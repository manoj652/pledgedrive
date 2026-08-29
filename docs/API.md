# API notes

The machine-readable contract is served at `/openapi.json` when the API is running.

## Upload

```http
POST /api/upload?name=report.pdf
Content-Type: application/octet-stream

<bytes>
```

The response is `201` with `{ "id", "name", "size", "chunks" }`. The server rejects empty bodies, invalid names, quota overflow, insufficient healthy capacity (`507`), and bodies over `PLEDGEDRIVE_MAX_UPLOAD_BYTES` (`413`).

## Download and delete

`GET /api/files/:id` streams a verified file with `Content-Disposition`. If one replica is offline or corrupt, the API tries the next online replica. It returns `503` only when no verified copy remains. `DELETE /api/files/:id` returns `204` after metadata and local replica capacity are released.

## Authentication

When `PLEDGEDRIVE_API_TOKEN` is configured, send `Authorization: Bearer <token>` to API routes. The current adapter maps that token to `PLEDGEDRIVE_USER_ID`; replace it with a real account/session integration before serving multiple users.
