# Operations runbook

## Probes and diagnostics

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/ready
curl http://127.0.0.1:8787/metrics
curl http://127.0.0.1:8787/openapi.json
```

Every response includes an `x-request-id`. Error responses also return that ID so logs can be correlated:

```json
{"error":"Request failed","code":"INTERNAL_ERROR","requestId":"..."}
```

The server writes one structured JSON error line per failed request. Do not log file contents, keys, or bearer tokens.

## Local state

The default state path is `./data/state.json`; production-like local deployments should put it on a dedicated persistent volume and restrict it to the service account (`0600`). Back it up before upgrades. A corrupt or unsupported state file causes startup to fail rather than silently discarding metadata.

## Safe node retirement

Pause a node before removing it. Run `POST /api/repair` until affected files have the configured replication factor, verify a download, then retire the node. Native node agents must implement a migration grace period before deleting hosted chunks.

## Scaling checklist

1. Put TLS and an identity provider in front of the API.
2. Replace the JSON store with PostgreSQL transactions and use Redis for locks/rate limits.
3. Move chunk bytes behind authenticated node/object-storage adapters.
4. Run repair, integrity, garbage-collection, and credit workers from durable queues.
5. Alert on readiness failures, error rate, upload/download latency, under-replication, corruption, and capacity exhaustion.
