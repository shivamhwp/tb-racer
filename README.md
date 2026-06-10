# 🏁 TB Racer

Password-gated real-time multiplayer 3D circuit racing in the browser, with
named rooms. Runs locally under bun and deploys to Cloudflare Workers +
Durable Objects.

## Run locally

```sh
bun install
bun start          # http://localhost:3000
```

Password: `theolovesobsidian` (override with `RACE_PASSWORD=... bun start`).
Port: `PORT=8080 bun start`.

## Deploy to Cloudflare

```sh
bunx wrangler deploy
```

Static assets, the login gate, and one Durable Object per room are configured
in `wrangler.jsonc`. To change the password in prod:
`bunx wrangler secret put RACE_PASSWORD`.

## Play

- Enter the password, pick a name **and a room name** — everyone who types the
  same room name races together; different rooms are fully isolated worlds.
- The first player in a room is the **host**: picks **Contact** /
  **Non-contact**, lap count, and starts the race.
- Drive with **WASD / arrow keys**, **SPACE** = handbrake (drift), **M** = mute,
  **C** = camera (chase / close / high).
- Other players' cars render at reduced opacity; in non-contact mode they are
  ghosts (no collisions).
- Players joining mid-race spectate automatically and race the next round.

## Architecture

- `game/room.js` — transport-agnostic race room: lobby/countdown/race/results
  state machine, authoritative 60 Hz physics, 20 Hz snapshot broadcast. Used
  verbatim by both servers below.
- `server.js` — local Node/bun HTTP + `ws` server. One room per name, created
  on demand, reaped when empty.
- `worker.js` — Cloudflare Worker entry: stateless HMAC-signed cookie auth on
  every page, asset, and WebSocket upgrade; routes `/ws/<room>` to a
  `RaceRoom` Durable Object (one per room name) running the same simulation.
- `public/shared.js` — track geometry + car physics, shared by server and
  client so prediction matches the simulation exactly.
- `public/client3d.js` — Three.js renderer (chase cam, shadows, ACES tone
  mapping, sky/fog/hills, animated crowd + grandstands, skid decals, tire
  smoke, body roll/pitch) on top of client-side prediction with
  render-interpolation between physics steps, server reconciliation, and
  ~120 ms snapshot interpolation for remote cars.
- `public/vendor/` — vendored Three.js so the whole game stays behind the
  password gate.
