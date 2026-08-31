# Real Poke E2E Test Report

- Test time: 2026-08-31 22:28 UTC
- Branch: `test/poke-real-e2e`
- Baseline main SHA: `8bc15ffff1509ddf42d24771cafd9c8cd0359bf3`
- Node version: v24.15.0 (project engines: `>=20`; CI uses Node 20)
- Docker version: not available in this verification environment
- Domain / TLS: not configured (`PUBLIC_BASE_URL` was local `http://127.0.0.1:3000`)
- Poke API status: official V2 contract unchanged; live key not provided
- MCP status: local `/mcp` tool discovery PASS; real Poke Remote MCP NOT TESTED
- WebSocket status: local RFC6455 `/ws` PASS (`permessage-deflate` remains off)
- Example requestId format: `req_<uuid>`
- Example messageId format: `msg_<uuid>`

## Official Poke contract check

Re-read on 2026-08-31:

- V2 key: Kitchen API key, `Authorization: Bearer <key>`
- Endpoint: `POST https://poke.com/api/v1/inbound/api-message`
- Body: any JSON; `message` is the user-facing field. Extra objects such as `source` and `routing` are forwarded as agent context.
- Response: `{ "success": true, "message": "Message sent successfully" }` confirms delivery only
- Remote MCP: public HTTPS URL, Bearer/API-key auth, `X-Poke-User-Id` still sent
- Recommended production transport: streamable HTTP at `/mcp` (docs also show `/sse` as an example path)
- MCP SDK used by this repo remains compatible with `tools/list` and `tools/call`

No official-contract code change was required.

## Environment limits

This session is not the target public VPS.

- No Docker daemon
- No production domain or TLS terminator
- No `POKE_API_KEY`
- No live Poke Kitchen / Remote MCP account access

Therefore the live chain `test-device -> Poke Agent -> reply_to_device -> device display` could not be executed against poke.com.

## Test matrix

| Item | Result |
| --- | --- |
| Typecheck | PASS |
| Lint | PASS |
| Unit tests | PASS (18 tests: storage, protocol, rate-limit, local protocol e2e) |
| Build | PASS |
| Docker build | NOT TESTED (no Docker in this environment) |
| Container startup | NOT TESTED |
| Health | PASS (`GET /health`) |
| Ready | PASS (`GET /ready`) |
| MCP tools/list | PASS (`reply_to_device`, `notify_device`, `get_device_status`) |
| Real Poke API | NOT TESTED |
| Real Poke Remote MCP | NOT TESTED |
| reply_to_device | PASS locally via authenticated `/mcp`; NOT TESTED from Poke Agent |
| Device WebSocket | PASS |
| Device REST fallback | PASS |
| Final reply display path | PASS locally with mock Poke + MCP; NOT TESTED through real Poke Agent |
| ACK | PASS (REST and WebSocket; cross-device ACK now returns `MESSAGE_NOT_FOUND`) |
| Offline queue | PASS |
| Restart persistence | PASS (SQLite reopen); Docker compose restart NOT TESTED |
| Inbound idempotency | PASS (same id/text returns same requestId and does not call Poke again; different text returns `IDEMPOTENCY_CONFLICT` / HTTP 409) |
| Notification repeat | PASS (identical `notify_device` payloads create distinct messageIds) |
| Cross-device isolation | PASS (`requestId` cannot be answered onto another device; ACK is device-scoped) |
| Device revoke | PASS (token 401, WebSocket close `4003`, MCP reply rejected) |
| Reply timeout | PASS (`POKE_REPLY_TIMEOUT` after accept, no automatic Poke retry) |

## Bugs found and fixes

1. Cross-device WebSocket ACK was a silent no-op. Isolation still held in SQLite, but the client did not see a failure.
   - Fix: emit `error` / `MESSAGE_NOT_FOUND` when ACK does not match the current device.
2. Reply-timeout timers could fire after shutdown and throw `The database connection is not open`.
   - Fix: clear pending reply timers on Fastify close and ignore expire updates when SQLite is closed.
3. `scripts/test-device.ts` used a slightly different prompt than the acceptance phrase.
   - Fix: send `Reply with exactly: POKE_DEVICE_BRIDGE_OK`.
4. CI only ran on `feat/poke-device-bridge`.
   - Fix: also run on `main` and `test/poke-real-e2e`.

## Secrets / logs

Local probes and tests used placeholder credentials only.

Application request logging remains disabled. Authorization headers are redacted if logging is re-enabled. No real `POKE_API_KEY`, `MCP_SHARED_SECRET`, `DEVICE_ENROLLMENT_SECRET`, or `DEVICE_TOKEN` was present or written to this report.

## Resource usage

`docker stats` was not collected. Idle Node process in this environment is not representative of a 1C1G VPS container.

## Real E2E status

**POKE REAL E2E BLOCKED: MISSING POKE CREDENTIAL**

Local protocol path with a mock Poke client:

```text
test / simulated device
  -> Bridge
  -> mock Poke accept
  -> /mcp reply_to_device
  -> SQLite
  -> WebSocket or HTTP poll
  -> POKE_DEVICE_BRIDGE_OK
  -> ACK
```

PASS.

Live path required for `REAL POKE E2E PASS`:

```text
test-device
  -> Bridge
  -> Poke V2 api-message
  -> Poke Agent
  -> Remote MCP reply_to_device
  -> Bridge
  -> SQLite completed + acknowledged
  -> test-device displays POKE_DEVICE_BRIDGE_OK
```

NOT TESTED.

## Unique items the operator must provide

1. Real Poke Kitchen V2 API key as `POKE_API_KEY`
2. Public HTTPS origin as `PUBLIC_BASE_URL` (do not buy a domain from this environment)
3. Reverse proxy (Caddy or Nginx) terminating TLS and forwarding `Host` to `127.0.0.1:3000`
4. `MCP_SHARED_SECRET` configured in Poke Kitchen as Bearer/API key for `https://DOMAIN/mcp`
5. One-time confirmation in Poke that it discovered `reply_to_device`, `notify_device`, `get_device_status`
6. Docker Engine on the target VPS if using `docker compose up -d --build`

After those are available, run:

```bash
docker compose up -d --build
curl -fsS https://DOMAIN/health
# enroll a device with DEVICE_ENROLLMENT_SECRET
SERVER_URL=https://DOMAIN DEVICE_TOKEN=... npm run test:device
```

Then inspect SQLite: the request must be `completed`, and the outbound row must have both `sent_at` and `acknowledged_at`.
