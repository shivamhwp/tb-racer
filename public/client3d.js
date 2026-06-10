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
  join: $('join'), name: $('nameInput'), joinRacer: $('joinRacer'), joinSpec: $('joinSpec'),
  lobby: $('lobby'), playerList: $('playerList'), modeSeg: $('modeSeg'), lapsSeg: $('lapsSeg'),
  roleBtn: $('roleBtn'), startBtn: $('startBtn'), lobbyHint: $('lobbyHint'),
  results: $('results'), resultsList: $('resultsList'), lobbyBtn: $('lobbyBtn'), resultsHint: $('resultsHint')
};

// ---- State ----
let ws = null, myId = null, myRole = null;
let meta = { state: 'lobby', mode: 'contact', laps: 3, host: null, players: [] };
let snaps = [], latest = null;
let timeOffset = 0, haveOffset = false;
let myCar = null, pending = [], seq = 0;
let errX = 0, errY = 0, errA = 0;
let keys = { u: 0, d: 0, l: 0, r: 0, h: 0 };
let racing = false;
let camMode = 0; // 0 chase, 1 close, 2 high

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
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const SKY = 0xaecbe8;
scene.fog = new THREE.Fog(0xbcd4ea, 900, 2600);

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
sun.shadow.mapSize.set(2048, 2048);
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
    // edge lines
    g.fillStyle = 'rgba(245,245,245,0.85)';
    g.fillRect(6, 0, 5, h);
    g.fillRect(w - 11, 0, 5, h);
    // center dash
    g.fillStyle = 'rgba(235,235,235,0.6)';
    g.fillRect(w / 2 - 3, 12, 6, 88);
    g.fillRect(w / 2 - 3, 140, 6, 88);
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
  gantry.position.set(s0.x, 0, s0.y);
  gantry.rotation.y = yaw;
  worldGroup.add(gantry);
}

// billboards along straights
{
  const texts = ['TB RACER', 'THEO ♥ OBSIDIAN', 'CAPSULE GP', 'FLAT OUT!'];
  let placed = 0;
  for (let i = 40; i < N && placed < texts.length; i += 30) {
    if (curva[i] > 0.02) continue;
    const s = SAM[i];
    const side = placed % 2 ? 1 : -1;
    const nx = -s.dy * side, ny = s.dx * side;
    const bb = new THREE.Group();
    const tex = canvasTex(512, 128, (g, w, h) => {
      g.fillStyle = ['#0e3e8e', '#7c2d8e', '#0e6e4e', '#8e2d2d'][placed];
      g.fillRect(0, 0, w, h);
      g.strokeStyle = '#fff'; g.lineWidth = 6; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = '#fff';
      g.font = '900 52px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(texts[placed], w / 2, h / 2);
    });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(110, 28), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 }));
    board.position.y = 26;
    board.castShadow = true;
    bb.add(board);
    for (const o of [-40, 40]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 26, 8), new THREE.MeshStandardMaterial({ color: 0x444a55 }));
      leg.position.set(o, 13, -1);
      bb.add(leg);
    }
    bb.position.set(s.x + nx * (HALF_W + 55), 0, s.y + ny * (HALF_W + 55));
    bb.lookAt(s.x, 26, s.y);
    worldGroup.add(bb);
    placed++;
  }
}

// trees (instanced)
{
  const treePos = [];
  for (let t = 0; t < 160; t++) {
    const x = 60 + rng() * (WORLD.w - 120), y = 60 + rng() * (WORLD.h - 120);
    if (S.nearestIdx(x, y, -1, 0).d2 < (HALF_W + 120) * (HALF_W + 120)) continue;
    treePos.push([x, y, 0.7 + rng() * 0.8]);
  }
  // outer ring of trees beyond the world
  for (let t = 0; t < 120; t++) {
    const a = rng() * Math.PI * 2, r = 1500 + rng() * 900;
    treePos.push([WORLD.w / 2 + Math.cos(a) * r, WORLD.h / 2 + Math.sin(a) * r, 1 + rng() * 1.3]);
  }
  const trunkG = new THREE.CylinderGeometry(2.2, 3, 18, 6);
  const leafG = new THREE.IcosahedronGeometry(16, 0);
  const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }), treePos.length);
  const leaves = new THREE.InstancedMesh(leafG, new THREE.MeshStandardMaterial({ color: 0x2e6b35, roughness: 1, flatShading: true }), treePos.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();
  treePos.forEach(([x, y, s], i) => {
    q.setFromEuler(new THREE.Euler(0, rng() * 6.28, 0));
    p.set(x, 9 * s, y); sc.set(s, s, s);
    m.compose(p, q, sc); trunks.setMatrixAt(i, m);
    p.set(x, (18 + 10) * s, y);
    m.compose(p, q, sc); leaves.setMatrixAt(i, m);
    leaves.setColorAt(i, col.setHSL(0.32 + rng() * 0.06, 0.45 + rng() * 0.2, 0.28 + rng() * 0.12));
  });
  leaves.castShadow = true;
  worldGroup.add(trunks, leaves);
}

// distant hills
{
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x55795a, roughness: 1, flatShading: true });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rng() * 0.3;
    const r = 2600 + rng() * 700;
    const h = new THREE.Mesh(new THREE.IcosahedronGeometry(420 + rng() * 380, 1), hillMat);
    h.position.set(WORLD.w / 2 + Math.cos(a) * r, -140 - rng() * 80, WORLD.h / 2 + Math.sin(a) * r);
    h.scale.y = 0.55 + rng() * 0.3;
    scene.add(h);
  }
}

// ---- crowd (instanced, animated) + grandstands ----
let crowdBodies, crowdHeads, crowdData = [];
{
  const standMat = new THREE.MeshStandardMaterial({ color: 0x39404f, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xd8dde6, roughness: 0.6, metalness: 0.3 });
  const spots = [];
  for (let c = 0; c < 26; c++) {
    const i = Math.floor(rng() * N);
    const s = SAM[i];
    const side = rng() > 0.5 ? 1 : -1;
    const nx = -s.dy * side, ny = s.dx * side;
    const grand = curva[i] > 0.05 && rng() > 0.45; // grandstands at corners
    const baseOff = HALF_W + (grand ? 46 : 26) + rng() * 10;
    const cx = s.x + nx * baseOff, cy = s.y + ny * baseOff;
    if (cx < 40 || cy < 40 || cx > WORLD.w - 40 || cy > WORLD.h - 40) continue;
    if (S.nearestIdx(cx, cy, i, 80).d2 < (HALF_W + 14) * (HALF_W + 14)) continue;
    spots.push({ s, nx, ny, baseOff, grand, i });
  }
  for (const sp of spots) {
    const { s, nx, ny, baseOff, grand } = sp;
    const yaw = Math.atan2(nx, ny) + Math.PI; // face the track
    if (grand) {
      const g = new THREE.Group();
      for (let row = 0; row < 3; row++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(120, 6 + row * 6, 16), standMat);
        step.position.set(0, (6 + row * 6) / 2, row * 16);
        step.castShadow = step.receiveShadow = true;
        g.add(step);
      }
      const roof = new THREE.Mesh(new THREE.BoxGeometry(126, 2.5, 58), roofMat);
      roof.position.set(0, 46, 18);
      roof.castShadow = true;
      g.add(roof);
      for (const ox of [-58, 58]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 46, 6), standMat);
        pole.position.set(ox, 23, 44);
        g.add(pole);
      }
      g.position.set(s.x + nx * (baseOff + 8), 0, s.y + ny * (baseOff + 8));
      g.rotation.y = -Math.atan2(ny, nx) + Math.PI / 2;
      worldGroup.add(g);
      // seated rows of people
      for (let row = 0; row < 3; row++) {
        for (let k = -5; k <= 5; k++) {
          const along = k * 10 + (rng() - 0.5) * 4;
          const out = baseOff + 8 + (row - 1) * 16 * 0 + row * 14;
          crowdData.push({
            x: s.x + s.dx * along + nx * (baseOff + 2 + row * 15),
            y: s.y + s.dy * along + ny * (baseOff + 2 + row * 15),
            h: 7 + row * 5.6, phase: rng() * 6.28, amp: 1.2 + rng() * 1.6
          });
        }
      }
    } else {
      const count = 8 + Math.floor(rng() * 12);
      for (let p = 0; p < count; p++) {
        crowdData.push({
          x: s.x + s.dx * (rng() - 0.5) * 120 + nx * (baseOff + rng() * 30),
          y: s.y + s.dy * (rng() - 0.5) * 120 + ny * (baseOff + rng() * 30),
          h: 0, phase: rng() * 6.28, amp: 1.4 + rng() * 2
        });
      }
    }
  }
  const bodyG = new THREE.CapsuleGeometry(2.1, 5.5, 2, 6);
  const headG = new THREE.SphereGeometry(1.9, 8, 6);
  crowdBodies = new THREE.InstancedMesh(bodyG, new THREE.MeshStandardMaterial({ roughness: 0.95 }), crowdData.length);
  crowdHeads = new THREE.InstancedMesh(headG, new THREE.MeshStandardMaterial({ roughness: 0.9 }), crowdData.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  const skins = [0xe8b08c, 0xc68863, 0x8d5a3b, 0xf1c9a5];
  crowdData.forEach((p, i) => {
    m.makeTranslation(p.x, p.h + 5.5, p.y);
    crowdBodies.setMatrixAt(i, m);
    crowdBodies.setColorAt(i, col.setHSL(rng(), 0.5 + rng() * 0.3, 0.45 + rng() * 0.2));
    m.makeTranslation(p.x, p.h + 11.5, p.y);
    crowdHeads.setMatrixAt(i, m);
    crowdHeads.setColorAt(i, col.setHex(skins[Math.floor(rng() * 4)]));
  });
  worldGroup.add(crowdBodies, crowdHeads);
}
const crowdM = new THREE.Matrix4();
function animateCrowd(tSec) {
  if (!racing) return;
  for (let i = 0; i < crowdData.length; i++) {
    const p = crowdData[i];
    const bob = Math.max(0, Math.sin(tSec * 5 + p.phase)) * p.amp;
    crowdM.makeTranslation(p.x, p.h + 5.5 + bob, p.y);
    crowdBodies.setMatrixAt(i, crowdM);
    crowdM.makeTranslation(p.x, p.h + 11.5 + bob, p.y);
    crowdHeads.setMatrixAt(i, crowdM);
  }
  crowdBodies.instanceMatrix.needsUpdate = true;
  crowdHeads.instanceMatrix.needsUpdate = true;
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
function makeCarObj(colorHex, ghost, name) {
  const mats = [];
  const M = m => { mats.push(m); return m; };
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const paint = M(carPaint(colorHex));
  const dark = M(new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.7, metalness: 0.2 }));
  const glass = M(new THREE.MeshStandardMaterial({ color: 0x0e1622, roughness: 0.08, metalness: 0.9 }));

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(34, 4.6, 16), paint);
  chassis.position.y = 5;
  chassis.castShadow = true;
  body.add(chassis);

  const hood = new THREE.Mesh(new THREE.BoxGeometry(11, 2.6, 13.5), paint);
  hood.position.set(10.5, 7.6, 0);
  hood.castShadow = true;
  body.add(hood);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(13.5, 4.6, 12), glass);
  cabin.position.set(-1.5, 9.2, 0);
  cabin.castShadow = true;
  body.add(cabin);

  const tail = new THREE.Mesh(new THREE.BoxGeometry(7, 2.8, 14.5), paint);
  tail.position.set(-13, 7.6, 0);
  body.add(tail);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(3, 1.1, 16.5), dark);
  wing.position.set(-16, 10.6, 0);
  body.add(wing);
  for (const z of [-5, 5]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.6, 1.4), dark);
    post.position.set(-16, 9, z);
    body.add(post);
  }

  // lights
  const head1 = M(new THREE.MeshStandardMaterial({ color: 0xfff6c8, emissive: 0xfff2b0, emissiveIntensity: 0.9 }));
  const brake = M(new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 0.15 }));
  for (const z of [-5.2, 5.2]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, 3), head1);
    h.position.set(17.2, 5.8, z);
    body.add(h);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, 3.2), brake);
    b.position.set(-17.2, 5.8, z);
    body.add(b);
  }

  // wheels: holder steers (Y), mesh spins (Z)
  const wheelG = new THREE.CylinderGeometry(4, 4, 3.4, 14);
  wheelG.rotateX(Math.PI / 2);
  const hubG = new THREE.CylinderGeometry(2.1, 2.1, 3.6, 8);
  hubG.rotateX(Math.PI / 2);
  const tyre = M(new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.92 }));
  const hub = M(new THREE.MeshStandardMaterial({ color: 0xb9bec8, roughness: 0.35, metalness: 0.8 }));
  const wheels = [];
  for (const [wx, wz, front] of [[10.5, -8.2, 1], [10.5, 8.2, 1], [-10.5, -8.2, 0], [-10.5, 8.2, 0]]) {
    const holder = new THREE.Group();
    holder.position.set(wx, 4, wz);
    const mesh = new THREE.Mesh(wheelG, tyre);
    mesh.add(new THREE.Mesh(hubG, hub));
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
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'you') { myId = m.id; return; }
    if (m.t === 'meta') return onMeta(m);
    if (m.t === 's') return onSnap(m);
    if (m.t === 'results') return onResults(m);
  };
  ws.onclose = () => {
    showBanner('Disconnected — refresh to rejoin', true);
    racing = false;
  };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function onMeta(m) {
  const prevState = meta.state;
  meta = m;
  if (m.state === 'countdown' && prevState !== 'countdown') {
    myCar = null; pending = []; snaps = []; latest = null;
    errX = errY = errA = 0;
    clearSkids();
  }
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
  }
  if (mine && meta.state === 'countdown' && !myCar) {
    myCar = S.makeCar(mine[1], mine[2], mine[3]);
    myCar.idx = S.nearestIdx(mine[1], mine[2], -1, 0).i;
  }
}

function onResults(m) {
  ui.resultsList.innerHTML = '';
  m.list.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'res-row';
    row.innerHTML = `<span class="res-pos">${i + 1}</span>
      <span class="pl-dot" style="background:${r.color}"></span>
      <span class="res-name"></span>
      <span class="res-time">${r.dnf ? 'DNF' : fmt(r.time)}</span>
      <span class="res-best">best ${fmt(r.best)}</span>`;
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
  mini.style.display = joined && st !== 'lobby' ? 'block' : 'none';

  const me = meta.players.find(p => p.id === myId);
  myRole = me ? me.role : null;
  const isHost = myId === meta.host;

  if (joined && st === 'lobby') {
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
  send({ t: 'join', name: ui.name.value.trim(), role });
}
ui.joinRacer.onclick = () => doJoin('racer');
ui.joinSpec.onclick = () => doJoin('spectator');
ui.name.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin('racer'); });
ui.modeSeg.addEventListener('click', e => {
  if (e.target.dataset.mode) send({ t: 'mode', mode: e.target.dataset.mode });
});
ui.lapsSeg.addEventListener('click', e => {
  if (e.target.dataset.laps) send({ t: 'laps', n: Number(e.target.dataset.laps) });
});
ui.roleBtn.onclick = () => send({ t: 'role', role: myRole === 'racer' ? 'spectator' : 'racer' });
ui.startBtn.onclick = () => send({ t: 'start' });
ui.lobbyBtn.onclick = () => send({ t: 'lobby' });

// ============================================================ INPUT
const KEYMAP = {
  ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', Space: 'h'
};
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'KeyM') { muted = !muted; return; }
  if (e.code === 'KeyC') { camMode = (camMode + 1) % 3; return; }
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
      vx: cb[4], vy: cb[5], steer: cb[6],
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
  const predicting = meta.state === 'racing' && myCar && !myCar.finished && myRole === 'racer';
  if (predicting) {
    acc += dt;
    let steps = 0;
    while (acc >= DT && steps < 5) {
      acc -= DT; steps++;
      seq++;
      const inp = { u: keys.u, d: keys.d, l: keys.l, r: keys.r, h: keys.h };
      S.stepCar(myCar, inp, DT);
      pending.push({ s: seq, i: inp });
      if (pending.length > 240) pending.shift();
      send({ t: 'i', s: seq, u: inp.u, d: inp.d, l: inp.l, r: inp.r, h: inp.h });
    }
  } else { acc = 0; }

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
    if (isMe && predicting) {
      st = {
        x: myCar.x + errX, y: myCar.y + errY, angle: myCar.angle + errA,
        vx: myCar.vx, vy: myCar.vy, steer: myCar.steer,
        braking: keys.d === 1, onTrack: myCar.onTrack
      };
    }
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
  let followSt = null;
  if (predicting || (myCar && meta.state === 'countdown')) {
    followSt = { x: myCar.x + errX, y: myCar.y + errY, angle: myCar.angle + errA, vx: myCar.vx, vy: myCar.vy };
  } else {
    const mine = remotes.find(r => r.id === myId);
    followSt = mine || remotes[0] || null;
  }
  if (followSt) {
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

  // ---- effects + crowd ----
  updateSmoke(dt);
  if ((hudTick & 1) === 0) animateCrowd(nowMs / 1000);

  // ---- HUD ----
  if (++hudTick % 3 === 0) {
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

  updateAudio(myCar && predicting ? Math.hypot(myCar.vx, myCar.vy) : 0, keys.u === 1);
  renderer.render(scene, camera);
}

connect();
requestAnimationFrame(frame);
