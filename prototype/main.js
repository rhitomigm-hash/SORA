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

// 外部API由来の文字列(住所検索の候補名など)をHTMLに埋め込む前に必ずエスケープする。
// 国土地理院のAddress Search APIは信頼できるが、レスポンスをそのままinnerHTMLや
// HTML属性値に差し込むとXSSの経路になりうるため、常にエスケープしてから使う(2026-08-03)
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

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
  `${location.origin}${location.pathname}?a=${AREA.lon.toFixed(4)},${AREA.lat.toFixed(4)}&w=${encodeWind(PIBAL)}${setupMode ? '&setup=1' : ''}${devMode ? '&dev=1' : ''}`;

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

// devMode: 気圧配置モデルを実際の飛行に反映する場合、離陸時点で計算した補正係数をここに保持する。
// 未使用時(setupMode/既定モード、またはdevModeでもH・L未配置の場合)はnullのままで、
// 従来通りパイバルのみで風を決める(このファイルの他の場所には影響しない)
let pressureCalibration = null; // { ratio, angleOffset, layerFt, params } | null

function windDirKtToVec(dir, kt) {
  const toRad = ((dir + 180) * Math.PI) / 180; // FROM → 進行方向
  const ms = kt * KT2MS;
  return { dir, kt, vx: ms * Math.sin(toRad), vz: -ms * Math.cos(toRad) };
}

// パイバル表のみを使った、高度ftに対する風向・風速の補間(気圧配置モデルを使わない場合の基本形)
function pibalInterpDirKt(ft) {
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
  return { dir, kt };
}

function windAt(altM, x, z) {
  const ft = altM * M2FT;
  // pressureCalibration がある(devModeでH・Lを使って離陸した)場合のみ、地上層(0〜layerFt)を
  // 気圧配置モデルの値へ置き換える。それ以外・layerFtより上は、従来通りパイバルのみで決める
  //
  // 地上層の判定は「対地高度(AGL、地面からの高さ)」で行う(2026-07-29修正)。
  // 海抜(MSL)で判定していたところ、離陸地点の標高がある場所では離陸直後から
  // 「地上層の外」と誤判定され、パイバルとかけ離れた風向が出る不具合があった
  if (pressureCalibration && x !== undefined && z !== undefined) {
    const { ratio, angleOffset, layerFt, params } = pressureCalibration;
    const groundY = terrain.getHeight(x, z); // 地面の標高(海抜、m)
    const aglFt = (altM - groundY) * M2FT;   // 対地高度(ft)
    if (aglFt < layerFt) {
      const ll = localXZToLonLat(x, z);
      const g = computeGroundWind(ll.lon, ll.lat, params);
      const groundDir = (g.fromBearing + angleOffset + 360) % 360;
      const groundKt = g.speedKt * ratio;
      if (aglFt <= 0) return windDirKtToVec(groundDir, groundKt);
      const upper = pibalInterpDirKt(layerFt); // 層の上端(layerFt)は従来通りパイバル側の値
      const t = aglFt / layerFt;
      const delta = ((upper.dir - groundDir + 540) % 360) - 180;
      const dir = (groundDir + delta * t + 360) % 360;
      const kt = groundKt + (upper.kt - groundKt) * t;
      return windDirKtToVec(dir, kt);
    }
  }
  const { dir, kt } = pibalInterpDirKt(ft);
  return windDirKtToVec(dir, kt);
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
  if (e.code === 'KeyW' && devMode) toggleWindCalcDebug(); // 隠しコマンド: 気圧配置モデルの計算過程表示(devMode専用)
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
} else {
  // PCでは折りたたみパネルを開いたまま表示(スマホでは省スペースのため閉じておく)
  document.getElementById('instruments').open = true;
  document.getElementById('area-search').open = true;
  document.getElementById('credit').open = true;
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
      // 座標も数値に変換してから埋め込む。title と同じくAPI由来の値なので、
      // 文字列のまま属性に差し込むと `130.3" onmouseover="…` のように属性を抜け出せてしまう
      const cands = items
        .map((it) => ({
          lon: Number(it?.geometry?.coordinates?.[0]),
          lat: Number(it?.geometry?.coordinates?.[1]),
          title: String(it?.properties?.title ?? ''),
        }))
        .filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat))
        .slice(0, 8);
      if (!cands.length) {
        list.innerHTML = '<li class="as-empty">見つかりませんでした</li>';
        return;
      }
      list.innerHTML = cands.map((c) => {
        const title = escapeHtml(c.title);
        return `<li data-lon="${c.lon}" data-lat="${c.lat}" data-name="${title}">${title}</li>`;
      }).join('');
      // 一番上の候補を自動で全画面マップに表示(住所検索は大まかな一致になりがちなので、
      // ここで実際の位置を目で見て微調整できるようにする)
      openMapAt(cands[0].lon, cands[0].lat, cands[0].title);
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

// 「開発途中版」: GameTargetで検討中の新機能(気圧配置モデル等)を試せる実験用モード。
// 安定版(?setup=1)とはコードを分離しているため、こちらが不安定でも安定版には影響しない
document.getElementById('setup-dev').addEventListener('click', () => {
  const p = new URLSearchParams(location.search);
  p.set('dev', '1');
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
// ?dev=1 は GameTarget で検討中の新機能を試す実験用モード(安定版とはコードを分離している)。
const mainParams = new URLSearchParams(location.search);
const setupMode = mainParams.has('setup');
const devMode = mainParams.has('dev');
const hasChosenArea = mainParams.has('a'); // 住所検索や共有URLなどで明示的にエリアが指定されているか
AREA = decodeArea(mainParams.get('a'));
if (!AREA) AREA = (setupMode || devMode) ? await selectArea() : PRESET_AREAS[0];

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
// devMode用は完全に別関数・別要素(#dev-briefing 以下)を使う。安定版のコードには触れない
if (devMode) setupDevWindEditor();

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

// ---- 開発途中版(?dev=1)専用: 風エディタ ----
// 上記の setupWindEditor 等の複製。安定版(setupMode)のコードとは完全に独立させている
// (GameTargetで検討中の気圧配置モデル等は、今後この関数群に追加していく)
function setupDevWindEditor() {
  const sel = document.getElementById('wind-preset-dev');
  sel.innerHTML = WIND_PRESETS
    .map((p, i) => `<option value="${i}">${p.name}</option>`)
    .join('') + '<option value="custom">カスタム</option>';
  if (new URLSearchParams(location.search).has('w')) sel.value = 'custom';
  renderDevEditorRows(PIBAL);

  sel.addEventListener('change', () => {
    if (sel.value === 'custom') return;
    renderDevEditorRows(WIND_PRESETS[Number(sel.value)].rows.map(toRowObj));
    applyDevWindFromEditor(); // PIBALを更新し、風の計算(キャリブレーション基準)にも反映する
  });
  document.getElementById('wind-add-dev').addEventListener('click', () => {
    const rows = readDevEditorRows();
    const last = rows[rows.length - 1];
    rows.push(last ? { ft: last.ft + 1000, dir: last.dir, kt: last.kt } : { ft: 0, dir: 180, kt: 5 });
    renderDevEditorRows(rows);
    sel.value = 'custom';
  });
  const editor = document.getElementById('wind-editor-dev');
  editor.addEventListener('input', () => {
    sel.value = 'custom';
    applyDevWindFromEditor(); // PIBALを更新し、風の計算(キャリブレーション基準)にも反映する
  });
  editor.addEventListener('click', (e) => {
    if (!e.target.classList.contains('del')) return;
    if (editor.querySelectorAll('tr').length <= 1) return; // 最低1行は残す
    e.target.closest('tr').remove();
    sel.value = 'custom';
    applyDevWindFromEditor();
  });
  document.getElementById('wind-copy-dev').addEventListener('click', (e) => {
    applyDevWindFromEditor();
    copyShare(e.target);
  });
  document.getElementById('wind-realdata-dev').addEventListener('click', fetchRealWindToAllPibalRows);
}

// devMode専用: Open-Meteo(無料・キー不要・CORS対応)から実況の風を高度別に取得し、
// パイバル表の「すべての行」に、各行の高度ftへ内挿した値を反映する。
// 気圧配置モデルは0ft行を基準にキャリブレーションする設計のため、これにより
// 「実データを基準に気圧配置モデルを較正する」というスコープを、表全体に拡張したことになる。
// エリア選択直後(離陸地点未選択)はエリア中心、離陸地点選択後はその地点の座標を使う
const REALDATA_HEIGHT_VARS = ['10m', '80m', '120m', '180m']; // 地表からの高さ(AGL)
const REALDATA_PRESSURE_VARS = ['1000hPa', '925hPa', '850hPa', '700hPa', '500hPa']; // 気圧面(高度はAMSL)
// 気象条件(第1段階、2026-08-05)。上の風と同じリクエストに相乗りするため、通信回数は増えない
// (実測: 変数を足してもHTTPリクエストは1回のまま、レスポンスは約2.5KB増のみ)。
// いずれも表示するだけで、風の計算・フライトの挙動には影響させない
const REALDATA_WX_VARS = ['wind_gusts_10m', 'visibility', 'weather_code', 'precipitation', 'cape',
  'boundary_layer_height',
  // 第4段階(2026-08-06): 日周期変動の背景となる地表の加熱状況
  'shortwave_radiation', 'temperature_2m', 'cloud_cover',
  // 第5段階(2026-08-06): 湿りの状態(視程が悪くなりやすいかの参考)
  'relative_humidity_2m', 'dew_point_2m'];
// 第3段階(2026-08-05): 逆転層の検出に使う気圧面の気温。下から順に並べておく
const REALDATA_TEMP_LEVELS = ['1000hPa', '975hPa', '950hPa', '925hPa', '900hPa', '850hPa'];
async function fetchRealWindToAllPibalRows() {
  const status = document.getElementById('wind-realdata-status');
  const ll = (devLaunchSel.x !== null) ? localXZToLonLat(devLaunchSel.x, devLaunchSel.z) : AREA;
  status.textContent = '取得中…';
  try {
    const hourlyVars = [
      ...REALDATA_HEIGHT_VARS.flatMap((h) => [`wind_speed_${h}`, `wind_direction_${h}`]),
      ...REALDATA_PRESSURE_VARS.flatMap((p) => [`wind_speed_${p}`, `wind_direction_${p}`, `geopotential_height_${p}`]),
      ...REALDATA_WX_VARS,
      ...REALDATA_TEMP_LEVELS.flatMap((p) => [`temperature_${p}`, `geopotential_height_${p}`]),
    ].join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${ll.lat}&longitude=${ll.lon}` +
      `&hourly=${hourlyVars}&wind_speed_unit=kn&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.hourly || !data.hourly.time || !data.hourly.time.length) {
      throw new Error('風データが取得できませんでした');
    }

    // 現在時刻に最も近い時間帯のインデックスを選ぶ
    // (timezoneを指定していないためAPIの時刻はGMT。末尾にZを付けてUTCとして解釈する)
    const now = Date.now();
    const times = data.hourly.time.map((t) => new Date(`${t}:00Z`).getTime());
    let idx = 0;
    for (let i = 1; i < times.length; i++) {
      if (Math.abs(times[i] - now) < Math.abs(times[idx] - now)) idx = i;
    }

    // 実データ点を高度ft(MSL)順に並べる。elevation は地点の標高(AMSL、m)。
    // 高さ指定(10m等)は地表からの高さなので、標高を足してMSLに揃える
    const elevM = Number(data.elevation) || 0;
    const points = [];
    for (const h of REALDATA_HEIGHT_VARS) {
      const kt = data.hourly[`wind_speed_${h}`][idx];
      const dir = data.hourly[`wind_direction_${h}`][idx];
      if (kt == null || dir == null) continue;
      points.push({ ft: (elevM + Number(h.replace('m', ''))) * M2FT, dir, kt });
    }
    for (const p of REALDATA_PRESSURE_VARS) {
      const kt = data.hourly[`wind_speed_${p}`][idx];
      const dir = data.hourly[`wind_direction_${p}`][idx];
      const gh = data.hourly[`geopotential_height_${p}`][idx];
      if (kt == null || dir == null || gh == null) continue;
      points.push({ ft: gh * M2FT, dir, kt });
    }
    points.sort((a, b) => a.ft - b.ft);
    if (points.length < 2) throw new Error('実データ点が不足しています');

    // パイバル表の既存の高度ftはそのまま維持し、各行の値だけを実データからの内挿値に置き換える
    // (同じ最短角度補間の考え方は pibalInterpDirKt に準拠)
    const interp = (ft) => {
      let a = points[0], b = points[points.length - 1];
      if (ft <= a.ft) b = a;
      else if (ft >= b.ft) a = b;
      else {
        for (let i = 0; i < points.length - 1; i++) {
          if (ft >= points[i].ft && ft < points[i + 1].ft) { a = points[i]; b = points[i + 1]; break; }
        }
      }
      const t = a === b ? 0 : (ft - a.ft) / (b.ft - a.ft);
      const delta = ((b.dir - a.dir + 540) % 360) - 180;
      const dir = Math.round((a.dir + delta * t + 360) % 360);
      const kt = Math.round((a.kt + (b.kt - a.kt) * t) * 10) / 10;
      return { dir, kt };
    };

    const rows = readDevEditorRows().map((r) => {
      const { dir, kt } = interp(r.ft);
      return { ft: r.ft, dir, kt };
    });
    renderDevEditorRows(rows);
    document.getElementById('wind-preset-dev').value = 'custom';
    applyDevWindFromEditor();
    renderWeatherConditions(data, idx); // 同じレスポンスから気象条件も表示する
    status.textContent = `取得成功(${data.hourly.time[idx]}時点、Open-Meteo、地点標高${elevM}m)。` +
      `${rows.length}行すべてを実データからの内挿値へ反映しました。`;
  } catch (err) {
    status.textContent = `取得失敗: ${err.message}(通信環境をご確認ください)`;
  }
}

// WMO天気コード → 日本語ラベル。Open-Meteoが返す weather_code の主要なものを対応させる
const WMO_LABELS = {
  0: '快晴', 1: '晴れ(ほぼ快晴)', 2: '晴れ時々曇り', 3: '曇り',
  45: '霧', 48: '霧(着氷性)',
  51: '霧雨(弱)', 53: '霧雨', 55: '霧雨(強)',
  61: '雨(弱)', 63: '雨', 65: '雨(強)',
  66: '着氷性の雨(弱)', 67: '着氷性の雨(強)',
  71: '雪(弱)', 73: '雪', 75: '雪(強)', 77: '霧雪',
  80: 'にわか雨(弱)', 81: 'にわか雨', 82: 'にわか雨(激しい)',
  85: 'にわか雪(弱)', 86: 'にわか雪(強)',
  95: '雷雨', 96: '雷雨(ひょうを伴う)', 99: '雷雨(激しいひょう)',
};

// CAPE(対流有効位置エネルギー)の区分。**気象一般で広く使われている区分**をそのまま示すもので、
// 熱気球が飛べる/飛べないの基準ではない(そのような基準は確認できていないため作らない)。
// CAPEは「大気がどれだけ対流を起こしうるか」という潜在的なエネルギーであり、
// 値が大きくても、きっかけがなければ実際に雷雨になるとは限らない点に注意
function capeCategory(v) {
  if (v < 1000) return '弱い不安定';
  if (v < 2500) return '中程度の不安定';
  if (v < 4000) return '強い不安定';
  return '極めて強い不安定';
}

const elevMOf = (data) => Number(data.elevation) || 0;

// 気圧面の気温から逆転層(上のほうが暖かい層)を見つける。第3段階(2026-08-05)。
// 逆転層があると上下の空気が混ざりにくくなり、その境目で風向・風速が変わりやすい。
// **検出して表示するだけ**で、風の計算には使わない
function detectInversions(hourly, idx, elevM) {
  const levels = [];
  for (const p of REALDATA_TEMP_LEVELS) {
    const t = hourly[`temperature_${p}`] ? hourly[`temperature_${p}`][idx] : null;
    const gh = hourly[`geopotential_height_${p}`] ? hourly[`geopotential_height_${p}`][idx] : null;
    if (t == null || gh == null) continue;
    if (gh < elevM) continue; // 地面より下の気圧面は無視する
    levels.push({ ft: gh * M2FT, t });
  }
  levels.sort((a, b) => a.ft - b.ft);
  const inversions = [];
  for (let i = 0; i < levels.length - 1; i++) {
    // 上の層のほうが暖かければ逆転層
    if (levels[i + 1].t > levels[i].t) {
      inversions.push({ fromFt: levels[i].ft, toFt: levels[i + 1].ft });
    }
  }
  return { levels, inversions };
}

// 直前に取得した気象データ。閾値を変えたときに再取得せず表示し直すために持っておく。
// (宣言はrenderWeatherConditionsより前に置く。過去にDIURNALで宣言順による
//  「初期化前アクセス」でスクリプトが停止する不具合を出したため)
let lastWeatherData = null;

// 気象条件(風・ガスト・視程・天気・降水)を表示する。第1段階(2026-08-05実装、同日方針変更)。
// **表示するだけ**で、風の計算やフライトの挙動には一切影響させない。
//
// 当初はガスト15kt・視程5000mを閾値にして合否を表示していたが、**この数値には実務的な根拠がなく**、
// 根拠のない基準をあたかも基準であるかのように見せることになるため取りやめた
// (熱気球は早朝・夕凪の穏やかな風で飛ぶもので、ガストはできるだけない方が望ましいが、
//  「何ktから飛べない」という明確な基準は現状ない、というユーザーの実務知識による)。
// 現在は**合否を判定せず、数値を示して注意を促すだけ**にしている。
//
// 目安の数値は、**出典のある項目だけ初期値を入れる**(2026-08-06決定)。
// 現在初期値があるのは視程の1500mのみで、これは航空法施行規則第5条の有視界気象状態
// (高度3000m未満・管制区・管制圏・情報圏以外の空域)に定められた飛行視程という法令上の根拠がある。
// 管制圏・情報圏の内側では5000mになるなど飛行場所で変わるため、書き換えられるようにしてある。
// ガスト・CAPE・気温と露点の差は、熱気球の可否を判断できる基準が存在しないため**空欄のまま**
// (理念「誤情報で混乱を生まない」と対応)。
//
// ガストは単独では意味が取りにくいため、**平均風速と並べて表示**する
// (平均4ktでガスト5ktなら穏やか、平均4ktでガスト13ktなら荒れている、という読み方)。
//
// 当初は「平均との差」も行として出していたが、2026-08-05に外した。
// 熱気球が飛ぶのは平均風速が小さいとき(5m/s≒10kt前後がキャンセルの目安)に限られるため、
// 平均は常に小さい範囲に収まり、**差はガストの値とほぼ同じ動きをする**。
// 独立した情報をほとんど持たない行を増やすと、かえって読み取る項目が増えて分かりにくくなるため、
// 平均とガストの2つを並べるだけにした
function renderWeatherConditions(data, idx) {
  const out = document.getElementById('wx-result');
  if (!out) return;
  lastWeatherData = { data, idx }; // 目安の変更時に再描画できるよう保持しておく
  const h = data.hourly || {};
  const at = (name) => (h[name] ? h[name][idx] : null);

  const meanKt = at('wind_speed_10m');   // wind_speed_unit=kn を指定しているのでノット
  const gustKt = at('wind_gusts_10m');
  const visM = at('visibility');
  const code = at('weather_code');
  const precip = at('precipitation');
  const cape = at('cape');

  // 空欄なら「目安なし」。0や負数も目安として扱わない
  const readLimit = (id) => {
    const raw = document.getElementById(id).value.trim();
    if (raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const gustLimit = readLimit('wx-gust');
  const visLimit = readLimit('wx-vis');

  const marks = [];
  const lines = [`[気象条件 ${data.hourly.time[idx]} 時点(Open-Meteo)]`, ''];

  lines.push(`  地上風(10m)の平均: ${meanKt == null ? '—' : meanKt.toFixed(1) + ' kt'}`);
  if (gustKt == null) {
    lines.push('  ガスト(瞬間的に強く吹く風): 取得できませんでした');
  } else {
    const over = gustLimit != null && gustKt >= gustLimit;
    lines.push(`  ガスト(瞬間的に強く吹く風): ${gustKt.toFixed(1)} kt${over ? `  ← 設定した目安(${gustLimit}kt)以上` : ''}`);
    if (over) marks.push('ガスト');
  }

  lines.push('');
  if (visM == null) {
    lines.push('  視程: 取得できませんでした');
  } else {
    const low = visLimit != null && visM <= visLimit;
    lines.push(`  視程: ${(visM / 1000).toFixed(1)} km${low ? `  ← 目安(${(visLimit / 1000).toFixed(1)}km)以下` : ''}`);
    if (low) marks.push('視程');
  }

  const label = (code == null) ? '取得できませんでした' : (WMO_LABELS[code] || `コード${code}`);
  lines.push(`  天気: ${label}`);
  if (precip != null) {
    lines.push(`  降水量: ${precip.toFixed(1)} mm/h${precip > 0 ? '  ← 降水あり' : ''}`);
    if (precip > 0) marks.push('降水');
  }

  // CAPE(第2段階、2026-08-05)。区分は気象一般で使われるものを示すだけで、
  // 熱気球の可否基準ではない(そのような基準は確認できていない)
  if (cape != null) {
    const capeLimit = readLimit('wx-cape');
    const over = capeLimit != null && cape >= capeLimit;
    lines.push('');
    lines.push(`  大気の不安定さ(CAPE): ${cape.toFixed(0)} J/kg` +
      `(気象一般の区分では「${capeCategory(cape)}」)${over ? `  ← 設定した目安(${capeLimit})以上` : ''}`);
    if (over) marks.push('CAPE');
  }

  // 第3段階(2026-08-05): 境界層高度と逆転層。**既定では風の計算に使わない**。
  // 境界層高度は「地上層の厚み」に適用できるが、適用するかどうかはボタンで明示的に選ばせる
  const blhM = at('boundary_layer_height');
  lastWeatherData.blhFt = (blhM == null) ? null : blhM * M2FT;
  document.getElementById('wx-apply-blh').disabled = (blhM == null);
  if (blhM != null) {
    lines.push('');
    lines.push(`  境界層高度: ${blhM.toFixed(0)} m(${(blhM * M2FT).toFixed(0)} ft)`);
    lines.push(`    地表の影響が及ぶ高さの目安。日中は厚く、夜間〜早朝は薄くなる`);
    lines.push(`    現在の「地上層の厚み」設定: ${windCalcReadParams().layerFt} ft（下のボタンで置き換えられます）`);
  }

  // 第4段階(2026-08-06): 地表の加熱状況。日周期変動の「背景」を見るための参考表示。
  // 実データで確認したところ、地上風との相関は日射量が0.638、境界層高度が0.907で、
  // **境界層高度のほうが明らかに良い予測因子**だった(日射のピークは13時だが風のピークは15時で
  // 2時間遅れる。日射は原因、境界層高度は蓄積された結果で、風が応答するのは後者のため)。
  // そのためこれらは日周期係数の計算には使わず、状況を読むための参考として表示するにとどめる
  const rad = at('shortwave_radiation');
  const temp2m = at('temperature_2m');
  const cloud = at('cloud_cover');
  if (rad != null || temp2m != null || cloud != null) {
    lines.push('');
    lines.push('  [地表の加熱状況(日周期変動の背景)]');
    if (temp2m != null) lines.push(`    気温(2m): ${temp2m.toFixed(1)} ℃`);
    if (rad != null) lines.push(`    日射量: ${rad.toFixed(0)} W/m²(地表がどれだけ温められているか)`);
    if (cloud != null) lines.push(`    雲量: ${cloud.toFixed(0)} %(多いほど日射を遮る)`);
  }

  // 第5段階(2026-08-06): 湿りの状態(相対湿度・露点温度)。**表示するだけ**で風の計算には使わない。
  // 気温と露点の差(スプレッド)が小さいほど空気が飽和に近く、視程が悪くなりやすい。
  //
  // 実装前に3地点×直近60日の実データで確かめた結果、以下が分かっている:
  // ・視程との関係自体はある(佐賀ではスプレッド0.5℃未満で視程の中央値2.6km、
  //   3℃以上では27.1km。5km未満になる割合は70.2%対2.6%)
  // ・**ただし「予兆」としての効き方は地点によって大きく違う**。現在の視程が10km以上ある時点から
  //   3時間以内に5km未満へ落ちる割合は、佐賀・佐久ではスプレッドが小さいほど高くなったが
  //   (37.8%/30.3% 対 5.0%/6.5%)、渡良瀬では単調にならずほとんど効かなかった(9.3% 対 7.6%)
  // ・**先読みできる時間はごく短い**。相関のピークは1〜2時間先(0.67)で同時刻(0.65)とほぼ同じ
  // ・相対湿度と露点差は実質同じ情報(視程との相関は -0.675 対 0.654)
  // ・風の弱さとの交互作用は確認できなかった(早朝スプレッド2未満で、
  //   風速3kt未満でも6kt以上でも視程5km未満の割合は約40%で差がなかった)
  //
  // 以上より、**霧の判定も予測もしない**。数値を示し、地点差があることを併せて伝えるにとどめる
  // (理念「根拠のない数値を基準のように見せない」)
  const rh = at('relative_humidity_2m');
  const dew = at('dew_point_2m');
  if (rh != null || dew != null) {
    lines.push('');
    lines.push('  [湿りの状態(視程が悪くなりやすいかの参考)]');
    if (rh != null) lines.push(`    相対湿度: ${rh.toFixed(0)} %`);
    if (dew != null) lines.push(`    露点温度: ${dew.toFixed(1)} ℃(この温度まで下がると空気中の水蒸気が飽和する)`);
    if (dew != null && temp2m != null) {
      const spread = temp2m - dew;
      const spreadLimit = readLimit('wx-spread');
      const under = spreadLimit != null && spread <= spreadLimit;
      lines.push(`    気温との差: ${spread.toFixed(1)} ℃(小さいほど飽和に近い)` +
        `${under ? `  ← 設定した目安(${spreadLimit}℃)以下` : ''}`);
      if (under) marks.push('気温と露点の差');
      lines.push('    差が小さいほど視程が悪くなりやすい傾向はありますが、');
      lines.push('    その効き方は地点によって差が大きく、霧の予測としては使えません。');
    }
  }

  const inv = detectInversions(h, idx, elevMOf(data));
  if (inv.levels.length >= 2) {
    lines.push('');
    lines.push(`  気温の高度変化: ${inv.levels.map((l) => `${l.ft.toFixed(0)}ft ${l.t.toFixed(1)}℃`).join(' / ')}`);
    lines.push(inv.inversions.length
      ? `    逆転層あり: ${inv.inversions.map((v) => `${v.fromFt.toFixed(0)}〜${v.toFt.toFixed(0)}ft`).join('、')}` +
        `(上のほうが暖かい層。空気が混ざりにくく、その境目で風が変わりやすい)`
      : '    逆転層は見つかりませんでした(高いほど気温が下がる、通常の状態)');
  }

  lines.push('');
  lines.push('熱気球は早朝や夕凪の穏やかな風のときに飛びます。ガストはできるだけない方が望ましいですが、');
  lines.push('「何ktから飛べない」という明確な基準はないため、SORAでは合否を判定していません。');
  if (marks.length) lines.push(`(目安に達した項目: ${marks.join('・')})`);

  // 合否は出さないので、枠の色は付けない(判定しているように見えてしまうため)
  out.classList.remove('judge-go', 'judge-cancel');
  out.textContent = lines.join('\n');
}
// 閾値を変えたときも、直前に取得したデータで表示し直せるようにする
['wx-gust', 'wx-vis', 'wx-cape', 'wx-spread'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    if (lastWeatherData) renderWeatherConditions(lastWeatherData.data, lastWeatherData.idx);
  });
});

// 「目安の決め方」(2026-08-06)。ガスト・CAPE・気温と露点の差は、熱気球の可否を判断できる
// 基準が存在しないため目安欄を空欄にしているが、それだと**何を入れたらいいか分からない**という
// 問題が残る。かといって根拠のない数値を初期値として示すことは理念に反する。
//
// そこで、基準を示す代わりに**その地点の実データの分布**を示すことにした。
// 「この地点のこの時期、飛ぶ時間帯では普通どのくらいの値か。どのくらいから珍しいか」であれば、
// 実測に基づいて言える。利用者は「いつもより荒れている日に印が付く」ように目安を選べる。
//
// これが固定値より意味を持つことは実データで確認済み: 飛行時間帯のCAPEの中央値は
// 佐賀690・渡良瀬160・上士幌0 J/kg と地点で大きく違い、**同じ1000という値でも
// 地点によって「よくあること」にも「めったにないこと」にもなる**
const WX_GUIDE_HOURS = [5, 6, 7, 8, 16, 17, 18, 19]; // 熱気球が飛ぶ時間帯(早朝・夕刻)
function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * p)];
}
async function showWeatherGuide() {
  const status = document.getElementById('wx-guide-status');
  const out = document.getElementById('wx-guide-result');
  const ll = (devLaunchSel.x !== null) ? localXZToLonLat(devLaunchSel.x, devLaunchSel.z) : AREA;
  status.textContent = '調べています…';
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${ll.lat}&longitude=${ll.lon}` +
      `&hourly=wind_gusts_10m,cape,temperature_2m,dew_point_2m&wind_speed_unit=kn` +
      `&past_days=60&forecast_days=1&timezone=Asia%2FTokyo`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const h = data.hourly;
    if (!h || !h.time || !h.time.length) throw new Error('データが取得できませんでした');

    // 飛行時間帯だけを取り出す(日中の値を混ぜると、飛ばない時間帯の荒れた値に引きずられる)
    const gusts = [], capes = [], spreads = [];
    for (let i = 0; i < h.time.length; i++) {
      if (!WX_GUIDE_HOURS.includes(Number(h.time[i].slice(11, 13)))) continue;
      if (h.wind_gusts_10m[i] != null) gusts.push(h.wind_gusts_10m[i]);
      if (h.cape[i] != null) capes.push(h.cape[i]);
      if (h.temperature_2m[i] != null && h.dew_point_2m[i] != null) {
        spreads.push(h.temperature_2m[i] - h.dew_point_2m[i]);
      }
    }
    if (!gusts.length) throw new Error('飛行時間帯のデータがありませんでした');

    const lines = [];
    lines.push(`[目安の決め方] ${ll.lat.toFixed(2)}, ${ll.lon.toFixed(2)} の直近60日`);
    lines.push(`熱気球が飛ぶ時間帯(5〜8時・16〜19時)の${gusts.length}時間分を集計しました。`);
    lines.push('');
    lines.push('これは「飛べる/飛べない」の基準ではありません。そのような基準は存在しないためです。');
    lines.push('この地点のこの時期に「どのくらいの値が普通で、どこからが珍しいか」を示すものです。');
    lines.push('「いつもより荒れている日に印が付く」ように選ぶ、という使い方を想定しています。');
    lines.push('');

    lines.push('■ ガストの目安(kt)');
    lines.push('  瞬間的に強く吹く風。地上風の平均と並べて読み、差が大きいほど荒れています。');
    lines.push(`  中央値 ${percentile(gusts, 0.5).toFixed(1)}(半分の時間はこれ以下)`);
    lines.push(`  上位25% ${percentile(gusts, 0.75).toFixed(1)} / 上位10% ${percentile(gusts, 0.9).toFixed(1)}` +
      ` / この60日の最大 ${percentile(gusts, 1).toFixed(1)}`);
    lines.push(`  → 4回に1回の頻度で印を付けたいなら ${Math.round(percentile(gusts, 0.75))}、` +
      `10回に1回なら ${Math.round(percentile(gusts, 0.9))} あたりです。`);
    lines.push('');

    lines.push('■ CAPEの目安(J/kg)');
    lines.push('  大気がどれだけ対流を起こしうるかの量。大きいほど雷雨やサーマルが起きやすい状態ですが、');
    lines.push('  あくまで潜在的なエネルギーで、きっかけがなければ実際に荒れるとは限りません。');
    lines.push(`  中央値 ${percentile(capes, 0.5).toFixed(0)}` +
      ` / 上位25% ${percentile(capes, 0.75).toFixed(0)} / 上位10% ${percentile(capes, 0.9).toFixed(0)}` +
      ` / この60日の最大 ${percentile(capes, 1).toFixed(0)}`);
    lines.push(`  → 10回に1回の頻度なら ${Math.round(percentile(capes, 0.9) / 50) * 50} あたりです。`);
    lines.push('  気象一般の区分(1000/2500/4000)は熱気球の基準ではなく、地点によって');
    lines.push('  「よくあること」にも「めったにないこと」にもなります(この地点の中央値と比べてください)。');
    lines.push('');

    lines.push('■ 気温と露点の差の目安(℃) ※ この項目だけ「下回ったら」印が付きます');
    lines.push('  小さいほど空気が飽和に近く、視程が悪くなりやすい傾向があります。');
    lines.push('  ただし効き方には地点差が大きく、霧の予測としては使えません。');
    lines.push(`  中央値 ${percentile(spreads, 0.5).toFixed(1)}(半分の時間はこれ以上)`);
    lines.push(`  下位25% ${percentile(spreads, 0.25).toFixed(1)} / 下位10% ${percentile(spreads, 0.1).toFixed(1)}` +
      ` / この60日の最小 ${percentile(spreads, 0).toFixed(1)}`);
    lines.push(`  → 4回に1回の頻度で印を付けたいなら ${percentile(spreads, 0.25).toFixed(1)}、` +
      `10回に1回なら ${percentile(spreads, 0.1).toFixed(1)} あたりです。`);
    lines.push('');
    lines.push('注意: 直近60日だけの集計なので、季節が変わると分布も変わります。');
    lines.push('また、ここに出るのは「この地点で普通かどうか」であって、安全かどうかではありません。');

    out.textContent = lines.join('\n');
    out.style.display = '';
    status.textContent = `${gusts.length}時間分を集計しました。`;
  } catch (err) {
    status.textContent = `調べられませんでした: ${err.message}(通信環境をご確認ください)`;
  }
}
document.getElementById('wx-guide').addEventListener('click', showWeatherGuide);

// 境界層高度を「地上層の厚み」に適用する(第3段階、2026-08-05)。
// **押したときだけ**風の計算が変わる。既定では従来の仮値(1000ft)のまま何も変わらない。
// 自動適用にしなかった理由: 実データでは早朝230ft・夕刻5184ftと20倍以上の差があり、
// そのまま入れると早朝は気圧配置モデルが、夕刻はパイバルがほぼ効かなくなってしまう。
// また SORAの「地上層」は2つのモデルを滑らかにつなぐブレンド区間であって、
// 気象学の境界層と同一の概念ではないため、置き換えの妥当性が確認できていない。
// そのため「試せるようにはするが、既定の挙動は変えない」形にした
document.getElementById('wx-apply-blh').addEventListener('click', () => {
  if (!lastWeatherData || lastWeatherData.blhFt == null) return;
  const ft = Math.round(lastWeatherData.blhFt);
  const before = windCalcReadParams().layerFt;
  document.getElementById('wc-layer').value = ft;
  updateWindCalc();
  updateDiurnalJudgment();
  renderWeatherConditions(lastWeatherData.data, lastWeatherData.idx); // 表示中の「現在の設定」を更新
  document.getElementById('wx-apply-blh-note').textContent =
    `地上層の厚みを ${before}ft → ${ft}ft に変更しました(元に戻すには上の入力欄を直接編集してください)`;
});

function renderDevEditorRows(rows) {
  document.getElementById('wind-editor-dev').innerHTML = rows.map((r) =>
    `<tr><td><input type="number" class="w-ft" step="100" min="0" value="${r.ft}"></td>` +
    `<td><input type="number" class="w-dir" step="10" min="0" max="360" value="${r.dir}"></td>` +
    `<td><input type="number" class="w-kt" step="1" min="0" value="${r.kt}"></td>` +
    `<td><button type="button" class="del" title="行を削除">×</button></td></tr>`).join('');
}

function readDevEditorRows() {
  return [...document.querySelectorAll('#wind-editor-dev tr')]
    .map((tr) => ({
      ft: Number(tr.querySelector('.w-ft').value),
      dir: ((Number(tr.querySelector('.w-dir').value) % 360) + 360) % 360,
      kt: Number(tr.querySelector('.w-kt').value),
    }))
    .filter((r) => Number.isFinite(r.ft) && Number.isFinite(r.dir) && Number.isFinite(r.kt)
      && r.ft >= 0 && r.kt >= 0)
    .sort((a, b) => a.ft - b.ft);
}

// エディタの内容を有効な風テーブルとして確定し、URLにも反映する(devMode版)
function applyDevWindFromEditor() {
  const rows = readDevEditorRows();
  if (rows.length) PIBAL = rows;
  renderFlightPibal();
  history.replaceState(null, '', shareUrl());
  updateWindCalc(); // パイバル(キャリブレーション基準)が変わったので風の計算表示も更新
}

document.getElementById('result-share').addEventListener('click', (e) => copyShare(e.target));

const launchSel = { x: null, z: null };
const devLaunchSel = { x: null, z: null }; // devMode専用(?dev=1)の離陸地点選択状態

// 気圧配置(H・L)の状態(devMode専用)。setupPressureMap() が下の if(devMode) ブロックで
// 呼ばれるより前に、ここで初期化しておく必要がある(呼ばれた時点で参照するため)
const devPressure = { points: [] }; // { type: 'h'|'l', lon, lat, hpa }
const PRESSURE_MAX_PER_TYPE = 5;
// 実データ取得時に種別を付け替える(relabelPressureTypesByValue)ため、種別ごとの上限だけだと
// 「付け替えで偏る → 少ないほうの種別に追加できる」を繰り返して合計が増えてしまう。
// 仕様上の意図(H・L合わせて10点程度に収める)を保つため、合計の上限も設ける
const PRESSURE_MAX_TOTAL = PRESSURE_MAX_PER_TYPE * 2;
const PRESSURE_DEFAULT_HPA = { h: 1015, l: 1005 };
let pressureMode = 'h'; // 'h' または 'l' — 次にクリックした位置をどちらに置くか
let renderPressureMap = () => {}; // setupPressureMap内でrenderを差し替える(クリア等から呼ぶため)

// 地上風の日周期変動(devMode専用)の状態。devPressureと同様、下のif(devMode)ブロックで
// renderPressureTable() → updateDiurnalJudgment() から参照されるより前に初期化しておく必要がある
// mode: 'dawn' | 'dusk' | null。duskRand/rollはボタンを押した時点で確定する乱数(下記setDiurnalMode参照)
const DIURNAL = { sunrise: null, sunset: null, dawnTime: null, duskTime: null, mode: null, duskRand: 0, roll: 0 };

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
// devMode: フルJDGブリーフィング相当を、安定版(#briefing)とは別要素(#dev-briefing)で表示する
if (devMode) {
  const devLaunchMapApi = setupDevLaunchMap();
  document.getElementById('dev-briefing').style.display = '';
  void devLaunchMapApi; // 現時点では離陸地点選択のみ
  setupPressureMap();      // 気圧配置(H・L)ステップ2: 位置・気圧値の入力のみ、まだ風の計算はしない
  renderPressureTable();
  fetchSunriseSunset();    // タスクシートに、このエリアの今日の日出・日没(実データ)を参考表示
}

// devMode専用: エリア中心の今日の日出・日没時刻をOpen-Meteoから取得しタスクシートに表示する。
// この値は「地上風の日周期変動」モデルの離陸時刻(既定 早朝07:00 / 夕刻16:00)の算出には使わず、
// 指定時刻がVFRで飛べる時間帯に収まっているかの確認(diurnalVfrWarning)に使う
async function fetchSunriseSunset() {
  const cell = document.getElementById('tasksheet-sunrise');
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${AREA.lat}&longitude=${AREA.lon}` +
      `&daily=sunrise,sunset&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const hm = (iso) => iso.slice(11, 16);
    cell.textContent = `日出 ${hm(data.daily.sunrise[0])} / 日没 ${hm(data.daily.sunset[0])}` +
      `(${data.daily.time[0]}、Open-Meteo実データ、現地時刻)`;

    DIURNAL.sunrise = new Date(data.daily.sunrise[0]);
    DIURNAL.sunset = new Date(data.daily.sunset[0]);
    // 離陸時刻自体は日出・日没に依存しない(既定07:00/16:00)が、日付の基準と
    // VFR警告の判定にこのデータを使うため、取得できた時点で計算し直す
    recomputeDiurnalTimes();
  } catch (err) {
    cell.textContent = `取得失敗: ${err.message}`;
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

// ---- 開発途中版(?dev=1)専用: 離陸地点選択マップ ----
// 上記 setupLaunchMap の複製。安定版のコードとは完全に独立させている。
// devLaunchSel / launch-map-dev / launch-btn-dev を使い、#dev-briefing 内でのみ動作する
function setupDevLaunchMap() {
  const cv = document.getElementById('launch-map-dev');
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
    if (devLaunchSel.x !== null) {
      const [lx, ly] = worldToScreen(devLaunchSel.x, devLaunchSel.z);
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
    devLaunchSel.x = THREE.MathUtils.clamp(wx, M.minX, M.minX + terrain.sizeMeters);
    devLaunchSel.z = THREE.MathUtils.clamp(wz, M.minZ, M.minZ + terrain.sizeMeters);
    render();
    const btn = document.getElementById('launch-btn-dev');
    btn.disabled = false;
    const d = Math.hypot(devLaunchSel.x - TARGET_XZ.x, devLaunchSel.z - TARGET_XZ.z);
    btn.textContent = `離陸!(ターゲットまで ${(d / 1000).toFixed(2)} km)`;
    updateWindCalc(); // 離陸地点が変わるとパイバルとのキャリブレーション基準点も変わる
    updateDiurnalJudgment(); // 離陸地点が変わると日周期判定の基準地点も変わる
  }

  render();
  return { selectAt };
}

document.getElementById('launch-btn-dev').addEventListener('click', () => {
  if (devLaunchSel.x === null) return;
  applyDevWindFromEditor(); // 離陸時点のエディタ内容で風を確定

  // 気圧配置モデル(H・L)が配置されていれば、離陸時点でパイバル(0ft)とキャリブレーションし、
  // 実際のフライトの地上層(0〜layerFt)に反映する。未配置の場合は従来通りパイバルのみで飛ぶ
  if (devPressure.points.length > 0) {
    const params = windCalcReadParams();
    const launch = localXZToLonLat(devLaunchSel.x, devLaunchSel.z);
    const groundL = computeGroundWind(launch.lon, launch.lat, params);
    const pibal0 = PIBAL.find((r) => r.ft === 0) || PIBAL[0];
    const ratio = groundL.speedKt > 0.01 ? pibal0.kt / groundL.speedKt : 1;
    const angleOffset = angleDiffDeg(pibal0.dir, groundL.fromBearing);
    pressureCalibration = { ratio, angleOffset, layerFt: params.layerFt, params };
  } else {
    pressureCalibration = null;
  }

  startFlight(devLaunchSel.x, devLaunchSel.z);
});

// ---- 開発途中版(?dev=1)専用: 気圧配置(H・L)のポイント選択 ----
// 「地上風の揺らぎ(気圧配置モデル)」検討のステップ2(2026-07-24仕様確定版):
// - 地図は天気図的な簡易表示(日本列島の簡略化した形を固定表示、パン・ズーム不要)
// - H・Lはそれぞれ最大5個まで配置可能
// - 各点は緯度経度に加えて気圧値(hPa)を持ち、下の表で編集できる(既存の風エディタと同じ考え方)
// - 参考天気図の画像を読み込んで隣に表示できる
// まだ風の計算はしない(位置と気圧値を入力できるだけ)
// (状態・データ定義は devLaunchSel と同様、この関数群が呼ばれるより前の場所にまとめて置いてある)

function setupPressureMap() {
  const cv = document.getElementById('pressure-map-dev');
  const ctx = cv.getContext('2d');
  // フライトエリア選択画面(selectArea)と同じ初期ビュー(z=5, 日本全体+周辺が入る中心)を
  // そのまま固定で使う。パン・ズーム・ドラッグは行わせない(スクロール機能なし、仕様により)
  const z = 5;
  const c = lonLatToTile(137.0, 38.0, z);

  const tiles = new Map(); // "x/y" -> ImageBitmap | 'loading' | 'error'
  function getTile(tx, ty) {
    const key = `${tx}/${ty}`;
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

  const toScreen = (tx, ty) => [(tx - c.x) * 256 + cv.width / 2, (ty - c.y) * 256 + cv.height / 2];
  const toTile = (sx, sy) => [(sx - cv.width / 2) / 256 + c.x, (sy - cv.height / 2) / 256 + c.y];
  const tileToLonLat = (tx, ty) => [
    (tx / 2 ** z) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** z))) * 180) / Math.PI,
  ];

  function drawMarker(lon, lat, label, color) {
    const t = lonLatToTile(lon, lat, z);
    const [sx, sy] = toScreen(t.x, t.y);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sx, sy, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, sx, sy);
  }

  function render() {
    ctx.fillStyle = '#0d1620';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const n = 2 ** z;
    const [txL, tyT] = toTile(0, 0);
    const [txR, tyB] = toTile(cv.width, cv.height);
    for (let ty = Math.max(0, Math.floor(tyT)); ty <= Math.min(n - 1, Math.floor(tyB)); ty++) {
      for (let tx = Math.max(0, Math.floor(txL)); tx <= Math.min(n - 1, Math.floor(txR)); tx++) {
        const bmp = getTile(tx, ty);
        if (!bmp) continue;
        const [sx, sy] = toScreen(tx, ty);
        ctx.drawImage(bmp, sx, sy, 256.5, 256.5);
      }
    }
    for (const p of devPressure.points) {
      drawMarker(p.lon, p.lat, p.type === 'h' ? '高' : '低', p.type === 'h' ? '#d84040' : '#4088e0');
    }
  }
  renderPressureMap = render;

  // パン・ズームは不要(仕様により省略)。クリックした位置に、選択中(H/L)の点を追加するだけ。
  // 種別ごとの上限(各5個)は「プレイヤーが手で置くとき」だけの制約で、実データ取得時の
  // 自動付け替え(relabelPressureTypesByValue)では超えてよい(2026-08-02決定。詳細はそちらを参照)
  cv.addEventListener('click', (e) => {
    const r = cv.width / cv.clientWidth;
    const count = devPressure.points.filter((p) => p.type === pressureMode).length;
    if (count >= PRESSURE_MAX_PER_TYPE) return;              // 上限(各5個)に達したら追加しない
    if (devPressure.points.length >= PRESSURE_MAX_TOTAL) return; // 合計上限(10点)も超えない
    const [fx, fy] = toTile(e.offsetX * r, e.offsetY * r);
    const [lon, lat] = tileToLonLat(fx, fy);
    devPressure.points.push({
      type: pressureMode, lon, lat, hpa: PRESSURE_DEFAULT_HPA[pressureMode],
    });
    render();
    renderPressureTable();
  });

  render();
}

function renderPressureTable() {
  document.getElementById('pressure-editor-dev').innerHTML = devPressure.points.map((p, i) => `
    <tr data-i="${i}">
      <td style="color:${p.type === 'h' ? '#ff8a8a' : '#8ab8ff'}">${p.type === 'h' ? '高(H)' : '低(L)'}</td>
      <td>${p.lat.toFixed(2)}N</td>
      <td>${p.lon.toFixed(2)}E</td>
      <td><input type="number" class="p-hpa" step="1" value="${p.hpa}"></td>
      <td><button type="button" class="del" title="削除">×</button></td>
    </tr>`).join('');
  updateWindCalc();
  updateDiurnalJudgment();
}

function setPressureMode(mode) {
  pressureMode = mode;
  document.getElementById('pressure-mode-h').classList.toggle('active', mode === 'h');
  document.getElementById('pressure-mode-l').classList.toggle('active', mode === 'l');
}
document.getElementById('pressure-mode-h').addEventListener('click', () => setPressureMode('h'));
document.getElementById('pressure-mode-l').addEventListener('click', () => setPressureMode('l'));
document.getElementById('pressure-clear').addEventListener('click', () => {
  devPressure.points = [];
  renderPressureMap();
  renderPressureTable();
});
document.getElementById('pressure-editor-dev').addEventListener('input', (e) => {
  if (!e.target.classList.contains('p-hpa')) return;
  const i = Number(e.target.closest('tr').dataset.i);
  devPressure.points[i].hpa = Number(e.target.value);
  updateWindCalc();
  updateDiurnalJudgment();
});
document.getElementById('pressure-editor-dev').addEventListener('click', (e) => {
  if (!e.target.classList.contains('del')) return;
  const i = Number(e.target.closest('tr').dataset.i);
  devPressure.points.splice(i, 1);
  renderPressureMap();
  renderPressureTable();
});

// devMode専用: 置かれているH・L点それぞれの座標について、Open-Meteoの実況気圧
// (海面更正気圧 pressure_msl)を取得し、各点のhpa欄を上書きする。
// H・Lの「位置」は引き続きプレイヤーが指示する前提のまま(仕様どおり)、
// 「気圧値」だけを実データに差し替える、というスコープ
document.getElementById('pressure-realdata-dev').addEventListener('click', fetchRealPressureToPoints);
async function fetchRealPressureToPoints() {
  const status = document.getElementById('pressure-realdata-status');
  if (devPressure.points.length === 0) {
    status.textContent = '先に地図でH・Lを1点以上置いてください。';
    return;
  }
  status.textContent = '取得中…';
  try {
    const results = await Promise.all(devPressure.points.map(async (p) => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
        `&current=pressure_msl`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const hpa = data.current && data.current.pressure_msl;
      if (hpa == null) throw new Error('気圧データが取得できませんでした');
      return { hpa: Math.round(hpa), time: data.current.time };
    }));
    devPressure.points.forEach((p, i) => { p.hpa = results[i].hpa; });
    const relabeled = relabelPressureTypesByValue();
    renderPressureMap();
    renderPressureTable();
    status.textContent = `取得成功(${results[0].time}時点、Open-Meteo)。${results.length}点の気圧hPaを反映しました。` +
      (relabeled ? `\n${relabeled}` : '');
  } catch (err) {
    status.textContent = `取得失敗: ${err.message}(通信環境をご確認ください)`;
  }
}

// 実データ取得後、各点のH・L種別を実測気圧に合わせて付け替える(2026-08-02決定)。
// プレイヤーは勘でH・Lの位置を置くため、実データを入れると「Hと置いた点のほうが低い」といった
// 食い違いが起きる。風の計算は気圧値だけを見ているため物理的には正しく動くが、マーカーの
// 「高」「低」表示だけが実態とずれてしまうため、表示側を実測値に合わせる。
//
// 判定基準は固定値(1013hPa)ではなく、置かれた点どうしの平均との相対比較にする。
// 夏の高気圧は1008hPa程度のこともあり、1013hPaを閾値にすると季節によって誤判定するため。
// 風を決めるのは点どうしの気圧差なので、相対比較のほうがモデルの実態にも合う。
//
// **種別ごとの上限(各5個)は、ここではあえてチェックしない**(2026-08-02決定)。
// 実際の気圧配置がH寄り・L寄りに偏ることは普通にあり、そこで無理に5個に収めようとすると
// 「実測では6点とも周囲より高いのに、1点だけLと表示する」という、実態と食い違う表示に
// 逆戻りしてしまう。上限は「プレイヤーが手で置くときの複雑さの歯止め」という位置づけなので、
// 実データに合わせる付け替えでは超えてよい。点数自体は増えない(合計上限は配置時に担保)。
// 付け替えが起きた場合は、その内容を説明する文字列を返す(空文字なら変更なし)
function relabelPressureTypesByValue() {
  const pts = devPressure.points;
  if (pts.length === 0) return '';
  const mean = pts.reduce((s, p) => s + p.hpa, 0) / pts.length;
  let toH = 0, toL = 0;
  for (const p of pts) {
    // 平均ちょうどの点は、どちらとも言えないので現状維持にする
    const t = p.hpa > mean ? 'h' : (p.hpa < mean ? 'l' : p.type);
    if (t !== p.type) { if (t === 'h') toH++; else toL++; }
    p.type = t;
  }
  if (!toH && !toL) return '';
  const parts = [];
  if (toL) parts.push(`H→L ${toL}点`);
  if (toH) parts.push(`L→H ${toH}点`);
  return `※ 実測値が周囲との比較(平均${mean.toFixed(0)}hPa)と合わなかったため、種別を付け替えました(${parts.join('、')})。` +
    `置いた位置と実際の気圧配置がずれていた、ということです。`;
}

// 参考天気図(画像ファイル)の読み込み — 見比べ用に隣へ表示するだけで、ゲームには使わない
document.getElementById('pressure-ref-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = document.getElementById('pressure-ref-img');
  img.src = URL.createObjectURL(file);
  img.style.display = '';
  document.getElementById('pressure-ref-placeholder').style.display = 'none';
});

// ---- 開発途中版(?dev=1)専用: 風の計算(ステップ3、2026-07-24仕様確定版) ----
// 気圧場の勾配から地上風を計算し、離陸地点のパイバル(0ft)とキャリブレーションする。
// まだ実際の飛行(startFlightのPIBAL参照)には反映していない。計算ロジックの検証・表示のみ

// ローカル地形座標(x=東, z=南。dxE/dN の既存コメントに準拠)を緯度経度に変換する近似式
// (プレイエリアは最大でも数十km四方なので、この程度の平面近似で十分)
function localXZToLonLat(x, z) {
  if (!AREA) return null;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((AREA.lat * Math.PI) / 180);
  const eastKm = x / 1000;
  const northKm = -z / 1000; // +z は南なので、北成分は符号反転
  return { lon: AREA.lon + eastKm / kmPerDegLon, lat: AREA.lat + northKm / kmPerDegLat };
}

function windCalcReadParams() {
  return {
    K: Number(document.getElementById('wc-K').value) || 0,
    L: Math.max(1, Number(document.getElementById('wc-L').value) || 1),
    damping: (Number(document.getElementById('wc-damp').value) || 0) / 100,
    angle: Number(document.getElementById('wc-angle').value) || 0,
    layerFt: Number(document.getElementById('wc-layer').value) || 1000,
  };
}

// 2地点間の東西・南北方向の距離(km)。緯度1°=111.32km、経度1°はcos(緯度)分だけ短くなる近似
function lonLatDeltaKm(lon1, lat1, lon2, lat2) {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((lat1 * Math.PI) / 180);
  return { dx: (lon2 - lon1) * kmPerDegLon, dy: (lat2 - lat1) * kmPerDegLat };
}

// 気圧場: 標準気圧(1013hPa)に、各H・L点からの影響(L²/(L²+距離²)で減衰)を足し合わせる
function pressureAt(lon, lat, L) {
  let p = 1013;
  for (const pt of devPressure.points) {
    const { dx, dy } = lonLatDeltaKm(lon, lat, pt.lon, pt.lat);
    const d2 = dx * dx + dy * dy;
    p += (pt.hpa - 1013) * ((L * L) / (L * L + d2));
  }
  return p;
}

// 気圧場の勾配(中心差分)。gx=東方向の変化率、gy=北方向の変化率(いずれも hPa/km)
function pressureGradient(lon, lat, L) {
  const eps = 0.05; // 度
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  const gx = (pressureAt(lon + eps, lat, L) - pressureAt(lon - eps, lat, L)) / (2 * eps * kmPerDegLon);
  const gy = (pressureAt(lon, lat + eps, L) - pressureAt(lon, lat - eps, L)) / (2 * eps * kmPerDegLat);
  return { gx, gy };
}

// 東西・南北成分のベクトルを、地図を上から見て時計回りにdeg度回転させる
function rotateCW(x, y, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: x * c + y * s, y: -x * s + y * c };
}
// 東西・南北成分のベクトルを、方位角(0=北、時計回りに360まで)に変換
function bearingFromXY(x, y) {
  const deg = (Math.atan2(x, y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// 上空相当の傾度風: 気圧が下がる方向(降り坂)を90°時計回りに回転させた向きに吹く
// (高気圧の周りは時計回り、低気圧の周りは反時計回りになる、というルールと一致)
function computeRawWind(lon, lat, params) {
  const { gx, gy } = pressureGradient(lon, lat, params.L);
  const gradMag = Math.hypot(gx, gy); // hPa/km
  const downMag = gradMag || 1;
  const down = { x: -gx / downMag, y: -gy / downMag }; // 気圧が下がる方向(単位ベクトル)
  const blow = rotateCW(down.x, down.y, 90); // 吹いていく向き
  const blowToBearing = bearingFromXY(blow.x, blow.y);
  return {
    speedKt: params.K * (gradMag * 100), // hPa/100kmあたりKノット
    blowToBearing,
    fromBearing: (blowToBearing + 180) % 360,
  };
}

// 地上風: 上空風 × 減速係数、かつ低気圧側へさらに角度補正(時計回りにangle度)
function computeGroundWind(lon, lat, params) {
  const raw = computeRawWind(lon, lat, params);
  const rad = (raw.blowToBearing * Math.PI) / 180;
  const blowVec = rotateCW(Math.sin(rad), Math.cos(rad), params.angle);
  const blowToBearing = bearingFromXY(blowVec.x, blowVec.y);
  return { speedKt: raw.speedKt * params.damping, fromBearing: (blowToBearing + 180) % 360, raw };
}

function angleDiffDeg(a, b) {
  let d = ((a - b + 540) % 360) - 180;
  return d;
}

// 離陸地点のパイバル(0ft)を基準にキャリブレーションし、離陸地点・ターゲット地点の
// 計算結果をまとめて表示する。H・Lが1点もない、または離陸地点未選択の場合は案内文のみ表示
function updateWindCalc() {
  const out = document.getElementById('windcalc-result');
  if (!out) return;
  if (devPressure.points.length === 0) {
    out.textContent = 'H・Lを2点以上置くと、計算結果がここに表示されます。';
    return;
  }
  if (devLaunchSel.x === null) {
    out.textContent = '離陸地点を選択すると、パイバル(0ft)とのキャリブレーションを計算します。';
    return;
  }
  const params = windCalcReadParams();
  const launch = localXZToLonLat(devLaunchSel.x, devLaunchSel.z);
  const rawL = computeRawWind(launch.lon, launch.lat, params);
  const groundL = computeGroundWind(launch.lon, launch.lat, params);

  const pibal0 = PIBAL.find((r) => r.ft === 0) || PIBAL[0];
  const ratio = groundL.speedKt > 0.01 ? pibal0.kt / groundL.speedKt : 1;
  const angleOffset = angleDiffDeg(pibal0.dir, groundL.fromBearing);
  const calibratedL = { speedKt: groundL.speedKt * ratio, fromBearing: (groundL.fromBearing + angleOffset + 360) % 360 };

  const targetLL = localXZToLonLat(TARGET_XZ.x, TARGET_XZ.z);
  const groundT = computeGroundWind(targetLL.lon, targetLL.lat, params);
  const calibratedT = { speedKt: groundT.speedKt * ratio, fromBearing: (groundT.fromBearing + angleOffset + 360) % 360 };

  const fmt = (w) => `${w.fromBearing.toFixed(0)}° / ${w.speedKt.toFixed(1)}kt`;
  out.textContent = [
    `[離陸地点]`,
    `  生の勾配風(上空相当): ${fmt(rawL)}`,
    `  地上風(減速${(params.damping * 100).toFixed(0)}%+角度補正${params.angle}°): ${fmt(groundL)}`,
    `  パイバル0ft: ${pibal0.dir}° / ${pibal0.kt}kt`,
    `  補正係数: 倍率×${ratio.toFixed(2)} / 角度${angleOffset >= 0 ? '+' : ''}${angleOffset.toFixed(0)}°`,
    `  補正後(≒パイバル0ftと一致): ${fmt(calibratedL)}`,
    ``,
    `[ターゲット地点(参考、地上クルー機能で使う想定)]`,
    `  地上風(補正前): ${fmt(groundT)}`,
    `  地上風(補正後): ${fmt(calibratedT)}`,
    ``,
    `※ 地上層(0〜${params.layerFt}ft)はこの値へ、それより上は既存パイバルへ滑らかに移行する` +
    `(「離陸!」を押すと実際のフライトに反映されます)`,
  ].join('\n');
}
// K・L等を変えると、気圧配置モデルの計算結果とそれを使う日周期判定の両方が変わる
['wc-K', 'wc-L', 'wc-damp', 'wc-angle', 'wc-layer'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    updateWindCalc();
    updateDiurnalJudgment();
  });
});

// ---- devMode専用: 地上風の日周期変動(実験、2026-07-31設計) ----
// 気圧配置モデルの地上風(離陸地点、パイバルとのキャリブレーション前の生の値)に、
// 選択した開始時刻(早朝/夕方)の係数を掛け、実競技の「地上風5m/s前後はキャンセルの目安」を
// シグモイド的な連続確率でキャンセル判定する。あくまで判定結果を表示するだけの実験機能で、
// 実際のフライト(パイバルとのキャリブレーション)には影響しない

// 離陸時刻は「早朝07:00 / 夕刻16:00」を既定とする実運用に合わせた時刻指定方式(画面上で変更可能)。
// 日出・日没の実データは時刻の算出には使わず、指定した時刻がVFRで飛べる時間帯(日の出〜日没)に
// 収まっているかの確認に使う(熱気球は日の出前・日没後は法律上飛行できないため)
const DIURNAL_TIME_IDS = { dawn: 'wc-dawntime', dusk: 'wc-dusktime' };

// "HH:MM" を、日出データと同じ日付のDateに変換する(日出データがなければ今日の日付を使う)
function diurnalTimeOf(mode) {
  const raw = document.getElementById(DIURNAL_TIME_IDS[mode]).value || '';
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const base = DIURNAL.sunrise ? new Date(DIURNAL.sunrise) : new Date();
  base.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return base;
}

const hhmm = (d) => (d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '--:--');

// 指定時刻がVFRで飛べる時間帯(日の出〜日没)の外なら、その旨のメッセージを返す(問題なければ空文字)
function diurnalVfrWarning(t) {
  if (!t || !DIURNAL.sunrise || !DIURNAL.sunset) return '';
  if (t < DIURNAL.sunrise) return `⚠ 日の出(${hhmm(DIURNAL.sunrise)})前のため、実際には飛行できない時刻です`;
  if (t > DIURNAL.sunset) return `⚠ 日没(${hhmm(DIURNAL.sunset)})後のため、実際には飛行できない時刻です`;
  return '';
}

// 入力された離陸時刻をボタンのラベルへ反映する。時刻欄の変更のたびに呼ばれる
function recomputeDiurnalTimes() {
  DIURNAL.dawnTime = diurnalTimeOf('dawn');
  DIURNAL.duskTime = diurnalTimeOf('dusk');
  document.getElementById('diurnal-dawn').textContent = `早朝(${hhmm(DIURNAL.dawnTime)}〜)`;
  document.getElementById('diurnal-dusk').textContent = `夕方(${hhmm(DIURNAL.duskTime)}〜)`;
  updateDiurnalJudgment(); // VFR警告は日出・日没データと時刻の両方に依存するため出し直す
}
document.getElementById('wc-dawntime').addEventListener('input', recomputeDiurnalTimes);
document.getElementById('wc-dusktime').addEventListener('input', recomputeDiurnalTimes);
recomputeDiurnalTimes(); // 日出・日没の取得を待たずに、既定時刻(07:00/16:00)でボタンを表示しておく

// 境界層高度(BLH)から日周期係数を導出する(2026-08-06)。
//
// 日周期係数は「気圧配置モデルの風のうち、どれだけが地上に届くか」を表す。
// 境界層が浅い早朝は地表付近が上空と切り離されて風が弱く、厚い日中〜夕刻は上空の風が
// 地上へ降りてきて強まる、という物理に対応する。
//
// 実データ72時間分(佐賀、3日)を log-log で回帰したところ
// **風速 ∝ BLH^0.436**(相関0.887)という関係が得られたため、
// 係数 = (BLH / 基準BLH)^指数(上限1)とする。基準・指数とも画面で調整できる。
//
// 選んだ離陸時刻のBLHを使う点が重要。1日分の時間別データを取得しているので、
// 「今」ではなく実際に飛ぶ時刻の値を引ける
function blhAtTime(t) {
  if (!lastWeatherData || !t) return null;
  const h = lastWeatherData.data.hourly;
  if (!h || !h.boundary_layer_height) return null;
  // hourly.time はGMT(timezone未指定で取得しているため)。絶対時刻で最も近いものを選ぶ
  const target = t.getTime();
  let best = -1, bestDiff = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const d = Math.abs(new Date(`${h.time[i]}:00Z`).getTime() - target);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  if (best < 0) return null;
  const v = h.boundary_layer_height[best];
  return v == null ? null : { blhM: v, time: h.time[best] };
}

function blhToDiurnalCoef(blhM) {
  const ref = Math.max(1, Number(document.getElementById('wc-blhref').value) || 1800);
  const exp = Number(document.getElementById('wc-blhexp').value) || 0.44;
  return Math.min(1, Math.pow(Math.max(0, blhM) / ref, exp));
}

function diurnalReadParams() {
  return {
    dawnCoef: Number(document.getElementById('wc-dawn').value) || 0,
    duskMean: Number(document.getElementById('wc-duskmean').value) || 0,
    duskWidth: Number(document.getElementById('wc-duskwidth').value) || 0,
    cancelCenter: Number(document.getElementById('wc-cancelc').value) || 0,
    cancelWidth: Math.max(0.01, Number(document.getElementById('wc-cancelw').value) || 0.01),
  };
}

// 開始時刻ボタンを押したときだけ乱数を引き直す(夕方係数のばらつき・キャンセル抽選)。
// 同じボタンをもう一度押せば再抽選になり、「際どい判断」を何度も試せる
function setDiurnalMode(mode) {
  DIURNAL.mode = mode;
  DIURNAL.duskRand = Math.random() * 2 - 1; // -1〜+1
  DIURNAL.roll = Math.random();
  document.getElementById('diurnal-dawn').classList.toggle('active', mode === 'dawn');
  document.getElementById('diurnal-dusk').classList.toggle('active', mode === 'dusk');
  updateDiurnalJudgment();
}
document.getElementById('diurnal-dawn').addEventListener('click', () => setDiurnalMode('dawn'));
document.getElementById('diurnal-dusk').addEventListener('click', () => setDiurnalMode('dusk'));
['wc-dawn', 'wc-duskmean', 'wc-duskwidth', 'wc-cancelc', 'wc-cancelw',
  'wc-blhref', 'wc-blhexp'].forEach((id) => {
  document.getElementById(id).addEventListener('input', updateDiurnalJudgment);
});

function updateDiurnalJudgment() {
  const out = document.getElementById('diurnal-result');
  if (!out) return;
  const clearJudgeStyle = () => out.classList.remove('judge-go', 'judge-cancel');
  if (!DIURNAL.mode) {
    clearJudgeStyle();
    out.textContent = '「フライト開始時刻」を先に選ぶと、ここに判定結果が表示されます(ボタンを押し直すと再判定します)。';
    return;
  }
  if (devPressure.points.length === 0) {
    clearJudgeStyle();
    out.textContent = 'H・Lを2点以上置くと、判定できます。';
    return;
  }
  const ll = (devLaunchSel.x !== null) ? localXZToLonLat(devLaunchSel.x, devLaunchSel.z) : AREA;
  const params = windCalcReadParams();
  const groundWind = computeGroundWind(ll.lon, ll.lat, params); // 気圧配置モデルの生の地上風(キャリブレーション前)

  const dp = diurnalReadParams();
  // 乱数(夕方係数のばらつき・キャンセル抽選)はボタンを押した時点で確定した値を使い回す。
  // 係数の入力欄を触るたびに振り直すと、パラメータ調整のたびに結果が変わってしまい比較できないため
  let coef;
  if (DIURNAL.mode === 'dawn') {
    coef = dp.dawnCoef; // 早朝はばらつきが小さいため固定係数
  } else {
    coef = dp.duskMean + DIURNAL.duskRand * dp.duskWidth; // 夕方は平均±ランダム幅
  }
  const diurnalKt = groundWind.speedKt * Math.max(0, coef);

  // シグモイド: キャンセル中心を境に、幅の分だけなだらかに0→1へ変化する確率
  const cancelProb = 1 / (1 + Math.exp(-(diurnalKt - dp.cancelCenter) / dp.cancelWidth));
  const canceled = DIURNAL.roll < cancelProb;

  const label = DIURNAL.mode === 'dawn' ? '早朝' : '夕方';
  const startTime = DIURNAL.mode === 'dawn' ? DIURNAL.dawnTime : DIURNAL.duskTime;
  const vfrWarning = diurnalVfrWarning(startTime);

  // 離陸時刻の境界層高度から導出した係数を、参考として併記する(適用は別途ボタンで)
  const blh = blhAtTime(startTime);
  const suggested = blh ? blhToDiurnalCoef(blh.blhM) : null;
  document.getElementById('diurnal-apply-blh').disabled = (suggested == null);

  out.classList.toggle('judge-go', !canceled);
  out.classList.toggle('judge-cancel', canceled);
  out.textContent = [
    `【${label}】${hhmm(startTime)} 開始 — ${canceled ? '✕ フライトキャンセル' : '○ 決行'}`,
    ...(vfrWarning ? [`  ${vfrWarning}`] : []),
    ``,
    `  気圧配置モデルの地上風(生値): ${groundWind.speedKt.toFixed(1)}kt`,
    `  日周期係数: ×${coef.toFixed(2)}${DIURNAL.mode === 'dusk' ? `(平均${dp.duskMean.toFixed(2)}±${dp.duskWidth.toFixed(2)}のランダム)` : '(固定)'}`,
    ...(suggested != null
      ? [`    参考: この時刻の境界層高度 ${blh.blhM.toFixed(0)}m から求めると ×${suggested.toFixed(2)}` +
         `(下のボタンで適用できます)`]
      : ['    参考: 「実データ取得(全高度)」を押すと、境界層高度からの係数も表示します']),
    `  日周期反映後の地上風: ${diurnalKt.toFixed(1)}kt`,
    `  キャンセル確率: ${(cancelProb * 100).toFixed(0)}%(中心${dp.cancelCenter}kt、幅${dp.cancelWidth}kt)`,
    `  抽選値: ${DIURNAL.roll.toFixed(2)} ${canceled ? '<' : '≥'} ${cancelProb.toFixed(2)} → ${canceled ? 'キャンセル' : '決行'}`,
    ``,
    `※ ボタンを押し直すたびに再抽選します(係数の調整では再抽選しません)。`,
    `※ 実際のフライトの風には影響せず、判定結果の表示のみです。`,
  ].join('\n');
}

// 境界層高度から求めた日周期係数を、選択中の時間帯(早朝/夕方)の係数欄に適用する。
// 第3段階の地上層厚みと同じく、**押したときだけ**変わる。既定では手入力の仮値のまま
document.getElementById('diurnal-apply-blh').addEventListener('click', () => {
  if (!DIURNAL.mode) return;
  const t = DIURNAL.mode === 'dawn' ? DIURNAL.dawnTime : DIURNAL.duskTime;
  const blh = blhAtTime(t);
  if (!blh) return;
  const coef = blhToDiurnalCoef(blh.blhM);
  const id = DIURNAL.mode === 'dawn' ? 'wc-dawn' : 'wc-duskmean';
  const before = document.getElementById(id).value;
  document.getElementById(id).value = coef.toFixed(2);
  updateDiurnalJudgment();
  document.getElementById('diurnal-apply-blh-note').textContent =
    `${DIURNAL.mode === 'dawn' ? '早朝係数' : '夕方係数(平均)'}を ${before} → ${coef.toFixed(2)} に変更しました` +
    `(${hhmm(t)}の境界層高度 ${blh.blhM.toFixed(0)}m から算出)`;
});

// ---- 隠しコマンド(Wキー、devMode専用): フライト中の計算過程デバッグ表示 ----
// ブリーフィング画面の「風の計算(実験)」パネルと同じ内容を、飛行中の現在位置でリアルタイムに表示する
let showWindCalcDebug = false;
function toggleWindCalcDebug() {
  showWindCalcDebug = !showWindCalcDebug;
  document.getElementById('flight-windcalc-debug').style.display = showWindCalcDebug ? '' : 'none';
}

// 毎フレーム呼ばれるが、非表示中・気圧配置モデル未使用時は何もしない(負荷はごくわずか)
function updateFlightWindCalcDebug(appliedW) {
  if (!showWindCalcDebug) return;
  const out = document.getElementById('flight-windcalc-debug');
  if (!pressureCalibration) {
    out.textContent = '気圧配置モデルは未使用です(H・Lを配置せずに離陸したフライトです)。';
    return;
  }
  const { ratio, angleOffset, layerFt, params } = pressureCalibration;
  const groundY = terrain.getHeight(state.pos.x, state.pos.z);
  const aglFtNow = (state.pos.y - groundY) * M2FT; // 対地高度(ft)。地上層の判定と揃える
  const here = localXZToLonLat(state.pos.x, state.pos.z);
  const rawHere = computeRawWind(here.lon, here.lat, params);
  const groundHere = computeGroundWind(here.lon, here.lat, params);
  const calibratedHere = {
    speedKt: groundHere.speedKt * ratio,
    fromBearing: (groundHere.fromBearing + angleOffset + 360) % 360,
  };
  const targetLL = localXZToLonLat(TARGET_XZ.x, TARGET_XZ.z);
  const groundT = computeGroundWind(targetLL.lon, targetLL.lat, params);
  const calibratedT = {
    speedKt: groundT.speedKt * ratio,
    fromBearing: (groundT.fromBearing + angleOffset + 360) % 360,
  };
  const fmt = (w) => `${w.fromBearing.toFixed(0)}° / ${w.speedKt.toFixed(1)}kt`;
  out.textContent = [
    `[風の計算(隠しデバッグ、Wで閉じる)]`,
    `現在高度: 対地${aglFtNow.toFixed(0)}ft ${aglFtNow < layerFt ? '(地上層内・モデル適用中)' : '(地上層の外・パイバルのみ)'}`,
    `▶ 実際に使われている風(現在高度でブレンド後の最終値): ` +
    `${appliedW.dir.toFixed(0)}° / ${appliedW.kt.toFixed(1)}kt`,
    `現在地点:`,
    `  生の勾配風(上空相当): ${fmt(rawHere)}`,
    `  地上風(減速${(params.damping * 100).toFixed(0)}%+角度補正${params.angle}°): ${fmt(groundHere)}`,
    `  補正係数(離陸時に固定): 倍率×${ratio.toFixed(2)} / 角度${angleOffset >= 0 ? '+' : ''}${angleOffset.toFixed(0)}°`,
    `  補正後(0ft換算): ${fmt(calibratedHere)}`,
    ``,
    `ターゲット地点(参考): ${fmt(calibratedT)}`,
  ].join('\n');
}

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
  document.getElementById('dev-briefing').style.display = 'none';
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
  const w = windAt(state.pos.y, state.pos.x, state.pos.z);
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
  const w = windAt(m.pos.y, m.pos.x, m.pos.z);
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

  const w = windAt(state.pos.y, state.pos.x, state.pos.z);
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

// 初回起動(既定エリア・setupなし・住所指定なし・devなし)ではブリーフィングを介さず即離陸する。
// setupMode / hasChosenArea / devMode のときは、ブリーフィングの「離陸!」ボタンで startFlight が呼ばれる。
// ?fpv=1 を付けるとゴンドラ視点で開始(視点確認用、離陸後に反映される)
if (!setupMode && !hasChosenArea && !devMode) {
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
    updateFlightWindCalcDebug(w);
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
