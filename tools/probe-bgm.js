'use strict';

/**
 * BGM 与自动播放闸门验证。
 *
 * 为什么必须用真浏览器跑：
 *   "音乐有没有在响""音量有没有真的淡入"是**运行期状态** —— 读代码看不出来，
 *   截图也看不出来（截图里没有声音）。只能让页面把状态吐出来量。
 *
 * 两条铁律（踩过的坑）：
 *   1. 无头浏览器**绝对不能**加 --autoplay-policy=no-user-gesture-required。
 *      加了之后 play() 无条件成功，"没交互不许出声"这条策略被绕过，闸门永远测不到。
 *   2. 触发用户手势只能走 CDP 的 Input.dispatchMouseEvent。
 *      element.click() 产生的事件 isTrusted === false，不算用户手势，永远测不过。
 *
 * 用法: node tools/probe-bgm.js [siteUrl]
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

const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9371;
const SITE = process.argv[2] || process.env.PROBE_SITE || 'http://127.0.0.1:3100';
// 探针的临时目录（无头浏览器的 profile 都落这里）。
// ★ 原来是**硬编码** 'F:\WorkBuddyData\wbtemp' —— 换台机器没这个目录就直接 mkdir 失败，
//   接手的人第一步就卡住。现在：PROBE_TMP 优先 → 本机那个 F 盘目录（本机 C 盘紧张，
//   profile 不能落系统 Temp）→ 系统临时目录。
const TMP_DIR = process.env.PROBE_TMP || (
  fs.existsSync('F:\\WorkBuddyData\\wbtemp')
    ? 'F:\\WorkBuddyData\\wbtemp'
    : path.join(require('os').tmpdir(), 'pong-probe')
);
const PROFILE = path.join(TMP_DIR, 'edgebgm_' + Date.now());

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
    const sess = { ws, seq: 0, pending: new Map(), handlers: Object.create(null) };

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
      resolve(sess);
    });
  });
}

async function evalx(sess, expr) {
  const r = await sess.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,     // ★ 不加这句，fetch().then() 拿到的是被序列化成 {} 的 Promise 壳
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面内异常: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result ? r.result.value : undefined;
}

const bgm = (sess) => evalx(sess, 'window.__bgm ? window.__bgm() : null');
const probe = (sess) => evalx(sess, 'window.__probe ? window.__probe() : null');

async function waitFor(sess, expr, timeoutMs, label) {
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

/** 真实鼠标手势：element.click() 的 isTrusted 是 false，骗不过自动播放策略 */
async function realClick(sess, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await sess.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
  await sleep(40);
  await sess.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
}

async function realKey(sess, k, vk, code) {
  await sess.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: k, code: code || k,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  await sleep(40);
  await sess.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k, code: code || k,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('找不到 Edge'); process.exit(1); }

  console.log(`浏览器: ${edge}`);
  console.log(`页面:   ${SITE}\n`);

  const child = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-swiftshader',
    // ★ 防后台节流三件套（见 probe.js 里的说明）：让后台标签也持续渲染，
    //   否则"画布/音频时间轴有没有推进"这类断言会随"谁在前台"随机变红。
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',            // 只静掉输出，不影响 paused/volume 这些属性
    '--autoplay-policy=user-gesture-required',   // ← 显式维持闸门，绝不豁免
    'about:blank',
  ], {
    env: { ...process.env, TEMP: TMP_DIR, TMP: TMP_DIR },
    stdio: 'ignore',
  });

  let sess = null;
  try {
    // 等调试端口
    let info = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/version`);
        info = await r.json();
        break;
      } catch (e) { await sleep(250); }
    }
    if (!info) throw new Error('调试端口没起来');

    const tab = await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    sess = await connectTarget(tab.webSocketDebuggerUrl);
    const pageErrors = [];
    sess.handlers['Runtime.exceptionThrown'] = [(p) => {
      const d = p.exceptionDetails || {};
      pageErrors.push((d.exception && d.exception.description) || d.text || 'unknown');
    }];

    await sess.send('Page.enable');
    await sess.send('Runtime.enable');
    await sess.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 820, deviceScaleFactor: 1, mobile: false,
    });
    await sess.send('Page.navigate', { url: SITE });

    await waitFor(sess, 'typeof window.__bgm === "function"', 15000, '__bgm 就绪');

    // ---------- 1. 资源 ----------
    console.log('1) 音频资源');
    const head = await evalx(sess, `fetch(window.__bgmSrc()).then(r => ({
      status: r.status,
      ct: r.headers.get('content-type'),
      ar: r.headers.get('accept-ranges'),
      len: r.headers.get('content-length')
    }))`);
    check('音频可访问', head && head.status === 200, head ? `status=${head.status}` : '无响应');
    check('Content-Type 是 audio/mpeg', !!head && /audio\/mpeg/.test(head.ct || ''), head && head.ct);
    check('支持 Range（否则循环要重下整首）',
      !!head && (head.ar || '').toLowerCase() === 'bytes', head && head.ar);
    note(`音频大小 ${head && head.len ? (Number(head.len) / 1048576).toFixed(2) : '?'} MB`);

    // 等元数据（duration 要能读出来才算真的解析成功）
    await waitFor(sess, `(window.__bgm().duration || 0) > 60`, 20000, '音频元数据');
    const st0 = await bgm(sess);
    // 这条断言的本意是"音频走自己项目里的文件，不是外链"——
    // 文件名不能写死：换一首 BGM 就假红了（换 ramble 时就真红过一次）。
    // 改成"落在本站 /audio/ 下，而且磁盘上真有这个文件"。
    const srcTail = decodeURIComponent((st0.src || '').split('/').pop() || '');
    const onDisk = path.join(__dirname, '..', 'public', 'audio', srcTail);
    const sameOrigin = (st0.src || '').indexOf(SITE.replace(/\/+$/, '') + '/audio/') === 0;
    check('音频源指向项目内路径（同源 /audio/ 且磁盘上真有）',
      sameOrigin && fs.existsSync(onDisk),
      `${st0.src} | 同源=${sameOrigin} 磁盘存在=${fs.existsSync(onDisk)}`);
    // 用户点名换的那首《游步欣愉》，别悄悄退回旧曲
    check('放的就是指定的那首 BGM', srcTail === 'bgm-ramble.mp3', srcTail);
    // 用户要求"声音略小一点点"：给一个区间，既不写死具体值，
    // 也不放任它哪天被改回大音量而没人发现。
    check('BGM 基准音量落在"略小"的区间（0.18~0.26）',
      st0.base >= 0.18 && st0.base <= 0.26, `base=${st0.base}`);
    check('整首都读进来了（duration > 60s）', st0.duration > 60, `${st0.duration}s`);
    check('循环播放已开启', st0.loop === true);

    // ---------- 2. 自动播放闸门 ----------
    console.log('\n2) 自动播放闸门（加载后未交互）');
    check('未交互时处于暂停', st0.paused === true, `paused=${st0.paused}`);
    // ★ 后半句才是关键：光看 paused 抓不到"音量已经偷偷爬满"
    check('未交互时音量恒为 0（防满音量起播）',
      st0.cur === 0 && st0.volume === 0,
      `cur=${st0.cur} volume=${st0.volume}`);

    // ---------- 3. 真实手势后应当起播并淡入 ----------
    console.log('\n3) 真实手势后起播与淡入');
    await realClick(sess, 60, 30);      // 点页眉标题上，安全位置，不触发游戏逻辑
    await sleep(220);
    const st1 = await bgm(sess);
    check('手势后开始播放', st1.paused === false, `paused=${st1.paused}`);
    check('音量在淡入（还没有一下到顶）',
      st1.volume > 0 && st1.volume < st1.base * 0.75,
      `volume=${st1.volume} base=${st1.base}`);

    await sleep(1700);
    const st2 = await bgm(sess);
    check('淡入完成后接近目标音量',
      Math.abs(st2.volume - st2.base) < 0.05,
      `volume=${st2.volume} 目标=${st2.base}`);

    // ---------- 4. 静音开关 ----------
    console.log('\n4) 静音开关与快捷键');
    const btnBefore = st2.btn;
    check('按钮显示为开启状态', /🔊/.test(btnBefore), btnBefore);

    await realKey(sess, 'm', 77, 'KeyM');
    await sleep(900);
    const st3 = await bgm(sess);
    check('M 键关闭声音', st3.soundOn === false);
    check('静音后目标音量归零', st3.want === 0, `want=${st3.want}`);
    check('音量已降下来（指数逼近，不断言恒等于 0）', st3.cur < 0.02, `cur=${st3.cur}`);
    check('按钮变为静音图标', /🔇/.test(st3.btn), st3.btn);

    await realKey(sess, 'm', 77, 'KeyM');
    await sleep(1200);
    const st4 = await bgm(sess);
    check('再按一次恢复出声', st4.soundOn === true && st4.paused === false);
    check('恢复后音量回升', st4.cur > 0.1, `cur=${st4.cur}`);

    // ---------- 5. 音频不能拖累游戏 ----------
    console.log('\n5) 音频与游戏逻辑互不干扰');
    // 先建房，让游戏逻辑真的跑起来。停在菜单页是收不到状态广播的，
    // 那样 snaps 和 tickRate 恒为 0，"音频有没有拖累它"就无从谈起。
    // ★ 必须点名「建房」那个按钮：菜单里第一个 button 已经**不是**它了 ——
    //   加了拍子皮肤之后，排在前面的是 4 个色块，`querySelector('#overlayBody button')`
    //   只会选中第一个色块（"选个皮肤"），房间压根没建起来。
    //   症状极具误导性：3 条红分别是"没进房间 / tickRate=0 / snaps=0"，
    //   看着像音频把主线程搞死了，其实只是按钮点错了。
    const clicked = await evalx(sess, `(function(){
      var b = document.querySelector('#overlayBody .primary');
      if (!b) return false; b.click(); return true;
    })()`);
    check('能触发建房', clicked === true);
    const inRoom = await waitFor(sess, 'window.__probe().mySide >= 0', 10000, '入房');
    check('已进入房间（收得到状态广播）', inRoom === true, String(inRoom));
    // 顺带验证刚修的那个除零问题：主线程被 AudioContext 创建阻塞后，tickRate 曾被污染成 Infinity
    await sleep(3200);
    const p1 = await probe(sess);
    check('页面未因音频产生未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('服务端推进频率可算出（不再被污染成 Infinity）',
      p1.tickRaw > 20 && p1.tickRaw < 45,
      `tickRaw=${p1.tickRaw} tickRate=${p1.tickRate}`);
    check('音频没有拖垮画面帧率（快照仍在正常到达）', p1.snaps > 30, `snaps=${p1.snaps}`);

    const shot = await sess.send('Page.captureScreenshot', { format: 'png' });
    const dir = path.join(__dirname, 'shots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bgm-state.png'), Buffer.from(shot.data, 'base64'));
    check('截图非空', shot.data.length > 1000);

    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  } catch (e) {
    console.log('\n探针异常: ' + (e && e.stack ? e.stack : e));
    fail += 1;
  } finally {
    try { if (sess) sess.ws.close(); } catch (e) {}
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch (e) {}
    await sleep(400);
    console.log(`（浏览器已清理，profile: ${PROFILE}）`);
    process.exit(fail ? 1 : 0);
  }
}

main();
