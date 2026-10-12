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

const fs = require('fs');
const path = require('path');
const { EDGE_CANDIDATES, startEdge, waitEdgeReady, killEdge } = require('./cdp-browser');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
