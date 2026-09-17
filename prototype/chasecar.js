// チェイスカー(地上クルー): road.js が組んだ道路グラフの上を車が走る。
//
// **走らせるだけ。**風にも高度計算にも当たり判定にも一切関与しない。
// 報告の文面は main.js 側(第3段階)。指示(第4段階)はまだ実装していない。
//
// 2台ある(どちらもこの関数で作る。違いは引数だけ):
//   1号車 … 気球を自動追尾する(kind:'van')。既定の動き
//   2号車 … 気球を追わず、**ターゲットへ向かって手前で待機する**(kind:'car' + goal)。
//            到着したら追尾には戻らず、経路探索も辺上の移動計算も止まる = 1号車より軽い
//
// 設計の要点(tmp/チェイスカー仕様メモ.md):
//   - 既定は自動追尾。プレイヤーは何もしなくてよい
//   - **経路探索は毎フレーム回さない**
//   - 高速道路は走らない(`isMotorway`)。気球を追えないため
//
// 実装してみて外れた想定(2026-08-27):
//   当初は「交差点で気球の方向に最も近い辺を選ぶだけで追尾が成立する」と考えたが、
//   **成立しなかった**。30分の走行で 渡良瀬は11km走って出発点から586m しか進めず、
//   気球との距離は平均5,050m・最大9,546m。角度だけを見ると細街路の格子で堂々巡りになる。
//   そこで A*(コストは所要時間)で経路を出し、**数秒おきに引き直す**方式にした。
//   毎フレームではないので負荷は軽い(実測は下の PATHFIND_INTERVAL の注記を参照)
import * as THREE from 'three';
import { isMotorway, DRAPE_LIFT } from './road.js';

// 幅員区分(rnkWidth)ごとの走行速度の**目安**(km/h)。
// 実測に基づく基準ではないので、UI に出すときも「目安」と明示すること。
//   0:3m未満 / 1:3〜5.5m / 2:5.5〜13m / 3:13〜19.5m / 4:19.5m以上 / 5:その他 / 6:不明
const SPEED_KMH = [20, 30, 40, 50, 50, 30, 30];
const DEFAULT_SPEED_KMH = 30;

// 車を置く高さ(m)。**道路の描画面と同じにする。**
// 地面基準(0.6m)にしていたときは、1.5m に浮かせて描いた道路の線が
// 車体の窓のあたりを突き抜けていた(外部視点で車のそばに寄って発覚、2026-08-28)
const CAR_LIFT = DRAPE_LIFT;
const TURN_RATE = 3.0;     // 車体の向きが追従する速さ(rad/s)。カクつきを抑える見た目だけの処理
const MAX_SPEED_MPS = 50 / 3.6;  // A* のヒューリスティックに使う上限速度
const PATHFIND_INTERVAL = 5;     // 経路を引き直す間隔(ゲーム内秒)。毎フレームではない
const ARRIVE_M = 150;            // 気球の真下にこれだけ近づいたら、その場で待つ

// 2点間の方位(x:東+, z:南+ なので atan2(dx, -dz) が北基準の時計回り)
const bearing = (dx, dz) => Math.atan2(dx, -dz);

// 角度差を -π〜π に畳む
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

function speedMps(props) {
  const kmh = SPEED_KMH[props.rnkWidth] ?? DEFAULT_SPEED_KMH;
  return (kmh * 1000) / 3600;
}

// --- 経路探索 --------------------------------------------------------------

// 最小ヒープ(A* の open set)。依存を増やさないため最小限だけ書く
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* で startNode から goalNode までの辺の並びを求める。コストは**所要時間**(秒)で、
 * 幅の広い道ほど速いので、遠回りでも走りやすい道が選ばれる。
 *
 * 道路網は連結成分が1つとは限らない(上士幌のような疎な地域では実測で71%)。
 * 気球の真下が別の成分にあると経路は引けないが、そこで諦めると角度による選択に落ちて
 * 堂々巡りになる。**到達できた範囲でいちばん気球に近いノードまでの経路を返す**。
 * 実際のチェイスカーも、道が続いていなければ行けるところまで行って待つ。
 *
 * @param {string|null} goalKey 目的地のノード。**null なら「goalPoint にいちばん近づけた場所」**
 *   を目的地にする(2号車。立入らない範囲があるので、着く先を先に1点へ決められない)
 * @param {object} [opts]
 * @param {(k:string)=>boolean} [opts.blocked] そのノードへ**入ってはいけない**なら true
 * @param {(e:object)=>boolean} [opts.blockedEdge] その辺を**通ってはいけない**なら true。
 *   両端が範囲の外でも、**道そのものが範囲の中を通り抜ける**ことがある
 * @param {{x:number,z:number}} [opts.goalPoint] ヒューリスティックの基準点
 * @returns {string[]|null} 辺キーの配列。1歩も進めないときだけ null
 */
function findRoute(nodes, edges, startKey, goalKey, opts = {}) {
  const { blocked = null, blockedEdge = null, goalPoint = null } = opts;
  if (goalKey !== null && startKey === goalKey) return [];
  const goal = goalPoint || nodes.get(goalKey);
  if (!goal) return null;

  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();      // nodeKey -> {from, edgeKey}
  const closed = new Set();
  const open = new MinHeap();
  const h = (n) => Math.hypot(n.x - goal.x, n.z - goal.z) / MAX_SPEED_MPS;
  open.push({ key: startKey, f: h(nodes.get(startKey)) });

  // 到達できた中でいちばん目的地に近かったノード(経路が引けなかったときの行き先)
  let bestKey = startKey, bestH = h(nodes.get(startKey));
  // **出発点そのものが「入ってはいけない場所」なら、そこを行き先にしてはいけない。**
  // 立入制限の範囲の中から出発した2号車が、その場に居座ってしまう
  if (blocked && blocked(startKey)) bestH = Infinity;

  const reconstruct = (endKey) => {
    const route = [];
    let k = endKey;
    while (cameFrom.has(k)) { const c = cameFrom.get(k); route.push(c.edgeKey); k = c.from; }
    return route.reverse();
  };

  let guard = 0;
  while (open.size > 0 && guard++ < 60000) {
    const cur = open.pop();
    if (closed.has(cur.key)) continue;
    closed.add(cur.key);
    if (cur.key === goalKey) return reconstruct(goalKey);
    const node = nodes.get(cur.key);
    if (!node) continue;
    // 行き先の候補にできるのは**入ってよい場所だけ**。中から外へ出る途中で
    // 通っただけの立入禁止ノードを行き先にしてはいけない
    const hc = h(node);
    if (hc < bestH && !(blocked && blocked(cur.key))) { bestH = hc; bestKey = cur.key; }
    const base = gScore.get(cur.key);
    for (const ek of node.edgeKeys) {
      const e = edges.get(ek);
      if (!e || isMotorway(e.props)) continue;
      const next = e.a === cur.key ? e.b : e.a;
      if (next === cur.key || closed.has(next)) continue;
      // 立入らない範囲・地形の外へは**入らない**。ただし**一方通行の壁**にする:
      // 中から外へは出られる。両方向を塞ぐと、範囲の中に置かれた車が
      // 「周りが全部立入禁止」で永久に出られなくなる
      const escaping = blocked && blocked(cur.key);
      if (blocked && blocked(next) && !escaping) continue;
      if (blockedEdge && blockedEdge(e) && !escaping) continue;
      const cost = e.lengthM / speedMps(e.props);
      const g = base + cost;
      if (gScore.has(next) && gScore.get(next) <= g) continue;
      gScore.set(next, g);
      cameFrom.set(next, { from: cur.key, edgeKey: ek });
      const nn = nodes.get(next);
      if (nn) open.push({ key: next, f: g + h(nn) });
    }
  }
  // 目的地に届かなかった。行けるところまでの経路を返す
  return bestKey === startKey ? null : reconstruct(bestKey);
}

// 車体(見た目)。2台を**形で**見分けられるようにする:
//   'van' … 1号車。ハイエース型(背の高い箱に短い鼻)。機材と回収要員を積む車
//   'car' … 2号車。自家用車型(低くて短い)。ターゲット付近へ先行する車
//
// **前(鼻)は必ず局所 -Z に置くこと。**進行方向は place() の rotation.y = -heading で
// 局所 -Z に一致する。前後を逆に作ると、走行中に後ろ向きに走って見える
const CAR_SHAPES = {
  van: {
    // 実車のハイエース(標準ボディ)に近い寸法: 全長4.7m / 全幅1.7m / 全高2.0m
    lower: { w: 1.70, h: 1.05, l: 4.70, y: 0.52, z: 0 },
    cabin: { w: 1.64, h: 0.90, l: 3.70, y: 1.50, z: 0.45 },  // 箱が後ろ寄り = 鼻が短い
    glass: { w: 1.56, h: 0.72, l: 0.10, y: 1.50, z: -1.40 },
  },
  car: {
    // セダン/ハッチバック相当: 全長4.3m / 全幅1.75m / 全高1.45m
    lower: { w: 1.75, h: 0.78, l: 4.30, y: 0.39, z: 0 },
    cabin: { w: 1.58, h: 0.56, l: 2.10, y: 1.06, z: 0.25 },  // 客室は中央やや後ろ
    glass: { w: 1.50, h: 0.46, l: 0.10, y: 1.06, z: -0.80 },
  },
};

function buildCarMesh(kind = 'van', bodyColor = 0xf0f0f0) {
  const group = new THREE.Group();
  group.name = `chase-car-${kind}`;
  const s = CAR_SHAPES[kind] ?? CAR_SHAPES.van;

  const box = (d, color) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(d.w, d.h, d.l),
      new THREE.MeshLambertMaterial({ color }),
    );
    m.position.set(0, d.y, d.z);
    return m;
  };

  group.add(box(s.lower, bodyColor));
  group.add(box(s.cabin, bodyColor));
  // フロントガラス。**どちらが前か**を一目で分かるようにするための面(局所 -Z 側)
  group.add(box(s.glass, 0x2a3442));

  // 上空からの目印。1000ft を超えると車そのものは1px にもならないので、
  // 見つけるための細い柱を立てる(地形には隠れる = 尾根の向こうなら見えない)
  const mark = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 60, 6),
    new THREE.MeshBasicMaterial({
      color: 0xffd24a, transparent: true, opacity: 0.55, depthWrite: false,
    }),
  );
  mark.position.y = 30;
  group.add(mark);

  group.userData.mark = mark;   // 車のそばで見るときは邪魔になるので消せるようにしておく
  return group;
}

/**
 * 道路グラフの上を走るチェイスカーを作る。
 *
 * @param {object} opts
 * @param {{nodes:Map, edges:Map}} opts.graph   loadRoads が返した graph
 * @param {(x:number,z:number)=>number} opts.getHeight terrain.js の getHeight
 * @param {number} opts.startX  初期位置(この点に最も近い道路から走り始める)
 * @param {number} opts.startZ
 * @param {'van'|'car'} [opts.kind='van'] 車種。1号車はハイエース型、2号車は自家用車型
 * @param {number} [opts.bodyColor=0xf0f0f0] 車体の色。2号車は濃い青
 * @param {{x:number,z:number,standoffM:number,arriveBandM?:number}} [opts.goal=null]
 *   **2号車**。気球を追わず、この点(ターゲット)へ向かい、standoffM の内側には
 *   **入らずに**、寄れるところまで寄って待つ。到着したら**追尾には戻らない**
 * @param {{x:number,z:number,minM:number}} [opts.spawnAwayFrom=null]
 *   **2号車**。この点(1号車)から minM 以上離れた最寄りの端点に置く
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} [opts.bounds=null]
 *   ここから外へは走らせない。**地形(DEM)の範囲**を渡すこと。外へ出ると
 *   getHeight が 0(海面)を返し、車が地面の下に埋まって見えなくなる
 * @returns {{group:THREE.Group, update:Function, info:Function}|null}
 *   走れる道路が無ければ null
 */
export function createChaseCar({
  graph, getHeight, startX = 0, startZ = 0, kind = 'van', bodyColor = 0xf0f0f0,
  goal = null, spawnAwayFrom = null, bounds = null,
}) {
  const { nodes, edges } = graph;

  // 走行可能な辺だけを対象にする(高速道路は除く)
  const drivable = [...edges.values()].filter((e) => !isMotorway(e.props));
  if (drivable.length === 0) return null;

  // その端点に接している走行可能な辺(車を置ける交差点かどうかの判定を兼ねる)。
  // 2号車は、立入制限の範囲を通り抜ける道の上には置かない
  const drivableAt = (nodeKey) => {
    const n = nodes.get(nodeKey);
    if (!n) return null;
    for (const ek of n.edgeKeys) {
      const e = edges.get(ek);
      if (e && !isMotorway(e.props) && !blockedEdgeZone(e)) return e;
    }
    return null;
  };

  // ターゲットからの距離。2号車の立入判定と到着判定に使う
  const goalDist = (x, z) => Math.hypot(x - goal.x, z - goal.z);

  // **入ってはいけないノード。**2つの理由がある:
  //
  // 1. 地形(DEM)の外。terrain.js の getHeight はそこで 0(海面)を返すので、車は
  //    **地面の下に埋まって見えなくなる**。実際に画面で「2台ともいなくなった」
  //    (2026-08-28)。道路グラフは地形より広く読めるので、境界は道路側では守れない
  // 2. ターゲットの立入制限の範囲(2号車のみ)。当初は「standoffM 以上離れた
  //    最寄りの端点」を目的地にしていたが、**そこへ行く経路がターゲットの真横を
  //    通り抜けていた**(実データで最接近17m → その後1,806m離れる)。
  //    立入らないための 100m なのに、そこを突っ切っては意味がない。
  //    → 範囲の中へは**入らない**ことにして、目的地は「入らずに寄れるいちばん近い場所」
  //      にした。通り過ぎが原理的に起きなくなる
  //
  // ただし**一方通行の壁**にする(中から外へは出られる)。両方向を塞ぐと、
  // 範囲の中に置かれた車が永久に出られない
  const margined = bounds && {
    minX: bounds.minX + 200, maxX: bounds.maxX - 200,
    minZ: bounds.minZ + 200, maxZ: bounds.maxZ - 200,
  };
  function blockedNode(key) {
    const n = nodes.get(key);
    if (!n) return true;
    if (margined && (n.x < margined.minX || n.x > margined.maxX
      || n.z < margined.minZ || n.z > margined.maxZ)) return true;
    if (goal && goalDist(n.x, n.z) < goal.standoffM) return true;
    return false;
  }
  // **道そのものが立入制限の範囲を通り抜ける辺**は通らない(2号車のみ)。
  // 端点だけを見ていたときは、両端が範囲の外でも道の途中がターゲットの
  // すぐ横(実データで最接近16m)を通っていた。1辺につき1回だけ測って覚えておく
  const edgeZoneCache = new Map();
  function blockedEdgeZone(e) {
    const hit = edgeZoneCache.get(e.key);
    if (hit !== undefined) return hit;
    const w = e.world;
    // 端点だけでなく途中の形状もDEM内に収める。初期配置にも同じ条件を使う。
    if (margined) {
      for (let k = 0; k < w.length; k += 2) {
        if (w[k] < margined.minX || w[k] > margined.maxX || w[k + 1] < margined.minZ || w[k + 1] > margined.maxZ) {
          edgeZoneCache.set(e.key, true);
          return true;
        }
      }
    }
    if (!goal) { edgeZoneCache.set(e.key, false); return false; }
    let min = Infinity;
    for (let k = 2; k < w.length; k += 2) {
      const ax = w[k - 2], az = w[k - 1], bx = w[k], bz = w[k + 1];
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      // 線分上でターゲットにいちばん近い点までの距離
      const t = len2 < 1e-9 ? 0
        : Math.max(0, Math.min(1, ((goal.x - ax) * dx + (goal.z - az) * dz) / len2));
      const d = Math.hypot(ax + dx * t - goal.x, az + dz * t - goal.z);
      if (d < min) min = d;
    }
    const blockedIt = min < goal.standoffM;
    edgeZoneCache.set(e.key, blockedIt);
    return blockedIt;
  }

  const routeOpts = { blocked: blockedNode, blockedEdge: blockedEdgeZone };

  let best = null, startForward = true;

  if (spawnAwayFrom) {
    // **2号車の置き方。**当初は「1号車の次に近い**別の辺**」にしようとしたが、
    // 実データ検証(既定5エリア×160通り)で **98/160 が間隔0m** だった。
    // 次に近い辺はたいてい同じ交差点に接している別の辺で、辺が違っても端点は同じ座標になる。
    // **「別の辺」は「別の場所」を意味しない。**
    // → 「1号車から minM 以上離れた最寄りの端点」に改めた(間隔 中央値77m / 20m未満 0件)
    //
    // **立入制限の範囲の中には置かない**(2026-08-28に画面で発覚)。
    // ターゲットのすぐ近くから離陸すると、いちばん近い端点が範囲の中に入ることがあり、
    // 地上クルーが立入禁止区域の中に湧いてしまう。しかも中から出る経路は遠回りになりやすく、
    // 渡良瀬では出るのに8.7km走っていた。置く時点で弾くのがいちばん簡単で確実
    let awayKey = null, awayD = Infinity;
    for (const [k, n] of nodes) {
      if (Math.hypot(n.x - spawnAwayFrom.x, n.z - spawnAwayFrom.z) < spawnAwayFrom.minM) continue;
      const d = (n.x - startX) ** 2 + (n.z - startZ) ** 2;
      if (d >= awayD) continue;
      if (blockedNode(k) || !drivableAt(k)) continue;
      awayD = d; awayKey = k;
    }
    if (awayKey) {
      best = drivableAt(awayKey);
      startForward = best.a === awayKey;
    }
    // 見つからなければ下の既定の置き方に落ちる(1号車と重なりうるが、車が消えるよりよい)
  }

  if (!best) {
    // 出発点に最も近い辺を選ぶ。頂点との距離で足りる(辺は数十m刻みなので)
    let bestD = Infinity;
    for (const e of drivable) {
      if (blockedNode(e.a) || blockedNode(e.b) || blockedEdgeZone(e)) continue;
      const w = e.world;
      for (let k = 0; k < w.length; k += 2) {
        const d = (w[k] - startX) ** 2 + (w[k + 1] - startZ) ** 2;
        if (d < bestD) { bestD = d; best = e; }
      }
    }
    // 辺のどちら側から走り始めるか。出発点(離陸地点)に近い端から始める
    if (!best) return null;
    const bw = best.world;
    startForward =
      (bw[0] - startX) ** 2 + (bw[1] - startZ) ** 2
      <= (bw[bw.length - 2] - startX) ** 2 + (bw[bw.length - 1] - startZ) ** 2;
  }

  const startKey = startForward ? best.a : best.b;
  const group = buildCarMesh(kind, bodyColor);

  // 走行状態。edge を a→b または b→a のどちらかの向きに進む
  const car = {
    edge: best,
    forward: startForward,
    seg: 0,        // 今いる区間の番号(world の頂点インデックス / 2)
    t: 0,          // 区間内の進捗 0〜1
    x: 0, z: 0,
    heading: 0,
    speed: 0,
    // 走れる道が見つからない状態。**永久停止ではない**(下の halted に一本化した)
    stuck: false,
    route: [],      // これから通る辺キーの並び(A* の結果)
    sinceFind: 1e9, // 前回経路を引いてからのゲーム内秒。初回は即引く
    waiting: false, // 気球の近くに着いたので待機中(1号車)
    // 以下は2号車(goal あり)専用。**行き先のノードは持たない**
    // (立入らない範囲があるので「どこまで寄れるか」は経路を引いてみないと決まらない)
    halted: false,  // 経路が尽きて止まっている。**行き止まり(stuck)ではない**
    arrived: false, // 目的地に着いた。ここから先は何もしない
    moved: false,   // 一度でも辺の上を進んだか
    findMs: 0, findCount: 0,
  };

  // 進行方向に沿った区間の端点を取り出す
  const segPoints = (e, forward, seg) => {
    const w = e.world;
    const n = w.length / 2 - 1;              // 区間数
    const i = forward ? seg : n - 1 - seg;
    const a = forward ? i : i + 1;
    const b = forward ? i + 1 : i;
    return [w[a * 2], w[a * 2 + 1], w[b * 2], w[b * 2 + 1]];
  };
  const segCount = (e) => e.world.length / 2 - 1;

  // 今の辺の終点ノード
  const endNodeKey = () => (car.forward ? car.edge.b : car.edge.a);

  // 目的地(気球の真下)にいちばん近いノードを探す。ノード数は数千なので総当たりで足りる
  function nearestNode(x, z) {
    let key = null, bd = Infinity;
    for (const [k, n] of nodes) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; key = k; }
    }
    return key;
  }

  // 経路を引き直す。**毎フレームではなく PATHFIND_INTERVAL 秒おき**
  function replan(fromNodeKey, targetX, targetZ) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let route;
    if (goal) {
      // 目的地のノードを先に1点へ決めない。**立入らない範囲があるので、
      // 「どこまで寄れるか」は経路を引いてみないと分からない。**
      // goalKey = null にすると、findRoute は「到達できた中でターゲットにいちばん
      // 近いノード」までの経路を返す(タイルが増えれば、より近いところへ引き直される)
      route = findRoute(nodes, edges, fromNodeKey, null, { ...routeOpts, goalPoint: goal });
    } else {
      const goalKey = nearestNode(targetX, targetZ);
      if (!goalKey) return;
      route = findRoute(nodes, edges, fromNodeKey, goalKey, routeOpts);
    }
    car.findMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    car.findCount++;
    car.sinceFind = 0;
    // 経路が引けなければ route は空のまま。交差点では下の角度による選択に落ちる
    car.route = route || [];
  }

  // 交差点で次の辺を選ぶ。経路があればそれに従い、無ければ気球の方向に最も近い辺を取る。
  // 角度だけの選択は細街路の格子で堂々巡りになるため、あくまで経路が引けないときの保険
  function chooseNext(nodeKey, targetX, targetZ) {
    const node = nodes.get(nodeKey);
    if (!node) return false;

    // 経路の先頭が、今いる交差点に接している辺なら、それを取る
    while (car.route.length > 0) {
      const ek = car.route[0];
      const e = edges.get(ek);
      if (!e || (e.a !== nodeKey && e.b !== nodeKey)) { car.route.shift(); continue; }
      car.route.shift();
      car.edge = e;
      car.forward = e.a === nodeKey;
      car.seg = 0;
      car.t = 0;
      return true;
    }

    // **2号車は角度による選択をしない。**目的地は決まっているので、経路が無いのに
    // 「それらしい方向」へ走らせると、根拠のない先回りになる。その場に止まって、
    // タイルが届いて経路が引き直されるのを待つ(到着していれば以後ずっと止まる)。
    //
    // 到着かどうかは「ターゲットの近くで止まったか」で分ける。立入らない範囲の
    // すぐ外まで寄れていれば到着、道が続かずに遠くで止まったなら到着ではない。
    // **この閾値は言い方(到着 / これ以上進めない)を選ぶためだけのもので、
    // 画面には出さない**(出すのは実測距離)。実データでは到着 100〜200m 台に対して
    // 届かない場合は 3〜8km と桁が違うので、間のどこで切っても結果は変わらない
    if (goal) {
      car.halted = true;
      const d = goalDist(car.x, car.z);
      car.arrived = d >= goal.standoffM && d < (goal.arriveBandM ?? goal.standoffM * 3);
      return false;
    }

    const want = bearing(targetX - node.x, targetZ - node.z);
    let pick = null, pickScore = Infinity, fallback = null, fallbackScore = Infinity;
    for (const ek of node.edgeKeys) {
      const e = edges.get(ek);
      if (!e || isMotorway(e.props)) continue;
      const forward = e.a === nodeKey;
      if (!forward && e.b !== nodeKey) continue;
      // 角度で選ぶときも、地形の外へは出さない(経路探索と同じ一方通行の壁)
      const escaping = blockedNode(nodeKey);
      if (blockedNode(forward ? e.b : e.a) && !escaping) continue;
      if (blockedEdgeZone(e) && !escaping) continue;
      // その辺に入った直後の進行方向
      const w = e.world;
      const [x0, z0] = forward ? [w[0], w[1]] : [w[w.length - 2], w[w.length - 1]];
      const [x1, z1] = forward ? [w[2], w[3]] : [w[w.length - 4], w[w.length - 3]];
      const score = Math.abs(wrapPi(bearing(x1 - x0, z1 - z0) - want));

      // 来た道は「他に選択肢が無いとき」だけ使う(行き止まりでのUターン)
      if (ek === car.edge.key) {
        if (score < fallbackScore) { fallbackScore = score; fallback = { e, forward }; }
        continue;
      }
      if (score < pickScore) { pickScore = score; pick = { e, forward }; }
    }

    const next = pick || fallback;
    if (!next) return false;
    car.edge = next.e;
    car.forward = next.forward;
    car.seg = 0;
    car.t = 0;
    return true;
  }

  // 車体を今の走行状態の位置へ置く。
  // **待機中も含めて必ず呼ぶこと。**呼ばないと group が原点(y=0)のまま地面に埋まる
  function place() {
    group.position.set(car.x, getHeight(car.x, car.z) + CAR_LIFT, car.z);
    // **-heading であること。**この世界の進行方向は (sinθ, -cosθ) で、three.js の
    // Y回転で局所 -Z がそこを向くのは -θ のとき。+θ だと**真後ろ**を向く
    // (東へ走る例: θ=π/2、-θ なら局所-Zは東、+θ なら西)。
    // 車体が前後ほぼ対称の箱だった間は見えなかった。形を分けたことで顕在化(2026-08-28)
    group.rotation.y = -car.heading;
  }

  // 初期位置を辺の先頭に置く
  const p0 = segPoints(car.edge, car.forward, 0);
  car.x = p0[0]; car.z = p0[1];
  car.heading = bearing(p0[2] - p0[0], p0[3] - p0[1]);
  place();

  /**
   * @param {number} dt      経過秒(ゲーム内時間。時間加速が掛かっていてよい)
   * @param {number} targetX 追う相手(気球)の位置。**2号車では無視される**(目的地は goal)
   * @param {number} targetZ
   */
  function update(dt, targetX, targetZ) {
    if (!dt || car.stuck) return;
    // 2号車は到着したらそこで終わり。経路探索も辺上の移動計算も止める(1号車より軽い)
    if (car.arrived) { car.speed = 0; place(); return; }
    if (goal) { targetX = goal.x; targetZ = goal.z; }

    // 経路の引き直し。交差点に着いたときではなく、時間で区切る
    car.sinceFind += dt;
    if (car.sinceFind >= PATHFIND_INTERVAL) replan(endNodeKey(), targetX, targetZ);

    if (goal) {
      // 置かれた場所がそのまま行き先だった(離陸地点がターゲットのすぐそば)。
      // 辺を1本走り切ってから止まるのを待たずに、その場で待機に入る
      if (!car.moved && car.route.length === 0) {
        const d = goalDist(car.x, car.z);
        if (d >= goal.standoffM && d < (goal.arriveBandM ?? goal.standoffM * 3)) {
          car.halted = true; car.arrived = true; car.speed = 0; place(); return;
        }
      }
    } else {
      // 気球の真下まで来ていたら、その場で待つ。無意味に走り回らせない
      car.waiting =
        Math.hypot(targetX - car.x, targetZ - car.z) < ARRIVE_M && car.route.length === 0;
      if (car.waiting) { car.speed = 0; place(); return; }
    }

    // 止まっている(行き先が無かった)。**2台に共通の扱い。**
    // 行き先が現れたら再開する: 2号車はタイルが届いて経路が引けたとき、
    // 1号車は気球が地形の中へ戻ってきたとき
    if (car.halted) {
      if (!chooseNext(endNodeKey(), targetX, targetZ)) { car.speed = 0; place(); return; }
      car.halted = false;
    }

    car.speed = speedMps(car.edge.props);
    car.moved = true;

    let remain = car.speed * dt;
    let guard = 0;
    while (remain > 0 && guard++ < 64) {   // 時間加速でも1フレームで暴走しないよう上限を置く
      const [ax, az, bx, bz] = segPoints(car.edge, car.forward, car.seg);
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 1e-6) {                 // 長さ0の区間は飛ばす
        if (!advanceSeg(targetX, targetZ)) { place(); return; }
        continue;
      }
      const left = (1 - car.t) * segLen;
      if (remain < left) {
        car.t += remain / segLen;
        remain = 0;
      } else {
        remain -= left;
        if (!advanceSeg(targetX, targetZ)) { place(); return; }
        continue;
      }
      const [nx, nz, mx, mz] = segPoints(car.edge, car.forward, car.seg);
      car.x = nx + (mx - nx) * car.t;
      car.z = nz + (mz - nz) * car.t;
      const want = bearing(mx - nx, mz - nz);
      car.heading = wrapPi(car.heading + wrapPi(want - car.heading) * Math.min(1, dt * TURN_RATE));
    }

    place();
  }

  // 次の区間へ。辺の端まで来ていたら交差点で次の辺を選ぶ
  function advanceSeg(targetX, targetZ) {
    car.seg++;
    car.t = 0;
    if (car.seg < segCount(car.edge)) return true;
    if (!chooseNext(endNodeKey(), targetX, targetZ)) {
      // **止まるだけで、二度と動かない状態にはしない。**
      // 地形の外へ出さない制限を入れたら、境界まで来た1号車が `stuck` で
      // 永久停止した(実データで3件)。境界は行き止まりではなく「今は行き先が無い」
      // だけで、気球が戻ってくれば再開できる。2号車も同じ(タイルが届けば再開する)
      car.halted = true;
      car.speed = 0;
      return false;
    }
    return true;
  }

  // 現在の状態(第3段階の報告や UI 表示で使う)
  function info() {
    return {
      x: car.x, z: car.z,
      y: group.position.y,   // 車の床の高さ。視点の目の位置もこれを基準にする
      headingDeg: ((car.heading * 180) / Math.PI + 360) % 360,
      speedKmh: Math.round((car.speed * 3600) / 1000),
      rnkWidth: car.edge.props.rnkWidth,
      rdCtg: car.edge.props.rdCtg,
      stuck: car.stuck,
      waiting: car.waiting,
      // 2号車(goal あり)専用。goalDistM は**実測距離**で、目安の 100m ではない
      hasGoal: !!goal,
      arrived: car.arrived,
      halted: car.halted,
      goalDistM: goal ? Math.hypot(goal.x - car.x, goal.z - car.z) : null,
      routeLeft: car.route.length,
      findMs: car.findMs,
      findCount: car.findCount,
    };
  }

  // 上空から探すための目印の柱を出し入れする。車のすぐそばで見るときは、
  // 画面を貫く柱になってしまうので消す
  function setMarkVisible(v) { group.userData.mark.visible = v; }

  return { group, update, info, setMarkVisible, drivableEdges: drivable.length };
}
