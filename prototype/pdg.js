// PDG(Pilot Declared Goal) —— ?dev=1 専用
//
// JDGは「競技委員が決めた1つのゴール」に投下する。PDGは**パイロット自身が目標を宣言**する。
//
// ── いまの範囲(2026-08-25決定) ───────────────────────────────
//   **宣言する目標は1つ。マーカーも1本。** 成績は目標までの距離。
//   複数目標にすると順序・割り当て・合計/平均の扱いが一気に増えるので、まず1つで作る。
//
// ── 将来ここへ寄せる(競技規定) ────────────────────────────────
//   FAIのPDGの記述はこうなっている:
//     「Competitors attempt to drop **a marker** close to a goal selected and declared by him」
//     「The result is the distance from the mark to **nearest valid declared goal**」
//   つまり **1タスク = マーカー1本**で、**目標は最大3つまで宣言してよい**。
//   複数宣言は「保険」で、風が変わって目標1へ行けなければ目標2を狙えばよい。
//   **採点は最も近い宣言目標まで。順番の縛りはない。**
//
//   **マーカーの色と番号は「タスクごと」に指定される**(2026-08-25、ユーザーの解説)。
//   タスク1の色のマーカーはタスク1にしか使えない。
//   これは**タスク間**の対応であって、1つのPDGタスク内の目標との対応ではない。
//
//   ⚠ 一度「N番目の宣言 ← N番目の投下(order方式)」で実装したが、
//     **公式の記述は「最も近い宣言目標」**だったので取り消した。
//     複数目標に戻すときは **order ではなく「最寄り」** で実装すること。
//
// ── 手元の飛行ログについて ────────────────────────────────────
//   ⚠ **提供された飛行ログ(IGC)は練習フライトで、競技規則は適用されていない**
//     (2026-08-25、提供者側の情報)。練習では順番も投下も自由なので、
//     **あのログからマーカーと目標の対応規則を読み取ろうとしてはいけない。**
//
// ── 設計の要 ─────────────────────────────────────────────
//   **宣言画面ではパイバル表と地図だけを見せる。**
//   気圧配置モデルの計算結果や実データの気象は、宣言中は隠す。
//   PDGは「宣言した時点の風読みが当たったか」を競うものなので、
//   宣言の時点で手札を増やすと競技として成立しない。
//   実物でも、宣言時に手元にあったのはパイバル観測だけだった。

const MAX_GOALS = 1;                 // 将来 3 まで増やせる(そのときは採点を「最寄り」に)
const GOAL_COLORS = ['#e53935', '#fb8c00', '#8e24aa'];

export const pdg = {
  enabled: false,      // PDGモードか(?dev=1 でユーザーが入れたときだけ true)
  placing: false,      // 地図のクリックが「目標を置く」か(false なら離陸地点)
  goals: [],           // { x, z, ft }
  declared: false,     // 離陸したら宣言を締め切る
  drops: [],           // 着地したマーカーの位置 { x, z }
};

export const pdgActive = () => pdg.enabled && pdg.goals.length > 0;

// 離陸地点は main.js の devLaunchSel が持っているので、表示用に参照だけ受け取る
export const pdgLaunch = { x: null, z: null };

// 宣言中に隠すもの = 「実際の風」を教えてしまう部分。
// パイバル表(.b-left)と地図(.b-right)だけを残す
const HIDE_SELECTORS = ['.b-pressure', '.b-diurnal'];

function setHidden(hidden) {
  const root = document.getElementById('dev-briefing');
  if (!root) return;
  for (const selector of HIDE_SELECTORS) {
    for (const el of root.querySelectorAll(selector)) {
      el.style.display = hidden ? 'none' : '';
    }
  }
}

export function setupPdgUi(onChange) {
  const right = document.querySelector('#dev-briefing .b-right');
  if (!right) return null;

  const box = document.createElement('div');
  box.className = 'b-hint';
  box.style.cssText = 'margin-top:10px; line-height:1.7';
  box.innerHTML = `
    <label style="display:inline-flex; align-items:center; gap:6px; font-weight:600">
      <input type="checkbox" id="pdg-on"> PDG(目標宣言)で飛ぶ
    </label>
    <div id="pdg-body" style="display:none; margin-top:8px">
      <div style="margin-bottom:6px">
        <button type="button" id="pdg-mode-goal" class="pmode-btn">目標を置く</button>
        <button type="button" id="pdg-mode-launch" class="pmode-btn active">離陸地点を置く</button>
        <button type="button" id="pdg-clear" class="pmode-clear">目標をクリア</button>
        <label style="margin-left:8px">宣言高度
          <input type="number" id="pdg-ft" step="100" value="500" style="width:80px"> ft</label>
      </div>
      <div id="pdg-list"></div>
      <div style="margin-top:6px; opacity:.85">
        目標は<strong>離陸するまで何度でも置き直せます</strong>（実際の競技でも再宣言があります）。<br>
        <strong>宣言のあいだ、気圧配置モデルと実データの気象は隠しています。</strong>
        手札はパイバル表と地図だけです。時間と場所で風は変わるので、当たるとは限りません。<br>
        マーカーは<strong>1本</strong>。成績は<strong>宣言した目標までの距離</strong>です。
        投下しなかった場合は、着陸・時間切れのときに機体位置で計測します。
      </div>
    </div>`;
  right.appendChild(box);

  const on = box.querySelector('#pdg-on');
  const body = box.querySelector('#pdg-body');
  const modeGoal = box.querySelector('#pdg-mode-goal');
  const modeLaunch = box.querySelector('#pdg-mode-launch');

  function refreshMode() {
    modeGoal.classList.toggle('active', pdg.placing);
    modeLaunch.classList.toggle('active', !pdg.placing);
  }

  function renderList() {
    const list = box.querySelector('#pdg-list');
    if (!pdg.goals.length) {
      list.innerHTML = '地図をクリックして目標を置いてください。';
      return;
    }
    list.innerHTML = pdg.goals.map((g, i) => {
      const from = pdgLaunch.x === null
        ? ''
        : `　離陸地点から ${Math.round(Math.hypot(g.x - pdgLaunch.x, g.z - pdgLaunch.z))} m`;
      return `<div><span style="color:${GOAL_COLORS[i]}">■</span> 宣言目標　${g.ft} ft${from}</div>`;
    }).join('');
  }

  on.addEventListener('change', () => {
    pdg.enabled = on.checked;
    body.style.display = pdg.enabled ? '' : 'none';
    if (!pdg.enabled) { pdg.placing = false; pdg.goals = []; }
    setHidden(pdg.enabled);
    refreshMode();
    renderList();
    onChange();
  });
  modeGoal.addEventListener('click', () => { pdg.placing = true; refreshMode(); });
  modeLaunch.addEventListener('click', () => { pdg.placing = false; refreshMode(); });
  box.querySelector('#pdg-clear').addEventListener('click', () => {
    pdg.goals = [];
    renderList();
    onChange();
  });

  renderList();
  return { renderList };
}

export function addGoal(x, z, ft) {
  if (pdg.declared) return false;
  // 上限に達していたら古いものから押し出す(=置き直し・再宣言)
  if (pdg.goals.length >= MAX_GOALS) pdg.goals.shift();
  pdg.goals.push({ x, z, ft });
  return true;
}

// ---- ブリーフィング地図への描画 ----
export function drawGoalsOnMap(ctx, worldToScreen) {
  pdg.goals.forEach((g, i) => {
    const [sx, sy] = worldToScreen(g.x, g.z);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx, sy, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = GOAL_COLORS[i];
    ctx.beginPath();
    ctx.arc(sx, sy, 10, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ---- 採点 ----
// マーカーが投下されていればその着地点、無ければ(飛行が終わったときだけ)機体位置。
//
// includeCurrentPos: 飛行が実際に終わった(着陸・時間切れ)ときだけ true。
// **マーカーを使い切っただけのときは false** —— まだ飛んでいる途中なので、
// そのときの機体位置を「着陸地点」として混ぜてはいけない
// (2026-08-25に実際に出た不具合: 投下したのに「着陸地点で計測」と出た)
export function scorePdg(currentPos, includeCurrentPos) {
  const rows = pdg.goals.map((g, i) => {
    const drop = pdg.drops[0];
    if (drop) {
      return {
        number: i + 1,
        distance: Math.hypot(drop.x - g.x, drop.z - g.z),
        usedDrop: true, measured: true,
      };
    }
    if (includeCurrentPos) {
      return {
        number: i + 1,
        distance: Math.hypot(currentPos.x - g.x, currentPos.z - g.z),
        usedDrop: false, measured: true,
      };
    }
    return { number: i + 1, distance: Infinity, usedDrop: false, measured: false };
  });
  const scored = rows.filter((r) => r.measured);
  const total = scored.reduce((s, r) => s + r.distance, 0);
  return { rows, total, scoredCount: scored.length };
}

export { MAX_GOALS, GOAL_COLORS };
