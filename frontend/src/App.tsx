import { FormEvent, useEffect, useMemo, useState } from "react";
import kuroiLogo from "./assets/kuroi-logo.svg";

type BanType = "None" | "VAC" | "GameBanned" | "VACLive";

type Account = {
  id: number;
  owner_id: number;
  username: string;
  password: string;
  email: string;
  ban_type: BanType;
  vac_live_remaining?: string | null;
  matchmaking_ready: boolean;
  is_public: boolean;
  avatar_url?: string | null;
  created_at: string;
};

type UserProfile = {
  id: number;
  username: string;
  email?: string | null;
};

type AuthConfig = {
  oidc_enabled: boolean;
  oidc_configured: boolean;
};

type ApiKeyResponse = {
  id: number;
  name: string;
  api_key: string;
  key_prefix: string;
  created_at: string;
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

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const oidcEnabledFromEnv = (import.meta.env.VITE_OIDC_ENABLED ?? "false") === "true";

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
    throw new Error(error.detail ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

function App() {
  const ACCOUNTS_PER_PAGE = 10;
  const [token, setToken] = useState(localStorage.getItem("kuroi_token") ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [banFilter, setBanFilter] = useState<"all" | BanType>("all");
  const [showPublicAccounts, setShowPublicAccounts] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [oidcVisible, setOidcVisible] = useState(oidcEnabledFromEnv);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);

  const [generatedApiKey, setGeneratedApiKey] = useState("");
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [massImportContent, setMassImportContent] = useState("");
  const [massImportPublic, setMassImportPublic] = useState(false);
  const [massImportResult, setMassImportResult] = useState<MassImportResponse | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<number>>(new Set());

  const [newAccount, setNewAccount] = useState({
    username: "",
    password: "",
    email: "",
    ban_type: "None" as BanType,
    vac_live_value: "24",
    vac_live_unit: "hours" as "hours" | "days",
    matchmaking_ready: false,
    is_public: false,
  });

  const [editAccount, setEditAccount] = useState({
    username: "",
    password: "",
    email: "",
    ban_type: "None" as BanType,
    vac_live_value: "24",
    vac_live_unit: "hours" as "hours" | "days",
    matchmaking_ready: false,
    is_public: false,
  });

  const isLoggedIn = useMemo(() => token.length > 0, [token]);
  const totalPages = useMemo(() => Math.max(1, Math.ceil(accounts.length / ACCOUNTS_PER_PAGE)), [accounts.length]);
  const pageNumbers = useMemo(() => Array.from({ length: totalPages }, (_, index) => index + 1), [totalPages]);
  const paginatedAccounts = useMemo(() => {
    const start = (currentPage - 1) * ACCOUNTS_PER_PAGE;
    return accounts.slice(start, start + ACCOUNTS_PER_PAGE);
  }, [accounts, currentPage]);
  const ownAccounts = useMemo(
    () => accounts.filter((account) => currentUserId !== null && account.owner_id === currentUserId),
    [accounts, currentUserId],
  );
  const ownPaginatedAccounts = useMemo(
    () => paginatedAccounts.filter((account) => currentUserId !== null && account.owner_id === currentUserId),
    [paginatedAccounts, currentUserId],
  );
  const selectedOwnAccounts = useMemo(
    () => ownAccounts.filter((account) => selectedAccountIds.has(account.id)),
    [ownAccounts, selectedAccountIds],
  );
  const allOwnOnPageSelected =
    ownPaginatedAccounts.length > 0 && ownPaginatedAccounts.every((account) => selectedAccountIds.has(account.id));

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
    const loadAuthConfig = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/auth/config`);
        if (!response.ok) {
          return;
        }
        const config = (await response.json()) as AuthConfig;
        setOidcVisible(config.oidc_enabled);
      } catch {
        setOidcVisible(oidcEnabledFromEnv);
      }
    };

    loadAuthConfig();
  }, []);

  const loadAccounts = async (filter = banFilter, includePublic = showPublicAccounts) => {
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
    const data = await apiFetch<Account[]>(`/accounts${query}`, token);
    setAccounts(data);
    setCurrentPage(1);
  };

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

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
      } catch {
        setCurrentUserId(null);
      }
    };

    loadProfile();
  }, [token]);

  const handleLocalLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    try {
      const response = await fetch(`${apiBaseUrl}/auth/local-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail ?? "Local login failed");
      }
      setToken(data.access_token);
      localStorage.setItem("kuroi_token", data.access_token);
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected error");
    }
  };

  const handleOidcLogin = async () => {
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/auth/oidc/login`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail ?? "OIDC login initialization failed");
      }
      if (!data.authorization_url) {
        throw new Error("OIDC authorization URL is missing");
      }
      window.location.href = data.authorization_url;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected OIDC error");
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
      };

      if (newAccount.ban_type === "VACLive") {
        payload.vac_live_value = Number(newAccount.vac_live_value);
        payload.vac_live_unit = newAccount.vac_live_unit;
      }

      await apiFetch<Account>("/accounts", token, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setNewAccount({
        username: "",
        password: "",
        email: "",
        ban_type: "None",
        vac_live_value: "24",
        vac_live_unit: "hours",
        matchmaking_ready: false,
        is_public: false,
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
        body: JSON.stringify({ content: massImportContent, is_public: massImportPublic }),
      });
      setMassImportResult(response);
      setMassImportContent("");
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
    setEditingAccountId(account.id);
    setEditAccount({
      username: account.username,
      password: account.password,
      email: account.email,
      ban_type: account.ban_type,
      vac_live_value: "24",
      vac_live_unit: "hours",
      matchmaking_ready: account.matchmaking_ready,
      is_public: account.is_public,
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
        password: editAccount.password,
        email: editAccount.email,
        ban_type: editAccount.ban_type,
        matchmaking_ready: editAccount.matchmaking_ready,
        is_public: editAccount.is_public,
      };
      if (editAccount.ban_type === "VACLive") {
        payload.vac_live_value = Number(editAccount.vac_live_value);
        payload.vac_live_unit = editAccount.vac_live_unit;
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
        throw new Error(payload.detail ?? "Delete failed");
      }
      if (editingAccountId === accountId) {
        setEditingAccountId(null);
      }
      await loadAccounts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected delete error");
    }
  };

  const handleLogout = () => {
    setToken("");
    setAccounts([]);
    setGeneratedApiKey("");
    setSelectedAccountIds(new Set());
    localStorage.removeItem("kuroi_token");
  };

  const escapeCsvValue = (value: string | number | boolean | null | undefined) => {
    const text = value === null || value === undefined ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };

  const downloadAccountsCsv = (rows: Account[], fileName: string) => {
    if (!rows.length) {
      setError("No accounts to export");
      return;
    }

    const header = ["id", "username", "email", "password", "ban_type", "vac_live_remaining", "matchmaking_ready", "is_public", "created_at"];
    const csvLines = [
      header.join(","),
      ...rows.map((account) =>
        [
          account.id,
          account.username,
          account.email,
          account.password,
          account.ban_type,
          account.vac_live_remaining ?? "",
          account.matchmaking_ready,
          account.is_public,
          account.created_at,
        ]
          .map((value) => escapeCsvValue(value))
          .join(","),
      ),
    ];

    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
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
    downloadAccountsCsv(ownAccounts, "kuroi-accounts-all.csv");
  };

  const handleExportSelectedAccounts = () => {
    setError("");
    downloadAccountsCsv(selectedOwnAccounts, "kuroi-accounts-selected.csv");
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

  return (
    <div className="relative min-h-screen overflow-hidden bg-zinc-950 px-4 py-8 text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(244,114,182,0.18),transparent_45%),radial-gradient(circle_at_15%_20%,rgba(99,102,241,0.25),transparent_42%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-20 [background-image:linear-gradient(to_right,rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:22px_22px]" />

      <div className="relative mx-auto max-w-6xl space-y-6">
        <header className="anime-panel rounded-3xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <img src={kuroiLogo} alt="kuroi logo" className="h-14 w-14 rounded-2xl border border-fuchsia-300/40 bg-zinc-950/90 p-1" />
              <div>
              <h1 className="bg-gradient-to-r from-fuchsia-200 via-sky-200 to-indigo-200 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
                kuroi 黒い
              </h1>
              <p className="mt-2 text-zinc-300/85">Steam account management with ban intelligence and automation-first workflows.</p>
              </div>
            </div>
            <span className="rounded-full border border-fuchsia-300/40 bg-fuchsia-500/15 px-3 py-1 text-xs font-medium text-fuchsia-200">Tokyo Neon</span>
          </div>
        </header>

        {!isLoggedIn ? (
          <div className="anime-panel rounded-3xl p-6">
            <form onSubmit={handleLocalLogin} className="grid gap-4 md:grid-cols-3">
              <input className="anime-input" placeholder="Username" value={username} onChange={(event) => setUsername(event.target.value)} />
              <input type="password" className="anime-input" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
              <button className="anime-primary-button">Login with Password</button>
            </form>

            {oidcVisible && (
              <button type="button" className="anime-secondary-button mt-4 w-full" onClick={handleOidcLogin}>
                Login with OAuth (OIDC)
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="anime-panel flex flex-wrap items-center gap-3 rounded-3xl p-4">
              <label className="text-sm text-zinc-300">Ban Type</label>
              <select className="anime-input max-w-44" value={banFilter} onChange={(event) => handleFilterChange(event.target.value as "all" | BanType)}>
                <option value="all">All</option>
                <option value="None">Not banned</option>
                <option value="VAC">VAC</option>
                <option value="GameBanned">Game Banned</option>
                <option value="VACLive">VAC Live</option>
              </select>
              <button className="anime-secondary-button px-4 py-2" onClick={() => loadAccounts()}>
                Refresh
              </button>
              <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                <input type="checkbox" checked={showPublicAccounts} onChange={(event) => handlePublicToggle(event.target.checked)} />
                Show public accounts
              </label>
              <button className="ml-auto rounded-xl border border-rose-300/40 bg-rose-500/10 px-4 py-2 text-rose-200 hover:bg-rose-500/20" onClick={handleLogout}>
                Logout
              </button>
            </div>

            {editingAccountId && (
              <form onSubmit={handleUpdateAccount} className="anime-panel grid gap-3 rounded-3xl p-4 md:grid-cols-3">
                <input className="anime-input" placeholder="Username" value={editAccount.username} onChange={(event) => setEditAccount({ ...editAccount, username: event.target.value })} />
                <input className="anime-input" placeholder="Email" value={editAccount.email} onChange={(event) => setEditAccount({ ...editAccount, email: event.target.value })} />
                <input type="password" className="anime-input" placeholder="Password" value={editAccount.password} onChange={(event) => setEditAccount({ ...editAccount, password: event.target.value })} />
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
                  </>
                )}
                <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                  <input type="checkbox" checked={editAccount.matchmaking_ready} onChange={(event) => setEditAccount({ ...editAccount, matchmaking_ready: event.target.checked })} />
                  Matchmaking ready (Level 2)
                </label>
                <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                  <input type="checkbox" checked={editAccount.is_public} onChange={(event) => setEditAccount({ ...editAccount, is_public: event.target.checked })} />
                  Public visibility
                </label>
                <div className="md:col-span-3 flex gap-3">
                  <button className="anime-primary-button">Save Changes</button>
                  <button type="button" className="anime-secondary-button" onClick={() => setEditingAccountId(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            <div className="anime-panel overflow-hidden rounded-3xl">
              <table className="min-w-full divide-y divide-zinc-700/60">
                <thead className="bg-zinc-900/70">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">
                      <input
                        type="checkbox"
                        checked={allOwnOnPageSelected}
                        disabled={ownPaginatedAccounts.length === 0}
                        onChange={toggleSelectAllOnPage}
                      />
                    </th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Avatar</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Username</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Email</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Password</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Ban Type</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">VAC Live Left</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">MM Ready</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Visibility</th>
                    <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-700/50">
                  {paginatedAccounts.map((account) => (
                    <tr key={account.id} className="hover:bg-zinc-800/35">
                      <td className="px-4 py-3">
                        {currentUserId === account.owner_id ? (
                          <input
                            type="checkbox"
                            checked={selectedAccountIds.has(account.id)}
                            onChange={() => toggleAccountSelection(account.id)}
                          />
                        ) : (
                          <span className="text-xs text-zinc-500">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {account.avatar_url ? <img src={account.avatar_url} alt="Avatar" className="h-9 w-9 rounded-full border border-zinc-600" /> : <div className="h-9 w-9 rounded-full bg-zinc-700" />}
                      </td>
                      <td className="px-4 py-3">{account.username}</td>
                      <td className="px-4 py-3">{account.email}</td>
                      <td className="px-4 py-3">{account.password}</td>
                      <td className="px-4 py-3">{account.ban_type}</td>
                      <td className="px-4 py-3">{account.ban_type === "VACLive" ? account.vac_live_remaining ?? "Expired" : "-"}</td>
                      <td className="px-4 py-3">{account.matchmaking_ready ? "Yes" : "No"}</td>
                      <td className="px-4 py-3">{account.is_public ? "Public" : "Private"}</td>
                      <td className="px-4 py-3">
                        {currentUserId === account.owner_id ? (
                          <div className="flex gap-2">
                            <button type="button" className="anime-secondary-button px-2 py-1 text-xs" onClick={() => startEditAccount(account)}>
                              Edit
                            </button>
                            <button type="button" className="rounded-lg border border-rose-400/40 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20" onClick={() => handleDeleteAccount(account.id)}>
                              Delete
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-400">View only</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="anime-panel flex flex-wrap items-center justify-between gap-3 rounded-3xl p-4 text-sm">
              <p className="text-zinc-300">Export only accounts you created.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="anime-secondary-button px-3 py-2" onClick={handleExportAllOwnAccounts}>
                  Export All My Accounts ({ownAccounts.length})
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

            <form onSubmit={handleCreateAccount} className="anime-panel grid gap-3 rounded-3xl p-4 md:grid-cols-3">
              <input className="anime-input" placeholder="Username" value={newAccount.username} onChange={(event) => setNewAccount({ ...newAccount, username: event.target.value })} />
              <input className="anime-input" placeholder="Email" value={newAccount.email} onChange={(event) => setNewAccount({ ...newAccount, email: event.target.value })} />
              <input type="password" className="anime-input" placeholder="Password" value={newAccount.password} onChange={(event) => setNewAccount({ ...newAccount, password: event.target.value })} />

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
                </>
              )}

              <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                <input type="checkbox" checked={newAccount.matchmaking_ready} onChange={(event) => setNewAccount({ ...newAccount, matchmaking_ready: event.target.checked })} />
                Matchmaking ready (Level 2)
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                <input type="checkbox" checked={newAccount.is_public} onChange={(event) => setNewAccount({ ...newAccount, is_public: event.target.checked })} />
                Public visibility
              </label>
              <button className="anime-primary-button md:col-span-3">Save Account</button>
            </form>

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
    "ban_type": "None",
    "is_public": false
  }'`}
                  </pre>
                </div>
              )}
            </form>

            <form onSubmit={handleMassImport} className="anime-panel rounded-3xl p-4 space-y-3">
              <p className="text-sm text-zinc-300">Mass import format: <span className="font-mono">timestamp: email | username | password</span></p>
              <textarea
                className="anime-input min-h-40 w-full"
                placeholder="2025-01-01 10:00:00: mail@example.com | account_name | secret_password"
                value={massImportContent}
                onChange={(event) => setMassImportContent(event.target.value)}
              />
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <label className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-100">
                  <input type="checkbox" checked={massImportPublic} onChange={(event) => setMassImportPublic(event.target.checked)} />
                  Imported accounts are public
                </label>
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

        {error && <div className="rounded-xl border border-rose-300/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
      </div>
    </div>
  );
}

export default App;
