import { FormEvent } from "react";

type ProfilePageProps = {
  currentUsername: string;
  currentEmail: string;
  canChangePassword: boolean;
  currentPasswordInput: string;
  newPasswordInput: string;
  isChangingPassword: boolean;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
};

function ProfilePage({
  currentUsername,
  currentEmail,
  canChangePassword,
  currentPasswordInput,
  newPasswordInput,
  isChangingPassword,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onSubmit,
}: ProfilePageProps) {
  return (
    <div className="anime-panel rounded-3xl p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h2 className="bg-gradient-to-r from-fuchsia-200 via-sky-200 to-indigo-200 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">Profile</h2>
          <p className="mt-2 text-sm text-zinc-300/85">Manage account settings and security.</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-zinc-700/70 bg-zinc-950/70 p-4">
          <p className="text-xs uppercase tracking-wider text-zinc-400">Username</p>
          <p className="mt-2 text-sm text-zinc-100">{currentUsername || "-"}</p>
        </div>
        <div className="rounded-2xl border border-zinc-700/70 bg-zinc-950/70 p-4">
          <p className="text-xs uppercase tracking-wider text-zinc-400">Email</p>
          <p className="mt-2 text-sm text-zinc-100">{currentEmail || "-"}</p>
        </div>
      </div>

      {canChangePassword ? (
        <form onSubmit={onSubmit} className="mt-6 grid gap-4 md:grid-cols-2">
          <input
            type="password"
            className="anime-input"
            placeholder="Current password"
            value={currentPasswordInput}
            onChange={(event) => onCurrentPasswordChange(event.target.value)}
            required
          />
          <input
            type="password"
            className="anime-input"
            placeholder="New password"
            value={newPasswordInput}
            onChange={(event) => onNewPasswordChange(event.target.value)}
            required
          />
          <button className="anime-primary-button md:col-span-2" disabled={isChangingPassword}>
            {isChangingPassword ? "Updating..." : "Change Password"}
          </button>
        </form>
      ) : (
        <div className="mt-6 rounded-2xl border border-amber-300/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Password change is only available for local invite-based accounts.
        </div>
      )}
    </div>
  );
}

export default ProfilePage;
