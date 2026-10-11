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
  // 抓 arc 的 (x, y, r, a0, a1) 才能断言"全透明的时候画布上到底有没有球"。
  // ★★ 必须连**起止角**一起抓：只看半径会把别的弧误判成球。
  //   实测过一次：黑洞的螺旋弧半径是 HOLE_R*(0.34…0.82)，HOLE_R=34 时
  //   这段区间覆盖到 8.3~27.9 —— 半径 9 恰好落在里面，于是"黑洞在场"会被
  //   当成"还画着球"，报成"全透明时画布上还有球"（假红）。
  //   球的特征是**整圆**（0 → 2π），螺旋弧/冷却环都是部分弧，用角度一票区分。
  const origArc = proto.arc;
  if (typeof origArc === 'function') {
    proto.arc = function (x, y, r, a0, a1) {
      if (rec.arcs.length < 40000) {
        rec.arcs.push([
          Math.round(x), Math.round(y), Math.round(r * 100) / 100,
          typeof a0 === 'number' ? a0 : null,
          typeof a1 === 'number' ? a1 : null,
          // ★★ 第 6 项：**画这一条弧的那一帧，我这一侧的可见度是多少**。
          //   逐帧配对是这条断言唯一站得住的形式 —— 原来靠"窗口两端的采样"近似，
          //   而采样窗口有 170ms 宽（叠上 CDP 往返实际更长），
          //   完全可能在这段里走完"透明 → 可见 → 透明"，两端都读到 0 但中间画了球。
          //   实测就是这么红的：被判成球的弧是同一颗球在 3 帧里的位置（x 399→394→391），
          //   两端透明度都是 0，看着像"全透明还在画球"，其实是那个窗口里球短暂可见过。
          //   弧一旦带上自己那一帧的可见度，"这一帧该不该画"就成了可判定的事实。
          (window.__probe && typeof window.__probe().ballVis === 'number')
            ? window.__probe().ballVis : null,
        ]);
      }
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
// 什么算"球"：半径在球半径（9）附近的**整圆**。
// ★ 必须同时要求整圆：黑洞的螺旋弧半径最高到 HOLE_R*0.82=27.9、最低到 8.3，
//   半径这一维根本分不开它和球（实测踩过，见 INJECT 里 arc 补丁的注释）。
const isBallArc = (a) => a[2] >= 8.7 && a[2] <= 9.3
  && (a[3] === null || Math.abs(a[3]) < 0.01)
  && (a[4] === null || Math.abs(a[4] - Math.PI * 2) < 0.01);

async function clickBtnText(sess, text) {
  // ★ 取 rect 之前必须 scrollIntoView：九宫格把菜单撑到 ~680px 之后，
  //   1280×820 下中后段按钮的 rect 中心点会落到视口外，realClick 点了等于没点
  //   —— 症状是"入房超时"，与"产品坏了"完全同形（probe-solo / probe-mobile 同样踩过）。
  const box = await C.evalx(sess, `(() => {
    const el = [...document.querySelectorAll('#overlayBody button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
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
      // 诊断用：把"被当成球"的那几条弧的原始记录留下（只在 badDeep 出现时打印）
      const ballArcs = drawn.arcs.filter(isBallArc).slice(0, 4);

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
      // ★★ 这里记录**窗口两端**的透明度（aBefore 是排空前、aAfter 是排空后再读一次）。
      //   只记一个端点是这条断言偶发红的根因（实测跑 7 次红 1 次）：
      //   drain 覆盖 170ms，而"透明度从 0.25 跨到 0"只占十几毫秒 ——
      //   窗口边界正好压在那一段时，球在窗口开头**确实应该**被画出来，
      //   但采样点读到的 a 可能已经是 0，于是被算进"深隐形"，报成"全透明的窗口里还画了球"。
      //   两端都读之后，这种窗口天然被排除：真正"全程透明"的窗口两端都会是 0。
      let aAfter = null;
      if (typeof p.ballVis === 'number') {
        aAfter = await C.evalx(sess,
          'typeof window.__probe().ballVis === "number" ? window.__probe().ballVis : null');
      }
      if (typeof p.ballVis === 'number') {
        invisSamples.push({
          a: p.ballVis,
          aAfter: typeof aAfter === 'number' ? aAfter : p.ballVis,
          ballDrawn,
          ballArcs,
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
    // ★ 阈值与客户端自己的判据一致：index.html 里球体绘制开头是
    //   `if (vis <= 0.004) continue;` —— 0.004 以上就会画（alpha 极低，肉眼看不见）。
    //   写 0.05（"看着已经透明了"）比客户端宽 12 倍，会把"客户端本来就该画"的帧算进来。
    const HIDDEN_EPS = 0.004;
    const off = play.filter((s) => s.a <= HIDDEN_EPS);
    check('★ 观察到"我这一侧被隐形"发生过（透明度真的到过 0）', off.length > 0,
      `${off.length} / ${play.length} 个窗口全透明`);

    // ★★★ 判据用**逐帧配对**，不再用"窗口两端的采样近似"。
    //   为什么必须逐帧：采样窗口 170ms（叠 CDP 往返实际更长），
    //   而隐形道具可以在这段里走完「透明 → 可见 → 透明」（连续吃两个道具、
    //   或淡出尾巴紧接着另一次淡入）。两端都读到 0，中间那几帧球却是**该画**的。
    //   实测证据：被判成球的弧是同一颗球在 3 帧里的位置（x=399→394→391，y=23→26→28），
    //   而窗口两端透明度都是 0 —— 看着像"全透明还在画球"，其实是采样分辨率不够。
    //   现在每条弧自带"画它的那一帧我看到多透明"（arcs 记录的第 6 项），
    //   于是"这一帧该不该画"变成可判定的事实：**只有 vis<=0.004 的帧才必须没有球**。
    const HIDDEN_FRAMES = [];
    play.forEach((s) => {
      (s.ballArcs || []).forEach((a) => {
        if (typeof a[5] === 'number') HIDDEN_FRAMES.push({ a, s });
      });
    });
    const violations = HIDDEN_FRAMES.filter((x) => x.a[5] <= HIDDEN_EPS);
    check('★ 球在"我这一侧完全看不见"的那些帧里，一颗都没画（逐帧取证，不是窗口近似）',
      off.length > 0 && HIDDEN_FRAMES.length > 0 && violations.length === 0,
      `取证到 ${HIDDEN_FRAMES.length} 条球弧（带所属帧的可见度），`
      + `其中 ${violations.length} 条画在"看不见"的帧上`
      + (violations.length ? `：${JSON.stringify(violations.slice(0, 3).map((v) => v.a))}` : ''));
    // 对照组：可见度正常（>=0.99）的那些帧里，球几乎每帧都该画出来。
    // 没有它的话，上面那条可以被"球压根没画过"满足 —— 一条什么都不做的实现也能过。
    const visFrames = HIDDEN_FRAMES.filter((x) => x.a[5] >= 0.99);
    check('★ 对照组：看得见的那些帧里球确实画了（否则上面那条毫无意义）',
      visFrames.length > 0,
      `可见帧里的球弧 ${visFrames.length} 条`);
    if (violations.length) {
      note(`  ⚠ 违规的球弧（[x,y,r,a0,a1,vis]）：${JSON.stringify(violations.slice(0, 4).map((v) => v.a))}`);
    }
    // ★ 对照组：看得见的时候球几乎每个窗口都画了（否则上面那条毫无意义）
    const on = play.filter((s) => s.a >= 0.99);
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
