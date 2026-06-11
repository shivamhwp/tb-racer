/* Cloudflare Worker entry. Auth-gates everything (pages, assets, WebSockets)
   behind the access code below (override with the RACE_PASSWORD secret).
   Routes /ws/<room> to a Durable Object running the same RoomCore simulation
   as the local server, and exposes /admin (gated by the ADMIN_PASSWORD secret
   when set) with a live room registry + the ability to close rooms and free
   their compute. Deploy with: bunx wrangler deploy */
import { RoomCore } from './game/room.js';

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
<table><thead><tr><th>ROOM</th><th>STATE</th><th>PLAYERS</th><th>LAST SEEN</th><th></th></tr></thead>
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
      '<td class="pl">'+Math.max(0,Math.round((Date.now()-x.ts)/1000))+'s ago</td>'+
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

const enc = new TextEncoder();

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function makeToken(key, prefix) {
  const exp = Date.now() + 7 * 864e5;
  return exp + '.' + await hmacHex(key, prefix + exp);
}
async function checkToken(tok, key, prefix) {
  if (!tok) return false;
  const i = tok.indexOf('.');
  if (i < 1) return false;
  const exp = Number(tok.slice(0, i));
  if (!exp || exp < Date.now()) return false;
  const want = await hmacHex(key, prefix + exp);
  const a = await hmacHex('cmp', tok.slice(i + 1));
  const b = await hmacHex('cmp', want);
  return a === b;
}
async function pwMatch(a, b) {
  return (await hmacHex('cmp', a)) === (await hmacHex('cmp', b));
}
function getCookie(req, name) {
  for (const p of (req.headers.get('Cookie') || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === name) return p.slice(i + 1).trim();
  }
  return null;
}

const REGISTRY = '__registry';
const registryStub = env => env.ROOMS.get(env.ROOMS.idFromName(REGISTRY));

export class RaceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.core = null;
    this.interval = null;
    this.sockets = new Set();
  }

  syncTick() {
    const need = !!this.core && this.core.needsTick;
    if (need && this.interval === null) {
      this.interval = setInterval(() => {
        this.core.tick(Date.now());
        if (!this.core.needsTick) this.syncTick();
      }, 1000 / 60);
    } else if (!need && this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  report(core) {
    registryStub(this.env).fetch('https://do/registry/update', {
      method: 'POST',
      body: JSON.stringify({
        room: core.name,
        state: core.game.state,
        players: [...core.players.values()].map(p => ({ name: p.name, role: p.role })),
        ts: Date.now()
      })
    }).catch(() => {});
  }

  unreport(name) {
    registryStub(this.env).fetch('https://do/registry/remove', {
      method: 'POST',
      body: JSON.stringify({ room: name })
    }).catch(() => {});
  }

  async fetch(req) {
    const url = new URL(req.url);

    // ---- registry mode (the '__registry' instance only gets these paths) ----
    if (url.pathname === '/registry/update') {
      const d = await req.json();
      await this.state.storage.put('room:' + d.room, d);
      return new Response('ok');
    }
    if (url.pathname === '/registry/remove') {
      const d = await req.json();
      await this.state.storage.delete('room:' + d.room);
      return new Response('ok');
    }
    if (url.pathname === '/registry/list') {
      const map = await this.state.storage.list({ prefix: 'room:' });
      const out = [...map.values()].filter(r => Date.now() - r.ts < 24 * 3600e3);
      return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
    }

    // ---- admin: close this room ----
    if (url.pathname === '/admin/kill') {
      for (const ws of this.sockets) { try { ws.close(4000, 'Closed by admin'); } catch (e) {} }
      this.sockets.clear();
      if (this.interval !== null) { clearInterval(this.interval); this.interval = null; }
      if (this.core) this.unreport(this.core.name);
      this.core = null;
      return new Response('ok');
    }

    // ---- game websocket ----
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const room = url.pathname.match(/^\/ws\/([a-z0-9_-]{1,24})$/i);
    if (!this.core) {
      this.core = new RoomCore(room ? room[1].toLowerCase() : 'paddock');
      this.core.onRoster = c => this.report(c);
    }
    const core = this.core;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);

    const conn = { send: s => { try { server.send(s); } catch (e) {} } };
    const ctx = core.onConnection(conn);
    const bye = () => {
      core.onClose(ctx);
      this.sockets.delete(server);
      if (core.size === 0) {
        this.unreport(core.name);
        if (this.core === core) this.syncTick();
      } else if (this.core === core) {
        this.syncTick();
      }
    };
    server.addEventListener('message', e => {
      core.onMessage(ctx, e.data);
      if (this.core === core) this.syncTick();
    });
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    // The site is password-gated; the default access code lives here in the
    // code (override with the RACE_PASSWORD secret). /admin is open unless
    // the ADMIN_PASSWORD secret is set.
    const pw = env.RACE_PASSWORD || 'theolovesobsidian';
    const apw = env.ADMIN_PASSWORD || '';

    if (p === '/favicon.ico') return new Response(null, { status: 204 });

    // ---- admin (own auth) ----
    if (p === '/admin/auth' && req.method === 'POST') {
      if (!apw) return new Response(null, { status: 302, headers: { Location: '/admin' } });
      const attempt = new URLSearchParams(await req.text()).get('password') || '';
      if (await pwMatch(attempt, apw)) {
        return new Response(null, {
          status: 302,
          headers: {
            'Set-Cookie': `adm=${await makeToken(apw, 'adm.')}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`,
            Location: '/admin'
          }
        });
      }
      return new Response(null, { status: 302, headers: { Location: '/admin?bad=1' } });
    }
    if (p === '/admin') {
      const ok = !apw || await checkToken(getCookie(req, 'adm'), apw, 'adm.');
      return new Response(
        ok ? ADMIN_DASH_HTML : ADMIN_LOGIN_HTML.replace('{{ERR}}', url.searchParams.get('bad') ? '<div class="err">Wrong admin password.</div>' : ''),
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    if (p.startsWith('/admin/api/')) {
      if (apw && !await checkToken(getCookie(req, 'adm'), apw, 'adm.')) return new Response('Unauthorized', { status: 401 });
      if (p === '/admin/api/rooms') {
        return registryStub(env).fetch('https://do/registry/list');
      }
      if (p === '/admin/api/kill' && req.method === 'POST') {
        let room = '';
        try { room = String((await req.json()).room || ''); } catch (e) {}
        if (!/^[a-z0-9_-]{1,24}$/i.test(room) || room.toLowerCase() === REGISTRY) {
          return new Response(JSON.stringify({ ok: false }), { headers: { 'Content-Type': 'application/json' } });
        }
        await env.ROOMS.get(env.ROOMS.idFromName(room.toLowerCase())).fetch('https://do/admin/kill', { method: 'POST' });
        await registryStub(env).fetch('https://do/registry/remove', { method: 'POST', body: JSON.stringify({ room: room.toLowerCase() }) });
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    }

    // ---- game password gate ----
    if (req.method === 'POST' && p === '/auth') {
      if (!pw) return new Response(null, { status: 302, headers: { Location: '/' } });
      const attempt = new URLSearchParams(await req.text()).get('password') || '';
      if (await pwMatch(attempt, pw)) {
        return new Response(null, {
          status: 302,
          headers: {
            'Set-Cookie': `sid=${await makeToken(pw, 'tbr.')}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`,
            Location: '/'
          }
        });
      }
      return new Response(null, { status: 302, headers: { Location: '/?bad=1' } });
    }

    const authed = !pw || await checkToken(getCookie(req, 'sid'), pw, 'tbr.');
    if (!authed) {
      if (p === '/') {
        return new Response(
          LOGIN_HTML.replace('{{ERR}}', url.searchParams.get('bad') ? '<div class="err">Wrong access code. Try again.</div>' : ''),
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
      return new Response('Forbidden', { status: 403 });
    }

    const ws = p.match(/^\/ws\/([a-z0-9_-]{1,24})$/i);
    if (ws) {
      const name = ws[1].toLowerCase();
      if (name === REGISTRY) return new Response('Not found', { status: 404 });
      return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(req);
    }

    return env.ASSETS.fetch(req);
  }
};
