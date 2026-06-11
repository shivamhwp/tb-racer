'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomCore } = require('./game/room.js');

const PORT = process.env.PORT || 3000;
// No passwords by default: the game and /admin are open unless these are set.
const PASSWORD = process.env.RACE_PASSWORD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ---- Auth: stateless signed tokens --------------------------------------------
function sign(key, prefix, exp) {
  return crypto.createHmac('sha256', key).update(prefix + exp).digest('hex');
}
function makeToken(key, prefix) {
  const exp = Date.now() + 7 * 864e5;
  return exp + '.' + sign(key, prefix, exp);
}
function checkToken(tok, key, prefix) {
  if (!tok) return false;
  const i = tok.indexOf('.');
  if (i < 1) return false;
  const exp = Number(tok.slice(0, i));
  if (!exp || exp < Date.now()) return false;
  const sig = Buffer.from(tok.slice(i + 1));
  const want = Buffer.from(sign(key, prefix, exp));
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
const authedGame = req => !PASSWORD || checkToken(parseCookies(req.headers.cookie).sid, PASSWORD, 'tbr.');
const authedAdmin = req => !ADMIN_PASSWORD || checkToken(parseCookies(req.headers.cookie).adm, ADMIN_PASSWORD, 'adm.');
function pwMatch(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Pages --------------------------------------------------------------------
const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>TB RACER</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{height:100vh;display:flex;align-items:center;justify-content:center;background:#07070a;font-family:system-ui,-apple-system,sans-serif;color:#eee;overflow:hidden}
body::before{content:"";position:fixed;inset:0;background:repeating-linear-gradient(115deg,transparent 0 26px,rgba(225,6,0,.05) 26px 30px)}
body::after{content:"";position:fixed;left:-10%;top:58%;width:120%;height:3px;background:linear-gradient(90deg,transparent,#e10600 30%,#e10600 70%,transparent);transform:rotate(-6deg);opacity:.5}
.card{position:relative;z-index:2;width:380px;padding:38px 40px;background:#0f0f15;border:1px solid #23232d;border-left:5px solid #e10600;clip-path:polygon(0 0,100% 0,100% calc(100% - 28px),calc(100% - 28px) 100%,0 100%)}
.k{font-size:10px;letter-spacing:.4em;color:#e10600;font-weight:800}
h1{font-size:34px;font-weight:900;font-style:italic;letter-spacing:.02em;margin:4px 0 2px}
.sub{font-size:11px;letter-spacing:.28em;color:#7d7d8c;margin-bottom:26px}
input{width:100%;padding:13px 14px;background:#0a0a10;border:1px solid #26262f;border-left:3px solid #e10600;color:#fff;font-size:15px;outline:none;letter-spacing:.05em}
input:focus{border-color:#e10600}
button{width:100%;margin-top:16px;padding:14px;border:0;background:#e10600;color:#fff;font-size:14px;font-weight:800;font-style:italic;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;clip-path:polygon(12px 0,100% 0,calc(100% - 12px) 100%,0 100%)}
button:hover{background:#ff1a14}
.err{color:#ff5a55;font-size:12px;margin-bottom:12px;letter-spacing:.05em}
</style></head><body><form class="card" method="POST" action="/auth">
<div class="k">PRIVATE SESSION</div><h1>TB RACER</h1><div class="sub">GRAND PRIX · MULTIPLAYER</div>{{ERR}}
<input type="password" name="password" placeholder="ACCESS CODE" autofocus autocomplete="current-password">
<button>Enter the paddock</button></form></body></html>`;

const ADMIN_LOGIN_HTML = LOGIN_HTML
  .replace('action="/auth"', 'action="/admin/auth"')
  .replace('PRIVATE SESSION', 'RACE CONTROL')
  .replace('GRAND PRIX · MULTIPLAYER', 'ADMIN · RACE CONTROL')
  .replace('Enter the paddock', 'Open race control');

const ADMIN_DASH_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>TB RACER — Race Control</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;background:#07070a;font-family:system-ui,sans-serif;color:#e8e8ee;padding:34px}
.k{font-size:10px;letter-spacing:.4em;color:#e10600;font-weight:800}
h1{font-size:28px;font-weight:900;font-style:italic;margin:2px 0 22px}
table{width:100%;max-width:980px;border-collapse:collapse}
th{font-size:10px;letter-spacing:.2em;color:#7d7d8c;text-align:left;padding:8px 12px;border-bottom:1px solid #23232d}
td{padding:11px 12px;font-size:14px;border-bottom:1px solid #17171f}
tr:hover td{background:#0e0e15}
.state{font-size:11px;font-weight:800;letter-spacing:.1em;color:#ffd166}
.state.racing{color:#2ed573}
.pl{color:#a9a9b8;font-size:13px}
button{padding:7px 14px;border:0;background:#e10600;color:#fff;font-weight:800;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-style:italic;cursor:pointer;clip-path:polygon(7px 0,100% 0,calc(100% - 7px) 100%,0 100%)}
button:hover{background:#ff1a14}
.empty{color:#7d7d8c;padding:30px 12px;font-style:italic}
.meta{color:#55555f;font-size:11px;margin-top:16px}
</style></head><body>
<div class="k">RACE CONTROL</div><h1>TB RACER — Admin</h1>
<table><thead><tr><th>ROOM</th><th>STATE</th><th>PLAYERS</th><th>SIM LOOP</th><th></th></tr></thead>
<tbody id="rows"><tr><td class="empty" colspan="5">Loading…</td></tr></tbody></table>
<div class="meta">Auto-refreshes every 4s. Closing a room disconnects everyone in it and frees its compute.</div>
<script>
async function load(){
  try{
    const r = await fetch('/admin/api/rooms');
    const rooms = await r.json();
    const tb = document.getElementById('rows');
    if(!rooms.length){ tb.innerHTML = '<tr><td class="empty" colspan="5">No active rooms — nothing is using compute.</td></tr>'; return; }
    tb.innerHTML = rooms.map(x => '<tr><td><b>'+esc(x.room)+'</b></td>'+
      '<td><span class="state '+esc(x.state)+'">'+esc(x.state.toUpperCase())+'</span></td>'+
      '<td class="pl">'+(x.players.map(p=>esc(p.name)+(p.role==='spectator'?' 👀':'')).join(', ')||'—')+'</td>'+
      '<td class="pl">'+(x.ticking?'60Hz':'idle')+'</td>'+
      '<td><button onclick="kill(\\''+esc(x.room)+'\\')">Close room</button></td></tr>').join('');
  }catch(e){}
}
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function kill(room){
  if(!confirm('Close room "'+room+'" and disconnect everyone?')) return;
  await fetch('/admin/api/kill', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({room})});
  load();
}
setInterval(load, 4000); load();
</script></body></html>`;

// ---- Rooms ----------------------------------------------------------------------
const rooms = new Map(); // name -> { core, interval, sockets:Set }

function syncTick(name, r) {
  const need = r.core.needsTick;
  if (need && !r.interval) {
    r.interval = setInterval(() => {
      r.core.tick(Date.now());
      if (!r.core.needsTick) syncTick(name, r);
    }, 1000 / 60);
  } else if (!need && r.interval) {
    clearInterval(r.interval);
    r.interval = null;
  }
}

function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = { core: new RoomCore(name), interval: null, sockets: new Set() };
    rooms.set(name, r);
  }
  return r;
}

function roomsInfo() {
  return [...rooms.entries()].map(([name, r]) => ({
    room: name,
    state: r.core.game.state,
    players: [...r.core.players.values()].map(p => ({ name: p.name, role: p.role })),
    ticking: !!r.interval,
    ts: Date.now()
  }));
}

function killRoom(name) {
  const r = rooms.get(name);
  if (!r) return false;
  for (const ws of r.sockets) { try { ws.close(4000, 'Closed by admin'); } catch (e) {} }
  return true;
}

// ---- HTTP -----------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const PUB = path.join(__dirname, 'public');

function readBody(req) {
  return new Promise(res => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => res(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  // ---- admin (own auth, independent of the game password) ----
  if (p === '/admin/auth' && req.method === 'POST') {
    if (!ADMIN_PASSWORD) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    const pw = new URLSearchParams(await readBody(req)).get('password') || '';
    if (pwMatch(pw, ADMIN_PASSWORD)) {
      res.writeHead(302, {
        'Set-Cookie': `adm=${makeToken(ADMIN_PASSWORD, 'adm.')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        Location: '/admin'
      });
    } else {
      res.writeHead(302, { Location: '/admin?bad=1' });
    }
    return res.end();
  }
  if (p === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (authedAdmin(req)) return res.end(ADMIN_DASH_HTML);
    return res.end(ADMIN_LOGIN_HTML.replace('{{ERR}}', url.searchParams.get('bad') ? '<div class="err">Wrong admin password.</div>' : ''));
  }
  if (p === '/admin/api/rooms') {
    if (!authedAdmin(req)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(roomsInfo()));
  }
  if (p === '/admin/api/kill' && req.method === 'POST') {
    if (!authedAdmin(req)) { res.writeHead(401); return res.end(); }
    let room = '';
    try { room = JSON.parse(await readBody(req)).room || ''; } catch (e) {}
    const ok = killRoom(String(room));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }

  // ---- game password gate ----
  if (req.method === 'POST' && p === '/auth') {
    if (!PASSWORD) { res.writeHead(302, { Location: '/' }); return res.end(); }
    const pw = new URLSearchParams(await readBody(req)).get('password') || '';
    if (pwMatch(pw, PASSWORD)) {
      res.writeHead(302, {
        'Set-Cookie': `sid=${makeToken(PASSWORD, 'tbr.')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        Location: '/'
      });
    } else {
      res.writeHead(302, { Location: '/?bad=1' });
    }
    return res.end();
  }

  if (!authedGame(req)) {
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(LOGIN_HTML.replace('{{ERR}}', url.searchParams.get('bad') ? '<div class="err">Wrong access code. Try again.</div>' : ''));
    } else {
      res.writeHead(403); res.end('Forbidden');
    }
    return;
  }

  const rel = p === '/' ? 'index.html' : p.slice(1);
  const file = path.join(PUB, path.normalize(rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---- WebSocket ---------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, sock, head) => {
  if (!authedGame(req)) {
    sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    sock.destroy();
    return;
  }
  const m = new URL(req.url, 'http://x').pathname.match(/^\/ws\/([a-z0-9_-]{1,24})$/i);
  if (!m || m[1].toLowerCase() === '__registry') {
    sock.write('HTTP/1.1 404 Not Found\r\n\r\n');
    sock.destroy();
    return;
  }
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req, m[1].toLowerCase()));
});

wss.on('connection', (ws, req, roomName) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const r = getRoom(roomName);
  r.sockets.add(ws);
  const conn = { send: s => { if (ws.readyState === 1) ws.send(s); } };
  const ctx = r.core.onConnection(conn);
  ws.on('message', raw => {
    r.core.onMessage(ctx, raw);
    syncTick(roomName, r);
  });
  ws.on('close', () => {
    r.core.onClose(ctx);
    r.sockets.delete(ws);
    if (r.core.size === 0) {
      if (r.interval) clearInterval(r.interval);
      rooms.delete(roomName);
    } else {
      syncTick(roomName, r);
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
  console.log(`TB Racer running on http://localhost:${PORT} (admin at /admin)`);
});
