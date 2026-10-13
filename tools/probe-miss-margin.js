'use strict';

/**
 * "球穿板"服务端取证：区分**真漏球**和**判定漏判**。
 *
 * 原理：服务端在球逼近拍子最后一刻（face 前 30px 窗口内）持续记录
 *   catchMargin = |球心 y - 拍心 y| - 半拍长 - 球半径
 *   （见 server.js 的 recordMissApproach，漏球时随 missLog 一起下发）。
 * 于是每次失分都有一个客观的"拍子离球差多少"：
 *   catchMargin  <  -4   → 球贴着拍子（甚至重叠着）飞过去了，判定却没触发 ⇒ 真 bug
 *   catchMargin ∈ [-4, 4] → 亚子步分辨率（每子步最多走 ~3.75px），判不了
 *   catchMargin  >  4     → 拍子确实不在球的位置 ⇒ 合法的"够不着"（球速/拍速设计）
 *
 * 用法：先起服务（PORT=3100 node server.js），再
 *       node tools/probe-miss-margin.js        （默认困难人机，连打 3 局或 4 分钟）
 */

const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3100;
const WSU = `ws://127.0.0.1:${PORT}/ws`;
const LEVEL = Number(process.env.LEVEL) || 2;        // 困难：AI 失误少，回合拉得长，球速才涨得起来
const MAX_MATCHES = Number(process.env.MAX_MATCHES) || 3;
const TOTAL_MS = Number(process.env.TOTAL_MS) || 240000;

const W = 800, H = 500;
const BALL_R = 9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ball0 = (s) => (s && Array.isArray(s.bs) && s.bs[0]) ? s.bs[0] : null;

function client() {
  const ws = new WebSocket(WSU);
  const c = { ws, joined: null, states: [] };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'joined' || m.t === 'rejoined') c.joined = m;
    if (m.t === 'state') c.states.push(m);
  });
  ws.on('error', () => {});
  c.open = () => new Promise((res) => ws.once('open', res));
  c.send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.last = () => c.states[c.states.length - 1] || null;
  return c;
}

(async () => {
  const A = client();
  await A.open();
  A.send({ t: 'create', solo: true, level: LEVEL });
  let g = 0;
  while (!A.joined && g++ < 100) await sleep(30);
  if (!A.joined) { console.log('建房失败'); process.exit(2); }
  console.log(`人机房间 ${A.joined.code}（难度 ${LEVEL}），连打最多 ${MAX_MATCHES} 局 / ${TOTAL_MS / 1000}s\n`);

  // ---- 预测式接球手（与 tools/check-solo.js 同一套） ----
  let prevBall = null;
  const PADDLE_X0 = 40;
  function predictArrivalY(s, b) {
    if (!prevBall || !(s.k > prevBall.k)) return null;
    const dk = s.k - prevBall.k;
    if (dk <= 0 || dk > 10) return null;
    const vx = (b[1] - prevBall.x) / dk, vy = (b[2] - prevBall.y) / dk;
    if (vx <= 0.05) return null;
    const t = (PADDLE_X0 - b[1]) / vx;
    if (t < 0 || t > 4) return null;
    let y = b[2] + vy * t;
    const lo = BALL_R, hi = H - BALL_R, span = hi - lo;
    let m = (y - lo) % (2 * span);
    if (m < 0) m += 2 * span;
    return m <= span ? lo + m : lo + (2 * span - m);
  }
  function drive() {
    const s = A.last();
    const b = ball0(s);
    if (!b || !s.p || s.ph !== 'playing') { A.send({ t: 'input', dir: 0 }); return; }
    if (!prevBall || s.k > prevBall.k) prevBall = { k: s.k, x: b[1], y: b[2] };
    const target = predictArrivalY(s, b);
    const want = (target === null) ? b[2] : target;
    const d = want - s.p[0];
    A.send({ t: 'input', dir: Math.abs(d) < 6 ? 0 : (d > 0 ? 1 : -1) });
  }
  const driver = setInterval(drive, 25);

  // ---- 收集 missLog（按 matchId 去重） ----
  const seen = new Set();
  const misses = [];
  const t0 = Date.now();
  let matchesDone = 0;
  while (matchesDone < MAX_MATCHES && Date.now() - t0 < TOTAL_MS) {
    await sleep(100);
    for (const s of A.states) {
      if (s.t !== 'state' || s.ph !== 'over' || !Array.isArray(s.mr)) continue;
      for (const ms of s.mr) {
        const key = `${s.mi}:${ms.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        misses.push({ mi: s.mi, ...ms });
      }
    }
    matchesDone = new Set(A.states.filter((s) => s.ph === 'over' && s.mi).map((s) => s.mi)).size;
  }
  clearInterval(driver);
  try { A.ws.close(); } catch { /* ignore */ }

  // ---- 分析 ----
  console.log(`\n共收集 ${misses.length} 次漏球（${matchesDone} 局，${((Date.now() - t0) / 1000).toFixed(0)}s）\n`);
  if (!misses.length) { console.log('没有拿到任何 missLog —— 对局可能没打完'); process.exit(2); }

  const buckets = { bug: [], fuzzy: [], legit: [], none: [] };
  for (const ms of misses) {
    const ap = ms.approach;
    if (!ap || !ap.paddles || !ap.paddles.length) { buckets.none.push(ms); continue; }
    const pad = ap.paddles[0];
    const speed = Math.hypot(ap.ball.vx, ap.ball.vy);
    ms._pad = pad; ms._speed = speed;
    if (pad.catchMargin < -4) buckets.bug.push(ms);
    else if (pad.catchMargin < 4) buckets.fuzzy.push(ms);
    else buckets.legit.push(ms);
  }

  for (const ms of misses) {
    const side = ms.concededBy === 0 ? '我(左)' : 'AI(右)';
    if (!ms._pad) { console.log(`#${String(ms.id).padStart(2)} ${side} 漏球  （无 approach 记录）`); continue; }
    const tag = ms._pad.catchMargin < -4 ? '★BUG' : ms._pad.catchMargin < 4 ? '模糊' : '合法';
    console.log(
      `#${String(ms.id).padStart(2)} ${side}  margin=${ms._pad.catchMargin.toFixed(1).padStart(5)}px  ` +
      `球速=${String(ms._speed.toFixed(0)).padStart(4)}  球y=${ms.approach.ball.y}  拍y=${ms._pad.y}  [${tag}]`
    );
  }

  console.log(`\n判定分布（<-4px = 疑似真 bug，±4px = 亚子步判不了，>4px = 够不着）:`);
  console.log(`  ★BUG 嫌疑 : ${buckets.bug.length}`);
  console.log(`  模糊区间   : ${buckets.fuzzy.length}`);
  console.log(`  合法漏球   : ${buckets.legit.length}`);
  console.log(`  无记录     : ${buckets.none.length}`);
  if (buckets.bug.length) {
    console.log('\n★BUG 嫌疑明细:');
    for (const b of buckets.bug) {
      console.log(`  漏球#${b.id} ${b.concededBy === 0 ? '左(我)' : '右(AI)'} ` +
        `margin=${b._pad.catchMargin} 球速=${b._speed.toFixed(0)} 球y=${b.approach.ball.y} 拍y=${b._pad.y}`);
    }
  }

  process.exit(buckets.bug.length ? 1 : 0);
})().catch((e) => {
  console.error('异常: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
