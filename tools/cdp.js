'use strict';

/**
 * 探针共用的 CDP 基础设施。
 *
 * 为什么抽出来：两个探针（双人对战 / 人机对战）各自维护一套 CDP 代码，
 * 一旦其中一份改了超时或事件订阅，另一份就悄悄跑在旧语义上 —— 那种不一致
 * 不会报错，只会让某一边的结论失去可比性。
 *
 * ★ Edge 必须带 TEMP/TMP 重定向：无头浏览器的 url_fetcher 缓存写的是系统 Temp，
 *   不受 --user-data-dir 控制，跑一次能往 C 盘塞上百 MB。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个无头 Edge，返回 { child, profile } */
function startEdge(opts) {
  const dbgPort = opts.dbgPort;
  const tmpDir = opts.tmpDir;
  const profile = path.join(tmpDir, (opts.profileName || 'edgeprobe') + '_' + Date.now());

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) throw new Error('找不到 Edge 可执行文件');

  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${dbgPort}`,
    `--user-data-dir=${profile}`,
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
    env: { ...process.env, TEMP: tmpDir, TMP: tmpDir },
    stdio: 'ignore',
    detached: false,
  });

  return { edge, child, profile };
}

async function waitEdgeReady(dbgPort, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
      if (r.ok) return true;
    } catch (e) { /* not yet */ }
    await sleep(200);
  }
  return false;
}

function killEdge(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch (e) { /* ignore */ }
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

async function newTab(dbgPort) {
  const res = await fetch(`http://127.0.0.1:${dbgPort}/json/new?about:blank`, { method: 'PUT' });
  return res.json();
}

async function openPage(opts, url) {
  const tab = await newTab(opts.dbgPort);
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

/** 真实鼠标手势。★ 不能用 element.click()：它的 isTrusted=false，不算用户手势，音频闸门不会放行 */
async function realClick(sess, x, y) {
  await sess.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(30);
  await sess.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function shot(sess, shotDir, name) {
  const r = await sess.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotDir, name), Buffer.from(r.data, 'base64'));
}

module.exports = {
  EDGE_CANDIDATES,
  sleep,
  startEdge,
  waitEdgeReady,
  killEdge,
  connectTarget,
  evalx,
  newTab,
  openPage,
  waitReady,
  waitFor,
  probe,
  key,
  realClick,
  shot,
};
