'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomCore } = require('./game/room.js');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.RACE_PASSWORD || 'theolovesobsidian';

// ---- Auth: stateless signed token (exp.hmac) ----------------------------------
function makeToken() {
  const exp = Date.now() + 7 * 864e5;
  const sig = crypto.createHmac('sha256', PASSWORD).update('tbr.' + exp).digest('hex');
  return exp + '.' + sig;
}
function checkToken(tok) {
  if (!tok) return false;
  const i = tok.indexOf('.');
  if (i < 1) return false;
  const exp = Number(tok.slice(0, i));
  if (!exp || exp < Date.now()) return false;
  const sig = Buffer.from(tok.slice(i + 1));
  const want = Buffer.from(crypto.createHmac('sha256', PASSWORD).update('tbr.' + exp).digest('hex'));
  return sig.length === want.length && crypto.timingSafeEqual(sig, want);
}
function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function authed(req) {
  return checkToken(parseCookies(req.headers.cookie).sid);
}

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

// ---- HTTP -------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const PUB = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && url.pathname === '/auth') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      const pw = new URLSearchParams(body).get('password') || '';
      const a = crypto.createHash('sha256').update(pw).digest();
      const b = crypto.createHash('sha256').update(PASSWORD).digest();
      if (crypto.timingSafeEqual(a, b)) {
        res.writeHead(302, {
          'Set-Cookie': `sid=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
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

// ---- Rooms over WebSocket ------------------------------------------------------
const rooms = new Map(); // name -> { core, interval }
function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    const core = new RoomCore(name);
    r = { core, interval: setInterval(() => core.tick(Date.now()), 1000 / 60) };
    rooms.set(name, r);
  }
  return r;
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, sock, head) => {
  if (!authed(req)) {
    sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    sock.destroy();
    return;
  }
  const m = new URL(req.url, 'http://x').pathname.match(/^\/ws\/([a-z0-9_-]{1,24})$/i);
  if (!m) {
    sock.write('HTTP/1.1 404 Not Found\r\n\r\n');
    sock.destroy();
    return;
  }
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req, m[1].toLowerCase()));
});

wss.on('connection', (ws, req, roomName) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const room = getRoom(roomName);
  const conn = { send: s => { if (ws.readyState === 1) ws.send(s); } };
  const ctx = room.core.onConnection(conn);
  ws.on('message', raw => room.core.onMessage(ctx, raw));
  ws.on('close', () => {
    room.core.onClose(ctx);
    if (room.core.size === 0) {
      clearInterval(room.interval);
      rooms.delete(roomName);
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
