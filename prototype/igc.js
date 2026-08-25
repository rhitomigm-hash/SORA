// 飛行ログ(IGC)の読み取り —— SORAの3D表示に要る分だけ
//
// ⚠ これは `tools/igc-view.html` の解析部分の**部分集合**です(2026-08-24の決定)。
//    向こうは1ファイルで完結させる約束(要望⑥: Claude Codeが終わっても分析できるように)なので、
//    共有せず**書き写して**あります。共有しているのは「文字の切り出し」だけで、
//    **風の集計・高度帯・CSVは持ち込んでいません**(静かに壊れるのはあちら側なので、
//    複製しない)。切り出しを間違えると軌跡がとんでもない場所に出るため、一目で分かります。
//
// 書式の詳細は `data/IGC分析メモ.md`。直すときは向こうも直すこと。

// 位置ブロック: 緯度8 + 経度9 + 測位1 + 気圧高度5 + GPS高度5 = 28文字
const FIX_BLOCK_LENGTH = 28;
const GROUND_AGL_M = 30;    // これ未満は地上とみなす
const FEET_PER_M = 3.28084;

// ---- 低レベル(バイト位置の切り出し) ----

function parseExtensionList(count, rest) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const chunk = rest.slice(i * 7, i * 7 + 7);
    if (chunk.length < 7) break;
    list.push({ from: +chunk.slice(0, 2), to: +chunk.slice(2, 4), code: chunk.slice(4, 7).toUpperCase() });
  }
  return list;
}

function parseTime(hhmmss) {
  return (+hhmmss.slice(0, 2)) * 3600 + (+hhmmss.slice(2, 4)) * 60 + (+hhmmss.slice(4, 6));
}

// 緯度経度は「度＋分」。DD + MM.mmm/60。DD.MMmmm と読むとまったく違う場所になる
function parseLatitude(s) {
  const value = (+s.slice(0, 2)) + (+s.slice(2, 7)) / 1000 / 60;
  return s[7].toUpperCase() === 'S' ? -value : value;
}
function parseLongitude(s) {
  const value = (+s.slice(0, 3)) + (+s.slice(3, 8)) / 1000 / 60;
  return s[8].toUpperCase() === 'W' ? -value : value;
}

function readFixBlock(line, start, seconds, extensions) {
  const lat = line.slice(start, start + 8);
  const lon = line.slice(start + 8, start + 17);
  if (!/^\d{7}[NS]$/i.test(lat) || !/^\d{8}[EW]$/i.test(lon)) return null;

  const fix = {
    seconds,
    lat: parseLatitude(lat),
    lon: parseLongitude(lon),
    pressureAlt: parseInt(line.slice(start + 18, start + 23), 10),
    gpsAlt: parseInt(line.slice(start + 23, start + 28), 10),
  };
  if (!Number.isFinite(fix.pressureAlt)) fix.pressureAlt = null;
  if (!Number.isFinite(fix.gpsAlt)) fix.gpsAlt = null;

  // 拡張の位置はファイルごとに違う。必ず I / HFXII レコードを読んでから切り出す
  for (const ext of extensions || []) {
    const value = line.slice(ext.from - 1, ext.to);
    if (!value) continue;
    const extra = (+value) / Math.pow(10, value.length) / 1000 / 60;
    if (ext.code === 'LAD') fix.lat += (fix.lat < 0 ? -extra : extra);
    else if (ext.code === 'LOD') fix.lon += (fix.lon < 0 ? -extra : extra);
  }
  return fix;
}

// ---- ファイル全体 ----

export function parseIgc(text) {
  const lines = text.split(/\r?\n/);
  const headers = {};
  const eventDefs = {};
  let flightDate = null;
  let bExtensions = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const kind = line[0].toUpperCase();

    if (kind === 'H') {
      if (/^HFDTE/i.test(line)) {
        const digits = line.replace(/^HFDTE(DATE:)?/i, '').replace(/[^0-9]/g, '');
        if (digits.length >= 6) {
          flightDate = { year: 2000 + +digits.slice(4, 6), month: +digits.slice(2, 4), day: +digits.slice(0, 2) };
        }
      } else if (/^HFXII:/i.test(line)) {
        const m = line.match(/^HFXII:([A-Z0-9]{3}):(\d{2})(.*)$/i);
        if (m) eventDefs[m[1].toUpperCase()] = parseExtensionList(+m[2], m[3]);
      } else {
        const m = line.match(/^H[FOP]([A-Z0-9]{3})(.*)$/i);
        if (m) headers[m[1].toUpperCase()] = m[2];
      }
    } else if (kind === 'I') {
      bExtensions = parseExtensionList(+line.slice(1, 3), line.slice(3));
    }
  }

  const fixes = [];
  const events = [];
  for (const raw of lines) {
    const line = raw.replace(/[\r\n]+$/, '');
    if (!line) continue;
    const kind = line[0].toUpperCase();
    if (kind === 'B') {
      if (line.length < 7 + FIX_BLOCK_LENGTH) continue;
      const fix = readFixBlock(line, 7, parseTime(line.slice(1, 7)), bExtensions);
      if (fix) fixes.push(fix);
    } else if (kind === 'E' && line.length >= 10) {
      events.push({ seconds: parseTime(line.slice(1, 7)), code: line.slice(7, 10).toUpperCase(), body: line.slice(10) });
    }
  }

  return { headers, flightDate, eventDefs, fixes, events };
}

// E系レコード(XX0 マーカー投下 / XL1 宣言した位置)。body = 番号2 + 位置ブロック28 + …
function parseEventFix(event) {
  if (event.body.length < 2 + FIX_BLOCK_LENGTH) return null;
  const fix = readFixBlock(event.code + event.body, 3 + 2, event.seconds, null);
  return fix ? { number: +event.body.slice(0, 2), fix } : null;
}

// ---- UTM(WGS84 順変換)。目標宣言の北成分を復元するために要る ----
// 変数名は短くしない($a と $A の衝突で静かに壊れた前例がある)
export function toUtm(latitudeDeg, longitudeDeg) {
  const semiMajorAxis = 6378137.0;
  const flattening = 1 / 298.257223563;
  const eccentricitySq = flattening * (2 - flattening);
  const eccentricityPrimeSq = eccentricitySq / (1 - eccentricitySq);
  const scaleFactor = 0.9996;

  const zone = Math.floor((longitudeDeg + 180) / 6) + 1;
  const centralMeridian = (zone - 1) * 6 - 180 + 3;
  const latitudeRad = latitudeDeg * Math.PI / 180;
  const deltaLonRad = (longitudeDeg - centralMeridian) * Math.PI / 180;

  const sinLat = Math.sin(latitudeRad), cosLat = Math.cos(latitudeRad), tanLat = Math.tan(latitudeRad);
  const radiusOfCurvature = semiMajorAxis / Math.sqrt(1 - eccentricitySq * sinLat * sinLat);
  const tanSq = tanLat * tanLat;
  const etaSq = eccentricityPrimeSq * cosLat * cosLat;
  const angle = deltaLonRad * cosLat;

  const meridionalArc = semiMajorAxis * (
      (1 - eccentricitySq / 4 - 3 * eccentricitySq ** 2 / 64 - 5 * eccentricitySq ** 3 / 256) * latitudeRad
    - (3 * eccentricitySq / 8 + 3 * eccentricitySq ** 2 / 32 + 45 * eccentricitySq ** 3 / 1024) * Math.sin(2 * latitudeRad)
    + (15 * eccentricitySq ** 2 / 256 + 45 * eccentricitySq ** 3 / 1024) * Math.sin(4 * latitudeRad)
    - (35 * eccentricitySq ** 3 / 3072) * Math.sin(6 * latitudeRad));

  const easting = scaleFactor * radiusOfCurvature * (
      angle
    + angle ** 3 / 6 * (1 - tanSq + etaSq)
    + angle ** 5 / 120 * (5 - 18 * tanSq + tanSq ** 2 + 72 * etaSq - 58 * eccentricityPrimeSq)) + 500000;

  let northing = scaleFactor * (meridionalArc + radiusOfCurvature * tanLat * (
      angle ** 2 / 2
    + angle ** 4 / 24 * (5 - tanSq + 9 * etaSq + 4 * etaSq ** 2)
    + angle ** 6 / 720 * (61 - 58 * tanSq + tanSq ** 2 + 600 * etaSq - 330 * eccentricityPrimeSq)));
  if (latitudeDeg < 0) northing += 10000000;

  return { zone, easting, northing };
}

// ---- 時刻 ----
export function jstLabel(seconds) {
  const t = ((seconds + 9 * 3600) % 86400 + 86400) % 86400;
  const pad = (v) => String(Math.floor(v)).padStart(2, '0');
  return `${pad(t / 3600)}:${pad(t % 3600 / 60)}:${pad(t % 60)}`;
}
export function jstDateText(date, seconds) {
  if (!date) return '—';
  const jst = new Date(Date.UTC(date.year, date.month - 1, date.day, 0, 0, seconds) + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
}

// ---- 高度別の風(気球は風の完全なトレーサー。水平移動速度がそのまま風) ----
//
// ⚠ 手順は `tools/igc-view.html` と揃えること。ずれると「実測の風」が別物になる。
//   1秒差分はGPSノイズに埋もれるので60秒。上昇下降中は層をまたぐので捨てる。
//   風向は東西・南北成分で平均してから角度に直す(角度のまま平均すると0°/360°で壊れる)。
const WIND_STEP_S = 60;      // 差分の間隔(秒)
const WIND_BAND_M = 150;     // 高度帯の刻み(m)
const WIND_CLIMB_LIMIT_M = 60;  // この間隔でこれ以上動いたら上昇下降中
const KNOT_PER_MS = 1.94384;
const MIN_N_FOR_PIBAL = 10;  // これ未満の帯はパイバルに使わない

function computeWindBands(fixes, groundPressureAlt, mslOf, toWorld, step, bandSize) {
  const bySeconds = new Map();
  for (const f of fixes) bySeconds.set(f.seconds, f);
  const bands = new Map();

  for (const f of fixes) {
    const later = bySeconds.get(f.seconds + step);
    if (!later) continue;
    // 地上にいる時間を除く(忘れると「無風」が大量に混ざる)
    if (f.pressureAlt - groundPressureAlt < GROUND_AGL_M) continue;
    if (later.pressureAlt - groundPressureAlt < GROUND_AGL_M) continue;
    // 上昇下降中を除く(複数の層をまたいでいる)
    if (Math.abs(later.pressureAlt - f.pressureAlt) >= WIND_CLIMB_LIMIT_M) continue;

    const a = toWorld(f), b = toWorld(later);
    const eastward = (b.x - a.x) / step;
    const northward = (-(b.z) - (-(a.z))) / step;   // z は南が+ なので北成分は符号を戻す
    const midMsl = (mslOf(f) + mslOf(later)) / 2;
    const key = Math.floor(midMsl / bandSize) * bandSize;

    if (!bands.has(key)) bands.set(key, { key, n: 0, eastSum: 0, northSum: 0, firstSec: f.seconds, lastSec: later.seconds });
    const band = bands.get(key);
    band.n++; band.eastSum += eastward; band.northSum += northward;
    band.firstSec = Math.min(band.firstSec, f.seconds);
    band.lastSec = Math.max(band.lastSec, later.seconds);
  }

  return [...bands.values()].sort((a, b) => a.key - b.key).map((band) => {
    const eastMean = band.eastSum / band.n;
    const northMean = band.northSum / band.n;
    const drift = (Math.atan2(eastMean, northMean) * 180 / Math.PI + 360) % 360;
    return {
      key: band.key, n: band.n,
      fromDeg: (drift + 180) % 360,                       // 吹いてくる向き
      speedKt: Math.hypot(eastMean, northMean) * KNOT_PER_MS,
      firstSec: band.firstSec, lastSec: band.lastSec,
    };
  });
}

// SORAのパイバル表(高度ft MSL / 風向FROM / 風速kt)へ。帯の中央を代表高度にする
function toPibalRows(bands, bandSize) {
  return bands
    .filter((b) => b.n >= MIN_N_FOR_PIBAL)
    .map((b) => ({
      ft: Math.round((b.key + bandSize / 2) * FEET_PER_M),
      dir: Math.round(b.fromDeg),
      kt: Math.round(b.speedKt * 10) / 10,
    }))
    .sort((a, b) => a.ft - b.ft);
}

// ---- 表示用にまとめる ----
//
// 戻り値の座標系は SORA の世界座標に合わせてある: **x=東+ / z=南+ / y=海抜m**、
// 原点は離陸地点。terrain.js が返す世界座標と同じ土俵なので、そのまま置ける。
//
export function buildFlight(igc) {
  const fixes = igc.fixes.filter((f) => f.pressureAlt !== null);
  if (fixes.length < 2) throw new Error('Bレコード(位置の記録)が読めませんでした。');

  // 地上の基準。気圧高度は1013hPa基準で当日気圧に合っていないので、生の値に閾値を当てない
  // (実測で地上の気圧高度が日により28m違った)
  const sorted = fixes.map((f) => f.pressureAlt).slice().sort((a, b) => a - b);
  const groundPressureAlt = sorted[Math.floor(sorted.length * 0.02)];

  // 海抜へ寄せる: 層に分けるのは気圧高度(滑らか)のまま、地上でのGPS高度との差を足す
  const offsets = fixes
    .filter((f) => f.pressureAlt - groundPressureAlt < GROUND_AGL_M && f.gpsAlt !== null)
    .map((f) => f.gpsAlt - f.pressureAlt)
    .sort((a, b) => a - b);
  const altitudeOffset = offsets.length ? offsets[Math.floor(offsets.length / 2)] : 0;
  const mslOf = (f) => f.pressureAlt + altitudeOffset;

  const airborne = fixes.filter((f) => f.pressureAlt - groundPressureAlt >= GROUND_AGL_M);
  const takeoffFix = airborne.length ? airborne[0] : fixes[0];
  const landingFix = airborne.length ? airborne[airborne.length - 1] : fixes[fixes.length - 1];

  const latitudeRad = takeoffFix.lat * Math.PI / 180;
  const metersPerDegreeNorth = 111132.92 - 559.82 * Math.cos(2 * latitudeRad) + 1.175 * Math.cos(4 * latitudeRad);
  const metersPerDegreeEast = 111412.84 * Math.cos(latitudeRad) - 93.5 * Math.cos(3 * latitudeRad);
  const toWorld = (f) => ({
    x: (f.lon - takeoffFix.lon) * metersPerDegreeEast,
    z: -(f.lat - takeoffFix.lat) * metersPerDegreeNorth,   // z は南が+
  });

  const track = fixes.map((f) => {
    const w = toWorld(f);
    return { x: w.x, z: w.z, y: mslOf(f), seconds: f.seconds, agl: f.pressureAlt - groundPressureAlt };
  });

  // ---- 宣言目標(UTMの下位桁を離陸地点の100km区画から復元する) ----
  const takeoffUtm = toUtm(takeoffFix.lat, takeoffFix.lon);
  const northBlock = Math.floor(takeoffUtm.northing / 100000) * 100000;
  const declarations = [];
  const markers = [];

  for (const event of igc.events) {
    if (/^XX[1-9]$/.test(event.code)) {
      const m = event.body.match(/^(\d{2})(\d{5})\/(\d{4}),?(-?\d+)?/);
      if (!m) continue;
      const easting = +m[2] * 10;
      const northing = northBlock + (+m[3]) * 10;
      declarations.push({
        number: +m[1], seconds: event.seconds,
        raw: `${m[2]}/${m[3]}`,
        altitudeFt: m[4] !== undefined ? +m[4] : null,
        easting, northing,
        x: easting - takeoffUtm.easting,
        z: -(northing - takeoffUtm.northing),
        distance: Math.hypot(easting - takeoffUtm.easting, northing - takeoffUtm.northing),
      });
    } else if (event.code === 'XX0') {
      const parsed = parseEventFix(event);
      if (!parsed) continue;
      const w = toWorld(parsed.fix);
      markers.push({
        number: parsed.number, seconds: event.seconds,
        x: w.x, z: w.z,
        y: parsed.fix.pressureAlt !== null ? parsed.fix.pressureAlt + altitudeOffset : null,
        agl: parsed.fix.pressureAlt !== null ? parsed.fix.pressureAlt - groundPressureAlt : null,
        utm: toUtm(parsed.fix.lat, parsed.fix.lon),
      });
    }
  }

  // 同じ番号の再宣言は、時刻が新しいほうが有効
  const effective = new Map();
  for (const d of declarations.slice().sort((a, b) => a.seconds - b.seconds)) effective.set(d.number, d);
  for (const d of declarations) d.superseded = effective.get(d.number) !== d;

  // マーカーと目標の対応。
  //
  // ⚠ **番号どうしを対応させない。** 競技のPDGは
  //   「the distance from the mark to **nearest valid declared goal**」= 最も近い宣言目標で採点する。
  //   さらに**このログは練習フライト**で、そもそも競技規則が適用されていない(2026-08-25、提供者側の情報)。
  //   **練習では順番も投下も自由**なので、対応規則を読み取ろうとしてはいけない。
  //   実例: 投下1は目標1から724m、同じ投下が目標2からは72m。
  //
  // 事実として**すべての目標との距離を並べ、最寄りを主に出す**。
  const activeGoals = [...effective.values()].sort((a, b) => a.number - b.number);
  markers.sort((a, b) => a.seconds - b.seconds);
  markers.forEach((marker, index) => {
    marker.dropOrder = index + 1;
    marker.distances = activeGoals
      .map((g) => ({ number: g.number, distance: Math.hypot(marker.utm.easting - g.easting, marker.utm.northing - g.northing) }))
      .sort((a, b) => a.distance - b.distance);
    marker.nearest = marker.distances[0] || null;
  });

  // ---- 高度別の風 ----
  // 2026-08-24: 当初「風の集計はSORAに複製しない」と決めていたが、
  // 「実測の風で飛ぶ・なぞる」を入れるにあたり必要になったので複製した。
  // 手順は `data/IGC分析メモ.md` と `tools/igc-view.html` と同じでなければならない。
  // 一致は検算で確かめること(帯ごとの風向・風速・nが両者で一致するか)。
  const windBands = computeWindBands(fixes, groundPressureAlt, mslOf, toWorld, WIND_STEP_S, WIND_BAND_M);

  const ys = track.map((p) => p.y);
  return {
    track, declarations, markers, altitudeOffset, windBands,
    pibalRows: toPibalRows(windBands, WIND_BAND_M),
    takeoff: { lon: takeoffFix.lon, lat: takeoffFix.lat, seconds: takeoffFix.seconds, msl: mslOf(takeoffFix) },
    landing: { seconds: landingFix.seconds },
    date: igc.flightDate,
    dateText: jstDateText(igc.flightDate, takeoffFix.seconds),
    mslRange: [Math.min(...ys), Math.max(...ys)],
    loggerText: igc.headers.FTY ? igc.headers.FTY.replace(/^FRTYPE:/i, '') : '—',
    counts: { fixes: fixes.length, airborne: airborne.length },
    FEET_PER_M,
  };
}
