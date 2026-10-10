'use strict';

/**
 * 道具的"画出来了没有"验证（真实浏览器 + 真实画布）。
 *
 * 为什么不能用协议测试代替：test-rules / check-powerup 能证明
 * 「吃到了道具、效果数值对、双倍真的算两分」，但证明不了**画布上画了什么**。
 * canvas 是一块不透明的位图，DOM 里查不到，截图里也不好自动比对。
 *
 * 办法：给 CanvasRenderingContext2D 的 fillText / strokeText / arc 各打一层记录补丁，
 * 把 page 真正画上去的字符串和圆弧调用全部抓下来。于是
 *   「九种道具的图标有没有画错、有没有静默落到兜底那款」
 *   「冰冻 / 护盾 / 双倍 / 隐形四个叠加层有没有真的画出来」
 *   「隐形球生效时球到底是**没画**还是只画淡了一点」
 * 这三件事就变成了可以断言的字符串/数值比较 —— 不需要给页面加任何测试钩子。
 * （补丁必须赶在页面脚本之前注入，所以走 Page.addScriptToEvaluateOnNewDocument。）
 *
 * ★ 为什么连 arc 也要记：球不是用 fillText 画的，是 arc + fill。
 *   只记字符串的话，"球还有没有在画"这件事根本看不到，只能去信 __probe 报的透明度 ——
 *   那是"拿输入断言输入"。记了 arc 就能直接证明"全透明那几秒画布上确实一颗球都没有"。
 *
 * 两个前置条件都由本脚本自己起服务满足：
 *   PONG_FORCE_PU=0,1,...,8  每次生成按列表轮转 → 一局就能看全九种
 *                            （可用 PROBE_FORCE_PU=6 只出弧线球，单独验第 7 种）
 *   PONG_DEBUG_FX=1          每 3 秒给某个位刷一种效果 → 叠加层不用等球去碰
 * 等球自然碰到道具是碰运气，测不出稳定结论。
 *
 * 用法: node tools/probe-powerup-fx.js
 *       PROBE_FORCE_PU=6 node tools/probe-powerup-fx.js   # 只验弧线球图标
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('./cdp.js');

const PORT = Number(process.env.PROBE_PU_PORT) || 3110;
const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9431;
const SITE = `http://127.0.0.1:${PORT}`;
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
const ROOT = path.join(__dirname, '..');

// 客户端 POWERUP_STYLE 里那九个图标，写在这里是为了"独立地"断言一次 ——
// 如果直接从前端读出来再跟前端比，那只是在跟自己比。
const EXPECT_GLYPHS = ['+', '–', '»', '❄', '◍', '2×', '~', 'Y', '◌'];

// 让服务端按这个列表轮转生成道具。默认九种全来一遍；
// 调成 PROBE_FORCE_PU=6 就只出弧线球 —— 用来单独证明"客户端确实会画 ~"，
// 把"没画出来"和"只是没轮到"这两件事分开。
const FORCE_PU = process.env.PROBE_FORCE_PU || '0,1,2,3,4,5,6,7,8';
const WANT_TYPES = [...new Set(FORCE_PU.split(',').map((s) => Number(s.trim())))];
const WANT_GLYPHS = WANT_TYPES.map((t) => EXPECT_GLYPHS[t]).filter(Boolean);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
const note = (m) => console.log(`  · ${m}`);

/** 画布记录补丁。只记调用，不改任何行为。 */
const CANVAS_PATCH = `(() => {
  const rec = { text: [], arcs: [], n: 0 };
  window.__drawn = rec;
  const proto = CanvasRenderingContext2D.prototype;
  const wrap = (name) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (t) {
      if (typeof t === 'string') {
        rec.n += 1;
        if (rec.text.length < 4000) rec.text.push(t);
      }
      return orig.apply(this, arguments);
    };
  };
  wrap('fillText');
  wrap('strokeText');
  // 球体是 arc + fill 画的，字符串记录里看不到它。
  // 抓 arc 的 (x, y, r) 才能断言"全透明的时候画布上到底有没有球"。
  const origArc = proto.arc;
  if (typeof origArc === 'function') {
    proto.arc = function (x, y, r) {
      if (rec.arcs.length < 40000) rec.arcs.push([Math.round(x), Math.round(y), Math.round(r * 100) / 100]);
      return origArc.apply(this, arguments);
    };
  }
})()`;

function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PONG_FORCE_PU: FORCE_PU,
      PONG_DEBUG_FX: '1',
      // 弧线球得靠球随机撞上道具才生效，靠等就是碰运气；这个开关让球一直拐弯
      PONG_DEBUG_CURVE: '1',
      TEMP: TMP_DIR,
      TMP: TMP_DIR,
    },
    stdio: 'ignore',
  });
}

async function waitServer(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(SITE + '/');
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await C.sleep(200);
  }
  return false;
}

const drain = (sess) => C.evalx(sess, `(() => {
  const d = window.__drawn || {};
  const out = { text: (d.text || []).slice(), arcs: (d.arcs || []).slice() };
  if (d.text) d.text.length = 0;
  if (d.arcs) d.arcs.length = 0;
  return out;
})()`);

// 球半径 9。尾迹点的半径上限是 9 * (0.25 + 0.7 * (n-1)/n) ≈ 8.44，
// 道具圈是 21 起 —— 所以 r 落在 [8.7, 9.3] 的圆弧只可能是球本体。
const isBallArc = (a) => a[2] >= 8.7 && a[2] <= 9.3;

async function clickBtnText(sess, text) {
  const box = await C.evalx(sess, `(() => {
    const el = [...document.querySelectorAll('#overlayBody button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
  })()`);
  if (!box) return null;
  await C.realClick(sess, box.x, box.y);
  return box;
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const srv = startServer();
  const { child, profile } = C.startEdge({
    dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'edgepu',
  });

  const seenGlyphs = new Set();
  const puShots = [];
  const fxShots = [];
  let sess = null;

  try {
    console.log(`服务: ${SITE}（PONG_FORCE_PU=${FORCE_PU} PONG_DEBUG_FX=1）`);
    const up = await waitServer();
    check('带强制道具参数的测试服务已起来', up);
    if (!up) throw new Error('服务没起来');

    console.log('\n1) 打开页面并注入画布记录补丁');
    if (!await C.waitEdgeReady(DBG_PORT)) throw new Error('调试端口没起来');
    sess = await C.openPage({ dbgPort: DBG_PORT }, 'about:blank');
    const sanity = await C.evalx(sess, '1+1');
    check('取值通道正常（1+1=2）', sanity === 2, `得到 ${sanity}`);
    await sess.send('Page.addScriptToEvaluateOnNewDocument', { source: CANVAS_PATCH });
    await sess.send('Page.navigate', { url: SITE });
    const ready = await C.waitReady(sess, 'S');
    check('页面加载并完成脚本初始化', ready);
    if (!ready) throw new Error('页面未就绪');
    check('记录补丁已生效', await C.evalx(sess, '!!window.__drawn'));

    const kinds = await C.probe(sess);
    check('前端样式表有九款道具', kinds.puKinds === 9, String(kinds.puKinds));
    check('九款的图标各不相同且与预期一致',
      JSON.stringify(kinds.puGlyphs) === JSON.stringify(EXPECT_GLYPHS),
      JSON.stringify(kinds.puGlyphs));

    console.log('\n2) 开一局人机，让道具轮转生成');
    await C.waitFor(sess, 'window.__probe().connected === true', 10000, 'WebSocket 连接');
    const clicked = await clickBtnText(sess, '单人打 AI');
    check('点到了「单人打 AI」', !!clicked && clicked.text === '单人打 AI',
      clicked ? clicked.text : 'null');
    const joined = await C.waitFor(sess, 'window.__probe().mySide >= 0', 10000, '入房');
    check('已进入人机局', joined === true);
    await drain(sess);

    console.log('\n3) 连续观察：九种道具逐个抓拍 + 四个叠加层各拍一张');
    // 快进模式下每 4.5 秒轮一个，九种一轮，但球要是把某个道具吃了，
    // 下一次生成就整体后移 —— 留足余量。
    const deadline = Date.now() + 110000;
    const seenTypes = new Set();
    let prevFreeze = 0;
    let prevShield = 0;
    let prevDouble = false;
    let curveSeen = false;      // 弧线球是否生效过（快照里的 cv 非 0）
    let curveTail = 0;          // 生效时尾迹攒到了多少段
    let samples = 0;
    // 隐形球：把"我这一侧该看到多透明"和"这 170ms 里球到底画了没有"配成对。
    // ★ 配对是粗略的（透明度在采样点读、绘制是整个窗口累起来的），
    //   所以下面断言时留了一个窗口的宽容度，理由写在断言旁边。
    const invisSamples = [];
    let invisShot = false;

    while (Date.now() < deadline) {
      await C.sleep(170);
      const p = await C.probe(sess);
      samples += 1;

      const drawn = await drain(sess);
      drawn.text.forEach((s) => seenGlyphs.add(s));
      const ballDrawn = drawn.arcs.some(isBallArc);

      // 道具：按类型各拍一张
      // ★ 快照里是**数组** us（场上可以同时挂好几个），不是单数。
      //   这里原来读的是 p.powerup —— 字段早就换成数组了，于是整个抓拍环节
      //   静默失效（seenTypes 永远是空集），只在最后那条"九种都上过场"上报红。
      const list = Array.isArray(p.powerups) ? p.powerups : [];
      for (const u of list) {
        const t = u[2];
        if (!Number.isInteger(t) || seenTypes.has(t)) continue;
        seenTypes.add(t);
        const name = `pu-${t}-${(EXPECT_GLYPHS[t] || 'x').replace(/[^\w+–»❄◍×~◌]/g, '')}.png`;
        await C.shot(sess, SHOT_DIR, name);
        puShots.push({ t, x: u[0], y: u[1], file: name });
        note(`道具 ${t}（${EXPECT_GLYPHS[t]}）出现在 (${u[0]}, ${u[1]}) → ${name}`);
      }

      // 隐形样本：数组下标取"我这一队"看到的透明度
      if (typeof p.ballVis === 'number') {
        invisSamples.push({
          a: p.ballVis,
          ballDrawn,
          play: p.phase === 'playing' || p.phase === 'over',
        });
      }
      if (p.ballVis < 0.05 && (p.phase === 'playing' || p.phase === 'over') && !invisShot) {
        invisShot = true;
        await C.shot(sess, SHOT_DIR, 'fx-invis.png');
        fxShots.push('fx-invis.png');
        note(`球被隐形（我这一侧的透明度 ${p.ballVis}，还剩 ${(p.invis && p.invis[0]) || 0}s）→ fx-invis.png`);
      }

      // 叠加层：抓"从无到有"的那一刻
      // ★ 按文件名去重。同一个叠加层会反复出现（冰冻每 3 秒刷一次），
      //   不去重的话「拍了 3 张」可能全是冰冻 —— 循环会过早退出，
      //   护盾 / 双倍的图标还没被排空就下了断言，变成随机红。
      if (p.freeze[0] > 0 && prevFreeze === 0) {
        await C.shot(sess, SHOT_DIR, 'fx-freeze.png');
        if (!fxShots.includes('fx-freeze.png')) {
          fxShots.push('fx-freeze.png');
          note(`冰冻叠加层出现（剩 ${p.freeze[0].toFixed(2)}s）→ fx-freeze.png`);
        }
      }
      if (p.shield[0] > prevShield) {
        await C.shot(sess, SHOT_DIR, 'fx-shield.png');
        if (!fxShots.includes('fx-shield.png')) {
          fxShots.push('fx-shield.png');
          note(`护盾叠加层出现（${p.shield[0]} 层）→ fx-shield.png`);
        }
      }
      if (p.double[0] && !prevDouble) {
        await C.shot(sess, SHOT_DIR, 'fx-double.png');
        if (!fxShots.includes('fx-double.png')) {
          fxShots.push('fx-double.png');
          note('双倍得分叠加层出现 → fx-double.png');
        }
      }
      // 弧线球：拐弯的尾迹是"每帧描点"画出来的，只有球真的在拐时才存在
      if (p.curve) {
        curveSeen = true;
        curveTail = Math.max(curveTail, p.tail || 0);
        if (!fxShots.includes('fx-curve.png')) {
          await C.shot(sess, SHOT_DIR, 'fx-curve.png');
          fxShots.push('fx-curve.png');
          note(`弧线球生效（角速度 ${p.curve}，尾迹 ${p.tail} 段）→ fx-curve.png`);
        }
      }
      prevFreeze = p.freeze[0];
      prevShield = p.shield[0];
      prevDouble = p.double[0];

      // 四个叠加层必须**各自**拍到，不是"拍了四张"
      const fxDone = ['fx-freeze.png', 'fx-shield.png', 'fx-double.png', 'fx-invis.png']
        .every((f) => fxShots.includes(f));
      if (seenTypes.size === WANT_TYPES.length && fxDone && curveSeen
        && WANT_GLYPHS.every((g) => seenGlyphs.has(g))) break;
    }

    // ★ 收尾补一次排空。原因：上面那轮循环是"先 drain、后发现有新道具类型"的，
    //   最后一种道具被发现的同一轮就可能满足退出条件，而客户端把它画到 canvas 上
    //   也许正好落在这次 drain 之后 —— 不补这一下会误报"没画出来"。
    //   （真实故障不会因此漏掉：真没画的话，循环会一直跑到 deadline 再失败。）
    await C.sleep(400);
    (await drain(sess)).text.forEach((s) => seenGlyphs.add(s));

    note(`采样 ${samples} 次；抓到道具类型 ${[...seenTypes].sort().join(',') || '无'}`);

    console.log('\n4) 断言：九种道具都生成过、并且都画出来了');
    check(`${WANT_TYPES.length} 种道具都上过场`, seenTypes.size === WANT_TYPES.length,
      `只看到 ${[...seenTypes].sort().join(',')}`);
    for (let t = 0; t < EXPECT_GLYPHS.length; t += 1) {
      if (!WANT_TYPES.includes(t)) continue;   // 只出第 6 种时，别的本来就不该有
      const g = EXPECT_GLYPHS[t];
      check(`画布上出现第 ${t} 种的图标「${g}」`, seenGlyphs.has(g),
        `没画出来（画布上的字符串样本：${[...seenGlyphs].slice(0, 24).join(' ')
          .replace(/\s+/g, ' ')}）`);
    }
    check(`${WANT_TYPES.length} 张道具抓拍都拍到了`, puShots.length === WANT_TYPES.length,
      `${puShots.length} 张`);

    console.log('\n5) 断言：四个叠加层都画出来了');
    // 冰冻画的是「❄ 1.6s」这种带数字的文案，所以用前缀匹配
    const freezeTxt = [...seenGlyphs].filter((s) => /^❄ /.test(s));
    check('冰冻叠加层画出来了（形如「❄ 1.6s」）', freezeTxt.length > 0,
      JSON.stringify(freezeTxt.slice(0, 3)));
    const shieldTxt = [...seenGlyphs].filter((s) => /^×\d+$/.test(s));
    check('护盾层数画出来了（形如「×1」）', shieldTxt.length > 0,
      JSON.stringify(shieldTxt.slice(0, 3)));
    check('双倍得分标记画出来了（「×2」）', seenGlyphs.has('×2'));
    check('四个叠加层都各拍到一张',
      ['fx-freeze.png', 'fx-shield.png', 'fx-double.png', 'fx-invis.png']
        .every((f) => fxShots.includes(f)),
      JSON.stringify(fxShots));

    console.log('\n5c) 断言：隐形球真的把球"藏起来了"（看画布，不看状态）');
    // 只统计正在打球（或已结束但仍在画球）的窗口，倒计时/等待期间的窗口不算数
    const play = invisSamples.filter((s) => s.play);
    // 把前后两个采样的透明度也带上：判断一个窗口是不是压在渐变边界上要用到
    const withNbr = play.map((s, i) => Object.assign({
      prevA: play[i - 1] ? play[i - 1].a : null,
      nextA: play[i + 1] ? play[i + 1].a : null,
    }, s));
    const off = withNbr.filter((s) => s.a < 0.05);
    check('★ 观察到"我这一侧被隐形"发生过（透明度真的到过 0）', off.length > 0,
      `${off.length} / ${play.length} 个窗口全透明`);

    // ★ 只对"深隐形"窗口断言：它自己 + 前一个 + 后一个采样都是全透明。
    //   采样窗口有 170ms 宽，而"透明度从 0 跨到可见"（淡出尾巴 / 淡入开头）
    //   只占其中十几毫秒 —— 窗口边界正好压在上面时，那一段**确实应该**画球，
    //   因为那一刻透明度还没降到 0。这不是给断言留宽容度，而是把边界窗口
    //   **排除出去**：要断言的是"已经完全透明的那些窗口里一颗球都不该有"。
    //   判断依据不是拍脑袋定的阈值，是窗口两端的实际透明度（见下面的明细输出）。
    const deep = withNbr.filter((s) => s.a < 0.05 && s.prevA !== null && s.prevA < 0.05
      && s.nextA !== null && s.nextA < 0.05);
    const badDeep = deep.filter((s) => s.ballDrawn);
    check('★ 完全透明那几秒，画布上**一颗球都没有**（不是"画淡一点"）',
      deep.length > 0 && badDeep.length === 0,
      `深隐形窗口 ${deep.length} 个，其中仍然画了球的 ${badDeep.length} 个`);
    const boundary = off.filter((s) => deep.indexOf(s) < 0);
    if (boundary.length) {
      note(`压在渐变边界上的窗口 ${boundary.length} 个（不计入上面的断言）：`);
      boundary.slice(0, 6).forEach((s) => note(
        `  前一个采样 a=${s.prevA} → 本窗口 a=${s.a} → 后一个采样 a=${s.nextA}｜画了球=${s.ballDrawn}`));
    }
    // ★ 对照组：看得见的时候球几乎每个窗口都画了（否则上面那条毫无意义）
    const on = withNbr.filter((s) => s.a >= 0.99);
    const onRate = on.length ? on.filter((s) => s.ballDrawn).length / on.length : 0;
    check('★ 对照组：看得见的时候球几乎每个窗口都画了（否则上面那条毫无意义）',
      on.length > 0 && onRate >= 0.8,
      `可见窗口 ${on.length} 个，其中画了球的占 ${(onRate * 100).toFixed(0)}%`);
    check('★ 透明度出现过中间值（说明是渐变，不是"啪"地消失）',
      play.some((s) => s.a > 0.05 && s.a < 0.95),
      `取到过的值: ${[...new Set(play.map((s) => s.a))].join(',')}`);
    check('隐形提示文案画出来了（形如「球被隐形 · 靠预判 2.2s」）',
      [...seenGlyphs].some((s) => /^球被隐形/.test(s)),
      JSON.stringify([...seenGlyphs].filter((s) => /隐形/.test(s)).slice(0, 3)));

    console.log('\n5b) 断言：弧线球的"飘"在客户端确实成立');
    check('★ 弧线球状态下发到了客户端（快照 cv 非 0）', curveSeen,
      'PONG_DEBUG_CURVE 开着却一次都没看到 cv，说明这条链路断了');
    // 尾迹是每帧采样球的位置攒出来的，至少要 2 段才画得出来。
    // 只验"状态对"是不够的 —— 尾迹不画的话玩家只觉得球有点飘，看不出原因。
    check('★ 尾迹采样真的在积累（≥2 段才画得出来）', curveTail > 1, `tail=${curveTail}`);

    console.log('\n6) 页面报错检查');
    const errs = sess.errors.filter((e) => e.indexOf('[网络]') !== 0);
    check('没有未捕获异常', errs.length === 0, errs.slice(0, 3).join(' ; '));

    console.log(`\n抓拍文件（${SHOT_DIR}）:`);
    [...puShots.filter((s) => s.file).map((s) => `  ${s.file}  (道具 ${s.t})`),
      ...fxShots.map((f) => `  ${f}`)].forEach((l) => console.log(l));

    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  } catch (e) {
    console.log('\n探针中断: ' + e.message + '\n');
    fail += 1;
  } finally {
    try { if (sess) sess.ws.close(); } catch (e) {}
    await C.sleep(300);
    C.killEdge(child);
    try { srv.kill(); } catch (e) {}
    await C.sleep(600);
    console.log(`（浏览器与服务进程已清理，profile: ${profile}）`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

main();
