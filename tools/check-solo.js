'use strict';

/**
 * 人机对战验证（纯协议层，不需要浏览器）。
 *
 * 要证明的不是"参数看起来像 AI"，而是**它真的在打球**，以及**难度真的不一样**：
 *   1. 建房就带 solo 标记，且对手座位立刻算"在场"（否则比赛会一直暂停）
 *   2. AI 的拍子会动、会朝着球去、会真的把球打回来（有 h1 击球事件）
 *   3. ★ 难度差异是可测量的：三档的**单 tick 最大位移**必须分别贴着各自的
 *      速度上限 —— 如果速度乘数没生效，简单档也会跑出困难档的速度。
 *      上界是确定性的（不可能靠运气突破），所以这条不会时红时绿。
 *   4. 人机房间不能被真人加入
 *
 * 为什么不断言"人类一方能否得分"：那取决于球路和 AI 恰好吃多少误差，是概率事件。
 * 写成断言就会时红时绿，那种测试比没有还糟 —— 这里只作观察输出。
 *
 * ★ 探针必须自己盯球打（见下面 driveHuman）。
 *   如果让"人类"完全不动，球一发到他这边就落地、判分给 AI，
 *   而按规则下一球还是发给失分方 —— 于是 AI 全场一次都不用碰球，
 *   h1 恒为 0。那样"AI 会不会接球"就变成了"首球有没有恰好发给 AI"的抽奖，
 *   断言时红时绿。（这个坑真踩过：同一条断言两次运行 29/29 和 26/29。）
 */

const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3100;
const WSU = `ws://127.0.0.1:${PORT}/ws`;
const OBSERVE_MS = Number(process.env.OBSERVE_MS) || 12000;

const W = 800, H = 500;
const PADDLE_SPEED = 540;
const TICK_HZ = 30;
// 三档的速度乘数（与服务端 BOT_PRESETS 对应）。这里刻意手写而不是从 server.js 读 ——
// 若有人改了服务端常量却忘了这些期望值，测试应该失败，而不是悄悄跟着变。
const SPEED_MUL = [0.66, 0.84, 1.0];
const LEVEL_NAMES = ['简单', '普通', '困难'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
function note(m) { console.log(`  · ${m}`); }

/**
 * 从快照里取 0 号球，返回 [id, x, y]；没有球就返回 null。
 *
 * ★ 球改成数组之后（分裂球会让场上同时有多个），快照字段从单数的 `b` 换成了
 *   `bs = [[id, x, y], ...]`。这个脚本原来读的是 `s.b` —— 那不会报错，
 *   只会让"球到底在哪儿"永远是 undefined，于是：
 *     · 带动拍子的那一手永远不动（人也不追球了）→ 拍子钉死在原地；
 *     · 球的 x/y 区间永远是空的 → span=0。
 *   报出来的是"球没跑动 / AI 没盯球"这种莫名其妙的假红，跟真因隔着两层。
 *   所以统一走这个函数，别再直接摸字段。
 */
const ball0 = (s) => (s && Array.isArray(s.bs) && s.bs[0]) ? s.bs[0] : null;

function client(name) {
  const ws = new WebSocket(WSU);
  const c = { name, ws, joined: null, error: null, states: [] };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'joined' || m.t === 'rejoined') c.joined = m;
    if (m.t === 'error') c.error = m;
    if (m.t === 'state') c.states.push(m);
  });
  ws.on('error', () => {});
  c.open = () => new Promise((res) => ws.once('open', res));
  c.send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.last = () => c.states[c.states.length - 1] || null;
  return c;
}

/** 跑一档难度，量出它到底跑多快、有没有真的在打球 */
async function runLevel(level) {
  const A = client('L' + level);
  await A.open();
  const t0 = Date.now();
  A.send({ t: 'create', solo: true, level });

  let guard = 0;
  while (!A.joined && guard++ < 100) await sleep(30);

  // 等第一帧 pr=[1,1]
  let prBothAt = null;
  guard = 0;
  while (prBothAt === null && guard++ < 200) {
    await sleep(30);
    const s = A.last();
    if (s && s.pr && s.pr[0] === 1 && s.pr[1] === 1) prBothAt = Date.now() - t0;
  }

  const deadline = Date.now() + OBSERVE_MS;

  // ★ 让"人类"自己盯着球打。
  //   不这么做的话，空闲拍子只能蹭到中路那一小段，球一到就落地，
  //   于是 AI 永远不用接球（详见文件头的说明）。
  //   这一手同时把"盯球比例"这条断言救活了 —— 空转时样本数是 0，
  //   而 0/0 会被算成 0%，报出来的是一句没有信息量的 0%。
  function driveHuman() {
    const s = A.last();
    const b = ball0(s);
    if (!b || !s.p || s.ph !== 'playing') { A.send({ t: 'input', dir: 0 }); return; }
    const d = b[2] - s.p[0];
    A.send({ t: 'input', dir: Math.abs(d) < 8 ? 0 : (d > 0 ? 1 : -1) });
  }
  const driver = setInterval(driveHuman, 25);

  let maxPerTick = 0;              // AI 单 tick 最大位移（用来量速度上限）
  // ★ 事件必须累积着看，且**按完整事件码**计数。
  //   两个坑：① 服务端发完即清，一个事件只活在一条 33ms 的快照里，
  //   每 60ms 取"最新一条"会漏掉近一半；② 按首字母聚合会把 h0（人类击球）
  //   和 h1（AI 击球）混成一个 h —— 那就根本没法判断 AI 到底有没有打到球。
  let scanned = A.states.length;
  const events = {};
  const phases = {};
  let ballXmin = Infinity, ballXmax = -Infinity, ballYmin = Infinity, ballYmax = -Infinity;
  let near = 0, nearBase = 0;
  let prevK = null, prevP1 = null;

  while (Date.now() < deadline) {
    await sleep(60);
    const fresh = A.states.slice(scanned);
    scanned = A.states.length;
    for (const s of fresh) {
      if (Array.isArray(s.ev)) {
        for (const e of s.ev) {
          if (typeof e === 'string') events[e] = (events[e] || 0) + 1;
        }
      }
      phases[s.ph] = (phases[s.ph] || 0) + 1;
      const b = ball0(s);
      if (b) {
        ballXmin = Math.min(ballXmin, b[1]);
        ballXmax = Math.max(ballXmax, b[1]);
        ballYmin = Math.min(ballYmin, b[2]);
        ballYmax = Math.max(ballYmax, b[2]);
        if (s.ph === 'playing' && b[1] > W / 2) {     // 球正在飞向 AI
          nearBase += 1;
          if (Math.abs(s.p[1] - b[2]) < 120) near += 1;
        }
      }
      if (prevK !== null && s.k > prevK) {
        const d = Math.abs(s.p[1] - prevP1) / (s.k - prevK);
        if (d > maxPerTick) maxPerTick = d;
      }
      prevK = s.k;
      prevP1 = s.p[1];
    }
  }

  clearInterval(driver);
  const res = {
    level,
    joined: A.joined,
    prBothAt,
    maxPerTick,
    aiTrackRatio: nearBase ? near / nearBase : 0,
    aiTrackSamples: nearBase,
    ballXspan: ballXmax > ballXmin ? ballXmax - ballXmin : 0,
    ballYspan: ballYmax > ballYmin ? ballYmax - ballYmin : 0,
    phases,
    events,
    aiHits: events.h1 || 0,          // AI 把球打回来
    humanHits: events.h0 || 0,       // 人类（自己盯球，所以会打到）
    aiConceded: events.g0 || 0,      // AI 丢分
    aiScored: events.g1 || 0,
    finalScore: A.last() ? A.last().s : null,
    totalStates: A.states.length,
  };
  try { A.ws.close(); } catch (e) {}
  return res;
}

(async () => {
  console.log(`\n目标: ${WSU}\n每档观察 ${OBSERVE_MS / 1000} 秒\n`);

  console.log('1) 建人机房间');
  const A0 = client('A0');
  await A0.open();
  A0.send({ t: 'create', solo: true, level: 2 });
  let g = 0;
  while (!A0.joined && g++ < 100) await sleep(30);
  check('建房成功', !!A0.joined, JSON.stringify(A0.joined));
  check('响应带 solo 标记（前端据此换界面）', A0.joined && A0.joined.solo === 1,
    JSON.stringify(A0.joined && A0.joined.solo));
  check('响应带难度等级', A0.joined && A0.joined.level === 2,
    JSON.stringify(A0.joined && A0.joined.level));
  check('响应带对手名称', A0.joined && A0.joined.botName === '困难',
    JSON.stringify(A0.joined && A0.joined.botName));
  check('真人坐左侧 side 0', A0.joined && A0.joined.side === 0);

  console.log('\n2) AI 座位立刻算"在场"（不需要第二个人）');
  await sleep(400);
  const s0 = A0.last();
  check('快照里双方都在场 pr=[1,1]',
    s0 && s0.pr && s0.pr[0] === 1 && s0.pr[1] === 1, JSON.stringify(s0 && s0.pr));
  check('比赛没有因为缺人而暂停', s0 && s0.ph !== 'waiting', s0 && s0.ph);

  console.log('\n3) 人机房间不能被真人加入');
  const B = client('B');
  await B.open();
  B.send({ t: 'join', code: A0.joined.code });
  await sleep(600);
  check('第二个人被拒绝', !!B.error, B.error ? B.error.msg : '(没有收到 error)');
  check('拒绝理由说清了是人机房间',
    !!B.error && B.error.msg.indexOf('人机') >= 0, B.error ? B.error.msg : '-');
  try { B.ws.close(); } catch (e) {}
  try { A0.ws.close(); } catch (e) {}
  await sleep(200);

  console.log('\n4) 三档难度真的在打球（每档 ' + (OBSERVE_MS / 1000) + ' 秒）');
  const results = [];
  for (let lv = 0; lv < 3; lv += 1) {
    const r = await runLevel(lv);
    results.push(r);
    const cap = (PADDLE_SPEED * SPEED_MUL[lv]) / TICK_HZ;
    console.log(`\n   —— ${LEVEL_NAMES[lv]}（速度上限 ${cap.toFixed(1)} px/tick）——`);
    note(`快照 ${r.totalStates} 条，相位分布 ${JSON.stringify(r.phases)}`);
    note(`球的横向活动范围 ${r.ballXspan.toFixed(0)} px / 纵向 ${r.ballYspan.toFixed(0)} px`);
    note(`AI 单 tick 最大位移 ${r.maxPerTick.toFixed(2)}（上限 ${cap.toFixed(1)}）`);
    note(`AI 盯球比例 ${(r.aiTrackRatio * 100).toFixed(0)}%（${r.aiTrackSamples} 个采样）`);
    note(`击球：AI ${r.aiHits} 次 / 人类 ${r.humanHits} 次`);
    note(`得分：AI ${r.aiScored} / 人类 ${r.aiConceded}   最终 ${JSON.stringify(r.finalScore)}`);
    note(`全部事件 ${JSON.stringify(r.events)}`);
  }

  console.log('\n5) 断言');
  for (const r of results) {
    const lv = r.level;
    const cap = (PADDLE_SPEED * SPEED_MUL[lv]) / TICK_HZ;
    const tag = LEVEL_NAMES[lv];
    check(`[${tag}] 球确实在场上跑动`,
      r.ballXspan > 100, `横向 span=${r.ballXspan.toFixed(0)}`);
    check(`[${tag}] 比赛主要在 playing 相位（没卡在别处）`,
      (r.phases.playing || 0) > r.totalStates * 0.3, JSON.stringify(r.phases));
    check(`[${tag}] AI 的拍子在动`,
      r.maxPerTick > 0.5, `max=${r.maxPerTick.toFixed(2)}`);
    check(`[${tag}] AI 朝着球移动（盯球比例 > 50%）`,
      r.aiTrackRatio > 0.5,
      `${(r.aiTrackRatio * 100).toFixed(0)}% (${r.aiTrackSamples} 采样)`);
    check(`[${tag}] ★ AI 真的把球打回来了（h1 事件 > 0）`,
      r.aiHits > 0, `h1=${r.aiHits}`);
    // ★ 上界是确定性的：速度乘数没生效的话，简单档也会跑出 ~18px/tick
    check(`[${tag}] 单 tick 位移没超过本档速度上限`,
      r.maxPerTick <= cap + 1.2, `实测 ${r.maxPerTick.toFixed(2)} > 上限 ${cap.toFixed(1)}`);
  }

  // 非平凡性：这个上界不能"因为拍子几乎不动"而白过。
  // 至少要有一档跑到接近自己的上限，才能证明速度真的被用满了。
  const sharpest = results.reduce((a, b) => (a.maxPerTick > b.maxPerTick ? a : b));
  const sharpCap = (PADDLE_SPEED * SPEED_MUL[sharpest.level]) / TICK_HZ;
  check('至少有一档把速度用到了接近上限（证明上界断言不是白过的）',
    sharpest.maxPerTick >= sharpCap * 0.7,
    `最快档=${LEVEL_NAMES[sharpest.level]} 实测 ${sharpest.maxPerTick.toFixed(2)} / 上限 ${sharpCap.toFixed(1)}`);

  const easy = results[0].maxPerTick;
  const hard = results[2].maxPerTick;
  check('困难档确实比简单档快（难度不是摆设）',
    hard > easy * 1.15,
    `简单 ${easy.toFixed(2)} vs 困难 ${hard.toFixed(2)}`);

  console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
