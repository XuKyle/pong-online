'use strict';

/**
 * 蓝粘球在**多球场上**的取证（真实浏览器 + 真实画布）。
 *
 * 玩家报的 bug（2026-10-11）：
 *   "当场上有多个球的时候有点bug，就是一个球被粘住的时候其它球会消失。"
 *
 * 根因：服务端 sk2 只下发 [x, y, 槽位]、**不带球 id**。
 *   客户端的旧前提是"同一时刻最多只有一颗球被粘住"，于是把硬贴坐标**无条件套给
 *   每一颗球**（见 index.html 里那段循环）。多球时，被粘住的那颗的坐标会被
 *   套到其余几颗身上 —— 它们全被画到同一个点上，看起来就是"其它球消失了"。
 *
 * 修法：sk2 变成 [球id, x, y, 槽位]，客户端**按 id 匹配**只硬贴那一颗。
 *
 * 为什么必须用真实浏览器取证：bug 在**渲染层**（画了几颗），
 *   协议测试只能证明"字段形状对了"，证明不了"画布上确实还有两颗球"。
 *   所以这里沿用 probe-powerup-fx 那套画布补丁：抓每一次 arc 调用，
 *   数其中"整圆 + 半径≈9"的个数 —— 那就是画面上球的个数。
 *
 * 怎么稳定造出"一颗粘住 + 一颗在飞"：靠真人接到粘球是碰运气，
 *   所以服务端加了调试开关 PONG_DEBUG_STICK_MULTI=1（默认关闭，线上走不到），
 *   发球时直接把 0 号球挂到左拍上、再放一颗向右飞的真球。
 *
 * 判据：
 *   ① 前置 —— 服务端确实报"有一颗球被粘住"（sk2 非 0）且场上有 ≥2 颗球
 *   ② ★ 画布上确实画了 ≥2 颗球（这就是"其它球没有消失"）
 *   ③ ★ 画出来的两颗球**不在同一个位置**（不是被叠在一起）
 *   ④ ★ sk2 带上了球 id，且 id 指向场上真实存在的球
 *
 * 用法: node tools/probe-stick-multi.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('./cdp.js');

const PORT = Number(process.env.PROBE_SM_PORT) || 3113;
const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9433;
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

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
const note = (m) => console.log(`  · ${m}`);

/** 画布记录补丁。只记调用，不改任何行为。
 *
 * ★★ 关键：**按帧分组**。同一个 rAF 回调里画的弧归为一组 —— 那才是"这一帧画了几颗球"。
 *   不分组的话，60ms 采样窗口会覆盖好几帧，同一颗球在不同帧的位置被全部算进来：
 *   实测"服务端报 2 颗球，画布上数到 10 颗"，而且里面必然有同一颗球前后两帧的
 *   重复坐标（相距 0px）。用它断言"两颗球不在同一位置"必然假红。
 *   钩 rAF 是最准的分帧方式：页面画球就在它自己的 rAF 回调里。
 */
const CANVAS_PATCH = `(() => {
  const rec = { frames: [], cur: null };   // frames 里每项是一帧的 arc 列表
  window.__drawn = rec;
  // 钩 rAF：每次回调开始前开一个新帧
  const origRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return origRaf.call(window, function (ts) {
      rec.cur = [];
      rec.frames.push(rec.cur);
      if (rec.frames.length > 60) rec.frames.shift();
      return cb(ts);
    });
  };
  const proto = CanvasRenderingContext2D.prototype;
  const origArc = proto.arc;
  if (typeof origArc === 'function') {
    proto.arc = function (x, y, r, a0, a1) {
      if (!rec.cur) { rec.cur = []; rec.frames.push(rec.cur); }
      if (rec.cur.length < 4000 && rec.frames.length <= 60) {
        rec.cur.push([x, y, r, a0, a1]);
      }
      return origArc.apply(this, arguments);
    };
  }
  // 取"最近这几帧里**球最多的那一帧**"，而不是简单取最后一帧：
  //   最后一帧可能正好是倒计时/结算帧（一颗球都没画），读出来是 0 反而像产品坏了。
  //   帧是按 rAF 边界分好的，所以"最多的那一帧"仍然是**一帧之内**的数字，
  //   不会把同一颗球在不同帧的位置混起来。
  window.__drainFrame = function () {
    let best = [];
    for (let i = 0; i < rec.frames.length; i += 1) {
      const f = rec.frames[i];
      const n = f.filter(function (a) {
        return a[2] >= 8.7 && a[2] <= 9.3
          && (a[3] === null || Math.abs(a[3]) < 0.01)
          && (a[4] === null || Math.abs(a[4] - Math.PI * 2) < 0.01);
      }).length;
      const bestN = best.filter(function (a) {
        return a[2] >= 8.7 && a[2] <= 9.3
          && (a[3] === null || Math.abs(a[3]) < 0.01)
          && (a[4] === null || Math.abs(a[4] - Math.PI * 2) < 0.01);
      }).length;
      if (n > bestN) best = f;
    }
    const out = best.slice();
    rec.frames.length = 0;
    rec.cur = null;
    return out;
  };
})()`;

function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PONG_DEBUG_STICK_MULTI: '1',
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

// ★★ 取"最新一帧"的弧，而不是采样窗口里所有帧的并集。
//   并集会把同一颗球在不同帧的位置全算进来（实测数到 10 颗、还带 0px 的重复坐标），
//   那是量具问题 —— 拿它断言"两颗球没被叠在一起"必然假红。
// ★★ 取数前**先让出完整一帧**：上一轮 drain 把 frames 清空了，如果紧接着就取，
//   页面的 rAF 还没跑到（两轮之间只隔了一个 CDP 往返，可能 < 16ms），
//   frames 是空的 ⇒ 数到 0 颗，看着像"球全没了"，其实是没画完就被读了。
//   实测就是这个假红（连跑两次，第二次 0 颗）。
async function drain(sess) {
  // 用页面的 rAF 等满一帧，再让第二帧落地 —— 保证 frames 里至少有一整帧
  await C.evalx(sess, `new Promise((res) => {
    requestAnimationFrame(() => requestAnimationFrame(() => res(1)));
  })`);
  const arcs = await C.evalx(sess,
    'typeof window.__drainFrame === "function" ? window.__drainFrame() : []');
  return { arcs: Array.isArray(arcs) ? arcs : [] };
}

// 球特征：**整圆 + 半径 ≈ 9**。
// ★ 必须同时要求整圆：黑洞螺旋弧 / 冷却环都是部分弧，只按半径分不开（probe-powerup-fx 踩过）。
const BALL_R = 9;
const isBallArc = (a) => a[2] >= BALL_R - 0.3 && a[2] <= BALL_R + 0.3
  && (a[3] === null || Math.abs(a[3]) < 0.01)
  && (a[4] === null || Math.abs(a[4] - Math.PI * 2) < 0.01);

async function clickBtnText(sess, text) {
  // ★ 取 rect 之前必须 scrollIntoView：九宫格把菜单撑到 ~680px 之后，
  //   中后段按钮的 rect 中心点会落到视口外，realClick 点了等于没点 ——
  //   症状是"入房超时"，与"产品坏了"完全同形。
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
    dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'edgesm',
  });

  let sess = null;

  try {
    console.log(`服务: ${SITE}（PONG_DEBUG_STICK_MULTI=1）`);
    const up = await waitServer();
    check('带粘球多球开关的测试服务已起来', up);
    if (!up) throw new Error('服务没起来');

    console.log('\n1) 打开页面并注入画布记录补丁');
    if (!await C.waitEdgeReady(DBG_PORT)) throw new Error('调试端口没起来');
    sess = await C.openPage({ dbgPort: DBG_PORT }, 'about:blank');
    check('取值通道正常（1+1=2）', await C.evalx(sess, '1+1') === 2);
    await sess.send('Page.addScriptToEvaluateOnNewDocument', { source: CANVAS_PATCH });
    await sess.send('Page.navigate', { url: SITE });
    const ready = await C.waitReady(sess, 'S');
    check('页面加载并完成脚本初始化', ready);
    if (!ready) throw new Error('页面未就绪');
    check('记录补丁已生效', await C.evalx(sess, '!!window.__drawn'));

    console.log('\n2) 开一局人机（服务端会直接造出"一颗粘住 + 一颗在飞"）');
    await C.waitFor(sess, 'window.__probe().connected === true', 10000, 'WebSocket 连接');
    const clicked = await clickBtnText(sess, '单人打 AI');
    check('点到了「单人打 AI」', !!clicked && clicked.text === '单人打 AI',
      clicked ? clicked.text : 'null');
    const joined = await C.waitFor(sess, 'window.__probe().mySide >= 0', 10000, '入房');
    check('已进入人机局', joined === true);

    console.log('\n3) 逐帧采样：数画布上的球 + 看服务端的粘球标记');
    // 粘球只持续 STICK_MS=1s，等入房加上倒计时，要在球被放出去之前抓到。
    // 采样密一点（每 60ms 一次），并且在"发现 sk2 非 0"时立刻定格。
    let hit = null;          // 抓到的那一帧：sk2 + 画布弧
    let sawMulti = null;     // 另一帧：场上球数 ≥2（拿不到粘球时的备选）
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const p = await C.probe(sess);
      if (p.phase !== 'playing' && p.phase !== 'over') { await C.sleep(60); continue; }
      const drawn = await drain(sess);
      const balls = drawn.arcs.filter(isBallArc);
      const ballCount = p.balls ? p.balls.length : 0;
      const sk2 = p.stuckBall;
      if (sk2 && sk2.length === 4 && (!hit || balls.length > hit.ballCount)) {
        hit = {
          sk2,
          ballCount,
          balls: balls.slice(),
          // ★ __probe 里 balls 是 [[x,y],...]（不带 id），球 id 单独在 ballIds 里。
          ids: (p.ballIds || []).slice(),
        };
      }
      if (ballCount >= 2 && !sawMulti) sawMulti = { ballCount, balls: balls.length };
      // 抓够了就停
      if (hit && hit.balls.length >= 2) break;
      await C.sleep(60);
    }

    if (hit) {
      note(`抓到粘球帧：sk2=[id=${hit.sk2[0]}, ${hit.sk2[1]}, ${hit.sk2[2]}, slot=${hit.sk2[3]}]，`
        + `服务端报 ${hit.ballCount} 颗球，画布上数到 ${hit.balls.length} 颗`);
      await C.shot(sess, SHOT_DIR, 'stick-multi.png');
      note('已截图 tools/shots/stick-multi.png');
    } else {
      note('没抓到"sk2 非 0"的帧（粘球只持续 1 秒，可能错过）');
    }

    // ---- 断言 ----
    check('前置：服务端确实报"有一颗球被粘住"（拿到了 sk2）', !!hit,
      hit ? '' : '整个采样窗口里一次都没看到粘住的球');
    if (hit) {
      check('★ sk2 带球 id：是 [球id, x, y, 槽位] 四元组',
        Array.isArray(hit.sk2) && hit.sk2.length === 4 && Number.isInteger(hit.sk2[0]),
        JSON.stringify(hit.sk2));
      check('★ sk2 里的球 id 指向场上真实存在的球',
        hit.ids.indexOf(hit.sk2[0]) >= 0,
        `id=${hit.sk2[0]} 场上 ballIds=${JSON.stringify(hit.ids)}`);
      check('★ 场上是多球（≥2 颗）—— 不然这条测不出玩家报的 bug',
        hit.ballCount >= 2, `服务端报 ${hit.ballCount} 颗`);
      check('★★ 画布上确实画了 ≥2 颗球（"其它球消失"没有发生）',
        hit.balls.length >= 2, `画布上数到 ${hit.balls.length} 颗`);
      if (hit.balls.length >= 2) {
        // 两颗球被画在同一个点上 = 还是"叠在一起"了，只是肉眼看着像一颗
        let minDist = Infinity;
        for (let i = 0; i < hit.balls.length; i += 1) {
          for (let j = i + 1; j < hit.balls.length; j += 1) {
            minDist = Math.min(minDist,
              Math.hypot(hit.balls[i][0] - hit.balls[j][0], hit.balls[i][1] - hit.balls[j][1]));
          }
        }
        check('★★ 画出来的球**不在同一位置**（不是被叠在一起冒充两颗）',
          minDist > BALL_R * 2, `最近两颗相距 ${minDist.toFixed(1)}px（球直径 ${BALL_R * 2}px）`);
      }
    }
    check('前置：场上确实出现过两颗球（调试开关生效）', !!sawMulti,
      sawMulti ? `观察到 ${sawMulti.ballCount} 颗` : '一次都没看到多球');

  } catch (e) {
    console.error('探针异常：', e && e.message);
    fail += 1;
  } finally {
    if (sess) { try { await sess.close(); } catch (e) { /* ignore */ } }
    try { child.kill(); } catch (e) { /* ignore */ }
    try { srv.kill(); } catch (e) { /* ignore */ }
    if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
    process.exit(fail ? 1 : 0);
  }
}

main();
