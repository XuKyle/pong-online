'use strict';

/**
 * 跨端互通验证：一端当电脑、一端当手机，进同一个房间真打。
 *
 * 为什么需要这个探针：
 * "手机能不能和电脑一起玩"这件事，只看代码里没有 UA/平台分支是**推理**，
 * 不是证据。而且更隐蔽的一种失败是：两端其实都跑在同一套布局上 ——
 * 那样的"互通成功"什么都没证明。
 *
 * 所以本探针做两件事：
 *   1. 先证明两端**真的处于不同形态**（电脑端有链路面板、手机端没有延迟胶囊，
 *      互相必须看不见对方专属的元素）。若这一条不成立，后面的互通结论作废。
 *   2. 再证明它们能进同一个房间、互相看见、各自的输入方式都能驱动对端看到变化
 *      （手机用真触摸事件、电脑用真键盘事件）。
 *
 * ★ 实测结论（别再用错判据）：无头 Edge 的 `navigator.maxTouchPoints` **默认就是 10**，
 *   拿它判"是不是触摸设备"恒为真、等于没判。真正能区分的是 `'ontouchstart' in window`
 *   —— 没开 Emulation.setTouchEmulationEnabled 时 false，开了才 true。
 *   另一条能区分的：`matchMedia('(pointer: coarse)')`，与它同步。
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

const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9355;
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
const PROFILE = path.join(TMP_DIR, 'edgecross_' + Date.now());

// 手机横屏一档真实尺寸（iPhone 12/13 横过来）
const MOBILE = { w: 844, h: 390, dsf: 3, ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' };
const DESKTOP = { w: 1280, h: 820, dsf: 1, ua: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
function note(msg) { console.log(`  · ${msg}`); }

// ---------- CDP ----------
function connectTarget(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const sess = { ws, seq: 0, pending: new Map(), handlers: Object.create(null), errors: [] };

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

async function evalx(sess, expr) {
  const r = await sess.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
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

/** dev = DESKTOP 或 MOBILE：决定这一端真的是电脑还是手机 */
async function openPage(url, dev, patch) {
  const tab = await newTab();
  const sess = await connectTarget(tab.webSocketDebuggerUrl);
  sess.device = dev;

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
    width: dev.w, height: dev.h, deviceScaleFactor: dev.dsf, mobile: dev.dsf > 1,
  });
  if (dev.dsf > 1) {
    // 真的把它当触屏设备：不开这个，dispatchTouchEvent 会被忽略
    await sess.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  if (dev.ua) await sess.send('Emulation.setUserAgentOverride', { userAgent: dev.ua });

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
    } catch (e) { /* 导航中 */ }
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
    type, key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}

// 手指在屏幕上滑动：分多步移动，才像真实手指（一步到位会被当成瞬移）
async function touchDrag(sess, x, yFrom, yTo, steps = 8) {
  const pt = (y) => [{ x: Math.round(x), y: Math.round(y) }];
  await sess.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(yFrom) });
  for (let i = 1; i <= steps; i += 1) {
    const y = yFrom + (yTo - yFrom) * (i / steps);
    await sess.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y) });
    await sleep(35);
  }
  await sess.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function shot(sess, name) {
  const r = await sess.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
}

/** 真实触摸点一下（手指不移动）。用来验证"手指点按钮"这条路真的通 */
async function touchTap(sess, x, y) {
  const pt = [{ x: Math.round(x), y: Math.round(y) }];
  await sess.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(70);
  await sess.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** 真实鼠标点击（按下 + 抬起） */
async function mouseClick(sess, x, y) {
  await sess.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await sleep(40);
  await sess.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}

/**
 * 点菜单里的某个元素（按端选输入方式：手机走真触摸、电脑走真鼠标）。
 *
 * expr 是一段求值出元素的表达式，比如
 * `document.querySelectorAll('#overlayBody .skinrow .swatch')[1]`。
 *
 * ★ 先 `scrollIntoView({block:'center'})` 再取坐标，不能省：
 *   手机横屏只有 390px 高，而菜单在手机上是一块**可滚动的整屏抽屉**，
 *   元素很可能落在折叠线以下。拿屏幕坐标去点一个视口外的位置，事件会落到别处，
 *   而失败信息会误导成"皮肤选不上/按钮点不动"。
 *   顺带把视口高宽一起报出来，便于一眼看出"这次点击到底有没有落在屏幕里"。
 */
async function clickEl(sess, mobile, expr) {
  const box = await evalx(sess, `(() => {
    const el = ${expr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2,
             w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight,
             text: el.textContent };
  })()`);
  if (!box) return null;
  if (mobile) await touchTap(sess, box.x, box.y);
  else await mouseClick(sess, box.x, box.y);
  return box;
}

/** 点第 idx 块皮肤色块（0 灰 / 1 青 / 2 黄 / 3 红） */
const clickSwatch = (sess, mobile, idx) => clickEl(
  sess, mobile, `document.querySelectorAll('#overlayBody .skinrow .swatch')[${idx}]`);

/**
 * 画布记录补丁：把页面**真正画上去**的字符串记下来。
 * 「暂停时球场上写着"对手按下的暂停"」这种话只说内部状态是证明不了的 ——
 * 那等于拿输入断言输入。patch 一层 fillText 才能直接断言"这个字符串被画过"。
 * ★ 必须赶在页面脚本之前注入，所以走 Page.addScriptToEvaluateOnNewDocument。
 * ★ 后台标签页的 rAF 会被节流，所以本文件在采样前会把该端 bringToFront，
 *   并且**先断言"暂停前球在动"**再断言"暂停后球不动" —— 否则一条恒真的假绿。
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

/** 读两端"形态"证据：各自独有的元素在对方那边必须是隐藏的 */
const SHAPE = `(() => {
  const g = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const hit = (() => {
      if (cs.display === 'none' || cs.visibility === 'hidden' || b.width < 1 || b.height < 1) return false;
      // ★ elementFromPoint **会跳过 pointer-events:none 的元素**，而本页的只读徽章
      //   （状态徽章 / 延迟胶囊）正处在横屏块 header .hright 的 pe:none 之下。
      //   直接问会落到下面那一层（实测拿到的是 .overlay），得到"没命中"——
      //   可胶囊其实好好画在最上面，这是一条**恒假的假红**（实测 armedHit 命中它自己）。
      //   做法：只在这一次探测期间把它放行，问完立刻还原，页面的持久状态一点不动。
      //   这样量到的才是真问题：**如果它能被点，这点上最上面的是不是它**。
      const saved = el.style.pointerEvents;
      el.style.pointerEvents = 'auto';
      const e = document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
      el.style.pointerEvents = saved;
      return !!(e && (e === el || el.contains(e)));
    })();
    return { display: cs.display, w: Math.round(b.width), h: Math.round(b.height), hit: hit };
  };
  return {
    w: window.innerWidth, h: window.innerHeight,
    // ★ 用 'ontouchstart' 而不是 maxTouchPoints：后者在无头 Edge 上默认 10，恒为真
    touch: 'ontouchstart' in window,
    maxTouchPoints: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches,
    meters: g('.meters'), ping: g('.ping'), tip: g('.tip'),
    uaMobile: /Mobi|Android|iPhone/i.test(navigator.userAgent),
  };
})()`;

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('找不到 Edge 可执行文件'); process.exit(1); }
  console.log(`浏览器: ${edge}`);
  console.log(`页面:   ${SITE}`);
  console.log(`电脑端: ${DESKTOP.w}x${DESKTOP.h}`);
  console.log(`手机端: ${MOBILE.w}x${MOBILE.h} @${MOBILE.dsf}x 触摸+手机UA\n`);

  const child = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-swiftshader',
    // ★ 防后台节流三件套。`--headless=new` 下后台标签的 visibilityState 是 'hidden'，
    //   rAF 会被暂停/降到 1Hz —— 于是"画布上画了没画"这类断言会在**同一个页面、
    //   同一份代码**上时而通过时而失败（实测遇到过，`Page.bringToFront` 有时赶不及）。
    //   这几个开关让每个标签页都持续渲染，断言才与"谁在前台"无关。
    //   ★ 注意：它**解决不了** Input.dispatchTouchEvent 的问题 —— 触摸事件仍然只能
    //     送到前台标签页（后台标签会 CDP 超时）。7b 节按"谁在前台"分段依然必要。
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

  let PC = null;   // 电脑端
  let PH = null;   // 手机端

  try {
    let ok = false;
    for (let i = 0; i < 100; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/version`);
        if (r.ok) { ok = true; break; }
      } catch (e) { /* not yet */ }
      await sleep(200);
    }
    if (!ok) { console.log('调试端口没起来'); process.exit(1); }

    console.log('1) 打开电脑端页面');
    PC = await openPage(SITE, DESKTOP, TEXT_PATCH);
    const okC = await waitReady(PC, '电脑端');
    check('电脑端页面加载并完成初始化', okC);
    if (!okC) throw new Error('电脑端未就绪');
    check('取值通道正常（1+1=2）', (await evalx(PC, '1+1')) === 2);

    console.log('\n2) 电脑端建房，拿到房间码');
    await sleep(1200);
    const pc0 = await probe(PC);
    check('电脑端 WebSocket 已连上', pc0.connected === true, JSON.stringify(pc0.connected));

    // ★ 在菜单里选一块拍子（红 = 下次击球超高速），端到端验证"颜色 = 技能"这条约定。
    //   用真鼠标点，不用 el.click() —— 后者绕过命中测试，被盖住也照样"成功"。
    const pickPc = await clickSwatch(PC, false, 3);
    check('电脑端在菜单里点得到皮肤色块（红）', !!pickPc, JSON.stringify(pickPc));
    check('★ 点击坐标确实落在视口内（否则这一下点了个寂寞，后面全是假绿）',
      !!pickPc && pickPc.x > 0 && pickPc.x < pickPc.vw
      && pickPc.y > 0 && pickPc.y < pickPc.vh,
      pickPc ? `(${pickPc.x},${pickPc.y}) 视口 ${pickPc.vw}x${pickPc.vh}` : 'null');

    await evalx(PC, "document.querySelector('#overlayBody .primary').click()");
    const code = await waitFor(PC, "window.__probe().code || ''", 8000, '房间码');
    check('拿到 6 位房间码', !!code && /^[A-Z0-9]{6}$/.test(code), String(code));

    console.log(`\n3) 手机端用同一个邀请链接进房（房间 ${code}）`);
    PH = await openPage(`${SITE}/?room=${code}`, MOBILE);
    const okP = await waitReady(PH, '手机端');
    check('手机端页面加载并完成初始化', okP);
    if (!okP) throw new Error('手机端未就绪');

    // ★ 邀请链接**不再自动入房**：链接只把房间码预填进菜单，手机上还要自己选拍子、点「加入」。
    //   不这么改的话，从链接进来的人永远选不了皮肤 —— 而皮肤就是技能，
    //   等于手机端玩家用不了这一轮新加的功能。
    const preM = await waitFor(PH,
      "(document.querySelector('#overlayBody .joinrow input') || {}).value || ''",
      8000, '手机端菜单预填房间码');
    check('★ 手机端：邀请链接把房间码预填进菜单（不是直接把人塞进房间）',
      preM === code, `预填「${preM}」vs 房间码「${code}」`);
    const phMenu = await probe(PH);
    check('★ 手机端此刻确实还没入房（证明"打开链接就自动进"这条老路径已经没了）',
      phMenu.mySide === -1, String(phMenu.mySide));

    // 手机端用**真触摸**选拍子（青 = 风），再真触摸点「加入」
    const pickPh = await clickSwatch(PH, true, 1);
    check('★ 手机端用手指点得到皮肤色块（青）', !!pickPh, JSON.stringify(pickPh));
    check('★ 触摸坐标确实落在视口内（横屏只有 390px 高，元素可能在折叠线以下）',
      !!pickPh && pickPh.x > 0 && pickPh.x < pickPh.vw
      && pickPh.y > 0 && pickPh.y < pickPh.vh,
      pickPh ? `(${pickPh.x},${pickPh.y}) 视口 ${pickPh.vw}x${pickPh.vh}` : 'null');
    const tapJoin = await clickEl(PH, true,
      "document.querySelector('#overlayBody .joinrow button')");
    check('★ 手机端点得到「加入」（预填之后它是主按钮）', !!tapJoin,
      JSON.stringify(tapJoin));

    const joined = await waitFor(PH, 'window.__probe().mySide >= 0', 12000, '手机端入房');
    check('★ 手机端从同一链接进来、自己选好拍子、点「加入」之后成功同房', joined === true);
    if (joined !== true) throw new Error('手机端没能加入房间');

    // ★ 等皮肤下发生效再取样：`joined` 消息先到、带 skins 的 state 快照后到，
    //   刚入房那一瞬间两边读到的都还是旧值（[3,0]）—— 那是"还没收到"，不是"没生效"。
    //   两端都要等：电脑端也得先收到"手机选了青"这件事。
    const skinPc = await waitFor(PC, 'window.__probe().skins[1] === 1', 5000, '电脑端收到手机皮肤');
    const skinPh = await waitFor(PH, 'window.__probe().skins[0] === 3', 5000, '手机端收到电脑皮肤');
    check('前置：两端都已收到对方的皮肤（否则下面两条是"还没收到"造成的假红）',
      skinPc === true && skinPh === true, `PC=${skinPc} PH=${skinPh}`);

    const [pc, ph] = await Promise.all([probe(PC), probe(PH)]);
    check('手机端拿到同一个房间码', ph.code === code, `${ph.code} vs ${code}`);
    check('电脑端分到左边（side 0）', pc.mySide === 0, `mySide=${pc.mySide}`);
    check('手机端分到右边（side 1）', ph.mySide === 1, `mySide=${ph.mySide}`);
    // ★ 皮肤跨端：两端各选各的，而两端看到的皮肤表必须一致 ——
    //   客户端要靠它给拍子上色、给技能按钮定型，说法不一致就会出现
    //   "我这边看你是青的、你那边看我是红的"这种没法交流的状态。
    check('★ 两端各自的皮肤都生效了，而且看到的皮肤表完全一致（电脑红=3 / 手机青=1）',
      JSON.stringify(pc.skins) === '[3,1]' && JSON.stringify(ph.skins) === '[3,1]',
      `电脑=${JSON.stringify(pc.skins)} 手机=${JSON.stringify(ph.skins)}`);
    check('★ 两端看到的拍子颜色也一致（电脑那边我的拍子是红的、手机那边是青的）',
      pc.paddleSkin[0] === ph.paddleSkin[0] && pc.paddleSkin[1] === ph.paddleSkin[1]
      && pc.paddleSkin[0] !== pc.paddleSkin[1],
      `电脑 pc.paddleSkin=${JSON.stringify(pc.paddleSkin)}`
      + ` 手机 ph.paddleSkin=${JSON.stringify(ph.paddleSkin)}`);

    await sleep(1500);
    const [pc2, ph2] = await Promise.all([probe(PC), probe(PH)]);
    check('★ 电脑端看得到手机端在线', pc2.present[0] === 1 && pc2.present[1] === 1,
      JSON.stringify(pc2.present));
    check('★ 手机端看得到电脑端在线', ph2.present[0] === 1 && ph2.present[1] === 1,
      JSON.stringify(ph2.present));
    check('两端都已进入比赛（遮罩已隐藏）',
      pc2.overlayHidden === true && ph2.overlayHidden === true,
      `PC=${pc2.overlayHidden} PH=${ph2.overlayHidden}`);

    console.log('\n4) ★★ 量具自检：两端必须真的是不同形态（否则"互通"什么都没证明）');
    const [sc, sh] = await Promise.all([evalx(PC, SHAPE), evalx(PH, SHAPE)]);
    note(`电脑端视口 ${sc.w}x${sc.h} touch=${sc.touch} coarse=${sc.coarse} uaMobile=${sc.uaMobile} maxTouchPoints=${sc.maxTouchPoints}`);
    note(`手机端视口 ${sh.w}x${sh.h} touch=${sh.touch} coarse=${sh.coarse} uaMobile=${sh.uaMobile} maxTouchPoints=${sh.maxTouchPoints}`);

    check('电脑端视口是 1280 宽', sc.w === 1280, String(sc.w));
    check('手机端视口是 844 宽', sh.w === 844, String(sh.w));
    check('★ 手机端有触摸事件、电脑端没有（两端输入形态确实不同）',
      sh.touch === true && sc.touch === false,
      `PC.touch=${sc.touch} PH.touch=${sh.touch}`);
    check('★ 手机端是粗指针、电脑端不是（与触摸一致，互为佐证）',
      sh.coarse === true && sc.coarse === false,
      `PC.coarse=${sc.coarse} PH.coarse=${sh.coarse}`);
    check('手机端 UA 真的是手机、电脑端不是',
      sh.uaMobile === true && sc.uaMobile === false,
      `PC=${sc.uaMobile} PH=${sh.uaMobile}`);

    check('★ 电脑端显示链路实测面板、手机端不显示（两端布局确实不同）',
      sc.meters && sc.meters.display !== 'none' && sh.meters && sh.meters.display === 'none',
      `PC=${sc.meters && sc.meters.display} PH=${sh.meters && sh.meters.display}`);
    check('★ 手机端有延迟胶囊且真的可见（中心点命中自己）',
      sh.ping && sh.ping.hit === true, JSON.stringify(sh.ping));
    check('★ 电脑端没有延迟胶囊',
      !sc.ping || sc.ping.display === 'none', JSON.stringify(sc.ping));

    console.log('\n5) 稳定性：两端同时收快照');
    const s0 = await probe(PC); const t0 = await probe(PH);
    await sleep(8000);
    const s1 = await probe(PC); const t1 = await probe(PH);
    const hzPC = (s1.snaps - s0.snaps) / 8;
    const hzPH = (t1.snaps - t0.snaps) / 8;
    check('电脑端持续收到快照（24~36 次/秒）', hzPC > 24 && hzPC < 36, `${hzPC.toFixed(1)}/s`);
    check('手机端持续收到快照（24~36 次/秒）', hzPH > 24 && hzPH < 36, `${hzPH.toFixed(1)}/s`);
    check('两端都没有掉线', s1.drops === 0 && t1.drops === 0, `PC=${s1.drops} PH=${t1.drops}`);
    check('服务端推进频率正常', s1.tickRate > 27 && s1.tickRate < 33, `${s1.tickRate}/s`);

    console.log('\n6) 手机端用手指滑 → 电脑端能不能看见');
    const cvRect = await evalx(PH, `(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const b = c.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    })()`);
    check('手机端画布有实际尺寸（手指落点基于它）',
      !!cvRect && cvRect.w > 100 && cvRect.h > 100, JSON.stringify(cvRect));
    if (!cvRect || cvRect.w < 100) throw new Error('手机端画布尺寸异常，触摸无从下手');
    const touchX = cvRect.x + cvRect.w * 0.72;   // 手机端是 side 1（右侧），点它的半场
    const put = (frac) => cvRect.y + cvRect.h * frac;

    const beforePC = await probe(PC);
    const beforePH = await probe(PH);
    // ★ 诊断：滑动起点上到底是哪个元素在接收触摸？
    //   如果它是 canvas / body（不是 .solobar / .overlay 这类被 touchHitsUI 排除的 UI 控件），
    //   那么"拍子没动"就不可能被解释成"被 UI 吃掉了" —— 只可能是触摸事件没送到页面。
    //   两种原因一个改客户端、一个改探针，必须先分清，不能靠猜。
    const tgt = await evalx(PH, `(() => {
      const e = document.elementFromPoint(${Math.round(touchX)}, ${Math.round(put(0.5))});
      return e ? e.tagName + (e.id ? '#' + e.id : '')
        + (typeof e.className === 'string' && e.className ? '.' + e.className : '') : null;
    })()`);
    note(`手机端滑动起点的触摸目标: ${tgt}`);
    await touchDrag(PH, touchX, put(0.5), put(0.78));
    await sleep(600);
    const afterPC = await probe(PC);
    const afterPH = await probe(PH);

    check('手机端手指下滑，自己的拍子跟着走',
      afterPH.paddle[1] > beforePH.paddle[1] + 40,
      `${beforePH.paddle[1]} -> ${afterPH.paddle[1]}`);
    check('★ 电脑端看到了手机端拍子的移动（触摸输入跨端可见）',
      afterPC.paddle[1] > beforePC.paddle[1] + 40,
      `${beforePC.paddle[1]} -> ${afterPC.paddle[1]}`);

    // 反方向滑动前再确认一次起点目标 —— 复用同一个诊断表达式
    const tgt2 = await evalx(PH, `(() => {
      const e = document.elementFromPoint(${Math.round(touchX)}, ${Math.round(put(0.78))});
      return e ? e.tagName + (e.id ? '#' + e.id : '')
        + (typeof e.className === 'string' && e.className ? '.' + e.className : '') : null;
    })()`);
    note(`手机端反向滑动起点的触摸目标: ${tgt2}`);
    await touchDrag(PH, touchX, put(0.78), put(0.3));
    await sleep(600);
    const backPC = await probe(PC);
    const backPH = await probe(PH);
    // 失败时把现场一并打出来：是座位没了（mySide<0）、还是阶段变了、还是它其实没动
    const diag = await evalx(PH, `(() => { const p = window.__probe();
      return { mySide: p.mySide, phase: p.phase, disp: p.paddleDisp[p.mySide],
               server: p.paddle[p.mySide], balls: p.balls.length }; })()`);
    check('手机端手指上滑，拍子反向移动',
      backPH.paddle[1] < afterPH.paddle[1] - 40,
      `${afterPH.paddle[1]} -> ${backPH.paddle[1]} | 现场 ${JSON.stringify(diag)} 起点目标 ${tgt2}`);
    check('★ 电脑端同步看到反向移动', backPC.paddle[1] < afterPC.paddle[1] - 40,
      `${afterPC.paddle[1]} -> ${backPC.paddle[1]}`);

    console.log('\n7) 电脑端用键盘 → 手机端能不能看见');
    const k0PH = await probe(PH);
    const k0PC = await probe(PC);
    await key(PC, 'rawKeyDown', 'ArrowUp', 38);
    await sleep(800);
    await key(PC, 'keyUp', 'ArrowUp', 38);
    await sleep(600);
    const k1PH = await probe(PH);
    const k1PC = await probe(PC);
    check('电脑端按键后自己的拍子动了',
      Math.abs(k1PC.paddle[0] - k0PC.paddle[0]) > 20,
      `${k0PC.paddle[0]} -> ${k1PC.paddle[0]}`);
    check('★ 手机端看到了电脑端拍子的移动（键盘输入跨端可见）',
      Math.abs(k1PH.paddle[0] - k0PH.paddle[0]) > 20,
      `${k0PH.paddle[0]} -> ${k1PH.paddle[0]}`);

    console.log('\n7b) 暂停：手机按一下 / 电脑按一下，两边都要生效');
    // ★ 分段的关键：**输入事件只能送到前台那个标签页**（往后台标签页发
    //   Input.dispatchTouchEvent 会直接 CDP 超时，实测过），而 rAF 又只在前后台
    //   才有保证。所以下面按"谁在前台"分成几段，并且凡是"画出来了没有""球停住了没有"
    //   这类断言，都放在那一端处于前台时做，另外还额外断言"这段时间画布确实在重绘"
    //   （__seenN 在涨）—— 否则一条后台停摆的页面会让"球不动"恒真，变成空断言。
    const drawCount = (sess) => evalx(sess, 'window.__seenN');

    /**
     * 等到"电脑端**画出来的**球真的在动"为止。
     *
     * ★ 不能只取相隔 900ms 的两个样本、要求它变 —— 进球之后有 3 秒倒计时，
     *   那段时间球**就停在正中**（400,250），窗口撞上去就稳定报红，
     *   而且报出来的样子像"球卡住了"，会把人引到完全错误的方向（第一版就是这么红的）。
     *   改成轮询等待"真的动起来"，语义反而更强：下面"暂停后不动"要求的前提本来就是
     *   "按下去之前它确实在动"。
     */
    async function waitBallMoving(sess, ms = 8000) {
      let prev = (await probe(sess)).ballDisp;
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await sleep(180);
        const cur = (await probe(sess)).ballDisp;
        if (Math.abs(cur[0] - prev[0]) > 2 || Math.abs(cur[1] - prev[1]) > 2) {
          return { ok: true, from: prev, to: cur };
        }
        prev = cur;
      }
      return { ok: false, from: prev, to: prev };
    }

    try { await PC.send('Page.bringToFront'); } catch (e) { /* 不支持也无所谓 */ }
    await sleep(700);
    // 前置：先证明"暂停前球真的在动"，否则下面"暂停后不动"什么也证明不了
    const liveN1 = await drawCount(PC);
    const moving = await waitBallMoving(PC);
    const liveN2 = await drawCount(PC);
    check('前置：暂停之前电脑端**画出来的**球确实在动（量具是活的）',
      moving.ok, `${moving.from} -> ${moving.to}（最多等了 8 秒）`);
    check('前置：这段时间画布确实在重绘（不是靠"页面根本没动"蒙混）',
      liveN2 - liveN1 > 30, `fillText ${liveN1} -> ${liveN2}`);

    // ---- 第一段：手机在前台，用真实手指点暂停 ----
    try { await PH.send('Page.bringToFront'); } catch (e) { /* 不支持也无所谓 */ }
    await sleep(500);
    const pbBox = await evalx(PH, `(() => {
      const b = document.getElementById('pauseBtn');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2,
               t: b.textContent, shown: getComputedStyle(b).display !== 'none' };
    })()`);
    check('手机端横屏下暂停按钮可见且写着「暂停」',
      !!pbBox && pbBox.shown && pbBox.t === '暂停', JSON.stringify(pbBox));
    await touchTap(PH, pbBox.x, pbBox.y);
    await sleep(900);
    const pPC = await probe(PC);
    const pPH = await probe(PH);
    check('★ 手机按暂停 → 电脑端也暂停（跨设备、跨输入方式）',
      pPC.userPaused === true && pPH.userPaused === true,
      `PC=${pPC.userPaused} PH=${pPH.userPaused}`);
    check('★ 电脑端知道"是对面按的"（pausedBy 指向手机端的座位）',
      pPC.pausedBy === pPH.mySide, `PC.pb=${pPC.pausedBy} PH.side=${pPH.mySide}`);
    check('两端按钮都变成「继续」',
      pPC.pauseBtnText === '继续' && pPH.pauseBtnText === '继续',
      `${pPC.pauseBtnText} / ${pPH.pauseBtnText}`);

    // ---- 第二段：把电脑端换到前台，验它"画出来了没有" ----
    try { await PC.send('Page.bringToFront'); } catch (e) { /* 不支持也无所谓 */ }
    await sleep(900);
    const seenPC = await evalx(PC, 'window.__seen');
    check('★ 电脑端画布上真的画出了「已暂停」', (seenPC['已暂停'] || 0) > 0,
      JSON.stringify(Object.keys(seenPC).slice(0, 14)));
    check('★ 而且写的是「对手按下的暂停」（跨端也得说清是谁按的）',
      (seenPC['对手按下的暂停'] || 0) > 0);
    const fb1c = (await probe(PC)).ballDisp;
    const fbN1 = await drawCount(PC);
    await sleep(1000);
    const fb2c = (await probe(PC)).ballDisp;
    const fbN2 = await drawCount(PC);
    check('★ 暂停期间电脑端画出来的球停住了', fb1c[0] === fb2c[0] && fb1c[1] === fb2c[1],
      `${fb1c} -> ${fb2c}`);
    check('★ 而这段时间画布一直在重绘（所以上面那条不是"页面停摆"造成的假绿）',
      fbN2 - fbN1 > 30, `fillText ${fbN1} -> ${fbN2}`);
    await shot(PC, 'cross-desktop-paused.png');

    // ---- 第三段：电脑端前台，用真实鼠标点恢复 ----
    const boxPC = await evalx(PC, `(() => {
      const r = document.getElementById('pauseBtn').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await mouseClick(PC, boxPC.x, boxPC.y);
    await sleep(900);
    const rPC = await probe(PC);
    const rPH = await probe(PH);
    check('★ 电脑按一下就能恢复（不必是"按暂停的那一端"才能恢复）',
      rPC.userPaused === false && rPH.userPaused === false,
      `PC=${rPC.userPaused} PH=${rPH.userPaused}`);
    check('恢复后"是谁按的"清掉了', rPC.pausedBy === -1, String(rPC.pausedBy));
    check('恢复后手机端按钮回到「暂停」', rPH.pauseBtnText === '暂停', rPH.pauseBtnText);
    // ★ 复位**必须**放在"恢复已经生效"之后：放在点击之前的话，点击到生效之间
    //   那几帧画的还是遮罩，于是这条断言会假红（实测踩到过）。
    await evalx(PC, RESET_SEEN);
    await sleep(800);
    check('★ 恢复后电脑端画布上不再出现「已暂停」（遮罩真的撤了）',
      !(await evalx(PC, 'window.__seen["已暂停"] || 0')));

    console.log('\n8) 两端都能正确渲染同一颗球');
    const [ballC, ballH] = await Promise.all([probe(PC), probe(PH)]);
    check('两端看到的球数量一致',
      ballC.balls.length === ballH.balls.length,
      `PC=${ballC.balls.length} PH=${ballH.balls.length}`);
    const sameBall = ballC.balls.length && ballH.balls.length
      && ballC.balls[0][0] === ballH.balls[0][0] && ballC.balls[0][1] === ballH.balls[0][1];
    check('★ 两端球的服务端坐标一致（同一场对局）', !!sameBall,
      `PC=${JSON.stringify(ballC.balls[0])} PH=${JSON.stringify(ballH.balls[0])}`);
    note(`两端球的绘制坐标（各自平滑，允许有差异）：`
      + `PC=${JSON.stringify(ballC.ballDisp)} PH=${JSON.stringify(ballH.ballDisp)}`);

    console.log('\n9) 页面报错检查');
    const eC = PC.errors.filter((e) => e.indexOf('[网络]') !== 0);
    const eH = PH.errors.filter((e) => e.indexOf('[网络]') !== 0);
    check('电脑端没有未捕获异常', eC.length === 0, eC.slice(0, 3).join(' ; '));
    check('手机端没有未捕获异常', eH.length === 0, eH.slice(0, 3).join(' ; '));

    console.log('\n10) 截图');
    await shot(PC, 'cross-desktop.png');
    await shot(PH, 'cross-mobile.png');
    const fc = fs.statSync(path.join(SHOT_DIR, 'cross-desktop.png')).size;
    const fh = fs.statSync(path.join(SHOT_DIR, 'cross-mobile.png')).size;
    check('两张截图都非空', fc > 3000 && fh > 3000, `PC=${fc}B PH=${fh}B`);

    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  } catch (e) {
    console.log('\n探针中断: ' + e.message + '\n');
    fail += 1;
  } finally {
    try { if (PC) PC.ws.close(); } catch (e) {}
    try { if (PH) PH.ws.close(); } catch (e) {}
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
