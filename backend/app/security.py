from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet, InvalidToken
from jose import jwt
from passlib.context import CryptContext

pwd_context = CryptContext(
    schemes=["argon2", "bcrypt"],
    deprecated=["bcrypt"],
)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return pwd_context.verify(plain_password, password_hash)


def verify_and_update_password(plain_password: str, password_hash: str) -> tuple[bool, str | None]:
    return pwd_context.verify_and_update(plain_password, password_hash)


def create_access_token(subject: str, secret: str, expiry_minutes: int) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=expiry_minutes)
    payload = {"sub": subject, "exp": expires_at}
    return jwt.encode(payload, secret, algorithm="HS256")


def generate_api_key() -> str:
    return f"kuroi_{secrets.token_urlsafe(32)}"


def api_key_prefix(api_key: str) -> str:
    return api_key[:12]


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def _derive_fernet_key(secret: str) -> bytes:
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def encrypt_account_password(plain_password: str, app_secret: str) -> str:
    fernet = Fernet(_derive_fernet_key(app_secret))
    encrypted = fernet.encrypt(plain_password.encode("utf-8")).decode("utf-8")
    return f"enc::{encrypted}"


def decrypt_account_password(stored_password: str, app_secret: str) -> str:
    if not stored_password.startswith("enc::"):
        return stored_password

    token = stored_password.replace("enc::", "", 1)
    fernet = Fernet(_derive_fernet_key(app_secret))
    try:
        return fernet.decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return stored_password
