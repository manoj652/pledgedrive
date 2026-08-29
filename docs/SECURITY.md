# Security boundary

## Implemented in this core

- AES-256-GCM encryption for every stored chunk with a fresh 96-bit nonce.
- Per-file data keys wrapped by a configured 32-byte master key.
- SHA-256 verification before a replica is read or counted as healthy.
- No plaintext chunk bytes are written to the local state file.
- Strict filename validation (no path separators/control characters).
- Request body limits, request IDs, safe static-path resolution, CSP, `nosniff`, frame and referrer protections, and loopback-only compose bindings.
- Production configuration fails closed without `PLEDGEDRIVE_MASTER_KEY` and a strong `PLEDGEDRIVE_API_TOKEN`.
- Transaction rollback on rejected mutations and atomic state persistence.

## Not yet a public-cloud security claim

The current browser and API process share the configured master key. This means it is encrypted at rest, but the service can decrypt content. A public deployment still needs:

- Client-held master keys, key recovery, and explicit sharing envelopes.
- TLS with certificate rotation, a real identity/session provider, per-user authorization, and signed node credentials.
- Outbound node protocol with replay protection, heartbeats, capacity proofs, revocation, and secure local credential storage.
- Rate limits, abuse reporting, malware/content policy, audit/security events, and data-retention/deletion workflows.
- Secret management outside environment files, dependency/SAST scanning, threat modelling, penetration testing, backup/restore drills, and incident response.

Never use the development fallback key or the compose development password for production data.
