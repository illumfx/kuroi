from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, model_validator

from .models import BanStatus, BanType


class UserOut(BaseModel):
    id: int
    username: str
    email: str | None = None

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    invite_code: str = Field(min_length=6, max_length=64)


class LocalLoginRequest(BaseModel):
    username: str
    password: str


class InviteCreateRequest(BaseModel):
    expires_in_hours: int | None = Field(default=None, gt=0, le=168)


class InviteOut(BaseModel):
    code: str
    expires_at: datetime | None = None


class APIKeyCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class APIKeyCreateResponse(BaseModel):
    id: int
    name: str
    api_key: str
    key_prefix: str
    created_at: datetime


class SteamAccountCreate(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=255)
    email: EmailStr
    ban_type: BanType = BanType.NONE
    vac_live_value: int | None = Field(default=None, ge=1, le=365)
    vac_live_unit: Literal["hours", "days"] | None = None
    matchmaking_ready: bool = False
    is_public: bool = False

    @model_validator(mode="after")
    def validate_vac_live_fields(self):
        if self.ban_type == BanType.VAC_LIVE:
            if self.vac_live_value is None or self.vac_live_unit is None:
                raise ValueError("VAC Live accounts require vac_live_value and vac_live_unit")
        else:
            self.vac_live_value = None
            self.vac_live_unit = None
        return self


class SteamAccountUpdate(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=255)
    email: EmailStr
    ban_type: BanType = BanType.NONE
    vac_live_value: int | None = Field(default=None, ge=1, le=365)
    vac_live_unit: Literal["hours", "days"] | None = None
    matchmaking_ready: bool = False
    is_public: bool = False

    @model_validator(mode="after")
    def validate_vac_live_fields(self):
        if self.ban_type == BanType.VAC_LIVE:
            if self.vac_live_value is None or self.vac_live_unit is None:
                raise ValueError("VAC Live accounts require vac_live_value and vac_live_unit")
        else:
            self.vac_live_value = None
            self.vac_live_unit = None
        return self


class SteamAccountOut(BaseModel):
    id: int
    owner_id: int
    username: str
    password: str
    email: str
    steam_id64: str | None = None
    ban_status: BanStatus
    ban_type: BanType
    vac_live_expires_at: datetime | None = None
    vac_live_remaining: str | None = None
    matchmaking_ready: bool
    is_public: bool
    avatar_url: str | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class MassImportRequest(BaseModel):
    content: str = Field(min_length=1)
    is_public: bool = False


class MassImportError(BaseModel):
    line: int
    message: str
    raw: str


class MassImportResponse(BaseModel):
    created: int
    failed: int
    errors: list[MassImportError]
