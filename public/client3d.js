import * as THREE from 'three';

const S = window.SHARED;
const { SAM, N, HALF_W, WORLD } = S.TRACK;
const DT = 1 / 60;
const INTERP_DELAY = 120;   // ms behind server for remote cars
const REMOTE_ALPHA = 0.45;  // other players' cars are translucent

// ---- DOM ----
const $ = id => document.getElementById(id);
const canvas = $('game');
const mini = $('minimap'), mctx = mini.getContext('2d');
const ui = {
  hud: $('hud'), speed: $('speedVal'), lap: $('lapVal'), pos: $('posVal'),
  mode: $('modeBadge'), banner: $('banner'), countdown: $('countdown'),
  join: $('join'), name: $('nameInput'), room: $('roomInput'), joinRacer: $('joinRacer'), joinSpec: $('joinSpec'),
  lobby: $('lobby'), lobbyTitle: $('lobbyTitle'), playerList: $('playerList'), modeSeg: $('modeSeg'), lapsSeg: $('lapsSeg'),
  roleBtn: $('roleBtn'), startBtn: $('startBtn'), lobbyHint: $('lobbyHint'),
  results: $('results'), resultsList: $('resultsList'), lobbyBtn: $('lobbyBtn'), resultsHint: $('resultsHint'),
  fsBtn: $('fsBtn'), muteBtn: $('muteBtn'), camBtn: $('camBtn'), leaveBtn: $('leaveBtn'),
  confirmOverlay: $('confirmOverlay'), confirmStay: $('confirmStay'), confirmLeave: $('confirmLeave'),
  curLapT: $('curLapT'), lastLapT: $('lastLapT'), bestLapT: $('bestLapT'), lapFlash: $('lapFlash')
};

// ---- State ----
let ws = null, myId = null, myRole = null, myRoom = 'paddock';
let meta = { state: 'lobby', mode: 'contact', laps: 3, host: null, players: [] };
let snaps = [], latest = null;
let timeOffset = 0, haveOffset = false;
let myCar = null, pending = [], seq = 0;
let myPrev = null; // own-car state before the latest physics step, for render interpolation
let errX = 0, errY = 0, errA = 0;
let keys = { u: 0, d: 0, l: 0, r: 0, h: 0 };
let racing = false;
let camMode = 0; // 0 chase, 1 close, 2 high
let lapStartSrv = 0, myLastLap = null, myBestLap = null; // live lap timing (server clock)

// ---- Helpers ----
const wrapAng = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAng = (a, b, t) => a + wrapAng(b - a) * t;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function fmt(ms) {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, t = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
}
let rngS = 1337;
const rng = () => (rngS = (rngS * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ============================================================ THREE SETUP
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const SKY = 0xaecbe8;
scene.fog = new THREE.Fog(0xbcd4ea, 1100, 3400);

const camera = new THREE.PerspectiveCamera(62, 1, 1, 6000);
camera.position.set(WORLD.w / 2, 400, WORLD.h / 2 + 600);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// lights
const hemi = new THREE.HemisphereLight(0xcfe5ff, 0x3d6b3a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
sun.position.set(500, 800, 300);
sun.castShadow = true;
sun.shadow.mapSize.set(1536, 1536);
sun.shadow.camera.near = 100;
sun.shadow.camera.far = 2500;
const SHADOW_R = 420;
sun.shadow.camera.left = -SHADOW_R; sun.shadow.camera.right = SHADOW_R;
sun.shadow.camera.top = SHADOW_R; sun.shadow.camera.bottom = -SHADOW_R;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

// ---- texture helpers ----
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  return t;
}

// sky dome (gradient, unaffected by fog)
{
  const skyTex = canvasTex(16, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#3f7fd4');
    gr.addColorStop(0.55, '#9cc3ec');
    gr.addColorStop(0.78, '#d8e8f6');
    gr.addColorStop(1, '#e8f0ea');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(4500, 24, 12),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  sky.position.set(WORLD.w / 2, 0, WORLD.h / 2);
  sky.renderOrder = -10;
  scene.add(sky);
  // sun glow sprite
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: canvasTex(128, 128, (g) => {
      const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,250,225,1)');
      gr.addColorStop(0.25, 'rgba(255,240,190,0.55)');
      gr.addColorStop(1, 'rgba(255,240,190,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    }), fog: false, depthWrite: false, transparent: true
  }));
  glow.scale.set(900, 900, 1);
  glow.position.set(WORLD.w / 2 + 1600, 1900, WORLD.h / 2 + 950);
  scene.add(glow);
  // clouds
  const cloudMat = new THREE.SpriteMaterial({
    map: canvasTex(256, 128, (g) => {
      g.clearRect(0, 0, 256, 128);
      for (let i = 0; i < 14; i++) {
        const x = 40 + Math.random() * 176, y = 50 + Math.random() * 36, r = 18 + Math.random() * 26;
        const gr = g.createRadialGradient(x, y, 2, x, y, r);
        gr.addColorStop(0, 'rgba(255,255,255,0.85)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      }
    }), transparent: true, fog: false, depthWrite: false, opacity: 0.85
  });
  for (let i = 0; i < 10; i++) {
    const cl = new THREE.Sprite(cloudMat);
    const a = rng() * Math.PI * 2, r = 900 + rng() * 1800;
    cl.position.set(WORLD.w / 2 + Math.cos(a) * r, 650 + rng() * 350, WORLD.h / 2 + Math.sin(a) * r);
    cl.scale.set(700 + rng() * 500, 280 + rng() * 160, 1);
    scene.add(cl);
  }
}

// ============================================================ WORLD BUILD
const worldGroup = new THREE.Group();
scene.add(worldGroup);

// ground
{
  const grassTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#41834c'; g.fillRect(0, 0, w, h);
    // mowing stripes, like a groomed F1 venue
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, 0, w / 2, h);
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = `rgba(${20 + Math.random() * 40 | 0},${90 + Math.random() * 60 | 0},${30 + Math.random() * 40 | 0},0.25)`;
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
  }, true);
  grassTex.repeat.set(60, 60);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000),
    new THREE.MeshStandardMaterial({ map: grassTex, color: 0xffffff, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(WORLD.w / 2, 0, WORLD.h / 2);
  ground.receiveShadow = true;
  worldGroup.add(ground);
}

// ensure every triangle of a flat ribbon faces up (+Y) so lighting is correct
function windUp(pos, idx) {
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const abx = pos[b] - pos[a], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acz = pos[c + 2] - pos[a + 2];
    if (abz * acx - abx * acz < 0) { // cross((B-A),(C-A)).y < 0 → faces down
      const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t;
    }
  }
}

// segment lengths + curvature
const segLen = [], curva = [];
for (let i = 0; i < N; i++) {
  const a = SAM[i], b = SAM[(i + 1) % N];
  segLen.push(Math.hypot(b.x - a.x, b.y - a.y));
  const c = SAM[(i + 6) % N];
  curva.push(Math.abs(wrapAng(Math.atan2(c.dy, c.dx) - Math.atan2(a.dy, a.dx))));
}

// road ribbon
{
  const roadTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#3c3c44'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const v = Math.random();
      g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.10)';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    // edge lines only — F1 circuits have no centerline
    g.fillStyle = 'rgba(245,245,245,0.85)';
    g.fillRect(6, 0, 5, h);
    g.fillRect(w - 11, 0, 5, h);
  }, true);

  const pos = [], nor = [], uv = [], idx = [];
  let v = 0;
  for (let i = 0; i <= N; i++) {
    const s = SAM[i % N];
    const nx = -s.dy, ny = s.dx;
    pos.push(s.x + nx * HALF_W, 0.22, s.y + ny * HALF_W, s.x - nx * HALF_W, 0.22, s.y - ny * HALF_W);
    nor.push(0, 1, 0, 0, 1, 0);
    uv.push(0, v, 1, v);
    v += segLen[i % N] / 130;
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  windUp(pos, idx);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: roadTex, roughness: 0.93, metalness: 0, side: THREE.DoubleSide
  }));
  road.receiveShadow = true;
  worldGroup.add(road);
}

// kerbs on curves
{
  const kerbTex = canvasTex(64, 64, (g) => {
    g.fillStyle = '#e23d3d'; g.fillRect(0, 0, 64, 32);
    g.fillStyle = '#f3f3f3'; g.fillRect(0, 32, 64, 32);
  }, true);
  const mk = (side) => {
    const pos = [], nor = [], uv = [], idx = [];
    let v = 0, quad = 0;
    for (let i = 0; i < N; i++) {
      if (curva[i] < 0.055) { v = 0; continue; }
      const s = SAM[i], s2 = SAM[(i + 1) % N];
      for (const [p, vv] of [[s, v], [s2, v + segLen[i] / 14]]) {
        const nx = -p.dy * side, ny = p.dx * side;
        pos.push(p.x + nx * (HALF_W - 2), 0.34, p.y + ny * (HALF_W - 2),
          p.x + nx * (HALF_W + 7), 0.34, p.y + ny * (HALF_W + 7));
        nor.push(0, 1, 0, 0, 1, 0);
        uv.push(0, vv, 1, vv);
      }
      const a = quad * 4;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      quad++;
      v += segLen[i] / 14;
    }
    windUp(pos, idx);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.85, side: THREE.DoubleSide }));
    m.receiveShadow = true;
    worldGroup.add(m);
  };
  mk(1); mk(-1);
}

// start line + gantry
{
  const s0 = SAM[0];
  const yaw = -Math.atan2(s0.dy, s0.dx);
  const checker = canvasTex(64, 64, (g) => {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      g.fillStyle = (r + c) % 2 ? '#101010' : '#f2f2f2';
      g.fillRect(c * 16, r * 16, 16, 16);
    }
  }, true);
  checker.repeat.set(1, HALF_W / 10);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(20, HALF_W * 2), new THREE.MeshStandardMaterial({ map: checker, roughness: 0.9 }));
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = yaw;
  line.position.set(s0.x, 0.3, s0.y);
  line.receiveShadow = true;
  worldGroup.add(line);

  const gantry = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.5, metalness: 0.6 });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 55, 10), postMat);
    post.position.set(0, 27.5, side * (HALF_W + 12));
    post.castShadow = true;
    gantry.add(post);
  }
  const bannerTex = canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = '#11151f'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffd166';
    g.font = '900 56px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('★  TB RACER  ★', w / 2, h / 2);
  });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(4, 16, HALF_W * 2 + 30),
    new THREE.MeshStandardMaterial({ color: 0x222838, roughness: 0.6 }));
  beam.position.y = 55;
  beam.castShadow = true;
  gantry.add(beam);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2 + 30, 16),
    new THREE.MeshBasicMaterial({ map: bannerTex }));
  face.rotation.y = Math.PI / 2;
  face.position.set(-2.2, 55, 0);
  gantry.add(face);
  const face2 = face.clone();
  face2.rotation.y = -Math.PI / 2;
  face2.position.x = 2.2;
  gantry.add(face2);
  // F1 start-light pods under the beam
  const podMat = new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x3a0a0a, emissive: 0xff2020, emissiveIntensity: 1.6 });
  for (let k = -2; k <= 2; k++) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(3, 9, 5), podMat);
    pod.position.set(0, 42.5, k * 12);
    gantry.add(pod);
    for (const ly of [40.5, 44.5]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.4, 2.6), lampMat);
      lamp.position.set(0, ly, k * 12);
      gantry.add(lamp);
    }
  }
  gantry.position.set(s0.x, 0, s0.y);
  gantry.rotation.y = yaw;
  worldGroup.add(gantry);

  // painted grid boxes for the starting slots
  const gridTex = canvasTex(96, 72, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(w - 6, 6); g.lineTo(6, 6); g.lineTo(6, h - 6); g.lineTo(w - 6, h - 6); // open toward +u (forward)
    g.stroke();
  });
  for (let slot = 0; slot < 8; slot++) {
    const gp = S.gridPose(slot);
    const box = new THREE.Mesh(new THREE.PlaneGeometry(40, 30),
      new THREE.MeshBasicMaterial({ map: gridTex, transparent: true, depthWrite: false }));
    box.rotation.set(-Math.PI / 2, 0, -gp.angle, 'YXZ');
    box.position.set(gp.x, 0.28, gp.y);
    worldGroup.add(box);
  }
}

// billboards along straights — paddock gossip, immortalized in sponsor vinyl
{
  const texts = [
    'TB GRAND PRIX',
    'THEO ♥ ANTHROPIC',
    'BEN LOVES REACT',
    'MARIA IS BAD AT TWITTER',
    "ALYSSA PAYS ME — CAN'T SAY MUCH 😨",
    'PHASE IS JUST THE GOAT 🐐',
    'MUNDAYS · THAT MAJESTIC HAIR',
    'DRS ZONE'
  ];
  let placed = 0, lastBB = -1e9;
  for (let i = 0; i < N && placed < texts.length; i++) {
    if (curva[i] > 0.03 || i - lastBB < 50) continue;
    lastBB = i;
    const s = SAM[i];
    const side = placed % 2 ? 1 : -1;
    const nx = -s.dy * side, ny = s.dx * side;
    const bb = new THREE.Group();
    const text = texts[placed];
    const tex = canvasTex(1024, 256, (g, w, h) => {
      g.fillStyle = ['#0e3e8e', '#7c2d8e', '#0e6e4e', '#8e2d2d'][placed % 4];
      g.fillRect(0, 0, w, h);
      // diagonal racing slash for a bit of livery flair
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.beginPath();
      g.moveTo(40, h); g.lineTo(190, 0); g.lineTo(260, 0); g.lineTo(110, h);
      g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 12; g.strokeRect(14, 14, w - 28, h - 28);
      g.fillStyle = '#fff';
      let size = 92;
      g.font = `italic 900 ${size}px system-ui, sans-serif`;
      while (g.measureText(text).width > w - 90 && size > 30) {
        size -= 4;
        g.font = `italic 900 ${size}px system-ui, sans-serif`;
      }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 4);
    });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(120, 30), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 }));
    board.position.y = 27;
    board.castShadow = true;
    bb.add(board);
    for (const o of [-44, 44]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 27, 8), new THREE.MeshStandardMaterial({ color: 0x444a55 }));
      leg.position.set(o, 13.5, -1);
      bb.add(leg);
    }
    bb.position.set(s.x + nx * (HALF_W + 55), 0, s.y + ny * (HALF_W + 55));
    bb.lookAt(s.x, 27, s.y);
    worldGroup.add(bb);
    placed++;
  }
}

// ---- F1 trackside: runoff paint, gravel traps, tyre stacks, grandstands, pits ----

// quad-strip beside the track. quads = array of [sampleIdx, side, offsetFrom, offsetTo]
function ribbonMesh(quads, color, y) {
  if (!quads.length) return;
  const pos = [], nor = [], idx = [];
  let q = 0;
  for (const [i, side, o1, o2] of quads) {
    const s = SAM[i], s2 = SAM[(i + 1) % N];
    for (const p of [s, s2]) {
      const nx = -p.dy * side, ny = p.dx * side;
      pos.push(p.x + nx * o1, y, p.y + ny * o1, p.x + nx * o2, y, p.y + ny * o2);
      nor.push(0, 1, 0, 0, 1, 0);
    }
    const a = q * 4;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    q++;
  }
  windUp(pos, idx);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.95, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  worldGroup.add(m);
}

// outside of a corner = the convex side
function outerSide(i) {
  const a = SAM[i], c = SAM[(i + 6) % N];
  return (a.dx * c.dy - a.dy * c.dx) > 0 ? -1 : 1;
}

{
  // painted runoff bands at every corner, gravel traps at the heavy ones
  const runoff = [], blue = [], red = [], gravel = [];
  for (let i = 0; i < N; i++) {
    if (curva[i] < 0.05) continue;
    for (const side of [1, -1]) {
      runoff.push([i, side, HALF_W + 7, HALF_W + 46]);
      blue.push([i, side, HALF_W + 46, HALF_W + 59]);
      red.push([i, side, HALF_W + 59, HALF_W + 72]);
    }
    if (curva[i] > 0.085) gravel.push([i, outerSide(i), HALF_W + 72, HALF_W + 135]);
  }
  ribbonMesh(runoff, 0x74767a, 0.16);
  ribbonMesh(blue, 0x1c54bd, 0.2);
  ribbonMesh(red, 0xc23434, 0.2);
  ribbonMesh(gravel, 0xc9b07e, 0.14);
}

{
  // tyre-stack barriers beyond the gravel at the big corners
  const spots = [];
  for (let i = 0; i < N && spots.length < 340; i += 2) {
    if (curva[i] < 0.085) continue;
    const side = outerSide(i);
    const s = SAM[i];
    const nx = -s.dy * side, ny = s.dx * side;
    spots.push([s.x + nx * (HALF_W + 160), s.y + ny * (HALF_W + 160)]);
  }
  if (spots.length) {
    const tyres = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(6, 6, 11, 9),
      new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.95 }), spots.length);
    const bands = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(6.15, 6.15, 3, 9),
      new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.8 }), spots.length);
    const m = new THREE.Matrix4();
    spots.forEach(([x, y], k) => {
      m.makeTranslation(x, 5.5, y); tyres.setMatrixAt(k, m);
      m.makeTranslation(x, 9, y); bands.setMatrixAt(k, m);
    });
    tyres.castShadow = true;
    worldGroup.add(tyres, bands);
  }
}

{
  // grandstands ringing the whole circuit, filled with empty chairs —
  // a grand prix venue with nobody in the seats
  const structMat = new THREE.MeshStandardMaterial({ color: 0x3a414e, roughness: 0.85 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x2b303a, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe2e6ec, roughness: 0.55, metalness: 0.35 });
  const standCols = [0xd23b3b, 0x2d63c8, 0xe0a32e, 0x3c9e57, 0x8a4fd0, 0x21a8a0];
  const cx0 = WORLD.w / 2, cy0 = WORLD.h / 2;
  const ROWS = 4, CHAIRS = 18, CHAIR_GAP = 12;
  const seatPos = [], seatCol = [];

  let last = -1e9, built = 0;
  for (let i = 0; i < N && built < 30; i++) {
    if (i - last < 38) continue;
    const s = SAM[i];
    // stands always sit on the outside of the circuit
    const side = ((-s.dy) * (s.x - cx0) + s.dx * (s.y - cy0)) > 0 ? 1 : -1;
    const nx = -s.dy * side, ny = s.dx * side;
    const sx = s.x + nx * (HALF_W + 195), sy = s.y + ny * (HALF_W + 195);
    if (sx < 90 || sy < 90 || sx > WORLD.w - 90 || sy > WORLD.h - 90) continue;
    if (S.nearestIdx(sx, sy, i, 140).d2 < (HALF_W + 165) * (HALF_W + 165)) continue;
    last = i; built++;

    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(224, 5, 80), structMat);
    base.position.set(0, 2.5, 33);
    g.add(base);
    for (let row = 0; row < ROWS; row++) {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(220, 6.5, 17), deckMat);
      deck.position.set(0, 5 + row * 6.5 + 3.25, row * 17);
      deck.castShadow = deck.receiveShadow = true;
      g.add(deck);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(230, 3, 88), roofMat);
    roof.position.set(0, 58, 31);
    roof.castShadow = true;
    g.add(roof);
    for (const ox of [-106, 106]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 56, 6), structMat);
      pole.position.set(ox, 28, 64);
      g.add(pole);
    }
    g.position.set(sx, 0, sy);
    g.rotation.y = -Math.atan2(ny, nx) + Math.PI / 2;
    worldGroup.add(g);

    // rows of empty chairs on the decks, one colour per stand
    const color = standCols[built % standCols.length];
    const yawQ = Math.atan2(nx, ny); // chair +Z points outward, so it faces the track
    for (let row = 0; row < ROWS; row++) {
      const deckTop = 5 + row * 6.5 + 6.5;
      for (let k = 0; k < CHAIRS; k++) {
        const along = (k - (CHAIRS - 1) / 2) * CHAIR_GAP;
        seatPos.push([
          sx + s.dx * along + nx * row * 17,
          deckTop,
          sy + s.dy * along + ny * row * 17,
          yawQ
        ]);
        seatCol.push(color);
      }
    }
  }

  if (seatPos.length) {
    const seatG = new THREE.BoxGeometry(8, 1.2, 5.5);
    seatG.translate(0, 0.6, -0.6);
    const backG = new THREE.BoxGeometry(8, 6, 1.2);
    backG.translate(0, 3, 2.6);
    const seats = new THREE.InstancedMesh(seatG, new THREE.MeshStandardMaterial({ roughness: 0.85 }), seatPos.length);
    const backs = new THREE.InstancedMesh(backG, new THREE.MeshStandardMaterial({ roughness: 0.85 }), seatPos.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    const col = new THREE.Color(), e = new THREE.Euler();
    seatPos.forEach(([x, y, z, yaw], k) => {
      e.set(0, yaw, 0);
      q.setFromEuler(e);
      v.set(x, y, z);
      m.compose(v, q, one);
      seats.setMatrixAt(k, m);
      backs.setMatrixAt(k, m);
      col.setHex(seatCol[k]).offsetHSL(0, 0, (rng() - 0.5) * 0.06);
      seats.setColorAt(k, col);
      backs.setColorAt(k, col);
    });
    worldGroup.add(seats, backs);
  }
}

{
  // pit complex along the main straight (inner side): pit lane, wall, building
  const i0 = 18, i1 = 104, side = -1;
  const P = (i, off) => {
    const s = SAM[i];
    return [s.x - s.dy * side * off, s.y + s.dx * side * off];
  };
  const lane = [];
  for (let i = i0; i < i1; i++) lane.push([i, side, HALF_W + 26, HALF_W + 96]);
  ribbonMesh(lane, 0x6c6e72, 0.15);

  const [x1, y1] = P(i0 + 2, HALF_W + 14), [x2, y2] = P(i1 - 2, HALF_W + 14);
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(Math.hypot(x2 - x1, y2 - y1), 7, 3),
    new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.7 }));
  wall.position.set((x1 + x2) / 2, 3.5, (y1 + y2) / 2);
  wall.rotation.y = -Math.atan2(y2 - y1, x2 - x1);
  wall.castShadow = true;
  worldGroup.add(wall);

  const [bx1, by1] = P(i0 + 8, HALF_W + 158), [bx2, by2] = P(i1 - 8, HALF_W + 158);
  const bl = Math.hypot(bx2 - bx1, by2 - by1);
  const bld = new THREE.Group();
  const main = new THREE.Mesh(new THREE.BoxGeometry(bl, 44, 92),
    new THREE.MeshStandardMaterial({ color: 0xbfc5cf, roughness: 0.6, metalness: 0.2 }));
  main.position.y = 22;
  main.castShadow = main.receiveShadow = true;
  bld.add(main);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(bl + 2, 10, 94),
    new THREE.MeshStandardMaterial({ color: 0x12202e, roughness: 0.1, metalness: 0.85 }));
  glass.position.y = 33;
  bld.add(glass);
  const front = canvasTex(1024, 128, (g, w, h) => {
    g.fillStyle = '#aab1bc'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#10151d';
    for (let d = 0; d < 11; d++) g.fillRect(24 + d * 92, 52, 64, 76);
    g.fillStyle = '#10151d'; g.fillRect(0, 0, w, 40);
    g.fillStyle = '#ffd166';
    g.font = '900 30px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('T B   G R A N D   P R I X   ·   P I T   L A N E', w / 2, 20);
  });
  for (const fz of [-47.5, 47.5]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(bl, 44), new THREE.MeshBasicMaterial({ map: front }));
    face.position.set(0, 22, fz);
    if (fz < 0) face.rotation.y = Math.PI;
    bld.add(face);
  }
  bld.position.set((bx1 + bx2) / 2, 0, (by1 + by2) / 2);
  bld.rotation.y = -Math.atan2(by2 - by1, bx2 - bx1);
  worldGroup.add(bld);
}

// ============================================================ SKIDS & SMOKE
const SKID_MAX = 1400;
const skids = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(5, 2.6),
  new THREE.MeshBasicMaterial({ color: 0x121214, transparent: true, opacity: 0.32, depthWrite: false }),
  SKID_MAX
);
skids.renderOrder = 1;
let skidHead = 0;
{
  const z = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SKID_MAX; i++) skids.setMatrixAt(i, z);
}
worldGroup.add(skids);
const skidM = new THREE.Matrix4(), skidQ = new THREE.Quaternion(), skidE = new THREE.Euler();
function dropSkid(x, y, angle) {
  skidE.set(-Math.PI / 2, 0, -angle, 'YXZ');
  skidQ.setFromEuler(skidE);
  skidM.compose(new THREE.Vector3(x, 0.28 + (skidHead % 7) * 0.004, y), skidQ, new THREE.Vector3(1, 1, 1));
  skids.setMatrixAt(skidHead % SKID_MAX, skidM);
  skidHead++;
  skids.instanceMatrix.needsUpdate = true;
}
function clearSkids() {
  const z = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SKID_MAX; i++) skids.setMatrixAt(i, z);
  skids.instanceMatrix.needsUpdate = true;
  skidHead = 0;
}

const smokeTex = canvasTex(64, 64, (g) => {
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  gr.addColorStop(0, 'rgba(255,255,255,0.65)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
});
const SMOKE_MAX = 130;
const smokePool = [];
for (let i = 0; i < SMOKE_MAX; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0, depthWrite: false }));
  sp.visible = false;
  sp.userData = { life: 0, vx: 0, vz: 0, grass: false };
  scene.add(sp);
  smokePool.push(sp);
}
let smokeHead = 0;
function puff(x, y, grass) {
  const sp = smokePool[smokeHead++ % SMOKE_MAX];
  sp.position.set(x, 3.5, y);
  sp.scale.set(7, 7, 1);
  sp.userData.life = 1;
  sp.userData.vx = (Math.random() - 0.5) * 26;
  sp.userData.vz = (Math.random() - 0.5) * 26;
  sp.userData.grass = grass;
  sp.material.color.setHex(grass ? 0x9a7a45 : 0xcfcfd4);
  sp.visible = true;
}
function updateSmoke(dt) {
  for (const sp of smokePool) {
    if (!sp.userData.life) continue;
    sp.userData.life -= dt * 1.5;
    if (sp.userData.life <= 0) { sp.userData.life = 0; sp.visible = false; continue; }
    sp.position.x += sp.userData.vx * dt;
    sp.position.z += sp.userData.vz * dt;
    sp.position.y += 9 * dt;
    const s = 7 + (1 - sp.userData.life) * 22;
    sp.scale.set(s, s, 1);
    sp.material.opacity = sp.userData.life * 0.42;
  }
}

// ============================================================ CARS
function carPaint(hex) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: 0.35, metalness: 0.55 });
}

// sponsor decal textures, shared across all cars
function sponsorTexture(text) {
  return canvasTex(256, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.font = 'italic 900 38px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 9; g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(text, w / 2, h / 2);
    g.fillStyle = '#ffffff';
    g.fillText(text, w / 2, h / 2);
  });
}
const SPONSOR_TEX = {
  nerd: sponsorTexture('NERD SNIPE'),
  theo: sponsorTexture('THEO'),
  ben: sponsorTexture('BEN'),
  alyssa: sponsorTexture('ALYSSA'),
  phase: sponsorTexture('PHASE')
};
function makeCarObj(colorHex, ghost, name) {
  const mats = [];
  const M = m => { mats.push(m); return m; };
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const paint = M(carPaint(colorHex));
  const carbon = M(new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.55, metalness: 0.35 }));
  const dark = M(new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.7, metalness: 0.2 }));

  // floor / plank
  const floor = new THREE.Mesh(new THREE.BoxGeometry(30, 1.2, 13), carbon);
  floor.position.set(-2, 2.2, 0);
  body.add(floor);

  // monocoque
  const mono = new THREE.Mesh(new THREE.BoxGeometry(17, 4, 7.5), paint);
  mono.position.set(1.5, 4.9, 0);
  mono.castShadow = true;
  body.add(mono);

  // pointed nose cone (tapered pyramid) + front wing
  const noseG = new THREE.CylinderGeometry(0.9, 3.1, 12, 4);
  noseG.rotateZ(-Math.PI / 2);
  noseG.rotateX(Math.PI / 4);
  const nose = new THREE.Mesh(noseG, paint);
  nose.position.set(14, 4.4, 0);
  nose.castShadow = true;
  body.add(nose);
  const fwing = new THREE.Mesh(new THREE.BoxGeometry(5, 0.9, 19), paint);
  fwing.position.set(17.5, 2.4, 0);
  body.add(fwing);
  for (const z of [-9.6, 9.6]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(5, 2.6, 0.8), carbon);
    ep.position.set(17.5, 3.4, z);
    body.add(ep);
  }

  // cockpit opening + driver helmet
  const pit = new THREE.Mesh(new THREE.BoxGeometry(7, 1.6, 5), dark);
  pit.position.set(1, 7, 0);
  body.add(pit);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(1.9, 10, 8),
    M(new THREE.MeshStandardMaterial({ color: 0xf4f4f6, roughness: 0.3, metalness: 0.4 })));
  helmet.position.set(-0.5, 8, 0);
  body.add(helmet);

  // sidepods
  for (const z of [-5.4, 5.4]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(12, 3.4, 3.8), paint);
    pod.position.set(-3, 4.2, z);
    pod.castShadow = true;
    body.add(pod);
  }

  // engine cover tapering back + shark fin
  const cover = new THREE.Mesh(new THREE.BoxGeometry(13, 3.2, 4.4), paint);
  cover.position.set(-8.5, 6.6, 0);
  cover.castShadow = true;
  body.add(cover);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(8, 2.4, 0.8), paint);
  fin.position.set(-10.5, 8.8, 0);
  body.add(fin);

  // rear wing with endplates
  const rwing = new THREE.Mesh(new THREE.BoxGeometry(4.5, 1, 17), carbon);
  rwing.position.set(-15.5, 9.6, 0);
  rwing.castShadow = true;
  body.add(rwing);
  const rwing2 = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.8, 17), carbon);
  rwing2.position.set(-16.2, 7.6, 0);
  body.add(rwing2);
  for (const z of [-8.5, 8.5]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(6.5, 5.4, 0.9), dark);
    ep.position.set(-15.5, 7.4, z);
    body.add(ep);
  }

  // sponsor decals
  const decal = (tex, dw, dh, x, y, z, flip) => {
    const mat = M(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(dw, dh), mat);
    pl.position.set(x, y, z);
    if (flip) pl.rotation.y = Math.PI;
    body.add(pl);
  };
  decal(SPONSOR_TEX.nerd, 11, 2.6, -3, 4.4, 7.36, false);     // sidepods
  decal(SPONSOR_TEX.nerd, 11, 2.6, -3, 4.4, -7.36, true);
  decal(SPONSOR_TEX.phase, 7, 1.9, -10.5, 8.8, 0.46, false);  // shark fin
  decal(SPONSOR_TEX.phase, 7, 1.9, -10.5, 8.8, -0.46, true);
  decal(SPONSOR_TEX.theo, 5.5, 2.6, -15.5, 7.6, 8.99, false); // rear wing endplates
  decal(SPONSOR_TEX.theo, 5.5, 2.6, -15.5, 7.6, -8.99, true);
  decal(SPONSOR_TEX.alyssa, 7, 2, 2.5, 5.2, 3.82, false);     // monocoque sides
  decal(SPONSOR_TEX.ben, 7, 2, 2.5, 5.2, -3.82, true);

  // rain light (doubles as brake light)
  const brake = M(new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 0.25 }));
  const rain = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 1.8), brake);
  rain.position.set(-17.8, 4.6, 0);
  body.add(rain);

  // open wheels: holder steers (Y), mesh spins (Z); rears are wider
  const tyre = M(new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.92 }));
  const hub = M(new THREE.MeshStandardMaterial({ color: 0xb9bec8, roughness: 0.35, metalness: 0.8 }));
  const mkWheelG = (r, w) => {
    const g = new THREE.CylinderGeometry(r, r, w, 14);
    g.rotateX(Math.PI / 2);
    return g;
  };
  const mkHubG = (r, w) => {
    const g = new THREE.CylinderGeometry(r, r, w, 8);
    g.rotateX(Math.PI / 2);
    return g;
  };
  const wheelF = mkWheelG(4.1, 3.4), hubF = mkHubG(2.2, 3.6);
  const wheelR = mkWheelG(4.5, 4.4), hubR = mkHubG(2.4, 4.6);
  const wheels = [];
  for (const [wx, wz, front] of [[11, -8.8, 1], [11, 8.8, 1], [-11.5, -9, 0], [-11.5, 9, 0]]) {
    const holder = new THREE.Group();
    holder.position.set(wx, front ? 4.1 : 4.5, wz);
    const mesh = new THREE.Mesh(front ? wheelF : wheelR, tyre);
    mesh.add(new THREE.Mesh(front ? hubF : hubR, hub));
    mesh.castShadow = true;
    holder.add(mesh);
    group.add(holder);
    wheels.push({ holder, mesh, front });
  }

  // soft blob shadow (helps ghosts that cast no shadow)
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 26),
    new THREE.MeshBasicMaterial({
      map: canvasTex(64, 40, (g) => {
        const gr = g.createRadialGradient(32, 20, 2, 32, 20, 26);
        gr.addColorStop(0, 'rgba(0,0,0,0.45)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 64, 40);
      }), transparent: true, depthWrite: false
    })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.45;
  group.add(blob);

  if (ghost) {
    for (const m of mats) { m.transparent = true; m.opacity = REMOTE_ALPHA; }
    blob.material.opacity = 0.5;
    body.traverse(o => { if (o.isMesh) o.castShadow = false; });
  }

  // name label
  let label = null;
  if (name) {
    const tex = canvasTex(256, 64, (g, w, h) => {
      g.font = '700 34px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.strokeText(name, w / 2, h / 2);
      g.fillStyle = '#fff';
      g.fillText(name, w / 2, h / 2);
    });
    label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, opacity: 0.95 }));
    label.scale.set(64, 16, 1);
    label.position.y = 26;
    group.add(label);
  }

  scene.add(group);
  return {
    group, body, wheels, brakeMat: brake, label,
    spin: 0, prevVF: 0, roll: 0, pitch: 0,
    update(st, dt) {
      group.position.set(st.x, 0, st.y);
      group.rotation.y = -st.angle;
      const cos = Math.cos(st.angle), sin = Math.sin(st.angle);
      const vF = st.vx * cos + st.vy * sin;
      const vL = -st.vx * sin + st.vy * cos;
      this.spin += vF * dt / 4;
      for (const w of this.wheels) {
        w.mesh.rotation.z = -this.spin;
        if (w.front) w.holder.rotation.y = -st.steer * 0.45;
      }
      const tPitch = clamp((this.prevVF - vF) * 0.016, -0.05, 0.06);
      const tRoll = clamp(vL * 0.0019, -0.07, 0.07);
      this.pitch = lerp(this.pitch, tPitch, Math.min(1, 8 * dt));
      this.roll = lerp(this.roll, tRoll, Math.min(1, 8 * dt));
      this.body.rotation.z = this.pitch;
      this.body.rotation.x = this.roll;
      this.prevVF = vF;
      this.brakeMat.emissiveIntensity = st.braking ? 2.4 : 0.15;
    },
    dispose() {
      scene.remove(group);
    }
  };
}

const carObjs = new Map(); // playerId -> carObj

// ============================================================ AUDIO
let AC = null, engOsc = null, engOsc2 = null, engGain = null, muted = false;
function initAudio() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    const lp = AC.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 600;
    engGain = AC.createGain(); engGain.gain.value = 0;
    engOsc = AC.createOscillator(); engOsc.type = 'sawtooth'; engOsc.frequency.value = 50;
    engOsc2 = AC.createOscillator(); engOsc2.type = 'square'; engOsc2.frequency.value = 25;
    const g2 = AC.createGain(); g2.gain.value = 0.4;
    engOsc.connect(engGain);
    engOsc2.connect(g2); g2.connect(engGain);
    engGain.connect(lp); lp.connect(AC.destination);
    engOsc.start(); engOsc2.start();
  } catch (e) { AC = null; }
}
function updateAudio(speed, throttle) {
  if (!AC || !engGain) return;
  const t = AC.currentTime;
  const rpm = 50 + speed * 0.45 + (throttle ? 25 : 0);
  engOsc.frequency.setTargetAtTime(rpm, t, 0.05);
  engOsc2.frequency.setTargetAtTime(rpm / 2, t, 0.05);
  const vol = muted ? 0 : Math.min(0.05, 0.012 + speed * 0.00009 + (throttle ? 0.01 : 0));
  engGain.gain.setTargetAtTime(racing ? vol : 0, t, 0.1);
}

// ============================================================ NETWORK
function connect(room, onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(room)}`);
  ws.onopen = onOpen;
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'you') { myId = m.id; return; }
    if (m.t === 'meta') return onMeta(m);
    if (m.t === 's') return onSnap(m);
    if (m.t === 'lap') return onLap(m);
    if (m.t === 'results') return onResults(m);
  };
  ws.onerror = () => showBanner('Connection failed — refresh and try again', true);
  ws.onclose = () => {
    showBanner('Disconnected — refresh to rejoin', true);
    racing = false;
  };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
// keepalive so idle lobby sockets don't get reaped by proxies
setInterval(() => send({ t: 'ping' }), 20000);

function onMeta(m) {
  const prevState = meta.state;
  meta = m;
  if (m.state === 'countdown' && prevState !== 'countdown') {
    myCar = null; pending = []; snaps = []; latest = null;
    errX = errY = errA = 0;
    lapStartSrv = 0; myLastLap = null; myBestLap = null;
    ui.lapFlash.classList.add('hidden');
    clearSkids();
  }
  // green light: anchor the live lap clock to the race start
  if (m.state === 'racing' && prevState !== 'racing') lapStartSrv = m.cd || 0;
  racing = m.state === 'racing' || m.state === 'countdown';
  // drop car objects for players that left
  const ids = new Set(m.players.map(p => p.id));
  for (const [id, obj] of carObjs) {
    if (!ids.has(id)) { obj.dispose(); carObjs.delete(id); }
  }
  updatePanels();
}

function onSnap(m) {
  const localNow = performance.now();
  const off = m.now - localNow;
  timeOffset = haveOffset ? timeOffset * 0.9 + off * 0.1 : off;
  haveOffset = true;
  latest = m;
  snaps.push({ at: m.now, cars: m.cars });
  while (snaps.length > 40) snaps.shift();

  const mine = m.cars.find(c => c[0] === myId);
  if (mine && meta.state === 'racing') {
    if (!myCar) {
      myCar = S.makeCar(mine[1], mine[2], mine[3]);
      myCar.idx = S.nearestIdx(mine[1], mine[2], -1, 0).i;
    }
    const ack = mine[7];
    pending = pending.filter(p => p.s > ack);
    const oldX = myCar.x, oldY = myCar.y, oldA = myCar.angle;
    myCar.x = mine[1]; myCar.y = mine[2]; myCar.angle = mine[3];
    myCar.vx = mine[4]; myCar.vy = mine[5]; myCar.steer = mine[6];
    myCar.finished = !!(mine[10] & 4);
    for (const p of pending) S.stepCar(myCar, p.i, DT);
    errX += oldX - myCar.x; errY += oldY - myCar.y; errA += wrapAng(oldA - myCar.angle);
    if (Math.abs(errX) > 120 || Math.abs(errY) > 120) errX = errY = errA = 0;
    // keep the render-interpolation anchor continuous across the rewind+replay
    if (myPrev) {
      myPrev.x += myCar.x - oldX;
      myPrev.y += myCar.y - oldY;
      myPrev.a += wrapAng(myCar.angle - oldA);
    }
  }
  if (mine && meta.state === 'countdown' && !myCar) {
    myCar = S.makeCar(mine[1], mine[2], mine[3]);
    myCar.idx = S.nearestIdx(mine[1], mine[2], -1, 0).i;
  }
}

function flashLap(text, cls) {
  ui.lapFlash.textContent = text;
  ui.lapFlash.className = cls || '';
  ui.lapFlash.style.opacity = '1';
  clearTimeout(flashLap._t);
  flashLap._t = setTimeout(() => { ui.lapFlash.style.opacity = '0'; }, 2600);
}

function onLap(m) {
  if (m.id !== myId) return;
  lapStartSrv = m.now;
  myLastLap = m.time;
  const newBest = myBestLap === null || m.time <= m.best;
  myBestLap = m.best;
  if (m.lap >= m.of) flashLap(`🏁 FINISHED — ${fmt(m.time)}`, 'finish');
  else flashLap(`LAP ${m.lap}/${m.of} — ${fmt(m.time)}`, newBest && m.lap > 1 ? 'best' : '');
}

function onResults(m) {
  ui.resultsList.innerHTML = '';
  const winT = m.list.length && !m.list[0].dnf ? m.list[0].time : null;
  m.list.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'res-row';
    const timeStr = r.dnf ? 'DNF'
      : (i === 0 || winT === null) ? fmt(r.time)
      : '+' + ((r.time - winT) / 1000).toFixed(3);
    const laps = (r.laps || []).map((t, k) =>
      `<span class="${t === r.best ? 'bl' : ''}">L${k + 1} ${fmt(t)}</span>`).join(' · ');
    row.innerHTML = `<div class="res-main">
        <span class="res-pos">${i + 1}</span>
        <span class="pl-dot" style="background:${r.color}"></span>
        <span class="res-name"></span>
        <span class="res-time">${timeStr}</span>
      </div>
      <div class="res-laps">${laps || 'no laps completed'}</div>`;
    row.querySelector('.res-name').textContent = r.name;
    ui.resultsList.appendChild(row);
  });
  updatePanels();
}

// ============================================================ UI
function showBanner(text, sticky) {
  ui.banner.textContent = text;
  ui.banner.classList.remove('hidden');
  clearTimeout(showBanner._t);
  if (!sticky) showBanner._t = setTimeout(() => ui.banner.classList.add('hidden'), 4000);
}

function updatePanels() {
  const st = meta.state;
  const joined = myId !== null && meta.players.some(p => p.id === myId);
  ui.join.classList.toggle('hidden', joined);
  ui.lobby.classList.toggle('hidden', !(joined && st === 'lobby'));
  ui.results.classList.toggle('hidden', !(joined && st === 'finished'));
  ui.hud.classList.toggle('hidden', !(joined && (st === 'racing' || st === 'countdown')));
  ui.leaveBtn.classList.toggle('hidden', !joined);
  if (st !== 'racing') ui.confirmOverlay.classList.add('hidden');
  mini.style.display = joined && st !== 'lobby' ? 'block' : 'none';

  const me = meta.players.find(p => p.id === myId);
  myRole = me ? me.role : null;
  const isHost = myId === meta.host;

  if (joined && st === 'lobby') {
    ui.lobbyTitle.textContent = 'Lobby · ' + (meta.room || myRoom);
    ui.playerList.innerHTML = '';
    for (const p of meta.players) {
      const row = document.createElement('div');
      row.className = 'pl-row';
      row.innerHTML = `<span class="pl-dot" style="background:${p.color}"></span>
        <span class="pl-name"></span>
        <span class="pl-tag">${p.role === 'racer' ? '🏎 RACER' : '👀 SPECTATOR'}${p.id === meta.host ? ' · HOST' : ''}${p.id === myId ? ' · YOU' : ''}</span>`;
      row.querySelector('.pl-name').textContent = p.name;
      ui.playerList.appendChild(row);
    }
    for (const b of ui.modeSeg.children) {
      b.classList.toggle('on', b.dataset.mode === meta.mode);
      b.disabled = !isHost;
    }
    for (const b of ui.lapsSeg.children) {
      b.classList.toggle('on', Number(b.dataset.laps) === meta.laps);
      b.disabled = !isHost;
    }
    ui.roleBtn.textContent = myRole === 'racer' ? 'Switch to Spectator' : 'Switch to Racer';
    const racerCount = meta.players.filter(p => p.role === 'racer').length;
    ui.startBtn.style.display = isHost ? '' : 'none';
    ui.startBtn.disabled = racerCount === 0;
    ui.lobbyHint.textContent = isHost
      ? (racerCount ? `${racerCount} racer${racerCount > 1 ? 's' : ''} ready — you're the host` : 'Need at least one racer')
      : 'Waiting for the host to start the race…';
  }

  if (joined && st === 'finished') {
    ui.lobbyBtn.style.display = isHost ? '' : 'none';
    ui.resultsHint.textContent = isHost ? '' : 'Waiting for the host…';
  }

  ui.mode.textContent = meta.mode === 'contact' ? 'CONTACT' : 'NON-CONTACT (GHOST)';

  if (joined && (st === 'racing' || st === 'countdown')) {
    const iRace = me && me.racing;
    if (!iRace) showBanner(myRole === 'racer' ? 'Race in progress — you race next round. Spectating…' : 'Spectating', false);
  }
}

function doJoin(role) {
  initAudio();
  const room = (ui.room.value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'paddock';
  const name = ui.name.value.trim();
  if (ws && ws.readyState === 1 && room === myRoom) {
    send({ t: 'join', name, role });
    return;
  }
  myRoom = room;
  if (ws) { ws.onclose = null; ws.close(); }
  connect(room, () => send({ t: 'join', name, role }));
}
ui.joinRacer.onclick = () => doJoin('racer');
ui.joinSpec.onclick = () => doJoin('spectator');
ui.name.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin('racer'); });
ui.room.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin('racer'); });
ui.modeSeg.addEventListener('click', e => {
  if (e.target.dataset.mode) send({ t: 'mode', mode: e.target.dataset.mode });
});
ui.lapsSeg.addEventListener('click', e => {
  if (e.target.dataset.laps) send({ t: 'laps', n: Number(e.target.dataset.laps) });
});
ui.roleBtn.onclick = () => send({ t: 'role', role: myRole === 'racer' ? 'spectator' : 'racer' });
ui.startBtn.onclick = () => send({ t: 'start' });
ui.lobbyBtn.onclick = () => send({ t: 'lobby' });

// ---- leave the game (back to the join screen; server cleans up on close) ----
function leaveGame() {
  const me = meta.players.find(p => p.id === myId);
  if (meta.state === 'racing' && me && me.racing) {
    ui.confirmOverlay.classList.remove('hidden');
    return;
  }
  doLeave();
}
function doLeave() {
  ui.confirmOverlay.classList.add('hidden');
  if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close(); } catch (e) {} ws = null; }
  myId = null; myRole = null; myCar = null; myPrev = null;
  pending = []; snaps = []; latest = null; haveOffset = false; racing = false;
  lapStartSrv = 0; myLastLap = null; myBestLap = null;
  ui.lapFlash.classList.add('hidden');
  meta = { state: 'lobby', mode: 'contact', laps: 3, host: null, players: [] };
  for (const obj of carObjs.values()) obj.dispose();
  carObjs.clear();
  clearSkids();
  ui.banner.classList.add('hidden');
  ui.countdown.classList.add('hidden');
  updatePanels();
}
ui.leaveBtn.onclick = leaveGame;
ui.confirmLeave.onclick = doLeave;
ui.confirmStay.onclick = () => ui.confirmOverlay.classList.add('hidden');
ui.confirmOverlay.addEventListener('click', e => {
  if (e.target === ui.confirmOverlay) ui.confirmOverlay.classList.add('hidden');
});

// ---- toolbar icons: bold arcade-style strokes, drawn inline ----
const ICON = {
  fsEnter: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M9 3.5H3.5V9M15 3.5h5.5V9M9 20.5H3.5V15M15 20.5h5.5V15"/></svg>`,
  fsExit: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M3.5 9H9V3.5M20.5 9H15V3.5M3.5 15H9v5.5M20.5 15H15v5.5"/></svg>`,
  sndOn: `<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" stroke="currentColor" stroke-linejoin="round">
    <path d="M3.5 9.5v5H7l5 4.5v-14L7 9.5H3.5z" stroke-width="1.6"/>
    <path d="M15.5 8.6a4.6 4.6 0 0 1 0 6.8M18.3 6a8.6 8.6 0 0 1 0 12" fill="none" stroke-width="2.6" stroke-linecap="round"/></svg>`,
  sndOff: `<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" stroke="currentColor" stroke-linejoin="round">
    <path d="M3.5 9.5v5H7l5 4.5v-14L7 9.5H3.5z" stroke-width="1.6"/>
    <path d="M15.5 9.5l6 6M21.5 9.5l-6 6" fill="none" stroke-width="2.8" stroke-linecap="round"/></svg>`,
  cam: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M3 7.5h4.2L9.2 5h5.6l2 2.5H21v11H3z"/>
    <circle cx="12" cy="12.7" r="3.4"/></svg>`
};
const CAM_NAMES = ['CHASE', 'CLOSE', 'HIGH'];
function syncIcons() {
  ui.fsBtn.innerHTML = document.fullscreenElement ? ICON.fsExit : ICON.fsEnter;
  ui.muteBtn.innerHTML = muted ? ICON.sndOff : ICON.sndOn;
  ui.muteBtn.classList.toggle('off', muted);
  ui.camBtn.innerHTML = ICON.cam + `<span class="cam-n">${CAM_NAMES[camMode]}</span>`;
  ui.camBtn.title = `Camera: ${CAM_NAMES[camMode].toLowerCase()} (C)`;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}
function toggleMute() {
  muted = !muted;
  syncIcons();
}
function cycleCam() {
  camMode = (camMode + 1) % 3;
  syncIcons();
}
ui.fsBtn.onclick = toggleFullscreen;
ui.muteBtn.onclick = toggleMute;
ui.camBtn.onclick = cycleCam;
document.addEventListener('fullscreenchange', syncIcons);
syncIcons();

// ============================================================ INPUT
const KEYMAP = {
  ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', Space: 'h'
};
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'KeyM') { toggleMute(); return; }
  if (e.code === 'KeyC') { cycleCam(); return; }
  if (e.code === 'KeyF') { toggleFullscreen(); return; }
  if (e.code === 'Escape' && !ui.confirmOverlay.classList.contains('hidden')) {
    ui.confirmOverlay.classList.add('hidden'); return;
  }
  const k = KEYMAP[e.code];
  if (k) { keys[k] = 1; e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  const k = KEYMAP[e.code];
  if (k) { keys[k] = 0; e.preventDefault(); }
});
window.addEventListener('blur', () => { keys = { u: 0, d: 0, l: 0, r: 0, h: 0 }; });

// ============================================================ MINIMAP
const miniTrack = document.createElement('canvas');
miniTrack.width = 230; miniTrack.height = 160;
const MSC = Math.min(206 / WORLD.w, 136 / WORLD.h);
const MOX = (230 - WORLD.w * MSC) / 2, MOY = (160 - WORLD.h * MSC) / 2;
{
  const g = miniTrack.getContext('2d');
  g.translate(MOX, MOY); g.scale(MSC, MSC);
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  g.moveTo(SAM[0].x, SAM[0].y);
  for (let i = 1; i < N; i++) g.lineTo(SAM[i].x, SAM[i].y);
  g.closePath();
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = HALF_W * 2.4; g.stroke();
  g.strokeStyle = 'rgba(20,25,38,0.9)'; g.lineWidth = HALF_W * 1.4; g.stroke();
}

// ============================================================ RENDER STATE
function remoteStates(renderT) {
  if (snaps.length === 0) return [];
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].at <= renderT) { a = snaps[i - 1]; b = snaps[i]; break; }
  }
  const span = b.at - a.at;
  const t = span > 0 ? Math.max(0, Math.min(1.2, (renderT - a.at) / span)) : 1;
  const out = [];
  for (const cb of b.cars) {
    const ca = a.cars.find(c => c[0] === cb[0]) || cb;
    out.push({
      id: cb[0],
      x: lerp(ca[1], cb[1], t), y: lerp(ca[2], cb[2], t),
      angle: lerpAng(ca[3], cb[3], t),
      vx: lerp(ca[4], cb[4], t), vy: lerp(ca[5], cb[5], t), steer: lerp(ca[6], cb[6], t),
      laps: cb[8], prog: cb[9],
      braking: !!(cb[10] & 1), finished: !!(cb[10] & 4), onTrack: !!(cb[10] & 8)
    });
  }
  return out;
}

function carSlipState(st) {
  const cos = Math.cos(st.angle), sin = Math.sin(st.angle);
  return Math.abs(-st.vx * sin + st.vy * cos);
}

function emitEffects(st) {
  const slip = carSlipState(st);
  const speed = Math.hypot(st.vx, st.vy);
  const cos = Math.cos(st.angle), sin = Math.sin(st.angle);
  if (slip > 70 && st.onTrack !== false) {
    for (const side of [-1, 1])
      dropSkid(st.x - cos * 10 - sin * 7 * side, st.y - sin * 10 + cos * 7 * side, st.angle);
    if (Math.random() < 0.45) puff(st.x - cos * 12, st.y - sin * 12, false);
  }
  if (st.onTrack === false && speed > 60 && Math.random() < 0.4) {
    puff(st.x - cos * 8, st.y - sin * 8, true);
  }
}

// menu-screen showcase: a car lapping the circuit, camera low at the rear wheel
let showcase = null, showAcc = 0;
function updateShowcase(dt, nowMs) {
  if (!showcase) {
    const s = SAM[120];
    const car = S.makeCar(s.x, s.y, Math.atan2(s.dy, s.dx), 120);
    showcase = { car, obj: makeCarObj('#e10600', false, '') };
  }
  const c = showcase.car;
  showAcc += dt;
  let steps = 0;
  while (showAcc >= DT && steps < 4) {
    showAcc -= DT; steps++;
    const tgt = SAM[(c.idx + 14) % N];
    let d = Math.atan2(tgt.y - c.y, tgt.x - c.x) - c.angle;
    d = wrapAng(d);
    const sp = Math.hypot(c.vx, c.vy);
    S.stepCar(c, {
      u: sp < 320 && Math.abs(d) < 0.5 ? 1 : 0,
      d: Math.abs(d) > 0.6 && sp > 230 ? 1 : 0,
      l: d < -0.04 ? 1 : 0, r: d > 0.04 ? 1 : 0, h: 0
    }, DT);
  }
  showcase.obj.group.visible = true;
  showcase.obj.update({
    x: c.x, y: c.y, angle: c.angle, vx: c.vx, vy: c.vy,
    steer: c.steer, braking: false, onTrack: c.onTrack
  }, dt);
  // low rear three-quarter shot, hugging the tarmac behind the rear wheel
  const fx = Math.cos(c.angle), fy = Math.sin(c.angle);
  const rx = -fy, ry = fx;
  camPos.set(
    c.x - fx * 34 + rx * 22,
    8 + Math.sin(nowMs / 950) * 0.5,
    c.y - fy * 34 + ry * 22
  );
  camLook.set(c.x + fx * 18, 4.5, c.y + fy * 18);
  camera.fov = lerp(camera.fov, 55, Math.min(1, 5 * dt));
  camera.updateProjectionMatrix();
}

// camera rigs: [back, height, lookAhead]
const CAM_RIGS = [[86, 36, 55], [58, 22, 70], [150, 95, 30]];
const camPos = new THREE.Vector3(WORLD.w / 2, 350, WORLD.h / 2 + 500);
const camLook = new THREE.Vector3(WORLD.w / 2, 0, WORLD.h / 2);
let orbitA = 0;

// ============================================================ MAIN LOOP
let lastT = performance.now(), acc = 0, hudTick = 0;
resize();

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dtMs = Math.min(100, nowMs - lastT);
  const dt = dtMs / 1000;
  lastT = nowMs;

  // ---- fixed-step local prediction ----
  // keeps running after the chequered flag (with hands-off inputs) so the car
  // coasts smoothly over the line instead of snapping to the delayed server view
  const predicting = meta.state === 'racing' && myCar && myRole === 'racer';
  if (predicting) {
    acc += dt;
    let steps = 0;
    while (acc >= DT && steps < 5) {
      acc -= DT; steps++;
      seq++;
      const inp = myCar.finished
        ? { u: 0, d: 0, l: 0, r: 0, h: 0 }
        : { u: keys.u, d: keys.d, l: keys.l, r: keys.r, h: keys.h };
      myPrev = { x: myCar.x, y: myCar.y, a: myCar.angle };
      S.stepCar(myCar, inp, DT);
      pending.push({ s: seq, i: inp });
      if (pending.length > 240) pending.shift();
      send({ t: 'i', s: seq, u: inp.u, d: inp.d, l: inp.l, r: inp.r, h: inp.h });
    }
  } else { acc = 0; myPrev = null; }

  // own-car visual state, interpolated between the last two physics steps so
  // motion is smooth at any display refresh rate
  let visMe = null;
  if (myCar) {
    const al = myPrev ? clamp(acc / DT, 0, 1) : 1;
    visMe = {
      x: (myPrev ? lerp(myPrev.x, myCar.x, al) : myCar.x) + errX,
      y: (myPrev ? lerp(myPrev.y, myCar.y, al) : myCar.y) + errY,
      angle: (myPrev ? lerpAng(myPrev.a, myCar.angle, al) : myCar.angle) + errA,
      vx: myCar.vx, vy: myCar.vy, steer: myCar.steer,
      braking: keys.d === 1 && !myCar.finished, onTrack: myCar.onTrack
    };
  }

  const decay = Math.pow(0.06, dt);
  errX *= decay; errY *= decay; errA *= decay;

  const serverNow = nowMs + timeOffset;
  const renderT = serverNow - INTERP_DELAY;
  const remotes = remoteStates(renderT);
  const names = new Map(meta.players.map(p => [p.id, p]));

  // ---- update car objects ----
  const seen = new Set();
  for (const r of remotes) {
    const isMe = r.id === myId;
    let st = r;
    if (isMe && predicting && visMe) st = visMe;
    let obj = carObjs.get(r.id);
    if (!obj) {
      const pl = names.get(r.id);
      obj = makeCarObj(pl ? pl.color : '#999999', !isMe, isMe ? '' : (pl ? pl.name : ''));
      carObjs.set(r.id, obj);
    }
    obj.group.visible = true;
    obj.update(st, dt);
    seen.add(r.id);
    if (meta.state === 'racing') emitEffects(st);
  }
  for (const [id, obj] of carObjs) {
    if (!seen.has(id)) obj.group.visible = false;
  }

  // ---- camera ----
  const onMenu = !ui.join.classList.contains('hidden');
  if (!onMenu && showcase) showcase.obj.group.visible = false;
  let followSt = null;
  if (visMe && (predicting || meta.state === 'countdown')) {
    followSt = visMe;
  } else {
    const mine = remotes.find(r => r.id === myId);
    followSt = mine || remotes[0] || null;
  }
  if (onMenu) {
    updateShowcase(dt, nowMs);
  } else if (followSt) {
    const rig = CAM_RIGS[camMode];
    const speed = Math.hypot(followSt.vx, followSt.vy);
    const back = rig[0] + speed * 0.04;
    const fx = Math.cos(followSt.angle), fy = Math.sin(followSt.angle);
    const tx = followSt.x - fx * back, ty = followSt.y - fy * back;
    const f = 1 - Math.pow(0.0015, dt);
    camPos.x = lerp(camPos.x, tx, f);
    camPos.z = lerp(camPos.z, ty, f);
    camPos.y = lerp(camPos.y, rig[1] + speed * 0.012, f);
    camLook.set(
      lerp(camLook.x, followSt.x + fx * rig[2], f),
      6,
      lerp(camLook.z, followSt.y + fy * rig[2], f)
    );
    const tFov = 60 + Math.min(1, speed / 470) * 14;
    camera.fov = lerp(camera.fov, tFov, Math.min(1, 4 * dt));
    camera.updateProjectionMatrix();
  } else {
    // lobby flyover
    orbitA += dt * 0.07;
    camPos.set(WORLD.w / 2 + Math.cos(orbitA) * 950, 420, WORLD.h / 2 + Math.sin(orbitA) * 950);
    camLook.set(WORLD.w / 2, 0, WORLD.h / 2);
  }
  camera.position.copy(camPos);
  camera.lookAt(camLook);

  // sun shadow follows the camera target
  sun.position.set(camLook.x + 380, 760, camLook.z + 230);
  sun.target.position.set(camLook.x, 0, camLook.z);

  // ---- effects ----
  updateSmoke(dt);

  // ---- HUD ----
  if (++hudTick % 3 === 0) {
    if (meta.state === 'racing' && lapStartSrv && haveOffset) {
      ui.curLapT.textContent = (myCar && myCar.finished) ? fmt(myLastLap) : fmt(Math.max(0, serverNow - lapStartSrv));
    } else {
      ui.curLapT.textContent = '—';
    }
    ui.lastLapT.textContent = fmt(myLastLap);
    ui.bestLapT.textContent = fmt(myBestLap);
    if (myCar && predicting) ui.speed.textContent = Math.round(Math.hypot(myCar.vx, myCar.vy) * 0.38);
    else if (followSt) ui.speed.textContent = Math.round(Math.hypot(followSt.vx || 0, followSt.vy || 0) * 0.38);
    if (latest) {
      const mineIdx = latest.cars.findIndex(c => c[0] === myId);
      if (mineIdx >= 0) {
        ui.pos.textContent = (mineIdx + 1) + '/' + latest.cars.length;
        ui.lap.textContent = Math.min(latest.cars[mineIdx][8] + 1, meta.laps) + '/' + meta.laps;
      } else if (latest.cars.length) {
        ui.pos.textContent = '—';
        ui.lap.textContent = Math.min(latest.cars[0][8] + 1, meta.laps) + '/' + meta.laps;
      }
    }
  }

  // countdown overlay
  if (meta.state === 'countdown' && haveOffset) {
    const left = (meta.cd || (latest && latest.cd) || 0) - serverNow;
    ui.countdown.classList.remove('hidden');
    if (left > 0) {
      ui.countdown.textContent = Math.ceil(left / 1000);
      ui.countdown.classList.remove('go');
    }
  } else if (meta.state === 'racing' && latest && serverNow - latest.cd < 1200) {
    ui.countdown.classList.remove('hidden');
    ui.countdown.textContent = 'GO!';
    ui.countdown.classList.add('go');
  } else {
    ui.countdown.classList.add('hidden');
  }

  // minimap
  if (mini.style.display !== 'none') {
    mctx.clearRect(0, 0, 230, 160);
    mctx.drawImage(miniTrack, 0, 0);
    for (const r of remotes) {
      const pl = names.get(r.id);
      mctx.fillStyle = pl ? pl.color : '#999';
      mctx.beginPath();
      mctx.arc(MOX + r.x * MSC, MOY + r.y * MSC, r.id === myId ? 4 : 3, 0, 7);
      mctx.fill();
      if (r.id === myId) { mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5; mctx.stroke(); }
    }
  }

  updateAudio(myCar && predicting ? Math.hypot(myCar.vx, myCar.vy) : 0, keys.u === 1 && !(myCar && myCar.finished));
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
