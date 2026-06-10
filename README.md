# 🏁 TB Racer

Password-gated real-time multiplayer circuit racing in the browser.

## Run

```sh
bun install
bun start          # http://localhost:3000
```

Password: `theolovesobsidian` (override with `RACE_PASSWORD=... bun start`).
Port: `PORT=8080 bun start`.

## Play

- Enter the password, pick a name, **Join as Racer** or **Watch as Spectator**.
- The first player in is the **host**: picks **Contact** / **Non-contact**, lap
  count, and starts the race.
- Drive with **WASD / arrow keys**, **SPACE** = handbrake (drift), **M** = mute,
  **C** = camera (chase / close / high).
- Other players' cars render at reduced opacity; in non-contact mode they are
  ghosts (no collisions).
- Players joining mid-race spectate automatically and race the next round.

## Architecture

- `server.js` — Node HTTP + `ws` WebSocket server. Session-cookie password gate
  on every page, asset, and the WebSocket upgrade. Authoritative physics at
  60 Hz, state broadcast at 20 Hz.
- `public/shared.js` — track geometry + car physics, shared verbatim by server
  and client so prediction matches the simulation.
- `public/client3d.js` — Three.js 3D renderer (chase camera, real-time shadows,
  ACES tone mapping, sky/fog/hills, animated crowd + grandstands, skid-mark
  decals, tire smoke, body roll/pitch) on top of client-side prediction +
  server reconciliation for your own car (zero input latency) and snapshot
  interpolation (~120 ms) for remote cars. Engine audio via WebAudio.
- `public/vendor/three.module.js` — vendored Three.js so the whole game stays
  behind the password gate.

## Deploying

This is a stateful WebSocket server — host it on something that runs a
persistent Node process (Railway, Fly.io, Render, a VPS). Vercel serverless
functions don't hold WebSocket connections, so this app isn't a fit there
as-is. Behind HTTPS the client automatically uses `wss://`.
