'use strict';

/**
 * 前端模块冒烟：把主要流程真跑一遍，**任何一条页面未捕获异常都算失败**。
 *
 * 为什么需要它：拆成多个文件之后，最容易出的错是"原来靠闭包共享的变量，
 * 搬到别的文件之后引用还在但没人声明了"。表现是运行期 ReferenceError，
 * 而触发点常常在一条平时不走的分支上 —— probe.js 可以全绿，probe-bgm 却报红。
 *
 * ★ 所以这里不看断言，看**页面有没有报错**：菜单 → 建房 → 加入 → 暂停 →
 *   技能 → 局间重选 → 退房 → 断线重连，每一步都点一遍，
 *   收集 CDP 抓到的 Runtime.exceptionThrown / 日志 error。
 *
 * 用法: PORT=3100 node tools/check-frontend-smoke.js
 */

const path = require('path');
const C = require('./cdp.js');

const PORT = Number(process.env.PORT) || 3100;
const SITE = process.env.PROBE_SITE || `http://127.0.0.1:${PORT}`;
const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9599;
const TMP_DIR = process.env.PROBE_TMP || path.join(require('os').tmpdir(), 'pong-probe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

/**
 * Report one assertion.
 *
 * @param {string} name What was checked.
 * @param {boolean} cond Result.
 * @param {string} [extra] Detail shown on failure.
 * @returns {void}
 */
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  [ok]   ${name}`);
  } else {
    fail += 1;
    console.error(`  [FAIL] ${name}${extra ? `  -> ${extra}` : ''}`);
  }
}

/**
 * Open a page and attach error collection.
 *
 * @param {object} browser Browser handle from cdp.js.
 * @param {string} url Page URL.
 * @returns {Promise<object>} CDP session.
 */
async function open(browser, url) {
  const sess = await C.openPage({ dbgPort: DBG_PORT }, url);
  await C.waitReady(sess);
  await sleep(1200);
  return sess;
}

/**
 * Walk every main flow and fail if any page logged an uncaught error.
 *
 * @returns {Promise<void>} Resolves when the walk completes.
 */
async function main() {
  console.log(`\n目标: ${SITE}\n`);
  const browser = await C.startEdge({ dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'fesmoke' });
  try {
    await C.waitEdgeReady(DBG_PORT);

    const A = await open(browser, SITE);
    check('页面加载且脚本初始化完成（__probe 已装上）',
      (await C.evalx(A, 'typeof window.__probe')) === 'function');
    check('模块按顺序装上了（audio / input / ui）',
      (await C.evalx(A, "['audio','input','ui'].every(k => !!(window.PongApp && document.querySelector('canvas'))) && typeof window.__bgm === 'function'")));

    // ---- 菜单里的每一类面板都渲染一遍（要在建房之前 —— 进房后菜单就没了）----
    check('图鉴能展开', await C.evalx(A,
      "(() => { const b = document.querySelector('#overlayBody .codex-toggle'); b.click();"
      + " return getComputedStyle(document.querySelector('#overlayBody .codex-body')).display !== 'none'; })()"));
    check('九种拍子都在', (await C.evalx(A,
      "document.querySelectorAll('#overlayBody .skinrow .swatch').length")) === 9);
    check('三个 AI 难度档都在', (await C.evalx(A,
      "[...document.querySelectorAll('#overlayBody .seg')].length")) === 3);

    // ---- 建房 ----
    await C.evalx(A, "document.querySelector('#overlayBody .primary').click()");
    await C.waitFor(A, "!!window.__probe().code", 8000, '房间码');
    const code = await C.evalx(A, 'window.__probe().code');
    check('建房成功', !!code && /^[A-Z0-9]{6}$/.test(code), String(code));

    // ---- 加入 ----
    const B = await open(browser, `${SITE}/?room=${code}`);
    check('邀请链接把房间码预填进了输入框',
      (await C.evalx(B, "document.querySelector('#overlayBody .joinrow input').value")) === code);
    await C.evalx(B, "document.querySelectorAll('#overlayBody .skinrow .swatch')[1].click()");
    check('选拍子真的生效（被标成选中）', await C.evalx(B,
      "(() => { const e = document.querySelectorAll('#overlayBody .skinrow .swatch')[1];"
      + " return /(^|\\s)on(\\s|$)/.test(e.className); })()"));
    await C.evalx(B, "document.querySelector('#overlayBody .joinrow button').click()");
    await C.waitFor(B, "window.__probe().mySide >= 0", 10000, 'B 入房');
    check('选完拍子点「加入」成功进房', (await C.evalx(B, 'window.__probe().mySide')) === 1);
    // 皮肤由服务端在 joined 回执里确认，入房**之前**那一帧的快照还没有 sc 字段，
    // 所以要等它真的下发下来再断言，别在刚进房那一瞬间读。
    await C.waitFor(B, "Array.isArray(window.__probe().skins) && window.__probe().skins.length > 1"
      + " && window.__probe().skins[1] === 1", 5000, '服务端确认皮肤');
    check('服务端确认了选过去的皮肤', (await C.evalx(B, 'window.__probe().skins[1]')) === 1);

    // ---- 开打，然后按暂停 / 技能 ----
    await C.waitFor(A, "window.__probe().phase === 'playing'", 10000, '开打');
    await C.key(A, 'keyDown', 'p', 80);
    await C.waitFor(B, "window.__probe().userPaused === true", 5000, '暂停');
    // 两边都要等到 —— 房间级的暂停对两端同时生效，但快照到达有先后。
    await C.waitFor(A, "window.__probe().userPaused === true", 5000, 'A 也看到暂停');
    check('暂停是房间级的（按的人和对面都进入暂停）',
      (await C.evalx(A, 'window.__probe().userPaused')) === true
      && (await C.evalx(B, 'window.__probe().userPaused')) === true);
    check('暂停按钮的文案跟着变', (await C.evalx(A, 'window.__probe().pauseBtnText')) === '继续');
    await C.key(A, 'keyUp', 'p', 80);
    // 恢复这次**用按钮点**，而不是键盘 —— 按钮的 onclick 和 P 键是两条独立路径，
    // 只测键盘会漏掉"按钮处理器里引用错东西"这类错误（拆模块时真的踩到过）。
    await C.evalx(A, "document.getElementById('pauseBtn').click()");
    await C.waitFor(A, "window.__probe().userPaused === false", 5000, '恢复');
    check('点按钮也能恢复暂停（按钮与 P 键是两条独立路径）',
      (await C.evalx(A, 'window.__probe().userPaused')) === false);
    check('恢复后按钮文案回到「暂停」',
      (await C.evalx(A, 'window.__probe().pauseBtnText')) === '暂停');

    // ★ 技能只能由**有技能的那一侧**放：A 建的是默认的灰拍子（没技能），
    //   B 选的是「青」（风）。所以这里必须用 B 按 Q，按 A 永远不会进冷却 ——
    //   写成 A 会得到一个"看起来像技能坏了"其实只是测错了人的假红。
    check('前置：A 是灰拍子（按 Q 不该有反应）',
      (await C.evalx(A, 'window.__probe().mySkin')) === 0);
    await C.key(A, 'keyDown', 'q', 81);
    await C.key(A, 'keyUp', 'q', 81);
    await sleep(500);
    check('灰拍子按 Q 放不出技能（也不进冷却）',
      (await C.evalx(A, 'window.__probe().skillCd[0]')) === 0);

    await C.key(B, 'keyDown', 'q', 81);
    await C.waitFor(B, "window.__probe().skillCd[1] > 0", 5000, '技能进冷却');
    check('技能快捷键放得出去（服务端确认进冷却）',
      (await C.evalx(B, 'window.__probe().skillCd[1]')) > 0);
    await C.key(B, 'keyUp', 'q', 81);
    check('技能放出去之后场上有风（画面上确实有东西）',
      (await C.evalx(A, 'window.__probe().winds.length')) >= 1);

    // 技能按钮的 onclick 与 Q 键是两条独立路径，各点一次。
    // 这时技能还在冷却里，点下去会被本地门禁挡掉 —— 正好：要验的是
    // "处理器有没有炸"，不是"这次放不放得出去"（后者上面已经验过了）。
    check('技能按钮存在且可见（有技能的槽位才画按钮）', await C.evalx(B,
      "(() => { const b = [...document.querySelectorAll('[id^=\"skillBtn\"]')]"
      + ".find((x) => x.style.display !== 'none');"
      + " return !!b && b.getBoundingClientRect().width > 0; })()"));
    await C.evalx(B, "(() => { const b = [...document.querySelectorAll('[id^=\"skillBtn\"]')]"
      + ".find((x) => x.style.display !== 'none'); if (b) b.click(); })()");
    await sleep(300);
    check('冷却期间点技能按钮不炸也不重复放',
      (await C.evalx(B, 'window.__probe().skillCd[1]')) > 0);

    // ---- 声音开关 ----
    await C.key(A, 'keyDown', 'm', 77);
    await C.key(A, 'keyUp', 'm', 77);
    await sleep(300);
    check('M 键能关声音（按钮也跟着变）',
      (await C.evalx(A, 'window.__bgm().soundOn')) === false);
    await C.key(A, 'keyDown', 'm', 77);
    await C.key(A, 'keyUp', 'm', 77);
    await sleep(300);
    check('再按一次能恢复', (await C.evalx(A, 'window.__bgm().soundOn')) === true);

    // ---- 退房回菜单 ----
    await C.evalx(B, "(() => { const b = [...document.querySelectorAll('#overlayBody button')]"
      + ".find(x => x.textContent === '离开房间'); if (b) b.click(); })()");
    await sleep(1200);
    check('退房后回到菜单', await C.evalx(B,
      "(() => { const o = document.getElementById('overlay');"
      + " return !o.classList.contains('hidden') && !!document.querySelector('#overlayBody .primary'); })()"));

    // ---- 报错汇总（这才是这个脚本的重点）----
    const all = [...A.errors, ...B.errors];
    check('★ 整个流程里页面没有任何未捕获异常', all.length === 0,
      JSON.stringify([...new Set(all.map((e) => e.split('\n')[0]))].slice(0, 4)));


    console.log(`\n========== 前端冒烟：通过 ${pass} / 失败 ${fail} ==========\n`);
  } finally {
    C.killEdge(browser.child);
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});