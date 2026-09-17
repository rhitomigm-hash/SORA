// SORA側の地上クルー統合。道路・走行はGameTarget由来、操作・報告はパイロット向け。
// 飛行状態は参照だけにし、気球の物理・風・採点を変更しない。
import { loadRoads } from './road.js';
import { createChaseCar } from './chasecar.js';

const distanceText = (m) => m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(2)}km`;

export function createGroundCrew({ scene, terrain, area, launch, goal, goalLabel, windAt, getBalloon }) {
  const panel = document.getElementById('ground-crew');
  const status = document.getElementById('crew-status');
  const bounds = { minX: terrain.map.minX, minZ: terrain.map.minZ,
    maxX: terrain.map.minX + terrain.sizeMeters, maxZ: terrain.map.minZ + terrain.sizeMeters };
  let roads = null, white = null, blue = null;
  let streaming = false, streamTurn = 0, lastStream = 0;

  // 既存の操作説明・タッチ操作・コンパスより上。オーバーレイより上には出さない。
  function layout() {
    const obstacles = ['help', 'touch-controls', 'compass', 'credit'];
    let bottom = 12;
    const own = panel.getBoundingClientRect();
    for (const id of obstacles) {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.left < own.right && r.right > own.left) {
        bottom = Math.max(bottom, innerHeight - r.top + 8);
      }
    }
    panel.style.bottom = `${bottom}px`;
    panel.style.maxHeight = `${Math.max(60, innerHeight - bottom - 80)}px`;
    panel.style.overflowY = 'auto';
  }
  const observer = new ResizeObserver(layout);
  for (const id of ['help', 'touch-controls', 'credit', 'ground-crew']) observer.observe(document.getElementById(id));
  addEventListener('resize', layout);
  layout();

  function reportCar(car, label) {
    if (!car) return `${label}：現在の道路データでは離陸地点付近に配置できません。`;
    const c = car.info();
    const destination = c.hasGoal ? goal : getBalloon();
    const dist = distanceText(Math.hypot(c.x - destination.x, c.z - destination.z));
    const to = c.hasGoal ? goalLabel : '気球';
    let state;
    if (c.arrived) state = '到着・待機';
    else if (c.waiting) state = '気球付近で待機';
    else if (c.halted || c.stuck) {
      const incomplete = roads.stats.capped || roads.stats.tilesFailed > 0 || roads.pendingAround(c.x, c.z) > 0;
      state = incomplete ? '待機・道路データを確認中' : '現在の道路データではこれ以上進めず待機';
    } else state = '移動中';
    const wind = windAt(terrain.getHeight(c.x, c.z), c.x, c.z);
    const direction = ((Math.round(wind.dir) % 360) + 360) % 360;
    return `${label}：${to}まで${dist}、${state}。現在地の地上風 ${String(direction).padStart(3, '0')}度 ${wind.kt.toFixed(1)}ノット。`;
  }

  function query() {
    if (!roads) return;
    // 自動警告ではなく、開いた時・問い合わせた時点の報告として固定する。
    document.getElementById('crew-white').textContent = reportCar(white, '白・追尾車');
    document.getElementById('crew-blue').textContent = reportCar(blue, '青・先行車');
    layout();
  }
  function toggleRadio() { panel.open = !panel.open; }
  panel.addEventListener('toggle', () => { if (panel.open) query(); layout(); });
  document.getElementById('crew-query').addEventListener('click', query);

  function updateStatus() {
    const notes = [];
    if (!white || !blue) notes.push('一部または全部の車を配置できませんでした');
    if (roads.stats.tilesFailed) notes.push('一部の道路データを取得できませんでした');
    if (roads.stats.capped) notes.push('道路の読み込み上限に達しました');
    status.textContent = notes.length ? `${notes.join('。')}。飛行は続けられます。`
      : `白は気球を追尾、青は${goalLabel}付近へ先行。報告は問い合わせ時点のものです。`;
  }

  const ready = (async () => {
    try {
      // 出発地点から読む。読み込み中も気球は飛べるが、車は保存した離陸地点から出す。
      roads = await loadRoads({ centerLon: area.lon, centerLat: area.lat, getHeight: terrain.getHeight,
        initialX: launch.x, initialZ: launch.z, radiusM: 2500, streamRadiusM: 2500, maxTilesTotal: 64,
        onProgress: (done, total) => { status.textContent = `離陸地点付近の道路を読み込み中… ${done}/${total}（飛行は続けられます）`; } });
      scene.add(roads.group);
      document.getElementById('credit-road').hidden = false;
      // 遠方にだけ道がある場合に、そこへ突然配置しない。
      const nearLaunch = (car) => car && Math.hypot(car.info().x - launch.x, car.info().z - launch.z) <= 2500;
      const discard = (car) => car?.group.traverse(o => {
        o.geometry?.dispose();
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material?.dispose();
      });
      white = createChaseCar({ graph: roads.graph, getHeight: terrain.getHeight,
        startX: launch.x, startZ: launch.z, bounds, kind: 'van', bodyColor: 0xf0f0f0 });
      if (!nearLaunch(white)) { discard(white); white = null; }
      const other = white?.info() || launch;
      blue = createChaseCar({ graph: roads.graph, getHeight: terrain.getHeight,
        startX: launch.x, startZ: launch.z, bounds, kind: 'car', bodyColor: 0x2f5f9e,
        goal: { ...goal, standoffM: 100 }, spawnAwayFrom: { x: other.x, z: other.z, minM: 20 } });
      if (!nearLaunch(blue)) { discard(blue); blue = null; }
      for (const [car, color] of [[white, 0xffffff], [blue, 0x5a9cff]]) {
        if (!car) continue;
        car.group.userData.mark.material.color.setHex(color);
        scene.add(car.group);
      }
      updateStatus();
      if (panel.open) query();
    } catch (err) {
      status.textContent = '道路・クルーを準備できませんでした。飛行は続けられます。';
      console.warn('地上クルーの準備に失敗:', err);
    }
  })();

  function update(dt) {
    const balloon = getBalloon();
    white?.update(dt, balloon.x, balloon.z);
    blue?.update(dt);
    if (!roads || streaming || performance.now() - lastStream < 3000) return;
    // 車・気球・目標の周囲を交代で読む。読み込み中に次の要求を重ねない。
    const centers = [balloon, goal, ...(white ? [white.info()] : []), ...(blue && !blue.info().arrived ? [blue.info()] : [])];
    const center = centers[streamTurn++ % centers.length];
    streaming = true;
    lastStream = performance.now();
    roads.ensureAround(center.x, center.z).then(updateStatus).catch(err => {
      status.textContent = '追加の道路を読み込めませんでした。飛行は続けられます。';
      console.warn('道路の追加取得に失敗:', err);
    }).finally(() => { streaming = false; });
  }

  return { update, toggleRadio, ready,
    info: () => ({ white: white?.info() || null, blue: blue?.info() || null,
      launch: { ...launch }, goal: { ...goal }, stats: roads?.stats }) };
}
