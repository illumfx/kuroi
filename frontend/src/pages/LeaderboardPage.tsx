import { useEffect, useState } from "react";

type LeaderboardPageProps = {
  token: string;
};

type VacLiveFaultLeaderboardEntry = {
  user_id: number;
  username: string;
  display_name: string;
  label: string;
  total_faults: number;
  accounts: string[];
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

function LeaderboardPage({ token }: LeaderboardPageProps) {
  const [rows, setRows] = useState<VacLiveFaultLeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setRows([]);
      setIsLoading(false);
      return;
    }

    const loadLeaderboard = async () => {
      setIsLoading(true);
      setError("");
      try {
        const response = await fetch(`${apiBaseUrl}/leaderboard/vac-live-faults`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { detail?: string };
          throw new Error(payload.detail || "Could not load leaderboard");
        }

        const payload = (await response.json()) as VacLiveFaultLeaderboardEntry[];
        setRows(payload);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Could not load leaderboard");
        setRows([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadLeaderboard();
  }, [token]);

  return (
    <div className="anime-panel rounded-3xl p-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h2 className="bg-gradient-to-r from-fuchsia-200 via-sky-200 to-indigo-200 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
            VAC Live Fault Leaderboard
          </h2>
          <p className="mt-2 text-sm text-zinc-300/85">Recorded VAC Live faults grouped by assigned user.</p>
        </div>
      </div>

      {error && <div className="mb-4 rounded-xl border border-rose-300/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

      {isLoading ? (
        <div className="flex min-h-[35vh] items-center justify-center text-sm text-zinc-300">Loading leaderboard...</div>
      ) : rows.length === 0 ? (
        <div className="flex min-h-[35vh] items-center justify-center rounded-2xl border border-zinc-700/60 bg-zinc-950/50 text-sm text-zinc-400">
          No recorded VAC Live faults found.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-zinc-700/60 bg-zinc-950/40">
          <table className="min-w-full divide-y divide-zinc-700/60 text-sm">
            <thead className="bg-zinc-900/70">
              <tr>
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Rank</th>
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">User</th>
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Recorded Faults</th>
                <th className="px-4 py-3 text-left text-xs uppercase tracking-wider text-zinc-300">Accounts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-700/50">
              {rows.map((row, index) => (
                <tr key={row.user_id} className="hover:bg-zinc-800/35">
                  <td className="px-4 py-3 font-semibold text-zinc-200">#{index + 1}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-100">{row.display_name}</div>
                    <div className="text-xs text-zinc-400">{row.username}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full border border-amber-300/40 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-100">
                      {row.total_faults}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{row.accounts.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default LeaderboardPage;
