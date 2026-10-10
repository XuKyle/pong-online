'use strict';

/**
 * 「双人对抗 AI」验证（纯协议层，不需要浏览器）。
 *
 * 要证明的是这个模式**真的按设计跑**，而不是"参数看起来对"：
 *   1. 建房带 mode=coop、三个槽位、场地比经典模式高
 *   2. 第二个真人能靠房间码坐进 1 号槽位 —— 这是它和「单人打 AI」最大的区别
 *   3. ★ 两个真人**各自被锁在自己那半场**里（不能越过中线），
 *      这是"一人守一半"这句话的全部内容，破了这条就变成了两个人挤在同一块地方
 *   4. ★ AI 一个人守整条右边：它会接球（有 h2 事件），
 *      而且单 tick 位移不会超过"难度倍率 × coop 加成"的上界
 *   5. 回归：单人打 AI 的房间仍然不能被别人加入；不带 mode 建房仍是经典双人
 *
 * ★ 两个"人类"都必须自己盯球打（见 driveHuman）。
 *   让它们不动的话，球一发到左边就落地、判分给 AI，下一球还发给失分方 ——
 *   右边那块 AI 拍子全场一次都不用碰球，h2 恒为 0，
 *   "AI 会不会接球"就退化成抽奖。这个坑在 check-solo.js 里真踩过。
 *
 * 用法: node tools/check-coop.js        （需要本地服务已在 PORT 上跑着）
 */

const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3100;
const WSU = `ws://127.0.0.1:${PORT}/ws`;
const OBSERVE_MS = Number(process.env.OBSERVE_MS) || 14000;

// coop 的场地与速度参数。**手写而不是从 server.js 读** ——
// 有人改了服务端常量却忘了这里的期望值时，测试应该失败，而不是悄悄跟着变。
const CW = 960;
const CH = 800;
const PADDLE_H = 96;
const PADDLE_SPEED = 540;
const TICK_HZ = 30;
const COOP_BOT_SPEED_MUL = 1.4;
const SPEED_MUL = [0.66, 0.84, 1.0];
const LEVEL = 1;                                   // 用普通档
const AI_TICK_CAP = (PADDLE_SPEED * SPEED_MUL[LEVEL] * COOP_BOT_SPEED_MUL) / TICK_HZ;

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
 * ★ 球改成数组（分裂球）之后快照字段是 `bs`，单数的 `b` 已经不存在。
 *   直接读 `t.b` 不会报错，只会让"球在哪儿"永远是 undefined ——
 *   两个真人的追随逻辑于是每 25ms 都发一个 dir:0，拍子钉死不动，
 *   最后报成"两条左拍钉死不动"这种看起来像玩法坏了的假红。
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

async function waitFor(fn, ms = 6000, step = 30) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}

(async () => {
  console.log('\n========== 双人对抗 AI 验证 ==========\n');

  // ---------- 1. 建房 ----------
  console.log('1) 建房：布局与场地');
  const A = client('A');
  await A.open();
  A.send({ t: 'create', mode: 'coop', level: LEVEL });
  const gotA = await waitFor(() => !!A.joined || !!A.error);
  check('建房有回执', gotA, A.error ? A.error.msg : '超时');
  if (!A.joined) throw new Error('建房失败: ' + (A.error ? A.error.msg : '超时'));

  check('回执带 mode=coop', A.joined.mode === 'coop', String(A.joined.mode));
  check('回执说明有三个槽位', A.joined.n === 3, String(A.joined.n));
  check('建房的人坐在 0 号槽位', A.joined.side === 0, String(A.joined.side));
  check('★ 场地比经典模式高（960x800）',
    A.joined.wh && A.joined.wh[0] === CW && A.joined.wh[1] === CH,
    JSON.stringify(A.joined.wh));

  await waitFor(() => !!A.last());
  let s = A.last();
  check('快照下发三条拍子位置', Array.isArray(s.p) && s.p.length === 3, JSON.stringify(s.p));
  check('快照里的场地尺寸与回执一致',
    s.wh && s.wh[0] === CW && s.wh[1] === CH, JSON.stringify(s.wh));
  check('快照带 coop 标记', s.coop === 1 && s.md === 'coop', `md=${s.md} coop=${s.coop}`);
  check('★ 只有 0 号和 2 号在场 —— 1 号还空着等第二个真人',
    s.pr[0] === 1 && s.pr[1] === 0 && s.pr[2] === 1, JSON.stringify(s.pr));
  check('★ 队友没来之前比赛是暂停的（不能让一个人先打起来）',
    s.ph === 'waiting', String(s.ph));
  check('两条左拍分别停在上半场和下半场的中间',
    Math.abs(s.p[0] - CH / 4) < 2 && Math.abs(s.p[1] - CH * 0.75) < 2,
    JSON.stringify([s.p[0], s.p[1]]));
  check('AI 那条停在场地中央',
    Math.abs(s.p[2] - CH / 2) < 30, String(s.p[2]));

  // ---------- 2. 第二个真人加入 ----------
  console.log('\n2) 第二个真人加入');
  const B = client('B');
  await B.open();
  B.send({ t: 'join', code: A.joined.code });
  const gotB = await waitFor(() => !!B.joined || !!B.error);
  check('第二个真人加入成功（单人打 AI 的房间是加不进去的，这是关键区别）',
    gotB && !!B.joined, B.error ? B.error.msg : '超时');
  if (!B.joined) throw new Error('加入失败: ' + (B.error ? B.error.msg : '超时'));

  check('他被安排到 1 号槽位（也就是下半场）', B.joined.side === 1, String(B.joined.side));
  check('他收到的模式与场地尺寸和房主一致',
    B.joined.mode === 'coop' && B.joined.wh[0] === CW && B.joined.wh[1] === CH,
    `${B.joined.mode} ${JSON.stringify(B.joined.wh)}`);

  const allIn = await waitFor(() => {
    const t = A.last();
    return t && t.pr && t.pr[0] === 1 && t.pr[1] === 1 && t.pr[2] === 1;
  });
  check('三个座位都到齐了', allIn, JSON.stringify(A.last() && A.last().pr));
  const started = await waitFor(() => {
    const t = A.last();
    return t && (t.ph === 'playing' || t.ph === 'countdown');
  });
  check('人到齐后比赛自动开始（不再停在 waiting）', started,
    A.last() && A.last().ph);

  // ---------- 3. 观察：两个真人各守半场、AI 守全场 ----------
  console.log(`3) 观察 ${OBSERVE_MS / 1000} 秒：两边都得真的在打球`);
  await waitFor(() => A.last() && A.last().ph === 'playing');

  // 两个"人类"各自盯球打。上半场那位只能在自己的半场里追，
  // 追不到就贴着中线停住 —— 这正是这个玩法的核心手感。
  const drive = (c, slot) => () => {
    const t = c.last();
    const b = ball0(t);
    if (!b || !t.p || t.ph !== 'playing') { c.send({ t: 'input', dir: 0 }); return; }
    const d = b[2] - t.p[slot];
    c.send({ t: 'input', dir: Math.abs(d) < 8 ? 0 : (d > 0 ? 1 : -1) });
  };
  const dA = setInterval(drive(A, 0), 25);
  const dB = setInterval(drive(B, 1), 25);

  let scanned = A.states.length;
  const events = {};
  let maxAiTick = 0;
  let prevK = null;
  let prevAi = null;
  let topMin = Infinity, topMax = -Infinity;      // 号 0 拍子（上半场）
  let botMin = Infinity, botMax = -Infinity;      // 号 1 拍子（下半场）
  let aiMin = Infinity, aiMax = -Infinity;        // 号 2 拍子（AI）
  const aiBad = [];                               // 越界帧（按当时倍率算出来的真越界）
  let samples = 0;

  const end = Date.now() + OBSERVE_MS;
  // ★ 观察窗不能写死。下面有一条断言要"两个真人都击到过球"（h0 与 h1 都出现），
  //   而那要求球的落点**上下两半场都出现过** —— 发球角度是随机的。
  //   实测 3 次里就出现过一次"4 个球全落在下半场"（h1=4 / h0=0），报成
  //   "上半场那位没击到球"，看起来像玩法坏了，其实只是运气。
  //   所以：基本窗口走完之后，如果还有真人的击球数为 0，再多等一会儿，
  //   最多多等 25 秒（够 6~8 个回合，两次都落同一半的概率 <1%）。
  const extraEnd = Date.now() + OBSERVE_MS + 25000;
  const bothHit = () => (events.h0 || 0) > 0 && (events.h1 || 0) > 0;
  while (Date.now() < end || (Date.now() < extraEnd && !bothHit())) {
    await sleep(60);
    const fresh = A.states.slice(scanned);
    scanned = A.states.length;
    for (const t of fresh) {
      samples += 1;
      if (Array.isArray(t.ev)) {
        for (const e of t.ev) if (typeof e === 'string') events[e] = (events[e] || 0) + 1;
      }
      if (!Array.isArray(t.p) || t.p.length !== 3) continue;
      topMin = Math.min(topMin, t.p[0]); topMax = Math.max(topMax, t.p[0]);
      botMin = Math.min(botMin, t.p[1]); botMax = Math.max(botMax, t.p[1]);
      aiMin = Math.min(aiMin, t.p[2]); aiMax = Math.max(aiMax, t.p[2]);
      // ★ "AI 拍子留在场地内"必须按**当时的拍子倍率**算边界。
      //   拍子会被"加长/削短"改长度（paddleMul 0.62 / 1 / 1.65），
      //   半长小了，中心本来就能更靠近上下墙 —— 削短时中心可以到 800-29.8=770。
      //   用固定 PADDLE_H/2 算出来的 [47, 753] 会把这种**合法**位置报成"跑出界"。
      //   （道具频率调高之后削短变得常见，这条就露出来了。）
      const aiHalf = PADDLE_H * (Array.isArray(t.pm) ? (t.pm[1] || 1) : 1) / 2;
      if (!(t.p[2] >= aiHalf - 0.6 && t.p[2] <= CH - aiHalf + 0.6)) {
        aiBad.push(`${t.p[2].toFixed(1)}（半长 ${aiHalf.toFixed(1)}）`);
      }
      if (prevK !== null && t.k > prevK) {
        const d = Math.abs(t.p[2] - prevAi) / (t.k - prevK);
        if (d > maxAiTick) maxAiTick = d;
      }
      prevK = t.k;
      prevAi = t.p[2];
    }
  }
  clearInterval(dA);
  clearInterval(dB);

  // ---------- 4. 断言 ----------
  console.log('\n4) 断言：三条拍子各就各位');
  check('★ 上半场那条始终没越过中线',
    topMax <= CH / 2 + 0.5, `最大 y=${topMax}`);
  check('★ 下半场那条也没越过中线',
    botMin >= CH / 2 - 0.5, `最小 y=${botMin}`);
  check('两条左拍各自在自己半场里有活动（不是钉死不动）',
    topMax - topMin > 20 && botMax - botMin > 20,
    `上 ${topMin}~${topMax} / 下 ${botMin}~${botMax}`);

  check('★ AI 那条会动', aiMax - aiMin > 20, `y ${aiMin}~${aiMax}`);
  check('★ AI 的拍子始终在场地内（按当时的拍子倍率算，没有跑出上下边界）',
    aiBad.length === 0,
    aiBad.length ? `${aiBad.length} 帧越界，例：${aiBad.slice(0, 3).join(' | ')}`
      : `y ${aiMin}~${aiMax}（都落在各自倍率允许的范围内）`);
  check('★ AI 单 tick 位移不超过「难度倍率 × coop 加成」的上界（不会瞬移）',
    maxAiTick <= AI_TICK_CAP + 0.6,
    `实测 ${maxAiTick.toFixed(2)} px/tick，上界 ${AI_TICK_CAP.toFixed(2)}`);

  console.log('\n5) 断言：两边都真的在打球');
  note(`事件统计: ${JSON.stringify(events)}`);
  check('★ AI 把球打回来过（有 h2 事件）', (events.h2 || 0) > 0,
    `h2=${events.h2 || 0}；如果两个人类都不动，AI 全场碰不到球，这个数恒为 0`);
  check('两个真人也都击到过球（h0 / h1 都出现过）',
    (events.h0 || 0) > 0 && (events.h1 || 0) > 0,
    `h0=${events.h0 || 0} h1=${events.h1 || 0}`);
  // ★ 不断言"这 14 秒里必须有人得分"。两个真人都盯球打、AI 也接得住的时候，
  //   完全可以一分不丢地打十几个回合 —— 那恰恰说明玩法是对的。
  //   把它写成断言就会时红时绿（实测 8 次击球 0 次得分），那种测试比没有还糟。
  //   比分链路本身由 test-rules 的第 7 节和 check-powerup 覆盖。
  note(`得分事件: g0=${events.g0 || 0} g1=${events.g1 || 0}`
    + '（回合打得住就可能是 0，不作断言）');
  check('采样到了足够多的快照', samples > 100, `${samples} 条`);

  // ---------- 6. 回归 ----------
  console.log('\n6) 回归：别把别的模式带坏');
  const C = client('C');
  await C.open();
  C.send({ t: 'create', mode: 'solo', level: 0 });
  await waitFor(() => !!C.joined || !!C.error);
  check('单人打 AI 建房仍然成功', !!C.joined, C.error ? C.error.msg : '超时');

  const D = client('D');
  await D.open();
  D.send({ t: 'join', code: C.joined.code });
  await waitFor(() => !!D.joined || !!D.error);
  check('★ 单人打 AI 的房间仍然不能被别人加入（只有 coop 才开放第二个真人位）',
    !!D.error && !D.joined, D.joined ? '竟然进去了' : (D.error && D.error.msg));

  const E = client('E');
  await E.open();
  E.send({ t: 'create' });          // 不带 mode：老写法的默认值
  await waitFor(() => !!E.joined || !!E.error);
  check('不带 mode 建房仍是经典双人模式', E.joined && E.joined.mode === 'duel',
    E.joined ? E.joined.mode : '超时');
  await waitFor(() => !!E.last());
  check('经典模式只下发两条拍子',
    E.last() && E.last().p.length === 2, E.last() ? JSON.stringify(E.last().p) : '无快照');
  check('经典模式的场地仍是 800x500',
    E.last() && E.last().wh[0] === 800 && E.last().wh[1] === 500,
    E.last() ? JSON.stringify(E.last().wh) : '无快照');

  console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  [A, B, C, D, E].forEach((c) => { try { c.ws.close(); } catch (e) {} });
  await sleep(200);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n异常: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(2);
});
