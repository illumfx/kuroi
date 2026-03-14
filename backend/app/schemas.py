from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, model_validator

from .models import BanStatus, BanType, SuggestionStatus


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    email: str | None = None
    has_password: bool = False

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


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class UserProfileUpdateRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=64)


class UserChoiceOut(BaseModel):
    id: int
    username: str
    display_name: str


class VacLiveFaultLeaderboardEntryOut(BaseModel):
    user_id: int
    username: str
    display_name: str
    label: str
    total_faults: int
    accounts: list[str]


class InviteCreateRequest(BaseModel):
    expires_in_hours: int | None = Field(default=None, gt=0, le=168)


class InviteOut(BaseModel):
    code: str
    expires_at: datetime | None = None
    link: str | None = None


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
    steam_id: str | None = Field(default=None, min_length=17, max_length=17, pattern=r"^\d{17}$")
    ban_type: BanType = BanType.NONE
    vac_live_value: int | None = Field(default=None, ge=1, le=365)
    vac_live_unit: Literal["hours", "days"] | None = None
    vac_live_fault_user_id: int | None = Field(default=None, ge=1)
    matchmaking_ready: bool = False
    is_public: bool = False
    is_prime: bool = False

    @model_validator(mode="after")
    def validate_vac_live_fields(self):
        if self.ban_type == BanType.VAC_LIVE:
            if self.vac_live_value is None or self.vac_live_unit is None:
                raise ValueError("VAC Live accounts require vac_live_value and vac_live_unit")
        else:
            self.vac_live_value = None
            self.vac_live_unit = None
            self.vac_live_fault_user_id = None
        return self


class SteamAccountUpdate(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str | None = Field(default=None, min_length=1, max_length=255)
    email: EmailStr
    steam_id: str | None = Field(default=None, min_length=17, max_length=17, pattern=r"^\d{17}$")
    ban_type: BanType = BanType.NONE
    vac_live_value: int | None = Field(default=None, ge=1, le=365)
    vac_live_unit: Literal["hours", "days"] | None = None
    vac_live_fault_user_id: int | None = Field(default=None, ge=1)
    matchmaking_ready: bool = False
    is_public: bool = False
    is_prime: bool = False

    @model_validator(mode="after")
    def validate_vac_live_fields(self):
        if self.ban_type == BanType.VAC_LIVE:
            if self.vac_live_value is None or self.vac_live_unit is None:
                raise ValueError("VAC Live accounts require vac_live_value and vac_live_unit")
        else:
            self.vac_live_value = None
            self.vac_live_unit = None
            self.vac_live_fault_user_id = None
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
    server_now: datetime | None = None
    vac_live_fault_user_id: int | None = None
    vac_live_fault_display: str | None = None
    matchmaking_ready: bool
    is_public: bool
    is_prime: bool
    avatar_url: str | None = None
    steam_profile_name: str | None = None
    online_status: str | None = None
    game_status: str | None = None
    requires_review: bool = False
    suggested_changes: list[str] = []
    suggested_ban_type: BanType | None = None
    pending_review_count: int = 0
    created_at: datetime

    class Config:
        from_attributes = True


class MassImportRequest(BaseModel):
    content: str = Field(min_length=1)
    is_public: bool = False
    is_prime: bool = False


class MassImportError(BaseModel):
    line: int
    message: str
    raw: str


class MassImportResponse(BaseModel):
    created: int
    failed: int
    errors: list[MassImportError]


class AccountSuggestionCreate(BaseModel):
    suggested_ban_type: BanType | None = None
    suggested_vac_live_value: int | None = Field(default=None, ge=1, le=365)
    suggested_vac_live_unit: Literal["hours", "days"] | None = None
    suggested_vac_live_fault_user_id: int | None = Field(default=None, ge=1)
    suggested_matchmaking_ready: bool | None = None
    suggested_is_public: bool | None = None
    note: str | None = Field(default=None, min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_has_change(self):
        if (
            self.suggested_ban_type is None
            and self.suggested_matchmaking_ready is None
            and self.suggested_is_public is None
            and self.note is None
        ):
            raise ValueError("At least one suggested change or note is required")
        if self.suggested_ban_type == BanType.VAC_LIVE:
            if self.suggested_vac_live_value is None or self.suggested_vac_live_unit is None:
                raise ValueError("VAC Live suggestions require suggested_vac_live_value and suggested_vac_live_unit")
        else:
            self.suggested_vac_live_value = None
            self.suggested_vac_live_unit = None
            self.suggested_vac_live_fault_user_id = None
        return self


class AccountSuggestionResolve(BaseModel):
    action: Literal["accept", "decline"]


class AccountSuggestionOut(BaseModel):
    id: int
    account_id: int
    suggested_by_id: int
    suggested_by_username: str
    suggested_by_display_name: str
    suggested_ban_type: BanType | None = None
    suggested_vac_live_value: int | None = None
    suggested_vac_live_unit: Literal["hours", "days"] | None = None
    suggested_vac_live_fault_user_id: int | None = None
    suggested_vac_live_fault_display: str | None = None
    suggested_matchmaking_ready: bool | None = None
    suggested_is_public: bool | None = None
    note: str | None = None
    status: SuggestionStatus
    created_at: datetime
