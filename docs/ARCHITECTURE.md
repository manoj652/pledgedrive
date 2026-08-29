# PledgeDrive architecture

## Runtime path

```text
Browser / node clients
        │ HTTPS + request id
        ▼
HTTP API
  ├── authentication boundary
  ├── quota + file metadata
  ├── append-only ledger
  └── health / readiness / metrics / OpenAPI
        │
        ▼
PledgeDriveService
  ├── 4 MiB chunk planner
  ├── AES-256-GCM envelope encryption
  ├── deterministic, diverse placement
  ├── verified-replica download failover
  └── repair + capacity accounting
        │
        ├── JsonStateStore (single-process local runtime)
        └── PostgreSQL schema contract (multi-process adapter)
```

## Invariants

1. A file consumes user quota once, while each replica consumes node pledged capacity.
2. Placement only considers online nodes with enough capacity and a reliability score of at least 0.7.
3. The planner simulates capacity for every chunk before mutating any node, so a rejected upload leaves no allocation leak.
4. Each chunk carries a plaintext hash, ciphertext hash, nonce, and authentication tag. Reads validate the ciphertext and decrypted plaintext before returning bytes.
5. A download tries every online replica and returns `503` only when no verified copy remains.
6. Removing a file deletes its unreferenced local replicas and returns their capacity to the owning nodes.
7. Local state writes use a temporary file plus atomic rename. The JSON store is a durable development fallback, not a substitute for a transactional database cluster.

## Deployment shape

The included container image runs one API process as an unprivileged user. `infrastructure/docker-compose.yml` adds PostgreSQL and Redis with persistent volumes and health checks. For a horizontally scaled deployment, replace `JsonStateStore` with a PostgreSQL repository, move chunk bytes to node/object-storage adapters, and run repair/integrity work from durable queues.
