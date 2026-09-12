// 无头 Edge + CDP 截图验证：自动点过标题/觉醒界面，把人物传送到各城市地标，
// 逐张截图输出到 tools/shots/。不依赖 playwright/puppeteer（Node 24 自带 WebSocket）。
//
// 用法: node tools/shot.cjs
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;
const URL = 'http://localhost:8080/index.html';
const OUT = path.join(__dirname, 'shots');
const T = 32;

// name, 人物站立的世界格坐标（站在地标南侧，能看到建筑正面和遮挡关系）
const SHOTS = [
  ['village-huts',   270, 154],
  ['village-temple', 270, 146],
  ['nuoding-temple', 407, 228],
  ['shrek-main',     575, 297],
  ['suoto-arena',    505, 440],
  ['wuhun-sanctum',  780, 626],
  ['xingluo-palace', 795, 825],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function waitFor(ms, fn) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error('waitFor timeout: ' + (last && last.message ? last.message : last));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-shot-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1600,1000', '--no-first-run', '--no-default-browser-check',
    URL,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    // 等 devtools 起来
    const ver = await waitFor(20000, async () => {
      try { return await get('/json/version'); } catch { return null; }
    });
    // 找到游戏页面 target
    const targets = await waitFor(10000, async () => {
      const ts = await get('/json/list');
      return ts.find(t => t.type === 'page' && t.url.includes('localhost:8080')) ? ts : null;
    });
    const target = targets.find(t => t.type === 'page' && t.url.includes('localhost:8080'));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evalJs = async expr => {
      const r = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');

    // 1) 等全部建筑贴图抠白完成（false = 404 也算就绪，走兜底）
    const readyPred = `(function(){
      if (typeof Render === 'undefined' || !Render.spritesReady || !Render.spritesReady()) return false;
      return Render.BUILDING_LIST.every(n => Render.sprites['b-'+n] != null);
    })()`;
    let ready = false;
    try {
      ready = await waitFor(45000, () => evalJs(readyPred));
    } catch {
      console.log('READY DIAG:', await evalJs(`(function(){
        if (typeof Render === 'undefined') return 'no Render';
        const base = Render.SPRITE_LIST.filter(n => {
          const s = Render.sprites[n];
          return !s || !s.complete || !s.naturalWidth;
        });
        const blds = Render.BUILDING_LIST.filter(n => Render.sprites['b-'+n] == null);
        return JSON.stringify({ baseReady: Render.spritesReady(), basePending: base, bldPending: blds });
      })()`).catch(e => 'diag failed: ' + e.message));
      throw new Error('sprites never ready');
    }
    console.log('sprites ready');

    // 2) 点过标题 → 觉醒（蓝银草）
    await evalJs(`document.getElementById('start-btn').click()`);
    await sleep(400);
    await evalJs(`document.querySelector('.soul-card[data-soul="grass"]').click()`);
    await sleep(600);

    // 3) 逐点传送 + 截图（snapCamera 立即跳镜头，不等缓动）
    for (const [name, tx, ty] of SHOTS) {
      await evalJs(`(function(){
        Player.x = ${(tx + 0.5) * T}; Player.y = ${(ty + 0.5) * T};
        Render.snapCamera();
      })()`);
      await sleep(1300);   // 等大城布局生成 + chunk 烘焙 + 贴图绘制
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
      console.log('shot', name);
    }

    ws.close();
    console.log('DONE ->', OUT);
  } finally {
    edge.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
