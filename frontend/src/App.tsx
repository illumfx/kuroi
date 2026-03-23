import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import kuroiLogo from "./assets/kuroi-logo.svg";
import HomePage from "./pages/HomePage";
import ProfilePage from "./pages/ProfilePage";
import AchievementsPage from "./pages/AchievementsPage";
import LeaderboardPage from "./pages/LeaderboardPage";

type BanType = "None" | "VAC" | "GameBanned" | "VACLive";
type BanStatus = "Clean" | "Ban" | "VACLive";

type Account = {
  id: number;
  owner_id: number;
  username: string;
  password: string;
  email: string;
  ban_status?: BanStatus | string;
  steam_id64?: string | null;
  steam_profile_name?: string | null;
  online_status?: string | null;
  game_status?: string | null;
  requires_review?: boolean;
  suggested_changes?: string[];
  suggested_ban_type?: BanType | null;
  pending_review_count?: number;
  ban_type: BanType;
  vac_live_expires_at?: string | null;
  vac_live_remaining?: string | null;
  server_now?: string | null;
  vac_live_fault_user_id?: number | null;
  vac_live_fault_display?: string | null;
  vac_live_fault_count?: number;
  suggested_next_vac_live_value?: number;
  suggested_next_vac_live_unit?: "hours" | "days";
  matchmaking_ready: boolean;
  is_public: boolean;
  is_prime: boolean;
  avatar_url?: string | null;
  created_at: string;
};

type UserProfile = {
  id: number;
  username: string;
  display_name: string;
  email?: string | null;
  has_password?: boolean;
};

type UserChoice = {
  id: number;
  username: string;
  display_name: string;
};

type AppPage = "home" | "profile" | "register" | "achievements" | "leaderboard";

type AuthConfig = {
  oidc_enabled: boolean;
  oidc_configured: boolean;
  allow_invite_link_creation: boolean;
  allow_shiro_login: boolean;
};

type ApiKeyResponse = {
  id: number;
  name: string;
  api_key: string;
  key_prefix: string;
  created_at: string;
};

type InviteCreateResponse = {
  code: string;
  expires_at?: string | null;
  link?: string | null;
};

type ChangePasswordResponse = {
  status: string;
};

type MassImportError = {
  line: number;
  message: string;
  raw: string;
};

type MassImportResponse = {
  created: number;
  failed: number;
  errors: MassImportError[];
};

type AccountSuggestion = {
  id: number;
  account_id: number;
  suggested_by_id: number;
  suggested_by_username: string;
  suggested_by_display_name: string;
  suggested_ban_type?: BanType | null;
  suggested_vac_live_value?: number | null;
  suggested_vac_live_unit?: "hours" | "days" | null;
  suggested_vac_live_fault_user_id?: number | null;
  suggested_vac_live_fault_display?: string | null;
  suggested_matchmaking_ready?: boolean | null;
  suggested_is_public?: boolean | null;
  note?: string | null;
  status: "Pending" | "Accepted" | "Declined";
  created_at: string;
};

type SortOption = "mm_ready" | "mm_not_ready" | "newest" | "oldest" | "username_asc" | "username_desc";
type ViewMode = "table" | "cards" | "compact" | "kanban" | "gallery" | "stats";

const VIEW_MODE_STORAGE_KEY = "kuroi_view_mode";
const isViewMode = (value: string | null): value is ViewMode =>
  value === "table" || value === "cards" || value === "compact" || value === "kanban" || value === "gallery" || value === "stats";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

const resolveAppPage = (pathname: string): AppPage => {
  if (pathname === "/profile") {
    return "profile";
  }
  if (pathname === "/register") {
    return "register";
  }
  if (pathname === "/achievements") {
    return "achievements";
  }
  if (pathname === "/leaderboard") {
    return "leaderboard";
  }
  return "home";
};

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function formatApiDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }

  if (Array.isArray(detail)) {
    const formatted = detail
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const message = "msg" in item ? String(item.msg) : null;
        const location = Array.isArray((item as { loc?: unknown }).loc)
          ? (item as { loc: unknown[] }).loc
              .map((part) => String(part))
              .filter((part) => part !== "body")
              .join(".")
          : "";

        if (message && location) {
          return `${location}: ${message}`;
        }
        return message;
      })
      .filter((line): line is string => Boolean(line));

    if (formatted.length > 0) {
      return formatted.join(" · ");
    }
  }

  if (detail && typeof detail === "object") {
    try {
      return JSON.stringify(detail);
    } catch {
      return "Request failed";
    }
  }

  return "Request failed";
}

async function parseJsonSafe(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({}));
}

async function apiFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(formatApiDetail(error.detail), response.status);
  }

  return response.json() as Promise<T>;
}

function isAccountOnline(account: Account): boolean {
  return ![null, undefined, "", "Offline", "Unknown"].includes(account.online_status ?? null);
}

function formatUserChoiceLabel(user: UserChoice): string {
  return `${user.display_name} (${user.username})`;
}

function parseApiDate(value: string | null | undefined): number | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }

  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeBanType(value: string | null | undefined, fallbackStatus?: string | null): BanType {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "vac") {
    return "VAC";
  }
  if (normalized === "gamebanned" || normalized === "game_banned" || normalized === "game banned") {
    return "GameBanned";
  }
  if (normalized === "vaclive" || normalized === "vac_live") {
    return "VACLive";
  }
  if (normalized === "none" || normalized === "clean") {
    return "None";
  }

  const statusNormalized = (fallbackStatus ?? "").trim().toLowerCase();
  if (statusNormalized === "vaclive") {
    return "VACLive";
  }
  if (statusNormalized === "ban") {
    return "VAC";
  }
  return "None";
}

function normalizeAccount(account: Account): Account {
  const normalizedBanType = normalizeBanType(account.ban_type, account.ban_status);
  const hasSuggestedBanType = typeof account.suggested_ban_type === "string";

  return {
    ...account,
    ban_type: normalizedBanType,
    suggested_ban_type: hasSuggestedBanType
      ? normalizeBanType(account.suggested_ban_type as string)
      : account.suggested_ban_type,
  };
}

function App() {
  const ACCOUNTS_PER_PAGE = 10;
  const LIVE_REFRESH_INTERVAL_MS = 5000;
  const [token, setToken] = useState(localStorage.getItem("kuroi_token") ?? "");
  const [currentPageRoute, setCurrentPageRoute] = useState<AppPage>(() => resolveAppPage(window.location.pathname));
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);
  const [isHeaderMenuRendered, setIsHeaderMenuRendered] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [banFilter, setBanFilter] = useState<"all" | BanType>("all");
  const [usernameSearch, setUsernameSearch] = useState("");
  const [sortOption, setSortOption] = useState<SortOption>("mm_ready");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return isViewMode(stored) ? stored : "table";
  });
  const [showPublicAccounts, setShowPublicAccounts] = useState(false);
  const [showOnlyPendingReviews, setShowOnlyPendingReviews] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [uiNotice, setUiNotice] = useState("");
  const [error, setError] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const [oidcVisible, setOidcVisible] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [currentUsername, setCurrentUsername] = useState("");
  const [currentDisplayName, setCurrentDisplayName] = useState("");
  const [profileDisplayNameInput, setProfileDisplayNameInput] = useState("");
  const [currentEmail, setCurrentEmail] = useState("");
  const [canChangePassword, setCanChangePassword] = useState(false);
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [userOptions, setUserOptions] = useState<UserChoice[]>([]);

  const [generatedApiKey, setGeneratedApiKey] = useState("");
  const [generatedInviteLink, setGeneratedInviteLink] = useState("");
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [suggestAccount, setSuggestAccount] = useState<Account | null>(null);
  const [reviewAccount, setReviewAccount] = useState<Account | null>(null);
  const [reviewSuggestions, setReviewSuggestions] = useState<AccountSuggestion[]>([]);
  const [isLoadingReviewSuggestions, setIsLoadingReviewSuggestions] = useState(false);
  const [reviewButtonHints, setReviewButtonHints] = useState<Record<number, string>>({});
  const [isSubmittingSuggestion, setIsSubmittingSuggestion] = useState(false);
  const [resolvingSuggestionId, setResolvingSuggestionId] = useState<number | null>(null);
  const [hasStickyActionsOverlap, setHasStickyActionsOverlap] = useState(false);
  const [suggestionForm, setSuggestionForm] = useState<{
    suggested_ban_type: "" | BanType;
    suggested_vac_live_value: string;
    suggested_vac_live_unit: "hours" | "days";
    suggested_vac_live_fault_user_id: string;
    suggested_matchmaking_ready: "" | "true" | "false";
    suggested_is_public: "" | "true" | "false";
    note: string;
  }>({
    suggested_ban_type: "",
    suggested_vac_live_value: "20",
    suggested_vac_live_unit: "hours",
    suggested_vac_live_fault_user_id: "",
    suggested_matchmaking_ready: "",
    suggested_is_public: "",
    note: "",
  });
  const [massImportContent, setMassImportContent] = useState("");
  const [massImportPublic, setMassImportPublic] = useState(false);
  const [massImportPrime, setMassImportPrime] = useState(false);
  const [massImportResult, setMassImportResult] = useState<MassImportResponse | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  // Shiro (Steam one-click login) state
  const [shiroLoginAccount, setShiroLoginAccount] = useState<Account | null>(null);
  const [shiroLoading, setShiroLoading] = useState(false);
  const [shiroMessage, setShiroMessage] = useState("");
  const [showManagementTools, setShowManagementTools] = useState(false);
  const [allowInviteLinkCreation, setAllowInviteLinkCreation] = useState(false);
  const [allowShiroLogin, setAllowShiroLogin] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<number>>(new Set());
  const [hasNewPendingReviewsPulse, setHasNewPendingReviewsPulse] = useState(false);
  const lastOwnPendingReviewCountRef = useRef(0);
  const pendingPulseTimeoutRef = useRef<number | null>(null);
  const uiNoticeTimeoutRef = useRef<number | null>(null);
  const headerMenuCloseTimeoutRef = useRef<number | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const extrasButtonRef = useRef<HTMLButtonElement | null>(null);
  const headerMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [headerMenuPosition, setHeaderMenuPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const showUiNotice = (message: string) => {
    setUiNotice(message);
    if (uiNoticeTimeoutRef.current) {
      window.clearTimeout(uiNoticeTimeoutRef.current);
    }
    uiNoticeTimeoutRef.current = window.setTimeout(() => {
      setUiNotice("");
      uiNoticeTimeoutRef.current = null;
    }, 2500);
  };

  const navigateToPage = (page: AppPage) => {
    const targetPath =
      page === "profile"
        ? "/profile"
        : page === "register"
          ? "/register"
          : page === "achievements"
            ? "/achievements"
            : page === "leaderboard"
              ? "/leaderboard"
              : "/";
    if (window.location.pathname !== targetPath) {
      window.history.pushState(null, "", targetPath);
    }
    setIsHeaderMenuOpen(false);
    setCurrentPageRoute(page);
  };

  const updateHeaderMenuPosition = () => {
    const button = extrasButtonRef.current;
    if (!button) {
      return;
    }

    const rect = button.getBoundingClientRect();
    const menuWidth = headerMenuPanelRef.current?.offsetWidth ?? 180;
    const centeredLeft = rect.left + rect.width / 2 - menuWidth / 2;
    const clampedLeft = Math.min(Math.max(centeredLeft, 8), window.innerWidth - menuWidth - 8);
    setHeaderMenuPosition({
      top: rect.bottom + 8,
      left: clampedLeft,
    });
  };

  const clearSession = (message?: string) => {
    setToken("");
    setAccounts([]);
    setGeneratedApiKey("");
    setGeneratedInviteLink("");
    setServerClockOffsetMs(0);
    setCountdownNow(Date.now());
    setSelectedAccountIds(new Set());
    setCurrentUserId(null);
    setCurrentUsername("");
    setCurrentDisplayName("");
    setProfileDisplayNameInput("");
    setCurrentEmail("");
    setCanChangePassword(false);
    setUserOptions([]);
    setCurrentPasswordInput("");
    setNewPasswordInput("");
    setError("");
    setSessionNotice(message ?? "");
    setCurrentPageRoute("home");
    setIsHeaderMenuOpen(false);
    localStorage.removeItem("kuroi_token");
  };

  const [multiEditOpen, setMultiEditOpen] = useState(false);
  const [multiEdit, setMultiEdit] = useState<{
    ban_type: BanType;
    vac_live_value: string;
    vac_live_unit: "hours" | "days";
    vac_live_fault_user_id: string;
    matchmaking_ready: boolean;
    is_public: boolean;
    apply_ban_type: boolean;
    apply_mm_ready: boolean;
    apply_is_public: boolean;
  }>({
    ban_type: "None",
    vac_live_value: "20",
    vac_live_unit: "hours",
    vac_live_fault_user_id: "",
    matchmaking_ready: false,
    is_public: false,
    apply_ban_type: false,
    apply_mm_ready: false,
    apply_is_public: false,
  });

  const [newAccount, setNewAccount] = useState({
    username: "",
    password: "",
    email: "",
    steam_id: "",
    ban_type: "None" as BanType,
    vac_live_value: "20",
    vac_live_unit: "hours" as "hours" | "days",
    vac_live_fault_user_id: "",
    matchmaking_ready: false,
    is_public: false,
    is_prime: false,
  });

  const [editAccount, setEditAccount] = useState({
    username: "",
    password: "",
    email: "",
    steam_id: "",
    ban_type: "None" as BanType,
    vac_live_value: "20",
    vac_live_unit: "hours" as "hours" | "days",
    vac_live_fault_user_id: "",
    matchmaking_ready: false,
    is_public: false,
    is_prime: false,
  });

  const [registerUsername, setRegisterUsername] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerInviteCode, setRegisterInviteCode] = useState("");
  const [registerTouched, setRegisterTouched] = useState({
    username: false,
    email: false,
    password: false,
    inviteCode: false,
  });
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const isLoggedIn = useMemo(() => token.length > 0, [token]);
  const normalizedRegisterEmail = registerEmail.trim();
  const isRegisterEmailValid = normalizedRegisterEmail.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedRegisterEmail);
  const isRegisterUsernameValid = registerUsername.trim().length >= 3;
  const isRegisterPasswordValid = registerPassword.length >= 8;
  const isRegisterInviteCodeValid = registerInviteCode.trim().length >= 6;
  const isRegisterFormValid =
    isRegisterUsernameValid &&
    isRegisterPasswordValid &&
    isRegisterInviteCodeValid &&
    isRegisterEmailValid;
  const registerUsernameInvalid = registerTouched.username && !isRegisterUsernameValid;
  const registerEmailInvalid = registerTouched.email && !isRegisterEmailValid;
  const registerPasswordInvalid = registerTouched.password && !isRegisterPasswordValid;
  const registerInviteCodeInvalid = registerTouched.inviteCode && !isRegisterInviteCodeValid;
  const registerUsernameValidHighlight = registerTouched.username && isRegisterUsernameValid;
  const registerEmailValidHighlight = registerTouched.email && isRegisterEmailValid;
  const registerPasswordValidHighlight = registerTouched.password && isRegisterPasswordValid;
  const registerInviteCodeValidHighlight = registerTouched.inviteCode && isRegisterInviteCodeValid;
  const filteredAccounts = useMemo(() => {
    const query = usernameSearch.trim().toLowerCase();
    const base = showOnlyPendingReviews
      ? accounts.filter((account) => currentUserId === account.owner_id && (account.pending_review_count ?? 0) > 0)
      : accounts;

    if (!query) {
      return base;
    }
    return base.filter((account) => {
      const accountName = account.username.toLowerCase();
      const profileName = (account.steam_profile_name ?? "").toLowerCase();
      return accountName.includes(query) || profileName.includes(query);
    });
  }, [accounts, usernameSearch, showOnlyPendingReviews, currentUserId]);

  const sortedAccounts = useMemo(() => {
    const items = [...filteredAccounts];

    if (sortOption === "mm_ready") {
      const isEffectivelyBannedForSort = (account: Account) => {
        const normalized = account.ban_type.trim().toLowerCase();
        if (normalized === "vac" || normalized === "gamebanned") {
          return true;
        }
        if (normalized === "vaclive") {
          const expiresAt = parseApiDate(account.vac_live_expires_at);
          if (expiresAt !== null) {
            return expiresAt > countdownNow;
          }
          return Boolean(account.vac_live_remaining && account.vac_live_remaining !== "Expired");
        }
        return false;
      };

      return items.sort((a, b) => {
        const aIsBanned = isEffectivelyBannedForSort(a);
        const bIsBanned = isEffectivelyBannedForSort(b);
        const aRank = a.matchmaking_ready ? (aIsBanned ? 1 : 0) : aIsBanned ? 3 : 2;
        const bRank = b.matchmaking_ready ? (bIsBanned ? 1 : 0) : bIsBanned ? 3 : 2;
        if (aRank !== bRank) {
          return aRank - bRank;
        }
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    }

    if (sortOption === "mm_not_ready") {
      return items.sort((a, b) => {
        if (a.matchmaking_ready !== b.matchmaking_ready) {
          return Number(a.matchmaking_ready) - Number(b.matchmaking_ready);
        }
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    }

    if (sortOption === "newest") {
      return items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    if (sortOption === "oldest") {
      return items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }

    if (sortOption === "username_asc") {
      return items.sort((a, b) => a.username.localeCompare(b.username));
    }

    return items.sort((a, b) => b.username.localeCompare(a.username));
  }, [filteredAccounts, sortOption, countdownNow]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(sortedAccounts.length / ACCOUNTS_PER_PAGE)), [sortedAccounts.length]);
  const pageNumbers = useMemo(() => Array.from({ length: totalPages }, (_, index) => index + 1), [totalPages]);
  const paginatedAccounts = useMemo(() => {
    const start = (currentPage - 1) * ACCOUNTS_PER_PAGE;
    return sortedAccounts.slice(start, start + ACCOUNTS_PER_PAGE);
  }, [sortedAccounts, currentPage]);
  const ownAccounts = useMemo(
    () => sortedAccounts.filter((account) => currentUserId !== null && account.owner_id === currentUserId),
    [sortedAccounts, currentUserId],
  );
  const ownPaginatedAccounts = useMemo(
    () => paginatedAccounts.filter((account) => currentUserId !== null && account.owner_id === currentUserId),
    [paginatedAccounts, currentUserId],
  );
  const ownPendingReviewCount = useMemo(
    () => accounts.filter((account) => currentUserId !== null && account.owner_id === currentUserId && (account.pending_review_count ?? 0) > 0).length,
    [accounts, currentUserId],
  );
  const kanbanColumns = useMemo(
    () => ({
      clean: paginatedAccounts.filter((account) => account.ban_type === "None"),
      banned: paginatedAccounts.filter((account) => account.ban_type === "VAC" || account.ban_type === "GameBanned"),
      vacLive: paginatedAccounts.filter((account) => account.ban_type === "VACLive"),
    }),
    [paginatedAccounts],
  );
  const accountStats = useMemo(() => {
    const total = sortedAccounts.length;
    const mmReady = sortedAccounts.filter((account) => account.matchmaking_ready).length;
    const publicCount = sortedAccounts.filter((account) => account.is_public).length;
    const vacLive = sortedAccounts.filter((account) => account.ban_type === "VACLive").length;
    const banned = sortedAccounts.filter((account) => account.ban_type === "VAC" || account.ban_type === "GameBanned").length;
    const clean = sortedAccounts.filter((account) => account.ban_type === "None").length;
    const pendingReviews = sortedAccounts.filter((account) => (account.pending_review_count ?? 0) > 0).length;

    return { total, mmReady, publicCount, vacLive, banned, clean, pendingReviews };
  }, [sortedAccounts]);

  useEffect(() => {
    if (ownPendingReviewCount > lastOwnPendingReviewCountRef.current) {
      setHasNewPendingReviewsPulse(true);
      showUiNotice(
        ownPendingReviewCount === 1
          ? "You have 1 account with pending review"
          : `You have ${ownPendingReviewCount} accounts with pending review`,
      );
      if (pendingPulseTimeoutRef.current) {
        window.clearTimeout(pendingPulseTimeoutRef.current);
      }
      pendingPulseTimeoutRef.current = window.setTimeout(() => {
        setHasNewPendingReviewsPulse(false);
        pendingPulseTimeoutRef.current = null;
      }, 6000);
    } else if (ownPendingReviewCount === 0) {
      setHasNewPendingReviewsPulse(false);
      if (pendingPulseTimeoutRef.current) {
        window.clearTimeout(pendingPulseTimeoutRef.current);
        pendingPulseTimeoutRef.current = null;
      }
    }

    lastOwnPendingReviewCountRef.current = ownPendingReviewCount;
  }, [ownPendingReviewCount]);

  useEffect(() => {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    return () => {
      if (pendingPulseTimeoutRef.current) {
        window.clearTimeout(pendingPulseTimeoutRef.current);
      }
      if (uiNoticeTimeoutRef.current) {
        window.clearTimeout(uiNoticeTimeoutRef.current);
      }
    };
  }, []);
  const selectedOwnAccounts = useMemo(
    () => ownAccounts.filter((account) => selectedAccountIds.has(account.id)),
    [ownAccounts, selectedAccountIds],
  );
  const allOwnOnPageSelected =
    ownPaginatedAccounts.length > 0 && ownPaginatedAccounts.every((account) => selectedAccountIds.has(account.id));
  const isExtrasPageActive = currentPageRoute === "achievements" || currentPageRoute === "leaderboard";

  useEffect(() => {
    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!isHeaderMenuOpen) {
        return;
      }

      if (!(event.target instanceof Node)) {
        return;
      }

      const clickedInsideTrigger = headerMenuRef.current?.contains(event.target) ?? false;
      const clickedInsideMenu = headerMenuPanelRef.current?.contains(event.target) ?? false;

      if (!clickedInsideTrigger && !clickedInsideMenu) {
        setIsHeaderMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleDocumentMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
    };
  }, [isHeaderMenuOpen]);

  useEffect(() => {
    if (isHeaderMenuOpen) {
      if (headerMenuCloseTimeoutRef.current) {
        window.clearTimeout(headerMenuCloseTimeoutRef.current);
        headerMenuCloseTimeoutRef.current = null;
      }
      setIsHeaderMenuRendered(true);
      return;
    }

    if (!isHeaderMenuRendered) {
      return;
    }

    headerMenuCloseTimeoutRef.current = window.setTimeout(() => {
      setIsHeaderMenuRendered(false);
      headerMenuCloseTimeoutRef.current = null;
    }, 150);

    return () => {
      if (headerMenuCloseTimeoutRef.current) {
        window.clearTimeout(headerMenuCloseTimeoutRef.current);
        headerMenuCloseTimeoutRef.current = null;
      }
    };
  }, [isHeaderMenuOpen, isHeaderMenuRendered]);

  useEffect(() => {
    if (!isHeaderMenuOpen) {
      return;
    }

    updateHeaderMenuPosition();

    const handleViewportChange = () => {
      updateHeaderMenuPosition();
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isHeaderMenuOpen]);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPageRoute(resolveAppPage(window.location.pathname));
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!isLoggedIn && (currentPageRoute === "profile" || currentPageRoute === "achievements" || currentPageRoute === "leaderboard")) {
      navigateToPage("home");
    }
    if (!isLoggedIn && currentPageRoute === "register" && !allowInviteLinkCreation) {
      navigateToPage("home");
    }
    if (isLoggedIn && currentPageRoute === "register") {
      navigateToPage("home");
    }
  }, [isLoggedIn, currentPageRoute, allowInviteLinkCreation]);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) {
      return;
    }

    const params = new URLSearchParams(hash);
    const newToken = params.get("token");
    const oidcError = params.get("error");

    if (newToken) {
      setToken(newToken);
      localStorage.setItem("kuroi_token", newToken);
    }

    if (oidcError) {
      setError(oidcError);
    }

    if (newToken || oidcError) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteFromUrl = params.get("invite");
    if (!inviteFromUrl) {
      return;
    }

    setRegisterInviteCode(inviteFromUrl);
    setRegisterTouched((previous) => ({ ...previous, inviteCode: true }));
    setSessionNotice("Invite code was loaded from the invite link.");
    setCurrentPageRoute("register");
    params.delete("invite");
    const newSearch = params.toString();
    const targetUrl = `/register${newSearch ? `?${newSearch}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", targetUrl);
  }, []);

  useEffect(() => {
    const loadAuthConfig = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/auth/config`);
        if (!response.ok) {
          setOidcVisible(false);
          setAllowInviteLinkCreation(false);
          setAllowShiroLogin(false);
          return;
        }
        const config = (await response.json()) as AuthConfig;
        setOidcVisible(config.oidc_enabled);
        setAllowInviteLinkCreation(config.allow_invite_link_creation);
        setAllowShiroLogin(config.allow_shiro_login);
      } catch {
        setOidcVisible(false);
        setAllowInviteLinkCreation(false);
        setAllowShiroLogin(false);
      }
    };

    loadAuthConfig();
  }, []);

  const loadAccounts = async (filter = banFilter, includePublic = showPublicAccounts, resetPage = true) => {
    if (!token) {
      return;
    }

    const params = new URLSearchParams();
    if (filter !== "all") {
      params.set("ban_type", filter);
    }
    if (includePublic) {
      params.set("include_public", "true");
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    try {
      const data = await apiFetch<Account[]>(`/accounts${query}`, token);
      const normalizedAccounts = data.map(normalizeAccount);
      const serverNow = normalizedAccounts.reduce<number | null>((found, account) => found ?? parseApiDate(account.server_now), null);
      if (serverNow !== null) {
        const offset = serverNow - Date.now();
        setServerClockOffsetMs(offset);
        setCountdownNow(serverNow);
      }
      setAccounts(normalizedAccounts);
      if (resetPage) {
        setCurrentPage(1);
      }
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        clearSession("Session expired. Please log in again.");
        return;
      }
      setError(requestError instanceof Error ? requestError.message : "Could not load accounts");
    }
  };

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    setCurrentPage(1);
  }, [usernameSearch]);

  useEffect(() => {
    if (currentUserId === null) {
      setSelectedAccountIds(new Set());
      return;
    }

    const ownIds = new Set(ownAccounts.map((account) => account.id));
    setSelectedAccountIds((previous) => {
      const next = new Set<number>();
      for (const id of previous) {
        if (ownIds.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
  }, [currentUserId, ownAccounts]);

  useEffect(() => {
    if (!token) {
      return;
    }
    loadAccounts();
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    const loadProfile = async () => {
      try {
        const me = await apiFetch<UserProfile>("/auth/me", token);
        setCurrentUserId(me.id);
        setCurrentUsername(me.username);
        setCurrentDisplayName(me.display_name);
        setProfileDisplayNameInput(me.display_name);
        setCurrentEmail(me.email ?? "");
        setCanChangePassword(Boolean(me.has_password));
      } catch (requestError) {
        if (requestError instanceof ApiError && requestError.status === 401) {
          clearSession("Session expired. Please log in again.");
          return;
        }
        setCurrentUserId(null);
        setCurrentUsername("");
        setCurrentDisplayName("");
        setProfileDisplayNameInput("");
        setCurrentEmail("");
        setCanChangePassword(false);
      }
    };

    loadProfile();
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    const loadUsers = async () => {
      try {
        const users = await apiFetch<UserChoice[]>("/users", token);
        setUserOptions(users);
      } catch (requestError) {
        if (requestError instanceof ApiError && requestError.status === 401) {
          clearSession("Session expired. Please log in again.");
          return;
        }
        setUserOptions([]);
      }
    };

    loadUsers();
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    const refreshInBackground = async () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      await loadAccounts(banFilter, showPublicAccounts, false);
    };

    const intervalId = window.setInterval(() => {
      void refreshInBackground();
    }, LIVE_REFRESH_INTERVAL_MS);

    const handleFocus = () => {
      void refreshInBackground();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshInBackground();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [token, banFilter, showPublicAccounts]);

  useEffect(() => {
    if (!isLoggedIn) {
      return;
    }

    setCountdownNow(Date.now() + serverClockOffsetMs);

    const intervalId = window.setInterval(() => {
      setCountdownNow(Date.now() + serverClockOffsetMs);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isLoggedIn, serverClockOffsetMs]);

  const handleLocalLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSessionNotice("");

    try {
      const response = await fetch(`${apiBaseUrl}/auth/local-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await parseJsonSafe(response);
      if (!response.ok) {
        throw new Error(formatApiDetail(data.detail));
      }
      const accessToken = typeof data.access_token === "string" ? data.access_token : "";
      if (!accessToken) {
        throw new Error("Login response is missing access token");
      }
      setToken(accessToken);
      localStorage.setItem("kuroi_token", accessToken);
      navigateToPage("home");
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected error");
    }
  };

  const handleOidcLogin = async () => {
    setError("");
    setSessionNotice("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/oidc/login`);
      const data = await parseJsonSafe(response);
      if (!response.ok) {
        throw new Error(formatApiDetail(data.detail));
      }
      if (typeof data.authorization_url !== "string" || !data.authorization_url) {
        throw new Error("OIDC authorization URL is missing");
      }
      window.location.href = data.authorization_url;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected OIDC error");
    }
  };

  const handleRegister = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSessionNotice("");

    if (!isRegisterFormValid) {
      setRegisterTouched({ username: true, email: true, password: true, inviteCode: true });
      setError("Please fix the highlighted registration fields.");
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: registerUsername.trim(),
          email: normalizedRegisterEmail,
          password: registerPassword,
          invite_code: registerInviteCode.trim(),
        }),
      });
      const data = await parseJsonSafe(response);
      if (!response.ok) {
        throw new Error(formatApiDetail(data.detail));
      }

      const accessToken = typeof data.access_token === "string" ? data.access_token : "";
      if (!accessToken) {
        throw new Error("Register response is missing access token");
      }

      setToken(accessToken);
      localStorage.setItem("kuroi_token", accessToken);
      navigateToPage("home");
      setRegisterUsername("");
      setRegisterEmail("");
      setRegisterPassword("");
      setRegisterInviteCode("");
      setRegisterTouched({ username: false, email: false, password: false, inviteCode: false });
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected registration error");
    }
  };

  const handleCreateAccount = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    try {
      const payload: Record<string, unknown> = {
        username: newAccount.username,
        password: newAccount.password,
        email: newAccount.email,
        ban_type: newAccount.ban_type,
        matchmaking_ready: newAccount.matchmaking_ready,
        is_public: newAccount.is_public,
        is_prime: newAccount.is_prime,
      };
      const normalizedSteamId = newAccount.steam_id.trim();
      if (normalizedSteamId) {
        payload.steam_id = normalizedSteamId;
      }

      if (newAccount.ban_type === "VACLive") {
        payload.vac_live_value = Number(newAccount.vac_live_value);
        payload.vac_live_unit = newAccount.vac_live_unit;
        if (newAccount.vac_live_fault_user_id) {
          payload.vac_live_fault_user_id = Number(newAccount.vac_live_fault_user_id);
        }
      }

      await apiFetch<Account>("/accounts", token, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setNewAccount({
        username: "",
        password: "",
        email: "",
        steam_id: "",
        ban_type: "None",
        vac_live_value: "20",
        vac_live_unit: "hours",
        vac_live_fault_user_id: "",
        matchmaking_ready: false,
        is_public: false,
        is_prime: false,
      });
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected error");
    }
  };

  const handleCreateApiKey = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    const confirmed = window.confirm(
      "Generating a new API key will invalidate and delete your previous key. Continue?",
    );
    if (!confirmed) {
      return;
    }

    try {
      const response = await apiFetch<ApiKeyResponse>("/auth/api-keys", token, {
        method: "POST",
        body: JSON.stringify({ name: "automation-script" }),
      });
      setGeneratedApiKey(response.api_key);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected API key error");
    }
  };

  const handleCreateInviteLink = async () => {
    setError("");

    try {
      const response = await apiFetch<InviteCreateResponse>("/auth/invite", token, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const fallbackLink = `${window.location.origin}/?invite=${encodeURIComponent(response.code)}`;
      setGeneratedInviteLink(response.link ?? fallbackLink);
      showUiNotice("Invite link created");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected invite link error");
    }
  };

  const handleChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSessionNotice("");

    if (!canChangePassword) {
      setError("Password change is only available for local accounts.");
      return;
    }

    setIsChangingPassword(true);
    try {
      await apiFetch<ChangePasswordResponse>("/auth/change-password", token, {
        method: "POST",
        body: JSON.stringify({
          current_password: currentPasswordInput,
          new_password: newPasswordInput,
        }),
      });
      setCurrentPasswordInput("");
      setNewPasswordInput("");
      showUiNotice("Password updated");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected password change error");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleUpdateProfile = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    const nextDisplayName = profileDisplayNameInput.trim();
    if (!nextDisplayName) {
      setError("Display name is required.");
      return;
    }

    setIsUpdatingProfile(true);
    try {
      const updated = await apiFetch<UserProfile>("/auth/me", token, {
        method: "PATCH",
        body: JSON.stringify({ display_name: nextDisplayName }),
      });
      setCurrentDisplayName(updated.display_name);
      setProfileDisplayNameInput(updated.display_name);
      showUiNotice("Display name updated");
      setUserOptions((previous) =>
        previous.map((entry) =>
          entry.id === updated.id
            ? { ...entry, display_name: updated.display_name, username: updated.username }
            : entry,
        ),
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected profile update error");
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const handleMassImport = async (event: FormEvent) => {
    event.preventDefault();
    if (!massImportContent.trim()) {
      return;
    }

    setError("");
    setMassImportResult(null);
    setIsImporting(true);
    try {
      const response = await apiFetch<MassImportResponse>("/accounts/mass-import", token, {
        method: "POST",
        body: JSON.stringify({ content: massImportContent, is_public: massImportPublic, is_prime: massImportPrime }),
      });
      setMassImportResult(response);
      setMassImportContent("");
      setMassImportPrime(false);
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected mass import error");
    } finally {
      setIsImporting(false);
    }
  };

  const handleFilterChange = async (value: "all" | BanType) => {
    setBanFilter(value);
    await loadAccounts(value, showPublicAccounts);
  };

  const handlePublicToggle = async (value: boolean) => {
    setShowPublicAccounts(value);
    await loadAccounts(banFilter, value);
  };

  const startEditAccount = (account: Account) => {
    const normalizedBanType = normalizeBanType(account.ban_type, account.ban_status);
    setEditingAccountId(account.id);
    setEditAccount({
      username: account.username,
      password: isAccountOnline(account) ? "" : account.password,
      email: account.email,
      steam_id: account.steam_id64 ?? "",
      ban_type: normalizedBanType,
      vac_live_value: "20",
      vac_live_unit: "hours",
      vac_live_fault_user_id: account.vac_live_fault_user_id ? String(account.vac_live_fault_user_id) : "",
      matchmaking_ready: account.matchmaking_ready,
      is_public: account.is_public,
      is_prime: account.is_prime,
    });
  };

  const handleUpdateAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingAccountId) {
      return;
    }

    setError("");
    try {
      const payload: Record<string, unknown> = {
        username: editAccount.username,
        email: editAccount.email,
        ban_type: editAccount.ban_type,
        matchmaking_ready: editAccount.matchmaking_ready,
        is_public: editAccount.is_public,
        is_prime: editAccount.is_prime,
      };
      const normalizedPassword = editAccount.password.trim();
      if (normalizedPassword) {
        payload.password = normalizedPassword;
      }
      const normalizedSteamId = editAccount.steam_id.trim();
      if (normalizedSteamId) {
        payload.steam_id = normalizedSteamId;
      }
      if (editAccount.ban_type === "VACLive") {
        payload.vac_live_value = Number(editAccount.vac_live_value);
        payload.vac_live_unit = editAccount.vac_live_unit;
        if (editAccount.vac_live_fault_user_id) {
          payload.vac_live_fault_user_id = Number(editAccount.vac_live_fault_user_id);
        }
      }

      await apiFetch<Account>(`/accounts/${editingAccountId}`, token, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setEditingAccountId(null);
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected update error");
    }
  };

  const handleDeleteAccount = async (accountId: number) => {
    const confirmed = window.confirm("Do you really want to delete this account?");
    if (!confirmed) {
      return;
    }

    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/accounts/${accountId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(formatApiDetail(payload.detail));
      }
      if (editingAccountId === accountId) {
        setEditingAccountId(null);
      }
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected delete error");
    }
  };

  const openSuggestModal = (account: Account) => {
    const suggestedValue = account.suggested_next_vac_live_value && account.suggested_next_vac_live_value > 0
      ? String(account.suggested_next_vac_live_value)
      : "20";
    const suggestedUnit = account.suggested_next_vac_live_unit === "days" ? "days" : "hours";

    setSuggestAccount(account);
    setSuggestionForm({
      suggested_ban_type: "",
      suggested_vac_live_value: suggestedValue,
      suggested_vac_live_unit: suggestedUnit,
      suggested_vac_live_fault_user_id: "",
      suggested_matchmaking_ready: "",
      suggested_is_public: "",
      note: "",
    });
  };

  const handleSubmitSuggestion = async (event: FormEvent) => {
    event.preventDefault();
    if (!suggestAccount) {
      return;
    }

    setError("");
    setIsSubmittingSuggestion(true);
    try {
      const payload: Record<string, unknown> = {};
      if (suggestionForm.suggested_ban_type) {
        payload.suggested_ban_type = suggestionForm.suggested_ban_type;
      }
      if (suggestionForm.suggested_ban_type === "VACLive") {
        payload.suggested_vac_live_value = Number(suggestionForm.suggested_vac_live_value);
        payload.suggested_vac_live_unit = suggestionForm.suggested_vac_live_unit;
        if (suggestionForm.suggested_vac_live_fault_user_id) {
          payload.suggested_vac_live_fault_user_id = Number(suggestionForm.suggested_vac_live_fault_user_id);
        }
      }
      if (suggestionForm.suggested_matchmaking_ready) {
        payload.suggested_matchmaking_ready = suggestionForm.suggested_matchmaking_ready === "true";
      }
      if (suggestionForm.suggested_is_public) {
        payload.suggested_is_public = suggestionForm.suggested_is_public === "true";
      }
      const note = suggestionForm.note.trim();
      if (note) {
        payload.note = note;
      }

      await apiFetch<AccountSuggestion>(`/accounts/${suggestAccount.id}/suggestions`, token, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSuggestAccount(null);
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not submit suggestion");
    } finally {
      setIsSubmittingSuggestion(false);
    }
  };

  const openReviewModal = async (account: Account) => {
    setReviewAccount(account);
    setError("");
    setIsLoadingReviewSuggestions(true);
    try {
      const items = await apiFetch<AccountSuggestion[]>(`/accounts/${account.id}/suggestions`, token);
      setReviewSuggestions(items);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load suggestions");
      setReviewSuggestions([]);
    } finally {
      setIsLoadingReviewSuggestions(false);
    }
  };

  const prefetchReviewHint = async (account: Account) => {
    if (reviewButtonHints[account.id] || (account.pending_review_count ?? 0) === 0) {
      return;
    }

    try {
      const items = await apiFetch<AccountSuggestion[]>(`/accounts/${account.id}/suggestions`, token);
      if (!items.length) {
        setReviewButtonHints((previous) => ({ ...previous, [account.id]: "No pending suggestions" }));
        return;
      }

      const vacLiveSuggestion = items.find(
        (item) => item.suggested_ban_type === "VACLive" && item.suggested_vac_live_value && item.suggested_vac_live_unit,
      );
      if (vacLiveSuggestion && vacLiveSuggestion.suggested_vac_live_value && vacLiveSuggestion.suggested_vac_live_unit) {
        setReviewButtonHints((previous) => ({
          ...previous,
          [account.id]: `Pending: VACLive ${vacLiveSuggestion.suggested_vac_live_value} ${vacLiveSuggestion.suggested_vac_live_unit}`,
        }));
        return;
      }

      const firstSuggestion = items[0];
      const banHint = firstSuggestion.suggested_ban_type ? `Ban ${firstSuggestion.suggested_ban_type}` : "Pending suggestion";
      setReviewButtonHints((previous) => ({ ...previous, [account.id]: banHint }));
    } catch {
      setReviewButtonHints((previous) => ({ ...previous, [account.id]: "Open to review pending suggestions" }));
    }
  };

  const handleResolveSuggestion = async (account: Account, suggestionId: number, action: "accept" | "decline") => {
    setResolvingSuggestionId(suggestionId);
    setError("");
    try {
      await apiFetch<Account>(`/accounts/${account.id}/suggestions/${suggestionId}/resolve`, token, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      const items = await apiFetch<AccountSuggestion[]>(`/accounts/${account.id}/suggestions`, token);
      if (items.length === 0) {
        setReviewAccount(null);
        setReviewSuggestions([]);
      } else {
        setReviewSuggestions(items);
      }
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not resolve suggestion");
    } finally {
      setResolvingSuggestionId(null);
    }
  };

  const openMultiEdit = () => {
    setMultiEdit({
      ban_type: "None",
      vac_live_value: "20",
      vac_live_unit: "hours",
      vac_live_fault_user_id: "",
      matchmaking_ready: false,
      is_public: false,
      apply_ban_type: false,
      apply_mm_ready: false,
      apply_is_public: false,
    });
    setMultiEditOpen(true);
  };

  const handleMultiEdit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    try {
      const normalizedVacLiveValue = Number(multiEdit.vac_live_value);
      if (
        multiEdit.apply_ban_type &&
        multiEdit.ban_type === "VACLive" &&
        (!Number.isFinite(normalizedVacLiveValue) || normalizedVacLiveValue < 1 || normalizedVacLiveValue > 365)
      ) {
        throw new Error("VAC Live duration must be a number between 1 and 365");
      }

      for (const account of selectedOwnAccounts) {
        const payload: Record<string, unknown> = {
          username: account.username,
          email: account.email,
          ban_type: multiEdit.apply_ban_type ? multiEdit.ban_type : account.ban_type,
          matchmaking_ready: multiEdit.apply_mm_ready ? multiEdit.matchmaking_ready : account.matchmaking_ready,
          is_public: multiEdit.apply_is_public ? multiEdit.is_public : account.is_public,
          is_prime: account.is_prime,
        };
        if (account.password) {
          payload.password = account.password;
        }
        const steamId = account.steam_id64?.trim();
        if (steamId) {
          payload.steam_id = steamId;
        }
        const effectiveBanType = multiEdit.apply_ban_type ? multiEdit.ban_type : account.ban_type;
        if (effectiveBanType === "VACLive" && multiEdit.apply_ban_type) {
          payload.vac_live_value = normalizedVacLiveValue;
          payload.vac_live_unit = multiEdit.vac_live_unit;
          if (multiEdit.vac_live_fault_user_id) {
            payload.vac_live_fault_user_id = Number(multiEdit.vac_live_fault_user_id);
          }
        }

        await apiFetch<Account>(`/accounts/${account.id}`, token, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }

      setMultiEditOpen(false);
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected multi-edit error");
    }
  };

  const handleLogout = () => {
    clearSession();
  };

  const downloadAccountsTxt = (rows: Account[], fileName: string) => {
    if (!rows.length) {
      setError("No accounts to export");
      return;
    }

    const formatMassImportTimestamp = (value: string | null | undefined) => {
      const raw = (value ?? "").trim();
      if (!raw) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        const hours = String(now.getHours()).padStart(2, "0");
        const minutes = String(now.getMinutes()).padStart(2, "0");
        const seconds = String(now.getSeconds()).padStart(2, "0");
        const microseconds = `${String(now.getMilliseconds()).padStart(3, "0")}000`;
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${microseconds}`;
      }

      const normalized = raw.replace("T", " ").replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
      const timestampMatch = normalized.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d+))?$/);
      if (timestampMatch) {
        const base = timestampMatch[1];
        const fraction = (timestampMatch[2] ?? "").padEnd(6, "0").slice(0, 6);
        return `${base}.${fraction}`;
      }

      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, "0");
        const day = String(parsed.getDate()).padStart(2, "0");
        const hours = String(parsed.getHours()).padStart(2, "0");
        const minutes = String(parsed.getMinutes()).padStart(2, "0");
        const seconds = String(parsed.getSeconds()).padStart(2, "0");
        const microseconds = `${String(parsed.getMilliseconds()).padStart(3, "0")}000`;
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${microseconds}`;
      }

      return raw;
    };

    const textLines = rows.map((account) => {
      const timestamp = formatMassImportTimestamp(account.created_at);
      const email = account.email.trim();
      const username = account.username.trim();
      const password = account.password.trim();
      const steamId = (account.steam_id64 ?? "").trim();
      return `${timestamp}: ${email} | ${username} | ${password} | ${steamId}`;
    });

    const blob = new Blob([textLines.join("\n")], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const handleExportAllOwnAccounts = () => {
    setError("");
    downloadAccountsTxt(ownAccounts, "kuroi-accounts-all.txt");
  };

  const handleExportSelectedAccounts = () => {
    setError("");
    downloadAccountsTxt(selectedOwnAccounts, "kuroi-accounts-selected.txt");
  };

  const toggleAccountSelection = (accountId: number) => {
    setSelectedAccountIds((previous) => {
      const next = new Set(previous);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const toggleSelectAllOnPage = () => {
    setSelectedAccountIds((previous) => {
      const next = new Set(previous);
      if (allOwnOnPageSelected) {
        ownPaginatedAccounts.forEach((account) => next.delete(account.id));
      } else {
        ownPaginatedAccounts.forEach((account) => next.add(account.id));
      }
      return next;
    });
  };

  const copyAccountField = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showUiNotice("Copied to clipboard");
    } catch {
      setError("Copy failed. Please copy manually.");
    }
  };

  const isAccountActivelyBanned = (account: Account) => {
    if (account.ban_type === "VAC" || account.ban_type === "GameBanned") {
      return true;
    }

    if (account.ban_type === "VACLive") {
      const expiresAtRaw = account.vac_live_expires_at;
      if (expiresAtRaw) {
        const expiresAt = parseApiDate(expiresAtRaw);
        if (expiresAt !== null) {
          return expiresAt > countdownNow;
        }
      }
      return Boolean(account.vac_live_remaining && account.vac_live_remaining !== "Expired");
    }

    return false;
  };

  const getAvatarBorderClass = (account: Account) => {
    if (isAccountActivelyBanned(account)) {
      return "border-rose-500/90 shadow-[0_0_10px_rgba(244,63,94,0.45)]";
    }

    if (account.online_status === "Playing") {
      return "border-emerald-400/90 shadow-[0_0_10px_rgba(52,211,153,0.45)]";
    }

    const onlineStates = new Set(["Online", "Busy", "Away", "Snooze", "LookingToTrade", "LookingToPlay"]);
    if (onlineStates.has(account.online_status ?? "")) {
      return "border-sky-400/90 shadow-[0_0_10px_rgba(56,189,248,0.45)]";
    }

    return "border-zinc-600";
  };

  const getDisplayStatus = (account: Account) => {
    if (isAccountActivelyBanned(account)) {
      return "Banned";
    }
    if (account.online_status === "Playing") {
      return account.game_status ? `Playing: ${account.game_status}` : "Playing";
    }
    return account.online_status ?? "Unknown";
  };

  const canLaunchLogin = (account: Account) => !isAccountOnline(account);

  const canRevealPassword = (account: Account) => !isAccountOnline(account) && Boolean(account.password);

  const renderAccountName = (account: Account, compact = false) => {
    const baseClassName = compact
      ? "inline-flex items-center gap-1 text-sm font-medium text-zinc-100"
      : "inline-flex max-w-[180px] items-center gap-1 truncate text-left";
    const nameClassName = account.is_prime ? "prime-name-text truncate" : "truncate";

    return (
      <span className={baseClassName} title={account.is_prime ? "Prime account" : undefined}>
        {account.is_prime ? (
          <span className="prime-name-aura">
            <span className={nameClassName}>{account.username}</span>
          </span>
        ) : (
          <span className={nameClassName}>{account.username}</span>
        )}
      </span>
    );
  };

  const updateStickyActionsOverlap = () => {
    const container = tableScrollRef.current;
    if (!container) {
      setHasStickyActionsOverlap(false);
      return;
    }

    const maxScrollLeft = container.scrollWidth - container.clientWidth;
    setHasStickyActionsOverlap(maxScrollLeft - container.scrollLeft > 1);
  };

  const getAvatarHoverTitle = (account: Account) => account.steam_profile_name ?? "Unknown";

  const getSteamProfileUrl = (account: Account) => {
    const steamId = account.steam_id64?.trim();
    if (!steamId) {
      return null;
    }
    return `https://steamcommunity.com/profiles/${steamId}`;
  };

  const getReviewSuggestions = (account: Account) => account.suggested_changes ?? [];

  const formatVacLiveTarget = (value: number | null | undefined, unit: "hours" | "days" | null | undefined) => {
    if (value && unit) {
      return `${value} ${unit}`;
    }
    return "custom duration";
  };

  const getVacLiveRemainingLabel = (account: Account) => {
    if (account.ban_type !== "VACLive") {
      return "-";
    }

    const expiresAtRaw = account.vac_live_expires_at;
    if (expiresAtRaw) {
      const expiresAt = parseApiDate(expiresAtRaw);
      if (expiresAt !== null) {
        const remainingSeconds = Math.floor((expiresAt - countdownNow) / 1000);
        if (remainingSeconds <= 0) {
          return "Expired";
        }

        const days = Math.floor(remainingSeconds / 86400);
        const hours = Math.floor((remainingSeconds % 86400) / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = remainingSeconds % 60;

        if (days > 0) {
          return `${days}d ${hours}h ${minutes}m`;
        }
        if (hours > 0) {
          return `${hours}h ${minutes}m ${seconds}s`;
        }
        if (minutes > 0) {
          return `${minutes}m ${seconds}s`;
        }
        return `${seconds}s`;
      }
    }

    return account.vac_live_remaining ?? "Expired";
  };

  const getRowClassName = (account: Account) => {
    return "hover:bg-zinc-800/35";
  };

  const modeOptions: Array<{ id: ViewMode; label: string }> = [
    { id: "table", label: "Table" },
    { id: "cards", label: "Cards" },
    { id: "compact", label: "Compact" },
    { id: "kanban", label: "Kanban" },
    { id: "gallery", label: "Gallery" },
    { id: "stats", label: "Stats" },
  ];

  const renderAccountAvatar = (account: Account, sizeClassName = "h-9 w-9") => {
    const steamProfileUrl = getSteamProfileUrl(account);
    const avatar = account.avatar_url ? (
      <img
        src={account.avatar_url}
        alt="Avatar"
        aria-label={getAvatarHoverTitle(account)}
        className={`${sizeClassName} rounded-full border ${getAvatarBorderClass(account)}`}
      />
    ) : (
      <div
        aria-label={getAvatarHoverTitle(account)}
        className={`${sizeClassName} rounded-full border ${getAvatarBorderClass(account)} bg-zinc-700`}
      />
    );

    const tooltip = (
      <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 max-w-[240px] -translate-x-1/2 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border border-zinc-700 bg-zinc-950/95 px-2 py-1 text-xs text-zinc-100 opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
        {getAvatarHoverTitle(account)}
      </div>
    );

    if (!steamProfileUrl) {
      return (
        <div className="group relative inline-flex">
          {avatar}
          {tooltip}
        </div>
      );
    }

    return (
      <a
        href={steamProfileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="group relative inline-flex cursor-pointer"
        title="Open Steam profile"
      >
        {avatar}
        {tooltip}
      </a>
    );
  };

  const handleShiroLogin = async (account: Account) => {
    if (!allowShiroLogin) {
      setError("Shiro one-click login is disabled");
      return;
    }

    if (!canLaunchLogin(account)) {
      setError("Login is unavailable while the account is online");
      return;
    }

    // Only account owners or viewers of public accounts should be able to launch Shiro.
    if (currentUserId !== account.owner_id && !account.is_public) {
      setError("Shiro login is only available for public accounts");
      return;
    }

    setShiroLoginAccount(account);
    setShiroLoading(true);
    setShiroMessage("Launching Shiro...");

    try {
      const resp = await apiFetch<{
        token: string;
        launch_url: string;
      }>(`/accounts/${account.id}/shiro-login`, token, { method: "POST" });

      // Open the shiro:// protocol URL via a hidden iframe (doesn't navigate away).
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = resp.launch_url;
      document.body.appendChild(iframe);
      setTimeout(() => iframe.remove(), 2000);

      setShiroMessage("Shiro is handling the login – check the Shiro window.");
      showUiNotice(`Shiro launched for ${account.username}`);

      // Auto-dismiss after a few seconds.
      setTimeout(() => {
        setShiroLoginAccount(null);
        setShiroLoading(false);
        setShiroMessage("");
      }, 4000);
    } catch (err) {
      setShiroMessage(err instanceof Error ? err.message : "Failed to launch Shiro");
      setShiroLoading(false);
      setTimeout(() => {
        setShiroLoginAccount(null);
        setShiroMessage("");
      }, 3000);
    }
  };

  const closeShiroModal = () => {
    setShiroLoginAccount(null);
    setShiroLoading(false);
    setShiroMessage("");
  };

  const renderAccountActions = (account: Account, compact = false) => {
    const loginDisabled = !canLaunchLogin(account);
    const loginTitle = loginDisabled
      ? "Unavailable while account is online"
      : "Login to this Steam account via Shiro";

    if (currentUserId === account.owner_id) {
      return (
        <div className={`flex ${compact ? "flex-wrap" : ""} gap-1.5`}>
          {allowShiroLogin && (
            <button
              type="button"
              className="inline-flex items-center rounded-lg border border-emerald-300/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              title={loginTitle}
              disabled={loginDisabled}
              onClick={() => handleShiroLogin(account)}
            >
              ▶ Login
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center rounded-lg border border-sky-300/40 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-100 hover:bg-sky-500/20"
            title={reviewButtonHints[account.id] ?? ((account.pending_review_count ?? 0) > 0 ? `Pending suggestions: ${account.pending_review_count}` : "No pending suggestions")}
            onMouseEnter={() => {
              void prefetchReviewHint(account);
            }}
            onClick={() => openReviewModal(account)}
          >
            Review
            {(account.pending_review_count ?? 0) > 0 && (
              <span className={`ml-1 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full border border-sky-200/70 bg-sky-400 px-1 text-[10px] font-semibold leading-none text-zinc-950 shadow-[0_0_10px_rgba(56,189,248,0.7)] ${hasNewPendingReviewsPulse ? "animate-pulse" : ""}`}>
                {account.pending_review_count}
              </span>
            )}
          </button>
          <button type="button" className="anime-secondary-button px-2 py-1 text-xs" onClick={() => startEditAccount(account)}>
            Edit
          </button>
          <button type="button" className="rounded-lg border border-rose-400/40 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20" onClick={() => handleDeleteAccount(account.id)}>
            Delete
          </button>
        </div>
      );
    }

    return (
      <div className={`flex ${compact ? "flex-wrap" : ""} gap-1.5`}>
        {allowShiroLogin && account.is_public && (
          <button
            type="button"
            className="inline-flex items-center rounded-lg border border-emerald-300/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            title={loginDisabled ? "Unavailable while account is online" : "Login to this public Steam account via Shiro"}
            disabled={loginDisabled}
            onClick={() => handleShiroLogin(account)}
          >
            ▶ Login
          </button>
        )}
        <button
          type="button"
          className="rounded-lg border border-fuchsia-300/40 bg-fuchsia-500/10 px-2 py-1 text-xs text-fuchsia-100 hover:bg-fuchsia-500/20"
          onClick={() => openSuggestModal(account)}
        >
          Suggest
        </button>
      </div>
    );
  };

  useEffect(() => {
    if (viewMode !== "table") {
      setHasStickyActionsOverlap(false);
      return;
    }

    updateStickyActionsOverlap();
    const handleResize = () => updateStickyActionsOverlap();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [viewMode, paginatedAccounts.length]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-zinc-950 px-4 py-8 text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(244,114,182,0.18),transparent_45%),radial-gradient(circle_at_15%_20%,rgba(99,102,241,0.25),transparent_42%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-20 [background-image:linear-gradient(to_right,rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:22px_22px]" />

      <div className="relative mx-auto max-w-[1700px] space-y-6">
        <header className="anime-panel rounded-3xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <img src={kuroiLogo} alt="kuroi logo" className="h-14 w-14 rounded-2xl border border-fuchsia-300/40 bg-zinc-950/90 p-1" />
              <div>
              <h1 className="bg-gradient-to-r from-fuchsia-200 via-sky-200 to-indigo-200 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
                kuroi 黒い
              </h1>
              <p className="mt-2 text-zinc-300/85">Simple Steam account tracking for everyday use.</p>
              </div>
            </div>
            {isLoggedIn && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={`rounded-xl border px-4 py-2 ${
                    currentPageRoute === "home"
                      ? "border-sky-300/40 bg-sky-500/10 text-sky-100"
                      : "border-zinc-500/50 bg-zinc-800/70 text-zinc-100 hover:bg-zinc-700/80"
                  }`}
                  onClick={() => navigateToPage("home")}
                >
                  Accounts
                </button>
                <button
                  type="button"
                  className={`rounded-xl border px-4 py-2 ${
                    currentPageRoute === "profile"
                      ? "border-sky-300/40 bg-sky-500/10 text-sky-100"
                      : "border-zinc-500/50 bg-zinc-800/70 text-zinc-100 hover:bg-zinc-700/80"
                  }`}
                  onClick={() => navigateToPage("profile")}
                >
                  Profile
                </button>
                <div className="relative" ref={headerMenuRef}>
                  <button
                    ref={extrasButtonRef}
                    type="button"
                    className={`rounded-xl border px-4 py-2 ${
                      isExtrasPageActive
                        ? "border-sky-300/40 bg-sky-500/10 text-sky-100"
                        : "border-zinc-500/50 bg-zinc-800/70 text-zinc-100 hover:bg-zinc-700/80"
                    }`}
                    onClick={() => {
                      if (!isHeaderMenuOpen) {
                        updateHeaderMenuPosition();
                      }
                      setIsHeaderMenuOpen((open) => !open);
                    }}
                  >
                    Extras ▾
                  </button>
                  {isHeaderMenuRendered &&
                    createPortal(
                      <div
                        ref={headerMenuPanelRef}
                        className={`fixed min-w-[180px] overflow-hidden rounded-xl border border-zinc-600/70 bg-zinc-900/95 p-1 shadow-xl backdrop-blur-sm transition duration-150 ease-out origin-top ${
                          isHeaderMenuOpen ? "translate-y-0 scale-100 opacity-100" : "-translate-y-1 scale-95 opacity-0 pointer-events-none"
                        }`}
                        style={{ top: headerMenuPosition.top, left: headerMenuPosition.left, zIndex: 2147483647 }}
                      >
                        <button
                          type="button"
                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-700/80"
                          onClick={() => navigateToPage("leaderboard")}
                        >
                          Leaderboard
                        </button>
                        <button
                          type="button"
                          className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-700/80"
                          onClick={() => navigateToPage("achievements")}
                        >
                          Achievements
                        </button>    
                      </div>,
                      document.body,
                    )}
                </div>
                <button type="button" className="rounded-xl border border-rose-300/40 bg-rose-500/10 px-4 py-2 text-rose-200 hover:bg-rose-500/20" onClick={handleLogout}>
                  Logout
                </button>
              </div>
            )}
          </div>
        </header>

        {!isLoggedIn ? (
          <div className="mx-auto w-full max-w-xl anime-panel rounded-3xl p-6">
            {sessionNotice && (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-300/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                <span>{sessionNotice}</span>
                <button
                  type="button"
                  className="rounded-md border border-amber-200/40 px-2 py-1 text-xs text-amber-100 hover:bg-amber-500/20"
                  onClick={() => setSessionNotice("")}
                >
                  Dismiss
                </button>
              </div>
            )}
            {currentPageRoute === "register" && allowInviteLinkCreation ? (
              <div className="mx-auto w-full max-w-lg space-y-4">
                <form onSubmit={handleRegister} className="grid gap-3">
                  <input
                    className={`anime-input ${
                      registerUsernameInvalid
                        ? "border-rose-400/70 focus:border-rose-300"
                        : registerUsernameValidHighlight
                          ? "border-emerald-400/70 focus:border-emerald-300"
                          : ""
                    }`}
                    placeholder="New username"
                    value={registerUsername}
                    onChange={(event) => setRegisterUsername(event.target.value)}
                    onBlur={() => setRegisterTouched((previous) => ({ ...previous, username: true }))}
                    minLength={3}
                    maxLength={64}
                    required
                  />
                  <input
                    type="email"
                    className={`anime-input ${
                      registerEmailInvalid
                        ? "border-rose-400/70 focus:border-rose-300"
                        : registerEmailValidHighlight
                          ? "border-emerald-400/70 focus:border-emerald-300"
                          : ""
                    }`}
                    placeholder="Email"
                    value={registerEmail}
                    onChange={(event) => setRegisterEmail(event.target.value)}
                    onBlur={() => setRegisterTouched((previous) => ({ ...previous, email: true }))}
                    required
                  />
                  <input
                    type="password"
                    className={`anime-input ${
                      registerPasswordInvalid
                        ? "border-rose-400/70 focus:border-rose-300"
                        : registerPasswordValidHighlight
                          ? "border-emerald-400/70 focus:border-emerald-300"
                          : ""
                    }`}
                    placeholder="New password"
                    value={registerPassword}
                    onChange={(event) => setRegisterPassword(event.target.value)}
                    onBlur={() => setRegisterTouched((previous) => ({ ...previous, password: true }))}
                    minLength={8}
                    maxLength={128}
                    required
                  />
                  <input
                    className={`anime-input ${
                      registerInviteCodeInvalid
                        ? "border-rose-400/70 focus:border-rose-300"
                        : registerInviteCodeValidHighlight
                          ? "border-emerald-400/70 focus:border-emerald-300"
                          : ""
                    }`}
                    placeholder="Invite code"
                    value={registerInviteCode}
                    onChange={(event) => setRegisterInviteCode(event.target.value)}
                    onBlur={() => setRegisterTouched((previous) => ({ ...previous, inviteCode: true }))}
                    minLength={6}
                    maxLength={64}
                    required
                  />
                  {registerUsernameInvalid && <p className="text-xs text-rose-300">Username must be at least 3 characters.</p>}
                  {registerEmailInvalid && <p className="text-xs text-rose-300">Please enter a valid email address.</p>}
                  {registerPasswordInvalid && <p className="text-xs text-rose-300">Password must be at least 8 characters.</p>}
                  {registerInviteCodeInvalid && <p className="text-xs text-rose-300">Invite code must be at least 6 characters.</p>}
                  <button className="anime-secondary-button" disabled={!isRegisterFormValid}>
                    Register with Invite
                  </button>
                  {!isRegisterFormValid && (
                    <p className="text-xs text-zinc-400">
                      Requirements: username ≥ 3 chars, valid email, password ≥ 8 chars, invite code ≥ 6 chars.
                    </p>
                  )}
                </form>
                <button type="button" className="anime-secondary-button w-full" onClick={() => navigateToPage("home")}>
                  Back to Login
                </button>
                {oidcVisible && (
                  <button type="button" className="anime-secondary-button w-full" onClick={handleOidcLogin}>
                    Login with OAuth (OIDC)
                  </button>
                )}
              </div>
            ) : (
              <div className="mx-auto w-full max-w-lg space-y-4">
                <form onSubmit={handleLocalLogin} className="grid gap-3">
                  <input className="anime-input" placeholder="Username" value={username} onChange={(event) => setUsername(event.target.value)} />
                  <input type="password" className="anime-input" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
                  <button className="anime-primary-button">Login with Password</button>
                </form>

                {allowInviteLinkCreation && (
                  <button type="button" className="anime-secondary-button w-full" onClick={() => navigateToPage("register")}>
                    Register with Invite
                  </button>
                )}

                {oidcVisible && (
                  <button type="button" className="anime-secondary-button w-full" onClick={handleOidcLogin}>
                    Login with OAuth (OIDC)
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {currentPageRoute === "profile" ? (
              <ProfilePage
                currentUsername={currentUsername}
                currentDisplayName={currentDisplayName}
                profileDisplayNameInput={profileDisplayNameInput}
                currentEmail={currentEmail}
                canChangePassword={canChangePassword}
                isUpdatingProfile={isUpdatingProfile}
                currentPasswordInput={currentPasswordInput}
                newPasswordInput={newPasswordInput}
                isChangingPassword={isChangingPassword}
                onDisplayNameChange={setProfileDisplayNameInput}
                onProfileSubmit={handleUpdateProfile}
                onCurrentPasswordChange={setCurrentPasswordInput}
                onNewPasswordChange={setNewPasswordInput}
                onSubmit={handleChangePassword}
              />
            ) : currentPageRoute === "achievements" ? (
              <AchievementsPage />
            ) : currentPageRoute === "leaderboard" ? (
              <LeaderboardPage token={token} />
            ) : (
            <HomePage>
            <div className="anime-panel space-y-4 rounded-3xl p-4">
              <div className="grid gap-3 xl:grid-cols-[1.2fr_180px_220px_auto]">
                <div className="flex items-center gap-2">
                  <input
                    className="anime-input"
                    placeholder="Search"
                    value={usernameSearch}
                    onChange={(event) => setUsernameSearch(event.target.value)}
                  />
                  {usernameSearch && (
                    <button
                      type="button"
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-600/70 bg-zinc-900/70 text-sm text-zinc-300 hover:bg-zinc-700/80"
                      onClick={() => setUsernameSearch("")}
                      aria-label="Clear account name filter"
                      title="Clear"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <select className="anime-input" value={banFilter} onChange={(event) => handleFilterChange(event.target.value as "all" | BanType)}>
                  <option value="all">All bans</option>
                  <option value="None">Not banned</option>
                  <option value="VAC">VAC</option>
                  <option value="GameBanned">Game Banned</option>
                  <option value="VACLive">VAC Live</option>
                </select>
                <select className="anime-input" value={sortOption} onChange={(event) => setSortOption(event.target.value as SortOption)}>
                  <option value="mm_ready">MM Ready (default)</option>
                  <option value="mm_not_ready">MM Not Ready first</option>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="username_asc">Username A-Z</option>
                  <option value="username_desc">Username Z-A</option>
                </select>
                <button className="anime-secondary-button px-4 py-2" onClick={() => loadAccounts()}>
                  Refresh
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-700/70 bg-zinc-950/70 p-2">
                {modeOptions.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                      viewMode === mode.id
                        ? "border-fuchsia-300/60 bg-fuchsia-500/20 text-fuchsia-100"
                        : "border-zinc-600/70 bg-zinc-800/70 text-zinc-200 hover:bg-zinc-700/80"
                    }`}
                    onClick={() => setViewMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
                <label className="ml-auto flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-100">
                  <input className="anime-checkbox" type="checkbox" checked={showPublicAccounts} onChange={(event) => handlePublicToggle(event.target.checked)} />
                  Show public
                </label>
                <label className="relative flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-1.5 pr-7 text-xs text-zinc-100">
                  <input className="anime-checkbox" type="checkbox" checked={showOnlyPendingReviews} onChange={(event) => setShowOnlyPendingReviews(event.target.checked)} />
                  Pending review
                  {ownPendingReviewCount > 0 && (
                    <span className={`absolute -right-1.5 -top-1.5 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full border border-sky-200/70 bg-sky-400 px-1 text-[10px] font-semibold leading-none text-zinc-950 shadow-[0_0_10px_rgba(56,189,248,0.7)] ${hasNewPendingReviewsPulse ? "animate-pulse" : ""}`}>
                      {ownPendingReviewCount}
                    </span>
                  )}
                </label>
              </div>
            </div>

            {viewMode === "table" && (
              <div ref={tableScrollRef} className="anime-panel overflow-x-auto rounded-3xl" onScroll={updateStickyActionsOverlap}>
                <table className="min-w-[980px] w-full divide-y divide-zinc-700/60 text-[12px] xl:min-w-[1180px] 2xl:min-w-[1360px]">
                  <thead className="bg-zinc-900/70">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300">
                        <input
                          className="anime-checkbox"
                          type="checkbox"
                          checked={allOwnOnPageSelected}
                          disabled={ownPaginatedAccounts.length === 0}
                          onChange={toggleSelectAllOnPage}
                        />
                      </th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300">Avatar</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300">Username</th>
                      <th className="hidden px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300 xl:table-cell">Email</th>
                      <th className="hidden px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300 2xl:table-cell">Steam ID64</th>
                      <th className="hidden px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300 2xl:table-cell">Password</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300">Ban Type</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300">Status</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300">VAC Live Left</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300">MM Ready</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300">Visibility</th>
                      <th className="hidden px-3 py-2 text-left text-[11px] uppercase tracking-wider text-zinc-300 lg:table-cell">Review</th>
                      <th className={`sticky-actions-shell sticky right-0 z-10 px-3 py-2 pr-3 text-left text-[11px] uppercase tracking-wider text-zinc-300 ${hasStickyActionsOverlap ? "sticky-actions-header sticky-actions-overlap" : "bg-zinc-900/70"}`}>
                        <span className={`sticky-actions-label ${hasStickyActionsOverlap ? "sticky-actions-label-active" : ""}`}>Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-700/50">
                    {paginatedAccounts.map((account) => (
                      <tr key={account.id} className={getRowClassName(account)}>
                        <td className="px-3 py-2">
                          {currentUserId === account.owner_id ? (
                            <input
                              className="anime-checkbox"
                              type="checkbox"
                              checked={selectedAccountIds.has(account.id)}
                              onChange={() => toggleAccountSelection(account.id)}
                            />
                          ) : (
                            <span className="text-xs text-zinc-500">-</span>
                          )}
                        </td>
                        <td className="px-3 py-2">{renderAccountAvatar(account)}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            className="block max-w-[170px] cursor-copy truncate text-left hover:text-fuchsia-200"
                            title="Click to copy username"
                            onClick={() => copyAccountField(account.username)}
                          >
                            {renderAccountName(account)}
                          </button>
                          <div className="mt-1 space-y-0.5 text-[10px] text-zinc-400 xl:hidden">
                            <p>{account.ban_type} · {account.matchmaking_ready ? "MM Ready" : "MM Off"}</p>
                            <p>{account.is_public ? "Public" : "Private"} · {getDisplayStatus(account)}</p>
                          </div>
                        </td>
                        <td className="hidden px-3 py-2 xl:table-cell">
                          <button
                            type="button"
                            className="block max-w-[200px] cursor-copy truncate text-left hover:text-fuchsia-200"
                            title="Click to copy email"
                            onClick={() => copyAccountField(account.email)}
                          >
                            {account.email}
                          </button>
                        </td>
                        <td className="hidden px-3 py-2 2xl:table-cell">
                          <button
                            type="button"
                            className="block max-w-[170px] cursor-copy truncate text-left hover:text-fuchsia-200"
                            title="Click to copy Steam ID64"
                            onClick={() => copyAccountField(account.steam_id64 ?? "")}
                          >
                            {account.steam_id64 ?? "-"}
                          </button>
                        </td>
                        <td className="hidden px-3 py-2 2xl:table-cell">
                          {canRevealPassword(account) ? (
                            <button
                              type="button"
                              className="group cursor-copy text-left"
                              title="Hover to reveal, click to copy password"
                              onClick={() => copyAccountField(account.password)}
                            >
                              <span className="inline-block blur-sm transition group-hover:blur-0">{account.password}</span>
                            </button>
                          ) : (
                            <span className="text-zinc-500">Hidden while online</span>
                          )}
                        </td>
                        <td className="px-3 py-2">{account.ban_type}</td>
                        <td className="px-3 py-2">{getDisplayStatus(account)}</td>
                        <td className="px-3 py-2">{getVacLiveRemainingLabel(account)}</td>
                        <td className="px-3 py-2">{account.matchmaking_ready ? "Yes" : "No"}</td>
                        <td className="px-3 py-2">{account.is_public ? "Public" : "Private"}</td>
                        <td className="hidden px-3 py-2 lg:table-cell">
                          {currentUserId === account.owner_id && (account.pending_review_count ?? 0) > 0 ? (
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.7)]" />
                          ) : null}
                        </td>
                        <td className={`sticky-actions-shell sticky right-0 z-10 px-3 py-2 pr-3 ${hasStickyActionsOverlap ? "sticky-actions-cell sticky-actions-overlap" : "bg-transparent"}`}>
                          {renderAccountActions(account)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {viewMode === "cards" && (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {paginatedAccounts.map((account) => (
                  <article key={account.id} className="anime-panel space-y-3 rounded-3xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        {renderAccountAvatar(account, "h-12 w-12")}
                        <div>
                          <button type="button" className="font-medium text-zinc-100 hover:text-fuchsia-200" onClick={() => copyAccountField(account.username)}>
                            {renderAccountName(account, true)}
                          </button>
                          <p className="text-xs text-zinc-400">{account.email}</p>
                        </div>
                      </div>
                      {currentUserId === account.owner_id && (
                        <input className="anime-checkbox" type="checkbox" checked={selectedAccountIds.has(account.id)} onChange={() => toggleAccountSelection(account.id)} />
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-zinc-300">
                      <p>Ban: <span className="text-zinc-100">{account.ban_type}</span></p>
                      <p>Status: <span className="text-zinc-100">{getDisplayStatus(account)}</span></p>
                      <p>MM Ready: <span className="text-zinc-100">{account.matchmaking_ready ? "Yes" : "No"}</span></p>
                      <p>Visibility: <span className="text-zinc-100">{account.is_public ? "Public" : "Private"}</span></p>
                      <p className="col-span-2">Steam ID: <span className="text-zinc-100">{account.steam_id64 ?? "-"}</span></p>
                    </div>
                    <div>{renderAccountActions(account, true)}</div>
                  </article>
                ))}
              </div>
            )}

            {viewMode === "compact" && (
              <div className="anime-panel rounded-3xl p-2">
                <div className="space-y-1">
                  {paginatedAccounts.map((account) => (
                    <div key={account.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-700/60 bg-zinc-900/40 px-3 py-2 text-xs">
                      {currentUserId === account.owner_id ? (
                        <input className="anime-checkbox" type="checkbox" checked={selectedAccountIds.has(account.id)} onChange={() => toggleAccountSelection(account.id)} />
                      ) : (
                        <span className="text-zinc-600">-</span>
                      )}
                      {renderAccountAvatar(account, "h-7 w-7")}
                      <button type="button" className="font-medium text-zinc-100 hover:text-fuchsia-200" onClick={() => copyAccountField(account.username)}>{renderAccountName(account, true)}</button>
                      <span className="text-zinc-400">{account.ban_type}</span>
                      <span className="text-zinc-400">{account.matchmaking_ready ? "MM Ready" : "MM Off"}</span>
                      <span className="text-zinc-400">{account.is_public ? "Public" : "Private"}</span>
                      {(account.pending_review_count ?? 0) > 0 && <span className="rounded-full bg-sky-400 px-2 py-0.5 text-[10px] font-semibold text-zinc-950">{account.pending_review_count}</span>}
                      <div className="ml-auto">{renderAccountActions(account, true)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {viewMode === "kanban" && (
              <div className="grid gap-3 xl:grid-cols-3">
                <section className="anime-panel rounded-3xl p-3">
                  <h3 className="mb-3 text-sm font-semibold text-emerald-200">Clean ({kanbanColumns.clean.length})</h3>
                  <div className="space-y-2">
                    {kanbanColumns.clean.map((account) => (
                      <div key={account.id} className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-3 text-xs">
                        <div className="mb-2 flex items-center gap-2">{renderAccountAvatar(account, "h-7 w-7")}{renderAccountName(account, true)}</div>
                        <p className="text-zinc-400">{account.matchmaking_ready ? "MM Ready" : "MM Off"} · {account.is_public ? "Public" : "Private"}</p>
                        <div className="mt-2">{renderAccountActions(account, true)}</div>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="anime-panel rounded-3xl p-3">
                  <h3 className="mb-3 text-sm font-semibold text-rose-200">Banned ({kanbanColumns.banned.length})</h3>
                  <div className="space-y-2">
                    {kanbanColumns.banned.map((account) => (
                      <div key={account.id} className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-3 text-xs">
                        <div className="mb-2 flex items-center gap-2">{renderAccountAvatar(account, "h-7 w-7")}{renderAccountName(account, true)}</div>
                        <p className="text-zinc-400">{account.ban_type} · {getDisplayStatus(account)}</p>
                        <div className="mt-2">{renderAccountActions(account, true)}</div>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="anime-panel rounded-3xl p-3">
                  <h3 className="mb-3 text-sm font-semibold text-fuchsia-200">VAC Live ({kanbanColumns.vacLive.length})</h3>
                  <div className="space-y-2">
                    {kanbanColumns.vacLive.map((account) => (
                      <div key={account.id} className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-3 text-xs">
                        <div className="mb-2 flex items-center gap-2">{renderAccountAvatar(account, "h-7 w-7")}{renderAccountName(account, true)}</div>
                        <p className="text-zinc-400">Remaining: {getVacLiveRemainingLabel(account)}</p>
                        <div className="mt-2">{renderAccountActions(account, true)}</div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {viewMode === "gallery" && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
                {paginatedAccounts.map((account) => (
                  <article key={account.id} className="anime-panel rounded-3xl p-4 text-center">
                    <div className="mx-auto mb-3 flex justify-center">{renderAccountAvatar(account, "h-16 w-16")}</div>
                    <button type="button" className="mx-auto block max-w-full truncate text-sm font-medium hover:text-fuchsia-200" onClick={() => copyAccountField(account.username)}>
                      {renderAccountName(account, true)}
                    </button>
                    <p className="mt-1 text-[11px] text-zinc-400">{account.ban_type} · {account.matchmaking_ready ? "MM" : "No MM"}</p>
                    <div className="mt-3 flex justify-center">{renderAccountActions(account, true)}</div>
                  </article>
                ))}
              </div>
            )}

            {viewMode === "stats" && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="anime-panel rounded-3xl p-4"><p className="text-xs text-zinc-400">Total</p><p className="mt-2 text-3xl font-semibold text-zinc-100">{accountStats.total}</p></div>
                <div className="anime-panel rounded-3xl p-4"><p className="text-xs text-zinc-400">Matchmaking Ready</p><p className="mt-2 text-3xl font-semibold text-emerald-200">{accountStats.mmReady}</p></div>
                <div className="anime-panel rounded-3xl p-4"><p className="text-xs text-zinc-400">Public</p><p className="mt-2 text-3xl font-semibold text-sky-200">{accountStats.publicCount}</p></div>
                <div className="anime-panel rounded-3xl p-4"><p className="text-xs text-zinc-400">Pending Reviews</p><p className="mt-2 text-3xl font-semibold text-fuchsia-200">{accountStats.pendingReviews}</p></div>
                <div className="anime-panel rounded-3xl p-4"><p className="text-xs text-zinc-400">Clean</p><p className="mt-2 text-2xl font-semibold text-emerald-200">{accountStats.clean}</p></div>
                <div className="anime-panel rounded-3xl p-4"><p className="text-xs text-zinc-400">VAC/Game Banned</p><p className="mt-2 text-2xl font-semibold text-rose-200">{accountStats.banned}</p></div>
                <div className="anime-panel rounded-3xl p-4"><p className="text-xs text-zinc-400">VAC Live</p><p className="mt-2 text-2xl font-semibold text-fuchsia-200">{accountStats.vacLive}</p></div>
                <div className="anime-panel rounded-3xl p-4">
                  <p className="text-xs text-zinc-400">Current View Range</p>
                  <p className="mt-2 text-sm text-zinc-200">Page {currentPage} of {totalPages}</p>
                  <p className="mt-1 text-xs text-zinc-400">based on active filters/search</p>
                </div>
              </div>
            )}

            <div className="anime-panel flex flex-wrap items-center justify-between gap-3 rounded-3xl p-4 text-sm">
              <p className="text-zinc-300">Bulk actions &amp; export for your accounts.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-fuchsia-400/40 bg-fuchsia-500/15 px-3 py-2 text-fuchsia-100 hover:bg-fuchsia-500/25 disabled:opacity-50 transition"
                  onClick={openMultiEdit}
                  disabled={selectedOwnAccounts.length === 0}
                >
                  Edit Selected ({selectedOwnAccounts.length})
                </button>
                <span className="text-zinc-600">|</span>
                <button type="button" className="anime-secondary-button px-3 py-2" onClick={handleExportAllOwnAccounts}>
                  Export All ({ownAccounts.length})
                </button>
                <button
                  type="button"
                  className="anime-secondary-button px-3 py-2 disabled:opacity-50"
                  onClick={handleExportSelectedAccounts}
                  disabled={selectedOwnAccounts.length === 0}
                >
                  Export Selected ({selectedOwnAccounts.length})
                </button>
              </div>
            </div>

            <div className="anime-panel flex items-center justify-between rounded-3xl p-4 text-sm">
              <p className="text-zinc-300">
                Page {currentPage} of {totalPages} · Showing up to {ACCOUNTS_PER_PAGE} accounts per page
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="anime-secondary-button px-3 py-2 disabled:opacity-50"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                >
                  Previous
                </button>
                <div className="flex items-center gap-1">
                  {pageNumbers.map((pageNumber) => (
                    <button
                      key={pageNumber}
                      type="button"
                      className={`rounded-lg border px-3 py-2 text-xs transition ${
                        pageNumber === currentPage
                          ? "border-fuchsia-300/60 bg-fuchsia-500/20 text-fuchsia-100"
                          : "border-zinc-600/70 bg-zinc-800/60 text-zinc-200 hover:bg-zinc-700/70"
                      }`}
                      onClick={() => setCurrentPage(pageNumber)}
                    >
                      {pageNumber}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="anime-secondary-button px-3 py-2 disabled:opacity-50"
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                >
                  Next
                </button>
              </div>
            </div>

            <div className="anime-panel space-y-4 rounded-3xl p-4">
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-2xl border border-fuchsia-300/40 bg-fuchsia-500/10 px-4 py-3 text-left text-sm text-fuchsia-100 hover:bg-fuchsia-500/20"
                onClick={() => setShowManagementTools((open) => !open)}
              >
                <span className="font-medium">Account Management Tools</span>
                <span className="text-xs text-fuchsia-200">{showManagementTools ? "Hide" : "Show"}</span>
              </button>

              {showManagementTools && (
                <div className="space-y-4">
                  <form onSubmit={handleCreateAccount} className="anime-panel grid gap-3 rounded-3xl p-4 md:grid-cols-3">
                    <input className="anime-input" placeholder="Username" value={newAccount.username} onChange={(event) => setNewAccount({ ...newAccount, username: event.target.value })} />
                    <input className="anime-input" placeholder="Email" value={newAccount.email} onChange={(event) => setNewAccount({ ...newAccount, email: event.target.value })} />
                    <input type="password" className="anime-input" placeholder="Password" value={newAccount.password} onChange={(event) => setNewAccount({ ...newAccount, password: event.target.value })} />
                    <input className="anime-input" placeholder="Steam ID64" value={newAccount.steam_id} onChange={(event) => setNewAccount({ ...newAccount, steam_id: event.target.value })} />

                    <select className="anime-input" value={newAccount.ban_type} onChange={(event) => setNewAccount({ ...newAccount, ban_type: event.target.value as BanType })}>
                      <option value="None">Not banned</option>
                      <option value="VAC">VAC</option>
                      <option value="GameBanned">Game Banned</option>
                      <option value="VACLive">VAC Live</option>
                    </select>

                    {newAccount.ban_type === "VACLive" && (
                      <>
                        <input
                          className="anime-input"
                          type="number"
                          min={1}
                          max={365}
                          placeholder="Duration"
                          value={newAccount.vac_live_value}
                          onChange={(event) => setNewAccount({ ...newAccount, vac_live_value: event.target.value })}
                        />
                        <select className="anime-input" value={newAccount.vac_live_unit} onChange={(event) => setNewAccount({ ...newAccount, vac_live_unit: event.target.value as "hours" | "days" })}>
                          <option value="hours">Hours</option>
                          <option value="days">Days</option>
                        </select>
                        <select
                          className="anime-input md:col-span-3"
                          value={newAccount.vac_live_fault_user_id}
                          onChange={(event) => setNewAccount({ ...newAccount, vac_live_fault_user_id: event.target.value })}
                        >
                          <option value="">Who caused it? Optional</option>
                          {userOptions.map((user) => (
                            <option key={user.id} value={String(user.id)}>
                              {formatUserChoiceLabel(user)}
                            </option>
                          ))}
                        </select>
                      </>
                    )}

                    <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                      <input className="anime-checkbox" type="checkbox" checked={newAccount.matchmaking_ready} onChange={(event) => setNewAccount({ ...newAccount, matchmaking_ready: event.target.checked })} />
                      Matchmaking ready (Level 2)
                    </label>
                    <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                      <input className="anime-checkbox" type="checkbox" checked={newAccount.is_public} onChange={(event) => setNewAccount({ ...newAccount, is_public: event.target.checked })} />
                      Public visibility
                    </label>
                    <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                      <input className="anime-checkbox" type="checkbox" checked={newAccount.is_prime} onChange={(event) => setNewAccount({ ...newAccount, is_prime: event.target.checked })} />
                      Prime account
                    </label>
                    <button className="anime-primary-button md:col-span-3">Save Account</button>
                  </form>

                  <form onSubmit={handleCreateApiKey} className="anime-panel rounded-3xl p-4">
                    <p className="mb-3 text-sm text-zinc-300">Create an API key for script-based account imports (Stace-style automation).</p>
                    <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                      <p className="flex items-center rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-zinc-200">Default key name: automation-script</p>
                      <button className="anime-primary-button px-4">Generate API Key</button>
                    </div>
                    {generatedApiKey && (
                      <div className="mt-3 space-y-2 rounded-xl border border-emerald-300/30 bg-emerald-500/10 p-3 text-sm">
                        <p className="text-emerald-200">Copy this key now (shown once in clear text):</p>
                        <p className="break-all rounded-md bg-zinc-950/80 p-2 font-mono text-emerald-200">{generatedApiKey}</p>
                        <p className="text-zinc-300">Example script call:</p>
                        <pre className="overflow-x-auto rounded-md bg-zinc-950/80 p-2 text-xs text-zinc-200">
{`curl -X POST ${apiBaseUrl}/accounts \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${generatedApiKey}" \\
  -d '{
    "username": "demo_user",
    "password": "demo_pass",
    "email": "demo@example.com",
    "steam_id": "76561198000000000",
    "ban_type": "None",
    "is_public": false
  }'`}
                        </pre>
                      </div>
                    )}
                  </form>

                  {allowInviteLinkCreation && (
                    <div className="anime-panel rounded-3xl p-4">
                      <p className="mb-3 text-sm text-zinc-300">Create a one-time invite link for a new user account.</p>
                      <button type="button" className="anime-primary-button px-4" onClick={handleCreateInviteLink}>
                        Create Invite Link
                      </button>
                      {generatedInviteLink && (
                        <p className="mt-3 break-all rounded-md bg-zinc-950/80 p-2 font-mono text-emerald-200">{generatedInviteLink}</p>
                      )}
                    </div>
                  )}

                  <form onSubmit={handleMassImport} className="anime-panel rounded-3xl p-4 space-y-3">
                    <p className="text-sm text-zinc-300">Mass import format: <span className="font-mono">timestamp: email | username | password | steamid64</span></p>
                    <textarea
                      className="anime-input min-h-40 w-full"
                      placeholder="2025-01-01 10:00:00: mail@example.com | account_name | secret_password | 76561198000000000"
                      value={massImportContent}
                      onChange={(event) => setMassImportContent(event.target.value)}
                    />
                    <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                      <div className="flex flex-wrap gap-3">
                        <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                          <input className="anime-checkbox" type="checkbox" checked={massImportPublic} onChange={(event) => setMassImportPublic(event.target.checked)} />
                          Imported accounts are public
                        </label>
                        <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                          <input className="anime-checkbox" type="checkbox" checked={massImportPrime} onChange={(event) => setMassImportPrime(event.target.checked)} />
                          Imported accounts are prime
                        </label>
                      </div>
                      <button className="anime-primary-button px-4" disabled={isImporting || !massImportContent.trim()}>
                        {isImporting ? "Importing..." : "Run Mass Import"}
                      </button>
                    </div>

                    {massImportResult && (
                      <div className="space-y-2 rounded-xl border border-zinc-700/60 bg-zinc-900/40 p-3 text-sm">
                        <p>
                          Created: <span className="font-semibold text-emerald-300">{massImportResult.created}</span> · Failed:{" "}
                          <span className="font-semibold text-rose-300">{massImportResult.failed}</span>
                        </p>
                        {massImportResult.errors.length > 0 && (
                          <ul className="max-h-40 overflow-auto space-y-1 rounded-lg border border-rose-300/30 bg-rose-500/10 p-2 text-xs text-rose-200">
                            {massImportResult.errors.map((importError, index) => (
                              <li key={`${importError.line}-${index}`}>
                                Line {importError.line}: {importError.message}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </form>
                </div>
              )}
            </div>
            </HomePage>
            )}
          </div>
        )}

        {error && <div className="rounded-xl border border-rose-300/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
      </div>

      {uiNotice && (
        <div className="fixed bottom-4 right-4 z-40 rounded-xl border border-emerald-300/40 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-100 shadow-lg backdrop-blur-sm">
          {uiNotice}
        </div>
      )}

      {multiEditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm px-4">
          <div className="anime-panel w-full max-w-lg rounded-3xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">
                Edit {selectedOwnAccounts.length} Account{selectedOwnAccounts.length !== 1 ? "s" : ""}
              </h2>
              <button
                type="button"
                className="rounded-lg border border-zinc-600 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700/60"
                onClick={() => setMultiEditOpen(false)}
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-zinc-400">Only checked fields will be applied to all selected accounts. Unchecked fields remain unchanged.</p>
            <form onSubmit={handleMultiEdit} className="space-y-4">

              {/* Ban Type */}
              <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/40 p-4 space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    className="anime-checkbox"
                    type="checkbox"
                    checked={multiEdit.apply_ban_type}
                    onChange={(e) => setMultiEdit({ ...multiEdit, apply_ban_type: e.target.checked })}
                  />
                  <span className="text-sm font-medium text-zinc-200">Ban Type</span>
                </label>
                {multiEdit.apply_ban_type && (
                  <div className="space-y-3 pl-6">
                    <select
                      className="anime-input w-full"
                      value={multiEdit.ban_type}
                      onChange={(e) => setMultiEdit({ ...multiEdit, ban_type: e.target.value as BanType })}
                    >
                      <option value="None">Not banned</option>
                      <option value="VAC">VAC</option>
                      <option value="GameBanned">Game Banned</option>
                      <option value="VACLive">VAC Live</option>
                    </select>
                    {multiEdit.ban_type === "VACLive" && (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <input
                            className="anime-input flex-1"
                            type="number"
                            min={1}
                            max={365}
                            placeholder="Duration"
                            value={multiEdit.vac_live_value}
                            onChange={(e) => setMultiEdit({ ...multiEdit, vac_live_value: e.target.value })}
                          />
                          <select
                            className="anime-input w-32"
                            value={multiEdit.vac_live_unit}
                            onChange={(e) => setMultiEdit({ ...multiEdit, vac_live_unit: e.target.value as "hours" | "days" })}
                          >
                            <option value="hours">Hours</option>
                            <option value="days">Days</option>
                          </select>
                        </div>
                        <select
                          className="anime-input w-full"
                          value={multiEdit.vac_live_fault_user_id}
                          onChange={(e) => setMultiEdit({ ...multiEdit, vac_live_fault_user_id: e.target.value })}
                        >
                          <option value="">Who caused it? Optional</option>
                          {userOptions.map((user) => (
                            <option key={user.id} value={String(user.id)}>
                              {formatUserChoiceLabel(user)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* MM Ready */}
              <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/40 p-4 space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    className="anime-checkbox"
                    type="checkbox"
                    checked={multiEdit.apply_mm_ready}
                    onChange={(e) => setMultiEdit({ ...multiEdit, apply_mm_ready: e.target.checked })}
                  />
                  <span className="text-sm font-medium text-zinc-200">Matchmaking Ready</span>
                </label>
                {multiEdit.apply_mm_ready && (
                  <label className="flex items-center gap-2 pl-6 cursor-pointer text-sm text-zinc-300">
                    <input
                      className="anime-checkbox"
                      type="checkbox"
                      checked={multiEdit.matchmaking_ready}
                      onChange={(e) => setMultiEdit({ ...multiEdit, matchmaking_ready: e.target.checked })}
                    />
                    Set as Matchmaking Ready (Level 2)
                  </label>
                )}
              </div>

              {/* Visibility */}
              <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/40 p-4 space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    className="anime-checkbox"
                    type="checkbox"
                    checked={multiEdit.apply_is_public}
                    onChange={(e) => setMultiEdit({ ...multiEdit, apply_is_public: e.target.checked })}
                  />
                  <span className="text-sm font-medium text-zinc-200">Visibility</span>
                </label>
                {multiEdit.apply_is_public && (
                  <label className="flex items-center gap-2 pl-6 cursor-pointer text-sm text-zinc-300">
                    <input
                      className="anime-checkbox"
                      type="checkbox"
                      checked={multiEdit.is_public}
                      onChange={(e) => setMultiEdit({ ...multiEdit, is_public: e.target.checked })}
                    />
                    Set as Public
                  </label>
                )}
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  className="anime-primary-button flex-1"
                  disabled={!multiEdit.apply_ban_type && !multiEdit.apply_mm_ready && !multiEdit.apply_is_public}
                >
                  Apply to {selectedOwnAccounts.length} Account{selectedOwnAccounts.length !== 1 ? "s" : ""}
                </button>
                <button
                  type="button"
                  className="anime-secondary-button px-5"
                  onClick={() => setMultiEditOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingAccountId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm px-4">
          <div className="anime-panel w-full max-w-4xl rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">Edit Account #{editingAccountId}</h2>
              <button
                type="button"
                className="rounded-lg border border-zinc-600 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700/60"
                onClick={() => setEditingAccountId(null)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleUpdateAccount} className="grid gap-3 md:grid-cols-3">
              <input className="anime-input" placeholder="Username" value={editAccount.username} onChange={(event) => setEditAccount({ ...editAccount, username: event.target.value })} />
              <input className="anime-input" placeholder="Email" value={editAccount.email} onChange={(event) => setEditAccount({ ...editAccount, email: event.target.value })} />
              <input
                type="password"
                className="anime-input"
                placeholder={
                  accounts.find((account) => account.id === editingAccountId && isAccountOnline(account))
                    ? "Hidden while online, leave empty to keep"
                    : "Password"
                }
                value={editAccount.password}
                onChange={(event) => setEditAccount({ ...editAccount, password: event.target.value })}
              />
              <input className="anime-input" placeholder="Steam ID64" value={editAccount.steam_id} onChange={(event) => setEditAccount({ ...editAccount, steam_id: event.target.value })} />
              <select className="anime-input" value={editAccount.ban_type} onChange={(event) => setEditAccount({ ...editAccount, ban_type: event.target.value as BanType })}>
                <option value="None">Not banned</option>
                <option value="VAC">VAC</option>
                <option value="GameBanned">Game Banned</option>
                <option value="VACLive">VAC Live</option>
              </select>

              {editAccount.ban_type === "VACLive" && (
                <>
                  <input
                    className="anime-input"
                    type="number"
                    min={1}
                    max={365}
                    value={editAccount.vac_live_value}
                    onChange={(event) => setEditAccount({ ...editAccount, vac_live_value: event.target.value })}
                  />
                  <select className="anime-input" value={editAccount.vac_live_unit} onChange={(event) => setEditAccount({ ...editAccount, vac_live_unit: event.target.value as "hours" | "days" })}>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                  <select
                    className="anime-input md:col-span-3"
                    value={editAccount.vac_live_fault_user_id}
                    onChange={(event) => setEditAccount({ ...editAccount, vac_live_fault_user_id: event.target.value })}
                  >
                    <option value="">Who caused it? Optional</option>
                    {userOptions.map((user) => (
                      <option key={user.id} value={String(user.id)}>
                        {formatUserChoiceLabel(user)}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                <input className="anime-checkbox" type="checkbox" checked={editAccount.matchmaking_ready} onChange={(event) => setEditAccount({ ...editAccount, matchmaking_ready: event.target.checked })} />
                Matchmaking ready (Level 2)
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                <input className="anime-checkbox" type="checkbox" checked={editAccount.is_public} onChange={(event) => setEditAccount({ ...editAccount, is_public: event.target.checked })} />
                Public visibility
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                <input className="anime-checkbox" type="checkbox" checked={editAccount.is_prime} onChange={(event) => setEditAccount({ ...editAccount, is_prime: event.target.checked })} />
                Prime account
              </label>

              <div className="md:col-span-3 flex gap-3">
                <button className="anime-primary-button">Save Changes</button>
                <button type="button" className="anime-secondary-button" onClick={() => setEditingAccountId(null)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {suggestAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm px-4">
          <div className="anime-panel w-full max-w-lg rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
                <span>Suggest changes for</span>
                {renderAccountName(suggestAccount, true)}
              </h2>
              <button type="button" className="rounded-lg border border-zinc-600 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700/60" onClick={() => setSuggestAccount(null)}>✕</button>
            </div>
            <form onSubmit={handleSubmitSuggestion} className="space-y-3">
              <select
                className="anime-input w-full"
                value={suggestionForm.suggested_ban_type}
                onChange={(event) => setSuggestionForm({ ...suggestionForm, suggested_ban_type: event.target.value as "" | BanType })}
              >
                <option value="">Ban Type: No change</option>
                <option value="None">Ban Type: None</option>
                <option value="VAC">Ban Type: VAC</option>
                <option value="GameBanned">Ban Type: GameBanned</option>
                <option value="VACLive">Ban Type: VAC Live</option>
              </select>
              {suggestionForm.suggested_ban_type === "VACLive" && (
                <div className="grid gap-2 md:grid-cols-[1fr_120px]">
                  <p className="md:col-span-2 rounded-xl border border-amber-300/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    Recommended next VAC Live duration (based on {suggestAccount.vac_live_fault_count ?? 0} recorded fault(s)): {suggestAccount.suggested_next_vac_live_value ?? 20} {suggestAccount.suggested_next_vac_live_unit ?? "hours"}
                  </p>
                  <input
                    className="anime-input"
                    type="number"
                    min={1}
                    max={365}
                    value={suggestionForm.suggested_vac_live_value}
                    onChange={(event) => setSuggestionForm({ ...suggestionForm, suggested_vac_live_value: event.target.value })}
                  />
                  <select
                    className="anime-input"
                    value={suggestionForm.suggested_vac_live_unit}
                    onChange={(event) => setSuggestionForm({ ...suggestionForm, suggested_vac_live_unit: event.target.value as "hours" | "days" })}
                  >
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                  <select
                    className="anime-input md:col-span-2"
                    value={suggestionForm.suggested_vac_live_fault_user_id}
                    onChange={(event) => setSuggestionForm({ ...suggestionForm, suggested_vac_live_fault_user_id: event.target.value })}
                  >
                    <option value="">Who caused it? Optional</option>
                    {userOptions.map((user) => (
                      <option key={user.id} value={String(user.id)}>
                        {formatUserChoiceLabel(user)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <select
                className="anime-input w-full"
                value={suggestionForm.suggested_matchmaking_ready}
                onChange={(event) => setSuggestionForm({ ...suggestionForm, suggested_matchmaking_ready: event.target.value as "" | "true" | "false" })}
              >
                <option value="">MM Ready: No change</option>
                <option value="true">MM Ready: Yes</option>
                <option value="false">MM Ready: No</option>
              </select>
              <select
                className="anime-input w-full"
                value={suggestionForm.suggested_is_public}
                onChange={(event) => setSuggestionForm({ ...suggestionForm, suggested_is_public: event.target.value as "" | "true" | "false" })}
              >
                <option value="">Visibility: No change</option>
                <option value="true">Visibility: Public</option>
                <option value="false">Visibility: Private</option>
              </select>
              <textarea
                className="anime-input min-h-24 w-full"
                placeholder="Optional note"
                value={suggestionForm.note}
                onChange={(event) => setSuggestionForm({ ...suggestionForm, note: event.target.value })}
              />
              <div className="flex gap-3">
                <button className="anime-primary-button flex-1" disabled={isSubmittingSuggestion}>{isSubmittingSuggestion ? "Sending..." : "Send Suggestion"}</button>
                <button type="button" className="anime-secondary-button px-5" onClick={() => setSuggestAccount(null)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {reviewAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm px-4">
          <div className="anime-panel w-full max-w-2xl rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
                <span>Review suggestions for</span>
                {renderAccountName(reviewAccount, true)}
              </h2>
              <button type="button" className="rounded-lg border border-zinc-600 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700/60" onClick={() => { setReviewAccount(null); setReviewSuggestions([]); }}>✕</button>
            </div>
            {isLoadingReviewSuggestions ? (
              <p className="text-sm text-zinc-300">Loading suggestions...</p>
            ) : reviewSuggestions.length === 0 ? (
              <p className="text-sm text-zinc-300">No pending suggestions.</p>
            ) : (
              <div className="space-y-3 max-h-[420px] overflow-auto pr-1">
                {reviewSuggestions.map((suggestion) => (
                  <div key={suggestion.id} className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-3 space-y-2">
                    <p className="text-xs text-zinc-400">From {suggestion.suggested_by_display_name} ({suggestion.suggested_by_username})</p>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {suggestion.suggested_ban_type && (
                        <span className="rounded-full border border-fuchsia-300/40 bg-fuchsia-500/10 px-2 py-0.5 text-fuchsia-100">
                          Ban: {suggestion.suggested_ban_type}
                          {suggestion.suggested_ban_type === "VACLive"
                            ? ` (${formatVacLiveTarget(suggestion.suggested_vac_live_value, suggestion.suggested_vac_live_unit)})`
                            : ""}
                        </span>
                      )}
                      {suggestion.suggested_vac_live_fault_display && (
                        <span className="rounded-full border border-amber-300/40 bg-amber-500/10 px-2 py-0.5 text-amber-100">
                          Fault: {suggestion.suggested_vac_live_fault_display}
                        </span>
                      )}
                      {suggestion.suggested_matchmaking_ready !== null && suggestion.suggested_matchmaking_ready !== undefined && <span className="rounded-full border border-sky-300/40 bg-sky-500/10 px-2 py-0.5 text-sky-100">MM Ready: {suggestion.suggested_matchmaking_ready ? "Yes" : "No"}</span>}
                      {suggestion.suggested_is_public !== null && suggestion.suggested_is_public !== undefined && <span className="rounded-full border border-emerald-300/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-100">Visibility: {suggestion.suggested_is_public ? "Public" : "Private"}</span>}
                    </div>
                    {suggestion.suggested_ban_type === "VACLive" && (
                      <p className="text-xs text-zinc-300">
                        VAC Live will be set to: {formatVacLiveTarget(suggestion.suggested_vac_live_value, suggestion.suggested_vac_live_unit)}
                      </p>
                    )}
                    {suggestion.note && <p className="text-sm text-zinc-200">{suggestion.note}</p>}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-md border border-emerald-300/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50"
                        disabled={resolvingSuggestionId === suggestion.id}
                        onClick={() => handleResolveSuggestion(reviewAccount, suggestion.id, "accept")}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-rose-300/40 bg-rose-500/10 px-3 py-1 text-xs text-rose-100 hover:bg-rose-500/20 disabled:opacity-50"
                        disabled={resolvingSuggestionId === suggestion.id}
                        onClick={() => handleResolveSuggestion(reviewAccount, suggestion.id, "decline")}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Shiro Steam Login Modal */}
      {shiroLoginAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm px-4">
          <div className="anime-panel w-full max-w-sm rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">
                Steam Login – {shiroLoginAccount.username}
              </h2>
              <button
                type="button"
                className="rounded-lg border border-zinc-600 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700/60"
                onClick={closeShiroModal}
              >
                ✕
              </button>
            </div>

            <div className="flex items-center gap-3">
              {shiroLoading && (
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
              )}
              <p className="text-sm text-zinc-300">{shiroMessage}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
