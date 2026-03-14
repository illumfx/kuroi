from __future__ import annotations

from datetime import datetime
from enum import Enum

from sqlalchemy import Boolean, DateTime, Enum as SQLEnum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class BanStatus(str, Enum):
    CLEAN = "Clean"
    BAN = "Ban"
    VAC_LIVE = "VACLive"


class BanType(str, Enum):
    NONE = "None"
    VAC = "VAC"
    GAME_BANNED = "GameBanned"
    VAC_LIVE = "VACLive"


class SuggestionStatus(str, Enum):
    PENDING = "Pending"
    ACCEPTED = "Accepted"
    DECLINED = "Declined"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), unique=True, index=True, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    oidc_sub: Mapped[str | None] = mapped_column(String(255), unique=True, index=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    accounts: Mapped[list[SteamAccount]] = relationship(
        "SteamAccount",
        back_populates="owner",
        foreign_keys="SteamAccount.owner_id",
    )
    api_keys: Mapped[list[APIKey]] = relationship("APIKey", back_populates="owner")


class InviteCode(Base):
    __tablename__ = "invite_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    used_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class APIKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    key_prefix: Mapped[str] = mapped_column(String(16), index=True)
    hashed_key: Mapped[str] = mapped_column(String(255), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    owner: Mapped[User] = relationship("User", back_populates="api_keys")


class SteamAccount(Base):
    __tablename__ = "steam_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    steam_id64: Mapped[str | None] = mapped_column(String(32), unique=True, index=True, nullable=True)
    username: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    password: Mapped[str] = mapped_column(Text)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    matchmaking_ready: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    is_public: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    is_prime: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    ban_status: Mapped[BanStatus] = mapped_column(SQLEnum(BanStatus), default=BanStatus.CLEAN, index=True)
    ban_type: Mapped[str] = mapped_column(String(16), default=BanType.NONE.value, index=True)
    vac_live_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    vac_live_fault_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    steam_profile_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    online_status: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    game_status: Mapped[str | None] = mapped_column(String(255), nullable=True)
    steam_vac_bans: Mapped[int | None] = mapped_column(Integer, nullable=True)
    steam_game_bans: Mapped[int | None] = mapped_column(Integer, nullable=True)
    steam_days_since_last_ban: Mapped[int | None] = mapped_column(Integer, nullable=True)
    steam_economy_ban: Mapped[str | None] = mapped_column(String(64), nullable=True)
    steam_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner: Mapped[User] = relationship(
        "User",
        back_populates="accounts",
        foreign_keys=[owner_id],
    )
    vac_live_fault_user: Mapped[User | None] = relationship("User", foreign_keys=[vac_live_fault_user_id])


class VacLiveFault(Base):
    __tablename__ = "vac_live_faults"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("steam_accounts.id"), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    ban_expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    account: Mapped[SteamAccount] = relationship("SteamAccount", foreign_keys=[account_id])
    user: Mapped[User] = relationship("User", foreign_keys=[user_id])


class AccountSuggestion(Base):
    __tablename__ = "account_suggestions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("steam_accounts.id"), index=True)
    suggested_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    suggested_ban_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    suggested_vac_live_value: Mapped[int | None] = mapped_column(Integer, nullable=True)
    suggested_vac_live_unit: Mapped[str | None] = mapped_column(String(8), nullable=True)
    suggested_vac_live_fault_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    suggested_matchmaking_ready: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    suggested_is_public: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[SuggestionStatus] = mapped_column(SQLEnum(SuggestionStatus), default=SuggestionStatus.PENDING, index=True)
    resolved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
