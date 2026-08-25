// PDG(Pilot Declared Goal) —— ?dev=1 専用
//
// JDGは「競技委員が決めた1つのゴール」に投下する。PDGは**パイロット自身が目標を宣言**する。
// 実データ(2026-08-24、飛行ログ2本)で分かった実物の姿:
//
//   - 目標は2〜3個。**離陸の15〜21分前**に、地上で、まとめて宣言する
//   - **撤回・再宣言がある**(1本目: 20分前に宣言した目標を12分前に別の場所・別の高度へ変更)
//   - 距離は441m〜5458m。**遠い目標は届かない**(5458mの目標には1640mまでしか寄れていない)
//   - **マーカー番号と目標番号は対応しない。** 番号は投下順とみられる
//   - 届かなかった目標は、**着陸時にその場でマーカーを置いていた**
//
// 設計の要:
//
//   **宣言画面ではパイバル表と地図だけを見せる**(2026-08-24決定)。
//   気圧配置モデルの計算結果や実データの気象は、宣言中は隠す。
//   PDGは「宣言した時点の風読みが当たったか」を競うものなので、
//   宣言の時点で手札を増やすと競技として成立しない。
//   実物でも、宣言時に手元にあったのはパイバル観測だけだった。
//
//   **採点はマーカーと目標を対応づけない。**
//   「各目標について、いちばん近かったマーカー(無ければ着陸地点)までの距離」の合計。
//   IGCから狙いが読めなかったのと同じ理由で、対応づけは決められない。

const MAX_GOALS = 3;
const GOAL_COLORS = ['#e53935', '#fb8c00', '#8e24aa'];

export const pdg = {
  enabled: false,      // PDGモードか(?dev=1 でユーザーが入れたときだけ true)
  placing: false,      // 地図のクリックが「目標を置く」か(false なら離陸地点)
  goals: [],           // { x, z, ft }
  declared: false,     // 離陸したら宣言を締め切る
  drops: [],           // 着地したマーカーの位置 { x, z }
};

export const pdgActive = () => pdg.enabled && pdg.goals.length > 0;

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

// 離陸ボタンの文言は launch-map 側が書き換えるので、こちらは状態表示だけ持つ
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
      <div id="pdg-list">地図をクリックして目標を置いてください（最大${MAX_GOALS}個）。</div>
      <div style="margin-top:6px; opacity:.85">
        目標は<strong>離陸するまで何度でも置き直せます</strong>（実際の競技でも再宣言があります）。<br>
        <strong>宣言のあいだ、気圧配置モデルと実データの気象は隠しています。</strong>
        手札はパイバル表と地図だけです。時間と場所で風は変わるので、当たるとは限りません。<br>
        採点は<strong>各目標について、いちばん近かったマーカー（無ければ着陸地点）までの距離の合計</strong>です。
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

  function renderList() {
    const list = box.querySelector('#pdg-list');
    if (!pdg.goals.length) {
      list.innerHTML = `地図をクリックして目標を置いてください（最大${MAX_GOALS}個）。`;
      return;
    }
    list.innerHTML = pdg.goals.map((g, i) => {
      const d = Math.hypot(g.x - (pdgLaunch.x ?? 0), g.z - (pdgLaunch.z ?? 0));
      const from = pdgLaunch.x === null ? '' : `　離陸地点から ${Math.round(d)} m`;
      return `<div><span style="color:${GOAL_COLORS[i]}">■</span> 目標${i + 1}　${g.ft} ft${from}</div>`;
    }).join('');
  }

  return { renderList };
}

// 離陸地点は main.js の devLaunchSel が持っているので、表示用に参照だけ受け取る
export const pdgLaunch = { x: null, z: null };

export function addGoal(x, z, ft) {
  if (pdg.declared) return false;
  if (pdg.goals.length >= MAX_GOALS) pdg.goals.shift();   // 古いものから押し出す(再宣言)
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
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), sx, sy + 8);
  });
}

// ---- 採点 ----
// マーカーと目標は対応づけない。各目標について、いちばん近かったマーカー
// (1つも無ければ着陸地点)までの距離を採る。届かなかった目標が着陸地点で計測されるのは、
// 実データで「届かない目標には着陸時にその場でマーカーを置いていた」のと同じ扱い。
// includeCurrentPos: 飛行が実際に終わった(着陸・時間切れ)ときだけ true。
// **マーカーを使い切っただけのときは false** —— まだ飛んでいる途中なので、
// そのときの機体位置を「着陸地点」として混ぜてはいけない
// (2026-08-25に実際に出た不具合: 投下したのに「着陸地点で計測」と出た)
export function scorePdg(currentPos, includeCurrentPos) {
  const rows = pdg.goals.map((g, i) => {
    let best = Infinity;
    let usedDrop = false;
    for (const p of pdg.drops) {
      const d = Math.hypot(p.x - g.x, p.z - g.z);
      if (d < best) { best = d; usedDrop = true; }
    }
    if (includeCurrentPos) {
      const here = Math.hypot(currentPos.x - g.x, currentPos.z - g.z);
      if (here < best) { best = here; usedDrop = false; }
    }
    return { number: i + 1, distance: best, usedDrop, measured: Number.isFinite(best) };
  });
  const scored = rows.filter((r) => r.measured);
  return { rows, total: scored.reduce((s, r) => s + r.distance, 0) };
}

export { MAX_GOALS, GOAL_COLORS };
