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
    check('★ 量具：两个阶段都真的接到了球（弹拍 ≥ 12 次）',
      A.bounces >= 12 && B.bounces >= 12, `A=${A.bounces} B=${B.bounces}`);
    check('★ 量具：球速真的量出来了（中位 ≥ 300px/s）', A.speedMed >= 300 && B.speedMed >= 300,
      `A=${Math.round(A.speedMed)} B=${Math.round(B.speedMed)}`);
    check('★ 量具：速度样本足够（每阶段 ≥ 20 个有效速度段）', A.segs >= 20 && B.segs >= 20,
      `A=${A.segs} B=${B.segs}`);
    table(A, B);

    console.log('5) 判定');
    check('★ 落后量与球速成正比，比例 ≈ 1/26（即落后恒等于 38ms 的球程，与帧率/球速无关）',
      A.lagRatioX > 12 && A.lagRatioX < 60 && B.lagRatioX > 12 && B.lagRatioX < 60,
      `A=${A.lagRatioX.toFixed(1)}ms B=${B.lagRatioX.toFixed(1)}ms`);
    check('★ 两个阶段都发生了丢分（说明对照组真的在比赛，不是一方空转）',
      A.goals + B.goals > 0, `A=${A.goals} B=${B.goals}`);
    check('★ 上帝视角（B）几乎不丢分 —— 证明本地 RTT≈0 时"看得准就能接到"',
      B.goals <= 2, `B 丢了 ${B.goals} 分`);
    check('★ 只看画面（A）更容易漏 —— 那部分来自**渲染落后**，不是网络延迟',
      A.goals > B.goals, `A 丢 ${A.goals} 分 / B 丢 ${B.goals} 分`);
    check('★ "球被画在拍子身上"的帧确实存在（就是玩家看到的"球穿过拍子"）',
      A.overlapFrames > 0, `A=${A.overlapFrames} 帧，B=${B.overlapFrames} 帧`);

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
