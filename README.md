<div align="center">

<h1>kuroi</h1>

<p><img alt="image" src="./frontend/src/assets/kuroi-logo.svg" /></p>

<p>
<code>kuroi</code> is a Steam account management app with OIDC authentication, API-key automation, account visibility controls, and ban-state tracking.
Supports optional one-click Steam login integration via <a href="https://github.com/ZeloteZ/shiro">Shiro</a>.
</p>

</div>

---

> [!NOTE]
> kuroi is mostly vibe-coded and not in a stable state.

## Production model (simplified)

Production now uses **one application image** (`kuroi-app`) plus **one database** (`postgres`).

- App image includes FastAPI backend + built frontend.
- No separate frontend/backend images are required for production rollout.
- Optional Traefik override is provided for existing reverse proxy setups.

## Configure environment

```bash
cp .env.example .env
```

Required values:

```env
POSTGRES_PASSWORD=CHANGE_ME_DB_PASSWORD
APP_SECRET=CHANGE_ME_LONG_RANDOM_SECRET
IMAGE_TAG=latest
```

Optional values:

```env
ALLOW_INVITE_LINK_CREATION=false
STEAM_API_KEY=your_steam_api_key
OIDC_ENABLED=true
OIDC_ISSUER_URL=https://auth.example.com
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret_or_empty
OIDC_REDIRECT_URI=https://kuroi.example.com/auth/oidc/callback
OIDC_TOKEN_AUTH_METHOD=auto
OIDC_USE_PKCE=true
ALLOW_SHIRO_LOGIN=false
SHIRO_TOKEN_TTL=30
```

If `ALLOW_SHIRO_LOGIN=true`, users will see the Shiro one-click `Login` action in the UI.
The app generates a short-lived one-time token and launches `shiro://...` so the local Shiro client can fetch credentials securely.

When OIDC is disabled or not fully configured and no users exist yet, kuroi prints a bootstrap invite link/code to the backend console on startup.
Open that link (or paste the code into the registration form) to create the first account.
