'use strict';

/**
 * 真实浏览器双端联机验证。
 *
 * 用无头 Edge 开两个独立标签页，一个建房、一个加入，让它们真的对打，
 * 然后从两边读状态核对。协议自测只能证明服务端逻辑对，
 * 证明不了「浏览器里真的能连上、能互相看见」。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 无头浏览器可执行文件。★ **顺序有意义**：Edge 排最前 —— 本机一直用 Edge，
//   换顺序等于让所有渲染类断言改成对着另一个浏览器跑。Chrome / Chromium 只是**兜底**，
//   让拿到这份代码的人在没装 Edge 的机器（或 macOS / Linux）上也能跑起来。
//   要强制指定就设 PROBE_BROWSER=<可执行文件的绝对路径>。
const EDGE_CANDIDATES = [
  process.env.PROBE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);   // ★ filter 不能省：PROBE_BROWSER 没设时它是 undefined，
                     //   fs.existsSync(undefined) 会直接抛 TypeError。

const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9333;
const SITE = process.env.PROBE_SITE || 'http://127.0.0.1:3100';
// 探针的临时目录（无头浏览器的 profile 都落这里）。
// ★ 原来是**硬编码** 'F:\WorkBuddyData\wbtemp' —— 换台机器没这个目录就直接 mkdir 失败，
//   接手的人第一步就卡住。现在：PROBE_TMP 优先 → 本机那个 F 盘目录（本机 C 盘紧张，
//   profile 不能落系统 Temp）→ 系统临时目录。
const TMP_DIR = process.env.PROBE_TMP || (
  fs.existsSync('F:\\WorkBuddyData\\wbtemp')
    ? 'F:\\WorkBuddyData\\wbtemp'
    : path.join(require('os').tmpdir(), 'pong-probe')
);
const SHOT_DIR = path.join(__dirname, 'shots');
const PROFILE = path.join(TMP_DIR, 'edgeprobe_' + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}

// ---------- CDP 会话 ----------
function connectTarget(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const sess = {
      ws,
      seq: 0,
      pending: new Map(),
      handlers: Object.create(null),
      errors: [],
    };

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && sess.pending.has(msg.id)) {
        const p = sess.pending.get(msg.id);
        sess.pending.delete(msg.id);
        if (msg.error) p.reject(new Error('CDP: ' + JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method && sess.handlers[msg.method]) {
        sess.handlers[msg.method].forEach((fn) => fn(msg.params));
      }
    });

    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));

    ws.addEventListener('open', () => {
      sess.send = (method, params) => new Promise((res, rej) => {
        const id = ++sess.seq;
        sess.pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        setTimeout(() => {
          if (sess.pending.has(id)) {
            sess.pending.delete(id);
            rej(new Error('CDP 超时: ' + method));
          }
        }, 20000);
      });
      sess.on = (m, fn) => { (sess.handlers[m] = sess.handlers[m] || []).push(fn); };
      resolve(sess);
    });
  });
}

// ★ send 返回的是 result 本体，但 Runtime.evaluate 的 result 自己还包一层
async function evalx(sess, expr) {
  const r = await sess.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面内表达式抛出异常: '
      + ((d.exception && d.exception.description) || d.text)
      + '\n  表达式: ' + expr.slice(0, 180));
  }
  return r.result ? r.result.value : undefined;
}

async function newTab() {
  const res = await fetch(`http://127.0.0.1:${DBG_PORT}/json/new?about:blank`, { method: 'PUT' });
  return res.json();
}

/**
 * 画布记录补丁：把页面**真正画上去**的字符串记下来。
 *
 * 为什么需要它：「暂停时球场上写着"已暂停"」这句话只说内部状态是证明不了的 ——
 * 那等于拿输入断言输入。patch 一层 fillText，就能直接断言"这个字符串被画过"，
 * 而且**恢复之后它必须不再出现**（否则就是遮罩撤不掉）。
 *
 * ★ 必须赶在页面脚本之前注入，所以走 Page.addScriptToEvaluateOnNewDocument。
 * ★ 同时记一个总次数 seenN：后台标签页的 rAF 会被节流，若不加这条元检查，
 *   "没抓到'已暂停'"既可能是"没画"、也可能是"根本没渲染"，两者分不开。
 */
const TEXT_PATCH = `(() => {
  window.__seen = {};
  window.__seenN = 0;
  const proto = CanvasRenderingContext2D.prototype;
  const orig = proto.fillText;
  proto.fillText = function (s) {
    window.__seenN += 1;
    if (typeof s === 'string') window.__seen[s] = (window.__seen[s] || 0) + 1;
    return orig.apply(this, arguments);
  };
})()`;

const RESET_SEEN = 'window.__seen = {}; window.__seenN = 0;';

async function openPage(url, patch) {
  const tab = await newTab();
  const sess = await connectTarget(tab.webSocketDebuggerUrl);

  sess.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    sess.errors.push('[异常] ' + ((d.exception && d.exception.description) || d.text || 'unknown'));
  });
  sess.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level === 'error') sess.errors.push('[日志] ' + (e.text || ''));
  });
  sess.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'assert') return;
    const txt = (p.args || []).map((a) => {
      if (a.value !== undefined) return JSON.stringify(a.value);
      if (a.description) return a.description;
      if (a.preview) return JSON.stringify(a.preview.properties || a.preview);
      return a.type;
    }).join(' | ');
    sess.errors.push('[控制台] ' + txt);
  });
  sess.on('Network.loadingFailed', (p) => {
    if (p.blockedReason) return;
    sess.errors.push('[网络] ' + (p.errorText || '') + ' ' + (p.type || ''));
  });

  await sess.send('Page.enable');
  await sess.send('Runtime.enable');
  await sess.send('Log.enable');
  await sess.send('Network.enable');
  await sess.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 820, deviceScaleFactor: 1, mobile: false,
  });

  if (patch) await sess.send('Page.addScriptToEvaluateOnNewDocument', { source: patch });
  await sess.send('Page.navigate', { url });
  return sess;
}

async function waitReady(sess, label, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const t = await evalx(sess, 'typeof window.__probe');
      if (t === 'function') return true;
    } catch (e) { /* 导航中，继续等 */ }
    await sleep(150);
  }
  console.log(`  ! ${label} 页面没有就绪`);
  return false;
}

async function waitFor(sess, expr, timeoutMs = 12000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v;
    try { v = await evalx(sess, expr); } catch (e) { v = undefined; }
    if (v) return v;
    await sleep(120);
  }
  console.log(`  ! 等待超时: ${label || expr}`);
  return null;
}

const probe = (sess) => evalx(sess, 'window.__probe()');

async function key(sess, type, k, vk) {
  await sess.send('Input.dispatchKeyEvent', {
    type,
    key: k,
    code: k,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  });
}

async function shot(sess, name) {
  const r = await sess.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) {
    console.log('找不到 Edge 可执行文件');
    process.exit(1);
  }
  console.log(`浏览器: ${edge}`);
  console.log(`页面:   ${SITE}\n`);

  const child = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-swiftshader',
    // ★ 防后台节流三件套。`--headless=new` 下后台标签的 visibilityState 是 'hidden'，
    //   rAF 会被暂停/降到 1Hz —— 于是"画布上画了没画"这类断言会在**同一个页面、
    //   同一份代码**上时而通过时而失败（实测遇到过，`Page.bringToFront` 有时赶不及）。
    //   这几个开关让每个标签页都持续渲染，断言才与"谁在前台"无关。
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=OverscrollHistoryNavigation',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    'about:blank',
  ], {
    env: { ...process.env, TEMP: TMP_DIR, TMP: TMP_DIR },
    stdio: 'ignore',
    detached: false,
  });

  let A = null;
  let B = null;

  try {
    // 等调试端口就绪
    let ok = false;
    for (let i = 0; i < 100; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/version`);
        if (r.ok) { ok = true; break; }
      } catch (e) { /* not yet */ }
      await sleep(200);
    }
    if (!ok) {
      console.log('调试端口没起来');
      process.exit(1);
    }

    console.log('1) 打开第一个页面（建房方）');
    A = await openPage(SITE, TEXT_PATCH);
    const ready = await waitReady(A, 'A');
    check('页面加载并完成脚本初始化', ready);
    if (!ready) throw new Error('页面未就绪，后续无法继续');

    // 量具自检：先证明 eval 通道是活的，否则后面读到 undefined 会误导方向
    const sanity = await evalx(A, '1+1');
    check('取值通道正常（1+1=2）', sanity === 2, `得到 ${sanity}`);

    const pa0 = await probe(A);
    check('初始状态为未连接或未入房', pa0.mySide === -1, JSON.stringify(pa0));
    await sleep(1500);

    const pa1 = await probe(A);
    check('WebSocket 握手成功', pa1.connected === true, JSON.stringify(pa1));
    check('菜单已显示（overlay 未隐藏）', pa1.overlayHidden === false);

    console.log('\n2) 建房方创建房间');
    await evalx(A, "document.querySelector('#overlayBody .primary').click()");
    const code = await waitFor(A, "window.__probe().code || ''", 8000, '房间码');
    check('拿到 6 位房间码', !!code && /^[A-Z0-9]{6}$/.test(code), String(code));

    await waitFor(A, 'window.__probe().overlayHidden === false', 3000, '等待界面');
    const pa2 = await probe(A);
    check('建房方分到左边（side 0）', pa2.mySide === 0, `mySide=${pa2.mySide}`);

    console.log(`\n3) 用邀请链接打开第二个页面（房间 ${code}）`);
    B = await openPage(`${SITE}/?room=${code}`);
    const readyB = await waitReady(B, 'B');
    check('第二页加载完成', readyB);

    // ★ 邀请链接**不再自动入房**：它只把房间码预填进菜单，剩下的走正常流程（选拍子 → 点「加入」）。
    //   为什么要改：自动加入的人永远没机会选皮肤，而皮肤就是技能 —— 等于从链接进来的
    //   那一半玩家用不了这一轮新加的功能。这一段顺带把这条设计本身变成可断言的行为。
    const prefilled = await waitFor(B,
      "(document.querySelector('#overlayBody .joinrow input') || {}).value || ''",
      8000, '菜单预填房间码');
    check('★ 邀请链接把房间码预填进菜单（而不是直接把人塞进房间）',
      prefilled === code, `预填「${prefilled}」vs 房间码「${code}」`);
    const pMenu = await probe(B);
    check('★ 而且此刻确实还没入房 —— 证明没有"打开链接就自动进"这条老路径',
      pMenu.mySide === -1, `mySide=${pMenu.mySide}`);
    check('★ 预填的人照样有机会选拍子（还没入房，所以还没有皮肤）',
      pMenu.mySkin === -1, `mySkin=${pMenu.mySkin}`);

    const skinSwatches = await evalx(B,
      "document.querySelectorAll('#overlayBody .skinrow .swatch').length");
    check('菜单里皮肤选项齐全（灰 / 青 / 黄 / 红 四块）', skinSwatches === 4,
      `实际 ${skinSwatches} 块`);
    await evalx(B, "document.querySelectorAll('#overlayBody .skinrow .swatch')[1].click()");
    await evalx(B, "document.querySelector('#overlayBody .joinrow button').click()");

    // 注意：这里的等待条件必须返回真正的布尔值。
    // 写成三元 `mySide >= 0 ? mySide : 0` 会恒返回 0（falsy），永远等不到。
    const joined = await waitFor(B, 'window.__probe().mySide >= 0', 10000, 'B 入房');
    check('第二页选完拍子点「加入」后成功进房', joined === true);
    if (joined !== true) throw new Error('B 没能加入房间');

    const pb1 = await probe(B);
    check('加入方分到右边（side 1）', pb1.mySide === 1, `mySide=${pb1.mySide}`);
    check('加入方看得到同一个房间码', pb1.code === code, `${pb1.code} vs ${code}`);
    // ★ 要验的是皮肤**真的到了服务端又发回来**，不是"本地变量改了"。
    //   所以必须等它出现在服务端下发的 skins 里：`joined` 消息先到、带 skins 的 state
    //   快照后到，刚入房那一瞬间读到的还是 [0,0] —— 那是"还没收到"，不是"没生效"。
    //   （第一版就是在这里读早了，红了却以为皮肤没传上去。）
    const skinApplied = await waitFor(B, 'window.__probe().skins[1] === 1', 5000, '皮肤下发');
    const pb2 = await probe(B);
    check('★ 加入方选的皮肤真的生效（服务端下发回 skins[1] = 1 青）',
      skinApplied === true && pb2.mySkin === 1 && pb2.skins[1] === 1,
      `mySkin=${pb2.mySkin} skins=${JSON.stringify(pb2.skins)}`);

    // 两边都读到对端在线
    await sleep(1200);
    const pair = await Promise.all([probe(A), probe(B)]);
    check('建房方看到双方都在线', pair[0].present[0] === 1 && pair[0].present[1] === 1,
      JSON.stringify(pair[0].present));
    check('加入方看到双方都在线', pair[1].present[0] === 1 && pair[1].present[1] === 1,
      JSON.stringify(pair[1].present));
    check('游戏开始时遮罩已隐藏（能看到场地）',
      pair[0].overlayHidden === true && pair[1].overlayHidden === true);
    // ★ 两边对"谁是什么皮肤"必须一致 —— 客户端的拍子上色、技能按钮样式全靠它。
    //   建房方没选过 = 灰（0）；加入方选了青 = 1。
    check('★ 双方看到的皮肤表一致，且建房方是默认的灰（0 = 没有技能）',
      JSON.stringify(pair[0].skins) === JSON.stringify(pair[1].skins)
      && JSON.stringify(pair[0].skins) === '[0,1]',
      `A=${JSON.stringify(pair[0].skins)} B=${JSON.stringify(pair[1].skins)}`);
    // ★ 拍子上色：B 的拍子必须按皮肤色画 —— 这是"颜色 = 技能"这条约定的视觉落点。
    //   比的是**画出来**的颜色（paddleSkin），不是"按皮肤推出来的"。
    check('★ 加了皮肤之后拍子真的换了填充色（B 的拍子 = 青色）',
      pair[1].paddleSkin[1] === pair[1].skinColors[1]
      && pair[1].paddleSkin[1] !== pair[1].paddleSkin[0],
      `B 的球拍色 ${pair[1].paddleSkin[1]} / A 的 ${pair[1].paddleSkin[0]}`
      + ` / 青色 ${pair[1].skinColors[1]}`);
    // ★ 技能按钮：B 选了青就该有一个「风」按钮，A 是灰就不该有。
    //   这条验的是"按钮真的在页面上显示出来了"，不是"逻辑上应该显示"。
    check('★ 只有选了技能的玩家才有技能按钮（B 有、A 没有）',
      pair[1].skillBtns[1].shown === true && pair[1].skillBtns[0].shown === false,
      `B.skillBtns[1]=${JSON.stringify(pair[1].skillBtns[1])}`
      + ` A.skillBtns[0].shown=${pair[0].skillBtns[0].shown}`);

    // canvas 真的分配了缓冲区 —— 排除"页面在但画布是空的"
    check('画布已按设备像素比分配', pair[0].canvasSize[0] > 0 && pair[0].canvasSize[1] > 0,
      JSON.stringify(pair[0].canvasSize));

    console.log('\n4) 观察 8 秒，看状态推送是否稳定');
    const s0 = await probe(A);
    const b0 = await probe(B);
    await sleep(8000);
    const s1 = await probe(A);
    const b1 = await probe(B);

    const hzA = (s1.snaps - s0.snaps) / 8;
    const hzB = (b1.snaps - b0.snaps) / 8;
    check('建房方持续收到快照', hzA > 24 && hzA < 36, `实测 ${hzA.toFixed(1)} 次/秒`);
    check('加入方持续收到快照', hzB > 24 && hzB < 36, `实测 ${hzB.toFixed(1)} 次/秒`);
    check('两端都没有掉线', s1.drops === 0 && b1.drops === 0,
      `A=${s1.drops} B=${b1.drops}`);
    check('服务端推进频率正常', s1.tickRate > 27 && s1.tickRate < 33,
      `${s1.tickRate} 次/秒`);
    check('两端都处在比赛阶段', s1.phase !== 'waiting',
      `A=${s1.phase} B=${s1.phase}`);
    // ★ 上限不是 800，而是 800 + 球半径 —— 球出界的判据是"**整个球**越过边线"
    //   （服务端写的是 x - R > W），所以 x 落在 (800, 809] 这段"已经越过边线、
    //   但还没被移除"的状态是合法的，会稳定存在几个子步。原来那条 ≤800 的断言
    //   在一次抽样里正好撞上就报假红（实测遇到过一次 x=804）。
    check('球在场内活动（允许越出边线一个球半径，那是出界判定的窗口）',
      s1.ball[0] >= -12 && s1.ball[0] <= 812 && s1.ball[1] >= -12 && s1.ball[1] <= 512,
      JSON.stringify(s1.ball));

    console.log('\n5) 真按键：B 按上，看 A 那边能不能看见');
    const beforeA = await probe(A);
    const beforeB = await probe(B);

    await key(B, 'rawKeyDown', 'ArrowUp', 38);
    await sleep(700);
    await key(B, 'keyUp', 'ArrowUp', 38);
    await sleep(500);

    const afterA = await probe(A);
    const afterB = await probe(B);

    check('B 自己的拍子确实动了',
      Math.abs(afterB.paddle[1] - beforeB.paddle[1]) > 20,
      `${beforeB.paddle[1]} -> ${afterB.paddle[1]}`);
    check('★ A 那边看到了 B 的移动（跨端可见）',
      Math.abs(afterA.paddle[1] - beforeA.paddle[1]) > 20,
      `${beforeA.paddle[1]} -> ${afterA.paddle[1]}`);

    // 反方向
    await key(B, 'rawKeyDown', 'ArrowDown', 40);
    await sleep(900);
    await key(B, 'keyUp', 'ArrowDown', 40);
    await sleep(500);
    const backB = await probe(B);
    check('松开方向键后能反向移动', backB.paddle[1] > afterB.paddle[1] + 20,
      `${afterB.paddle[1]} -> ${backB.paddle[1]}`);

    console.log('\n5b) 暂停：两个人各按一次都要生效');
    // ★ rAF 在后台标签页会被节流。要断言"画布上真的画了这几个字"，必须先把 A 提到前台，
    //   否则抓不到字这件事既可能是"没画"、也可能是"根本没在渲染"（两者必须分得开）。
    try { await A.send('Page.bringToFront'); } catch (e) { /* 不支持也无所谓 */ }
    await sleep(400);

    await evalx(A, RESET_SEEN);
    await sleep(700);
    const idleDraws = await evalx(A, 'window.__seenN');
    check('A 的渲染循环确实在跑（否则下面"画了没有"的断言就是空转）',
      idleDraws > 30, `700ms 内画了 ${idleDraws} 次文字`);
    check('没暂停时画布上不会出现「已暂停」',
      !(await evalx(A, 'window.__seen["已暂停"] || 0')));

    // ★ 先证明这把"量具"是活的："A 按住方向键 → A 自己的 paddleDisp 会变"。
    //   少了这一步，下面那句「暂停期间按方向键 paddleDisp 不变」有可能是**恒真**的
    //   （比如 A 的拍子正好顶在活动范围的边界上，或者 A 根本不是在前台渲染的那一页）。
    const liveP0 = (await probe(A)).paddleDisp[0];
    await key(A, 'rawKeyDown', 'ArrowUp', 38);
    await sleep(400);
    await key(A, 'keyUp', 'ArrowUp', 38);
    await sleep(150);
    const liveP1 = (await probe(A)).paddleDisp[0];
    check('★ 量具检查：没暂停时 A 按方向键自己的拍子确实会动（下面那条才不是空断言）',
      liveP0 !== liveP1, `${liveP0} -> ${liveP1}`);

    const btn = await evalx(A, `(() => {
      const m = (id) => {
        const b = document.getElementById(id);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return { text: b.textContent, shown: b.style.display !== 'none',
                 w: Math.round(r.width), h: Math.round(r.height),
                 style: [cs.fontSize, cs.padding, cs.borderWidth, cs.borderRadius,
                   cs.lineHeight, cs.verticalAlign].join('|') };
      };
      return { pause: m('pauseBtn'), sfx: m('sfxBtn') };
    })()`);
    check('★ 对局中出现了暂停按钮（菜单态是隐藏的，所以电脑端基线未被它影响）',
      !!btn.pause && btn.pause.shown && btn.pause.text === '暂停', JSON.stringify(btn.pause));
    // ★ 这里**不**断言 32×32：那是手机端触控目标的规矩（由 probe-mobile 管）。
    //   桌面上 27px 高的按钮本来就是常态。
    // ★ 也**不**比宽度：两个按钮里写的字不一样（"暂停"两个字 vs 一个 emoji），
    //   宽度天然不同，比宽度只会得到一条注定要红的假要求。
    //   真正该断言的是"它复用了同一套样式规则" —— 高度、字号、内边距、圆角、边框全一致。
    check('暂停按钮复用了声音按钮那套样式（高度/字号/内边距/圆角/边框一致）',
      !!btn.pause && !!btn.sfx && btn.pause.h === btn.sfx.h
        && btn.pause.style === btn.sfx.style,
      `暂停 ${btn.pause && btn.pause.h}px [${btn.pause && btn.pause.style}]`
      + ` vs 声音 ${btn.sfx && btn.sfx.h}px [${btn.sfx && btn.sfx.style}]`);

    // ---- 左边那个人点暂停 ----
    await evalx(A, RESET_SEEN);
    await evalx(A, "document.getElementById('pauseBtn').click()");
    await sleep(800);
    const qa = await probe(A);
    const qb = await probe(B);
    check('★ 左边按下后自己这边进入暂停', qa.userPaused === true, String(qa.userPaused));
    check('★ 右边也一起暂停（暂停是房间级的，不是本地效果）', qb.userPaused === true,
      String(qb.userPaused));
    check('★ 两边的按钮都变成「继续」',
      qa.pauseBtnText === '继续' && qb.pauseBtnText === '继续',
      `${qa.pauseBtnText} / ${qb.pauseBtnText}`);
    check('★ 两边都知道是谁按的（都指向左边那个座位）',
      qa.pausedBy === qa.mySide && qb.pausedBy === qa.mySide,
      `A.pb=${qa.pausedBy} B.pb=${qb.pausedBy} A.side=${qa.mySide}`);
    const seenA = await evalx(A, 'window.__seen');
    check('★ 画布上真的画出了「已暂停」（不是只改了内部状态）',
      (seenA['已暂停'] || 0) > 0, JSON.stringify(Object.keys(seenA).slice(0, 14)));
    check('★ 按的人看到的是「你按下的暂停」', (seenA['你按下的暂停'] || 0) > 0);
    check('★ 并且写明了怎么恢复（否则玩家只会以为卡住了）',
      (seenA['任意一方点「继续」即可恢复'] || 0) > 0);
    await shot(A, 'a-paused.png');

    // 球真的停住了（看**画出来**的位置，不是服务端真值 —— 后者不动可能只是没收到快照）
    // ★ 第一次采样必须等本地平滑把画面追平：服务端冻住球之后，客户端"画出来的"位置
    //   还要再收几百毫秒才贴住服务端值。采早了会把这段收敛尾巴当成"暂停了球还在动"。
    const fb1 = (await probe(A)).ballDisp;
    const fbN1 = await evalx(A, 'window.__seenN');
    await sleep(1100);
    const fb2 = (await probe(A)).ballDisp;
    const fbN2 = await evalx(A, 'window.__seenN');
    check('★ 暂停期间画出来的球也停住了', fb1[0] === fb2[0] && fb1[1] === fb2[1],
      `${fb1} -> ${fb2}`);
    // ★ 防空洞：如果这一段时间画布压根没重绘（页面停摆/被节流），上面那条恒真。
    check('★ 而这段时间画布一直在重绘（上面那条不是"页面停摆"造成的假绿）',
      fbN2 - fbN1 > 30, `fillText ${fbN1} -> ${fbN2}`);

    // 右边按住方向键：服务器冻结着，拍子不许动
    const pad0 = (await probe(B)).paddle[1];
    await key(B, 'rawKeyDown', 'ArrowUp', 38);
    await sleep(700);
    await key(B, 'keyUp', 'ArrowUp', 38);
    const pad1 = (await probe(B)).paddle[1];
    check('★ 暂停期间另一边按方向键也动不了拍子（冻结在服务端）', pad0 === pad1,
      `${pad0} -> ${pad1}`);

    // ★ 上面那条只证明了"服务端把球和拍子冻住了" —— 对方的拍子在客户端本来就只向
    //   服务端收敛，服务端不动它就动不了，和"暂停"没关系。
    //   真正的缺口是**自己的本地预测**：客户端对自己那块拍子是**不等服务端**的
    //   （`dir !== 0` 时直接以 PADDLE_SPEED*dt 追随）。漏掉这一条，
    //   "暂停时还能把拍子挪走"的实现会一路绿灯 —— 而"能挪拍子"就不算暂停。
    //   所以这里读的是**画出来的**位置 paddleDisp，不是服务端真值 paddle。
    // ★ 两个方向都试，这不是啰嗦：活动范围是**夹取**出来的
    //   （`Math.max(lo, Math.min(hi, ...))`），拍子一旦顶在某一侧的边界上，
    //   朝那一侧按就是**恒真**的"没动"。实测踩过这个坑 ——
    //   上面那句量具检查把 A 的拍子顶到了上边界，于是"暂停中按 ArrowUp 不动"
    //   在**本地预测根本没冻结**的坏实现下照样全绿。两个方向一起测就与位置无关了。
    const selfP0 = (await probe(A)).paddleDisp[qa.mySide];
    await key(A, 'rawKeyDown', 'ArrowUp', 38);
    await sleep(700);
    await key(A, 'keyUp', 'ArrowUp', 38);
    await sleep(100);
    const selfP1 = (await probe(A)).paddleDisp[qa.mySide];
    await key(A, 'rawKeyDown', 'ArrowDown', 40);
    await sleep(1400);
    await key(A, 'keyUp', 'ArrowDown', 40);
    await sleep(100);
    const selfP2 = (await probe(A)).paddleDisp[qa.mySide];
    check('★ 暂停期间自己按方向键也挪不动自己的拍子（本地预测一起冻住了）',
      selfP0 === selfP1 && selfP1 === selfP2,
      `起始${selfP0} →按上${selfP1} →按下${selfP2}`);

    // ---- 右边那个人点恢复 ----
    await evalx(B, "document.getElementById('pauseBtn').click()");
    await sleep(800);
    const ra = await probe(A);
    const rb = await probe(B);
    check('★ 右边按一下就能恢复（不必是"按暂停的那个人"才能恢复）',
      ra.userPaused === false && rb.userPaused === false,
      `${ra.userPaused} / ${rb.userPaused}`);
    check('恢复后两边的按钮都回到「暂停」',
      ra.pauseBtnText === '暂停' && rb.pauseBtnText === '暂停',
      `${ra.pauseBtnText} / ${rb.pauseBtnText}`);
    check('恢复后"是谁按的"清掉了', ra.pausedBy === -1, String(ra.pausedBy));

    await evalx(A, RESET_SEEN);
    await sleep(800);
    check('★ 恢复后画布上不再出现「已暂停」（遮罩真的撤了，不是只改了状态）',
      !(await evalx(A, 'window.__seen["已暂停"] || 0')));
    // ★ 不能只看"隔 900ms 的两个采样点位置是否相同" —— 刚进球那一下球会被重置到
    //   球场正中、并停在倒计时里（实测撞到过 400,250 -> 400,250 的假红）。
    //   这里要测的性质是"恢复之后球会重新动"，所以用有界重试：
    //   4 秒内只要出现过一次位移就算过，超时才判红。
    const fb3 = (await probe(A)).ballDisp;
    let fbMoved = false;
    for (let t = 0; t < 16 && !fbMoved; t += 1) {
      await sleep(250);
      const fbn = (await probe(A)).ballDisp;
      fbMoved = fbn[0] !== fb3[0] || fbn[1] !== fb3[1];
    }
    check('★ 恢复后球重新动起来（4 秒内出现过位移即算过；进球重置会短暂停在中场）',
      fbMoved, `起点 ${fb3}`);

    // ---- 两个人**同一个时刻**各按一下 ----
    // ★ 这是「每个人点都会生效」最容易翻车的一格：两条 pause 消息各自 toggle 一次，
    //   净效果是回到原状。如果客户端在点击瞬间就乐观翻转按钮，两边按钮会一起写成
    //   「继续」，而真值是「没暂停」—— 按钮上的字恰好是反的。
    //   这条断言不靠时序：只要 A、B 两条消息都到了服务端，结果就是"切两次"，
    //   与时序、与是否落在同一 tick 都无关。
    const wasPaused = (await probe(A)).userPaused;
    check('前置：同时点之前确实是「没暂停」（否则下面那条会被"本来就没暂停"蒙对）',
      wasPaused === false, String(wasPaused));
    await Promise.all([
      evalx(A, "document.getElementById('pauseBtn').click()"),
      evalx(B, "document.getElementById('pauseBtn').click()"),
    ]);
    await sleep(900);
    const ja = await probe(A);
    const jb = await probe(B);
    check('★ 两个人同时各点一下 = 切两次 = 回到「没暂停」，且按钮文字跟着服务端走',
      ja.userPaused === false && jb.userPaused === false
        && ja.pauseBtnText === '暂停' && jb.pauseBtnText === '暂停'
        && ja.pausedBy === -1,
      `A ${ja.userPaused}/${ja.pauseBtnText}/${ja.pausedBy}`
      + ` · B ${jb.userPaused}/${jb.pauseBtnText}/${jb.pausedBy}`);

    console.log('\n6) 页面报错检查');
    const errsA = A.errors.filter((e) => e.indexOf('[网络]') !== 0);
    check('建房页没有未捕获异常', errsA.length === 0, errsA.slice(0, 3).join(' ; '));
    const errsB = B.errors.filter((e) => e.indexOf('[网络]') !== 0);
    check('加入页没有未捕获异常', errsB.length === 0, errsB.slice(0, 3).join(' ; '));

    console.log('\n7) 截图');
    await shot(A, 'a-host.png');
    await shot(B, 'b-guest.png');
    const sa = fs.statSync(path.join(SHOT_DIR, 'a-host.png')).size;
    const sb = fs.statSync(path.join(SHOT_DIR, 'b-guest.png')).size;
    check('两张截图都非空', sa > 3000 && sb > 3000, `A=${sa}B B=${sb}B`);

    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  } catch (e) {
    console.log('\n探针中断: ' + e.message + '\n');
    fail += 1;
  } finally {
    try { if (A) A.ws.close(); } catch (e) {}
    try { if (B) B.ws.close(); } catch (e) {}
    await sleep(300);
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch (e) {}
    await sleep(800);
    console.log(`（浏览器进程已清理，profile: ${PROFILE}）`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

main();
