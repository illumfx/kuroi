<div style="text-align: center;">
<h3>kuroi</h3>

![Kuroi Logo](./frontend/src/assets/kuroi-logo.svg)

`kuroi` is a Steam account management app with OIDC authentication, API-key automation, account visibility controls, and ban-state tracking.

</div>

---

> [!NOTE]
> kuroi is mostly vibe-coded and not in a stable state.

## Production model (simplified)

Production now uses **one application image** (`kuroi-app`) plus **one database** (`postgres`).

- App image includes FastAPI backend + built frontend.
- No separate frontend/backend images are required for production rollout.
- Optional Traefik override is provided for existing reverse proxy setups.

## 1) Configure environment

```bash
cp .env.example .env
```

Required values:

```env
POSTGRES_PASSWORD=CHANGE_ME_DB_PASSWORD
APP_SECRET=CHANGE_ME_LONG_RANDOM_SECRET
IMAGE_TAG=latest
```

Optional OIDC values:

```env
OIDC_ENABLED=true
OIDC_ISSUER_URL=https://auth.example.com
OIDC_CLIENT_ID=your_client_id
OIDC_CLIENT_SECRET=your_client_secret_or_empty
OIDC_REDIRECT_URI=https://kuroi.example.com/auth/oidc/callback
OIDC_TOKEN_AUTH_METHOD=auto
OIDC_USE_PKCE=true
```

## 2) Deploy from GHCR (no local build)

Public image used by default: `ghcr.io/illumfx/kuroi-app`

If package visibility is private, authenticate first:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
```

Deploy:

```bash
docker compose pull
docker compose up -d
```

Access:

- App (frontend + API): `http://localhost:3000`

## 3) Deploy behind existing Traefik

Set Traefik variables in `.env`:

```env
TRAEFIK_NETWORK=traefik_proxy
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_DOMAIN=kuroi.example.com
TRAEFIK_TLS=true
```

Deploy with override:

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d
```

Notes:

- Assumes Traefik is already running.
- `TRAEFIK_NETWORK` must exist as an external Docker network.
- Host ports are removed in Traefik mode.

## 4) CI/CD workflow

Workflow file: `.github/workflows/docker-publish.yml`

What it does:

- Builds and pushes **one** image: `ghcr.io/<owner>/kuroi-app` (public deploy uses `ghcr.io/illumfx/kuroi-app`)
- Triggers on `main`, `v*` tags, and manual dispatch
- Publishes multi-arch images (`linux/amd64`, `linux/arm64`)
- Uses GitHub Actions cache for faster rebuilds

## 5) Security checklist

- Keep `.env` out of git (already ignored).
- Use strong unique `APP_SECRET` and `POSTGRES_PASSWORD`.
- Use HTTPS for production domains and OIDC redirect URI.
- Rotate API keys regularly.
- Keep GHCR token scoped minimally.

## 6) VPS quick checklist (copy/paste)

```bash
# 1) Optional: login to GHCR (required for private packages)
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

# 2) Prepare environment
cp .env.example .env

# 3) Pull latest images
docker compose pull

# 4) Start (or update) stack
docker compose up -d

# 5) Future rollout update
docker compose pull && docker compose up -d
```

With Traefik:

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d
```
