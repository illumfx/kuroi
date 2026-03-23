from __future__ import annotations

import asyncio
import base64
import hashlib
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import delete, inspect
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from .database import Base, SessionLocal, engine, get_db
from .models import APIKey, AccountSuggestion, InviteCode, SteamAccount, User, VacLiveFault
from .models import BanStatus, BanType, SuggestionStatus
from .schemas import (
    AccountSuggestionCreate,
    AccountSuggestionOut,
    AccountSuggestionResolve,
    APIKeyCreateRequest,
    APIKeyCreateResponse,
    ChangePasswordRequest,
    InviteCreateRequest,
    InviteOut,
    LocalLoginRequest,
    MassImportError,
    MassImportRequest,
    MassImportResponse,
    RegisterRequest,
    SteamAccountCreate,
    SteamAccountOut,
    SteamAccountUpdate,
    TokenResponse,
    UserChoiceOut,
    UserProfileUpdateRequest,
    UserOut,
    VacLiveFaultLeaderboardEntryOut,
)
from .security import (
    api_key_prefix,
    create_access_token,
    decrypt_account_password,
    encrypt_account_password,
    generate_api_key,
    hash_api_key,
    hash_password,
    verify_password,
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "kuroi"
    app_secret: str = ""
    access_token_expire_minutes: int = 720
    frontend_url: str = "http://localhost:5173"

    oidc_enabled: bool = True
    oidc_issuer_url: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None
    oidc_redirect_uri: str | None = None
    oidc_scope: str = "openid profile email"
    oidc_token_auth_method: str = "auto"
    oidc_use_pkce: bool = True
    allow_invite_link_creation: bool = False
    allow_shiro_login: bool = False

    steam_api_key: str | None = None
    steam_status_refresh_seconds: int = 30
    steam_id_legacy_cleanup_enabled: bool = False

    # Shiro one-time token TTL (seconds).
    shiro_token_ttl: int = 30


@lru_cache
def get_settings() -> Settings:
    return Settings()


app = FastAPI(title="kuroi API", version="0.1.0")

settings = get_settings()

OIDC_STATE_TTL_SECONDS = 600
oidc_state_store: dict[str, dict[str, str | float]] = {}
steam_sync_task: asyncio.Task[None] | None = None

# Rate limiting: track request counts per IP
# Format: {ip_address: [(timestamp, count), ...]}
rate_limit_store: dict[str, list[float]] = {}
RATE_LIMIT_REQUESTS = 100  # requests per window
RATE_LIMIT_WINDOW_SECONDS = 60  # time window

def check_rate_limit(ip_address: str) -> bool:
    """Check if an IP has exceeded rate limit. Returns True if request is allowed."""
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS
    
    if ip_address not in rate_limit_store:
        rate_limit_store[ip_address] = []
    
    # Remove old requests outside the window
    rate_limit_store[ip_address] = [ts for ts in rate_limit_store[ip_address] if ts > window_start]
    
    # Check if limit exceeded
    if len(rate_limit_store[ip_address]) >= RATE_LIMIT_REQUESTS:
        return False
    
    # Record this request
    rate_limit_store[ip_address].append(now)
    return True


def rate_limit(request: Request) -> None:
    """Check rate limit for the requesting IP address"""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Too many requests. Please try again later.",
        )


def cleanup_expired_vac_live_faults() -> None:
    """Delete VAC Live fault records that have expired (ban_expires_at < now)"""
    with SessionLocal() as db:
        now = datetime.now(timezone.utc)
        expired_faults = db.scalars(
            select(VacLiveFault).where(VacLiveFault.ban_expires_at < now)
        ).all()

        if expired_faults:
            for fault in expired_faults:
                db.delete(fault)
            db.commit()


def validate_runtime_config() -> None:
    blocked_secrets = {"", "change-me", "please-change-me", "change-this-secret", "CHANGE_ME_LONG_RANDOM_SECRET"}
    if settings.app_secret in blocked_secrets:
        raise RuntimeError("APP_SECRET must be set to a strong unique value")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Base.metadata.create_all(bind=engine)


def ensure_schema_extensions() -> None:
    inspector = inspect(engine)
    columns = inspector.get_columns("steam_accounts")
    column_names = {column["name"] for column in columns}

    with engine.begin() as connection:
        user_columns = {column["name"] for column in inspector.get_columns("users")}
        if "display_name" not in user_columns:
            connection.exec_driver_sql("ALTER TABLE users ADD COLUMN display_name VARCHAR(64)")
        if "ban_type" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN ban_type VARCHAR(16) DEFAULT 'None'")
        if "vac_live_expires_at" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN vac_live_expires_at TIMESTAMP")
        if "is_prime" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN is_prime BOOLEAN DEFAULT FALSE")
        if "vac_live_fault_user_id" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN vac_live_fault_user_id INTEGER")
        if "matchmaking_ready" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN matchmaking_ready BOOLEAN DEFAULT FALSE")
        if "online_status" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN online_status VARCHAR(32)")
        if "game_status" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN game_status VARCHAR(255)")
        if "steam_profile_name" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN steam_profile_name VARCHAR(255)")
        if "steam_vac_bans" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN steam_vac_bans INTEGER")
        if "steam_game_bans" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN steam_game_bans INTEGER")
        if "steam_days_since_last_ban" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN steam_days_since_last_ban INTEGER")
        if "steam_economy_ban" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN steam_economy_ban VARCHAR(64)")
        if "steam_checked_at" not in column_names:
            connection.exec_driver_sql("ALTER TABLE steam_accounts ADD COLUMN steam_checked_at TIMESTAMP")

        table_names = set(inspector.get_table_names())
        if "account_suggestions" in table_names:
            suggestion_columns = {column["name"] for column in inspector.get_columns("account_suggestions")}
            if "suggested_vac_live_value" not in suggestion_columns:
                connection.exec_driver_sql("ALTER TABLE account_suggestions ADD COLUMN suggested_vac_live_value INTEGER")
            if "suggested_vac_live_unit" not in suggestion_columns:
                connection.exec_driver_sql("ALTER TABLE account_suggestions ADD COLUMN suggested_vac_live_unit VARCHAR(8)")
            if "suggested_vac_live_fault_user_id" not in suggestion_columns:
                connection.exec_driver_sql("ALTER TABLE account_suggestions ADD COLUMN suggested_vac_live_fault_user_id INTEGER")

        if "vac_live_faults" in table_names and engine.dialect.name == "sqlite":
            table_sql = connection.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vac_live_faults'"
            ).scalar()
            normalized_table_sql = str(table_sql or "").upper()
            if "UNIQUE" in normalized_table_sql and "ACCOUNT_ID" in normalized_table_sql:
                connection.exec_driver_sql(
                    "CREATE TABLE vac_live_faults__new ("
                    "id INTEGER NOT NULL PRIMARY KEY, "
                    "account_id INTEGER NOT NULL, "
                    "user_id INTEGER NOT NULL, "
                    "ban_expires_at TIMESTAMP NOT NULL, "
                    "created_at TIMESTAMP, "
                    "updated_at TIMESTAMP, "
                    "FOREIGN KEY(account_id) REFERENCES steam_accounts (id), "
                    "FOREIGN KEY(user_id) REFERENCES users (id)"
                    ")"
                )
                connection.exec_driver_sql(
                    "INSERT INTO vac_live_faults__new (id, account_id, user_id, ban_expires_at, created_at, updated_at) "
                    "SELECT id, account_id, user_id, ban_expires_at, created_at, updated_at FROM vac_live_faults"
                )
                connection.exec_driver_sql("DROP TABLE vac_live_faults")
                connection.exec_driver_sql("ALTER TABLE vac_live_faults__new RENAME TO vac_live_faults")
                connection.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_vac_live_faults_account_id ON vac_live_faults (account_id)"
                )
                connection.exec_driver_sql(
                    "CREATE INDEX IF NOT EXISTS ix_vac_live_faults_user_id ON vac_live_faults (user_id)"
                )

        if settings.steam_id_legacy_cleanup_enabled:
            connection.execute(
                text(
                    "UPDATE steam_accounts "
                    "SET steam_id64 = 'removed_' || CAST(id AS TEXT) "
                    "WHERE steam_id64 LIKE :pattern"
                ),
                {"pattern": "local_%"},
            )
        connection.exec_driver_sql("UPDATE steam_accounts SET matchmaking_ready = FALSE WHERE matchmaking_ready IS NULL")
        connection.exec_driver_sql("UPDATE steam_accounts SET is_prime = FALSE WHERE is_prime IS NULL")
        connection.exec_driver_sql("UPDATE users SET display_name = username WHERE display_name IS NULL OR trim(display_name) = ''")


def ensure_account_unique_constraints() -> None:
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_steam_accounts_username_ci ON steam_accounts (lower(username))"
            )
            connection.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_steam_accounts_email_ci ON steam_accounts (lower(email))"
            )
    except Exception as exc:
        raise RuntimeError(
            "Could not create unique account indexes for username/email. "
            "Please remove duplicate account usernames/emails and restart."
        ) from exc


def ensure_account_delete_cascades() -> None:
    if engine.dialect.name != "postgresql":
        return

    fk_specs = [
        ("vac_live_faults", "vac_live_faults_account_id_fkey"),
        ("account_suggestions", "account_suggestions_account_id_fkey"),
    ]

    with engine.begin() as connection:
        for table_name, canonical_fk_name in fk_specs:
            existing_fk_names = connection.execute(
                text(
                    "SELECT c.conname "
                    "FROM pg_constraint c "
                    "JOIN pg_class t ON t.oid = c.conrelid "
                    "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey) "
                    "JOIN pg_class rt ON rt.oid = c.confrelid "
                    "WHERE c.contype = 'f' "
                    "AND t.relname = :table_name "
                    "AND rt.relname = 'steam_accounts' "
                    "AND a.attname = 'account_id'"
                ),
                {"table_name": table_name},
            ).scalars().all()

            for constraint_name in existing_fk_names:
                connection.exec_driver_sql(f"ALTER TABLE {table_name} DROP CONSTRAINT IF EXISTS {constraint_name}")

            connection.exec_driver_sql(
                "ALTER TABLE "
                f"{table_name} "
                f"ADD CONSTRAINT {canonical_fk_name} "
                "FOREIGN KEY (account_id) REFERENCES steam_accounts(id) ON DELETE CASCADE"
            )


ensure_schema_extensions()
ensure_account_delete_cascades()
ensure_account_unique_constraints()
validate_runtime_config()


@lru_cache
def get_oidc_discovery() -> dict[str, Any]:
    if not settings.oidc_issuer_url:
        raise HTTPException(status_code=500, detail="OIDC issuer not configured")

    url = f"{settings.oidc_issuer_url.rstrip('/')}/.well-known/openid-configuration"
    with httpx.Client(timeout=10.0) as client:
        response = client.get(url)
        response.raise_for_status()
        return response.json()


@lru_cache
def get_oidc_jwks() -> dict[str, Any]:
    discovery = get_oidc_discovery()
    with httpx.Client(timeout=10.0) as client:
        response = client.get(discovery["jwks_uri"])
        response.raise_for_status()
        return response.json()


def validate_oidc_id_token(id_token: str, access_token: str | None = None) -> dict[str, Any]:
    discovery = get_oidc_discovery()
    jwks = get_oidc_jwks()

    try:
        headers = jwt.get_unverified_header(id_token)
        kid = headers.get("kid")
        keys = jwks.get("keys", [])
        key = next((entry for entry in keys if entry.get("kid") == kid), None)
        if not key and len(keys) == 1:
            key = keys[0]
        if not key:
            raise HTTPException(status_code=401, detail="OIDC signing key not found")

        claims = jwt.decode(
            id_token,
            key,
            algorithms=[headers.get("alg") or key.get("alg") or "RS256"],
            options={"verify_aud": False, "verify_iss": False},
            access_token=access_token,
        )

        expected_issuer = (discovery.get("issuer") or settings.oidc_issuer_url or "").rstrip("/")
        token_issuer = str(claims.get("iss", "")).rstrip("/")
        if expected_issuer and token_issuer != expected_issuer:
            raise HTTPException(status_code=401, detail="Invalid OIDC issuer")

        expected_audience = settings.oidc_client_id
        token_audience = claims.get("aud")
        if not expected_audience:
            raise HTTPException(status_code=500, detail="OIDC client ID not configured")
        if isinstance(token_audience, str):
            audience_ok = token_audience == expected_audience
        elif isinstance(token_audience, list):
            audience_ok = expected_audience in token_audience
        else:
            audience_ok = False
        if not audience_ok:
            raise HTTPException(status_code=401, detail="Invalid OIDC audience")

        return claims
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid OIDC ID token: {exc}") from exc


def get_current_user_from_token(token: str, db: Session) -> User:
    try:
        payload = jwt.decode(token, settings.app_secret, algorithms=["HS256"])
        subject = payload.get("sub")
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid access token") from exc

    if not subject:
        raise HTTPException(status_code=401, detail="Invalid access token payload")

    user = db.get(User, int(subject))
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def get_current_user(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.replace("Bearer ", "", 1).strip()
    return get_current_user_from_token(token, db)


def serialize_user(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        display_name=(user.display_name or user.username).strip(),
        email=user.email,
        has_password=bool(user.password_hash),
    )


def format_user_label(user: User) -> str:
    display_name = (user.display_name or user.username).strip() or user.username
    return f"{display_name} ({user.username})"


def is_online_status(status_value: str | None) -> bool:
    return status_value not in {None, "", "Offline", "Unknown"}


def is_account_online(account: SteamAccount) -> bool:
    return is_online_status(account.online_status)


def get_user_by_api_key(x_api_key: str, db: Session) -> User:
    prefix = api_key_prefix(x_api_key)
    hashed = hash_api_key(x_api_key)
    api_key_entry = db.scalar(
        select(APIKey).where(APIKey.key_prefix == prefix, APIKey.hashed_key == hashed, APIKey.revoked_at.is_(None))
    )
    if not api_key_entry:
        raise HTTPException(status_code=401, detail="Invalid API key")

    user = db.get(User, api_key_entry.user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User for API key not found")
    return user


def resolve_actor(
    authorization: str = Header(default=""),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if authorization.startswith("Bearer "):
        token = authorization.replace("Bearer ", "", 1).strip()
        return get_current_user_from_token(token, db)

    if x_api_key:
        return get_user_by_api_key(x_api_key, db)

    raise HTTPException(status_code=401, detail="Missing authentication")


async def fetch_steam_avatar(steam_id64: str) -> str | None:
    if not settings.steam_api_key:
        return None

    url = (
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/"
        f"?key={settings.steam_api_key}&steamids={steam_id64}"
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        players = response.json().get("response", {}).get("players", [])
        if not players:
            return None
        return players[0].get("avatarfull")


def format_remaining_time(expires_at: datetime | None, *, reference_time: datetime | None = None) -> str | None:
    if not expires_at:
        return None

    now = normalize_utc_datetime(reference_time) or datetime.now(timezone.utc)
    target = normalize_utc_datetime(expires_at)
    remaining_seconds = int((target - now).total_seconds())
    if remaining_seconds <= 0:
        return "Expired"

    total_hours = remaining_seconds // 3600
    total_days = total_hours // 24
    if total_days > 0:
        return f"{total_days} day(s)"
    return f"{max(total_hours, 1)} hour(s)"


def normalize_utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def serialize_account(
    account: SteamAccount,
    *,
    pending_review_count: int = 0,
    vac_live_fault_display: str | None = None,
    vac_live_fault_count: int = 0,
    suggested_next_vac_live_value: int = 20,
    suggested_next_vac_live_unit: str = "hours",
    server_now: datetime | None = None,
) -> SteamAccountOut:
    suggestions, suggested_ban_type = build_account_suggestions(account)
    password_value = "" if is_account_online(account) else decrypt_account_password(account.password, settings.app_secret)
    current_server_time = normalize_utc_datetime(server_now) or datetime.now(timezone.utc)
    payload = {
        "id": account.id,
        "owner_id": account.owner_id,
        "username": account.username,
        "password": password_value,
        "email": account.email,
        "steam_id64": account.steam_id64,
        "ban_status": account.ban_status,
        "ban_type": BanType(account.ban_type) if account.ban_type in BanType._value2member_map_ else BanType.VAC,
        "vac_live_expires_at": normalize_utc_datetime(account.vac_live_expires_at),
        "vac_live_remaining": format_remaining_time(account.vac_live_expires_at, reference_time=current_server_time),
        "server_now": current_server_time,
        "vac_live_fault_user_id": account.vac_live_fault_user_id,
        "vac_live_fault_display": vac_live_fault_display,
        "vac_live_fault_count": vac_live_fault_count,
        "suggested_next_vac_live_value": suggested_next_vac_live_value,
        "suggested_next_vac_live_unit": suggested_next_vac_live_unit,
        "matchmaking_ready": account.matchmaking_ready,
        "is_public": account.is_public,
        "is_prime": account.is_prime,
        "avatar_url": account.avatar_url,
        "steam_profile_name": account.steam_profile_name,
        "online_status": account.online_status,
        "game_status": account.game_status,
        "requires_review": len(suggestions) > 0,
        "suggested_changes": suggestions,
        "suggested_ban_type": suggested_ban_type,
        "pending_review_count": pending_review_count,
        "created_at": normalize_utc_datetime(account.created_at),
    }
    return SteamAccountOut.model_validate(payload)


def serialize_suggestion(suggestion: AccountSuggestion, users_by_id: dict[int, User]) -> AccountSuggestionOut:
    suggested_ban_type = None
    if suggestion.suggested_ban_type and suggestion.suggested_ban_type in BanType._value2member_map_:
        suggested_ban_type = BanType(suggestion.suggested_ban_type)

    suggested_by = users_by_id.get(suggestion.suggested_by_id)
    fault_user = users_by_id.get(suggestion.suggested_vac_live_fault_user_id or -1)

    return AccountSuggestionOut(
        id=suggestion.id,
        account_id=suggestion.account_id,
        suggested_by_id=suggestion.suggested_by_id,
        suggested_by_username=suggested_by.username if suggested_by else "unknown",
        suggested_by_display_name=(suggested_by.display_name or suggested_by.username).strip() if suggested_by else "unknown",
        suggested_ban_type=suggested_ban_type,
        suggested_vac_live_value=suggestion.suggested_vac_live_value,
        suggested_vac_live_unit=suggestion.suggested_vac_live_unit if suggestion.suggested_vac_live_unit in {"hours", "days"} else None,
        suggested_vac_live_fault_user_id=suggestion.suggested_vac_live_fault_user_id,
        suggested_vac_live_fault_display=format_user_label(fault_user) if fault_user else None,
        suggested_matchmaking_ready=suggestion.suggested_matchmaking_ready,
        suggested_is_public=suggestion.suggested_is_public,
        note=suggestion.note,
        status=suggestion.status,
        created_at=normalize_utc_datetime(suggestion.created_at),
    )


def sync_vac_live_fault_record(db: Session, account: SteamAccount) -> None:
    expires_at = normalize_utc_datetime(account.vac_live_expires_at)
    should_track = account.ban_type == BanType.VAC_LIVE.value and account.vac_live_fault_user_id is not None and expires_at is not None

    # Always check if there's an existing record
    latest_record = db.scalar(
        select(VacLiveFault)
        .where(VacLiveFault.account_id == account.id)
        .order_by(VacLiveFault.created_at.desc(), VacLiveFault.id.desc())
        .limit(1)
    )

    if not should_track:
        # Delete any existing record if we're not tracking this account anymore
        if latest_record:
            db.delete(latest_record)
            db.flush()
        return

    expires_at_naive = expires_at.replace(tzinfo=None)
    if latest_record and latest_record.user_id == int(account.vac_live_fault_user_id) and latest_record.ban_expires_at == expires_at_naive:
        return

    # Delete the old record if it exists before inserting the new one to avoid unique constraint violations
    if latest_record:
        db.delete(latest_record)
        db.flush()

    db.add(
        VacLiveFault(
            account_id=account.id,
            user_id=int(account.vac_live_fault_user_id),
            ban_expires_at=expires_at_naive,
        )
    )


def backfill_vac_live_fault_records() -> None:
    with SessionLocal() as db:
        accounts = db.scalars(select(SteamAccount).where(SteamAccount.ban_type == BanType.VAC_LIVE.value)).all()
        for account in accounts:
            sync_vac_live_fault_record(db, account)
        db.commit()


VAC_LIVE_SUGGESTION_STEPS: list[tuple[int, str]] = [
    (20, "hours"),
    (7, "days"),
    (31, "days"),
    (180, "days"),
]


def resolve_next_vac_live_duration(fault_count: int) -> tuple[int, str]:
    clamped_fault_count = max(fault_count, 0)
    step_index = min(clamped_fault_count, len(VAC_LIVE_SUGGESTION_STEPS) - 1)
    return VAC_LIVE_SUGGESTION_STEPS[step_index]


def build_account_suggestions(account: SteamAccount) -> tuple[list[str], BanType | None]:
    suggestions: list[str] = []
    suggested_ban_type: BanType | None = None
    vac_bans = account.steam_vac_bans or 0
    game_bans = account.steam_game_bans or 0

    if vac_bans > 0 and account.ban_type != BanType.VAC.value:
        suggestions.append(f"Steam reports {vac_bans} VAC ban(s) — review ban type (VAC suggested)")
        suggested_ban_type = BanType.VAC
    elif game_bans > 0 and account.ban_type not in {BanType.VAC.value, BanType.GAME_BANNED.value}:
        suggestions.append(f"Steam reports {game_bans} game ban(s) — review ban type (GameBanned suggested)")
        suggested_ban_type = BanType.GAME_BANNED

    if account.matchmaking_ready and not account.steam_id64:
        suggestions.append("Matchmaking-ready account has no Steam ID — set steam_id64 for live checks")

    if account.matchmaking_ready and account.steam_id64 and account.online_status in {None, "Unknown"}:
        suggestions.append("Steam status unavailable — verify Steam ID or profile visibility")

    if vac_bans == 0 and game_bans == 0 and account.ban_type in {BanType.VAC.value, BanType.GAME_BANNED.value}:
        suggestions.append("Steam currently reports no VAC/Game bans — re-check local ban type")
        suggested_ban_type = BanType.NONE

    return suggestions, suggested_ban_type


PERSONA_STATE_LABELS = {
    0: "Offline",
    1: "Online",
    2: "Busy",
    3: "Away",
    4: "Snooze",
    5: "LookingToTrade",
    6: "LookingToPlay",
}


def _resolve_steam_presence(player: dict[str, Any]) -> tuple[str, str | None]:
    game_name = player.get("gameextrainfo")
    if game_name:
        return "Playing", str(game_name)

    game_id = player.get("gameid")
    if game_id:
        return "Playing", None

    raw_state = player.get("personastate", 0)
    try:
        persona_state = int(raw_state)
    except (TypeError, ValueError):
        persona_state = 0
    return PERSONA_STATE_LABELS.get(persona_state, "Offline"), None


def _chunked(values: list[str], size: int) -> list[list[str]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


async def refresh_matchmaking_accounts_steam_presence() -> None:
    if not settings.steam_api_key:
        return

    db = SessionLocal()
    try:
        candidates = db.scalars(select(SteamAccount).where(SteamAccount.matchmaking_ready.is_(True))).all()
        if not candidates:
            return

        steamid_to_account: dict[str, SteamAccount] = {}
        for account in candidates:
            steam_id = (account.steam_id64 or "").strip()
            if steam_id.isdigit():
                steamid_to_account[steam_id] = account

        if not steamid_to_account:
            return

        ids = list(steamid_to_account.keys())
        async with httpx.AsyncClient(timeout=15.0) as client:
            for id_chunk in _chunked(ids, 100):
                url = (
                    "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/"
                    f"?key={settings.steam_api_key}&steamids={','.join(id_chunk)}"
                )
                response = await client.get(url)
                response.raise_for_status()
                players = response.json().get("response", {}).get("players", [])

                bans_url = (
                    "https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/"
                    f"?key={settings.steam_api_key}&steamids={','.join(id_chunk)}"
                )
                bans_response = await client.get(bans_url)
                bans_response.raise_for_status()
                bans_players = bans_response.json().get("players", [])
                bans_by_steam_id = {str(player.get("SteamId", "")).strip(): player for player in bans_players}

                seen_ids: set[str] = set()
                for player in players:
                    steam_id = str(player.get("steamid", "")).strip()
                    if not steam_id:
                        continue
                    seen_ids.add(steam_id)
                    account = steamid_to_account.get(steam_id)
                    if not account:
                        continue

                    avatar_url = player.get("avatarfull")
                    if avatar_url:
                        account.avatar_url = str(avatar_url)
                    persona_name = player.get("personaname")
                    account.steam_profile_name = str(persona_name).strip() if persona_name else None
                    account.online_status, account.game_status = _resolve_steam_presence(player)
                    ban_data = bans_by_steam_id.get(steam_id, {})
                    account.steam_vac_bans = int(ban_data.get("NumberOfVACBans", 0) or 0)
                    account.steam_game_bans = int(ban_data.get("NumberOfGameBans", 0) or 0)
                    account.steam_days_since_last_ban = int(ban_data.get("DaysSinceLastBan", 0) or 0)
                    economy_ban = ban_data.get("EconomyBan")
                    account.steam_economy_ban = str(economy_ban) if economy_ban else None
                    account.steam_checked_at = datetime.now(timezone.utc)

                missing_ids = set(id_chunk) - seen_ids
                for missing_id in missing_ids:
                    account = steamid_to_account.get(missing_id)
                    if not account:
                        continue
                    account.steam_profile_name = None
                    account.online_status = "Unknown"
                    account.game_status = None
                    account.steam_checked_at = datetime.now(timezone.utc)

        db.commit()
    finally:
        db.close()


async def steam_sync_loop() -> None:
    refresh_seconds = max(settings.steam_status_refresh_seconds, 60)
    while True:
        try:
            await refresh_matchmaking_accounts_steam_presence()
        except Exception:
            pass
        await asyncio.sleep(refresh_seconds)


@app.on_event("startup")
async def startup_steam_sync() -> None:
    global steam_sync_task
    backfill_vac_live_fault_records()
    cleanup_expired_vac_live_faults()
    if not settings.steam_api_key:
        return
    if steam_sync_task is None or steam_sync_task.done():
        steam_sync_task = asyncio.create_task(steam_sync_loop())


@app.on_event("shutdown")
async def shutdown_steam_sync() -> None:
    global steam_sync_task
    if not steam_sync_task:
        return
    steam_sync_task.cancel()
    try:
        await steam_sync_task
    except asyncio.CancelledError:
        pass
    steam_sync_task = None


def create_account_record(
    *,
    actor_id: int,
    username: str,
    email: str,
    password: str,
    steam_id: str | None = None,
    matchmaking_ready: bool,
    is_public: bool,
    is_prime: bool,
    ban_type: BanType = BanType.NONE,
    vac_live_value: int | None = None,
    vac_live_unit: str | None = None,
    vac_live_fault_user_id: int | None = None,
) -> SteamAccount:
    resolved_steam_id = steam_id.strip() if steam_id else None
    ban_status = BanStatus.CLEAN
    vac_live_expires_at = None
    if ban_type in {BanType.VAC, BanType.GAME_BANNED}:
        ban_status = BanStatus.BAN
    elif ban_type == BanType.VAC_LIVE:
        ban_status = BanStatus.VAC_LIVE
        amount = vac_live_value or 0
        delta = timedelta(hours=amount) if vac_live_unit == "hours" else timedelta(days=amount)
        vac_live_expires_at = datetime.now(timezone.utc) + delta

    return SteamAccount(
        owner_id=actor_id,
        steam_id64=resolved_steam_id,
        username=username,
        password=encrypt_account_password(password, settings.app_secret),
        email=email,
        matchmaking_ready=matchmaking_ready,
        is_public=is_public,
        is_prime=is_prime,
        ban_status=ban_status,
        ban_type=ban_type.value,
        vac_live_expires_at=vac_live_expires_at,
        vac_live_fault_user_id=vac_live_fault_user_id if ban_type == BanType.VAC_LIVE else None,
        avatar_url=None,
        steam_profile_name=None,
        online_status=None,
        game_status=None,
        steam_vac_bans=None,
        steam_game_bans=None,
        steam_days_since_last_ban=None,
        steam_economy_ban=None,
        steam_checked_at=None,
    )


def ensure_account_identity_unique(
    db: Session,
    *,
    username: str,
    email: str,
    exclude_account_id: int | None = None,
) -> None:
    normalized_username = username.strip().lower()
    normalized_email = email.strip().lower()

    username_query = select(SteamAccount.id).where(func.lower(SteamAccount.username) == normalized_username)
    email_query = select(SteamAccount.id).where(func.lower(SteamAccount.email) == normalized_email)

    if exclude_account_id is not None:
        username_query = username_query.where(SteamAccount.id != exclude_account_id)
        email_query = email_query.where(SteamAccount.id != exclude_account_id)

    if db.scalar(username_query) is not None:
        raise HTTPException(status_code=409, detail="Username already exists")
    if db.scalar(email_query) is not None:
        raise HTTPException(status_code=409, detail="Email already exists")


def ensure_steam_id_unique(db: Session, *, steam_id: str) -> None:
    normalized_steam_id = steam_id.strip()
    if not normalized_steam_id:
        return

    existing_steam_id = db.scalar(select(SteamAccount.id).where(SteamAccount.steam_id64 == normalized_steam_id))
    if existing_steam_id is not None:
        raise HTTPException(status_code=409, detail="Steam ID already exists")


def ensure_steam_id_unique_for_update(db: Session, *, steam_id: str, exclude_account_id: int) -> None:
    normalized_steam_id = steam_id.strip()
    if not normalized_steam_id:
        return

    existing_steam_id = db.scalar(
        select(SteamAccount.id).where(
            SteamAccount.steam_id64 == normalized_steam_id,
            SteamAccount.id != exclude_account_id,
        )
    )
    if existing_steam_id is not None:
        raise HTTPException(status_code=409, detail="Steam ID already exists")


def ensure_user_exists(db: Session, user_id: int | None, *, detail: str) -> None:
    if user_id is None:
        return
    if db.get(User, user_id) is None:
        raise HTTPException(status_code=400, detail=detail)


def get_fault_display_map(db: Session, user_ids: list[int]) -> dict[int, str]:
    valid_ids = sorted({user_id for user_id in user_ids if user_id})
    if not valid_ids:
        return {}
    users = db.scalars(select(User).where(User.id.in_(valid_ids))).all()
    return {user.id: format_user_label(user) for user in users}


def is_oidc_auth_available() -> bool:
    return bool(settings.oidc_enabled and settings.oidc_issuer_url and settings.oidc_client_id and settings.oidc_redirect_uri)


def build_invite_link(invite_code: str) -> str:
    frontend_base = settings.frontend_url.rstrip("/")
    return f"{frontend_base}/?invite={quote(invite_code)}"


def ensure_bootstrap_invite_link() -> None:
    if is_oidc_auth_available():
        return

    with SessionLocal() as db:
        user_count = db.scalar(select(func.count(User.id))) or 0
        if user_count > 0:
            return

        previous_invite = db.scalar(
            select(InviteCode)
            .where(InviteCode.is_active.is_(True), InviteCode.used_by_id.is_(None))
            .order_by(InviteCode.created_at.desc())
        )
        if previous_invite:
            previous_invite.is_active = False
            db.add(previous_invite)

        invite = InviteCode(code=secrets.token_urlsafe(12), created_by_id=None)
        db.add(invite)
        db.commit()
        db.refresh(invite)

        invite_link = build_invite_link(invite.code)
        print("=== kuroi bootstrap invite ===")
        print("OIDC is not configured. Use this invite to create the first account:")
        print(f"Invite link: {invite_link}")
        print(f"Invite code: {invite.code}")
        print("Invite links are currently consumed via URL parameter (?invite=...) and manual registration form.")
        print("================================")


ensure_bootstrap_invite_link()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/auth/config")
def auth_config() -> dict[str, bool]:
    oidc_configured = bool(settings.oidc_issuer_url and settings.oidc_client_id and settings.oidc_redirect_uri)
    return {
        "oidc_enabled": settings.oidc_enabled,
        "oidc_configured": oidc_configured,
        "allow_invite_link_creation": settings.allow_invite_link_creation,
        "allow_shiro_login": settings.allow_shiro_login,
    }


def _cleanup_oidc_state() -> None:
    now = time.time()
    expired_states = [state for state, data in oidc_state_store.items() if float(data["expires_at"]) < now]
    for state in expired_states:
        oidc_state_store.pop(state, None)


def _create_pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge_digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    challenge = base64.urlsafe_b64encode(challenge_digest).rstrip(b"=").decode("utf-8")
    return verifier, challenge


def _resolve_token_auth_method(discovery: dict[str, Any]) -> str:
    configured = settings.oidc_token_auth_method.strip().lower()
    if configured in {"client_secret_basic", "client_secret_post", "none"}:
        return configured

    supported = discovery.get("token_endpoint_auth_methods_supported") or []
    if isinstance(supported, list):
        lowered_supported = [str(item).lower() for item in supported]
        if "client_secret_basic" in lowered_supported:
            return "client_secret_basic"
        if "client_secret_post" in lowered_supported:
            return "client_secret_post"
        if "none" in lowered_supported:
            return "none"

    return "client_secret_post" if settings.oidc_client_secret else "none"


def _token_auth_attempt_order(discovery: dict[str, Any]) -> list[str]:
    preferred = _resolve_token_auth_method(discovery)
    supported = discovery.get("token_endpoint_auth_methods_supported")

    ordered: list[str] = []
    if preferred in {"client_secret_basic", "client_secret_post", "none"}:
        ordered.append(preferred)

    if isinstance(supported, list):
        for method in supported:
            normalized = str(method).lower()
            if normalized in {"client_secret_basic", "client_secret_post", "none"} and normalized not in ordered:
                ordered.append(normalized)

    for fallback in ["client_secret_basic", "client_secret_post", "none"]:
        if fallback not in ordered:
            ordered.append(fallback)

    return ordered


@app.get("/auth/oidc/login")
def oidc_login() -> dict[str, str]:
    if not settings.oidc_enabled:
        raise HTTPException(status_code=400, detail="OIDC is disabled")
    if not settings.oidc_client_id or not settings.oidc_redirect_uri:
        raise HTTPException(status_code=500, detail="OIDC client settings are missing")

    discovery = get_oidc_discovery()
    state = secrets.token_urlsafe(16)
    nonce = secrets.token_urlsafe(16)

    code_verifier: str | None = None
    authorize_params = {
        "client_id": settings.oidc_client_id,
        "response_type": "code",
        "redirect_uri": settings.oidc_redirect_uri,
        "scope": settings.oidc_scope,
        "state": state,
        "nonce": nonce,
    }
    if settings.oidc_use_pkce:
        code_verifier, challenge = _create_pkce_pair()
        authorize_params["code_challenge"] = challenge
        authorize_params["code_challenge_method"] = "S256"

    _cleanup_oidc_state()
    state_entry: dict[str, str | float] = {
        "expires_at": time.time() + OIDC_STATE_TTL_SECONDS,
    }
    if code_verifier:
        state_entry["verifier"] = code_verifier
    oidc_state_store[state] = state_entry

    authorize_url = f"{discovery['authorization_endpoint']}?{urlencode(authorize_params)}"
    return {"authorization_url": authorize_url, "state": state, "nonce": nonce}


@app.get("/auth/oidc/callback")
def oidc_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
    as_json: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    if not settings.oidc_enabled:
        raise HTTPException(status_code=400, detail="OIDC is disabled")
    if not settings.oidc_client_id or not settings.oidc_redirect_uri:
        raise HTTPException(status_code=500, detail="OIDC settings are incomplete")

    if error:
        detail = error_description or error
        message = f"OIDC provider error: {detail}"
        if as_json:
            raise HTTPException(status_code=400, detail=message)
        redirect_url = f"{settings.frontend_url.rstrip('/')}/#error={quote(message)}"
        return RedirectResponse(url=redirect_url, status_code=status.HTTP_302_FOUND)
    if not code:
        raise HTTPException(status_code=400, detail="OIDC callback missing authorization code")
    if not state:
        raise HTTPException(status_code=400, detail="OIDC callback missing state")

    _cleanup_oidc_state()
    state_data = oidc_state_store.pop(state, None)
    if not state_data:
        raise HTTPException(status_code=400, detail="OIDC state is invalid or expired")

    verifier_raw = state_data.get("verifier")
    code_verifier = str(verifier_raw) if verifier_raw else None

    discovery = get_oidc_discovery()
    base_token_payload: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.oidc_redirect_uri,
        "client_id": settings.oidc_client_id,
    }
    if code_verifier:
        base_token_payload["code_verifier"] = code_verifier

    attempted_methods: list[str] = []
    last_provider_detail = ""

    with httpx.Client(timeout=10.0) as client:
        token_data: dict[str, Any] | None = None
        for token_auth_method in _token_auth_attempt_order(discovery):
            payload = dict(base_token_payload)
            basic_auth: httpx.BasicAuth | None = None

            if token_auth_method == "client_secret_post":
                payload["client_secret"] = settings.oidc_client_secret or ""
            elif token_auth_method == "client_secret_basic":
                basic_auth = httpx.BasicAuth(settings.oidc_client_id, settings.oidc_client_secret or "")

            try:
                token_response = client.post(
                    discovery["token_endpoint"],
                    data=payload,
                    auth=basic_auth,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                token_response.raise_for_status()
                token_data = token_response.json()
                break
            except httpx.HTTPStatusError as exc:
                attempted_methods.append(token_auth_method)
                last_provider_detail = exc.response.text.strip() or str(exc)
                continue

    if token_data is None:
        attempted = ", ".join(attempted_methods) if attempted_methods else "none"
        raise HTTPException(
            status_code=401,
            detail=f"OIDC token exchange failed after methods [{attempted}]: {last_provider_detail}",
        )

    id_token = token_data.get("id_token")
    if not id_token:
        raise HTTPException(status_code=401, detail="OIDC token response missing id_token")

    claims = validate_oidc_id_token(id_token, token_data.get("access_token"))
    subject = claims.get("sub")
    if not subject:
        raise HTTPException(status_code=401, detail="OIDC token has no subject")

    user = db.scalar(select(User).where(User.oidc_sub == subject))
    if not user:
        preferred_username = claims.get("preferred_username") or claims.get("name") or f"oidc_{subject[-8:]}"
        email = claims.get("email")
        username = preferred_username[:64]
        user = User(username=username, display_name=username, email=email, oidc_sub=subject)
        db.add(user)
        db.commit()
        db.refresh(user)

    access_token = create_access_token(str(user.id), settings.app_secret, settings.access_token_expire_minutes)
    token_response = TokenResponse(access_token=access_token, user=serialize_user(user))
    if as_json:
        return token_response

    redirect_url = f"{settings.frontend_url.rstrip('/')}/#token={access_token}"
    return RedirectResponse(url=redirect_url, status_code=status.HTTP_302_FOUND)


@app.post("/auth/register", response_model=TokenResponse)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    invite = db.scalar(select(InviteCode).where(InviteCode.code == payload.invite_code))
    if not invite or not invite.is_active:
        raise HTTPException(status_code=400, detail="Invalid invite code")
    if invite.used_by_id:
        raise HTTPException(status_code=400, detail="Invite code already used")
    if invite.expires_at and invite.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Invite code expired")

    existing = db.scalar(select(User).where(or_(User.username == payload.username, User.email == payload.email)))
    if existing:
        raise HTTPException(status_code=400, detail="Username or email already exists")

    user = User(
        username=payload.username,
        display_name=payload.username,
        email=payload.email,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    db.flush()

    invite.used_by_id = user.id
    invite.used_at = datetime.now(timezone.utc)
    invite.is_active = False
    db.commit()
    db.refresh(user)

    access_token = create_access_token(str(user.id), settings.app_secret, settings.access_token_expire_minutes)
    return TokenResponse(access_token=access_token, user=serialize_user(user))


@app.post("/auth/local-login", response_model=TokenResponse)
def local_login(payload: LocalLoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == payload.username))
    if not user or not user.password_hash:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    access_token = create_access_token(str(user.id), settings.app_secret, settings.access_token_expire_minutes)
    return TokenResponse(access_token=access_token, user=serialize_user(user))


@app.post("/auth/invite", response_model=InviteOut)
def create_invite(payload: InviteCreateRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not settings.allow_invite_link_creation:
        raise HTTPException(status_code=403, detail="Invite link creation is disabled")

    code = secrets.token_urlsafe(12)
    expires_at = None
    if payload.expires_in_hours:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=payload.expires_in_hours)

    invite = InviteCode(code=code, created_by_id=user.id, expires_at=expires_at)
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return InviteOut(code=invite.code, expires_at=invite.expires_at, link=build_invite_link(invite.code))


@app.post("/auth/api-keys", response_model=APIKeyCreateResponse)
def create_api_key(payload: APIKeyCreateRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    existing_active_keys = db.scalars(
        select(APIKey).where(APIKey.user_id == user.id, APIKey.revoked_at.is_(None))
    ).all()
    for existing_key in existing_active_keys:
        db.delete(existing_key)

    plain_key = generate_api_key()
    entry = APIKey(
        user_id=user.id,
        name=payload.name,
        key_prefix=api_key_prefix(plain_key),
        hashed_key=hash_api_key(plain_key),
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)

    return APIKeyCreateResponse(
        id=entry.id,
        name=entry.name,
        api_key=plain_key,
        key_prefix=entry.key_prefix,
        created_at=entry.created_at,
    )


@app.get("/auth/me", response_model=UserOut)
def auth_me(user: User = Depends(get_current_user)):
    return serialize_user(user)


@app.patch("/auth/me", response_model=UserOut)
def update_profile(
    payload: UserProfileUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    user.display_name = payload.display_name.strip()
    db.add(user)
    db.commit()
    db.refresh(user)
    return serialize_user(user)


@app.get("/users", response_model=list[UserChoiceOut])
def list_users(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _ = user
    users = db.scalars(select(User).order_by(func.lower(User.display_name), func.lower(User.username))).all()
    return [
        UserChoiceOut(
            id=entry.id,
            username=entry.username,
            display_name=(entry.display_name or entry.username).strip(),
        )
        for entry in users
    ]


@app.get("/leaderboard/vac-live-faults", response_model=list[VacLiveFaultLeaderboardEntryOut])
def vac_live_fault_leaderboard(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _ = user
    rows = db.execute(
        select(VacLiveFault, User, SteamAccount)
        .join(User, User.id == VacLiveFault.user_id)
        .join(SteamAccount, SteamAccount.id == VacLiveFault.account_id)
        .order_by(VacLiveFault.updated_at.desc(), VacLiveFault.created_at.desc())
    ).all()

    grouped: dict[int, VacLiveFaultLeaderboardEntryOut] = {}
    grouped_account_counts: dict[int, dict[str, int]] = {}
    grouped_account_order: dict[int, list[str]] = {}

    for _fault_record, fault_user, account in rows:
        existing = grouped.get(fault_user.id)
        if existing is None:
            existing = VacLiveFaultLeaderboardEntryOut(
                user_id=fault_user.id,
                username=fault_user.username,
                display_name=(fault_user.display_name or fault_user.username).strip(),
                label=format_user_label(fault_user),
                total_faults=0,
                accounts=[],
            )
            grouped[fault_user.id] = existing
            grouped_account_counts[fault_user.id] = {}
            grouped_account_order[fault_user.id] = []

        existing.total_faults += 1
        account_counts = grouped_account_counts[fault_user.id]
        account_order = grouped_account_order[fault_user.id]
        account_counts[account.username] = account_counts.get(account.username, 0) + 1
        if account.username not in account_order:
            account_order.append(account.username)

    for user_id, entry in grouped.items():
        account_counts = grouped_account_counts[user_id]
        account_order = grouped_account_order[user_id]
        entry.accounts = [
            f"{account_name} ({account_counts[account_name]})" if account_counts[account_name] > 1 else account_name
            for account_name in account_order
        ]

    return sorted(grouped.values(), key=lambda entry: (-entry.total_faults, entry.label.lower()))


@app.post("/auth/change-password")
def change_password(payload: ChangePasswordRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not user.password_hash:
        raise HTTPException(status_code=400, detail="Password change is only available for local accounts")
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if verify_password(payload.new_password, user.password_hash):
        raise HTTPException(status_code=400, detail="New password must differ from current password")

    user.password_hash = hash_password(payload.new_password)
    db.add(user)
    db.commit()
    return {"status": "ok"}


@app.post("/accounts", response_model=SteamAccountOut, status_code=status.HTTP_201_CREATED)
async def create_account(
    payload: SteamAccountCreate,
    actor: User = Depends(resolve_actor),
    _: None = Depends(rate_limit),
    db: Session = Depends(get_db),
):
    ensure_account_identity_unique(db, username=payload.username, email=payload.email)
    if payload.steam_id:
        ensure_steam_id_unique(db, steam_id=payload.steam_id)
    ensure_user_exists(db, payload.vac_live_fault_user_id, detail="Selected VAC Live fault user does not exist")

    account = create_account_record(
        actor_id=actor.id,
        username=payload.username,
        email=payload.email,
        password=payload.password,
        steam_id=payload.steam_id,
        matchmaking_ready=payload.matchmaking_ready,
        is_public=payload.is_public,
        is_prime=payload.is_prime,
        ban_type=payload.ban_type,
        vac_live_value=payload.vac_live_value,
        vac_live_unit=payload.vac_live_unit,
        vac_live_fault_user_id=payload.vac_live_fault_user_id,
    )
    db.add(account)
    db.flush()
    sync_vac_live_fault_record(db, account)
    db.commit()
    db.refresh(account)
    fault_display_map = get_fault_display_map(db, [account.vac_live_fault_user_id or 0])
    return serialize_account(account, vac_live_fault_display=fault_display_map.get(account.vac_live_fault_user_id or 0))


@app.post("/accounts/mass-import", response_model=MassImportResponse)
def mass_import_accounts(
    payload: MassImportRequest,
    actor: User = Depends(resolve_actor),
    _: None = Depends(rate_limit),
    db: Session = Depends(get_db),
):
    errors: list[MassImportError] = []
    created = 0
    seen_usernames: set[str] = set()
    seen_emails: set[str] = set()
    seen_steam_ids: set[str] = set()

    for line_number, raw_line in enumerate(payload.content.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue

        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 4:
            errors.append(
                MassImportError(
                    line=line_number,
                    message="Invalid format, expected: email | username | password | steamid64",
                    raw=raw_line,
                )
            )
            continue

        email_with_optional_timestamp, username, password, steam_id = parts
        email = email_with_optional_timestamp
        if ": " in email_with_optional_timestamp:
            email = email_with_optional_timestamp.split(": ", 1)[1].strip()

        if not email or not username or not password or not steam_id:
            errors.append(
                MassImportError(
                    line=line_number,
                    message="Email, username, password and steamid64 are required",
                    raw=raw_line,
                )
            )
            continue
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            errors.append(MassImportError(line=line_number, message="Invalid email format", raw=raw_line))
            continue
        if not re.match(r"^\d{17}$", steam_id):
            errors.append(MassImportError(line=line_number, message="Invalid steamid64 format", raw=raw_line))
            continue

        normalized_username = username.lower()
        normalized_email = email.lower()
        if normalized_username in seen_usernames:
            errors.append(MassImportError(line=line_number, message="Username is duplicated in import", raw=raw_line))
            continue
        if normalized_email in seen_emails:
            errors.append(MassImportError(line=line_number, message="Email is duplicated in import", raw=raw_line))
            continue
        if steam_id in seen_steam_ids:
            errors.append(MassImportError(line=line_number, message="Steam ID is duplicated in import", raw=raw_line))
            continue

        existing_username = db.scalar(
            select(SteamAccount.id).where(func.lower(SteamAccount.username) == normalized_username)
        )
        if existing_username is not None:
            errors.append(MassImportError(line=line_number, message="Username already exists", raw=raw_line))
            continue

        existing_email = db.scalar(
            select(SteamAccount.id).where(func.lower(SteamAccount.email) == normalized_email)
        )
        if existing_email is not None:
            errors.append(MassImportError(line=line_number, message="Email already exists", raw=raw_line))
            continue

        existing_steam_id = db.scalar(select(SteamAccount.id).where(SteamAccount.steam_id64 == steam_id))
        if existing_steam_id is not None:
            errors.append(MassImportError(line=line_number, message="Steam ID already exists", raw=raw_line))
            continue

        try:
            account = create_account_record(
                actor_id=actor.id,
                username=username,
                email=email,
                password=password,
                steam_id=steam_id,
                matchmaking_ready=False,
                is_public=payload.is_public,
                is_prime=payload.is_prime,
                ban_type=BanType.NONE,
            )
            db.add(account)
            sync_vac_live_fault_record(db, account)
            db.commit()
            created += 1
            seen_usernames.add(normalized_username)
            seen_emails.add(normalized_email)
            seen_steam_ids.add(steam_id)
        except Exception as exc:
            db.rollback()
            errors.append(MassImportError(line=line_number, message=f"Could not create account: {exc}", raw=raw_line))

    return MassImportResponse(created=created, failed=len(errors), errors=errors)


@app.get("/accounts", response_model=list[SteamAccountOut])
def list_accounts(
    ban_type: BanType | None = Query(default=None),
    include_public: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if include_public:
        query = select(SteamAccount).where(or_(SteamAccount.is_public.is_(True), SteamAccount.owner_id == user.id))
    else:
        query = select(SteamAccount).where(SteamAccount.owner_id == user.id)
    if ban_type:
        query = query.where(SteamAccount.ban_type == ban_type.value)
    query = query.order_by(SteamAccount.created_at.desc())

    accounts = db.scalars(query).all()
    account_ids = [account.id for account in accounts]
    fault_display_map = get_fault_display_map(db, [account.vac_live_fault_user_id or 0 for account in accounts])
    pending_counts: dict[int, int] = {}
    fault_counts: dict[int, int] = {}
    if account_ids:
        count_rows = db.execute(
            select(AccountSuggestion.account_id, func.count(AccountSuggestion.id))
            .where(
                AccountSuggestion.account_id.in_(account_ids),
                AccountSuggestion.status == SuggestionStatus.PENDING,
            )
            .group_by(AccountSuggestion.account_id)
        ).all()
        pending_counts = {int(account_id): int(count) for account_id, count in count_rows}

        fault_count_rows = db.execute(
            select(VacLiveFault.account_id, func.count(VacLiveFault.id))
            .where(VacLiveFault.account_id.in_(account_ids))
            .group_by(VacLiveFault.account_id)
        ).all()
        fault_counts = {int(account_id): int(count) for account_id, count in fault_count_rows}

    server_now = datetime.now(timezone.utc)

    return [
        serialize_account(
            account,
            pending_review_count=pending_counts.get(account.id, 0),
            vac_live_fault_display=fault_display_map.get(account.vac_live_fault_user_id or 0),
            vac_live_fault_count=fault_counts.get(account.id, 0),
            suggested_next_vac_live_value=resolve_next_vac_live_duration(fault_counts.get(account.id, 0))[0],
            suggested_next_vac_live_unit=resolve_next_vac_live_duration(fault_counts.get(account.id, 0))[1],
            server_now=server_now,
        )
        for account in accounts
    ]


@app.post("/accounts/{account_id}/suggestions", response_model=AccountSuggestionOut, status_code=status.HTTP_201_CREATED)
def create_account_suggestion(
    account_id: int,
    payload: AccountSuggestionCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    account = db.get(SteamAccount, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    if account.owner_id == user.id:
        raise HTTPException(status_code=400, detail="Owners cannot suggest changes for their own account")
    if not account.is_public:
        raise HTTPException(status_code=403, detail="Only public accounts can receive external suggestions")
    ensure_user_exists(db, payload.suggested_vac_live_fault_user_id, detail="Selected VAC Live fault user does not exist")

    suggested_vac_live_value = payload.suggested_vac_live_value
    suggested_vac_live_unit = payload.suggested_vac_live_unit
    if payload.suggested_ban_type == BanType.VAC_LIVE and (suggested_vac_live_value is None or suggested_vac_live_unit is None):
        account_fault_count = int(
            db.scalar(select(func.count(VacLiveFault.id)).where(VacLiveFault.account_id == account.id)) or 0
        )
        suggested_vac_live_value, suggested_vac_live_unit = resolve_next_vac_live_duration(account_fault_count)

    suggestion = AccountSuggestion(
        account_id=account.id,
        suggested_by_id=user.id,
        suggested_ban_type=payload.suggested_ban_type.value if payload.suggested_ban_type else None,
        suggested_vac_live_value=suggested_vac_live_value,
        suggested_vac_live_unit=suggested_vac_live_unit,
        suggested_vac_live_fault_user_id=payload.suggested_vac_live_fault_user_id,
        suggested_matchmaking_ready=payload.suggested_matchmaking_ready,
        suggested_is_public=payload.suggested_is_public,
        note=payload.note.strip() if payload.note else None,
        status=SuggestionStatus.PENDING,
    )
    db.add(suggestion)
    db.commit()
    db.refresh(suggestion)
    return serialize_suggestion(suggestion, {user.id: user})


@app.get("/accounts/{account_id}/suggestions", response_model=list[AccountSuggestionOut])
def list_account_suggestions(
    account_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    account = db.get(SteamAccount, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    if account.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the account owner can review suggestions")

    suggestions = db.scalars(
        select(AccountSuggestion)
        .where(AccountSuggestion.account_id == account_id, AccountSuggestion.status == SuggestionStatus.PENDING)
        .order_by(AccountSuggestion.created_at.asc())
    ).all()
    if not suggestions:
        return []

    related_user_ids = sorted(
        {
            suggestion.suggested_by_id
            for suggestion in suggestions
        }
        | {
            suggestion.suggested_vac_live_fault_user_id
            for suggestion in suggestions
            if suggestion.suggested_vac_live_fault_user_id is not None
        }
    )
    related_users = db.scalars(select(User).where(User.id.in_(related_user_ids))).all()
    users_by_id = {entry.id: entry for entry in related_users}
    return [serialize_suggestion(suggestion, users_by_id) for suggestion in suggestions]


@app.post("/accounts/{account_id}/suggestions/{suggestion_id}/resolve", response_model=SteamAccountOut)
def resolve_account_suggestion(
    account_id: int,
    suggestion_id: int,
    payload: AccountSuggestionResolve,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    account = db.get(SteamAccount, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    if account.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the account owner can resolve suggestions")

    suggestion = db.get(AccountSuggestion, suggestion_id)
    if not suggestion or suggestion.account_id != account_id:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status != SuggestionStatus.PENDING:
        raise HTTPException(status_code=400, detail="Suggestion already resolved")

    if payload.action == "accept":
        if suggestion.suggested_ban_type and suggestion.suggested_ban_type in BanType._value2member_map_:
            account.ban_type = suggestion.suggested_ban_type
            if suggestion.suggested_ban_type == BanType.NONE.value:
                account.ban_status = BanStatus.CLEAN
                account.vac_live_expires_at = None
                account.vac_live_fault_user_id = None
            elif suggestion.suggested_ban_type in {BanType.VAC.value, BanType.GAME_BANNED.value}:
                account.ban_status = BanStatus.BAN
                account.vac_live_expires_at = None
                account.vac_live_fault_user_id = None
            elif suggestion.suggested_ban_type == BanType.VAC_LIVE.value:
                amount = suggestion.suggested_vac_live_value or 20
                unit = suggestion.suggested_vac_live_unit or "hours"
                delta = timedelta(hours=amount) if unit == "hours" else timedelta(days=amount)
                account.ban_status = BanStatus.VAC_LIVE
                account.vac_live_expires_at = datetime.now(timezone.utc) + delta
                account.vac_live_fault_user_id = suggestion.suggested_vac_live_fault_user_id
        if suggestion.suggested_matchmaking_ready is not None:
            account.matchmaking_ready = suggestion.suggested_matchmaking_ready
        if suggestion.suggested_is_public is not None:
            account.is_public = suggestion.suggested_is_public

    suggestion.status = SuggestionStatus.ACCEPTED if payload.action == "accept" else SuggestionStatus.DECLINED
    suggestion.resolved_by_id = user.id
    suggestion.resolved_at = datetime.now(timezone.utc)
    db.add(account)
    db.add(suggestion)
    sync_vac_live_fault_record(db, account)
    db.commit()
    db.refresh(account)

    pending_count = db.scalar(
        select(func.count(AccountSuggestion.id)).where(
            AccountSuggestion.account_id == account.id,
            AccountSuggestion.status == SuggestionStatus.PENDING,
        )
    )
    fault_display_map = get_fault_display_map(db, [account.vac_live_fault_user_id or 0])
    return serialize_account(
        account,
        pending_review_count=int(pending_count or 0),
        vac_live_fault_display=fault_display_map.get(account.vac_live_fault_user_id or 0),
    )


@app.put("/accounts/{account_id}", response_model=SteamAccountOut)
def update_account(
    account_id: int,
    payload: SteamAccountUpdate,
    user: User = Depends(get_current_user),
    _: None = Depends(rate_limit),
    db: Session = Depends(get_db),
):
    account = db.get(SteamAccount, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    if account.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the account owner can edit this account")

    ensure_account_identity_unique(
        db,
        username=payload.username,
        email=payload.email,
        exclude_account_id=account.id,
    )
    if payload.steam_id:
        ensure_steam_id_unique_for_update(db, steam_id=payload.steam_id, exclude_account_id=account.id)
    ensure_user_exists(db, payload.vac_live_fault_user_id, detail="Selected VAC Live fault user does not exist")

    account.username = payload.username
    if payload.password:
        account.password = encrypt_account_password(payload.password, settings.app_secret)
    account.email = payload.email
    if payload.steam_id:
        account.steam_id64 = payload.steam_id.strip()
    account.matchmaking_ready = payload.matchmaking_ready
    account.is_public = payload.is_public
    account.is_prime = payload.is_prime
    account.ban_type = payload.ban_type.value

    if payload.ban_type == BanType.NONE:
        account.ban_status = BanStatus.CLEAN
        account.vac_live_expires_at = None
        account.vac_live_fault_user_id = None
    elif payload.ban_type in {BanType.VAC, BanType.GAME_BANNED}:
        account.ban_status = BanStatus.BAN
        account.vac_live_expires_at = None
        account.vac_live_fault_user_id = None
    else:
        amount = payload.vac_live_value or 0
        delta = timedelta(hours=amount) if payload.vac_live_unit == "hours" else timedelta(days=amount)
        account.ban_status = BanStatus.VAC_LIVE
        account.vac_live_expires_at = datetime.now(timezone.utc) + delta
        account.vac_live_fault_user_id = payload.vac_live_fault_user_id

    db.add(account)
    sync_vac_live_fault_record(db, account)
    db.commit()
    db.refresh(account)
    fault_display_map = get_fault_display_map(db, [account.vac_live_fault_user_id or 0])
    return serialize_account(account, vac_live_fault_display=fault_display_map.get(account.vac_live_fault_user_id or 0))


@app.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    account_id: int,
    user: User = Depends(get_current_user),
    _: None = Depends(rate_limit),
    db: Session = Depends(get_db),
):
    account = db.get(SteamAccount, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    if account.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the account owner can delete this account")

    # Remove child records explicitly before deleting the parent account.
    db.execute(delete(VacLiveFault).where(VacLiveFault.account_id == account.id))
    db.execute(delete(AccountSuggestion).where(AccountSuggestion.account_id == account.id))
    db.delete(account)
    db.commit()


# ---------------------------------------------------------------------------
# Shiro one-time token endpoints (Steam one-click login)
# ---------------------------------------------------------------------------

# In-memory store for one-time Shiro tokens: token → {account_name, password, created_at}
_shiro_tokens: dict[str, dict[str, Any]] = {}


def _cleanup_expired_shiro_tokens() -> None:
    """Remove Shiro tokens older than the configured TTL."""
    now = time.time()
    expired = [t for t, v in _shiro_tokens.items() if now - v["created_at"] > settings.shiro_token_ttl]
    for t in expired:
        del _shiro_tokens[t]


@app.post("/accounts/{account_id}/shiro-login")
async def shiro_login(
    account_id: int,
    request: Request,
    actor: User = Depends(resolve_actor),
    db: Session = Depends(get_db),
):
    """Create a one-time token for Shiro to fetch credentials.

    Returns {token, launch_url} – the frontend opens the launch_url
    which triggers the shiro:// protocol handler on the user's machine.
    """
    if not settings.allow_shiro_login:
        raise HTTPException(status_code=403, detail="Shiro one-click login is disabled")

    account = db.get(SteamAccount, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    is_owner = account.owner_id == actor.id
    if not is_owner and not account.is_public:
        raise HTTPException(status_code=403, detail="Shiro login is only available for the account owner or public accounts")
    if is_account_online(account):
        raise HTTPException(status_code=409, detail="Shiro login is unavailable while the account is online")

    plaintext_password = decrypt_account_password(account.password, settings.app_secret)

    # Cleanup expired tokens before creating a new one.
    _cleanup_expired_shiro_tokens()

    # Create a cryptographically random one-time token.
    token = secrets.token_urlsafe(32)
    _shiro_tokens[token] = {
        "account_id": account.id,
        "account_name": account.username,
        "password": plaintext_password,
        "persona_name": account.steam_profile_name or account.username,
        "created_at": time.time(),
    }

    # Derive API base URL from the incoming request so it works in any
    # environment (local dev, Docker, behind reverse proxy, etc.).
    api_base = quote(str(request.base_url).rstrip("/"), safe="")
    launch_url = f"shiro://login?token={token}&api={api_base}"

    return {"token": token, "launch_url": launch_url}


@app.get("/accounts/{account_id}/shiro-info")
async def shiro_info(
    account_id: int,
    actor: User = Depends(resolve_actor),
    db: Session = Depends(get_db),
):
    """Return account credentials on demand.

    Intended for the frontend info modal. Available for account owners,
    and for viewers if the account is public.
    """
    if not settings.allow_shiro_login:
        raise HTTPException(status_code=403, detail="Shiro one-click login is disabled")

    account = db.get(SteamAccount, account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    is_owner = account.owner_id == actor.id
    if not is_owner and not account.is_public:
        raise HTTPException(status_code=403, detail="Account info is only available for the account owner or public accounts")
    if is_account_online(account):
        raise HTTPException(status_code=409, detail="Credentials are unavailable while the account is online")

    plaintext_password = decrypt_account_password(account.password, settings.app_secret)
    return {
        "username": account.username,
        "email": account.email,
        "password": plaintext_password,
    }


@app.get("/shiro/credentials/{token}")
async def shiro_credentials(token: str):
    """Exchange a one-time token for account credentials.

    This endpoint requires no authentication – the token itself IS the auth.
    The token is deleted immediately after use (single-use).
    """
    _cleanup_expired_shiro_tokens()

    creds = _shiro_tokens.pop(token, None)
    if not creds:
        raise HTTPException(status_code=404, detail="Token not found or expired")

    with SessionLocal() as db:
        account = db.get(SteamAccount, int(creds.get("account_id", 0) or 0))
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        if is_account_online(account):
            raise HTTPException(status_code=409, detail="Credentials are unavailable while the account is online")

    return {"account_name": creds["account_name"], "password": creds["password"], "persona_name": creds.get("persona_name", creds["account_name"])}


def register_frontend_routes() -> None:
    frontend_dist_dir = Path(__file__).resolve().parent.parent / "frontend-dist"
    if not frontend_dist_dir.exists():
        return

    assets_dir = frontend_dist_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="frontend-assets")

    @app.get("/favicon.ico", include_in_schema=False)
    def frontend_favicon():
        favicon_path = frontend_dist_dir / "favicon.ico"
        if favicon_path.exists():
            return FileResponse(str(favicon_path))
        raise HTTPException(status_code=404, detail="Favicon not found")

    @app.get("/", include_in_schema=False)
    def frontend_index_root():
        return FileResponse(str(frontend_dist_dir / "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False)
    def frontend_spa_fallback(full_path: str):
        protected_prefixes = {
            "auth",
            "accounts",
            "health",
            "docs",
            "redoc",
            "openapi.json",
        }
        first_segment = full_path.split("/", 1)[0]
        if first_segment in protected_prefixes:
            raise HTTPException(status_code=404, detail="Not found")

        requested_file = frontend_dist_dir / full_path
        if full_path and requested_file.exists() and requested_file.is_file():
            return FileResponse(str(requested_file))
        return FileResponse(str(frontend_dist_dir / "index.html"))


register_frontend_routes()
