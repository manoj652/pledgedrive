# API notes

The machine-readable contract is served at `/openapi.json` when the API is running.

## Accounts and sessions

`POST /api/auth/register` and `POST /api/auth/login` accept `{ "email": "...", "password": "..." }`. A successful response sets a `pledgedrive_session` HttpOnly, SameSite cookie. `GET /api/auth/me` returns the safe account view; `POST /api/auth/logout` revokes the cookie server-side. Passwords are never persisted in plaintext. A password must be 10–256 characters.

## Upload

```http
POST /api/upload?name=report.pdf
Content-Type: application/octet-stream

<bytes>
```

The response is `201` with `{ "id", "name", "size", "mimeType", "category", "chunks" }`. The server rejects empty bodies, invalid names, quota overflow, insufficient healthy capacity (`507`), and bodies over `PLEDGEDRIVE_MAX_UPLOAD_BYTES` (`413`). MIME is classified as `image`, `video`, `audio`, `document`, `archive`, `text`, or `other`, using the request type with a safe extension fallback.

## Download and delete

`GET /api/files/:id` streams a verified file with `Content-Disposition`. If one replica is offline or corrupt, the API tries the next online replica. It returns `503` only when no verified copy remains. Add `?inline=1` to preview safe JPEG/PNG/GIF/WebP/AVIF, common video/audio, or PDF files. `DELETE /api/files/:id` returns `204` after metadata and local replica capacity are released.

## Authentication

When `PLEDGEDRIVE_API_TOKEN` is configured, service-to-service callers send `Authorization: Bearer <token>`; browser callers can use the HttpOnly session cookie from the account endpoints. The token adapter maps to `PLEDGEDRIVE_USER_ID`; replace it with a real identity provider and durable account/session integration before serving multiple users.
