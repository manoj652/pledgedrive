# PledgeDrive

**Your cloud. Powered by everyone's spare storage.**

![PledgeDrive dashboard](pledgedrive-dashboard.png)

PledgeDrive is a production-grade core MVP for encrypted, replicated cloud storage. The repository contains a working TypeScript control plane, durable local state store, deterministic placement engine, failure repair, a responsive web client, a node CLI contract, and container/CI packaging. The code is intentionally explicit about what still needs a multi-process production adapter before a public launch.

## What works today

- 5 GB account quota, file listing/search, upload, download, and delete.
- Account registration, sign-in/sign-out, salted scrypt password hashes, and revocable HttpOnly session cookies.
- File classification for photos, videos, audio, documents, archives, and text; safe inline preview for common image/video/audio formats and PDFs.
- 4 MiB chunking with three replicas across independent users where capacity allows.
- AES-256-GCM envelope encryption at rest: a per-file key is wrapped by the configured 32-byte master key; nodes only hold ciphertext.
- SHA-256 verification of both ciphertext and recovered plaintext, with automatic download failover to another healthy replica.
- Atomic preflighted uploads, durable atomic JSON state (`PLEDGEDRIVE_STATE_FILE`), replica repair, node status transitions, and append-only credit ledger entries.
- Request IDs, structured error logs, security headers/CSP, body-size limits, liveness/readiness probes, Prometheus-style metrics, and an OpenAPI document.
- Accessible responsive web UI with safe DOM rendering, progress feedback, drag-friendly upload affordance, search, error toasts, and destructive-action confirmation.

## Run locally

```bash
npm ci
npm run dev
# open http://localhost:8787
```

The server does not seed provider nodes. A fresh install starts with an empty network; register storage nodes through the authenticated API or after signing in to the web client, and state is stored under `./data/state.json` by default.

Quality gates:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke # requires the server to be running
```

## Configuration

Copy `.env.example` to `.env` and set values for your environment. Important production settings:

```text
NODE_ENV=production
PLEDGEDRIVE_MASTER_KEY=<32-byte base64 or 64-character hex key>
PLEDGEDRIVE_API_TOKEN=<at least 32 random characters>
PLEDGEDRIVE_USER_ID=<stable operator account id>
PLEDGEDRIVE_STATE_FILE=/var/lib/pledgedrive/state.json
```

Production startup fails closed if the master key, API token, or operator user ID is missing. When `PLEDGEDRIVE_API_TOKEN` is set, service-to-service API calls use `Authorization: Bearer <token>`; browser accounts use the revocable HttpOnly session cookie. Health, readiness, metrics, OpenAPI, and static assets remain probeable. The token maps to the configured operator user ID; replace that single-account adapter with your identity provider and durable account/session store before exposing the service to multiple users.

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `GET /ready` | Readiness probe |
| `GET /metrics` | Prometheus-compatible process metrics |
| `GET /openapi.json` | API contract |
| `GET /api/dashboard` | Quota, files, devices, and network health |
| `GET /api/auth/me` | Read the current session |
| `POST /api/auth/register` | Create an account and sign in |
| `POST /api/auth/login` | Sign in |
| `POST /api/auth/logout` | Revoke the current session |
| `GET /api/files?query=` | Search the authenticated account's files |
| `POST /api/upload?name=...` | Upload an octet-stream (size-limited, MIME classified) |
| `GET /api/files/:id` | Download with verified-replica failover (`?inline=1` previews safe formats) |
| `DELETE /api/files/:id` | Delete metadata and release replica capacity |
| `POST /api/nodes` | Register a storage node |
| `PATCH /api/nodes/:id/status` | Pause, resume, or retire a node |
| `POST /api/repair` | Rebuild under-replicated chunks |
| `GET /api/ledger` | Read the authenticated account ledger |

## Containers

The compose stack includes the API, PostgreSQL, Redis, health checks, persistent volumes, and loopback-only host bindings:

```bash
docker compose -f infrastructure/docker-compose.yml up --build
```

`packages/database/migrations/001_initial.sql` is the PostgreSQL schema contract. The default local runtime uses the atomic JSON store so it remains runnable without external services; wire the schema through a repository/transaction adapter before running more than one API process.

## Node CLI

```bash
npm run node -- node init
npm run node -- node start
npm run node -- node stop
npm run node -- node status
npm run node -- node pause
npm run node -- node logs
npm run node -- node configure
```

The CLI defines the Linux/NAS-friendly control contract. Native Windows Service, macOS LaunchAgent, Docker node image, and Android/iOS clients are protocol-level follow-on work; mobile nodes must remain intermittent and never be the sole durable replica.

## Security boundary

The storage layer now encrypts chunks before they are placed and verifies them on every read. This is server-side envelope encryption for the runnable core, not a claim of browser end-to-end encryption: the API process can decrypt data. Before public launch, add client-held keys/key recovery, TLS termination, signed node authentication and heartbeats, capacity proofs, rate limiting, audit/security events, abuse controls, durable Postgres/Redis repositories, background workers, object-storage fallback, and a threat-model/penetration-test review. See [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
