// 飛行ログ(IGC)の3D表示 —— ?igc=1 専用
//
// 既定の起動・?setup=1・?a=・?dev=1 には一切関与しない。
// main.js からの入口は selectIgcFlight() と buildIgcScene() の2つだけ。
//
// **地面から軌跡まで板を立てて、高度で色をつける**(3Dの標準的な手法)。
// 軌跡の線だけでは高さが読めず、ゴールへの寄せ方は地面と目標が一緒に見えないと分からない。
//
// ⚠ 画面に実在の航空写真と実際の飛行軌跡が出るため、**離着陸地点がそのまま写る**。
//   IGCには通常、パイロット名・1秒ごとの位置履歴・離着陸地点が含まれる。
//   ファイルはブラウザの中だけで処理し、どこへも送信しない。
//
// ⚠ 表示物はすべて fog: false にしてある。SORAの霧は4000m先から掛かるが、
//   飛行は数km規模になることがあり、霧に入ると軌跡が読めなくなるため(2026-08-24)。

import * as THREE from 'three';
import { parseIgc, buildFlight, jstLabel } from './igc.js';

const GOAL_COLOR = 0xd94b32;
const MARKER_COLOR = 0x9a5cd0;
const TAKEOFF_COLOR = 0x2a78d6;

// 高度の色。低い=青 → 中=青緑 → 高い=黄(2Dツールと同じ並び)
function altitudeColor(t) {
  const stops = [[0.17, 0.24, 0.56], [0.12, 0.61, 0.54], [0.88, 0.73, 0.23]];
  const clamped = Math.max(0, Math.min(1, t));
  const i = clamped < 0.5 ? 0 : 1;
  const local = clamped < 0.5 ? clamped * 2 : (clamped - 0.5) * 2;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local, a[2] + (b[2] - a[2]) * local];
}

// ---- ファイル選択 ----------------------------------------------------------

export function selectIgcFlight() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:9000; display:flex; align-items:center; justify-content:center;
      background:#0d0d0d; color:#fff; font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;`;
    overlay.innerHTML = `
      <div style="max-width:560px; padding:28px 32px; background:#1a1a19; border:1px solid rgba(255,255,255,.12); border-radius:10px">
        <h2 style="margin:0 0 6px; font-size:19px">飛行ログ(IGC)を3Dで見る</h2>
        <p style="margin:0 0 18px; color:#c3c2b7; font-size:13px">
          離陸地点の地形を地理院タイルから組み、軌跡を地面まで下ろした板で描きます。
          ゲームは開始しません。</p>
        <p style="margin:0 0 18px; padding:10px 14px; background:#2a2413; border:1px solid #4d431f; border-radius:6px; color:#e3d094; font-size:13px">
          <strong>⚠ 画面に離着陸地点が写ります。</strong>
          実在の航空写真の上に実際の飛行軌跡を描くため、
          <strong>スクリーンショットを共有すると、どこから飛んでどこへ降りたかが分かります</strong>。
          自分以外の方のログを扱うときは、提供者の意向をご確認ください。</p>
        <p style="margin:0 0 14px; color:#c3c2b7; font-size:13px">
          ファイルはブラウザの中だけで処理し、<strong>どこにも送信しません</strong>。</p>
        <!-- accept は付けない。iOSは拡張子ではなくUTIで判定し、.igc は未登録のため
             accept を書くとファイルが灰色になって選べなくなる(2026-08-28にiPhoneで確認) -->
        <input type="file" id="igc-pick"
               style="font:inherit; font-size:13px; color:#c3c2b7">
        <p id="igc-err" style="margin:14px 0 0; color:#ef7a63; font-size:13px; display:none"></p>

        <div id="igc-modes" style="display:none; margin-top:18px; border-top:1px solid rgba(255,255,255,.12); padding-top:16px">
          <div id="igc-summary" style="color:#c3c2b7; font-size:13px; margin-bottom:12px"></div>
          <div style="display:flex; flex-direction:column; gap:8px">
            <button data-mode="view" style="text-align:left; padding:10px 14px; font:inherit; cursor:pointer;
                    background:#26261f; color:#fff; border:1px solid rgba(255,255,255,.18); border-radius:7px">
              <strong>見る</strong>
              <span style="display:block; color:#b9b8b0; font-size:12px">
                軌跡を板で描くだけ。飛びません（従来どおり）</span></button>
            <button data-mode="fly" style="text-align:left; padding:10px 14px; font:inherit; cursor:pointer;
                    background:#26261f; color:#fff; border:1px solid rgba(255,255,255,.18); border-radius:7px">
              <strong>飛ぶ（復習）</strong>
              <span style="display:block; color:#b9b8b0; font-size:12px">
                同じ離陸地点・実測の風で自分が操縦する。板を追いかけて追体験できます</span></button>
            <button data-mode="trace" style="text-align:left; padding:10px 14px; font:inherit; cursor:pointer;
                    background:#26261f; color:#fff; border:1px solid rgba(255,255,255,.18); border-radius:7px">
              <strong>なぞる（検証）</strong>
              <span style="display:block; color:#b9b8b0; font-size:12px">
                高度だけ実測どおりに動かし、水平は風モデルに任せる。
                <strong>ずれは必ず出ます</strong>（実測で数百m）。
                答え合わせではなく、どこで開くかを見るためのものです</span></button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let loaded = null;
    // 想定内のエラー(日本語の完結した文)はそのまま、想定外(TypeError等)だけ前置きを付ける
    const showError = (message) => {
      const err = overlay.querySelector('#igc-err');
      err.textContent = /。$/.test(message) ? message : '読み取れませんでした: ' + message;
      err.style.display = '';
      overlay.querySelector('#igc-modes').style.display = 'none';
    };

    overlay.querySelector('#igc-pick').addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          loaded = buildFlight(parseIgc(reader.result));
          const rows = loaded.pibalRows.length;
          overlay.querySelector('#igc-summary').innerHTML =
            `${loaded.dateText}　${jstLabel(loaded.takeoff.seconds).slice(0, 5)}〜`
            + `${jstLabel(loaded.landing.seconds).slice(0, 5)} JST　`
            + `高度 ${Math.round(loaded.mslRange[0])}〜${Math.round(loaded.mslRange[1])} m<br>`
            + `実測の風: <strong>${rows}層</strong>（n が10未満の高度帯は除いています）`;
          overlay.querySelector('#igc-modes').style.display = '';
          overlay.querySelector('#igc-err').style.display = 'none';
        } catch (e) {
          showError(e.message);
        }
      };
      // 動画などを選ぶと readAsText が固まる。IGCは1時間の飛行でも数百KB
      if (file.size > 20 * 1024 * 1024) {
        showError('ファイルが大きすぎます（' + Math.round(file.size / 1024 / 1024) + 'MB）。'
          + 'IGCファイルではないようです。動画や写真を選んでいないかご確認ください。');
        return;
      }
      reader.readAsText(file, 'utf-8');
    });

    for (const button of overlay.querySelectorAll('#igc-modes button')) {
      button.addEventListener('click', () => {
        if (!loaded) return;
        overlay.remove();
        resolve({ flight: loaded, mode: button.dataset.mode });
      });
    }
  });
}

// ---- 3D ------------------------------------------------------------------

function makeLabel(text, color) {
  const pad = 8, font = 'bold 34px system-ui, sans-serif';
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const width = Math.ceil(measure.measureText(text).width) + pad * 2;
  const height = 48;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = 'rgba(12,12,12,0.72)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: false, transparent: true, fog: false,
  }));
  sprite.renderOrder = 10;
  // ⚠ 大きさは毎フレーム updateIgcLabels() が決める。
  //   世界座標で固定にすると、**近づいたとき画面いっぱいの白い箱になる**
  //   (2026-08-25に実際に出た。地形に隠れない設定なので余計に目立つ)
  sprite.userData.aspect = width / height;
  sprite.scale.set(width, height, 1);
  return sprite;
}

// ラベルの見かけの大きさを距離によらず一定に保つ。
// 遠くでも読めて、近づいても巨大にならないようにする
const LABEL_ANGULAR_SIZE = 0.055;   // カメラからの距離に対する高さの比
const LABEL_MIN_M = 18;
const LABEL_MAX_M = 260;

export function updateIgcLabels(labels, camera) {
  for (const sprite of labels) {
    const distance = camera.position.distanceTo(sprite.position);
    const height = Math.min(LABEL_MAX_M, Math.max(LABEL_MIN_M, distance * LABEL_ANGULAR_SIZE));
    sprite.scale.set(height * sprite.userData.aspect, height, 1);
  }
}

// 地面から軌跡まで板を立てる。上端は高度の色、下端はそれを暗くした色にして
// 「どこが地面か」が分かるようにする
function buildCurtain(flight, terrain) {
  const [lo, hi] = flight.mslRange;
  const range = Math.max(1, hi - lo);
  const positions = [];
  const colors = [];

  const push = (x, y, z, rgb) => { positions.push(x, y, z); colors.push(rgb[0], rgb[1], rgb[2]); };
  const dim = (c) => [c[0] * 0.22, c[1] * 0.22, c[2] * 0.22];

  for (let i = 1; i < flight.track.length; i++) {
    const a = flight.track[i - 1], b = flight.track[i];
    // 記録が飛んでいるところは繋がない
    if (b.seconds - a.seconds > 30) continue;
    const ga = terrain.getHeight(a.x, a.z);
    const gb = terrain.getHeight(b.x, b.z);
    const ca = altitudeColor((a.y - lo) / range);
    const cb = altitudeColor((b.y - lo) / range);

    // 三角形2枚 (A地面, A上, B上) と (A地面, B上, B地面)
    push(a.x, ga, a.z, dim(ca)); push(a.x, a.y, a.z, ca); push(b.x, b.y, b.z, cb);
    push(a.x, ga, a.z, dim(ca)); push(b.x, b.y, b.z, cb); push(b.x, gb, b.z, dim(cb));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide,
    transparent: true, opacity: 0.72, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // 板より目印を先に見せる。板は深度を書かないので、あとから描く目印が必ず上に乗る
  // (これが無いと、板の中に入った投下点が埋もれて見えなくなる)
  mesh.renderOrder = -1;
  return mesh;
}

function buildTrackLine(flight) {
  const [lo, hi] = flight.mslRange;
  const range = Math.max(1, hi - lo);
  const positions = [];
  const colors = [];
  for (let i = 1; i < flight.track.length; i++) {
    const a = flight.track[i - 1], b = flight.track[i];
    if (b.seconds - a.seconds > 30) continue;
    const ca = altitudeColor((a.y - lo) / range);
    const cb = altitudeColor((b.y - lo) / range);
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    colors.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, fog: false }));
}

// 地面に立てる目印(円盤＋細い柱)。目標も投下点も同じ形にして、色で区別する
function buildStake(x, z, groundY, topY, color, labelText, labels) {
  const group = new THREE.Group();
  const height = Math.max(60, topY - groundY);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(4, 4, height, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, fog: false }));
  pole.position.set(x, groundY + height / 2, z);
  group.add(pole);

  const disc = new THREE.Mesh(
    new THREE.RingGeometry(40, 55, 40),
    new THREE.MeshBasicMaterial({
      color, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false, fog: false,
    }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(x, groundY + 1.5, z);
  group.add(disc);

  const label = makeLabel(labelText, '#ffffff');
  label.position.set(x, groundY + height + 40, z);
  group.add(label);
  if (labels) labels.push(label);

  return group;
}

export function buildIgcScene(flight, terrain) {
  const group = new THREE.Group();
  const labels = [];
  group.add(buildCurtain(flight, terrain));
  group.add(buildTrackLine(flight));

  const points = flight.track.slice();

  // 離陸地点
  const takeoffGround = terrain.getHeight(0, 0);
  group.add(buildStake(0, 0, takeoffGround, takeoffGround + 80, TAKEOFF_COLOR, '離陸', labels));

  // 宣言目標(有効なものだけ立てる。撤回されたものは出さない)
  for (const goal of flight.declarations) {
    if (goal.superseded) continue;
    const ground = terrain.getHeight(goal.x, goal.z);
    const declared = goal.altitudeFt !== null ? goal.altitudeFt / flight.FEET_PER_M : 80;
    group.add(buildStake(goal.x, goal.z, ground, ground + declared, GOAL_COLOR, `目標${goal.number}`, labels));
    points.push({ x: goal.x, z: goal.z, y: ground + declared });
    terrain.requestDetail(goal.x, goal.z);
  }

  // マーカー投下点(投下高度に球、地面まで柱)
  for (const marker of flight.markers) {
    const ground = terrain.getHeight(marker.x, marker.z);
    const top = marker.y !== null ? Math.max(marker.y, ground + 10) : ground + 80;
    group.add(buildStake(marker.x, marker.z, ground, top, MARKER_COLOR, `M${marker.dropOrder}`, labels));
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(14, 16, 12),
      new THREE.MeshBasicMaterial({ color: MARKER_COLOR, fog: false }));
    ball.position.set(marker.x, top, marker.z);
    group.add(ball);
    points.push({ x: marker.x, z: marker.z, y: top });
  }

  terrain.requestDetail(0, 0);

  const bounds = {
    minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)),
    minZ: Math.min(...points.map((p) => p.z)), maxZ: Math.max(...points.map((p) => p.z)),
    minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)),
  };
  return { group, bounds, labels };
}

// ---- 自分の軌跡 ------------------------------------------------------------
// 実測は「板」、自分は「線」で描き分ける。SORAは元々、自分の飛んだ跡を残していない。

export function createOwnTrail(scene, maxPoints = 20000) {
  const positions = new Float32Array(maxPoints * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, 0);
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    color: 0xff3d6e, fog: false, depthTest: false,
  }));
  line.renderOrder = 8;
  scene.add(line);

  let count = 0;
  let lastX = null, lastZ = null;
  return {
    push(x, y, z) {
      if (count >= maxPoints) return;
      // 1m以上動いたときだけ点を足す(静止中に点を積まない)
      if (lastX !== null && Math.hypot(x - lastX, z - lastZ) < 1) return;
      positions[count * 3] = x; positions[count * 3 + 1] = y; positions[count * 3 + 2] = z;
      count++; lastX = x; lastZ = z;
      geometry.setDrawRange(0, count);
      geometry.attributes.position.needsUpdate = true;
      geometry.computeBoundingSphere();
    },
  };
}

// ---- 実測とのずれ ----------------------------------------------------------
// 「なぞる」で使う。同じ経過時間の実測位置と、いまの自分の位置を比べる。
// これがそのまま風モデルの誤差になる(数字は data/IGC分析メモ.md にある)。

export function createDeviationPanel(flight) {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed; right:14px; z-index:500; padding:10px 14px; border-radius:8px;
    background:rgba(16,16,15,.86); color:#fff; border:1px solid rgba(255,255,255,.14);
    font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; min-width:190px;
    font-variant-numeric:tabular-nums;`;
  document.body.appendChild(el);
  // パイバル表(#pibal)と重ならないよう、その下に置く(表の行数で高さが変わるので実測する)
  const pibalEl = document.getElementById('pibal');
  const below = pibalEl ? pibalEl.getBoundingClientRect().bottom + 10 : 14;
  el.style.top = `${Math.round(below)}px`;

  // ⚠ この数字を「再現の精度」と読ませない。理念「誤情報で混乱を生まない」に直接あたる部分。
  //   高度帯の風は「その帯にいた時刻の平均」なので、原理的にずれる(実測で平均200〜500m)
  const caveat = document.createElement('div');
  caveat.style.cssText = 'color:#e3d094; font-size:11px; line-height:1.5; margin-top:8px; max-width:230px';
  caveat.innerHTML = `
    ※ この風は「その高度に<strong>いた時刻</strong>の平均」です。
    同じ高度に戻っても時刻が違えば風は違うため、<strong>ずれは必ず出ます</strong>。
    <strong>答え合わせには使えません</strong>（実測で平均200〜500m）。`;

  let maxDeviation = 0;
  let sum = 0, samples = 0;

  return {
    update(elapsedSeconds, x, z) {
      const t = flight.takeoff.seconds + elapsedSeconds;
      // 実測のその時刻の位置(1秒ごとの記録なので最も近い点を採る)
      let nearest = null;
      for (const p of flight.track) {
        const dt = Math.abs(p.seconds - t);
        if (!nearest || dt < nearest.dt) nearest = { dt, p };
        if (p.seconds > t + 2) break;
      }
      if (!nearest || nearest.dt > 5) return;
      const deviation = Math.hypot(x - nearest.p.x, z - nearest.p.z);
      maxDeviation = Math.max(maxDeviation, deviation);
      sum += deviation; samples++;
      const mm = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
      const ss = String(Math.floor(elapsedSeconds % 60)).padStart(2, '0');
      el.innerHTML = `
        <div style="font-weight:600; margin-bottom:4px">実測とのずれ</div>
        <div style="font-size:22px">${Math.round(deviation)} <span style="font-size:13px">m</span></div>
        <div style="color:#b9b8b0; font-size:12px">
          平均 ${Math.round(sum / samples)} m ／ 最大 ${Math.round(maxDeviation)} m<br>
          離陸から ${mm}:${ss}
        </div>`;
      el.appendChild(caveat);
    },
    finish() {
      if (!samples) return;
      el.innerHTML += `<div style="color:#e3d094; font-size:12px; margin-top:6px">終了</div>`;
    },
  };
}

// ---- 方位表示 --------------------------------------------------------------
// 風の話をする道具なので、どちらが北かは常に見えている必要がある。
// ゲームのコンパス(#compass)は気球用なので使わず、見るだけのモード用に別に置く。
// 世界座標は x=東+ / z=南+ なので、北は -z 方向。

export function createNorthIndicator() {
  const size = 74;
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed; right:14px; bottom:14px; z-index:500; width:${size}px; height:${size}px;
    border-radius:50%; background:rgba(16,16,15,.72); border:1px solid rgba(255,255,255,.16);
    backdrop-filter:blur(6px);`;
  el.innerHTML = `
    <svg viewBox="0 0 100 100" width="${size}" height="${size}">
      <g id="north-rot" transform="rotate(0 50 50)">
        <polygon points="50,12 41,54 50,48 59,54" fill="#e05a3f"/>
        <polygon points="50,88 41,46 50,52 59,46" fill="#e8e8e2"/>
        <text x="50" y="30" text-anchor="middle" font-size="17" font-weight="700"
              fill="#fff" font-family="system-ui,sans-serif">N</text>
      </g>
    </svg>`;
  document.body.appendChild(el);
  const rot = el.querySelector('#north-rot');

  return {
    update(camera, target) {
      // カメラが向いている方位(北から時計回り)。その逆に矢印を回せば北を指す
      const fx = target.x - camera.position.x;
      const fz = target.z - camera.position.z;
      if (fx === 0 && fz === 0) return;
      const bearing = Math.atan2(fx, -fz) * 180 / Math.PI;
      rot.setAttribute('transform', `rotate(${-bearing} 50 50)`);
    },
  };
}

// ---- 説明パネル ------------------------------------------------------------

export function showIgcPanel(flight, options = {}) {
  const durationMin = Math.round((flight.landing.seconds - flight.takeoff.seconds) / 60);
  const goalRows = flight.declarations
    .filter((g) => !g.superseded)
    .sort((a, b) => a.number - b.number)
    .map((g) => `<tr><td>目標${g.number}</td><td>${jstLabel(g.seconds)}</td>`
      + `<td>${Math.round(g.distance)} m</td>`
      + `<td>${g.altitudeFt !== null ? g.altitudeFt + ' ft' : '—'}</td></tr>`);
  const markerRows = flight.markers
    .sort((a, b) => a.seconds - b.seconds)
    .map((m) => {
      const nearest = m.nearest
        ? `目標${m.nearest.number}へ ${Math.round(m.nearest.distance)} m`
        : '—';
      const others = m.distances.slice(1)
        .map((d) => `目標${d.number} ${Math.round(d.distance)} m`).join('／');
      const note = others ? `<span style="opacity:.6"><br>${others}</span>` : '';
      return `<tr><td>投下${m.dropOrder}</td><td>${jstLabel(m.seconds)}</td>`
        + `<td>${nearest}${note}</td>`
        + `<td>${m.agl !== null ? '対地 ' + Math.round(m.agl) + ' m' : '—'}</td></tr>`;
    });

  const panel = document.createElement('div');
  panel.style.cssText = `
    position:fixed; top:12px; left:12px; z-index:500; max-width:340px; max-height:calc(100vh - 24px);
    overflow:auto; padding:14px 16px; border-radius:9px;
    background:rgba(16,16,15,.86); color:#fff; backdrop-filter:blur(6px);
    border:1px solid rgba(255,255,255,.12);
    font:13px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;`;
  panel.innerHTML = `
    <div style="font-size:15px; font-weight:600; margin-bottom:2px">飛行ログ 3D表示</div>
    <div style="color:#b9b8b0; font-size:12px; margin-bottom:10px">
      ${flight.dateText}　${jstLabel(flight.takeoff.seconds).slice(0, 5)}〜${jstLabel(flight.landing.seconds).slice(0, 5)} JST（${durationMin}分）<br>
      高度 ${Math.round(flight.mslRange[0])}〜${Math.round(flight.mslRange[1])} m（海抜相当）　記録 ${flight.counts.fixes}点
    </div>
    ${goalRows.length || markerRows.length ? `
      <table style="width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; margin-bottom:10px">
        <tr style="color:#8f8e86; font-size:11px; text-align:left">
          <th></th><th>時刻</th><th style="text-align:right">距離</th><th style="text-align:right">高度</th></tr>
        ${goalRows.join('')}${markerRows.join('')}
      </table>
      <div style="color:#8f8e86; font-size:11px; margin-bottom:10px">
        目標の距離は離陸地点から。投下は<strong>最寄りの目標</strong>までを主に、他も薄字で併記します。
        <strong>番号どうしは対応しません</strong>（競技のPDGは最も近い宣言目標で採点し、
        またこのログは練習フライトです）。<strong>得点は出しません。</strong>
      </div>` : ''}
    <div style="padding:8px 10px; background:rgba(77,67,31,.5); border:1px solid #4d431f; border-radius:5px; color:#e3d094; font-size:12px">
      <strong>⚠ 画面に離着陸地点が写ります。</strong>
      共有すると、どこから飛んでどこへ降りたかが分かります。
    </div>
    <div style="color:#8f8e86; font-size:11px; margin-top:8px">
      色は高度（低い=青／高い=黄）。板は地面まで下ろしたもの。<br>
      ドラッグで回転、ホイールで拡大、右ドラッグで平行移動。
    </div>`;
  document.body.appendChild(panel);

  // 邪魔にならないよう畳めるようにする。
  // 飛ぶ・なぞるでは計器パネルと同じ位置に出るので、最初から畳んでおく
  const title = panel.firstElementChild;
  title.style.cursor = 'pointer';
  let folded = false;
  const apply = () => {
    for (const child of [...panel.children].slice(1)) child.style.display = folded ? 'none' : '';
    title.title = folded ? 'クリックで開く' : 'クリックで畳む';
    title.textContent = folded ? '飛行ログ 3D表示 ▸' : '飛行ログ 3D表示';
  };
  title.addEventListener('click', () => { folded = !folded; apply(); });
  if (options.collapsed) { folded = true; }
  apply();
  if (options.collapsed) {
    // 計器パネルを避けて下に置く
    panel.style.top = 'auto';
    panel.style.bottom = '14px';
  }
}

// 飛ぶ・なぞるでは計器を残すが、意味を失うものだけ消す。
//   ターゲット … JDGのターゲットは世界原点(=IGCの離陸地点)なので「離陸地点までの距離」になる
//   残り時間   … IGCモードでは時計を止めている(実測が30分を超えることがあるため)
//   マーカー   … 飛行ログのモードに得点は無い(投下も塞いである)
export function trimGameUiForIgc() {
  for (const id of ['target-info', 'clock', 'marker-info']) {
    const el = document.getElementById(id);
    if (el && el.parentElement) el.parentElement.style.display = 'none';
  }
  // ⚠ 住所検索は隠す。検索すると ?a= を足して再読み込みするが、**?igc=1 が残ったまま**なので
  //   IGCモードで起動し直し、ファイル選択に戻ってしまう(2026-08-25に実際に出た)。
  //   エリアはIGCの離陸地点から決まるので、そもそもこのモードで動かす意味がない
  const search = document.getElementById('area-search');
  if (search) search.style.display = 'none';
}

// ゲーム用のUI(計器・コンパス・操作ボタンなど)は出さない。
// ⚠ #app は3Dキャンバスの入れ物なので**隠してはいけない**(2026-08-24に一度これで画面が真っ黒になった)
export function hideGameUi() {
  const ids = ['instruments', 'status', 'clock', 'compass', 'help', 'touch-controls',
    'pibal', 'credit', 'area-search', 'target-info', 'marker-info', 'flight-windcalc-debug'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}
