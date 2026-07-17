// 地理院タイルから地形を生成する
//   標高: dem_png (DEM10B) z13 … 標高 = (R*65536 + G*256 + B) * 0.01m
//   質感: seamlessphoto(全国最新写真) z14 を 2x2 枚合成して各タイルに貼る
import * as THREE from 'three';

const DEM_Z = 13;
const PHOTO_Z = 14;
const TILE_PX = 256;
const SEG = 128;                    // 1タイルあたりのメッシュ分割数
const EARTH_CIRC = 40075016.686;    // 赤道周長(m)

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return { x, y };
}

async function fetchBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tile fetch failed: ${res.status} ${url}`);
  return createImageBitmap(await res.blob());
}

function decodeDem(bitmap) {
  const cv = document.createElement('canvas');
  cv.width = TILE_PX;
  cv.height = TILE_PX;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
  const h = new Float32Array(TILE_PX * TILE_PX);
  for (let i = 0; i < h.length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    let e = r * 65536 + g * 256 + b;
    if (e === 8388608) { h[i] = 0; continue; }   // 無効値(海など)
    if (e > 8388608) e -= 16777216;
    h[i] = e * 0.01;
  }
  return h;
}

// centerLon/Lat を原点に、(2*radius+1)^2 枚の DEM タイルで地形グループを作る。
// 戻り値: { group, getHeight(x,z), tileMeters, sizeMeters }
export async function buildTerrain(centerLon, centerLat, radius, onProgress) {
  const c = lonLatToTile(centerLon, centerLat, DEM_Z);
  const latRad = (centerLat * Math.PI) / 180;
  // メルカトルの緯度伸長を打ち消して「実距離のメートル」で組む
  const tileMeters = (EARTH_CIRC / 2 ** DEM_Z) * Math.cos(latRad);

  const cx = Math.floor(c.x);
  const cy = Math.floor(c.y);
  const demTiles = new Map(); // "tx_ty" -> Float32Array

  const coords = [];
  for (let ty = cy - radius; ty <= cy + radius; ty++)
    for (let tx = cx - radius; tx <= cx + radius; tx++) coords.push([tx, ty]);

  let done = 0;
  const total = coords.length * 2; // DEM + テクスチャ
  const tick = () => { done++; if (onProgress) onProgress(done, total); };

  // --- DEM 読み込み(全タイル揃えてから頂点を張ると継ぎ目が出ない) ---
  await Promise.all(coords.map(async ([tx, ty]) => {
    try {
      const bmp = await fetchBitmap(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${DEM_Z}/${tx}/${ty}.png`);
      demTiles.set(`${tx}_${ty}`, decodeDem(bmp));
    } catch {
      // 海上などタイルが存在しない場所は標高0の平面にする
      demTiles.set(`${tx}_${ty}`, new Float32Array(TILE_PX * TILE_PX));
    }
    tick();
  }));

  // グローバルピクセル座標(タイル座標*256)で標高をバイリニア補間
  function samplePixel(gx, gy) {
    const tx = Math.floor(gx / TILE_PX);
    const ty = Math.floor(gy / TILE_PX);
    const t = demTiles.get(`${tx}_${ty}`);
    if (!t) return 0;
    return t[(gy - ty * TILE_PX) * TILE_PX + (gx - tx * TILE_PX)];
  }
  function heightAtTileCoord(fx, fy) {
    const sx = fx * TILE_PX - 0.5;
    const sy = fy * TILE_PX - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const ax = sx - x0, ay = sy - y0;
    const h00 = samplePixel(x0, y0), h10 = samplePixel(x0 + 1, y0);
    const h01 = samplePixel(x0, y0 + 1), h11 = samplePixel(x0 + 1, y0 + 1);
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
  }

  // 世界座標(m) → 標高(m)。x: 東+, z: 南+
  function getHeight(x, z) {
    return heightAtTileCoord(c.x + x / tileMeters, c.y + z / tileMeters);
  }

  // --- メッシュ生成 ---
  const group = new THREE.Group();
  const tileEntries = []; // 高解像度化(LOD)管理用
  for (const [tx, ty] of coords) {
    const x0 = (tx - c.x) * tileMeters; // タイル北西角の世界座標
    const z0 = (ty - c.y) * tileMeters;

    const verts = new Float32Array((SEG + 1) * (SEG + 1) * 3);
    const uvs = new Float32Array((SEG + 1) * (SEG + 1) * 2);
    let vi = 0, ui = 0;
    for (let j = 0; j <= SEG; j++) {
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG, v = j / SEG;
        verts[vi++] = x0 + u * tileMeters;
        verts[vi++] = heightAtTileCoord(tx + u, ty + v);
        verts[vi++] = z0 + v * tileMeters;
        uvs[ui++] = u;
        uvs[ui++] = 1 - v;
      }
    }
    const idx = new Uint32Array(SEG * SEG * 6);
    let k = 0;
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * (SEG + 1) + i;
        const b = a + 1;
        const d = a + (SEG + 1);
        const e = d + 1;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
        idx[k++] = b; idx[k++] = d; idx[k++] = e;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({ color: 0x8a9a8a });
    group.add(new THREE.Mesh(geo, mat));

    const entry = {
      tx, ty, mat,
      cx: x0 + tileMeters / 2, cz: z0 + tileMeters / 2,
      level: 0, hiApplied: false,
    };
    tileEntries.push(entry);

    // テクスチャは後追いで貼る(z14 写真タイル 2x2 → 512px キャンバス)。
    // 先に高解像度版が適用済みなら低解像度で上書きしない
    loadPhotoTexture(tx, ty).then((tex) => {
      if (!entry.hiApplied) {
        mat.map = tex;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
      }
      tick();
    }).catch(() => tick());
  }

  // --- 低高度向け高解像度テクスチャ(z16 ≒ 2m/px)への段階アップグレード ---
  const HIRES_Z = 16;
  const HIRES_RADIUS = 3000; // この距離内のタイルを対象(m)
  const HIRES_MAX = 12;      // メモリ保護のための上限枚数
  let hiCount = 0;
  let upgradingCount = 0;

  // 写真タイルを合成して1枚のテクスチャを作る(z16→2048px / z17→4096px)
  async function buildPhotoTex(entry, z) {
    const f = 2 ** (z - DEM_Z);
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = f * TILE_PX;
    const cctx = cvs.getContext('2d');
    await Promise.all(Array.from({ length: f * f }, (_, k) => {
      const dx = k % f, dy = Math.floor(k / f);
      return fetchBitmap(
        `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${entry.tx * f + dx}/${entry.ty * f + dy}.jpg`)
        .then((bmp) => cctx.drawImage(bmp, dx * TILE_PX, dy * TILE_PX))
        .catch(() => {});
    }));
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  async function upgradeTile(entry) {
    const tex = await buildPhotoTex(entry, HIRES_Z);
    const old = entry.mat.map;
    entry.hiApplied = true;
    entry.mat.map = tex;
    entry.mat.color.set(0xffffff);
    entry.mat.needsUpdate = true;
    if (old) old.dispose();
  }

  function startUpgrade(entry, force) {
    if (!entry || entry.level || (!force && hiCount >= HIRES_MAX)) return;
    entry.level = 1;
    hiCount++;
    upgradingCount++;
    upgradeTile(entry).finally(() => { upgradingCount--; });
  }

  // 毎秒程度呼ばれ、指定位置に最も近い未処理タイルを1枚ずつ上げていく
  function updateDetail(x, z) {
    if (upgradingCount > 0) return;
    let best = null, bestD = Infinity;
    for (const t of tileEntries) {
      if (t.level) continue;
      const d = Math.hypot(t.cx - x, t.cz - z);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best && bestD < HIRES_RADIUS) startUpgrade(best);
  }

  // 指定地点を含むタイルを即時アップグレード(離陸地点・ターゲット用)
  function requestDetail(x, z) {
    const h = tileMeters / 2;
    startUpgrade(tileEntries.find(
      (t) => Math.abs(x - t.cx) <= h && Math.abs(t.cz - z) <= h));
  }

  // --- 最寄り1タイルだけ z17(≒1m/px)に引き上げる ---
  // 気球直下のタイルをz17化し、直前のz17タイルはz16に戻す(メモリはz17一枚分のみ)
  const ULTRA_Z = 17;
  let ultraEntry = null;
  let ultraLoading = false;

  async function requestUltra(x, z) {
    const dbg = document.documentElement.dataset; // デバッグ確認用(あとで消す)
    if (ultraLoading) { dbg.ultraState = 'loading'; return; }
    const h = tileMeters / 2;
    const entry = tileEntries.find(
      (t) => Math.abs(x - t.cx) <= h && Math.abs(t.cz - z) <= h);
    if (!entry) { dbg.ultraState = 'no-entry'; return; }
    if (entry === ultraEntry) { dbg.ultraState = 'already'; return; }
    if (!entry.hiApplied) { dbg.ultraState = 'wait-z16'; startUpgrade(entry, true); return; } // 先にz16を確保
    dbg.ultraState = 'building';
    ultraLoading = true;
    try {
      const tex = await buildPhotoTex(entry, ULTRA_Z);
      if (ultraEntry) { // 前のz17タイルをz16に戻す
        ultraEntry.mat.map = ultraEntry.baseTex;
        ultraEntry.mat.needsUpdate = true;
        ultraEntry.ultraTex.dispose();
        ultraEntry.ultraTex = null;
        ultraEntry.baseTex = null;
      }
      entry.baseTex = entry.mat.map; // z16を保持しておく
      entry.ultraTex = tex;
      entry.mat.map = tex;
      entry.mat.needsUpdate = true;
      ultraEntry = entry;
      document.documentElement.dataset.ultraTile = `${entry.tx}/${entry.ty}`; // デバッグ確認用
    } finally {
      ultraLoading = false;
    }
  }

  const n = radius * 2 + 1;
  return {
    group, getHeight, tileMeters, updateDetail, requestDetail, requestUltra,
    sizeMeters: tileMeters * n,
    // 2D地図(ブリーフィング)用: タイル範囲と世界座標での北西角
    map: {
      z: DEM_Z, x0: cx - radius, y0: cy - radius, n,
      minX: (cx - radius - c.x) * tileMeters,
      minZ: (cy - radius - c.y) * tileMeters,
    },
  };
}

async function loadPhotoTexture(tx, ty) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 512;
  const ctx = cv.getContext('2d');
  await Promise.all([0, 1].flatMap((dy) => [0, 1].map(async (dx) => {
    const bmp = await fetchBitmap(
      `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${PHOTO_Z}/${tx * 2 + dx}/${ty * 2 + dy}.jpg`);
    ctx.drawImage(bmp, dx * 256, dy * 256);
  })));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
