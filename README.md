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
- HTTP polling fallback for Android 6 devices
- SQLite WAL persistence and bounded offline queue
- reply timeout handling
- device and MCP rate limiting
- Docker, Compose, Caddy, Nginx and systemd deployment files
- CI typecheck, lint, tests, build and production-container smoke test

## Configuration

Copy `.env.example` to `.env` and set the public HTTPS base URL plus the three independent credentials used for Poke outbound access, MCP inbound access and device enrollment.

By default the server does not persist full inbound user text. Set `STORE_MESSAGE_CONTENT=true` only if message retention is desired.

For Docker, SQLite is stored under the mounted `data` directory.

## Poke setup

In Poke/Kitchen add this server as a Remote MCP integration using:

- URL: `https://YOUR_DOMAIN/mcp`
- authentication: Bearer/API-key authentication
- key: the same value configured as `MCP_SHARED_SECRET`

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

The preferred WebSocket authentication method is an Authorization header. A query-token compatibility mode exists for old Android WebSocket clients; application request logging is disabled so that compatibility token is not written to request logs.

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

A `chat.message` remains in SQLite until the device ACKs its message ID. On reconnect, unacknowledged messages are replayed.

## Development verification

Run the normal npm install step, then `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

`scripts/test-device.ts` is a simulated Android client. With a real enrolled device token and a configured Poke Remote MCP integration, `npm run test:device` performs the full end-to-end check and expects the final text `POKE_DEVICE_BRIDGE_OK` to arrive through `reply_to_device`.

CI does not contain real Poke credentials, so live Poke E2E remains a manual deployment test.

## Deployment

`docker-compose.yml` binds the application to localhost so a TLS reverse proxy can expose it. `Caddyfile.example` and `nginx.conf.example` preserve the public Host header required by production MCP host validation.

For a non-Docker installation, `poke-device-bridge.service` provides a hardened systemd starting point. Its writable database directory must match `DATABASE_PATH` in the service environment file.

The Android APK is intentionally outside the current server-side scope.
