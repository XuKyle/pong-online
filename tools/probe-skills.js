'use strict';

/**
 * 第 10 轮（拍子皮肤 = 技能）的真实浏览器验证。
 *
 * 服务端逻辑已经被 test-rules（294 条）和 test-protocol（86 条）钉住了，这个探针只管
 * **浏览器里到底发生了什么** —— 也就是那几件离线测不到的事：
 *
 *   1. 菜单里点得动皮肤色块，点了之后**画出来的拍子真的换了颜色**；
 *   2. 技能按钮真的出现在页面上、位置对（在自己那条拍子边上）、
 *      **中心点命中的是它自己**（"量到了" ≠ "看得见"）；
 *   3. 三种释放方式各自通：电脑**鼠标点按钮** / 手机**手指点按钮** / 电脑**按 Q 键**；
 *   4. ★ 青色：画布上真的画出了风的气流线，而且**方向与风向一致**，
 *      风过去之后渲染循环还活着；
 *   5. ★ 黄色：对手那一端画面上真的**多画了一个球**，释放方那一端没多；
 *      "幻影生效中"这句话只出现在释放方那边；
 *   6. ★ 红色：蓄力时拍子外面真的多画了一圈光，而按之前那一圈是不存在的。
 *
 * ★★ 最要紧的一条纪律：所有"画出来了没有"的断言，都**先证明渲染循环活着**。
 *    踩过的真坑：`drawWind` 里漏定义 `WIND_MS` 时，异常发生在 `draw()` 之后、
 *    `requestAnimationFrame(loop)` 之前 —— **整个渲染循环当场停摆**，
 *    画面冻住但按钮还在更新，看着像"卡了"。
 *    所以下面每处取证都先读 `__fxc`（每帧开头 clearRect 的计数）在不在涨。
 *
 * ★ 画布取证走"打补丁"而不是给页面加测试钩子：改 CanvasRenderingContext2D 原型，
 *    记录**真正被调用的绘制指令**。断言的才是"画上去了"，而不是"代码按逻辑应该画"。
 *
 * ★★ 第二要紧的纪律：每次取证都要在一个"干净窗口"里，并且**能重试**。
 *    进球会重发球（`resetBall` 把整个 balls 数组换掉），撞上它就会看到
 *    "技能没生效 / 球数没变"，把人引到完全错误的方向。判据和理由见 waitBallFresh。
 *
 * ★★ 第三要紧的纪律：要窗口就得要**当前球速下最大的那个**，不能"够用就走"；
 *    而且**得让球有人接**（陪练，见 waitBallFresh）。
 *    这两条是复跑时 2 条红、加上 6 号房那条"没等到窗口"换来的 ——
 *    根因都不是技能坏了，而是"球在两块静止的拍子之间根本活不过一次往返"
 *    （发球 74% 直接得分，算过：角度随机 ±0.54 rad，纵向偏移最多 240px，拍子只覆盖 ±57px）。
 *    更详细的原因见 waitBallFresh / castPhantom 上面的注释。
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

const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9377;
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
const PROFILE = path.join(TMP_DIR, 'edgeskill_' + Date.now());

const DESKTOP = { w: 1280, h: 820, dsf: 1, ua: null };
// 手机横屏一档真实尺寸（和 probe-crossplay 保持一致，两处结论可以互相印证）
const MOBILE = {
  w: 844, h: 390, dsf: 3,
  ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Mobile Safari/537.36',
};

// 约定值。写在这里是为了断言里的"魔法数"有出处，而不是凭空来的。
const WIND_COLOR = '#67e8f9';     // drawWind 的气流线颜色（整个文件只此一处用）
const ARMED_COLOR = '#ef4444';    // drawArmed 的蓄力光圈颜色（SKIN_COL[3]，只作描边用）
const BALL_R = 9;                 // 与页面里的 BALL_R 一致（FX_PATCH 靠它认"球体"）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
// 当前在前台的是哪个会话 —— front() 靠它避免重复切换（见 front 的注释）
let lastFronted = null;
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
    await sess.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  if (dev.ua) await sess.send('Emulation.setUserAgentOverride', { userAgent: dev.ua });

  if (patch) await sess.send('Page.addScriptToEvaluateOnNewDocument', { source: patch });
  await sess.send('Page.navigate', { url });
  // ★ 新建标签页会**改变前台是哪一个**，而 `lastFronted` 是它之前的状态 —— 必须作废，
  //   否则 front() 会以为目标页已经在前台而跳过切换，后面读到的是没在渲染的冻帧。
  lastFronted = null;
  return sess;
}

async function waitReady(sess, label, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await evalx(sess, 'typeof window.__probe')) === 'function') return true;
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

/** 静默轮询（不打印超时）—— 用在"预期可能失败、由调用方重试"的场合 */
async function pollFor(sess, expr, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let v;
    try { v = await evalx(sess, expr); } catch (e) { v = undefined; }
    if (v) return v;
    await sleep(70);
  }
  return null;
}

const probe = (sess) => evalx(sess, 'window.__probe()');

/** 客户端**发出去**的 skill 消息条数（配合 FX_PATCH 里的 __sent） */
const sentSkills = (sess) => evalx(sess,
  "window.__sent.filter(function (s) { return s.indexOf('\"skill\"') >= 0; }).length");

// ---------- 真实输入 ----------
async function mouseClick(sess, x, y) {
  await sess.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await sleep(40);
  await sess.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}

/** 真实触摸点一下（手指不移动） */
async function touchTap(sess, x, y) {
  const pt = [{ x: Math.round(x), y: Math.round(y) }];
  await sess.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(70);
  await sess.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** 真键盘按一下（Q 键：key='q' code='KeyQ' vk=81）。按下和抬起都要发，否则页面里按键会"卡住" */
async function tapKey(sess, k, vk) {
  const base = {
    key: k, code: 'Key' + k.toUpperCase(),
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  };
  await sess.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  await sleep(40);
  await sess.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// 方向键的 vk 码。ArrowUp=38 / ArrowDown=40 / ArrowLeft=37 / ArrowRight=39
const VK = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };

/**
 * 真键盘**按住** ms 毫秒再松开。
 * ★ 与 tapKey 的区别：tapKey 只按 40ms，拍子几乎不动；要"把拍子推到底"必须按住。
 * ★ 松手一定要发 keyUp —— 不发的话页面里 dir 会一直挂着，
 *   后面的断言就会看到"拍子自己在动"，看起来像产品坏了。
 */
async function holdKey(sess, k, ms) {
  const vk = VK[k] || 0;
  const base = {
    key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  };
  await sess.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  await sleep(ms);
  await sess.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  await sleep(60);
}

/** 点页面上某个元素：expr 求值出元素；先滚进视野再取坐标（手机上菜单是可滚抽屉） */
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

const clickSwatch = (sess, mobile, idx) => clickEl(
  sess, mobile, `document.querySelectorAll('#overlayBody .skinrow .swatch')[${idx}]`);

const skillBtnSel = (idx) => `document.querySelectorAll('.skillbtn')[${idx}]`;

/**
 * 等菜单真的渲染出来。
 * ★ 不能省：页面"脚本初始化完成"（`__probe` 已经是函数）**不等于**"菜单已经在 DOM 里"
 *   —— `showMenu()` 是在 WebSocket 连上之后才调的。早一步去 querySelectorAll
 *   `.skinrow .swatch` 会得到 undefined，而失败信息只会说"点不到色块"，
 *   看起来像皮肤功能坏了，其实是还没渲染（第一版就栽在这里）。
 */
async function waitMenu(sess, ms = 10000) {
  return waitFor(sess, "!!document.querySelector('#overlayBody .skinrow .swatch')", ms, '菜单出现');
}

/**
 * 把该页切到前台。
 *
 * ★ 每次发输入之前都必须切：`Input.dispatchTouchEvent` 送到后台标签页会直接 CDP 超时
 *   （实测过），键盘也照这个规矩来 —— 不切的话这一下会落到**另一个标签页**身上，
 *   而"这一端什么都没发生"那条断言会因为完全错误的理由变绿。
 * ★ 已经在前台就不用再切（省 100~250ms 是小事，**缩短取样窗口**才是大事：见 waitBallFresh）。
 */
async function front(sess, settle = 250) {
  if (lastFronted === sess) return;
  try { await sess.send('Page.bringToFront'); } catch (e) { /* 不支持也无所谓 */ }
  lastFronted = sess;
  await sleep(settle);
}

/**
 * 把该页切到前台再读画布记录。
 *
 * ★★ 实测规律（本探针自己撞出来的）：**同一个浏览器里，只有前台那个标签页会真的渲染。**
 *    `--headless=new` 下非活动标签的 `visibilityState` 是 'hidden'，
 *    `--disable-background-timer-throttling` 那套开关**救不了 rAF**（它管的是定时器）。
 *    症状极具误导性：后台那一端的 `__fxc` 停在原地、`__balls` 冻在最后一帧的值，
 *    读出来就是"没画出风 / 只画了一个球 / 帧数 0"—— 看着像功能坏了，
 *    实际是"这一页压根没在画"。
 *    所以凡是"画出来了没有"的断言，都必须先切前台，并且**顺带用 frames 自证**。
 *    settle 只给 100ms：切完之后 3 帧就够本探针用了（frames >= 3 是断言的一部分）。
 */
async function fxFront(sess) {
  await front(sess, 100);
  return frameFx(sess);
}

async function shot(sess, name) {
  const r = await sess.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
}

/**
 * 画布取证补丁。
 *
 * ★ 为什么必须打补丁而不是读 `__probe()`：`__probe()` 报的是**喂给渲染器的数据**
 *   （view.balls / view.winds）。"数据里有两个球"和"屏幕上画了两个球"是两件事 ——
 *   中间还隔着一层 `if (!bd) continue;` 这种提前返回。拿输入断言输入等于没测。
 *
 * ★ 每帧开头 `clearRect` 会把记录清空，所以读到的永远是"当前这一帧"：
 *   `__balls` 的长度就是这一帧画了几个球，不需要按时间归一化，也不怕累计值混淆。
 *
 * ★ `__fxc`（clearRect 调用次数）是本探针的**生命体征**：`loop()` 里是
 *   `draw(); requestAnimationFrame(loop);` —— draw 抛异常的话 rAF 再也排不上，计数会停。
 *   所以"__fxc 还在涨" = 渲染循环还活着。
 */
const FX_PATCH = `(() => {
  const proto = CanvasRenderingContext2D.prototype;
  const BALL_R = ${BALL_R};
  window.__fxc = 0;
  window.__balls = [];      // 这一帧画的球（圆心）
  window.__strokes = {};    // 这一帧各 strokeStyle 描了几次
  window.__texts = {};      // 这一帧写上去的文字
  window.__segs = [];       // 这一帧画的线段 [x0, y0, x1, y1, strokeStyle]
  window.__sent = [];       // 客户端**发出去**的消息（原样，截断到 60 字符）

  // ★ 出站消息也要记。"按了 Q 没反应"至少有三种完全不同的原因：
  //   ① 按键根本没到 keydown 处理器；② 到了但被客户端本地挡掉（没发）；③ 发了但服务端没认。
  //   只看服务端状态的话这三种长得一模一样 —— 这正是"没收到"和"没推进"必须能分开的道理。
  const wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    if (typeof d === 'string') window.__sent.push(d.slice(0, 60));
    return wsSend.apply(this, arguments);
  };

  const clr = proto.clearRect;
  proto.clearRect = function () {
    window.__fxc += 1;
    window.__balls.length = 0;
    window.__strokes = {};
    window.__texts = {};
    window.__segs.length = 0;
    return clr.apply(this, arguments);
  };
  const arc = proto.arc;
  proto.arc = function (x, y, r) {
    // 只认半径正好等于 BALL_R 的圆 —— 球拖尾的半径是 BALL_R * (0.25..0.95)，撞不上
    if (r === BALL_R) window.__balls.push([Math.round(x), Math.round(y)]);
    return arc.apply(this, arguments);
  };
  const st = proto.stroke;
  proto.stroke = function () {
    const s = this.strokeStyle;
    if (typeof s === 'string') window.__strokes[s] = (window.__strokes[s] || 0) + 1;
    return st.apply(this, arguments);
  };
  const ft = proto.fillText;
  proto.fillText = function (t) {
    if (typeof t === 'string') window.__texts[t] = (window.__texts[t] || 0) + 1;
    return ft.apply(this, arguments);
  };
  let last = null;
  const mv = proto.moveTo;
  proto.moveTo = function (x, y) { last = [x, y]; return mv.apply(this, arguments); };
  const ln = proto.lineTo;
  proto.lineTo = function (x, y) {
    if (last) window.__segs.push([last[0], last[1], x, y, String(this.strokeStyle)]);
    last = [x, y];
    return ln.apply(this, arguments);
  };
  /** 风的气流线方向（弧度）。只取风那个颜色 —— 护盾/拍子/出界线的线段不能混进来 */
  window.__windAngles = function () {
    const out = [];
    for (let i = 0; i < window.__segs.length; i += 1) {
      const s = window.__segs[i];
      if (s[4] !== '${WIND_COLOR}') continue;
      out.push(Math.atan2(s[3] - s[1], s[2] - s[0]));
    }
    return out;
  };
})()`;

/** 读"当前这一帧"的画布记录，外加这段窗口里画了多少帧（生命体征） */
async function frameFx(sess) {
  const n1 = await evalx(sess, 'window.__fxc');
  await sleep(140);
  const n2 = await evalx(sess, 'window.__fxc');
  const json = await evalx(sess, `JSON.stringify({
    balls: window.__balls,
    strokes: window.__strokes,
    texts: Object.keys(window.__texts),
    angles: window.__windAngles()
  })`);
  const o = JSON.parse(json);
  o.frames = n2 - n1;
  return o;
}

/**
 * 技能按钮的实际几何 + 命中测试。
 * `hitSelf` 走 elementFromPoint(中心点) —— **必须有它**：
 * `getBoundingClientRect()` 有面积只证明它在布局里，不证明它在最上层，
 * 更不证明手指点得到它（竖屏提示条被整屏抽屉盖住时，矩形照样有面积、断言照样过）。
 */
async function btnGeom(sess, idx) {
  return evalx(sess, `(() => {
    const el = document.querySelectorAll('.skillbtn')[${idx}];
    if (!el) return null;
    const c = document.getElementById('game').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const p = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      shown: el.style.display !== 'none' && r.width > 0,
      x: r.left, y: r.top, right: r.right, bottom: r.bottom,
      w: r.width, h: r.height, text: el.textContent, cls: el.className,
      court: { l: c.left, r: c.right, t: c.top, b: c.bottom },
      vw: window.innerWidth, vh: window.innerHeight,
      // ★ 这个槽位贴哪条边。位置断言必须按它分流 ——
      //   "自己半场的左上角"对右半场那位来说镜像到屏幕右上，
      //   拿左半场的期望去判它是一条与实现无关的假红。
      mineEdge: (window.__probe().slotEdges || [])[${idx}] || '',
      hitSelf: !!p && (p === el || el.contains(p)),
      hitWhat: p ? (p.id || p.className || p.tagName) : null
    };
  })()`);
}

/**
 * 等一个"当前球速下能拿到的**最大**窗口"。
 *
 * ★ 为什么需要：进球会重发球（`resetBall` 把整个 balls 数组换掉）—— 幻影球跟着消失、
 *   球也回到中场。观测窗口撞上去就会看到"技能好像没生效 / 球数没变 / 球卡住了"，
 *   把人引到完全错误的方向。判据必须**按时间**算而不是按位置：球在中场但**高速冲向球门**
 *   时位置判据会放过它，而零点几秒后就进球了；而本探针读一次画布要 ~0.3 秒
 *   （切前台 + 取两帧计数），幻影那一段还要连读两端。
 *
 * ★★ 为什么不能"够用就走"（判据写成 `tGoal > 1.0 秒`）：那是本探针最早一版的写法，
 *    实测常常刚好在 1.0 秒那一刻开闸。而幻影那一段要花的钱是固定的：
 *    切前台 + 真触摸点一下 + 读两端数据 + 再切两次前台读画布 ≈ 0.8~1.0 秒。
 *    于是"窗口 1.0 秒"和"观测 0.9 秒"基本打平，中间再撞上一次进球就会读到
 *    "球数没变 / 看不到幻影"，看着像幻影功能坏了。
 *    这个误诊真发生过：首跑 77/0、复跑 75/2，红的就是那两条，根因是窗口不够。
 *
 * ★ 判据：球在**最外侧 28% 的带子里、并且正朝中间飞** ⇒ 它刚从那一侧的拍子上弹回来，
 *    此刻到进球的时间就是这一轮往返里最长的。不能写死一个秒数：球每被拍子打中一次
 *    都会加速（SPEEDUP_PER_HIT，封顶 900），球快的时候整个往返也只有 0.8 秒，
 *    写死"必须 > 1.3 秒"会永远等不到（这是个**会静默变成死等**的陷阱）。
 *
 * ★ 失败时把最后几次采样一起带出去 —— "没等到窗口"和"窗口判据写错了"必须能分开。
 */

/**
 * 陪练阵容：把房间里的真人按入座顺序列上 —— `guardsOf(A, B)` = A 守 0 号、B 守 1 号。
 * 两端都列上 ⇒ 球永远有人接 ⇒ 比分不涨、"干净窗口"一个接一个。
 * （服务端按 socket 认人，所以每条拍子只能由它自己那一页发键盘来驱动。）
 */
const guardsOf = (...sess) => sess.map((s, i) => ({ sess: s, slot: i }));

/**
 * 球飞到某一侧拍子那个平面上时，会落在哪一行（含上下墙的反射）。
 *
 * ★ 反射必须算：球在场上通常要先弹上下墙才飞到对面，直接用 `by + vy * t` 会算出
 *   一个场外的 y，陪练就会把拍子开到墙上去（第一版就是这么错的）。
 */
function interceptY(by, vy, tArr, H) {
  const lo = BALL_R;
  const hi = H - BALL_R;
  const span = hi - lo;
  let m = (by + vy * tArr - lo) % (2 * span);
  if (m < 0) m += 2 * span;
  return m <= span ? lo + m : hi - (m - span);
}

/**
 * 等一个窗口，顺手可以**陪练**（`guards` = 要陪练的槽位，空数组 = 纯旁观）。
 *
 * ★★ 为什么必须有陪练：两块拍子都静止在中点时，**发球有 74% 直接得分**。
 *    发球角度是 ±0.54 弧度里的随机值，飞到对面时纵向偏移最多 240px，而拍子只覆盖
 *    ±57px —— 只有 |角度| ≤ 0.14 的那 26% 会被挡回去。也就是说"等到一个不会进球的
 *    窗口"完全是在抽奖：复跑时 75/2 那两条红、以及 6 号房那条"没等到干净窗口"，
 *    根因是同一件事 —— **不是技能坏了，是球根本没被接回来**。
 *    有了陪练，球一定会被这一侧打回来，窗口从"抽奖"变成"等一次往返"。
 *
 * ★ 为什么陪练用键盘事件而不是触摸：`onKey` → `setDir()` 是**同步**调的，所以
 *    `Runtime.evaluate` 派发的事件在后台标签页也生效；而触摸走的是 `touchTargetY`，
 *    它是在 **rAF 里**被消费的 —— 后台标签页 rAF 停摆，推了等于没推（见 fxFront）。
 *    这是"客户端对触摸有响应"之外，又一组必须分开举证的事。
 *
 * ★ 拍子位置读 `paddle`（服务端真值）而不是 `paddleDisp`（本地预测）：后者每帧在
 *    rAF 里更新，**后台标签页里是冻住的** —— 拿它当反馈，陪练会一直跑偏。
 *
 * ★ `guards` 是 `[{ sess, slot }]`：陪练**只能由那一页自己发键盘**（一页只能控制
 *    自己那条拍子，服务端按 socket 认人）。两端都安排上，球就永远有人接，
 *    比分也永远不涨 —— 窗口从"等一次往返"变成"一秒钟一个"。
 *
 * ★ 判据：球在**最外侧 28% 的带子里、并且正朝中间飞** ⇒ 它刚从那一侧的拍子弹回来，
 *    此刻到进球的时间就是这一轮往返里最长的。不能写死一个秒数：球每被打中一次都会加速
 *    （SPEEDUP_PER_HIT，封顶 900），球快的时候整个往返只有 0.8 秒，写死"必须 > 1.3 秒"
 *    会永远等不到 —— 那是个**会静默变成死等**的陷阱。
 */
async function waitBallFresh(sess, ms = 20000, guards = []) {
  const t0 = Date.now();
  const tail = [];
  let prev = null;
  const held = new Map();             // sess → 此刻按住的键（0 = 没按）
  let lastErr = null;

  const hold = async (s, dir) => {
    if ((held.get(s) || 0) === dir) return;
    const prevDir = held.get(s) || 0;
    if (prevDir !== 0) {
      const k = prevDir < 0 ? 'ArrowUp' : 'ArrowDown';
      held.set(s, 0);
      await evalx(s, `(()=>{window.dispatchEvent(new KeyboardEvent('keyup',{key:'${k}'}));return 1})()`);
    }
    if (dir !== 0) {
      const k = dir < 0 ? 'ArrowUp' : 'ArrowDown';
      held.set(s, dir);
      await evalx(s, `(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'${k}'}));return 1})()`);
    }
  };
  const releaseAll = async () => {
    for (const g of guards) await hold(g.sess, 0);
  };

  try {
    while (Date.now() - t0 < ms) {
      const t = Date.now();
      const p = await probe(sess);
      if (p && p.phase === 'playing' && p.balls.length === 1) {
        const W = p.geom.court[0];
        const H = p.geom.court[1];
        const bx = p.balls[0][0];
        const by = p.balls[0][1];
        const dt = prev ? (t - prev.t) / 1000 : 0;
        const vx = dt > 0.02 ? (bx - prev.x) / dt : 0;
        const vy = dt > 0.02 ? (by - prev.y) / dt : 0;
        if (dt > 0.02 && Math.abs(vx) > 40) {
          // ① 窗口判据：球刚从某侧拍子上弹回来
          if ((vx < -60 && bx > 0.72 * W) || (vx > 60 && bx < 0.28 * W)) {
            await releaseAll();
            const tGoal = vx > 0 ? (W - bx) / vx : bx / -vx;
            return { ok: true, x: Math.round(bx), vx: Math.round(vx), tGoal: +tGoal.toFixed(2) };
          }
          // ② 陪练：球正飞向哪一侧，就把那一侧的拍子对准"球到达时的那一行"
          //    ★ hold() 对同一个方向是空操作 —— 不能每轮都先松手再按住，
          //      那样客户端每轮都会发一次 dir=0，拍子变成一顿一顿地走。
          for (const g of guards) {
            const left = g.slot === 0;
            const toward = left ? vx < -60 : vx > 60;
            let want = 0;
            if (toward) {
              const plane = left ? 49 : W - 49;          // 拍子正面 + 球半径
              const tArr = (left ? bx - plane : plane - bx) / Math.abs(vx);
              if (tArr >= 0) {
                const gp = g.sess === sess ? p : await probe(g.sess);
                const cur = (gp && gp.paddle[g.slot]) || H / 2;
                const err = interceptY(by, vy, tArr, H) - cur;
                lastErr = `${left ? 'L' : 'R'} err=${Math.round(err)}`;
                if (Math.abs(err) > 8) want = err > 0 ? 1 : -1;
              }
            }
            await hold(g.sess, want);
          }
        } else {
          tail.push(`x=${Math.round(bx)} vx=${Math.round(vx)}`);
          if (tail.length > 3) tail.shift();
        }
        prev = { t, x: bx, y: by };
      } else {
        prev = null;
        await releaseAll();
      }
      await sleep(50);
    }
  } finally {
    await releaseAll();               // 不管怎么退出，都不能把键留着按住
  }
  return { ok: false, seen: tail, lastErr };
}

/**
 * 在一个干净窗口里放技能，失败就重试。
 *
 * ★ 为什么必须重试：进球之后是倒计时，那一刻按技能会被"phase === playing"门禁拒掉
 *   （客户端本地也挡了一道，压根不往服务端发）—— 那是设计如此，不是 bug。
 *   不重试的话，看到的是"技能没放出来"，很容易误诊成实现有问题。
 *
 * ★ 返回值里带上"这一下客户端到底发了几条 skill 消息"。"按了没反应"至少有三种原因：
 *   ① 按键没到 keydown 处理器（没发）；② 到了但被客户端本地挡掉（没发）；
 *   ③ 发了但服务端没认。只看服务端状态三者长得一模一样 —— 必须能分开。
 */
async function castWhenOpen(sess, opt) {
  const { mobile, btn, okExpr, label, guards = [] } = opt;
  let sentBefore = null;
  let sentAfter = null;
  // ★ "等不到干净窗口"**不该一次就判死**：机器负载高时（同时跑别的探针 / 有别的进程抢 CPU）
  //   球在一段不太顺的飞行里能连着二十秒都落不进"刚被打回来"那条带子。
  //   实测过：6 次里偶发 1 次整段红（症状是"按 Q 放不出技能"，看着像按键接线断了，
  //   其实那一整个 20 秒窗口都没等到合适的球位）。
  //   所以把"等窗口"也纳入重试预算：最多试 4 轮、每轮 15 秒，但**总时长封顶 45 秒**，
  //   免得真有问题时无限等下去（真等不到就照实报"等不到窗口"，仍是可诊断的）。
  const tStart = Date.now();
  let dryRounds = 0;
  for (let i = 0; i < 6; i += 1) {
    if (!(await waitBallFresh(sess, 15000, guards)).ok) {
      dryRounds += 1;
      if (Date.now() - tStart > 45000 || dryRounds >= 3) {
        return { ok: false, why: `等不到干净窗口（连试 ${dryRounds} 轮）`, sentBefore, sentAfter };
      }
      continue;
    }
    await front(sess);
    const s0 = await sentSkills(sess);
    if (btn) {
      const c = await clickEl(sess, mobile, btn);
      if (!c) return { ok: false, why: '点不到按钮', sentBefore, sentAfter };
    } else {
      await tapKey(sess, 'q', 81);
    }
    const s1 = await sentSkills(sess);
    if (sentBefore === null) { sentBefore = s0; sentAfter = s1; }
    if (await pollFor(sess, okExpr, 1600)) return { ok: true, sentBefore: s0, sentAfter: s1 };
  }
  const s = await probe(sess);
  return {
    ok: false,
    sentBefore,
    sentAfter,
    why: `${label} 重试 6 次都没生效（phase=${s.phase} skillCd=${JSON.stringify(s.skillCd)}`
      + ` mySkin=${s.mySkin} 发出了 ${sentAfter - sentBefore} 条 skill 消息）`,
  };
}

/**
 * 手机端点「幻」按钮，然后**立刻**把两端一起读掉。
 *
 * ★ 为什么"点"和"观测"写在一起，而不是复用通用的 castWhenOpen：
 *   幻影只有 5 秒，而窗口只有一秒多，观测要花的每一毫秒都在跟它抢。
 *   分开写就得先 poll 一次"技能放出去了"，再另起一个循环去等"对手 2 个球" ——
 *   白多花 100~200ms，那正好是余量。这里点完立刻把两个取值请求**并行**发出去，
 *   "技能生效"和"按队过滤"一次判掉。
 *
 * ★ 进球会让这一次作废（`resetBall` 换掉整个 balls 数组，幻影跟着消失）。
 *   所以一旦看到 phase 离开 playing 就立刻停 —— 不是为了等它，而是为了
 *   **把失败原因说清楚**："撞上进球"和"幻影压根没生效"是两件事，
 *   只看球数的话两者长得一模一样。
 */
async function castPhantom(sess, foeSess) {
  await front(sess);          // 已经在前面就是空操作；不切的话真触摸会落到别的标签页上
  const c = await clickEl(sess, true, skillBtnSel(1));
  if (!c) return { ok: false, why: '点不到「幻」按钮' };
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 2600) {
    const [a, b] = await Promise.all([probe(foeSess), probe(sess)]);
    last = {
      foeBalls: a.balls.length,
      mineBalls: b.balls.length,
      foePx: a.phantom,
      minePx: b.phantom,
      cd: b.skillCd[1],
      phase: b.phase,
    };
    if (last.foeBalls === 2 && last.mineBalls === 1) return { ok: true, last };
    if (b.phase !== 'playing') {
      return { ok: false, why: `观测途中进球了（phase=${b.phase}，进球重发球会把幻影一起清掉）`
        + ` —— 这一次作废，重放。当时 ${JSON.stringify(last)}` };
    }
    await sleep(30);
  }
  return { ok: false, why: `点了按钮但 2.6 秒内没看到"对手 2 个球 / 自己 1 个球"：`
    + JSON.stringify(last) };
}

// ---------- 主流程 ----------
async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('找不到 Edge 可执行文件'); process.exit(1); }
  console.log(`浏览器: ${edge}`);
  console.log(`页面:   ${SITE}\n`);

  const child = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-swiftshader',
    // ★ 关掉后台节流：本探针要同时看两三个标签页的**画布**，而 rAF 在后台标签里会被
    //   暂停/降到 1Hz。不关的话"没画出风"和"根本没在渲染"分不开。
    //   ★ 它解决不了 Input.dispatchTouchEvent —— 触摸只能送到前台标签页，
    //     所以每次发输入前都会先 front()。
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

  let A = null;   // 电脑端 · 青（风）
  let B = null;   // 手机端 · 黄（幻影）
  let C = null;   // 电脑端 · 红（超高速）
  let D = null;   // 电脑端 · 灰（无技能）

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

    // =====================================================================
    // 房间一：电脑端青（风） + 手机端黄（幻影）
    // =====================================================================
    console.log('1) 电脑端在菜单里选「青」，建房');
    A = await openPage(SITE, DESKTOP, FX_PATCH);
    check('电脑端页面加载并完成初始化', await waitReady(A, 'A'));
    check('取值通道正常（1+1=2）', (await evalx(A, '1+1')) === 2);
    check('电脑端菜单渲染出来了（皮肤选择行在 DOM 里）', !!(await waitMenu(A)));

    const swA = await clickSwatch(A, false, 1);
    check('在菜单里点得到「青」色块（真鼠标点，不是 el.click()）', !!swA, JSON.stringify(swA));
    const menuSel = await evalx(A,
      "(() => { const on = document.querySelector('#overlayBody .swatch.on');"
      + ' return on ? on.textContent : null; })()');
    // ★ 第 12 轮起，每块皮肤格子上写的是「青 · 风」+ 一句技能说明（九种皮肤靠一行小字讲不完，
    //   得把说明放进每一格）。所以这里不能再要求"正好等于'青'"，改成"以'青'开头" ——
    //   仍然能抓住"点完之后选中的不是青"这种真问题，也不会因为文案变长就假红。
    check('★ 点完之后菜单里「青」被标成选中（选择是有可见反馈的）',
      typeof menuSel === 'string' && menuSel.indexOf('青') === 0, String(menuSel));
    check('★ 而且这一格上写着它的技能说明（"颜色 = 技能"要能在选的时候读懂）',
      typeof menuSel === 'string' && menuSel.indexOf('风') > 0, String(menuSel));

    await evalx(A, "document.querySelector('#overlayBody .primary').click()");
    const code = await waitFor(A, "window.__probe().code || ''", 8000, '房间码');
    check('拿到 6 位房间码', !!code && /^[A-Z0-9]{6}$/.test(code), String(code));

    console.log(`\n2) 手机端用邀请链接进来，自己选「黄」（房间 ${code}）`);
    B = await openPage(`${SITE}/?room=${code}`, MOBILE, FX_PATCH);
    check('手机端页面加载并完成初始化', await waitReady(B, 'B'));

    // ★ 邀请链接不再自动入房：链接只预填房间码，手机上还要自己选拍子、点「加入」。
    const preM = await waitFor(B,
      "(document.querySelector('#overlayBody .joinrow input') || {}).value || ''",
      8000, '手机端菜单预填房间码');
    check('★ 邀请链接把房间码预填进菜单（不是直接把人塞进房间）',
      preM === code, `预填「${preM}」vs 房间码「${code}」`);
    await front(B);
    const swB = await clickSwatch(B, true, 2);
    check('★ 手机端用手指点得到「黄」色块', !!swB, JSON.stringify(swB));
    check('★ 触摸坐标落在视口内（横屏只有 390px 高，元素可能在折叠线以下）',
      !!swB && swB.x > 0 && swB.x < swB.vw && swB.y > 0 && swB.y < swB.vh,
      swB ? `(${swB.x},${swB.y}) 视口 ${swB.vw}x${swB.vh}` : 'null');
    const tapJoin = await clickEl(B, true, "document.querySelector('#overlayBody .joinrow button')");
    check('手机端点得到「加入」', !!tapJoin, JSON.stringify(tapJoin));

    const joined = await waitFor(B, 'window.__probe().mySide >= 0', 12000, '手机端入房');
    check('★ 手机端选好拍子点「加入」之后成功同房', joined === true);
    if (joined !== true) throw new Error('手机端没能加入房间');

    // 等皮肤经服务端往返一次再取样（joined 先到、带 skins 的快照后到）
    const skinOk = await waitFor(A,
      'JSON.stringify(window.__probe().skins) === "[1,2]"', 5000, '皮肤下发');
    check('前置：电脑端已收到"手机选了黄"（否则下面的皮肤断言是"还没收到"造成的假红）',
      skinOk === true);

    // =====================================================================
    console.log('\n3) 皮肤落到画面与按钮上');
    await waitFor(A, "window.__probe().phase !== 'waiting'", 6000, '比赛开始');
    const [pa, pb] = await Promise.all([probe(A), probe(B)]);
    check('★ 两端皮肤表一致：[青, 黄]',
      JSON.stringify(pa.skins) === '[1,2]' && JSON.stringify(pb.skins) === '[1,2]',
      `A=${JSON.stringify(pa.skins)} B=${JSON.stringify(pb.skins)}`);
    check('★ 拍子**画出来的填充色**就是自己的皮肤色（这就是"颜色 = 技能"）',
      pa.paddleSkin[0] === pa.skinColors[1] && pa.paddleSkin[1] === pa.skinColors[2]
      && pb.paddleSkin[0] === pa.skinColors[1] && pb.paddleSkin[1] === pa.skinColors[2],
      `A=${JSON.stringify(pa.paddleSkin)} B=${JSON.stringify(pb.paddleSkin)}`
      + ` 青=${pa.skinColors[1]} 黄=${pa.skinColors[2]}`);
    check('★ 两条拍子的填充色互不相同（不然一眼分不清哪条是自己的）',
      pa.paddleSkin[0] !== pa.paddleSkin[1], JSON.stringify(pa.paddleSkin));

    const bA0 = await btnGeom(A, 0);
    const bA1 = await btnGeom(A, 1);
    note(`电脑端按钮：自己的 x=${Math.round(bA0.x)} y=${Math.round(bA0.y)} 字「${bA0.text}」`
      + ` / 对手的 x=${Math.round(bA1.x)} y=${Math.round(bA1.y)} 字「${bA1.text}」`);
    check('★ 电脑端：自己那个按钮写着「风」（青 = 风）', bA0.shown && bA0.text === '风',
      `${bA0.shown} / ${bA0.text}`);
    check('★ 电脑端：对手那个按钮写着「幻」且不可点（foreign）',
      bA1.shown && bA1.text === '幻' && /foreign/.test(bA1.cls), `${bA1.text} / ${bA1.cls}`);
    // ★ 位置断言（第 12 轮改过）：按钮**不再是"跟拍子走、摆在球场外侧"**，
    //   而是固定在自己半场的左上角（右半场那位从自己的视角看，"左上"就是屏幕右上，
    //   所以按 edge 镜像）。改的理由见 index.html 里 layoutSkillBtns 的注释：
    //   手机端那条拍子是被手指盖住的，按钮跟着它走就等于永远在手指底下，
    //   玩家得先挪开手指才点得到，而挪开手指球就漏了。
    //   ★ 判据用 `btnGeom` 里的 `mineEdge`：不假设"我是左边那个"，
    //   否则右半场的用例会拿左半场的期望来判（一条与实现无关的假红）。
    check('★ 自己那个按钮固定在自己半场的**左上角**（不再跟着拍子走）',
      bA0.mineEdge === 'left'
        ? (bA0.x >= bA0.court.l - 1 && bA0.x <= bA0.court.l + 24)
        : (bA0.right <= bA0.court.r + 1 && bA0.right >= bA0.court.r - 24),
      `edge=${bA0.mineEdge} 按钮 x=${Math.round(bA0.x)}..${Math.round(bA0.right)}`
      + ` vs 球场 ${Math.round(bA0.court.l)}..${Math.round(bA0.court.r)}`);
    check('★ 而且整颗按钮都在球场纵向的**上四分之一**里（"左上"不只是一个词）',
      bA0.y >= bA0.court.t - 1 && bA0.y <= bA0.court.t + bA0.court.b * 0.25,
      `y=${Math.round(bA0.y)} 球场上边=${Math.round(bA0.court.t)}`);
    check('★ 而且中心点命中的是它自己（"量到了"不等于"看得见"）',
      bA0.hitSelf === true, `中心点上是 ${bA0.hitWhat}`);
    check('★ 对手那个按钮：看得见但**点不到**（pointer-events:none，不能替对面放技能）',
      bA1.hitSelf === false, `中心点上是 ${bA1.hitWhat}`);

    // ★★ 这一条是这次改动的**实质**：把拍子推到底，按钮不能跟着走。
    //    没有它的话，"固定位置"这个说法完全没有被验证 —— 一个错误的实现
    //    （在固定位置和跟随之间摇摆、或按钮吃掉了拍子的位置）也能通过上面那条。
    {
      const yBefore = await evalx(A, "window.__probe().skillBtns[0] ? window.__probe().skillBtns[0].y : -1");
      await holdKey(A, 'ArrowDown', 900);
      const after = await evalx(A, "JSON.stringify({b: window.__probe().skillBtns[0], p: window.__probe().paddle[0]})");
      const o = JSON.parse(after);
      await holdKey(A, 'ArrowUp', 900);
      note(`推拍子后：按钮 y=${o.b.y}（改前 ${yBefore}），拍子 y=${Math.round(o.p)}`);
      check('★ 拍子被推到底了，但按钮**纹丝不动**（这才是"固定位置"的判据）',
        o.b.y === yBefore && Math.abs(o.p - o.b.y) > 30,
        `按钮 y ${yBefore} → ${o.b.y}，拍子 y=${Math.round(o.p)}`);
    }

    const bB1 = await btnGeom(B, 1);
    note(`手机端按钮：自己的 x=${Math.round(bB1.x)} y=${Math.round(bB1.y)}`
      + ` right=${Math.round(bB1.right)} bottom=${Math.round(bB1.bottom)} 视口 ${bB1.vw}x${bB1.vh}`);
    check('★ 手机端：自己那个按钮写着「幻」（黄 = 幻影）', bB1.shown && bB1.text === '幻',
      `${bB1.shown} / ${bB1.text}`);
    check('★ 手机端：按钮整颗都在视口内（外侧放不下就该退回场内贴边，而不是跑出屏幕点不到）',
      bB1.x >= 0 && bB1.right <= bB1.vw && bB1.y >= 0 && bB1.bottom <= bB1.vh,
      `x=${Math.round(bB1.x)} right=${Math.round(bB1.right)}`
      + ` y=${Math.round(bB1.y)} bottom=${Math.round(bB1.bottom)} / 视口 ${bB1.vw}x${bB1.vh}`);
    check('★ 手机端：中心点命中的是它自己（手指真点得到）',
      bB1.hitSelf === true, `中心点上是 ${bB1.hitWhat}`);

    // =====================================================================
    console.log('\n4) 青色 · 风：鼠标点按钮放技能，画布上真的刮起风');
    await front(A);
    const open1 = await waitBallFresh(A, 20000, guardsOf(A, B));
    check('前置：等到一个"短时间内不会进球"的窗口（本探针所有取样的前提）', open1.ok,
      open1.ok ? `x=${open1.x} vx=${open1.vx} ⇒ 距进球 ${open1.tGoal}s`
        : `没等到，phase=${(await probe(A)).phase}`);

    const fxBefore = await frameFx(A);
    check('前置：渲染循环活着（__fxc 在涨）—— 否则"没画出风"和"根本没渲染"分不开',
      fxBefore.frames >= 3, `220ms 内 ${fxBefore.frames} 帧`);
    check('前置：没放技能时画布上没有任何风的气流线（下面那条才不是空话）',
      !(fxBefore.strokes[WIND_COLOR] > 0), `风色描边次数 ${fxBefore.strokes[WIND_COLOR] || 0}`);
    const ballCount0 = fxBefore.balls.length;
    check('前置：此刻场上确实画着球', ballCount0 === 1, `画出的球 ${ballCount0} 个`);

    const windClick = await clickEl(A, false, skillBtnSel(0));
    check('鼠标点得到自己那个技能按钮', !!windClick, JSON.stringify(windClick));
    const windOn = await pollFor(A, 'window.__probe().winds.length > 0', 2000);
    check('★ 点了按钮之后风真的放出去了（服务端下发 wf）', !!windOn,
      JSON.stringify((await probe(A)).winds));
    check('★ 而且手机端也看到了这股风（风扫过整个球场；只有自己看得见就成"球自己乱动"了）',
      (await probe(B)).winds.length > 0, JSON.stringify((await probe(B)).winds));

    const fxWind = await frameFx(A);
    check('★ 画布上真的画出了风的气流线（不是只改了个内部状态）',
      fxWind.strokes[WIND_COLOR] > 0,
      `风色描边次数 ${fxWind.strokes[WIND_COLOR] || 0}（drawWind 每帧最多 26 条）`);

    const w0 = (await probe(A)).winds[0] || [0, 0, 0];
    const wantAngle = Math.atan2(w0[1], w0[0]);
    const maxDev = fxWind.angles.length
      ? Math.max(...fxWind.angles.map((a) => Math.abs(a - wantAngle))) : NaN;
    check('★ 而且气流线的方向与风向**一致**（每条线段都平行于 wf 里的单位向量）',
      fxWind.angles.length >= 3 && maxDev < 0.02,
      `${fxWind.angles.length} 条线段，最大偏差 ${Number.isNaN(maxDev) ? 'n/a' : maxDev.toFixed(4)} rad`);
    check('★ 电脑端放风的方向朝右（左半场的拍子 → 球场中心，dx 恒正）', w0[0] > 0,
      JSON.stringify(w0));
    check('★ 放完进入冷却（按钮上的数字会开始倒数）',
      (await probe(A)).skillCd[0] > 9 && (await probe(A)).skillCd[0] <= 10,
      `skillCd[0]=${(await probe(A)).skillCd[0]}`);

    // ★ 风只有 1 秒。等它过去，确认两件事：风不再画了、**渲染循环还活着**。
    //   后半条是关键：drawWind 里漏一个变量就会让 draw() 抛异常，
    //   而异常发生在 `requestAnimationFrame(loop)` 之前 —— 整个渲染循环当场停摆。
    await sleep(1500);
    // ★ 取样前必须确认 phase 是 playing：倒计时/结束时**本来就不画球**，
    //   在那种时刻断言"球还在画"会凭空报红，而且看起来像渲染坏了。
    const backPlaying = await waitFor(A, "window.__probe().phase === 'playing'", 6000, 'playing');
    const fxAfter = await frameFx(A);
    check('前置：风过去之后对局仍在 playing（否则"没有球"是倒计时的正常表现）',
      backPlaying === true, `phase=${(await probe(A)).phase}`);
    check('★ 风过去之后不再画气流线（不是残留一直挂着）',
      !(fxAfter.strokes[WIND_COLOR] > 0), `风色描边次数 ${fxAfter.strokes[WIND_COLOR] || 0}`);
    check('★★ 风过去之后渲染循环**仍然活着**（这是本轮最容易漏的那种"卡住"）',
      fxAfter.frames >= 3, `220ms 内 ${fxAfter.frames} 帧`);
    // ★★ 这条不能只读一次：单帧采样会**取到"刚好不画球"的那一帧**。
    //   playing 期间确实应该每帧都画球，但"进球 → 球回中场"的那一两帧、
    //   以及画布与快照之间的相位差，都会让某一次采样读到 0 个球。
    //   实测就是偶发红：报"现在 0 个 / 之前 1 个"，看着像渲染循环停摆，
    //   而同一次采样里 `frames >= 3`（上一行）已经证明循环活着。
    //   判据改成"在 1 秒内**读到过**球"——它要证明的命题本来就是"球还在被画"，
    //   而不是"此后每一帧都恰好被抽到"。抽到就停，不会用运气蒙对（读到过就是读到过）。
    let ballBack = 0;
    const tb = Date.now();
    while (Date.now() - tb < 1200) {
      const f = await frameFx(A);
      if (f.balls.length > 0) { ballBack = f.balls.length; break; }
    }
    check('★ 而且球还在被正常绘制（有画面，不是空转）',
      ballBack > 0,
      `1.2 秒内读到过 ${ballBack} 个球（风前是 ${ballCount0} 个）`);

    // =====================================================================
    console.log('\n5) 黄色 · 幻影：手机点按钮，对手那边多画一个球、自己这边不多');
    // 基线：两端画布上都只有 1 个球。
    // ★ 一次只能让**一个**标签页真的在渲染（见 fxFront），所以两端是**先后**读的 ——
    //   这对基线没影响：此刻本来就只有 1 个球，两端读数之间不会冒出第二个。
    //   "必须在同一帧取样"那条纪律针对的是**数据**比较（见 test-protocol 的 syncPair），
    //   不适用于这里：幻影有 5 秒，状态是个稳定的平台期，先后读不会张冠李戴。
    let preA = null;
    let preB = null;
    for (let i = 0; i < 6 && !preA; i += 1) {
      // 这里要一个大窗口：读两端的画布要切两次前台、花掉 0.5 秒，
      // 一秒的窗口不够；下面幻影那一段更是全靠它。
      if (!(await waitBallFresh(B, 20000, guardsOf(A, B))).ok) break;
      const a = await fxFront(A);
      const b = await fxFront(B);
      if ((await probe(B)).phase === 'playing'
        && a.frames >= 3 && b.frames >= 3 && a.balls.length === 1 && b.balls.length === 1) {
        preA = a;
        preB = b;
      }
    }
    check('前置：两端都真的在渲染（frames 自证）、画布上都只有 1 个球，取样期间也没进球',
      !!preA && !!preB,
      preA ? `A ${preA.frames} 帧 ${JSON.stringify(preA.balls)}`
        + ` / B ${preB.frames} 帧 ${JSON.stringify(preB.balls)}` : '没等到有效窗口');
    check('前置：释放方此刻没有"幻影生效中"的字样',
      !!preB && !preB.texts.some((t) => /幻影生效中/.test(t)),
      preB ? JSON.stringify(preB.texts) : 'n/a');

    // ★★ 顺序：**先把手机端切到前台，再去等窗口**。
    //    真触摸只能送到前台页（见 front），切前台要 100~250ms；而幻影只有 5 秒、
    //    能用的大窗口只有一秒多 —— 这一步必须在窗口之外花掉。
    await front(B);
    const fresh = await waitBallFresh(B, 20000, guardsOf(A, B));
    check('前置：等到一个"刚被打回来"的窗口（球在最外侧 28% 的带子里、正朝中间飞，'
      + '这是当前球速下最长的窗口）',
      fresh.ok, fresh.ok ? `x=${fresh.x} vx=${fresh.vx} ⇒ 距进球还有 ${fresh.tGoal}s`
        : `没等到，最后几次采样 ${JSON.stringify(fresh.seen)}`);

    // ★★ 允许重放：幻影 CD 是 15 秒，而"整段观测都落在一个不会进球的窗口里"是概率事件。
    //    判据自带"幻影确实活着"的确认（对手那边 2 个球），所以重放不等于降低标准 ——
    //    它只是把"撞上进球"这种与实现无关的运气因素从红灯里剔出去。
    let phCast = null;
    for (let att = 0; att < 3 && !(phCast && phCast.ok); att += 1) {
      if (att > 0) {
        const ready = await waitFor(B, 'window.__probe().skillCd[1] <= 0.05', 22000, '幻影冷却');
        if (ready !== true) { phCast = { ok: false, why: '等冷却超时' }; break; }
        await front(B);
        const f2 = await waitBallFresh(B, 20000, guardsOf(A, B));
        if (!f2.ok) continue;
        note(`幻影第 ${att + 1} 次尝试，窗口 x=${f2.x} vx=${f2.vx} ⇒ 距进球 ${f2.tGoal}s`);
      }
      phCast = await castPhantom(B, A);
      if (!phCast.ok) note(`第 ${att + 1} 次失败：${phCast.why}`);
    }
    const phOk = !!(phCast && phCast.ok);
    const phLast = phOk ? phCast.last : null;
    check('★ 手机端手指点自己的技能按钮，幻影真的放出去了（服务端确认，并给释放方"还剩几秒"）',
      phOk && phLast.cd > 0 && phLast.minePx[1] > 0,
      phOk ? `skillCd[1]=${phLast.cd} px=${JSON.stringify(phLast.minePx)}`
        : (phCast && phCast.why) || '');
    check('★ 释放方（手机）那边**没有**多球（服务端按队过滤了 bs，这是整套设计的核心）',
      phOk && phLast.mineBalls === 1, phLast ? JSON.stringify(phLast) : 'n/a');
    check('★ 对手（电脑）那边多看到一个球 —— 这才叫"被迷惑"',
      phOk && phLast.foeBalls === 2, phLast ? JSON.stringify(phLast) : 'n/a');
    // ★ px（"还剩几秒"的反馈）也必须按队过滤：原本它整数组下发、客户端只读自己那格，
    //   对手照样能收到 —— 看到"自己那格是 0 而另一格不是 0"就等于确知有幻影。
    //   （对比：蓄力光圈 bo 是**故意公开**的，见下一节。这两者不是一回事。）
    check('★ "还剩几秒"的反馈也只给释放方：对手那边 px 两格全 0',
      phOk && JSON.stringify(phLast.foePx) === '[0,0]',
      phLast ? JSON.stringify(phLast.foePx) : 'n/a');

    // ★ 画布取证分两步，顺序是有讲究的：
    //   ① **先读释放方 B**：它这会儿刚被切到前台（技能就是它点出去的），这次读几乎不额外花时间，
    //      而"幻影生效中"那句话只存在于幻影活着的窗口里，越早读越稳。
    //   ② **再读对手 A**：它是"幻影还在不在"的唯一判据（B 那边前后都是 1 个球），
    //      所以读完①就立刻读，读到就停。
    // ★ 为什么要"反复读到达标"：进球会让画面切进倒计时，那一帧**本来就不画球、也不写
    //   「幻影生效中」**（客户端里有 `view.phase === 'playing' || 'over'` 这个前提）。
    //   只读一次撞上倒计时，报出来就是"释放方看不到球"——像是幻影坏了，其实那帧在倒计时。
    //   判据自带校验，所以反复读不等于"读到啥算啥"：
    //     · B 出现「幻影生效中」只可能在 playing；
    //     · A 出现 2 个球只可能在 playing / over（倒计时不画球）。
    let sawB = null;
    // 同上：按**时间**给预算、并且只在"幻影还没死"时读，否则读到的是倒计时帧。
    // 释放方这条更紧（它还得先切回前台），但它同时是"幻影确实在跑"的判据，
    // 判据自带校验（必须看到「幻影生效中」字样），所以多读几次不会变成"读到啥算啥"。
    const tb0 = Date.now();
    while (!sawB && Date.now() - tb0 < 3000) {
      const bs = await evalx(B, 'window.__probe().phantom')
        .catch(() => null);
      if (bs && !((bs[0] || 0) > 0 || (bs[1] || 0) > 0)) break;
      const b = await fxFront(B);
      if (b.frames >= 3 && b.balls.length === 1
        && b.texts.some((t) => /幻影生效中/.test(t))) sawB = b;
    }
    let sawA = null;
    // ★★ 这里踩过一次偶发红（3 次里红 1 次），根因是**取证窗口选错了判据**：
    //   原来只写「5 次里读到 2 个球就算过」。但 `fxFront` 每次要 front(100ms) + 采样(140ms)
    //   ≈ 250ms，再叠 CDP 往返，5 次要花掉一秒多 —— 而幻影只有 5 秒，
    //   期间只要进一次球，画面就切进倒计时、**本来就不画球**，那几次采样全是白读。
    //   （红出来的症状是"对手画布上没画两个球"，看着像幻影在客户端没渲染，其实那几帧在倒计时。）
    //   改法：**每次读之前先确认幻影确实还活着**（服务端 px / 球数），
    //   只在"幻影活着"的采样里计数；并且把预算按**时间**给，而不是按次数给。
    const t0 = Date.now();
    let tries = 0;
    let sawAlive = 0;
    while (!sawA && Date.now() - t0 < 4200) {
      tries += 1;
      // 幻影死了就没必要再读画面 —— 那时画布上只有 1 个球是**正确行为**
      const st = await evalx(A, `(() => { const p = window.__probe();
        return { px: p.phantom ? p.phantom.slice() : [0, 0],
                 balls: (p.balls || []).length }; })()`);
      const alive = (st.px[0] || 0) > 0 || (st.px[1] || 0) > 0 || st.balls >= 2;
      if (!alive) break;
      sawAlive += 1;
      const a = await fxFront(A);
      if (a.frames >= 3 && a.balls.length === 2) sawA = a;
    }
    if (!sawA) note(`对手侧取证：试了 ${tries} 次（其中幻影活着 ${sawAlive} 次）`);
    check('★ 对手的画布上**真的画了两个球**（不是"数据里有两个"——中间还隔着一层提前返回）',
      !!sawA, sawA ? `${sawA.frames} 帧，画出的球 ${JSON.stringify(sawA.balls)}` : '没读到');
    check('★ 释放方的画布上仍然只画一个球、而且写着「幻影生效中」',
      !!sawB, sawB ? `${sawB.frames} 帧，画出的球 ${JSON.stringify(sawB.balls)}`
        + ` 文字 ${JSON.stringify(sawB.texts.filter((t) => /幻/.test(t)))}` : '没读到');
    check('★★ 而对手的画布上一个"幻影"字样都没有（连"场上有两个球"都不该提示他）',
      !!sawA && !sawA.texts.some((t) => /幻影/.test(t)),
      sawA ? JSON.stringify(sawA.texts.filter((t) => /幻/.test(t))) : 'n/a');
    // 反方向也要钉住：不能"两边都不画"也算过（上面那条会被"一片空白"满足）
    check('前置：对手那边确实在渲染且在画球（所以上面"没有幻影字样"不是因为画面是空的）',
      !!sawA && sawA.frames >= 3 && sawA.balls.length > 0,
      sawA ? `帧 ${sawA.frames} 球 ${sawA.balls.length}` : 'n/a');

    await shot(A, 'skill-phantom-opponent.png');
    await shot(B, 'skill-phantom-caster.png');

    // =====================================================================
    // 房间二：电脑端红（超高速） + 电脑端灰（无技能）
    // =====================================================================
    console.log('\n6) 另一间房：红（超高速）对灰（无技能），验证 Q 键与"灰板子按了白按"');
    C = await openPage(SITE, DESKTOP, FX_PATCH);
    check('红方页面加载并完成初始化', await waitReady(C, 'C'));
    check('红方菜单渲染出来了', !!(await waitMenu(C)));
    const swC = await clickSwatch(C, false, 3);
    check('点得到「红」色块', !!swC, JSON.stringify(swC));
    await evalx(C, "document.querySelector('#overlayBody .primary').click()");
    const code2 = await waitFor(C, "window.__probe().code || ''", 8000, '房间码');
    check('第二间房拿到 6 位房间码', !!code2 && /^[A-Z0-9]{6}$/.test(code2), String(code2));
    const cSkin = await waitFor(C, 'window.__probe().mySkin === 3', 6000, '红方皮肤');
    check('★ 红方选的红真的生效了（服务端下发回 mySkin = 3）',
      cSkin === true, `mySkin=${(await probe(C)).mySkin}`);

    D = await openPage(`${SITE}/?room=${code2}`, DESKTOP, FX_PATCH);
    check('灰方页面加载并完成初始化', await waitReady(D, 'D'));
    check('灰方菜单渲染出来了', !!(await waitMenu(D)));
    const swD = await clickSwatch(D, false, 0);   // 显式点「灰」—— 对应"没有技能的就是灰色"
    check('点得到「灰」色块（无技能的那块）', !!swD, JSON.stringify(swD));
    const tapJoin2 = await clickEl(D, false, "document.querySelector('#overlayBody .joinrow button')");
    check('灰方点得到「加入」', !!tapJoin2, JSON.stringify(tapJoin2));
    const joined2 = await waitFor(D, 'window.__probe().mySide >= 0', 12000, '灰方入房');
    check('★ 灰方成功入房', joined2 === true);
    if (joined2 !== true) throw new Error('灰方没能加入房间');

    // ★ 必须在这里核对"实际生效的皮肤"，不能只信色块点到了。
    //   理由：皮肤选择会写进 localStorage，并且**同源的新标签页会继承它**
    //   （这是有意为之的功能）。色块没点中的话，这一页会沿用上一个标签页选的皮肤，
    //   后面"红方按钮写着速 / 灰方没有按钮"就会以完全错误的理由报红，
    //   排查方向会被彻底带偏（第一版就是：两页都继承了手机的黄）。
    //   ★ 而且必须**等**：房间码 / 入座这些消息比带 `sk` 的快照先到，
    //     刚拿到房间码就立刻读，读到的是初始值 0 —— 报出来是"皮肤没生效"，纯属读早了
    //     （这一条真红过：72/7 那次的原因之一）。
    const skin2Ok = await waitFor(C,
      'JSON.stringify(window.__probe().skins) === "[3,0]"', 8000, '皮肤下发');
    check('前置：两端皮肤表都是 [红, 灰]', skin2Ok === true);
    check('★ 红方真的是红（皮肤 3）、灰方真的是灰（皮肤 0）',
      (await probe(C)).mySkin === 3 && (await probe(D)).mySkin === 0,
      `C.mySkin=${(await probe(C)).mySkin} D.mySkin=${(await probe(D)).mySkin}`);
    await waitFor(C, "window.__probe().phase !== 'waiting'", 6000, '比赛开始');

    const bC0 = await btnGeom(C, 0);
    const bD1 = await btnGeom(D, 1);
    check('★ 红方的按钮写着「速」', bC0.shown && bC0.text === '速', `${bC0.shown} / ${bC0.text}`);
    check('★ 灰方**没有**自己的技能按钮（灰 = 没有技能，连按钮都不该有）',
      bD1.shown === false, `shown=${bD1.shown} text=${bD1.text} cls=${bD1.cls}`);

    // ★★ 这一节有两次按键，而**输入事件只送到前台标签页**。
    //    不切前台的话灰方那一下会打到红方身上：红方被提前烧掉冷却，
    //    而"灰方按了没反应"那条断言会因为**完全错误的理由**变绿。
    //    ★ 还要等 phase 变成 playing 再按：倒计时期间两边都会在客户端就被挡掉
    //      （requestSkill 要求 playing），那时候按谁都"没反应"，这条断言等于没测。
    const dPlay = await waitFor(D, "window.__probe().phase === 'playing'", 8000, 'playing');
    check('前置：已进入 playing，此时按 Q 才是"真的按下去"（倒计时期间按谁都白按）',
      dPlay === true, `phase=${(await probe(D)).phase}`);
    await front(D);
    const dPre = await probe(D);
    const dSent0 = await sentSkills(D);
    await tapKey(D, 'q', 81);
    await sleep(400);
    const dPost = await probe(D);
    const dSent1 = await sentSkills(D);
    check('★ 灰板子按 Q 之后客户端**一条 skill 消息都没发**（灰板子在本地就被挡住了）',
      dSent1 === dSent0, `发了 ${dSent1 - dSent0} 条`);
    check('★ 灰板子按 Q：没有蓄力、没有风、没进冷却（按了完全白按）',
      dPost.boostArmed[1] === 0 && dPost.winds.length === 0
      && dPost.skillCd[1] === 0 && dPre.skillCd[1] === 0,
      `bo=${JSON.stringify(dPost.boostArmed)} wf=${dPost.winds.length}`
      + ` sc=${JSON.stringify(dPost.skillCd)}`);
    check('前置：红方没有被这一下误伤（说明上面的按键确实只落到灰方）',
      (await probe(C)).skillCd[0] === 0 && (await probe(C)).boostArmed[0] === 0,
      `C.sc=${JSON.stringify((await probe(C)).skillCd)} C.bo=${JSON.stringify((await probe(C)).boostArmed)}`);

    await front(C);
    // ★ 这一间只陪练**红方（0 号）**，不陪练灰方：两条都陪练的话球一定被打回来，
    //   而"蓄力"会在红方下一次击球时被正当消耗掉 —— 光圈在断言读它之前就没了。
    //   只陪练红方时，球被红方打回去之后要飞完整整一个来回才可能再碰到红方，
    //   那 1.7 秒足够把"光圈画出来了没有"和"对手那边也画得出来"两条都读完。
    const open2 = await waitBallFresh(C, 20000, [{ sess: C, slot: 0 }]);
    const fxPre = open2.ok ? await frameFx(C) : null;
    check('前置：等到干净窗口、渲染循环活着、且此刻**没有**那圈红光（下面那条才不是空话）',
      !!fxPre && fxPre.frames >= 3 && !(fxPre.strokes[ARMED_COLOR] > 0),
      fxPre ? `${fxPre.frames} 帧，红光描边 ${fxPre.strokes[ARMED_COLOR] || 0}`
        : `没等到窗口（${open2.ok ? 'x=' + open2.x : JSON.stringify(open2.seen)}）`);

    // ★ 红方按 Q 键放技能（真键盘事件，不是发 json）
    const boostCast = await castWhenOpen(C, {
      mobile: false, btn: null, okExpr: 'window.__probe().boostArmed[0] === 1', label: '超高速',
      guards: [{ sess: C, slot: 0 }],
    });
    check('★ 电脑端按 Q 键能放技能（需求点名的三种释放方式之一）', boostCast.ok,
      boostCast.why || `mySkin=${(await probe(C)).mySkin}`);
    check('★ 放完不是立刻提速，而是"蓄力"状态 + 进冷却',
      (await probe(C)).skillCd[0] > 9 && (await probe(C)).skillCd[0] <= 10,
      `sc[0]=${(await probe(C)).skillCd[0]}`);

    const fxBoost = await fxFront(C);
    check('★ 蓄力时拍子外面真的多画了一圈光（"下一板是超高速"一眼可见）',
      fxBoost.strokes[ARMED_COLOR] > 0, `红光描边 ${fxBoost.strokes[ARMED_COLOR] || 0}`);
    check('★ 而且画布没被这圈光搞停（渲染循环仍然活着）',
      fxBoost.frames >= 3, `${fxBoost.frames} 帧/220ms`);

    const fxD = await fxFront(D);
    // ★ 这条断言第一版写反了：我原本断言"对手那边不该画出蓄力光圈"，结果稳定报红 ——
    //   一查才发现**那圈光是故意公开的**（`bo` 不按队过滤，drawArmed 对每条槽位都画）。
    //   设计上也该如此：下一板要超高速，本来就该让对方看得见，不然就是纯偷袭。
    //   （对比：幻影球的 px 必须按队过滤 —— 它骗的是"信息"。这两者不是一回事。）
    check('★ 蓄力光圈是**公开**的：对手（灰方）的画布上也画得出来，而且它确实在渲染',
      fxD.frames >= 3 && fxD.strokes[ARMED_COLOR] > 0,
      `帧 ${fxD.frames}，红光描边 ${fxD.strokes[ARMED_COLOR] || 0}`);

    await shot(C, 'skill-boost-armed.png');
    await shot(B, 'skill-mobile-wind.png');
    await shot(A, 'skill-desktop-phantom.png');

    // =====================================================================
    console.log('\n7) 页面报错检查');
    const errs = (s) => s.errors.filter((e) => e.indexOf('[网络]') !== 0);
    for (const [label, sess] of [['青（电脑）', A], ['黄（手机）', B],
      ['红（电脑）', C], ['灰（电脑）', D]]) {
      const e = errs(sess);
      check(`${label} 页面没有未捕获异常（含控制台报错）`, e.length === 0, e.slice(0, 3).join(' ; '));
    }

    console.log('\n8) 截图');
    const files = ['skill-phantom-opponent.png', 'skill-phantom-caster.png',
      'skill-boost-armed.png', 'skill-mobile-wind.png', 'skill-desktop-phantom.png'];
    const sizes = files.map((f) => {
      const p = path.join(SHOT_DIR, f);
      return fs.existsSync(p) ? fs.statSync(p).size : 0;
    });
    check('截图都非空', sizes.every((s) => s > 3000), JSON.stringify(sizes));

    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  } catch (e) {
    console.log('\n探针中断: ' + e.message + '\n');
    fail += 1;
  } finally {
    for (const s of [A, B, C, D]) { try { if (s) s.ws.close(); } catch (e) { /* ignore */ } }
    await sleep(300);
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch (e) { /* ignore */ }
    await sleep(800);
    console.log(`（浏览器进程已清理，profile: ${PROFILE}）`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

main();
