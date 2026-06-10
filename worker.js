/* Cloudflare Worker entry. Auth-gates everything (pages, assets, WebSockets),
   then routes /ws/<room> to a Durable Object running the same RoomCore
   simulation as the local server. Deploy with: bunx wrangler deploy */
import { RoomCore } from './game/room.js';

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

const enc = new TextEncoder();

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function makeToken(pw) {
  const exp = Date.now() + 7 * 864e5;
  return exp + '.' + await hmacHex(pw, 'tbr.' + exp);
}
async function checkToken(tok, pw) {
  if (!tok) return false;
  const i = tok.indexOf('.');
  if (i < 1) return false;
  const exp = Number(tok.slice(0, i));
  if (!exp || exp < Date.now()) return false;
  const want = await hmacHex(pw, 'tbr.' + exp);
  // compare digests of both sides so the comparison is constant-time-ish
  const a = await hmacHex('cmp', tok.slice(i + 1));
  const b = await hmacHex('cmp', want);
  return a === b;
}
function getCookie(req, name) {
  for (const p of (req.headers.get('Cookie') || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === name) return p.slice(i + 1).trim();
  }
  return null;
}

export class RaceRoom {
  constructor(state, env) {
    this.core = null;
    this.interval = null;
  }

  fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const room = new URL(req.url).pathname.match(/^\/ws\/([a-z0-9_-]{1,24})$/i);
    if (!this.core) this.core = new RoomCore(room ? room[1].toLowerCase() : 'paddock');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const conn = { send: s => { try { server.send(s); } catch (e) {} } };
    const ctx = this.core.onConnection(conn);
    const bye = () => {
      this.core.onClose(ctx);
      if (this.core.size === 0 && this.interval !== null) {
        clearInterval(this.interval);
        this.interval = null;
      }
    };
    server.addEventListener('message', e => this.core.onMessage(ctx, e.data));
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);

    if (this.interval === null) {
      this.interval = setInterval(() => this.core.tick(Date.now()), 1000 / 60);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const pw = env.RACE_PASSWORD || 'theolovesobsidian';

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    if (req.method === 'POST' && url.pathname === '/auth') {
      const body = await req.text();
      const attempt = new URLSearchParams(body).get('password') || '';
      const ok = (await hmacHex('cmp', attempt)) === (await hmacHex('cmp', pw));
      if (ok) {
        return new Response(null, {
          status: 302,
          headers: {
            'Set-Cookie': `sid=${await makeToken(pw)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800`,
            Location: '/'
          }
        });
      }
      return new Response(null, { status: 302, headers: { Location: '/?bad=1' } });
    }

    const authed = await checkToken(getCookie(req, 'sid'), pw);
    if (!authed) {
      if (url.pathname === '/') {
        return new Response(
          LOGIN_HTML.replace('{{ERR}}', url.searchParams.get('bad') ? '<div class="err">Wrong password. Try again.</div>' : ''),
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
      return new Response('Forbidden', { status: 403 });
    }

    const ws = url.pathname.match(/^\/ws\/([a-z0-9_-]{1,24})$/i);
    if (ws) {
      const id = env.ROOMS.idFromName(ws[1].toLowerCase());
      return env.ROOMS.get(id).fetch(req);
    }

    return env.ASSETS.fetch(req);
  }
};
