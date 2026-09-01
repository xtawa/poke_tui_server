# Poke Device Bridge

A server bridge for small Android devices, including Android 6 MP3 players, to talk to Poke and display Poke replies.

## Flow

```text
Android device
  <-> HTTPS / WebSocket
Poke Device Bridge
  -> Poke V2 message API
  <- Poke Remote MCP /mcp
       reply_to_device
  -> SQLite offline queue
  -> Android device
```

The outbound Poke API confirms delivery only. The final answer returns through the `reply_to_device` MCP tool and is then pushed to the device.

## Implemented

- Poke V2 outbound message client
- Remote MCP endpoint at `/mcp`
- MCP tools: `reply_to_device`, `notify_device`, `get_device_status`
- device enrollment, hashed device tokens and revocation
- WebSocket connection, heartbeat, replacement and reconnect replay
- persisted inbound idempotency so a retried device message cannot invoke Poke twice
- HTTP polling fallback for Android 6 devices
- SQLite WAL persistence and bounded offline queue
- reply timeout handling
- device and MCP rate limiting
- Docker, Compose, Caddy, Nginx and systemd deployment files
- CI typecheck, lint, tests, build, production-container health and MCP tool-discovery smoke tests

## Configuration

Copy `.env.example` to `.env` and set the public HTTPS base URL plus the three independent credentials used for Poke outbound access, MCP inbound access and device enrollment.

By default the server does not persist full inbound user text. Set `STORE_MESSAGE_CONTENT=true` only if message retention is desired. Inbound deduplication stores only the client message ID, request ID and existing request text hash, so it still works when full message retention is disabled.

For Docker, SQLite is stored under the mounted `data` directory.

## Poke setup

In Poke/Kitchen add this server as a Remote MCP integration using:

- URL: `https://YOUR_DOMAIN/mcp`
- authentication: Bearer/API-key authentication
- key: the same value configured as `MCP_SHARED_SECRET`

The current Poke CLI can also add the remote MCP after login:

```bash
npx poke@latest login
npx poke@latest mcp add https://YOUR_DOMAIN/mcp -n "Poke Device Bridge" -k "$MCP_SHARED_SECRET"
```

After tool sync, Poke should discover `reply_to_device`, `notify_device` and `get_device_status`.

Device-originated messages are sent to Poke with server-generated `deviceId` and `requestId` routing metadata. Poke is explicitly instructed to call `reply_to_device` after completing the request. The MCP tool verifies that the request belongs to the specified device before delivering it.

## Device endpoints

- `POST /api/v1/enroll` - administrator device enrollment
- `GET /api/v1/device` - current device information
- `DELETE /api/v1/device` - revoke current device
- `POST /api/v1/messages` - send a Poke request over HTTP
- `GET /api/v1/messages` - fetch unacknowledged replies
- `POST /api/v1/messages/:messageId/ack` - acknowledge a reply
- `POST /api/v1/device/status` - report device state
- `GET /ws` - preferred real-time device connection
- `POST/GET /mcp` - Poke Remote MCP endpoint
- `GET /health` and `GET /ready` - service probes

The preferred WebSocket authentication method is an `Authorization: Bearer ...` header. Query-string token authentication is disabled by default because reverse-proxy access logs can capture URLs. Only set `ALLOW_WS_QUERY_TOKEN=true` for a legacy Android WebSocket client that cannot send an Authorization header; application request logging remains disabled as an additional safeguard.

For HTTP sending, clients may supply an `Idempotency-Key` header (1-128 characters). Reusing that key with the same text returns the original request ID without calling Poke again; reusing it with different text returns HTTP 409.

## WebSocket protocol

Device messages use a common envelope with `id`, `type`, `timestamp` and `payload`.

Device -> server types:

- `chat.send`
- `ack`
- `device.status`
- `ping`

Server -> device types:

- `hello`
- `chat.accepted`
- `chat.message`
- `notification`
- `error`
- `pong`

The WebSocket envelope `id` is the persisted idempotency key for `chat.send`. If the same message is retransmitted after a network interruption, the bridge returns the original `requestId` instead of executing Poke a second time. Reusing the ID with different message text is rejected as an idempotency conflict.

A `chat.message` remains in SQLite until the device ACKs its message ID. On reconnect, unacknowledged messages are replayed.

## Development verification

Run the normal npm install step, then `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

`scripts/test-device.ts` is a simulated Android client. With a real enrolled device token and a configured Poke Remote MCP integration, `npm run test:device` performs the end-to-end check and expects the final text `POKE_DEVICE_BRIDGE_OK` to arrive through `reply_to_device`.

For a deployed server, `scripts/test-real-e2e.ts` performs the complete acceptance flow itself: health/ready, temporary device enrollment, authenticated WSS connection, Poke request, Remote MCP reply, ACK persistence, test-device revocation and revoked-token rejection.

```bash
SERVER_URL=https://YOUR_DOMAIN \
DEVICE_ENROLLMENT_SECRET="$DEVICE_ENROLLMENT_SECRET" \
npm run test:real-e2e
```

Optional variables:

- `E2E_EXPECTED_TEXT` (default `POKE_DEVICE_BRIDGE_OK`)
- `E2E_TIMEOUT_MS` (default `240000`)

A successful run ends with `REAL POKE E2E PASS`. It requires the deployed bridge to already have a real `POKE_API_KEY` and the Poke account to have the bridge Remote MCP integration configured.

CI also builds the production Docker image, starts it, checks `/health`, authenticates to `/mcp`, and verifies that `reply_to_device` is actually discoverable at runtime.

CI does not contain real Poke credentials, so live Poke E2E remains a deployment test rather than a public-repository CI step.

## Deployment

`docker-compose.yml` binds the application to localhost so a TLS reverse proxy can expose it. `Caddyfile.example` and `nginx.conf.example` preserve the public Host header required by production MCP host validation.

For a non-Docker installation, `poke-device-bridge.service` provides a hardened systemd starting point. Its writable database directory must match `DATABASE_PATH` in the service environment file.

The Android APK is intentionally outside the current server-side scope.
