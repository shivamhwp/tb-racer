# 🏁 TB Racer

Real-time multiplayer 3D circuit racing in the browser, with named rooms.
Runs locally under bun and deploys to Cloudflare Workers + Durable Objects.

## Run locally

```sh
bun install
bun start          # http://localhost:3000
```

No password needed — just open the URL and play.
Port: `PORT=8080 bun start`. To put the game behind an access code, set
`RACE_PASSWORD=... bun start` (and `ADMIN_PASSWORD=...` to gate `/admin`).

## Deploy to Cloudflare

```sh
bunx wrangler deploy
```

Static assets, the optional login gate, and one Durable Object per room are
configured in `wrangler.jsonc`. The deployment is open by default; to
password-protect it: `bunx wrangler secret put RACE_PASSWORD` and
`bunx wrangler secret put ADMIN_PASSWORD`.

## Admin (race control)

`/admin` — race control dashboard (gated by `ADMIN_PASSWORD` when set). Shows
every active room with its state and players, and a **Close room** button that
disconnects everyone and frees the room's compute. Rooms also conserve compute
automatically: the 60Hz simulation loop only runs while a race is in progress
(lobbies are idle), and a finished race returns to the lobby by itself after
90s.

## Play

- Pick a name **and a room name** — everyone who types the same room name
  races together; different rooms are fully isolated worlds.
- The first player in a room is the **host**: picks **Contact** /
  **Non-contact**, lap count, and starts the race.
- Drive with **WASD / arrow keys**, **SPACE** = handbrake (drift), **M** = mute,
  **C** = camera (chase / close / high), **F** = fullscreen.
- The **Leave** button (top right) exits to the join screen from anywhere —
  lobby, mid-race, or results. Host leaves → the next player becomes host.
- Other players' cars render at reduced opacity; in non-contact mode they are
  ghosts (no collisions).
- Players joining mid-race spectate automatically and race the next round.

## Architecture

- `game/room.js` — transport-agnostic race room: lobby/countdown/race/results
  state machine, authoritative 60 Hz physics, 20 Hz snapshot broadcast. Used
  verbatim by both servers below.
- `server.js` — local Node/bun HTTP + `ws` server. One room per name, created
  on demand, reaped when empty.
- `worker.js` — Cloudflare Worker entry: stateless HMAC-signed cookie auth
  (only when the `RACE_PASSWORD` secret is set) on every page, asset, and
  WebSocket upgrade; routes `/ws/<room>` to a `RaceRoom` Durable Object (one
  per room name) running the same simulation.
- `public/shared.js` — track geometry + car physics, shared by server and
  client so prediction matches the simulation exactly.
- `public/client3d.js` — Three.js renderer (chase cam, shadows, ACES tone
  mapping, sky/fog/hills, animated crowd + grandstands, skid decals, tire
  smoke, body roll/pitch) on top of client-side prediction with
  render-interpolation between physics steps, server reconciliation, and
  ~120 ms snapshot interpolation for remote cars.
- `public/vendor/` — vendored Three.js, kept local so the game has no CDN
  dependency.
