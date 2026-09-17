// 実DEM・実道路で統合を確認する。テスト用アクセス口はHTTP応答だけに追加する。
// SORAを8002で配信し、SORA_PLAYWRIGHTにPlaywrightパッケージの場所を指定して実行。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SORA_PLAYWRIGHT || 'playwright');
const root = new URL('../../', import.meta.url);
const out = new URL(process.env.SORA_VERIFY_OUT || 'tmp/crew-verification/', root);
const cache = new URL(process.env.SORA_CACHE || 'cache/', out);
await mkdir(out, { recursive: true });
await mkdir(cache, { recursive: true });
// 提供者の実ログを使わず、再現可能な架空ログを作る。
const igcLines = ['AXXXSORA TEST', 'HFDTE160926'];
for (let t=0;t<=600;t++) {
  const hhmmss = `00${String(Math.floor(t/60)).padStart(2,'0')}${String(t%60).padStart(2,'0')}`;
  const lat = String(16200 + Math.floor(t/10)).padStart(5,'0');
  const lon = String(15000 + Math.floor(t/8)).padStart(5,'0');
  const alt = String(Math.round(20 + 200 * Math.sin(Math.PI*t/600))).padStart(5,'0');
  igcLines.push(`B${hhmmss}33${lat}N130${lon}EA${alt}${alt}`);
}
const igcData = Buffer.from(igcLines.join('\r\n'));
await writeFile(new URL('synthetic.igc',out),igcData);
// ZIPは外部依存なしのstore方式。CRC32と単一エントリを含む正規のZIPを作る。
let crc=0xffffffff;
for(const byte of igcData) {crc^=byte; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
crc=(crc^0xffffffff)>>>0;
const name=Buffer.from('synthetic.igc'), local=Buffer.alloc(30), central=Buffer.alloc(46), end=Buffer.alloc(22);
local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);
local.writeUInt32LE(igcData.length,18);local.writeUInt32LE(igcData.length,22);local.writeUInt16LE(name.length,26);
central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);
central.writeUInt32LE(igcData.length,20);central.writeUInt32LE(igcData.length,24);central.writeUInt16LE(name.length,28);
end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);
end.writeUInt32LE(local.length+name.length+igcData.length,16);
await writeFile(new URL('synthetic.zip',out),Buffer.concat([local,name,igcData,central,name,end]));
const source = await readFile(new URL('prototype/main.js', root), 'utf8');
const hook = `
window.soraCrewTest = {
 stop: () => renderer.setAnimationLoop(null),
 render: () => {balloon.group.position.copy(state.pos);updateHud(windAt(state.pos.y,state.pos.x,state.pos.z));renderer.render(scene,camera);},
 snap: () => ({started, pos:{...state.pos}, remaining, fuel:state.fuel,
  crew:groundCrew?.info(), enabled:crewOption.checked, url:shareUrl(), pdg:pdgActive(), igcViewMode}),
 ready: () => groundCrew?.ready,
 simulation: (seconds) => {
  for(let t=0;t<seconds;t+=0.2) groundCrew?.update(0.2);
  return groundCrew?.info();
 },
 moveBalloon: (x,z) => state.pos.set(x,terrain.getHeight(x,z)+100,z),
 wind: (x,z) => windAt(terrain.getHeight(x,z),x,z),
 bounds: () => ({minX:terrain.map.minX,minZ:terrain.map.minZ,maxX:terrain.map.minX+terrain.sizeMeters,maxZ:terrain.map.minZ+terrain.sizeMeters}),
 selectLaunch: (x,z) => {devLaunchSel.x=x;devLaunchSel.z=z;pdgLaunch.x=x;pdgLaunch.z=z;document.getElementById('launch-btn-dev').disabled=false;},
 addGoal: (x,z) => { addGoal(x,z,0); pdgUi.renderList(); },
 start: () => startFlight(1000,1000),
 burn: () => {input.burner=true;stepPhysics(1);input.burner=false;return state.heat;}
};`;
const browser = await chromium.launch({ headless: true });
const reports = [];
const base = process.env.SORA_BASE || 'http://127.0.0.1:8002/prototype/';
async function pageFor(query, { mobile = false, failure = false } = {}) {
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
    : { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('experimental_bvmap')) requests.push(r.url()); });
  await page.route('**/main.js', route => route.fulfill({ contentType: 'text/javascript', body: source + hook }));
  await page.route('https://**/*', async route => {
    const url = route.request().url();
    if (failure && url.includes('experimental_bvmap')) return route.fulfill({ status: 503, body: '' });
    if (url.includes('open-meteo.com')) return route.abort(); // 参考気象は今回の検証対象外
    const file = new URL(`${createHash('sha256').update(url).digest('hex')}.json`, cache);
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      return route.fulfill({ status: cached.status, headers: cached.headers, body: Buffer.from(cached.body, 'base64') });
    } catch {}
    try {
      const response = await route.fetch({ timeout: 30000 });
      const body = await response.body();
      if (response.ok()) await writeFile(file, JSON.stringify({ status: response.status(), headers: response.headers(), body: body.toString('base64') }));
      await route.fulfill({ response, body });
    } catch { await route.abort().catch(() => {}); }
  });
  await page.goto(base + query, { waitUntil: 'domcontentloaded' });
  return { page, context, errors, requests };
}
async function loaded(t) {
  await t.page.waitForFunction(() => !!window.soraCrewTest, undefined, { timeout: 90000 });
  assert.deepEqual(t.errors, []);
}
async function finish(t, name) {
  assert.deepEqual(t.errors, [], name);
  reports.push({ name, passed: true });
  console.log('PASS', name);
  await t.context.close();
}
try {
  // 既定・setup・共有エリア・dev(JDG/PDG)で選択しなければ道路を取得しない。
  for (const [name, query] of [['default',''], ['setup','?setup=1&a=130.25,33.27'],
    ['area','?a=130.25,33.27'], ['dev-off','?dev=1&a=130.25,33.27'], ['pdg-off','?dev=1&a=130.25,33.27'],
    ['dev-opt-out','?dev=1&a=130.25,33.27&road=1'], ['road-ignored','?road=1']]) {
    const t = await pageFor(query); await loaded(t);
    if (name === 'pdg-off') {
      await t.page.locator('#pdg-on').check();
      await t.page.evaluate(() => { soraCrewTest.addGoal(500,500); soraCrewTest.selectLaunch(1500,1500); });
      await t.page.locator('#launch-btn-dev').click();
    } else if (name === 'dev-off' || name === 'dev-opt-out') {
      if(name==='dev-opt-out') await t.page.locator('#crew-enabled').uncheck();
      await t.page.evaluate(() => soraCrewTest.selectLaunch(1000,1000));
      await t.page.locator('#launch-btn-dev').click();
    } else if (name !== 'default' && name !== 'road-ignored') {
      const map = t.page.locator('#launch-map');
      await map.click({ position: { x: 150, y: 150 } });
      await t.page.locator('#launch-btn').click();
    }
    assert.equal((await t.page.evaluate(() => soraCrewTest.snap())).started, true);
    assert.equal(await t.page.locator('#ground-crew').isVisible(), false);
    assert.equal(t.requests.length, 0);
    assert.ok(await t.page.evaluate(() => soraCrewTest.burn()) > 0.5);
    await finish(t, name);
  }
  for (const mode of ['view','fly','trace']) {
    const t = await pageFor('?igc=1');
    await t.page.locator('#igc-pick').setInputFiles(fileURLToPath(new URL(mode === 'fly' ? 'synthetic.zip' : 'synthetic.igc', out)));
    await t.page.locator(`[data-mode="${mode}"]`).click();
    await loaded(t);
    assert.equal((await t.page.evaluate(() => soraCrewTest.snap())).igcViewMode, mode);
    assert.equal((await t.page.evaluate(() => soraCrewTest.snap())).started, mode !== 'view');
    assert.equal(t.requests.length, 0);
    await finish(t, `igc-${mode}`);
  }
  for (const test of [
    { name:'crew-near', x:20,z:0 },
    { name:'crew-watarase', x:20,z:0,area:'139.68,36.22' },
    { name:'crew-far', x:6000,z:0 },
    { name:'crew-pdg', x:1800,z:1500,pdg:true },
    { name:'crew-mobile', x:1000,z:1000,mobile:true },
    { name:'crew-road-failure', x:1000,z:1000,failure:true },
  ]) {
    const t = await pageFor(`?dev=1&a=${test.area || '130.25,33.27'}&road=1`, test); await loaded(t);
    assert.equal(t.requests.length, 0, '道路は離陸後に読む');
    if (test.pdg) {
      await t.page.locator('#pdg-on').check();
      await t.page.evaluate(() => soraCrewTest.addGoal(700,900));
    }
    await t.page.evaluate(({x,z}) => soraCrewTest.selectLaunch(x,z), test);
    await t.page.locator('#launch-btn-dev').click();
    await t.page.waitForFunction(() => !!soraCrewTest.snap().crew, undefined, { timeout: 15000 });
    // 道路待ち中に気球だけ移動させても、車の出発地点がずれないこと。
    await t.page.evaluate(() => { soraCrewTest.stop(); soraCrewTest.moveBalloon(-2000,-1500); });
    await t.page.evaluate(() => soraCrewTest.ready());
    const before = await t.page.evaluate(() => soraCrewTest.snap());
    assert.deepEqual(before.crew.launch, { x:test.x,z:test.z });
    assert.deepEqual(before.crew.goal, test.pdg ? {x:700,z:900} : {x:0,z:0});
    assert.ok(before.url.includes('road=1'));
    if (test.failure) {
      assert.equal(before.crew.white, null); assert.equal(before.crew.blue, null);
      assert.ok(before.crew.stats.tilesFailed > 0);
      assert.ok((await t.page.locator('#crew-status').textContent()).includes('取得できません'));
    } else {
      assert.ok(before.crew.white && before.crew.blue, '実道路に2台を配置');
      for (const c of [before.crew.white,before.crew.blue]) assert.ok(Math.hypot(c.x-test.x,c.z-test.z)<=2500);
      assert.ok(before.crew.blue.goalDistM >= 100);
      const bounds = await t.page.evaluate(() => soraCrewTest.bounds());
      // 近距離開始を含め、30分間の全ステップで立入禁止域・DEM境界を確認。
      const result = await t.page.evaluate((b) => {
        let minGoal=Infinity, inside=true, finite=true;
        for(let t=0;t<1800;t+=.2) {
          const s=soraCrewTest.simulation(.2);
          minGoal=Math.min(minGoal,s.blue.goalDistM);
          for(const c of [s.white,s.blue]) {
            finite &&= Number.isFinite(c.x+c.z+c.y);
            inside &&= c.x>=b.minX&&c.x<=b.maxX&&c.z>=b.minZ&&c.z<=b.maxZ;
          }
        }
        return {minGoal,inside,finite};
      }, bounds);
      assert.ok(result.minGoal >= 99.99); assert.ok(result.inside && result.finite);
      await t.page.locator('#ground-crew summary').click();
      await t.page.locator('#crew-query').click();
      const report = await t.page.locator('#crew-white').textContent();
      const w = await t.page.evaluate(() => {const c=soraCrewTest.snap().crew.white;return soraCrewTest.wind(c.x,c.z)});
      assert.ok(report.includes(`${w.kt.toFixed(1)}ノット`));
      assert.ok((await t.page.locator('#crew-blue').textContent()).includes(test.pdg?'宣言目標':'ターゲット'));
      await t.page.keyboard.press('c');
      assert.equal(await t.page.locator('#ground-crew').evaluate(el=>el.open),false);
      await t.page.keyboard.press('c');
      assert.equal(await t.page.locator('#ground-crew').evaluate(el=>el.open),true);
      if (test.name==='crew-near') {
        const invalid = await t.page.evaluate(async () => {
          const {createChaseCar}=await import('./chasecar.js');
          function trial(world,goal,bounds) {
            const a={x:world[0],z:world[1],edgeKeys:['e']},b={x:world.at(-2),z:world.at(-1),edgeKeys:['e']};
            const edge={key:'e',a:'a',b:'b',world,lengthM:1000,props:{rnkWidth:1}};
            return createChaseCar({graph:{nodes:new Map([['a',a],['b',b]]),edges:new Map([['e',edge]])},
              getHeight:()=>0,startX:world[0],startZ:world[1],goal,bounds})===null;
          }
          return [trial([-200,0,200,0],{x:0,z:0,standoffM:100}),
            trial([-250,0,0,600,250,0],null,{minX:-700,maxX:700,minZ:-700,maxZ:700}),
            trial([0,0,20,0],{x:0,z:0,standoffM:100})];
        });
        assert.deepEqual(invalid,[true,true,true],'禁止域を横切る辺・DEM外へ曲がる辺・禁止域内の初期配置');
      }
      await t.page.evaluate(()=>soraCrewTest.render());
      await t.page.screenshot({ path: new URL(`${test.name}.png`,out).pathname.replace(/^\/(\w:)/,'$1') });
      if (test.mobile) {
        for (const size of [{width:390,height:844},{width:844,height:390}]) {
          await t.page.setViewportSize(size);
          await t.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{soraCrewTest.render();resolve()})));
          const box = await t.page.locator('#ground-crew').boundingBox();
          assert.ok(box.x>=0 && box.y>=0 && box.x+box.width<=size.width+1 && box.y+box.height<=size.height+1);
          for(const id of ['touch-controls','compass','help']) {
            const r=await t.page.locator('#'+id).boundingBox();
            if(r) assert.ok(box.x+box.width<=r.x||r.x+r.width<=box.x||box.y+box.height<=r.y||r.y+r.height<=box.y,`${id}との重なり`);
          }
          await t.page.screenshot({ path: new URL(`mobile-${size.width}.png`,out).pathname.replace(/^\/(\w:)/,'$1') });
        }
      }
    }
    await finish(t, test.name);
  }
} finally {
  await writeFile(new URL('results.json',out),JSON.stringify(reports,null,2));
  await browser.close();
}
