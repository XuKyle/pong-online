'use strict';

/**
 * AI 接球诊断（临时工具，需要服务端带 PONG_DEBUG_BOT=1 启动）。
 *
 * 现象：三档难度下 h1（AI 击球）事件都是 0 —— AI 一次也没把球打回来。
 * "离球 120px 内"的比例还有 70%，但判定阈值其实是 48+9=57px。
 *
 * 这里把球逼近拍面那一段**逐帧**打出来，连同 AI 的内部决策
 * （bt = [方向, 目标y, 瞄准误差]），用来分辨是"瞄错了"还是"来不及动"。
 *
 * 用法: node tools/diag-ai.js [level] [ms]
 */

const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3100;
const WSU = `ws://127.0.0.1:${PORT}/ws`;
const LEVEL = Number(process.argv[2] || 2);
const MS = Number(process.argv[3] || 15000);
const PADDLE_H = 96, BALL_R = 9;
const CATCH = PADDLE_H / 2 + BALL_R;      // 57
const FACE = 800 - 26 - 14 - 9;           // 751，AI 拍面

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(WSU);
const states = [];
let joined = null;
ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.t === 'joined') joined = m;
  if (m.t === 'state') states.push(m);
});
ws.on('error', () => {});

(async () => {
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'create', solo: true, level: LEVEL }));
  let g = 0;
  while (!joined && g++ < 100) await sleep(30);
  console.log(`人机房间 ${joined.code}  难度=${joined.level}(${joined.botName})`);
  console.log(`拍面 x=${FACE}，判定阈值 |球y - 拍y| <= ${CATCH}px\n`);

  await sleep(MS);
  try { ws.close(); } catch (e) {}
  await sleep(100);

  // ★ 球改成数组之后（分裂球）快照字段是 bs = [[id, x, y], ...]，
  //   单球时代的 b 已经不存在。这里统一补上 b = 0 号球，下面的回放逻辑就不必逐个改 ——
  //   这是个只看快照的诊断工具，补一个只读的兼容字段没有副作用。
  //   （没补之前的表现：s.b 恒为 undefined，整段"逐帧回放"永远是空的，
  //     看起来像"球根本没飞到 x=620 右边"，跟真因完全无关。）
  for (const s of states) {
    if (!s.b && Array.isArray(s.bs) && s.bs[0]) s.b = s.bs[0];
  }

  if (states.length && states[0].bt === undefined) {
    console.log('!! 服务端没有输出 bt 字段 —— 请用 PONG_DEBUG_BOT=1 启动再看');
  }

  // 逐帧回放，按 k 连续且"球向右逼近"切段
  const groups = [];
  let cur = null;
  for (const s of states) {
    const ok = s.ph === 'playing' && s.b && s.b[0] > 620;
    if (!ok) { cur = null; continue; }
    if (cur && s.b[0] > cur[cur.length - 1].b[0]) cur.push(s);
    else { cur = [s]; groups.push(cur); }
  }

  console.log('=== 逐帧回放（球越过 x=620 之后）===');
  groups.slice(0, 4).forEach((g2, gi) => {
    console.log(`\n── 第 ${gi + 1} 球 ──`);
    console.log('   k     bx     by    拍y    偏差   AI方向  目标y  瞄准误差  冻结');
    for (const s of g2) {
      const bt = Array.isArray(s.bt) ? s.bt : [null, null, null];
      const d = s.b[1] - s.p[1];
      console.log(
        `${String(s.k).padStart(5)} ${s.b[0].toFixed(0).padStart(6)} ${s.b[1].toFixed(1).padStart(6)} `
        + `${s.p[1].toFixed(1).padStart(6)} ${d.toFixed(1).padStart(7)} `
        + `${String(bt[0]).padStart(6)} ${String(bt[1]).padStart(7)} ${String(bt[2]).padStart(8)} `
        + `${(s.fz && s.fz[1] ? s.fz[1] + 's' : '-').padStart(6)}`,
      );
    }
    const atFace = g2.filter((s) => s.b[0] >= FACE);
    if (atFace.length) {
      const s = atFace[0];
      const d = Math.abs(s.b[1] - s.p[1]);
      console.log(`   ⇒ 越过拍面那一刻：球y=${s.b[1].toFixed(1)} 拍y=${s.p[1].toFixed(1)} `
        + `偏差=${d.toFixed(1)} ${d <= CATCH ? '✓ 应接住' : '✗ 接不住'}`);
    } else {
      console.log('   ⇒ 这一球在到达拍面前就结束了（被拍面之前的墙/道具改写）');
    }
  });

  const ev = {};
  for (const s of states) if (Array.isArray(s.ev)) for (const e of s.ev) ev[e] = (ev[e] || 0) + 1;
  console.log(`\n事件: ${JSON.stringify(ev)}`);
  console.log(`快照 ${states.length} 条`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
