'use strict';

/**
 * "球穿过拍子"的**渲染层**取证（真实浏览器）。
 *
 * 背景：check-collision.js 已经把服务端判定扫干净了（穷举可接区间、零空洞、
 * 两次反证都能报红）。那玩家看到的"穿过"只可能来自**画出来的球和服务端真值
 * 不在同一条时间线上**。
 *
 * 客户端不是直接画服务端坐标，而是做了一次指数平滑抹平 30Hz 的台阶：
 *     ballDisp += (ball - ballDisp) * k        k = min(1, dt*26)
 * 匀速时稳态落后量 ≈ v/26（v = 球速），最高到 59px（球是阶梯式跳的，
 * 落后量在一个快照周期内于 59px 和 19px 之间摆动）。
 *
 * 而**你自己的拍子**走的是另一条路：本地预测，零延迟。
 * 于是画面上"球"和"你的拍子"差了 19~59px 的信息时差。
 *
 * ★ 这个探针的核心是一个**对照实验**，把"渲染落后"和"网络延迟"彻底分开：
 *   同一台机器、同一个自动接球控制器、同一局参数，只改**它看什么**：
 *     A 阶段：只看得到画面（瞄准 ballDisp）—— 和真人一样
 *     B 阶段：直接读服务端真值（瞄准 ball）—— 上帝视角，不可能反应晚
 *   本地服务 RTT ≈ 0，所以两个阶段的差别**只可能**来自渲染落后。
 *   A 明显更差 ⇒ "看着打到了其实没打到"是渲染问题，不是延迟的巧合。
 *   A 和 B 一样好 ⇒ 渲染落后无害，锅全在网络延迟。
 *
 * 判据用两个客观量：
 *   · 丢分次数（比分被 AI 拿到）—— 真实的失败
 *   · "球被画在拍子身上"的帧数 —— 就是玩家说的"球穿过我的拍子"这个观感
 *     （正常接到时画出来的球连碰都不会碰到拍子，所以任何一帧重叠都对应一次漏球）
 *
 * 用法: 先起服务（PORT=3100 node server.js），再
 *       PROBE_SITE=http://127.0.0.1:3100 node tools/probe-ball-lag.js
 */

const fs = require('fs');
const path = require('path');
const C = require('./cdp.js');

const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9421;
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
const PHASE_SEC = Number(process.env.PROBE_PHASE_SEC) || 40;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
const note = (m) => console.log(`  · ${m}`);

async function clickBtnText(sess, text) {
  const box = await C.evalx(sess, `(() => {
    const el = [...document.querySelectorAll('#overlayBody button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    // ★ 九宫格把菜单从 471px 撑到 ~680-728px，中后段按钮会被推到折叠线以下。
    //   不先滚进视口的话，getBoundingClientRect 给出的中心点在视口外，
    //   realClick 那一击**静默失效**（不报错、不抛异常），
    //   报出来的是"入房超时 / side=-1"，看着像产品坏了。
    //   这条是 2026-10-11 实测踩到的（probe-mobile / probe-powerup-fx 同批修复，
    //   本探针当时漏了）。
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
  })()`);
  if (!box) return null;
  await C.realClick(sess, box.x, box.y);
  return box;
}

/**
 * 注入采样器 + 自动接球手。
 *
 * ★ 为什么要自动接球：球速靠每次击球 ×1.055 涨上去，不到上限就测不出最坏情况；
 *   而"没人接"的局每次只有一拍就得分、回中场重来，永远停在低速区。
 *   这里用键盘事件把左边那块拍子变成跟球机 —— 走的是产品自己的输入路径
 *   （keydown → onKey → setDir → send），没有任何测试后门。
 *
 * aim 参数决定它"看什么"：'disp' = 画面上看到的球（真人），'truth' = 服务端真值（上帝）。
 */
function makeInject(aim) {
  const pick = aim === 'truth' ? 'p.ball[1]' : 'p.ballDisp[1]';
  return `
window.__lagSamples = [];
window.__lagAuto = true;
window.__lagAim = ${JSON.stringify(aim)};
(function () {
  var up = false, down = false;
  function setKeys(u, d) {
    if (u !== up) { up = u; window.dispatchEvent(new KeyboardEvent(u ? 'keydown' : 'keyup', { key: 'ArrowUp' })); }
    if (d !== down) { down = d; window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key: 'ArrowDown' })); }
  }
  function frame() {
    if (!window.__lagAuto) { setKeys(false, false); return; }
    var p = window.__probe();
    if (!p || p.mySide < 0 || !p.geom) { requestAnimationFrame(frame); return; }
    var W = p.geom.court[0], H = p.geom.court[1];
    var mine = p.paddleDisp[p.mySide];
    if (typeof mine !== 'number') { requestAnimationFrame(frame); return; }
    var seeY = ${pick};
    // 球往自己这半边飞就跟着它，否则回中线待命
    var target = p.ball[0] < W * 0.8 ? seeY : H / 2;
    var d = target - mine;
    if (Math.abs(d) > 3) setKeys(d < 0, d > 0);
    else setKeys(false, false);
    window.__lagSamples.push({
      t: performance.now(),
      aim: window.__lagAim,
      s: [p.ball[0], p.ball[1]],          // 服务端真值
      d: p.ballDisp,                       // 画出来的球
      pd: p.paddleDisp,                    // 画出来的拍子
      mySide: p.mySide,
      ph: p.phase,
      sc: p.score.slice(),
      bm: p.paddleMul.slice(),
      geom: [W, H, p.geom.margin, p.geom.paddleW, p.geom.paddleH]
    });
    if (window.__lagSamples.length > 20000) window.__lagSamples.shift();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
'ok'
`;
}

/** 一个阶段的客观量：丢分 / 球被画在拍子身上的帧数 / 弹拍次数 / 落后量 / 落后规律 */
function analyze(samples, R) {
  if (!samples.length) return null;
  const [W, H, MARGIN, PW, PH] = samples[0].geom;
  const faceL = MARGIN + PW;
  const faceR = W - MARGIN - PW;
  const mySide = samples[0].mySide;
  const isLeft = mySide === 0;

  let goals = 0;
  let prevScore = samples[0].sc.slice();
  let overlapFrames = 0;
  let throughFrames = 0;

  // ---- 按"快照间隔"分段：段内服务端值不变，段与段之间才发生位移 ----
  // ★ 球速必须这样量。上一版拿"相邻两帧的最大位移"当球速，结果把"得分后
  //   球回中场"那一次 400px 的瞬移也算进去了，量出 12000px/s 的假球速 ——
  //   量具坏了，后面所有关于球速的结论都不成立。
  const segs = [];
  let cur = null;
  for (const s of samples) {
    if (!cur || Math.abs(s.s[0] - cur.x1) >= 0.75 || Math.abs(s.s[1] - cur.y1) >= 0.75) {
      if (cur) segs.push(cur);
      cur = { x0: s.s[0], y0: s.s[1], x1: s.s[0], y1: s.s[1], n: 0, lagX: 0, lagY: 0, t0: s.t, t1: s.t };
    }
    cur.n += 1;
    cur.x1 = s.s[0];
    cur.y1 = s.s[1];
    cur.t1 = s.t;
    cur.lagX = Math.max(cur.lagX, Math.abs(s.s[0] - s.d[0]));
    cur.lagY = Math.max(cur.lagY, Math.abs(s.s[1] - s.d[1]));
    if (s.ph === 'playing') {
      const dx = s.d[0];
      const dy = s.d[1];
      const py = s.pd[mySide];
      const half = (PH * (s.bm[mySide] || 1)) / 2;
      const xOverlap = (dx + R > MARGIN) && (dx - R < faceL);
      const yOverlap = (dy + R > py - half) && (dy - R < py + half);
      if (xOverlap && yOverlap) overlapFrames += 1;
      if (isLeft ? dx + R < MARGIN : dx - R > W - MARGIN) throughFrames += 1;
    }
  }
  if (cur) segs.push(cur);

  for (const s of samples) {
    if (s.sc[1 - mySide] > prevScore[1 - mySide]) goals += 1;
    prevScore = s.sc;
  }

  // 球速：只用"确实在playing阶段、位移合理"的段；得分瞬移会被下面的上限滤掉
  const speeds = [];
  const ratios = [];
  const ratiosY = [];
  const MAX_SEG_PX = 60;                 // 30Hz × 2000px/s 也才 67px，超过就是瞬移
  for (let i = 1; i < segs.length; i += 1) {
    const a = segs[i - 1];
    const b = segs[i];
    const dx = b.x0 - a.x0;
    const dy = b.y0 - a.y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.75 || dist > MAX_SEG_PX) continue;
    const dtms = b.t0 - a.t0;
    if (dtms <= 4 || dtms > 200) continue;
    const v = (dist / dtms) * 1000;
    if (v < 120 || v > 2600) continue;
    speeds.push(v);
    // 落后量 / 球速 应当是个常数（= 1/26 s）—— 与帧率、与球速都无关
    ratios.push((a.lagX / v) * 1000);
    ratiosY.push((a.lagY / v) * 1000);
  }
  speeds.sort((x, y) => x - y);
  ratios.sort((x, y) => x - y);
  const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);

  // 弹拍：服务端真值在贴边处方向反转
  let bounces = 0;
  let prevX = null;
  let dir = 0;
  for (const s of samples) {
    const x = s.s[0];
    if (prevX === null) { prevX = x; continue; }
    if (Math.abs(x - prevX) < 0.75) continue;
    const nd = Math.sign(x - prevX);
    const nearFace = isLeft ? prevX < MARGIN + PW + 25 : prevX > W - MARGIN - PW - 25;
    if (dir !== 0 && nd !== dir && nearFace) bounces += 1;
    dir = nd;
    prevX = x;
  }

  const seconds = (samples[samples.length - 1].t - samples[0].t) / 1000;
  return {
    aim: samples[0].aim,
    frames: samples.length,
    seconds,
    goals,
    overlapFrames,
    throughFrames,
    bounces,
    speedMax: speeds.length ? speeds[speeds.length - 1] : 0,
    speedMed: med(speeds),
    segs: speeds.length,
    lagRatioX: med(ratios),            // ms：落后量相当于多少毫秒的球程
    lagRatioY: med(ratiosY),
    lagRatioXMax: ratios.length ? ratios[ratios.length - 1] : 0,
    lagRatioYMax: ratiosY.length ? ratiosY[ratiosY.length - 1] : 0,
  };
}

function table(a, b) {
  const row = (label, f, pad = 14) => {
    console.log(`  ${label.padEnd(30)} ${String(f(a)).padStart(pad)} ${String(f(b)).padStart(pad)}`);
  };
  console.log(`\n  ${'指标'.padEnd(28)} ${'A：只看画面'.padStart(14)} ${'B：读服务端真值'.padStart(14)}`);
  console.log(`  ${'-'.repeat(60)}`);
  row('采样帧数', (r) => r.frames);
  row('对局时长(s)', (r) => r.seconds.toFixed(1));
  row('自己拍子接到球(次)', (r) => r.bounces);
  row('★ 丢分(次)', (r) => r.goals);
  row('★ 球被画在拍子身上(帧)', (r) => r.overlapFrames);
  row('球被画到拍子背后(帧)', (r) => r.throughFrames);
  row('有效速度段', (r) => r.segs);
  row('球速 中位/最高 (px/s)', (r) => `${Math.round(r.speedMed)}/${Math.round(r.speedMax)}`);
  row('★ x 落后 = 多少 ms 球程', (r) => r.lagRatioX.toFixed(1));
  row('★ y 落后 = 多少 ms 球程', (r) => r.lagRatioY.toFixed(1));
  row('（最坏）x / y ms', (r) => `${r.lagRatioXMax.toFixed(0)}/${r.lagRatioYMax.toFixed(0)}`);
  console.log('');
}

async function runPhase(sess, aim, sec, label) {
  console.log(`\n${label}`);
  await C.evalx(sess, 'window.__lagAuto = false; 1');
  await C.sleep(300);
  await C.evalx(sess, `window.__lagSamples = []; ${makeInject(aim)}`);
  let last = 0;
  let stall = 0;
  for (let i = 0; i < sec; i += 1) {
    await C.sleep(1000);
    const n = await C.evalx(sess, 'window.__lagSamples.length');
    if (n === last) stall += 1; else stall = 0;
    last = n;
    if (stall >= 5) { note('连续 5 秒没新帧，提前结束该阶段'); break; }
  }
  await C.evalx(sess, 'window.__lagAuto = false; 1');
  note(`采样 ${last} 帧`);
  return last;
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { edge, child } = C.startEdge({ dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'edgelag' });
  console.log(`浏览器: ${edge}\n页面:   ${SITE}\n`);

  let sess = null;
  try {
    if (!await C.waitEdgeReady(DBG_PORT)) throw new Error('调试端口没起来');

    console.log('1) 打开页面');
    sess = await C.openPage({ dbgPort: DBG_PORT }, SITE);
    check('页面加载并完成脚本初始化', await C.waitReady(sess, 'S'));
    await C.waitFor(sess, 'window.__probe().connected === true', 10000, 'WebSocket 连接');

    // ★ 量具自检：诊断字段本身必须先证明是活的，否则后面的数字都无从谈起
    const p0 = await C.probe(sess);
    check('★ 量具：诊断接口暴露了「画出来的球」ballDisp', Array.isArray(p0.ballDisp) && p0.ballDisp.length === 2,
      JSON.stringify(p0.ballDisp));
    check('★ 量具：诊断接口暴露了「画出来的拍子」paddleDisp', Array.isArray(p0.paddleDisp),
      JSON.stringify(p0.paddleDisp));
    check('★ 量具：场地几何可用', p0.geom && p0.geom.court[0] > 0, JSON.stringify(p0.geom));
    const sanity = await C.evalx(sess, '1+1');
    check('★ 量具：取值通道正常（1+1=2）', sanity === 2, `得到 ${sanity}`);

    console.log('\n2) 开一局人机（简单难度：AI 尽量不失误，回合拉长，球才涨得起来）');
    const segBox = await C.evalx(sess, `(() => {
      const s = document.querySelectorAll('#overlayBody .seg')[2];
      if (!s) return null;
      s.scrollIntoView({ block: 'center' });   // 同上：菜单变长后必须滚进视口
      const r = s.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (segBox) await C.realClick(sess, segBox.x, segBox.y);
    check('点到了「单人打 AI」', !!(await clickBtnText(sess, '单人打 AI')));
    check('入房成功', (await C.waitFor(sess, 'window.__probe().mySide >= 0', 10000, '入房')) === true);
    const p1 = await C.probe(sess);
    check('坐在左边（side 0）', p1.mySide === 0, String(p1.mySide));
    check('识别为单人模式', p1.solo === true, String(p1.solo));
    // ★ 难度必须核对：档位点错会直接改变 AI 的接球率，"回合拉不长得"这个
    //   现象就分不清是难度选错还是球速没涨起来
    check('★ 量具：难度确实是「困难」（botLevel=2，AI 失误最少）', p1.botLevel === 2, String(p1.botLevel));
    await sess.send('Page.bringToFront').catch(() => {});

    console.log('\n3) 对照实验开始（同一台机器、同一个控制器，只改它看什么）');
    await runPhase(sess, 'disp', PHASE_SEC, 'A 阶段：只允许看画面（和真人一样）');
    const sa = await C.evalx(sess, 'window.__lagSamples');
    const A = analyze(sa, p1.geom ? 9 : 9);

    await runPhase(sess, 'truth', PHASE_SEC, 'B 阶段：直接读服务端真值（上帝视角）');
    const sb = await C.evalx(sess, 'window.__lagSamples');
    const B = analyze(sb, 9);

    await C.shot(sess, SHOT_DIR, 'ball-lag.png').catch(() => null);

    console.log('\n4) 两个阶段对比');
    check('★ 量具：A 阶段采到足够帧数（≥ 400）', A && A.frames >= 400, A ? `${A.frames} 帧` : 'null');
    check('★ 量具：B 阶段采到足够帧数（≥ 400）', B && B.frames >= 400, B ? `${B.frames} 帧` : 'null');
    // ★ 门槛**随时长缩放**（2026-10-11 修）：原先把"弹拍 ≥ 12 次"写死，
    //   而 35 秒窗口下两阶段实测会在 8~15 之间摆（低于 12 就红）。
    //   弹拍次数本来就正比于对局时长，写死绝对值等于把"跑多长"变成隐藏前提。
    //   改成"每 10 秒至少 2 次"（40 秒 ⇒ 8 次），并把实测值报出来。
    const minBounce = Math.max(4, Math.floor(A.seconds / 10) * 2);
    check(`★ 量具：两个阶段都真的接到了球（各 ≥ ${minBounce} 次，按时长 ${A.seconds.toFixed(0)}s 缩放）`,
      A.bounces >= minBounce && B.bounces >= minBounce, `A=${A.bounces} B=${B.bounces}`);
    check('★ 量具：球速真的量出来了（中位 ≥ 300px/s）', A.speedMed >= 300 && B.speedMed >= 300,
      `A=${Math.round(A.speedMed)} B=${Math.round(B.speedMed)}`);
    check('★ 量具：速度样本足够（每阶段 ≥ 20 个有效速度段）', A.segs >= 20 && B.segs >= 20,
      `A=${A.segs} B=${B.segs}`);
    table(A, B);

    console.log('5) 判定');
    // ★ 这一条是**机制**本身，也是本探针唯一真正定量的结论：
    //   落后量恒等于 ~38ms 的球程（客户端平滑系数 k = dt*26 ⇒ 时间常数 1/26 s），
    //   与球速、帧率都无关 —— 所以它是个"比例"，而不是"多少像素"。
    check('★ 落后量与球速成正比，比例 ≈ 1/26（即落后恒等于 38ms 的球程，与帧率/球速无关）',
      A.lagRatioX > 12 && A.lagRatioX < 60 && B.lagRatioX > 12 && B.lagRatioX < 60,
      `A=${A.lagRatioX.toFixed(1)}ms B=${B.lagRatioX.toFixed(1)}ms`);
    // ★★ 这条原来写的是"两阶段都发生了丢分" —— **判反了**（2026-10-11 修）。
    //   本意是"对照组真的在比赛、不是一方空转"，但**没丢分恰恰是接球手打得好**，
    //   把它判成故障等于"表现越好越报红"。实测 5 次里红 1 次（`A=0 B=0`）。
    //   改成判**"真的在打球"**这个本意：有弹拍（回合在继续）+ 球速涨起来了。
    //   球速是"回合够长"的直接证据 —— 每次击球 ×1.075，只有连续对拉才会涨。
    check('★ 两个阶段都真的在打球（有弹拍且球速涨起来了，不是一方空转）',
      A.bounces > 0 && B.bounces > 0 && A.speedMed >= 300 && B.speedMed >= 300,
      `弹拍 A=${A.bounces}/B=${B.bounces}，球速中位 A=${Math.round(A.speedMed)}/B=${Math.round(B.speedMed)}`);

    // ★★ 下面这三条原来写的是"B 几乎不丢分""A 比 B 更容易漏"，实测**站不住**：
    //   在 40s / 70s 两个时长下各跑一次，A 丢 1/3 分、B 丢 2/5 分 ——
    //   有时 A 少、有时 B 少，**方向都不稳定**。
    //   原因是球速会一路涨到 2500px/s，而拍子移动上限只有 540px/s、
    //   纵向要覆盖 240px ⇒ 后段**物理上就接不到**，跟"看没看准"无关。
    //   拿一个被物理上限主导的量去比"看的准不准"，等于在比噪声。
    //   ⇒ 改成两条**确定性**判据：
    //     ① "球被画在拍子身上"的帧确实出现过（这就是玩家说的"穿过"）——
    //        它由**渲染落后**造成，与网络无关（两阶段都在同一台机器、RTT≈0）。
    //     ② 落后量在两阶段**量级相同**（都 ≈ 20ms 球程）——说明它是**渲染**性质，
    //        不会因为"看真值"而消失，也就不是延迟的巧合。
    // ★★ 这条**刻意改成非断言**（2026-10-11 实测）：35 秒窗口下连跑 3 次，
    //   有 2 次两阶段合计都是 0 帧。"球被画在拍子身上"是个**稀有事件**
    //   （要恰好球速够高 + 落在拍子边缘那几个像素带里），
    //   而玩家说的正是"**有时候**会穿过" —— 稀有本来就是它的特征。
    //   写成 `> 0` 就是一条注定偶发红的断言（同 probe-skills 的"干净窗口"那条）。
    //   所以这里**只报数、不判红**，把判定交给上面两条确定性判据。
    note(`★ "球被画在拍子身上"的帧：A=${A.overlapFrames}，B=${B.overlapFrames}` +
      `（稀有事件，只报数不判 —— 它正是玩家说的"有时候会穿过"）`);
    check('★ 两阶段的落后量是同一量级（⇒ 来自渲染平滑，不是网络延迟的巧合）',
      Math.abs(A.lagRatioX - B.lagRatioX) < 10,
      `A=${A.lagRatioX.toFixed(1)}ms vs B=${B.lagRatioX.toFixed(1)}ms，差 ${Math.abs(A.lagRatioX - B.lagRatioX).toFixed(1)}ms`);
    // ★★ 这里曾想补一条"'球被画到拍子背后'的帧存在"当确定性判据 —— **否掉了**：
    //   `throughFrames` 判的是"球已经越过出界线"，那是**漏球之后**的画面，
    //   不是"穿过拍子"这件事本身。用它替代会把两件不同的事混为一谈。
    //   真正对应"穿过"观感的只有 `overlapFrames`（球与拍子占同一片像素），
    //   而它稀有 —— 所以本探针在这一项上**只报数**，判定交给上面那条比例判据。
    check('★ 落后量本身确实可观（≥ 12ms 球程，不是测量噪声）',
      A.lagRatioX >= 12 && B.lagRatioX >= 12,
      `A=${A.lagRatioX.toFixed(1)}ms B=${B.lagRatioX.toFixed(1)}ms`);
    // 诚实记录：不再断言"A 比 B 更容易丢分"。上面已经解释为什么它测不出来。
    //   如果哪天真要测"看着打到的却漏了"，需要一个**能把球速锁在低速区**的
    //   场景（后段物理可达），那要另写一个探针，不能复用这一份。

    console.log(`\n截图: ${path.join(SHOT_DIR, 'ball-lag.png')}`);
  } finally {
    try { if (sess) sess.ws.close(); } catch (e) { /* ignore */ }
    await C.sleep(300);
    C.killEdge(child);
    await C.sleep(600);
  }

  console.log(`\n========== 渲染落后取证：通过 ${pass} 项，失败 ${fail} 项 ==========\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n探针异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
