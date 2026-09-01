# Real Poke E2E Test Report

- Verification date: 2026-09-01
- Branch: `test/poke-real-e2e`
- Baseline main SHA: `8bc15ffff1509ddf42d24771cafd9c8cd0359bf3`
- Verified code SHA: `1a76e0f49e9c85984660b4400db9e86e1b306dc7`
- GitHub Actions run: `33520198311` — PASS
- CI Node version: 20.20.2
- Production image base: `node:20-bookworm-slim`
- Target public VPS / production domain: NOT CONFIGURED in this session
- Real `POKE_API_KEY`: NOT PROVIDED
- Real Poke Remote MCP account integration: NOT AVAILABLE in this session

## Official Poke contract check

Re-checked against current Poke documentation on 2026-09-01:

- V2 API key uses `Authorization: Bearer <key>`.
- Device messages are sent to `POST https://poke.com/api/v1/inbound/api-message`.
- The request body may carry additional routing context; the HTTP success response confirms delivery to Poke, not the final Agent answer.
- Remote MCP supports a public MCP URL with Bearer/API-key authentication.
- Poke supplies `X-Poke-User-Id` to MCP requests.
- The bridge's authenticated `/mcp` Streamable HTTP endpoint remains compatible with current MCP tool discovery and invocation.

No Poke private API, browser scraping, SMS workaround, or PokeTunnel production dependency is used.

## GitHub CI verification

The final code verification run completed successfully with all of these steps:

| CI step | Result |
| --- | --- |
| `npm install` | PASS |
| Typecheck | PASS |
| ESLint | PASS |
| Vitest | PASS — 6 files / 22 tests |
| TypeScript build | PASS |
| Production Docker image build | PASS |
| Production container startup | PASS |
| `GET /health` smoke | PASS |
| Authenticated `/mcp` `tools/list` smoke | PASS |
| `reply_to_device` runtime discovery | PASS |

The production-container smoke test uses placeholder credentials only and does not contact poke.com.

## Test matrix

| Item | Result |
| --- | --- |
| Typecheck | PASS |
| Lint | PASS |
| Unit / local protocol tests | PASS — 22 tests |
| Build | PASS |
| Docker build | PASS in GitHub CI |
| Container startup | PASS in GitHub CI |
| Health / Ready | PASS |
| MCP tools/list | PASS (`reply_to_device`, `notify_device`, `get_device_status`) |
| Real Poke API | NOT TESTED — real V2 key unavailable |
| Real Poke Remote MCP | NOT TESTED — public deployment / Poke integration unavailable |
| `reply_to_device` | PASS locally via authenticated MCP; NOT TESTED from real Poke Agent |
| Device WebSocket | PASS |
| Device REST fallback | PASS |
| Final reply display path | PASS with mock Poke + real bridge MCP; NOT TESTED through real Poke Agent |
| ACK | PASS (REST + WebSocket, device-scoped) |
| Offline queue | PASS |
| SQLite persistence | PASS (reopen); target VPS compose restart remains deployment-only verification |
| Inbound idempotency | PASS |
| Notification repeat | PASS |
| Cross-device isolation | PASS |
| Device revoke | PASS |
| Reply timeout / no automatic retry | PASS |
| WS query-token auth default | PASS — rejected unless explicitly enabled |
| Weak-network send-state bookkeeping | PASS — `sent_at` changes only after successful `socket.send()` |

## Three review / repair rounds

### Round 1 — protocol and functionality

Verified the complete local protocol path:

```text
simulated device
  -> Bridge
  -> mock Poke accept
  -> authenticated MCP reply_to_device
  -> SQLite
  -> WebSocket / REST polling
  -> ACK
```

Fixes and additions:

- device-originated WebSocket and REST requests have persisted idempotency keys;
- same ID + same text returns the original request ID without invoking Poke twice;
- same ID + different text is rejected as an idempotency conflict;
- cross-device request routing and ACKs are rejected;
- timeout never automatically replays an Agent request with potential side effects;
- added `npm run test:real-e2e` as a one-command real-deployment verifier;
- the verifier uses a persistent WebSocket inbox so early `hello`, `chat.accepted`, or `chat.message` frames cannot race past temporary listeners.

### Round 2 — security

Fixes and verification:

- WebSocket `Authorization: Bearer DEVICE_TOKEN` remains the preferred authentication method;
- query-string device token compatibility is now **disabled by default** and requires `ALLOW_WS_QUERY_TOKEN=true`;
- `TRUST_PROXY` is now **false by default** and must be explicitly enabled behind a trusted reverse proxy;
- MCP uses a separate `MCP_SHARED_SECRET` and constant-time comparison;
- optional `X-Poke-User-Id` allowlist remains supported;
- Device Tokens are 256-bit random values and only hashes are persisted;
- request logging is suppressed using Fastify's current `LogController` API;
- structured logs do not include authorization headers, device tokens, Poke keys, MCP secrets, notification bodies, or chat text.

### Round 3 — deployment and weak-network behavior

Fixes and verification:

- production Docker build and container boot are exercised by CI;
- production `/mcp` is authenticated and tool discovery is exercised in the running container;
- WebSocket `permessage-deflate` remains disabled for old Android compatibility;
- `SessionManager.deliver()` marks `sent_at` only if `socket.send()` succeeds;
- send exceptions leave the message pending for later replay rather than producing false diagnostic state;
- privacy-safe structured events now identify where a real deployment stopped, including:
  - `chat_request_received`
  - `poke_api_request`
  - `poke_api_accepted`
  - `mcp_request`
  - `poke_reply_received`
  - `device_message_queued`
  - `device_message_delivered`
  - `message_acknowledged`
  - `request_reply_timeout`
  - auth / routing rejection events
- Fastify's deprecated top-level `disableRequestLogging` option was replaced with the current `LogController` configuration.

## Real deployment verifier

Once a public deployment has a real Poke V2 key and its Remote MCP integration is registered, run:

```bash
SERVER_URL=https://YOUR_DOMAIN \
DEVICE_ENROLLMENT_SECRET="$DEVICE_ENROLLMENT_SECRET" \
npm run test:real-e2e
```

The script automatically:

1. checks `/health` and `/ready`;
2. enrolls a temporary device;
3. verifies Device Token authentication;
4. opens authenticated WSS using the Authorization header;
5. sends `Reply with exactly: POKE_DEVICE_BRIDGE_OK`;
6. waits for Poke API acceptance;
7. waits for `Poke Agent -> Remote MCP -> reply_to_device -> WebSocket`;
8. requires exact text `POKE_DEVICE_BRIDGE_OK`;
9. sends ACK and verifies the message disappears from the pending queue;
10. revokes the temporary device and verifies the token now returns HTTP 401.

A successful execution ends with:

```text
REAL POKE E2E PASS
```

## Real E2E status

**POKE REAL E2E BLOCKED: MISSING POKE CREDENTIAL / PUBLIC POKE INTEGRATION**

This environment does not have access to a real Poke V2 API key, a deployed HTTPS bridge URL, or the user's Poke Kitchen Remote MCP integration. Therefore it would be incorrect to claim that the actual poke.com Agent round trip has passed.

The following live chain remains the only unverified core path:

```text
test-real-e2e
  -> public Bridge
  -> Poke V2 api-message
  -> Poke Agent
  -> public Remote MCP /mcp
  -> reply_to_device
  -> Bridge SQLite
  -> authenticated WSS
  -> POKE_DEVICE_BRIDGE_OK
  -> ACK
```

## Operator requirements for REAL POKE E2E PASS

1. Set a real Poke Kitchen V2 API key as `POKE_API_KEY` on the server.
2. Deploy the bridge at a public HTTPS `PUBLIC_BASE_URL`.
3. Put Caddy/Nginx in front of the localhost-only Node service and preserve the Host header.
4. Register `https://YOUR_DOMAIN/mcp` in Poke using `MCP_SHARED_SECRET` as its Bearer/API-key credential.
5. Confirm Poke discovers `reply_to_device`, `notify_device`, and `get_device_status`.
6. Run the real E2E verifier shown above.

Current Poke CLI setup can be performed with:

```bash
npx poke@latest login
npx poke@latest mcp add https://YOUR_DOMAIN/mcp -n "Poke Device Bridge" -k "$MCP_SHARED_SECRET"
```

If the real test fails, use the new structured event sequence to identify the boundary:

```text
chat_request_received
-> poke_api_request
-> poke_api_accepted
-> mcp_request
-> poke_reply_received
-> device_message_delivered / device_message_queued
-> message_acknowledged
```

No real credential or secret value is contained in this report.
