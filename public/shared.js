/* Shared track + car physics. Runs identically on the Node server (authoritative
   simulation) and in the browser (client-side prediction). */
(function (S) {
  'use strict';

  // ---- Track: F1-style circuit ------------------------------------------------
  // Long main straight into a heavy-braking T1, esses, top straight with a
  // chicane, then an infield loop back onto the start/finish straight.
  const SCALE = 1.13;
  const PTS = [
    [500, 2500], [1600, 2550], [2900, 2550], [3700, 2450],  // main straight + kink
    [4050, 2100], [3950, 1700],                              // T1-T2 complex
    [3600, 1500], [3750, 1150], [3500, 850],                 // esses
    [3850, 600], [3400, 330],                                // top-right sweep
    [2400, 300], [1500, 340],                                // back straight
    [1100, 520], [800, 330],                                 // chicane
    [400, 450], [300, 850], [450, 1250],                     // left side
    [900, 1400], [1300, 1300], [1500, 1600],                 // infield loop
    [1150, 1900], [650, 1950], [350, 2200]                   // final corner
  ].map(p => [p[0] * SCALE, p[1] * SCALE]);
  const PER = 40;            // samples per control point
  const HALF_W = 88;         // half road width (px) — very wide, fits 4 cars abreast
  const WORLD = { w: 5000, h: 3300 };

  function cr(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  const SAM = [];
  for (let i = 0; i < PTS.length; i++) {
    const p0 = PTS[(i - 1 + PTS.length) % PTS.length];
    const p1 = PTS[i];
    const p2 = PTS[(i + 1) % PTS.length];
    const p3 = PTS[(i + 2) % PTS.length];
    for (let j = 0; j < PER; j++) {
      const t = j / PER;
      SAM.push({ x: cr(p0[0], p1[0], p2[0], p3[0], t), y: cr(p0[1], p1[1], p2[1], p3[1], t) });
    }
  }
  const N = SAM.length;
  for (let i = 0; i < N; i++) {
    const a = SAM[i], b = SAM[(i + 1) % N];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    a.dx = dx / l; a.dy = dy / l;
  }

  function d2seg(px, py, i) {
    const a = SAM[i], b = SAM[(i + 1) % N];
    const abx = b.x - a.x, aby = b.y - a.y;
    let t = ((px - a.x) * abx + (py - a.y) * aby) / (abx * abx + aby * aby || 1);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (a.x + abx * t), dy = py - (a.y + aby * t);
    return dx * dx + dy * dy;
  }

  // Nearest centerline segment. `hint` (previous index) makes this O(window).
  function nearestIdx(px, py, hint, win) {
    let best = -1, bd = Infinity;
    if (hint >= 0 && win > 0) {
      for (let o = -win; o <= win; o++) {
        const i = (hint + o + N) % N;
        const d = d2seg(px, py, i);
        if (d < bd) { bd = d; best = i; }
      }
      if (bd < (HALF_W * 4) * (HALF_W * 4)) return { i: best, d2: bd };
    }
    best = -1; bd = Infinity;
    for (let i = 0; i < N; i += 2) {
      const d = d2seg(px, py, i);
      if (d < bd) { bd = d; best = i; }
    }
    for (let o = -2; o <= 2; o++) {
      const i = (best + o + N) % N;
      const d = d2seg(px, py, i);
      if (d < bd) { bd = d; best = i; }
    }
    return { i: best, d2: bd };
  }

  // ---- Car physics ----------------------------------------------------------
  const CFG = {
    engine: 980,      // forward accel (px/s^2)
    reverse: 360,
    brake: 1600,
    dragK: 0.0023,    // quadratic aero drag
    rollK: 1.5,       // rolling resistance
    grip: 9.0,        // lateral tyre grip on tarmac
    gripHand: 2.4,    // grip with handbrake (drift)
    grassGrip: 3.4,
    grassDrag: 3.2,
    steer: 2.7,       // base steering rate (rad/s)
    carR: 13,         // collision radius
    maxRev: 150
  };

  function makeCar(x, y, angle, idx) {
    return {
      x, y, angle, vx: 0, vy: 0, steer: 0,
      idx: idx || 0, prog: idx || 0, frozen: 0,
      finished: false, onTrack: true, slip: 0
    };
  }

  // input: {u,d,l,r,h} booleans (up/down/left/right/handbrake)
  function stepCar(c, inp, dt) {
    const target = (inp.l ? -1 : 0) + (inp.r ? 1 : 0);
    c.steer += (target - c.steer) * Math.min(1, 12 * dt);

    const cos = Math.cos(c.angle), sin = Math.sin(c.angle);
    let vF = c.vx * cos + c.vy * sin;          // forward speed
    let vL = -c.vx * sin + c.vy * cos;         // lateral speed

    const near = nearestIdx(c.x, c.y, c.idx, 30);
    c.idx = near.i;
    const onT = near.d2 < HALF_W * HALF_W;
    c.onTrack = onT;

    let aF = 0;
    if (inp.u) aF += CFG.engine * (onT ? 1 : 0.5);
    if (inp.d) aF -= (vF > 20 ? CFG.brake : CFG.reverse);
    aF -= CFG.dragK * vF * Math.abs(vF) + CFG.rollK * vF + (onT ? 0 : CFG.grassDrag * vF);
    vF += aF * dt;
    if (vF < -CFG.maxRev) vF = -CFG.maxRev;

    const speedFac = Math.min(1, Math.abs(vF) / 90);   // no steering at standstill
    const highSpd = 1 / (1 + Math.abs(vF) / 500);      // tighter wheel at speed
    c.angle += c.steer * CFG.steer * speedFac * highSpd * (vF < 0 ? -1 : 1) * dt;

    let grip = onT ? (inp.h ? CFG.gripHand : CFG.grip) : CFG.grassGrip;
    if (inp.h && onT) vF -= vF * 1.1 * dt;
    vL *= Math.exp(-grip * dt);

    const c2 = Math.cos(c.angle), s2 = Math.sin(c.angle);
    c.vx = vF * c2 - vL * s2;
    c.vy = vF * s2 + vL * c2;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    if (c.x < 20) { c.x = 20; c.vx = Math.abs(c.vx) * 0.3; }
    if (c.y < 20) { c.y = 20; c.vy = Math.abs(c.vy) * 0.3; }
    if (c.x > WORLD.w - 20) { c.x = WORLD.w - 20; c.vx = -Math.abs(c.vx) * 0.3; }
    if (c.y > WORLD.h - 20) { c.y = WORLD.h - 20; c.vy = -Math.abs(c.vy) * 0.3; }
    c.slip = Math.abs(vL);
  }

  // Monotonic progress along the track (laps = floor(prog / N)). Large jumps
  // (corner cutting across the infield) freeze progress; after 3s the car is
  // resynced to wherever it actually is.
  function updateProgress(c) {
    const last = ((Math.round(c.prog) % N) + N) % N;
    let d = c.idx - last;
    if (d > N / 2) d -= N;
    if (d < -N / 2) d += N;
    if (Math.abs(d) < 80) {
      c.prog += d;
      c.frozen = 0;
    } else if (++c.frozen > 180) {
      c.prog += d;
      c.frozen = 0;
    }
    return Math.floor(c.prog / N);
  }

  function collideCars(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    let d = Math.hypot(dx, dy);
    const R = CFG.carR * 2;
    if (d >= R) return false;
    if (d < 0.01) d = 0.01;
    const nx = dx / d, ny = dy / d, ov = (R - d) / 2;
    a.x -= nx * ov; a.y -= ny * ov;
    b.x += nx * ov; b.y += ny * ov;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < 0) {
      const j = -(1 + 0.4) * vn / 2;
      a.vx -= j * nx; a.vy -= j * ny;
      b.vx += j * nx; b.vy += j * ny;
    }
    return true;
  }

  // Starting grid: 4 cars abreast, 2 rows — everyone starts together at the
  // line (lap 1 counts after a full circuit).
  function gridPose(slot) {
    const row = Math.floor(slot / 4);
    const col = slot % 4;
    const i = (16 + row * 3 + (col % 2)) % N; // tiny stagger within the row
    const s = SAM[i];
    const side = (col - 1.5) * 38; // -57, -19, +19, +57 across the road
    return {
      x: s.x - s.dy * side,
      y: s.y + s.dx * side,
      angle: Math.atan2(s.dy, s.dx),
      idx: i
    };
  }

  S.TRACK = { SAM, N, HALF_W, WORLD };
  S.CFG = CFG;
  S.makeCar = makeCar;
  S.stepCar = stepCar;
  S.updateProgress = updateProgress;
  S.collideCars = collideCars;
  S.gridPose = gridPose;
  S.nearestIdx = nearestIdx;
})(typeof module !== 'undefined' ? module.exports : (window.SHARED = {}));
