'use strict';
/* Transport-agnostic race room. Driven by the local Node server (server.js)
   and the Cloudflare Durable Object (worker.js). A connection is anything
   with a send(string) method. Call tick(now) at 60Hz while size > 0. */
const SH = require('../public/shared.js');

const DT = 1 / 60;
const SNAP_EVERY = 3; // broadcast every 3rd tick = 20Hz
const MAX_RACERS = 8;
const COLORS = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#e84393', '#00d2d3', '#f9ca24', '#a55eea'];

const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;

class RoomCore {
  constructor(name) {
    this.name = name;
    this.players = new Map();
    this.nextId = 1;
    this.tickNo = 0;
    this.game = { state: 'lobby', mode: 'contact', lapsTotal: 3, countdownEnd: 0, raceStart: 0, firstFinishAt: 0 };
  }

  get size() { return this.players.size; }

  hostId() {
    for (const id of this.players.keys()) return id;
    return null;
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      try { p.conn.send(s); } catch (e) { /* dead socket; close event cleans up */ }
    }
  }

  sendMeta() {
    if (this.onRoster) { try { this.onRoster(this); } catch (e) {} }
    this.broadcast({
      t: 'meta',
      room: this.name,
      state: this.game.state,
      mode: this.game.mode,
      laps: this.game.lapsTotal,
      host: this.hostId(),
      cd: this.game.countdownEnd,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, role: p.role, racing: !!p.car
      }))
    });
  }

  startRace(now) {
    const racers = [...this.players.values()].filter(p => p.role === 'racer').slice(0, MAX_RACERS);
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
    this.game.state = 'countdown';
    this.game.countdownEnd = now + 3500;
    this.game.firstFinishAt = 0;
    this.sendMeta();
  }

  rankCmp(a, b) {
    const af = a.finishTime !== null, bf = b.finishTime !== null;
    if (af && bf) return a.finishTime - b.finishTime;
    if (af) return -1;
    if (bf) return 1;
    return b.car.prog - a.car.prog;
  }

  endRace() {
    this.game.state = 'finished';
    this.game.finishedAt = Date.now();
    const racers = [...this.players.values()].filter(p => p.car);
    racers.sort(this.rankCmp);
    this.broadcast({
      t: 'results',
      list: racers.map(p => ({
        name: p.name, color: p.color,
        time: p.finishTime, best: p.bestLap, dnf: p.finishTime === null
      }))
    });
    this.sendMeta();
  }

  toLobby() {
    this.game.state = 'lobby';
    for (const p of this.players.values()) p.car = null;
    this.sendMeta();
  }

  onConnection(conn) {
    try { conn.send(JSON.stringify({ t: 'welcome', room: this.name })); } catch (e) {}
    return { conn, me: null };
  }

  onMessage(ctx, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const game = this.game;

    if (m.t === 'join' && !ctx.me) {
      const name = String(m.name || '').replace(/[^\w \-'.]/g, '').trim().slice(0, 16) || 'Racer ' + this.nextId;
      const role = m.role === 'spectator' ? 'spectator' : 'racer';
      const used = new Set([...this.players.values()].map(p => p.color));
      const color = COLORS.find(c => !used.has(c)) || COLORS[this.nextId % COLORS.length];
      ctx.me = {
        id: this.nextId++, conn: ctx.conn, name, color, role,
        input: { u: 0, d: 0, l: 0, r: 0, h: 0 }, lastSeq: 0,
        car: null, lapsDone: 0, bestLap: null, finishTime: null, lapStart: 0
      };
      this.players.set(ctx.me.id, ctx.me);
      try { ctx.conn.send(JSON.stringify({ t: 'you', id: ctx.me.id })); } catch (e) {}
      this.sendMeta();
      return;
    }
    const me = ctx.me;
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
        if (me.id === this.hostId() && game.state === 'lobby' && (m.mode === 'contact' || m.mode === 'nocontact')) {
          game.mode = m.mode; this.sendMeta();
        }
        break;
      case 'laps':
        if (me.id === this.hostId() && game.state === 'lobby') {
          const n = Math.round(Number(m.n));
          if (n >= 1 && n <= 10) { game.lapsTotal = n; this.sendMeta(); }
        }
        break;
      case 'role':
        if (m.role === 'racer' || m.role === 'spectator') {
          me.role = m.role;
          if (game.state === 'lobby') me.car = null;
          this.sendMeta();
        }
        break;
      case 'start':
        if (me.id === this.hostId() && game.state === 'lobby') this.startRace(Date.now());
        break;
      case 'lobby':
        if (me.id === this.hostId() && game.state === 'finished') this.toLobby();
        break;
      case 'ping':
        break;
    }
  }

  onClose(ctx) {
    if (!ctx.me) return;
    this.players.delete(ctx.me.id);
    ctx.me = null;
    if (this.players.size === 0) {
      this.game = { state: 'lobby', mode: 'contact', lapsTotal: 3, countdownEnd: 0, raceStart: 0, firstFinishAt: 0 };
    } else {
      if (this.game.state === 'racing') {
        const racers = [...this.players.values()].filter(p => p.car);
        if (racers.length === 0) this.toLobby();
      }
      this.sendMeta();
    }
  }

  // true while the room actually needs the 60Hz loop
  get needsTick() {
    return this.players.size > 0 && this.game.state !== 'lobby';
  }

  tick(now) {
    this.tickNo++;
    const game = this.game;

    // nobody clicked "back to lobby" — return automatically so the loop can stop
    if (game.state === 'finished' && game.finishedAt && now - game.finishedAt > 90000) {
      this.toLobby();
      return;
    }

    if (game.state === 'countdown' && now >= game.countdownEnd) {
      game.state = 'racing';
      game.raceStart = now;
      for (const p of this.players.values()) if (p.car) p.lapStart = now;
      this.sendMeta();
    }

    if (game.state === 'racing') {
      const racers = [...this.players.values()].filter(p => p.car);
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
            p.lapsDone = laps;
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
      if (allDone || timeout || racers.length === 0) this.endRace();
    }

    if (this.tickNo % SNAP_EVERY === 0 && (game.state === 'countdown' || game.state === 'racing' || game.state === 'finished')) {
      const racers = [...this.players.values()].filter(p => p.car);
      racers.sort(this.rankCmp);
      this.broadcast({
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
}

module.exports = { RoomCore };
