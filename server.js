'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const SH = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.RACE_PASSWORD || 'theolovesobsidian';
const DT = 1 / 60;
const SNAP_EVERY = 3; // broadcast every 3rd tick = 20Hz
const MAX_RACERS = 8;
const COLORS = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#e84393', '#00d2d3', '#f9ca24', '#a55eea'];

// ---- Auth -------------------------------------------------------------------
const sessions = new Set();

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>TB Racer — Private</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at top,#1c2333,#0a0d14);font-family:system-ui,-apple-system,sans-serif;color:#e8ecf4}
.card{background:#141a26;border:1px solid #263042;border-radius:14px;padding:36px 40px;width:320px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{font-size:22px;margin:0 0 6px}p{color:#8b96ab;font-size:13px;margin:0 0 22px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #2c3850;background:#0d1320;color:#fff;font-size:15px;outline:none}
input:focus{border-color:#4d7cfe}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:8px;background:#4d7cfe;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#3d6cf0}.err{color:#ff6b6b;font-size:13px;margin-bottom:12px}
</style></head><body><form class="card" method="POST" action="/auth">
<h1>🏁 TB Racer</h1><p>This track is private. Enter the password.</p>{{ERR}}
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button>Enter the paddock</button></form></body></html>`;

function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function authed(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  return !!sid && sessions.has(sid);
}

// ---- HTTP -------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUB = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && url.pathname === '/auth') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      const pw = new URLSearchParams(body).get('password') || '';
      const a = Buffer.from(pw), b = Buffer.from(PASSWORD);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        const tok = crypto.randomBytes(24).toString('hex');
        sessions.add(tok);
        res.writeHead(302, {
          'Set-Cookie': `sid=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          Location: '/'
        });
      } else {
        res.writeHead(302, { Location: '/?bad=1' });
      }
      res.end();
    });
    return;
  }

  if (!authed(req)) {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(LOGIN_HTML.replace('{{ERR}}', url.searchParams.get('bad') ? '<div class="err">Wrong password. Try again.</div>' : ''));
    } else {
      res.writeHead(403); res.end('Forbidden');
    }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUB, path.normalize(rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---- Game state ---------------------------------------------------------------
const players = new Map(); // id -> player
let nextId = 1;
const game = {
  state: 'lobby',          // lobby | countdown | racing | finished
  mode: 'contact',         // contact | nocontact
  lapsTotal: 3,
  countdownEnd: 0,
  raceStart: 0,
  firstFinishAt: 0
};

function hostId() {
  for (const id of players.keys()) return id;
  return null;
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws.readyState === 1) p.ws.send(s);
  }
}

function sendMeta() {
  broadcast({
    t: 'meta',
    state: game.state,
    mode: game.mode,
    laps: game.lapsTotal,
    host: hostId(),
    cd: game.countdownEnd,
    players: [...players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, role: p.role, racing: !!p.car
    }))
  });
}

function startRace() {
  const racers = [...players.values()].filter(p => p.role === 'racer').slice(0, MAX_RACERS);
  if (!racers.length) return;
  racers.forEach((p, slot) => {
    const g = SH.gridPose(slot);
    p.car = SH.makeCar(g.x, g.y, g.angle, g.idx);
    p.lapsDone = 0;
    p.bestLap = null;
    p.finishTime = null;
    p.lastSeq = 0;
    p.input = { u: 0, d: 0, l: 0, r: 0, h: 0 };
  });
  game.state = 'countdown';
  game.countdownEnd = Date.now() + 3500;
  game.firstFinishAt = 0;
  sendMeta();
}

function endRace() {
  game.state = 'finished';
  const racers = [...players.values()].filter(p => p.car);
  racers.sort((a, b) => {
    if (a.finishTime !== null && b.finishTime !== null) return a.finishTime - b.finishTime;
    if (a.finishTime !== null) return -1;
    if (b.finishTime !== null) return 1;
    return b.car.prog - a.car.prog;
  });
  broadcast({
    t: 'results',
    list: racers.map(p => ({
      name: p.name, color: p.color,
      time: p.finishTime, best: p.bestLap, dnf: p.finishTime === null
    }))
  });
  sendMeta();
}

function toLobby() {
  game.state = 'lobby';
  for (const p of players.values()) p.car = null;
  sendMeta();
}

function rankCmp(a, b) {
  const af = a.finishTime !== null, bf = b.finishTime !== null;
  if (af && bf) return a.finishTime - b.finishTime;
  if (af) return -1;
  if (bf) return 1;
  return b.car.prog - a.car.prog;
}

const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;

let tickNo = 0;
function tick() {
  const now = Date.now();
  tickNo++;

  if (game.state === 'countdown' && now >= game.countdownEnd) {
    game.state = 'racing';
    game.raceStart = now;
    for (const p of players.values()) if (p.car) p.lapStart = now;
    sendMeta();
  }

  if (game.state === 'racing') {
    const racers = [...players.values()].filter(p => p.car);
    for (const p of racers) {
      const c = p.car;
      const inp = c.finished ? { u: 0, d: 1, l: 0, r: 0, h: 0 } : p.input;
      SH.stepCar(c, inp, DT);
      if (!c.finished) {
        const laps = SH.updateProgress(c);
        if (laps > p.lapsDone) {
          const lapTime = now - p.lapStart;
          if (p.bestLap === null || lapTime < p.bestLap) p.bestLap = lapTime;
          p.lapStart = now;
          p.lapsDone = laps;
          if (laps >= game.lapsTotal) {
            c.finished = true;
            p.finishTime = now - game.raceStart;
            if (!game.firstFinishAt) game.firstFinishAt = now;
          }
        } else if (laps < p.lapsDone) {
          p.lapsDone = laps; // drove backwards across the line
        }
      }
    }
    if (game.mode === 'contact') {
      for (let i = 0; i < racers.length; i++)
        for (let j = i + 1; j < racers.length; j++)
          SH.collideCars(racers[i].car, racers[j].car);
    }
    const allDone = racers.length > 0 && racers.every(p => p.car.finished);
    const timeout = game.firstFinishAt && now - game.firstFinishAt > 45000;
    if (allDone || timeout || racers.length === 0) endRace();
  }

  if (tickNo % SNAP_EVERY === 0 && (game.state === 'countdown' || game.state === 'racing' || game.state === 'finished')) {
    const racers = [...players.values()].filter(p => p.car);
    racers.sort(rankCmp);
    broadcast({
      t: 's',
      st: game.state,
      now,
      cd: game.countdownEnd,
      cars: racers.map(p => {
        const c = p.car;
        return [p.id, r1(c.x), r1(c.y), r3(c.angle), r1(c.vx), r1(c.vy), r3(c.steer),
          p.lastSeq, p.lapsDone, Math.round(c.prog),
          (p.input.d ? 1 : 0) | (p.input.h ? 2 : 0) | (c.finished ? 4 : 0) | (c.onTrack ? 8 : 0)];
      })
    });
  }
}
setInterval(tick, 1000 / 60);

// ---- WebSocket ----------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, sock, head) => {
  if (!authed(req)) {
    sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    sock.destroy();
    return;
  }
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ t: 'welcome' }));

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join' && !me) {
      const name = String(m.name || '').replace(/[^\w \-'.]/g, '').trim().slice(0, 16) || 'Racer ' + nextId;
      const role = m.role === 'spectator' ? 'spectator' : 'racer';
      const used = new Set([...players.values()].map(p => p.color));
      const color = COLORS.find(c => !used.has(c)) || COLORS[nextId % COLORS.length];
      me = {
        id: nextId++, ws, name, color, role,
        input: { u: 0, d: 0, l: 0, r: 0, h: 0 }, lastSeq: 0,
        car: null, lapsDone: 0, bestLap: null, finishTime: null, lapStart: 0
      };
      players.set(me.id, me);
      ws.send(JSON.stringify({ t: 'you', id: me.id }));
      sendMeta();
      return;
    }
    if (!me) return;

    switch (m.t) {
      case 'i':
        me.input.u = m.u ? 1 : 0;
        me.input.d = m.d ? 1 : 0;
        me.input.l = m.l ? 1 : 0;
        me.input.r = m.r ? 1 : 0;
        me.input.h = m.h ? 1 : 0;
        if (typeof m.s === 'number') me.lastSeq = m.s;
        break;
      case 'mode':
        if (me.id === hostId() && game.state === 'lobby' && (m.mode === 'contact' || m.mode === 'nocontact')) {
          game.mode = m.mode; sendMeta();
        }
        break;
      case 'laps':
        if (me.id === hostId() && game.state === 'lobby') {
          const n = Math.round(Number(m.n));
          if (n >= 1 && n <= 10) { game.lapsTotal = n; sendMeta(); }
        }
        break;
      case 'role':
        if (m.role === 'racer' || m.role === 'spectator') {
          me.role = m.role;
          if (game.state === 'lobby') me.car = null;
          sendMeta();
        }
        break;
      case 'start':
        if (me.id === hostId() && game.state === 'lobby') startRace();
        break;
      case 'lobby':
        if (me.id === hostId() && game.state === 'finished') toLobby();
        break;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    players.delete(me.id);
    if (players.size === 0) {
      game.state = 'lobby';
      game.mode = 'contact';
      game.lapsTotal = 3;
    } else {
      if (game.state === 'racing') {
        const racers = [...players.values()].filter(p => p.car);
        if (racers.length === 0) toLobby();
      }
      sendMeta();
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`TB Racer running on http://localhost:${PORT}`);
});
