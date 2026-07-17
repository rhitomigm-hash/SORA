// 熱気球フライト プロトタイプ
// 佐賀・嘉瀬川周辺(約20km四方)を地理院タイルから生成し、
// バーナー/リップライン(上下操作)+ 高度別レイヤーの風で飛ぶ。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTerrain, lonLatToTile } from './terrain.js';

// ---- 舞台設定 ----
const TILE_RADIUS = 2; // 5x5タイル ≒ 20km四方
let AREA = null;       // { lon, lat, name? } エリア選択またはURLで決まる

// 日本の主な気球競技開催地(エリア選択のプリセット)
const PRESET_AREAS = [
  { name: '佐賀・嘉瀬川', lon: 130.25, lat: 33.27 },
  { name: '渡良瀬遊水地', lon: 139.68, lat: 36.22 },
  { name: '佐久・千曲川', lon: 138.48, lat: 36.25 },
  { name: '一関・平泉', lon: 141.13, lat: 38.93 },
  { name: '上士幌(北海道)', lon: 143.30, lat: 43.23 },
];

// URLの ?a=lon,lat からエリアを復元
function decodeArea(s) {
  if (!s) return null;
  const v = s.split(',').map(Number);
  if (v.length !== 2 || !v.every(Number.isFinite)) return null;
  const [lon, lat] = v;
  if (lon < 122 || lon > 148 || lat < 24 || lat > 46) return null; // 日本近辺のみ
  return { lon, lat };
}

// パイバル観測データ。高度ft(MSL) / 風向FROM 磁方位° / 風速kt
const WIND_PRESETS = [
  { name: '佐賀・朝の順転(既定)',
    rows: [[0, 140, 3], [500, 160, 5], [1000, 190, 7], [2000, 220, 10], [3000, 240, 13], [5000, 260, 17]] },
  { name: '逆転(北東→北西)',
    rows: [[0, 40, 4], [500, 20, 6], [1000, 350, 8], [2000, 330, 11], [3000, 310, 14], [5000, 300, 18]] },
  { name: 'ほぼ一定(南風)',
    rows: [[0, 170, 4], [1000, 180, 6], [3000, 185, 9], [5000, 190, 12]] },
  { name: '強風・大きく順転',
    rows: [[0, 120, 6], [500, 150, 9], [1000, 180, 12], [2000, 220, 15], [3000, 250, 18], [5000, 270, 24]] },
];
const toRowObj = ([ft, dir, kt]) => ({ ft, dir, kt });

// URLの ?w=ft,dir,kt;ft,dir,kt;… から風テーブルを復元(共有シード)
function decodeWind(s) {
  if (!s) return null;
  const rows = s.split(';')
    .map((p) => p.split(',').map(Number))
    .filter((v) => v.length === 3 && v.every(Number.isFinite) && v[0] >= 0 && v[2] >= 0)
    .map(toRowObj)
    .sort((a, b) => a.ft - b.ft);
  return rows.length ? rows : null;
}
const encodeWind = (rows) => rows.map((r) => `${r.ft},${r.dir},${r.kt}`).join(';');
const shareUrl = () =>
  `${location.origin}${location.pathname}?a=${AREA.lon.toFixed(4)},${AREA.lat.toFixed(4)}&w=${encodeWind(PIBAL)}${setupMode ? '&setup=1' : ''}`;

let PIBAL = decodeWind(new URLSearchParams(location.search).get('w'))
  || WIND_PRESETS[0].rows.map(toRowObj);
const KT2MS = 0.514444;
const M2FT = 3.28084;

// JDGターゲットはエリア中央。離陸地点はブリーフィングでプレイヤーが選ぶ
const TARGET_XZ = { x: 0, z: 0 };
const BEST_KEY = 'balloon-jdg-proto-best';
const TASK_LIMIT_S = 30 * 60; // 制限時間(ゲーム内秒)

// マーカー(70g+リボン)の落下特性
const MARKER_TERMINAL = 10;              // 終端速度 m/s
const MARKER_DRAG = 9.81 / MARKER_TERMINAL;
const MARKER_WIND_TAU = 1.5;             // 水平速度が風に馴染む時定数 s

function windAt(altM) {
  const ft = altM * M2FT;
  let a = PIBAL[0], b = PIBAL[PIBAL.length - 1];
  if (ft <= a.ft) b = a;
  else if (ft >= b.ft) a = b;
  else {
    for (let i = 0; i < PIBAL.length - 1; i++) {
      if (ft >= PIBAL[i].ft && ft < PIBAL[i + 1].ft) { a = PIBAL[i]; b = PIBAL[i + 1]; break; }
    }
  }
  const t = a === b ? 0 : (ft - a.ft) / (b.ft - a.ft);
  // 風向は最短の角度経路で補間(例: 350°→020° は北回り)
  const delta = ((b.dir - a.dir + 540) % 360) - 180;
  const dir = (a.dir + delta * t + 360) % 360;
  const kt = a.kt + (b.kt - a.kt) * t;
  const toRad = ((dir + 180) * Math.PI) / 180; // FROM → 進行方向
  const ms = kt * KT2MS;
  return { dir, kt, vx: ms * Math.sin(toRad), vz: -ms * Math.cos(toRad) };
}

// ---- three.js セットアップ ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec8e8);
scene.fog = new THREE.Fog(0x9ec8e8, 4000, 16000);

scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x54604a, 0.9));
const sun = new THREE.DirectionalLight(0xfff2df, 1.6);
sun.position.set(-3000, 5000, -2000);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 40000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.maxPolarAngle = Math.PI * 0.52;
controls.minDistance = 25;
controls.maxDistance = 600;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// 編みかご風テクスチャ(Canvasで生成。横方向の籐の束を段違いに重ねた見た目)
function buildWickerTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#5d451f';
  ctx.fillRect(0, 0, 128, 128);
  const rowH = 16, segW = 32;
  for (let y = 0, r = 0; y < 128; y += rowH, r++) {
    const off = (r % 2) * (segW / 2);
    for (let x = -segW; x < 128 + segW; x += segW) {
      const grad = ctx.createLinearGradient(0, y, 0, y + rowH);
      grad.addColorStop(0, '#8a6a3c');
      grad.addColorStop(0.45, '#b28a54');
      grad.addColorStop(1, '#6d5127');
      ctx.fillStyle = grad;
      ctx.fillRect(x + off + 1, y + 1, segW - 2, rowH - 2);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ゴア(縦の縫い目パネル)模様のテクスチャ。bright=true は内面用の明るい配色
function buildGoreTexture(bright) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 64;
  const ctx = cv.getContext('2d');
  const gores = 16, w = 512 / gores;
  const cols = bright ? ['#e0584a', '#c94434'] : ['#c62828', '#a81f1f'];
  const seam = bright ? '#a83028' : '#7a1515';
  for (let i = 0; i < gores; i++) {
    ctx.fillStyle = cols[i % 2];
    ctx.fillRect(i * w, 0, w, 64);
    ctx.fillStyle = seam;
    ctx.fillRect(i * w, 0, 2, 64);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- 気球(プレースホルダ形状) ----
const BASKET_W = 1.4, BASKET_H = 1.1, WALL_T = 0.06, BURNER_Y = 2.0;
function buildBalloon() {
  const g = new THREE.Group(); // 原点 = バスケット底面(接地点)
  const envMat = new THREE.MeshLambertMaterial({ map: buildGoreTexture(false) });
  const env = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 18), envMat);
  env.scale.set(1, 1.12, 1);
  env.position.y = 16.5;
  g.add(env);
  // 球皮の内面(見上げたときに見える側)。日光が透けた明るい布として自発光風に描く
  const envInnerMat = new THREE.MeshBasicMaterial({
    map: buildGoreTexture(true), side: THREE.BackSide,
  });
  const envInner = new THREE.Mesh(new THREE.SphereGeometry(8.8, 24, 18), envInnerMat);
  envInner.scale.set(1, 1.12, 1);
  envInner.position.y = 16.5;
  g.add(envInner);

  // スカート(球皮の口からバーナー上方へ絞る布)。上端半径3.0は球皮の
  // y=7.0における断面半径と一致させ、継ぎ目が浮かないようにしている
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(3.0, 1.5, 3.2, 20, 1, true),
    new THREE.MeshLambertMaterial({ color: 0xb52a2a, side: THREE.DoubleSide }));
  skirt.position.y = 5.4;
  g.add(skirt);

  // 四角い編みかごのゴンドラ(4面の壁+床。内側からも見えるようDoubleSide)
  const wicker = buildWickerTexture();
  wicker.repeat.set(3, 3);
  const wickerMat = new THREE.MeshLambertMaterial({ map: wicker, side: THREE.DoubleSide });
  const half = BASKET_W / 2 - WALL_T / 2;
  for (const [w, d, x, z] of [
    [BASKET_W, WALL_T, 0, half], [BASKET_W, WALL_T, 0, -half],   // 前後の壁
    [WALL_T, BASKET_W, half, 0], [WALL_T, BASKET_W, -half, 0],   // 左右の壁
  ]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, BASKET_H, d), wickerMat);
    wall.position.set(x, BASKET_H / 2, z);
    g.add(wall);
  }
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(BASKET_W, WALL_T, BASKET_W),
    new THREE.MeshLambertMaterial({ color: 0x4a3620 }));
  floor.position.y = WALL_T / 2;
  g.add(floor);

  // 上縁の革張りリム(4辺の横棒。壁の上面を覆って縞の露出を隠す)
  const rimMat = new THREE.MeshLambertMaterial({ color: 0x3e2b18 });
  for (const [len, rot, x, z] of [
    [BASKET_W + 0.14, 0, 0, half], [BASKET_W + 0.14, 0, 0, -half],
    [BASKET_W + 0.14, Math.PI / 2, half, 0], [BASKET_W + 0.14, Math.PI / 2, -half, 0],
  ]) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, len, 10), rimMat);
    rim.rotation.z = Math.PI / 2;
    rim.rotation.y = rot;
    rim.position.set(x, BASKET_H, z);
    g.add(rim);
  }

  // 四隅の支柱(革巻き風。バスケット上縁→スカート裾まで)+バーナー本体
  const POLE_TOP = 3.9; // スカート裾(y=3.8)に届く高さ
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x5c3a26 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, POLE_TOP - BASKET_H, 6), poleMat);
      pole.position.set(sx * (half - 0.05), (POLE_TOP + BASKET_H) / 2, sz * (half - 0.05));
      g.add(pole);
    }
  }
  const burnerUnit = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.26, 0.32, 10),
    new THREE.MeshLambertMaterial({ color: 0x555555 }));
  burnerUnit.position.y = BURNER_Y;
  g.add(burnerUnit);

  // リップライン(ゴンドラから気球の口まで伸びる赤いロープ)
  const ropeBaseY = 4.5; // 中心y。長さ5.2でおよそ y=1.9〜7.1
  const rope = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 5.2, 6),
    new THREE.MeshBasicMaterial({ color: 0xd32f2f }));
  rope.position.set(0.3, ropeBaseY, 0.3);
  g.add(rope);

  // バーナー炎(外側オレンジ+芯の黄色の二重コーン)。バーナー上端から上へ吹き上がる。
  // 底面なし(openEnded)にして、ゴンドラから見上げたときも自然に見えるようにする
  const flame = new THREE.Group();
  const flameMatOpts = { transparent: true, side: THREE.DoubleSide };
  const flameOuter = new THREE.Mesh(
    new THREE.ConeGeometry(0.35, 1.8, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff8a30, opacity: 0.85, ...flameMatOpts }));
  flame.add(flameOuter);
  const flameCore = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 1.2, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffe082, opacity: 0.95, ...flameMatOpts }));
  flameCore.position.y = -0.25;
  flame.add(flameCore);
  flame.position.y = BURNER_Y + 1.3; // 基部 y≈2.4 からバーナー上方へ吹き上がる
  flame.visible = false;
  g.add(flame);
  const flameLight = new THREE.PointLight(0xffa040, 0, 60);
  flameLight.position.y = BURNER_Y + 1.1;
  g.add(flameLight);
  return { group: g, flame, flameLight, envInnerMat, rope, ropeBaseY };
}

// ---- JDGターゲット(オレンジのX+白リング) ----
function buildTarget(x, z, groundY) {
  const g = new THREE.Group();
  const armMat = new THREE.MeshBasicMaterial({ color: 0xff5a00 });
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(16, 0.2, 2.6), armMat);
    arm.rotation.y = rot;
    g.add(arm);
  }
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(24, 25.5, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  g.position.set(x, groundY + 0.4, z);
  return g;
}

// ---- マーカー(重り+リボン+視認用グロー) ----
function buildMarkerMesh() {
  const g = new THREE.Group();
  const weight = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 10, 8),
    new THREE.MeshLambertMaterial({ color: 0xd32f2f }));
  g.add(weight);
  const ribbon = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 4.5),
    new THREE.MeshBasicMaterial({ color: 0xffee58, side: THREE.DoubleSide }));
  ribbon.position.y = 2.6;
  g.add(ribbon);
  // 落下中でも見失わないよう、常にカメラを向く淡い光のスプライトを重ねる
  const spCv = document.createElement('canvas');
  spCv.width = spCv.height = 64;
  const sctx = spCv.getContext('2d');
  const grad = sctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,235,80,0.85)');
  grad.addColorStop(1, 'rgba(255,235,80,0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 64, 64);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(spCv), transparent: true, depthWrite: false,
  }));
  glow.scale.set(3, 3, 1);
  g.add(glow);
  return g;
}

// ---- サウンド(Web Audio合成、外部ファイル不要) ----
// ブラウザの自動再生制限があるため、初回のユーザー操作で初期化し、
// suspended のままなら操作のたびに resume する(前回鳴らなかった原因への対処)
let audioCtx = null, burnerGain = null, ripGain = null, windGain = null;
let sndBurnerOn = false, sndRipOn = false;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const noise = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const makeLoop = (type, freq, q) => {
      const src = audioCtx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = audioCtx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0;
      src.connect(filter).connect(gainNode).connect(audioCtx.destination);
      src.start();
      return gainNode;
    };
    burnerGain = makeLoop('bandpass', 600, 0.6);   // バーナーの噴射音(ゴーッ)
    ripGain = makeLoop('bandpass', 2600, 0.9);     // リップラインの排気音(シューッ)
    windGain = makeLoop('lowpass', 380, 0.4);      // 風のアンビエント
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
addEventListener('keydown', ensureAudio);
addEventListener('pointerdown', ensureAudio);

// 毎フレーム呼ばれ、入力状態・風速に音量を追従させる
function updateSounds(windKt) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const bOn = input.burner && state.fuel > 0;
  if (bOn !== sndBurnerOn) {
    sndBurnerOn = bOn;
    burnerGain.gain.setTargetAtTime(bOn ? 0.4 : 0, t, bOn ? 0.04 : 0.18);
  }
  if (input.rip !== sndRipOn) {
    sndRipOn = input.rip;
    ripGain.gain.setTargetAtTime(input.rip ? 0.25 : 0, t, input.rip ? 0.04 : 0.12);
  }
  windGain.gain.setTargetAtTime(THREE.MathUtils.clamp(windKt / 40, 0, 1) * 0.15, t, 0.4);
}

// ---- 入力 ----
const input = { burner: false, rip: false };
let timeScale = 1;
let fpv = false;
let flightReady = false; // 離陸前のキー入力を無視する
let started = false;     // 離陸済みかどうか(物理・時計は離陸後のみ進む)
let remaining = TASK_LIMIT_S;
let expired = false;

// 一人称視点(ゴンドラ視点)。目の位置は固定し、視線方向だけをドラッグで回す
let fpvYaw = 0, fpvPitch = 0;
const EYE_HEIGHT = 1.85;
const LOOK_SPEED = 0.0038;
const PITCH_LIMIT = THREE.MathUtils.degToRad(85);
const look = { dragging: false, lastX: 0, lastY: 0 };

function toggleFpv() {
  if (!started) return;
  fpv = !fpv;
  applyViewMode();
  if (!fpv) {
    // ゴンドラ視点から戻るときは、見ていた方向の後方に回り込む
    const horiz = new THREE.Vector3(Math.sin(fpvYaw), 0, -Math.cos(fpvYaw));
    const tgt = new THREE.Vector3(state.pos.x, state.pos.y + 12, state.pos.z);
    camera.position.copy(tgt).addScaledVector(horiz, -90).add(new THREE.Vector3(0, 35, 0));
    controls.target.copy(tgt);
  }
}
function togglePibal() {
  const p = document.getElementById('pibal');
  p.style.display = p.style.display === 'none' ? '' : 'none';
}
function cycleTimeScale() {
  const seq = [1, 2, 4, 8];
  timeScale = seq[(seq.indexOf(timeScale) + 1) % seq.length];
  document.getElementById('tscale').textContent = timeScale;
  const btn = document.getElementById('tc-tscale');
  if (btn) btn.textContent = `×${timeScale}`;
}

addEventListener('keydown', (e) => {
  if (e.code === 'Space') { input.burner = true; e.preventDefault(); }
  if (e.code === 'KeyR') input.rip = true;
  if (e.code === 'KeyV') toggleFpv();
  if (e.code === 'KeyM' && flightReady) dropMarker();
  if (e.code === 'KeyP') togglePibal();
  if (e.code >= 'Digit1' && e.code <= 'Digit4') {
    timeScale = [1, 2, 4, 8][Number(e.code.slice(5)) - 1];
    document.getElementById('tscale').textContent = timeScale;
    const btn = document.getElementById('tc-tscale');
    if (btn) btn.textContent = `×${timeScale}`;
  }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') input.burner = false;
  if (e.code === 'KeyR') input.rip = false;
});

// ---- タッチ操作ボタン(スマホ・タブレットなどタッチ端末向け) ----
const isTouchDevice = matchMedia('(hover: none) and (pointer: coarse)').matches;
if (isTouchDevice) {
  document.getElementById('pibal').style.display = 'none'; // 初期状態は隠して画面を広く使う
}
function setupTouchControls() {
  function holdButton(btn, onDown, onUp) {
    const down = (e) => { e.preventDefault(); btn.classList.add('active'); onDown(); };
    const up = () => { btn.classList.remove('active'); onUp(); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
  }
  holdButton(document.getElementById('tc-burner'),
    () => { input.burner = true; }, () => { input.burner = false; });
  holdButton(document.getElementById('tc-rip'),
    () => { input.rip = true; }, () => { input.rip = false; });
  document.getElementById('tc-marker').addEventListener('click', () => {
    if (flightReady) dropMarker();
  });
  document.getElementById('tc-view').addEventListener('click', toggleFpv);
  document.getElementById('tc-tscale').addEventListener('click', cycleTimeScale);
  document.getElementById('tc-pibal').addEventListener('click', togglePibal);
}
setupTouchControls();

// ゴンドラ視点でのルック操作(ドラッグで視線方向を回転。目の位置は動かさない)
// pointerイベントなのでマウスでもタッチでも同じコードで動く
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!fpv || !started) return;
  renderer.domElement.setPointerCapture(e.pointerId);
  look.dragging = true;
  look.lastX = e.clientX;
  look.lastY = e.clientY;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!look.dragging) return;
  const dx = e.clientX - look.lastX, dy = e.clientY - look.lastY;
  look.lastX = e.clientX;
  look.lastY = e.clientY;
  fpvYaw -= dx * LOOK_SPEED;
  fpvPitch = THREE.MathUtils.clamp(fpvPitch - dy * LOOK_SPEED, -PITCH_LIMIT, PITCH_LIMIT);
});
renderer.domElement.addEventListener('pointerup', () => { look.dragging = false; });
renderer.domElement.addEventListener('pointercancel', () => { look.dragging = false; });

function applyViewMode() {
  if (fpv) {
    // 現在の視線方向を引き継いでゴンドラ視点に入る(切り替え時の違和感を減らす)
    const dir = new THREE.Vector3().subVectors(controls.target, camera.position).normalize();
    fpvYaw = Math.atan2(dir.x, -dir.z);
    fpvPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    controls.enabled = false;
  } else {
    controls.enabled = true;
  }
}

// ---- 飛行中HUDのパイバル表を描画 ----
function renderFlightPibal() {
  document.getElementById('pibal-body').innerHTML = PIBAL
    .map((r) => `<tr><td>${r.ft}</td><td>${String(Math.round(r.dir)).padStart(3, '0')}</td><td>${r.kt}</td></tr>`)
    .join('');
}
renderFlightPibal();

// ---- 住所検索でエリア移動(画面上に常時表示、いつでも使える) ----
// 選んだ場所は ?a=lon,lat を付けて再読み込みすることで反映する
// (地形はエリアごとに丸ごと作り直すので、その場での切り替えはせずリロードする)
function setupAddressSearch() {
  const input = document.getElementById('area-search-input');
  const btn = document.getElementById('area-search-btn');
  const list = document.getElementById('area-search-results');
  const overlay = document.getElementById('address-map-overlay');
  const mapTitle = document.getElementById('address-map-title');
  const mapCanvas = document.getElementById('area-search-map');
  const goBtn = document.getElementById('area-search-go');
  const cancelBtn = document.getElementById('area-search-cancel');

  let mapApi = null;
  let pending = null; // { lon, lat } 現在マップ上で選択されている地点

  function openMapAt(lon, lat, name) {
    overlay.style.display = '';
    mapTitle.textContent = name ? `位置を確認: ${name}` : '位置を確認';
    if (!mapApi) {
      mapApi = setupAreaMap(mapCanvas, (lon2, lat2) => { pending = { lon: lon2, lat: lat2 }; });
    }
    mapApi.jumpTo(lon, lat, 13);
    mapApi.select(lon, lat, name);
    pending = { lon, lat };
  }
  function closeMap() { overlay.style.display = 'none'; }

  async function search() {
    const q = input.value.trim();
    if (!q) { list.innerHTML = ''; return; }
    list.innerHTML = '<li class="as-empty">検索中…</li>';
    try {
      const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(String(res.status));
      const items = await res.json();
      if (!Array.isArray(items) || !items.length) {
        list.innerHTML = '<li class="as-empty">見つかりませんでした</li>';
        return;
      }
      list.innerHTML = items.slice(0, 8).map((it) => {
        const [lon, lat] = it.geometry.coordinates;
        return `<li data-lon="${lon}" data-lat="${lat}" data-name="${it.properties.title}">${it.properties.title}</li>`;
      }).join('');
      // 一番上の候補を自動で全画面マップに表示(住所検索は大まかな一致になりがちなので、
      // ここで実際の位置を目で見て微調整できるようにする)
      const [lon0, lat0] = items[0].geometry.coordinates;
      openMapAt(lon0, lat0, items[0].properties.title);
    } catch {
      list.innerHTML = '<li class="as-empty">検索に失敗しました</li>';
    }
  }

  btn.addEventListener('click', search);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-lon]');
    if (!li) return;
    openMapAt(Number(li.dataset.lon), Number(li.dataset.lat), li.dataset.name);
  });

  cancelBtn.addEventListener('click', closeMap);
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') closeMap();
  });

  goBtn.addEventListener('click', () => {
    if (!pending) return;
    const { lon, lat } = pending;
    if (lon < 122 || lon > 148 || lat < 24 || lat > 46) {
      closeMap();
      list.innerHTML = '<li class="as-empty">日本国内のみ対応しています</li>';
      return;
    }
    const p = new URLSearchParams(location.search);
    p.set('a', `${lon.toFixed(4)},${lat.toFixed(4)}`);
    location.href = `${location.pathname}?${p.toString()}`;
  });
}
setupAddressSearch();

// ---- 「使い方」「本格モード」オーバーレイ(リンク付きの簡易情報パネル) ----
function setupLinkOverlay(linkId, overlayId, closeBtnId) {
  const link = document.getElementById(linkId);
  const overlay = document.getElementById(overlayId);
  const closeBtn = document.getElementById(closeBtnId);
  link.addEventListener('click', (e) => {
    e.preventDefault();
    overlay.style.display = '';
  });
  closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') overlay.style.display = 'none';
  });
}
setupLinkOverlay('howto-link', 'howto-overlay', 'howto-close');
setupLinkOverlay('setup-link', 'setup-overlay', 'setup-close');

// 「お試しでやってみる」: SORAに残っているフルJDGブリーフィング機能(?setup=1)を試せる
// (hot-air-balloon1の最新版ではないが、機能自体はSORA内にそのまま残っている)
document.getElementById('setup-try').addEventListener('click', () => {
  const p = new URLSearchParams(location.search);
  p.set('setup', '1');
  location.href = `${location.pathname}?${p.toString()}`;
});

// ---- エリア選択画面(日本全図のスリッピーマップ+プリセット) ----
function selectArea() {
  return new Promise((resolve) => {
    const el = document.getElementById('areasel');
    const btn = document.getElementById('area-btn');
    el.style.display = '';
    let sel = null;

    const map = setupAreaMap(document.getElementById('area-map'), (lon, lat, name) => {
      sel = { lon, lat, name };
      btn.disabled = false;
      btn.textContent = `このエリアで飛ぶ(${name || `${lat.toFixed(3)}N, ${lon.toFixed(3)}E`})`;
    });

    const presetBox = document.getElementById('area-presets');
    presetBox.innerHTML = PRESET_AREAS
      .map((p, i) => `<button type="button" data-i="${i}">${p.name}</button>`)
      .join('');
    presetBox.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const p = PRESET_AREAS[Number(b.dataset.i)];
      map.jumpTo(p.lon, p.lat);
      map.select(p.lon, p.lat, p.name);
    });

    btn.addEventListener('click', () => {
      if (!sel) return;
      el.style.display = 'none';
      resolve(sel);
    });
  });
}

// マウスとタッチを共通で扱うためのヘルパー。
// 1本指ドラッグ=パン、動かず離す=タップ選択、2本指ピンチ=ズーム。
// (マウスのホイールズームは呼び出し側で別途 'wheel' を扱う)
function enablePointerNav(cv, cssRatio, { onPanStart, onPan, onTap, onZoom }) {
  const pointers = new Map();
  let mode = null; // 'pan' | 'pinch'
  let dragStart = null;
  let pinchDist = 0;

  function rectOffset(clientX, clientY) {
    const r = cv.getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  }

  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      mode = 'pan';
      dragStart = { cx: e.clientX, cy: e.clientY, moved: false };
      onPanStart();
    } else if (pointers.size === 2) {
      mode = 'pinch';
      const [p1, p2] = [...pointers.values()];
      pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pan' && pointers.size === 1) {
      const dx = (e.clientX - dragStart.cx) * cssRatio();
      const dy = (e.clientY - dragStart.cy) * cssRatio();
      if (Math.abs(dx) + Math.abs(dy) > 6) dragStart.moved = true;
      if (dragStart.moved) onPan(dx, dy);
    } else if (mode === 'pinch' && pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinchDist > 0 && (dist / pinchDist > 1.15 || dist / pinchDist < 0.87)) {
        const [ox, oy] = rectOffset((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
        onZoom(ox, oy, dist > pinchDist ? 1 : -1);
        pinchDist = dist;
      }
    }
  });
  function end(e) {
    if (pointers.has(e.pointerId)) {
      if (mode === 'pan' && pointers.size === 1 && !dragStart.moved) {
        onTap(...rectOffset(e.clientX, e.clientY));
      }
      pointers.delete(e.pointerId);
    }
    if (pointers.size === 0) {
      mode = null; dragStart = null;
    } else if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      mode = 'pan';
      dragStart = { cx: p.x, cy: p.y, moved: true }; // 2本指→1本指の切替時は誤タップを防ぐ
    }
  }
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

function setupAreaMap(cv, onSelect) {
  const ctx = cv.getContext('2d');
  let z = 5;
  let c = lonLatToTile(137.0, 38.0, z); // 日本全体が入る初期ビュー
  let sel = null;

  const tiles = new Map();
  function getTile(zz, tx, ty) {
    const key = `${zz}/${tx}/${ty}`;
    const v = tiles.get(key);
    if (v) return v instanceof ImageBitmap ? v : null;
    tiles.set(key, 'loading');
    fetch(`https://cyberjapandata.gsi.go.jp/xyz/std/${zz}/${tx}/${ty}.png`)
      .then((r) => { if (!r.ok) throw 0; return r.blob(); })
      .then(createImageBitmap)
      .then((bmp) => { tiles.set(key, bmp); render(); })
      .catch(() => tiles.set(key, 'error'));
    return null;
  }

  const cssRatio = () => cv.width / cv.clientWidth;
  const toScreen = (tx, ty) => [(tx - c.x) * 256 + cv.width / 2, (ty - c.y) * 256 + cv.height / 2];
  const toTile = (sx, sy) => [(sx - cv.width / 2) / 256 + c.x, (sy - cv.height / 2) / 256 + c.y];
  const tileToLonLat = (tx, ty) => [
    (tx / 2 ** z) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** z))) * 180) / Math.PI,
  ];

  function render() {
    ctx.fillStyle = '#0d1620';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const n = 2 ** z;
    const [txL, tyT] = toTile(0, 0);
    const [txR, tyB] = toTile(cv.width, cv.height);
    for (let ty = Math.max(0, Math.floor(tyT)); ty <= Math.min(n - 1, Math.floor(tyB)); ty++) {
      for (let tx = Math.max(0, Math.floor(txL)); tx <= Math.min(n - 1, Math.floor(txR)); tx++) {
        const bmp = getTile(z, tx, ty);
        if (!bmp) continue;
        const [sx, sy] = toScreen(tx, ty);
        ctx.drawImage(bmp, sx, sy, 256.5, 256.5);
      }
    }
    if (sel) {
      const t = lonLatToTile(sel.lon, sel.lat, z);
      const [sx, sy] = toScreen(t.x, t.y);
      // この緯度・ズームでの1画面ピクセルあたりの実距離から20km枠を描く
      const mpp = (156543.03392 * Math.cos((sel.lat * Math.PI) / 180)) / 2 ** z;
      const box = 20460 / mpp;
      ctx.strokeStyle = '#ff5a00';
      ctx.lineWidth = 3;
      ctx.strokeRect(sx - box / 2, sy - box / 2, box, box);
      ctx.beginPath();
      ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy);
      ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8);
      ctx.stroke();
    }
  }

  function zoomAt(ox, oy, dir) {
    const nz = THREE.MathUtils.clamp(z + dir, 4, 16);
    if (nz === z) return;
    const r = cssRatio();
    const [fx, fy] = toTile(ox * r, oy * r);
    const k = 2 ** (nz - z);
    z = nz;
    c = {
      x: fx * k - (ox * r - cv.width / 2) / 256,
      y: fy * k - (oy * r - cv.height / 2) / 256,
    };
    render();
  }
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  let panOrigin = null;
  enablePointerNav(cv, cssRatio, {
    onPanStart: () => { panOrigin = { x: c.x, y: c.y }; },
    onPan: (dx, dy) => {
      c = { x: panOrigin.x - dx / 256, y: panOrigin.y - dy / 256 };
      render();
    },
    onTap: (ox, oy) => {
      const r = cssRatio();
      const [fx, fy] = toTile(ox * r, oy * r);
      const [lon, lat] = tileToLonLat(fx, fy);
      select(lon, lat, null);
    },
    onZoom: zoomAt,
  });

  function select(lon, lat, name) {
    sel = { lon, lat, name };
    render();
    onSelect(lon, lat, name);
  }
  function jumpTo(lon, lat, zz) {
    z = zz || 10;
    c = lonLatToTile(lon, lat, z);
    render();
  }
  render();
  return { select, jumpTo };
}

// ---- メイン ----
// 既定では競技のルール説明(エリア選択・ブリーフィング画面)を省き、即フライト画面から始める。
// 実際のJDG競技のようにエリア/風/離陸地点を自分で選びたい場合は URL に ?setup=1 を付ける。
const mainParams = new URLSearchParams(location.search);
const setupMode = mainParams.has('setup');
const hasChosenArea = mainParams.has('a'); // 住所検索や共有URLなどで明示的にエリアが指定されているか
AREA = decodeArea(mainParams.get('a'));
if (!AREA) AREA = setupMode ? await selectArea() : PRESET_AREAS[0];

const loadingEl = document.getElementById('loading');
document.getElementById('load-title').textContent =
  `${AREA.name || `${AREA.lat.toFixed(3)}N ${AREA.lon.toFixed(3)}E`} の地形を読み込み中…`;
loadingEl.style.display = '';

const loadEl = document.getElementById('load-progress');
const terrain = await buildTerrain(AREA.lon, AREA.lat, TILE_RADIUS,
  (done, total) => { loadEl.textContent = `${done} / ${total}`; });
scene.add(terrain.group);
loadingEl.remove();

// ---- ブリーフィング(タスクシート+パイバル編集+離陸地点選択) ----
// setupMode のときだけ構築する(既定モードでは風は既定値/URL指定のまま使う)
if (setupMode) setupWindEditor();

function setupWindEditor() {
  const sel = document.getElementById('wind-preset');
  sel.innerHTML = WIND_PRESETS
    .map((p, i) => `<option value="${i}">${p.name}</option>`)
    .join('') + '<option value="custom">カスタム</option>';
  if (new URLSearchParams(location.search).has('w')) sel.value = 'custom';
  renderEditorRows(PIBAL);

  sel.addEventListener('change', () => {
    if (sel.value === 'custom') return;
    renderEditorRows(WIND_PRESETS[Number(sel.value)].rows.map(toRowObj));
  });
  document.getElementById('wind-add').addEventListener('click', () => {
    const rows = readEditorRows();
    const last = rows[rows.length - 1];
    rows.push(last ? { ft: last.ft + 1000, dir: last.dir, kt: last.kt } : { ft: 0, dir: 180, kt: 5 });
    renderEditorRows(rows);
    sel.value = 'custom';
  });
  const editor = document.getElementById('wind-editor');
  editor.addEventListener('input', () => { sel.value = 'custom'; });
  editor.addEventListener('click', (e) => {
    if (!e.target.classList.contains('del')) return;
    if (editor.querySelectorAll('tr').length <= 1) return; // 最低1行は残す
    e.target.closest('tr').remove();
    sel.value = 'custom';
  });
  document.getElementById('wind-copy').addEventListener('click', (e) => {
    applyWindFromEditor();
    copyShare(e.target);
  });
}

function renderEditorRows(rows) {
  document.getElementById('wind-editor').innerHTML = rows.map((r) =>
    `<tr><td><input type="number" class="w-ft" step="100" min="0" value="${r.ft}"></td>` +
    `<td><input type="number" class="w-dir" step="10" min="0" max="360" value="${r.dir}"></td>` +
    `<td><input type="number" class="w-kt" step="1" min="0" value="${r.kt}"></td>` +
    `<td><button type="button" class="del" title="行を削除">×</button></td></tr>`).join('');
}

function readEditorRows() {
  return [...document.querySelectorAll('#wind-editor tr')]
    .map((tr) => ({
      ft: Number(tr.querySelector('.w-ft').value),
      dir: ((Number(tr.querySelector('.w-dir').value) % 360) + 360) % 360,
      kt: Number(tr.querySelector('.w-kt').value),
    }))
    .filter((r) => Number.isFinite(r.ft) && Number.isFinite(r.dir) && Number.isFinite(r.kt)
      && r.ft >= 0 && r.kt >= 0)
    .sort((a, b) => a.ft - b.ft);
}

// エディタの内容を有効な風テーブルとして確定し、URLにも反映する
function applyWindFromEditor() {
  const rows = readEditorRows();
  if (rows.length) PIBAL = rows;
  renderFlightPibal();
  history.replaceState(null, '', shareUrl());
}

function copyShare(btn) {
  const orig = btn.textContent;
  navigator.clipboard.writeText(shareUrl())
    .then(() => { btn.textContent = 'コピーしました!'; })
    .catch(() => { btn.textContent = 'コピー失敗'; })
    .finally(() => setTimeout(() => { btn.textContent = orig; }, 1600));
}
document.getElementById('result-share').addEventListener('click', (e) => copyShare(e.target));

const launchSel = { x: null, z: null };
// setupMode: フルのJDGブリーフィング(タスクシート+風編集+離陸地点選択)を表示。
// hasChosenArea(住所検索などで来た場合): タスクシート/風編集は省き、離陸地点選択の地図だけを表示する
// それ以外(初回起動時の既定エリア): ブリーフィング自体を作らず、従来通り即フライト開始する
// (defaultLaunchPoint() で妥当な地点をあらかじめ選択済みにしておき、
//  そのまま「離陸!」を押してもいいし、地図をクリックして選び直してもいい)
if (setupMode || hasChosenArea) {
  const launchMapApi = setupLaunchMap();
  document.getElementById('briefing').style.display = '';
  if (setupMode) {
    document.getElementById('briefing-title').textContent = 'タスクブリーフィング';
  } else {
    document.getElementById('briefing').classList.add('quick-launch');
    document.getElementById('briefing-title').textContent = '地図で離陸地点を選択してください';
    const dp = defaultLaunchPoint();
    launchMapApi.selectAt(dp.x, dp.z);
  }
}

// ブリーフィング地図: ズーム(ホイール)+パン(ドラッグ)可能な簡易スリッピーマップ。
// ズームに応じて標準地図タイルを z11〜z17 から選んで表示する
function setupLaunchMap() {
  const cv = document.getElementById('launch-map');
  const ctx = cv.getContext('2d');
  const M = terrain.map;
  const tm13 = terrain.tileMeters;            // z13タイルの一辺(m)
  const c13x = M.x0 - M.minX / tm13;          // 世界原点のz13タイル座標
  const c13y = M.y0 - M.minZ / tm13;
  const fitScale = cv.width / terrain.sizeMeters; // 全域表示のpx/m
  const MAX_SCALE = 1.0;
  const view = {
    x: M.minX + terrain.sizeMeters / 2,
    z: M.minZ + terrain.sizeMeters / 2,
    scale: fitScale,
  };

  const tiles = new Map(); // "z/x/y" -> ImageBitmap | 'loading' | 'error'
  function getTile(z, tx, ty) {
    const key = `${z}/${tx}/${ty}`;
    const v = tiles.get(key);
    if (v) return v instanceof ImageBitmap ? v : null;
    tiles.set(key, 'loading');
    fetch(`https://cyberjapandata.gsi.go.jp/xyz/std/${z}/${tx}/${ty}.png`)
      .then((r) => { if (!r.ok) throw 0; return r.blob(); })
      .then(createImageBitmap)
      .then((bmp) => { tiles.set(key, bmp); render(); })
      .catch(() => tiles.set(key, 'error'));
    return null;
  }

  const cssRatio = () => cv.width / cv.clientWidth;
  const worldToScreen = (wx, wz) => [
    (wx - view.x) * view.scale + cv.width / 2,
    (wz - view.z) * view.scale + cv.height / 2,
  ];
  const screenToWorld = (sx, sy) => [
    (sx - cv.width / 2) / view.scale + view.x,
    (sy - cv.height / 2) / view.scale + view.z,
  ];
  function clampView() {
    const half = cv.width / 2 / view.scale;
    view.x = THREE.MathUtils.clamp(view.x, M.minX + half, M.minX + terrain.sizeMeters - half);
    view.z = THREE.MathUtils.clamp(view.z, M.minZ + half, M.minZ + terrain.sizeMeters - half);
  }

  function render() {
    ctx.fillStyle = '#0d1620';
    ctx.fillRect(0, 0, cv.width, cv.height);

    // 表示解像度に合ったタイルズームを選ぶ
    let z = Math.round(13 + Math.log2((view.scale * tm13) / 256));
    z = THREE.MathUtils.clamp(z, 11, 17);
    const f = 2 ** (z - 13);
    const tmz = tm13 / f;

    const [wL, wT] = screenToWorld(0, 0);
    const [wR, wB] = screenToWorld(cv.width, cv.height);
    const txMin = Math.max(Math.floor((c13x + wL / tm13) * f), Math.floor(M.x0 * f));
    const txMax = Math.min(Math.floor((c13x + wR / tm13) * f), Math.ceil((M.x0 + M.n) * f) - 1);
    const tyMin = Math.max(Math.floor((c13y + wT / tm13) * f), Math.floor(M.y0 * f));
    const tyMax = Math.min(Math.floor((c13y + wB / tm13) * f), Math.ceil((M.y0 + M.n) * f) - 1);
    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const bmp = getTile(z, tx, ty);
        if (!bmp) continue;
        const [sx, sy] = worldToScreen((tx / f - c13x) * tm13, (ty / f - c13y) * tm13);
        const s = tmz * view.scale;
        ctx.drawImage(bmp, sx, sy, s + 0.5, s + 0.5);
      }
    }

    // ターゲット(橙X+白丸)
    const [tx, ty] = worldToScreen(TARGET_XZ.x, TARGET_XZ.z);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(tx, ty, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#ff5a00';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(tx - 11, ty - 11); ctx.lineTo(tx + 11, ty + 11);
    ctx.moveTo(tx - 11, ty + 11); ctx.lineTo(tx + 11, ty - 11);
    ctx.stroke();
    // 選択中の離陸地点(赤丸)
    if (launchSel.x !== null) {
      const [lx, ly] = worldToScreen(launchSel.x, launchSel.z);
      ctx.fillStyle = '#e53935';
      ctx.beginPath();
      ctx.arc(lx, ly, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(lx, ly, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function zoomAt(ox, oy, dir) {
    const [wx, wz] = screenToWorld(ox * cssRatio(), oy * cssRatio());
    const k = dir > 0 ? 1.3 : 1 / 1.3;
    view.scale = THREE.MathUtils.clamp(view.scale * k, fitScale, MAX_SCALE);
    // カーソル/指の位置の地点が動かないように中心を合わせ直す
    view.x = wx - (ox * cssRatio() - cv.width / 2) / view.scale;
    view.z = wz - (oy * cssRatio() - cv.height / 2) / view.scale;
    clampView();
    render();
  }
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  let panOrigin = null;
  enablePointerNav(cv, cssRatio, {
    onPanStart: () => { panOrigin = { x: view.x, z: view.z }; },
    onPan: (dx, dy) => {
      view.x = panOrigin.x - dx / view.scale;
      view.z = panOrigin.z - dy / view.scale;
      clampView();
      render();
    },
    onTap: (ox, oy) => {
      const [wx, wz] = screenToWorld(ox * cssRatio(), oy * cssRatio());
      selectAt(wx, wz);
    },
    onZoom: zoomAt,
  });

  function selectAt(wx, wz) {
    launchSel.x = THREE.MathUtils.clamp(wx, M.minX, M.minX + terrain.sizeMeters);
    launchSel.z = THREE.MathUtils.clamp(wz, M.minZ, M.minZ + terrain.sizeMeters);
    render();
    const btn = document.getElementById('launch-btn');
    btn.disabled = false;
    const d = Math.hypot(launchSel.x - TARGET_XZ.x, launchSel.z - TARGET_XZ.z);
    btn.textContent = `離陸!(ターゲットまで ${(d / 1000).toFixed(2)} km)`;
  }

  render();
  return { selectAt };
}

document.getElementById('launch-btn').addEventListener('click', () => {
  if (launchSel.x === null) return;
  if (setupMode) applyWindFromEditor(); // 離陸時点のエディタ内容で風を確定(既定モードは風エディタが無いため不要)
  startFlight(launchSel.x, launchSel.z);
});

// 既定モード(setupMode=false)の初心者向け既定離陸地点。
// ターゲットから見て風上側 約3kmに置き、そのまま飛べば自然と
// ターゲット付近へ流れていくようにする(巡航高度の目安として1500ft付近の風を採用)。
function defaultLaunchPoint() {
  const w = windAt(1500 / M2FT);
  const spd = Math.hypot(w.vx, w.vz) || 1;
  const dist = 3000;
  return { x: -(w.vx / spd) * dist, z: -(w.vz / spd) * dist };
}

function startFlight(x, z) {
  // 離陸地点とターゲット周辺は先に高解像度化しておく
  terrain.requestDetail(x, z);
  terrain.requestDetail(TARGET_XZ.x, TARGET_XZ.z);
  state.pos.set(x, terrain.getHeight(x, z), z);
  state.vy = 0;
  state.heat = 0.5;
  state.grounded = true;
  balloon.group.position.copy(state.pos);
  controls.target.copy(state.pos).add(new THREE.Vector3(0, 12, 0));
  camera.position.copy(controls.target).add(new THREE.Vector3(60, 35, 60));
  prevPos.copy(state.pos);
  document.getElementById('briefing').style.display = 'none';
  flightReady = true;
  started = true;
}

const balloon = buildBalloon();
scene.add(balloon.group);

const targetGroundY = terrain.getHeight(TARGET_XZ.x, TARGET_XZ.z);
const target = buildTarget(TARGET_XZ.x, TARGET_XZ.z, targetGroundY);
scene.add(target);

// マーカーは1本。dropped後は marker.state が物理を持つ
const marker = { available: 1, state: null, mesh: null };

function dropMarker() {
  if (marker.available <= 0 || state.grounded || expired) return;
  marker.available = 0;
  const w = windAt(state.pos.y);
  marker.state = {
    pos: state.pos.clone().add(new THREE.Vector3(0, 0.8, 0)),
    vel: new THREE.Vector3(w.vx, state.vy, w.vz), // 気球(=風)の速度を引き継ぐ
    landed: false,
  };
  marker.mesh = buildMarkerMesh();
  marker.mesh.position.copy(marker.state.pos);
  scene.add(marker.mesh);
  document.getElementById('marker-info').textContent = '投下!';
}

function stepMarker(dt) {
  const m = marker.state;
  if (!m || m.landed) return;
  const w = windAt(m.pos.y);
  // 鉛直: 重力+空気抵抗(終端速度 MARKER_TERMINAL)/ 水平: 風に漸近
  m.vel.y += (-9.81 - MARKER_DRAG * m.vel.y) * dt;
  m.vel.x += ((w.vx - m.vel.x) / MARKER_WIND_TAU) * dt;
  m.vel.z += ((w.vz - m.vel.z) / MARKER_WIND_TAU) * dt;
  m.pos.addScaledVector(m.vel, dt);

  const ground = terrain.getHeight(m.pos.x, m.pos.z);
  if (m.pos.y <= ground) {
    m.pos.y = ground + 0.3;
    m.landed = true;
    marker.mesh.position.copy(m.pos);
    onMarkerLanded(m.pos);
    return;
  }
  marker.mesh.position.copy(m.pos);
  marker.mesh.rotation.y += 2 * dt; // リボンの回転(演出)
  document.getElementById('marker-info').textContent = `落下中 ${Math.round(m.pos.y - ground)}m`;
}

function onMarkerLanded(pos) {
  const dist = Math.hypot(pos.x - TARGET_XZ.x, pos.z - TARGET_XZ.z);
  // 着地点→ターゲットの計測ライン
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(pos.x, pos.y + 1, pos.z),
    new THREE.Vector3(TARGET_XZ.x, targetGroundY + 1, TARGET_XZ.z),
  ]);
  scene.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffee58 })));
  showResult(dist, null);
}

function showResult(dist, note) {
  const prev = Number(localStorage.getItem(BEST_KEY));
  const isBest = !Number.isFinite(prev) || prev <= 0 || dist < prev;
  if (isBest) localStorage.setItem(BEST_KEY, dist.toFixed(1));

  const subs = [];
  if (note) subs.push(note);
  subs.push(isBest ? '自己ベスト更新!' : `自己ベスト: ${Number(prev).toFixed(1)} m`);
  document.getElementById('result-dist').textContent = dist.toFixed(1);
  document.getElementById('result-sub').innerHTML = subs.join('<br>');
  document.getElementById('result').style.display = '';
  document.getElementById('marker-info').textContent = `${dist.toFixed(1)} m`;
}

// 制限時間の進行。時間内に投下できなければ現在地点で計測(フォールバック)
function stepClock(dt) {
  if (expired) return;
  remaining = Math.max(0, remaining - dt);
  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(Math.floor(remaining % 60)).padStart(2, '0');
  hud.clock.textContent = `${mm}:${ss}`;
  if (remaining <= 0) {
    expired = true;
    if (!marker.state) {
      marker.available = 0;
      const d = Math.hypot(state.pos.x - TARGET_XZ.x, state.pos.z - TARGET_XZ.z);
      showResult(d, '制限時間切れ: 現在地点で計測');
    }
  }
}

document.getElementById('result-retry').addEventListener('click', () => location.reload());

// 物理状態。pos.y はバスケット底面の標高(MSL)
const state = {
  pos: new THREE.Vector3(0, terrain.getHeight(0, 0), 0),
  vy: 0,
  heat: 0.5,   // エンベロープ温度(0..1)。0.5 が中立浮力
  fuel: 100,
  grounded: true,
};
const H_NEUTRAL = 0.5;

function stepPhysics(dt) {
  if (input.burner && state.fuel > 0) {
    state.heat += 0.055 * dt;
    state.fuel = Math.max(0, state.fuel - 0.25 * dt);
  }
  if (input.rip) state.heat -= 0.16 * dt;
  state.heat -= 0.012 * dt; // 自然冷却
  state.heat = THREE.MathUtils.clamp(state.heat, 0, 1);

  // 浮力(温度差比例)と空気抵抗。加熱の効きが遅れて現れる感覚はこの一次遅れで出る
  const acc = 7.0 * (state.heat - H_NEUTRAL) - 0.5 * state.vy;
  state.vy += acc * dt;
  state.pos.y += state.vy * dt;

  const w = windAt(state.pos.y);
  if (!state.grounded) {
    state.pos.x += w.vx * dt;
    state.pos.z += w.vz * dt;
  }

  const ground = terrain.getHeight(state.pos.x, state.pos.z);
  if (state.pos.y <= ground) {
    state.pos.y = ground;
    if (state.vy < 0) state.vy = 0;
    state.grounded = true;
  } else if (state.pos.y > ground + 0.05) {
    state.grounded = false;
  }
  return w;
}

// ---- コンパス(カメラの向き=画面正面の磁方位。ターゲット方向をオレンジ印で表示) ----
const compassCv = document.getElementById('compass');
const compassCtx = compassCv.getContext('2d');
const camDirTmp = new THREE.Vector3();

function drawCompass() {
  camera.getWorldDirection(camDirTmp);
  const heading = (Math.atan2(camDirTmp.x, -camDirTmp.z) * 180 / Math.PI + 360) % 360;

  const ctx = compassCtx;
  const W = compassCv.width, C = W / 2, R = W / 2 - 10;
  ctx.clearRect(0, 0, W, W);

  // 文字盤(視線方向が常に上。北の文字が回る)
  ctx.save();
  ctx.translate(C, C);
  ctx.rotate((-heading * Math.PI) / 180);
  for (let d = 0; d < 360; d += 30) {
    const rad = (d * Math.PI) / 180;
    const isCard = d % 90 === 0;
    ctx.strokeStyle = isCard ? '#e8f0f6' : '#5a7085';
    ctx.lineWidth = isCard ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(Math.sin(rad) * (R - (isCard ? 12 : 7)), -Math.cos(rad) * (R - (isCard ? 12 : 7)));
    ctx.lineTo(Math.sin(rad) * R, -Math.cos(rad) * R);
    ctx.stroke();
  }
  ctx.font = 'bold 20px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cards = [['N', 0, '#ff5252'], ['E', 90, '#e8f0f6'], ['S', 180, '#e8f0f6'], ['W', 270, '#e8f0f6']];
  for (const [label, deg, color] of cards) {
    const rad = (deg * Math.PI) / 180;
    ctx.save();
    ctx.translate(Math.sin(rad) * (R - 26), -Math.cos(rad) * (R - 26));
    ctx.rotate((heading * Math.PI) / 180); // 文字自体は正立させる
    ctx.fillStyle = color;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
  // ターゲット方向(オレンジの印)
  const brgT = Math.atan2(TARGET_XZ.x - state.pos.x, -(TARGET_XZ.z - state.pos.z));
  ctx.fillStyle = '#ff5a00';
  ctx.beginPath();
  ctx.arc(Math.sin(brgT) * (R - 5), -Math.cos(brgT) * (R - 5), 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 視線方向の固定ポインタ(上向き三角)と数値
  ctx.fillStyle = '#ffd54f';
  ctx.beginPath();
  ctx.moveTo(C, 4);
  ctx.lineTo(C - 7, 18);
  ctx.lineTo(C + 7, 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e8f0f6';
  ctx.font = 'bold 16px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${String(Math.round(heading)).padStart(3, '0')}°`, C, C);
}

// ---- HUD ----
const hud = {
  altFt: document.getElementById('alt-ft'),
  altM: document.getElementById('alt-m'),
  agl: document.getElementById('agl'),
  vario: document.getElementById('vario'),
  wind: document.getElementById('wind'),
  fuel: document.getElementById('fuel'),
  fuelFill: document.getElementById('fuel-fill'),
  heatFill: document.getElementById('heat-fill'),
  status: document.getElementById('status'),
  target: document.getElementById('target-info'),
  clock: document.getElementById('clock'),
};
function updateHud(w) {
  const ground = terrain.getHeight(state.pos.x, state.pos.z);
  hud.altFt.textContent = Math.round(state.pos.y * M2FT);
  hud.altM.textContent = Math.round(state.pos.y);
  hud.agl.textContent = Math.round(state.pos.y - ground);
  hud.vario.textContent = (state.vy >= 0 ? '+' : '') + state.vy.toFixed(1);
  hud.wind.textContent = `${String(Math.round(w.dir)).padStart(3, '0')}° / ${w.kt.toFixed(0)}kt`;
  hud.fuel.textContent = Math.round(state.fuel);
  hud.fuelFill.style.width = `${state.fuel}%`;
  hud.heatFill.style.width = `${state.heat * 100}%`;
  hud.status.textContent = state.grounded ? '接地' : '飛行中';

  const dxE = TARGET_XZ.x - state.pos.x;        // 東成分
  const dN = -(TARGET_XZ.z - state.pos.z);      // 北成分
  const distT = Math.hypot(dxE, dN);
  const brg = (Math.atan2(dxE, dN) * 180 / Math.PI + 360) % 360;
  hud.target.textContent =
    `${distT >= 1000 ? (distT / 1000).toFixed(2) + ' km' : Math.round(distT) + ' m'} / ${String(Math.round(brg)).padStart(3, '0')}°`;
}

// ---- カメラ初期配置 ----
balloon.group.position.copy(state.pos);
controls.target.copy(state.pos).add(new THREE.Vector3(0, 12, 0));
camera.position.copy(controls.target).add(new THREE.Vector3(60, 35, 60));
applyViewMode();

const prevPos = state.pos.clone();
const clock = new THREE.Clock();
let lastDetailCheck = 0;
let envGlow = 0;  // バーナー点火時の球皮内面の明るさ(0..1、滑らかに追従)
let ripPull = 0;  // リップラインを引いた量(0..1、滑らかに追従)

// 初回起動(既定エリア・setupなし・住所指定なし)ではブリーフィングを介さず即離陸する。
// setupMode や hasChosenArea のときは、ブリーフィングの「離陸!」ボタンで startFlight が呼ばれる。
// ?fpv=1 を付けるとゴンドラ視点で開始(視点確認用、離陸後に反映される)
if (!setupMode && !hasChosenArea) {
  const lp = defaultLaunchPoint();
  startFlight(lp.x, lp.z);
}
if (new URLSearchParams(location.search).has('fpv')) {
  fpv = true;
  applyViewMode();
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05) * timeScale;

  if (started) {
    const w = stepPhysics(dt);
    stepMarker(dt);
    stepClock(dt);
    updateSounds(w.kt);

    balloon.group.position.copy(state.pos);
    balloon.flame.visible = input.burner && state.fuel > 0;
    balloon.flameLight.intensity = balloon.flame.visible ? 40 : 0;

    // バーナー点火で球皮内面がふわっと暖色に明るくなる(点滅ではなく滑らかな変化)
    const glowTarget = balloon.flame.visible ? 1 : 0;
    envGlow += (glowTarget - envGlow) * Math.min(1, dt * 2.5);
    balloon.envInnerMat.color.setRGB(1 + 0.3 * envGlow, 1 + 0.12 * envGlow, 1);
    // リップラインを引いている間はロープが引き下がる
    const pullTarget = input.rip ? 1 : 0;
    ripPull += (pullTarget - ripPull) * Math.min(1, dt * 6);
    balloon.rope.position.y = balloon.ropeBaseY - 0.18 * ripPull;

    if (fpv) {
      // ゴンドラ視点: 目の位置は気球に固定し、視線方向だけドラッグで回す。
      // 立ち位置は中心から少し横(実機のパイロット位置。真上の炎が正しく見える)
      camera.position.set(state.pos.x - 0.45, state.pos.y + EYE_HEIGHT, state.pos.z);
      const cy = Math.cos(fpvPitch), sy = Math.sin(fpvPitch);
      const dir = new THREE.Vector3(Math.sin(fpvYaw) * cy, sy, -Math.cos(fpvYaw) * cy);
      camera.lookAt(camera.position.x + dir.x, camera.position.y + dir.y, camera.position.z + dir.z);
    } else {
      // カメラは気球に追従(ターゲット+同じ分だけ平行移動)
      const delta = new THREE.Vector3().subVectors(state.pos, prevPos);
      camera.position.add(delta);
      controls.target.copy(state.pos).add(new THREE.Vector3(0, 12, 0));
    }
    prevPos.copy(state.pos);

    updateHud(w);
    drawCompass();

    // 気球の近くの地面を段階的に高解像度化(1.5秒おきに1枚ずつ)。
    // 低高度では直下の1タイルだけさらにz17(≒1m/px)へ
    if (performance.now() - lastDetailCheck > 1500) {
      lastDetailCheck = performance.now();
      terrain.updateDetail(state.pos.x, state.pos.z);
      const agl = state.pos.y - terrain.getHeight(state.pos.x, state.pos.z);
      if (agl < 1000) terrain.requestUltra(state.pos.x, state.pos.z);
    }
  }

  if (!fpv) controls.update();
  renderer.render(scene, camera);
});
