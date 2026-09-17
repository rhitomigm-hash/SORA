// チェイスカー(地上クルー)の第1段階: 地理院ベクトルタイルの道路を読み込み、
// prototype/terrain.js と同じローカル座標系(x:東+, y:標高, z:南+, 単位m)に載せて描画する。
//
// **この段階では表示のみ。**車はまだ走らせない。当たり判定・風・高度計算には一切関与しない。
//
// 実データで確認した前提(2026-08-27, experiments/chasecar/):
//   - 配信は https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf
//     認証不要・CORS `*`・z4〜z16。形式は MVT(protobuf)
//   - **全域 z14 の単一ズームで足りる**。z16 との総延長差(佐賀で 56.89km vs 170.34km)の
//     正体は細い道ではなく、`rdCtg`・`rnkWidth` を持たない `ftCode` 2201 等
//     = 道路の縁(中心線までの距離が中央値 2.4m)。走行グラフに混ぜてはいけない線で、
//     z14 はそれが除かれた「中心線のみ」の状態で来る
//   - 走行に使う中心線は `rnkWidth` の全区分が z14 で 100% 揃っている(佐賀・上士幌で確認)。
//     幅員3m未満の細い道も落ちていない
//   - z14 で失われるのは頂点密度だけ(頂点間隔 41.5m → 55.8m)。総延長は完全一致で、
//     間引かれたのは直線上の冗長点
//   - **交差点で線分は分割されている**。「端点が他線の中間点と重なる数」は
//     佐賀z16・上士幌z16・佐賀z14 の3ケースとも0件。端点突き合わせだけでグラフが組める
//   - タイル境界に乗る端点は0で、代わりに各タイルは境界の外へ頂点をはみ出させている
//     (バッファ)。**その重複域の頂点は隣接タイルと完全一致する(丸め誤差ゼロ)**。
//     `tileX * extent + px` のグローバル整数座標で統合すれば継ぎ目が縫える
//   - 道路データは2D。高さは terrain.js の getHeight で地形に貼る
import * as THREE from 'three';
import { lonLatToTile } from './terrain.js';

const BVMAP = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap';
const ROAD_Z = 14;               // 単一ズーム。ここを変えるとグローバル整数統合の前提が崩れる
const EARTH_CIRC = 40075016.686;
const DRAPE_STEP = 25;           // 地形に貼るときの分割間隔(m)。z14 の頂点間隔より細かくする
// 地面から浮かせる量(m)。地形との z-fighting を避ける。
// **チェイスカーはこの高さを路面として走る**(下げると z-fighting が戻り、
// 合わせないと道路の線が車体を突き抜ける)。chasecar.js が読む
export const DRAPE_LIFT = 1.5;

// 幅員区分(rnkWidth)ごとの色。コード値は地理院の仕様に従う:
//   0:3m未満 / 1:3〜5.5m / 2:5.5〜13m / 3:13〜19.5m / 4:19.5m以上 / 5:その他 / 6:不明
// 5・6 は幅が分からないので、太さを主張しない中間色にする
const WIDTH_COLORS = [0x6b7a8f, 0x93a7bd, 0xd6c88c, 0xe8a25a, 0xf0b070, 0x8a8a8a, 0x8a8a8a];
const UNKNOWN_WIDTH_COLOR = 0x8a8a8a;
const MOTORWAY_COLOR = 0xd0705c; // 高速道路。チェイスカーは通れないので色で区別する

// 高速道路かどうか。motorWay は 0:高速道路以外 / 1:高速道路 / 9:不明 で、
// 実データでは 9(不明)が大半を占める。9 を「高速道路」と扱ってはいけない。
// rdCtg の 3(高速自動車国道等)と tollSect の 1(有料)も併せて見る
export const isMotorway = (p) => p.motorway === 1 || p.rdCtg === 3 || p.tollSect === 1;

// --- MVT(protobuf)の最小デコーダ -----------------------------------------
// ビルド工程なしを維持するため、必要な部分だけ自前で読む。
// 使うのは Tile{layers=3} / Layer{name=1,features=2,keys=3,values=4,extent=5} /
// Feature{tags=2,type=3,geometry=4} だけ。

class PbfReader {
  constructor(bytes, end = bytes.length) { this.b = bytes; this.p = 0; this.end = end; }
  varint() {
    let r = 0, s = 0, b;
    do { b = this.b[this.p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
    return r;
  }
  skip(wire) {
    // 複合代入だと this.p が varint 前の値で読まれるので、長さを先に取り出す
    if (wire === 0) this.varint();
    else if (wire === 2) { const n = this.varint(); this.p += n; }
    else if (wire === 5) this.p += 4;
    else if (wire === 1) this.p += 8;
    else throw new Error(`未知の wire type: ${wire}`);
  }
  sub() {
    const len = this.varint();
    const r = new PbfReader(this.b, this.p + len);
    r.p = this.p;
    this.p += len;
    return r;
  }
  str() {
    const len = this.varint();
    const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + len));
    this.p += len;
    return s;
  }
}

const unzig = (v) => (v >> 1) ^ (-(v & 1));

// MVT のジオメトリコマンド列 → 線分の配列(タイル内整数座標のまま)
function decodeGeometry(gr) {
  const lines = [];
  let cur = null, x = 0, y = 0;
  while (gr.p < gr.end) {
    const cmd = gr.varint();
    const id = cmd & 7, count = cmd >> 3;
    for (let i = 0; i < count; i++) {
      if (id === 1) {          // MoveTo = 新しい線の始まり
        x += unzig(gr.varint()); y += unzig(gr.varint());
        cur = [x, y];
        lines.push(cur);
      } else if (id === 2) {   // LineTo
        x += unzig(gr.varint()); y += unzig(gr.varint());
        cur.push(x, y);
      } else break;            // ClosePath は道路には現れない
    }
  }
  return lines;
}

function decodeValue(vr) {
  while (vr.p < vr.end) {
    const t = vr.varint(), f = t >> 3, w = t & 7;
    if (f === 1 && w === 2) return vr.str();
    if ((f === 4 || f === 5) && w === 0) return vr.varint();
    if (f === 6 && w === 0) return unzig(vr.varint());
    if (f === 7 && w === 0) return vr.varint() !== 0;
    vr.skip(w);
  }
  return null;
}

function decodeFeature(fr) {
  const feat = { type: 0, lines: [], tags: [] };
  while (fr.p < fr.end) {
    const t = fr.varint(), f = t >> 3, w = t & 7;
    if (f === 3) feat.type = fr.varint();
    else if (f === 4) feat.lines = decodeGeometry(fr.sub());
    else if (f === 2 && w === 2) { const tr = fr.sub(); while (tr.p < tr.end) feat.tags.push(tr.varint()); }
    else fr.skip(w);
  }
  return feat;
}

// pbf 全体から road レイヤだけを取り出す(他のレイヤは読み飛ばす)
function decodeRoadLayer(bytes) {
  const r = new PbfReader(bytes);
  while (r.p < r.end) {
    const tag = r.varint();
    if (tag >> 3 !== 3) { r.skip(tag & 7); continue; }
    const lr = r.sub();
    const layer = { name: '', extent: 4096, features: [], keys: [], values: [] };
    while (lr.p < lr.end) {
      const lt = lr.varint(), f = lt >> 3;
      if (f === 1) layer.name = lr.str();
      else if (f === 5) layer.extent = lr.varint();
      else if (f === 2) layer.features.push(decodeFeature(lr.sub()));
      else if (f === 3) layer.keys.push(lr.str());
      else if (f === 4) layer.values.push(decodeValue(lr.sub()));
      else lr.skip(lt & 7);
    }
    if (layer.name !== 'road') continue;
    for (const ft of layer.features) {
      ft.props = {};
      for (let i = 0; i + 1 < ft.tags.length; i += 2) ft.props[layer.keys[ft.tags[i]]] = layer.values[ft.tags[i + 1]];
    }
    return layer;
  }
  return null;
}

// --- 接続グラフ ------------------------------------------------------------

// 素集合(連結成分の確認用)
function makeUnionFind() {
  const parent = new Map();
  const find = (k) => {
    if (!parent.has(k)) { parent.set(k, k); return k; }
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(k) !== root) { const next = parent.get(k); parent.set(k, root); k = next; }
    return root;
  };
  return {
    find,
    union: (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); },
  };
}

// --- 読み込み本体 ----------------------------------------------------------

/**
 * 地理院ベクトルタイルの道路(中心線)を読み込み、地形に貼った線として返す。
 *
 * **全域を先に読まない。**気球は30分で10km近く流れるので、最初に読んだ範囲だけでは
 * チェイスカーがすぐデータの端にぶつかる(第2段階の検証で実際にそうなった)。
 * `ensureAround(x, z)` で、車と気球の周囲のタイルを走行中に足していく。
 * 継ぎ目はグローバル整数座標の一致だけで縫えるので、後から足しても同じグラフに繋がる。
 *
 * @param {object} opts
 * @param {number} opts.centerLon 基準点の経度(terrain と同じ値を渡すこと)
 * @param {number} opts.centerLat 基準点の緯度
 * @param {(x:number,z:number)=>number} opts.getHeight terrain.js の getHeight
 * @param {number} [opts.radiusM=3000]     最初に読む範囲(m)
 * @param {number} [opts.streamRadiusM=2500] 走行中に先読みする範囲(m)
 * @param {number} [opts.maxTilesTotal=48] 読み込むタイル数の総上限(負荷の保険)。
 *   z14 は1枚 約2.05km四方。実測で1枚あたり 佐賀 約95KB / 上士幌 約22KB
 * @param {(done:number,total:number,msg:string)=>void} [opts.onProgress]
 * @returns {Promise<{group:THREE.Group, graph:object, stats:object,
 *   ensureAround:Function, pendingAround:Function}>}
 */
export async function loadRoads({
  centerLon, centerLat, getHeight,
  radiusM = 3000, streamRadiusM = 2500, maxTilesTotal = 48, onProgress,
  initialX = 0, initialZ = 0,
}) {
  const stats = {
    tilesLoaded: 0, tilesFailed: 0, bytes: 0,
    centerlines: 0, skippedEdgeLines: 0,
    nodes: 0, edges: 0, lengthM: 0,
    motorwayEdges: 0, motorwayUnknown: 0, narrowEdges: 0, unknownWidthEdges: 0,
    deg1: 0, deg2: 0, deg3: 0, deg4plus: 0,
    largestComponentRatio: 0, components: 0, batches: 0, ms: 0, capped: false,
  };
  const t0 = performance.now();
  const report = (done, total, msg) => onProgress && onProgress(done, total, msg);

  const latRad = (centerLat * Math.PI) / 180;
  const tileMeters = (EARTH_CIRC / 2 ** ROAD_Z) * Math.cos(latRad);
  const c = lonLatToTile(centerLon, centerLat, ROAD_Z);

  // タイル内整数座標 → グローバル整数座標("gx_gy")。継ぎ目はこのキーの一致だけで縫える
  const nodes = new Map();   // key -> {x, z, deg, edgeKeys}
  const edges = new Map();   // "keyA|keyB" -> {key, a, b, world, lengthM, props}
  const uf = makeUnionFind();
  const loadedTiles = new Set();

  const group = new THREE.Group();
  group.name = 'chasecar-roads';

  // --- タイル1枚をグラフに取り込む。戻り値は新しく増えた辺 ---
  async function addTile(tx, ty) {
    const id = `${tx}_${ty}`;
    if (loadedTiles.has(id)) return [];
    loadedTiles.add(id);   // 失敗しても再試行しない(海上など道路が無い範囲がある)

    let layer = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${BVMAP}/${ROAD_Z}/${tx}/${ty}.pbf`, { signal: controller.signal });
      if (!res.ok) { stats.tilesFailed++; return []; } // 未取得と「道がない」を混同しない
      const buf = await res.arrayBuffer();
      stats.bytes += buf.byteLength;
      layer = decodeRoadLayer(new Uint8Array(buf));
      stats.tilesLoaded++;
    } catch (err) {
      stats.tilesFailed++;
      console.warn('道路タイルの読み込みに失敗:', tx, ty, err);
      return [];
    } finally {
      clearTimeout(timeout);
    }
    if (!layer) return [];

    const ext = layer.extent;
    const added = [];
    for (const f of layer.features) {
      if (f.type !== 2) continue;                     // LineString のみ
      // rnkWidth を持たないものは道路の縁(ftCode 2201 等)。走行グラフに入れてはいけない。
      // z14 では本来出てこないが、ズームを変えたときの保険として明示的に弾く
      if (f.props.rnkWidth === undefined) { stats.skippedEdgeLines++; continue; }
      stats.centerlines++;

      for (const flat of f.lines) {
        if (flat.length < 4) continue;
        // グローバル整数座標に直す。バッファのはみ出しも捨てずにそのまま統合する
        const pts = new Array(flat.length);
        for (let k = 0; k < flat.length; k += 2) {
          pts[k] = tx * ext + flat[k];
          pts[k + 1] = ty * ext + flat[k + 1];
        }
        const a = `${pts[0]}_${pts[1]}`;
        const b = `${pts[pts.length - 2]}_${pts[pts.length - 1]}`;
        if (a === b) continue;
        const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (edges.has(ek)) continue;                  // 隣接タイルとの重複を二重に持たない

        // 世界座標(m)に直しておく。描画と車の走行の両方がこれを使う
        const world = new Float64Array(pts.length);
        for (let k = 0; k < pts.length; k += 2) {
          world[k] = (pts[k] / ext - c.x) * tileMeters;
          world[k + 1] = (pts[k + 1] / ext - c.y) * tileMeters;
        }
        // 辺の長さ(m)。経路探索のコストに使うので、ここで一度だけ出しておく
        let edgeLen = 0;
        for (let k = 2; k < world.length; k += 2) {
          edgeLen += Math.hypot(world[k] - world[k - 2], world[k + 1] - world[k - 1]);
        }
        const edge = { key: ek, a, b, world, lengthM: edgeLen, props: f.props };
        edges.set(ek, edge);
        added.push(edge);

        for (const [key, ix] of [[a, 0], [b, world.length - 2]]) {
          if (!nodes.has(key)) nodes.set(key, { x: world[ix], z: world[ix + 1], deg: 0, edgeKeys: [] });
          const n = nodes.get(key);
          n.deg++;
          n.edgeKeys.push(ek);   // 交差点で次の道を選ぶための隣接情報
        }
        uf.union(a, b);
      }
    }
    return added;
  }

  // --- 増えた辺を1つの LineSegments にまとめて描く ---
  // タイルを足すたびに全体を作り直すと重いので、追加ぶんだけ別バッチにする。
  // ドローコールはバッチ数(飛行中でも数十)で、依然として十分軽い
  function drawBatch(added) {
    if (added.length === 0) return;
    const positions = [];
    const colors = [];
    const col = new THREE.Color();
    const push = (x1, z1, x2, z2) => {
      positions.push(x1, getHeight(x1, z1) + DRAPE_LIFT, z1);
      positions.push(x2, getHeight(x2, z2) + DRAPE_LIFT, z2);
      colors.push(col.r, col.g, col.b, col.r, col.g, col.b);
    };

    for (const e of added) {
      const w = e.props.rnkWidth;
      col.setHex(isMotorway(e.props) ? MOTORWAY_COLOR : (WIDTH_COLORS[w] ?? UNKNOWN_WIDTH_COLOR));
      const w2 = e.world;
      for (let k = 2; k < w2.length; k += 2) {
        const x1 = w2[k - 2], z1 = w2[k - 1];
        const x2 = w2[k], z2 = w2[k + 1];
        const len = Math.hypot(x2 - x1, z2 - z1);
        stats.lengthM += len;
        // 地形の起伏に沿わせるため、長い区間は分割して標高を拾い直す
        const n = Math.max(1, Math.ceil(len / DRAPE_STEP));
        for (let s = 0; s < n; s++) {
          const t1 = s / n, t2 = (s + 1) / n;
          push(x1 + (x2 - x1) * t1, z1 + (z2 - z1) * t1, x1 + (x2 - x1) * t2, z1 + (z2 - z1) * t2);
        }
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
    lines.name = `gsi-roads-${stats.batches}`;
    lines.frustumCulled = false;
    group.add(lines);
    stats.batches++;
  }

  // 連結成分などの統計。O(ノード数)なのでタイル追加のたびにだけ数え直す
  function recountStats() {
    const compSize = new Map();
    for (const key of nodes.keys()) {
      const root = uf.find(key);
      compSize.set(root, (compSize.get(root) || 0) + 1);
    }
    stats.components = compSize.size;
    stats.largestComponentRatio = nodes.size > 0 ? Math.max(0, ...compSize.values()) / nodes.size : 0;

    stats.deg1 = stats.deg2 = stats.deg3 = stats.deg4plus = 0;
    for (const n of nodes.values()) {
      if (n.deg === 1) stats.deg1++;
      else if (n.deg === 2) stats.deg2++;
      else if (n.deg === 3) stats.deg3++;
      else stats.deg4plus++;
    }
    stats.nodes = nodes.size;
    stats.edges = edges.size;

    // 走行可否に関わる内訳。motorWay=9(不明)がどれだけあるかを把握しておく
    stats.motorwayEdges = stats.motorwayUnknown = stats.narrowEdges = stats.unknownWidthEdges = 0;
    for (const e of edges.values()) {
      if (isMotorway(e.props)) stats.motorwayEdges++;
      if (e.props.motorway === 9) stats.motorwayUnknown++;
      if (e.props.rnkWidth === 0) stats.narrowEdges++;      // 3m未満
      if (e.props.rnkWidth >= 5) stats.unknownWidthEdges++; // 5:その他 / 6:不明
    }
  }

  // 世界座標(m)の点のまわりで、まだ読んでいないタイルを近い順に並べる
  function wantTiles(x, z, r) {
    const fx = c.x + x / tileMeters;
    const fy = c.y + z / tileMeters;
    const span = Math.ceil(r / tileMeters);
    const want = [];
    for (let ty = Math.floor(fy) - span; ty <= Math.floor(fy) + span; ty++) {
      for (let tx = Math.floor(fx) - span; tx <= Math.floor(fx) + span; tx++) {
        if (loadedTiles.has(`${tx}_${ty}`)) continue;
        const dist = Math.hypot((tx + 0.5 - fx) * tileMeters, (ty + 0.5 - fy) * tileMeters);
        if (dist <= r) want.push({ tx, ty, dist });
      }
    }
    want.sort((a, b) => a.dist - b.dist);
    return want;
  }

  /**
   * その点のまわりに、**まだ読んでいないタイルが何枚残っているか**。
   * 第3段階の報告で使う。「ここまでしか道が続いていません」と言ってよいのは、
   * 足すものが無くなってから(0枚)だけ。出発直後に短い経路しか引けないのは
   * 道が無いからではなく**まだ読んでいないから**で、そこで「行けません」と言うと、
   * 第2段階で車がデータの端を道の端と取り違えたのと同じ間違いを言葉でやることになる
   */
  function pendingAround(x, z, r = streamRadiusM) {
    return wantTiles(x, z, r).length;
  }

  // 世界座標(m)の点のまわりで、まだ読んでいないタイルを読む。
  // 走行中に呼ばれるので、二重に走らないようにする
  let busy = false;
  async function ensureAround(x, z, r = streamRadiusM, progress) {
    if (busy) return 0;
    const want = wantTiles(x, z, r);
    if (want.length === 0) return 0;

    busy = true;
    let loaded = 0;
    try {
      for (let i = 0; i < want.length; i++) {
        if (loadedTiles.size >= maxTilesTotal) { stats.capped = true; break; }
        if (progress) progress(i, want.length, `道路タイル ${i + 1}/${want.length}`);
        const added = await addTile(want[i].tx, want[i].ty);
        drawBatch(added);
        loaded++;
      }
      if (loaded > 0) recountStats();
    } finally {
      busy = false;
    }
    return loaded;
  }

  await ensureAround(initialX, initialZ, radiusM, report);
  stats.ms = Math.round(performance.now() - t0);
  return { group, graph: { nodes, edges }, stats, ensureAround, pendingAround };
}
