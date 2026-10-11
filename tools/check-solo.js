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
  //
  // ★★ 但"盯着球的**当前位置**"是不够的（2026-10-11 发现）。
  //   球从对面飞到我这侧要几百毫秒，拍子只有 ~114px 高、而球在纵向跨 240px，
  //   追当前 y 等于永远追在球屁股后面 ⇒ 接球成功率很低 ⇒ 一局里 AI 可能
  //   **一次都轮不到接球**（实测 4 秒窗口：h0=1 / h1=0）。
  //   于是两条断言变成抽奖（"AI 真的把球打回来了"红、"困难档比简单档快"红）。
  //   修法：**预测球到达我这一侧时的纵向落点**（含上下墙反射），一次算准。
  //   纯读数、不发任何额外消息，服务端行为一点没变。
  //
  //   ★ 球的快照字段是 `[id, x, y]`，**不含速度**（见 server.js 的 bs.map）。
  //     所以在客户端侧用"最近两帧的位置差 / 帧差"估 vx、vy。
  //
  // ★★ 但估计**随时可能拿不到**（两次 25ms 调用之间不一定有新快照），
  //   所以 `predictArrivalY` 返回 null 时的兜底**必须是"追当前位置"**，
  //   绝不能是 dir=0 —— 实测一版写成 dir=0 之后拍子**全程钉死不动**
  //   （`max=0.00`、`AI 的击球机会 0 趟`），把陪练整个弄坏了。
  let prevBall = null;   // { k, x, y }
  let lastPredict = null;
  function estimateVel(s, b) {
    if (!prevBall || !(s.k > prevBall.k)) return null;
    const dk = s.k - prevBall.k;
    if (dk <= 0 || dk > 10) return null;         // 帧差太大（掉帧/重置）不可信
    return { vx: (b[1] - prevBall.x) / dk, vy: (b[2] - prevBall.y) / dk, tick: dk };
  }
  const PADDLE_X0 = 40;                          // 左拍所在的 x，只用来估剩余时间
  function predictArrivalY(s, b) {
    const v = estimateVel(s, b);
    if (!v || v.vx <= 0.05) return null;         // 不朝我来（或已到中线）
    const t = (PADDLE_X0 - b[1]) / v.vx;
    if (t < 0 || t > 4) return null;
    let y = b[2] + v.vy * t;
    // 上下墙反射（球半径按 9 算，和 BALL_R 一致）
    const lo = 9, hi = H - 9, span = hi - lo;
    let m = (y - lo) % (2 * span);
    if (m < 0) m += 2 * span;
    y = m <= span ? lo + m : lo + (2 * span - m);
    return y;
  }
  function driveHuman() {
    const s = A.last();
    const b = ball0(s);
    if (!b || !s.p || s.ph !== 'playing') { A.send({ t: 'input', dir: 0 }); return; }
    // 只有真的拿到新帧才更新 prevBall，否则会把同一帧重复当成两帧、算出 vx=0
    if (!prevBall || s.k > prevBall.k) prevBall = { k: s.k, x: b[1], y: b[2] };
    // 预测落点；估不出来就退回"追球当前 y"（保底永远能追）
    let target = predictArrivalY(s, b);
    if (target === null) target = b[2];
    lastPredict = target;
    const d = target - s.p[0];
    A.send({ t: 'input', dir: Math.abs(d) < 6 ? 0 : (d > 0 ? 1 : -1) });
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
  let prevK = null, prevP1 = null, prevPh = null, prevPm = null;
  // ★ "AI 一共获得过几次击球机会" = 球进入 AI 半场（x > W/2）的**独立趟数**。
  //   h1 是"AI 真的打了"的结果事件，会因 AI 没接到而为 0；
  //   把它和"机会数"分开记，才能在机会太少时**明确报出"这是采样不足"**
  //   而不是让"AI 会不会接球"退化成抽奖（旧版本 4 秒窗口实测 h0=1/h1=0 直接红）。
  let aiChances = 0, wasInAiHalf = false;
  // ★ 单独记"球在 AI 半场的帧数"。这条是诊断用的：
  //   如果它是 0，就说明 maxPerTickChasing=0 是**"球压根没过去"**，
  //   而不是"AI 不动"—— 两者报出来的数字一样，但责任完全不同。
  let aiHalfFrames = 0;
  // 同理，AI 的单 tick 最大位移只在"球逼它跑"时才接近上限。
  // 单独记"球在 AI 半场时"的最大位移，它才是真正要跟上限比的那个量。
  let maxPerTickChasing = 0;

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
      // 这一帧和上一帧是不是"同一局里的相邻 tick"（下面两处判据都要用）
      const sameTickPrev = prevK !== null && s.k - prevK === 1;
      if (b) {
        ballXmin = Math.min(ballXmin, b[1]);
        ballXmax = Math.max(ballXmax, b[1]);
        ballYmin = Math.min(ballYmin, b[2]);
        ballYmax = Math.max(ballYmax, b[2]);
        if (s.ph === 'playing' && b[1] > W / 2) {     // 球正在飞向 AI
          aiHalfFrames += 1;
          if (!wasInAiHalf) { aiChances += 1; wasInAiHalf = true; }
          // ★★ 只在球**已经逼近 AI 拍子**时判"在不在球的位置上"。
          //   实测教训（2026-10-11）：AI 是预测性移动，球刚过中线时它往往
          //   还按**落点**在走、跟球的当前 y 差很远；拿那一段统计会把
          //   困难档的 80% 拉低到 44%（"方向相关性"同样被这一点坑到 44%）。
          //   球到了 x > 3/4 场宽，AI 就必须已经就位了 —— 这才是有效判据。
          if (b[1] > W * 0.75) {
            nearBase += 1;
            if (Math.abs(s.p[1] - b[2]) < 120) near += 1;
          }
        } else if (b[1] <= W / 2) {
          wasInAiHalf = false;                        // 球回到我这侧，下一趟重新计
        }
      }
      if (prevK !== null && s.k > prevK) {
        const dk = s.k - prevK;
        // ★★ 必须排除**跨局/跨倒计时复位**造成的跳变（2026-10-11 修）。
        //   `startMatch` 会把两块拍子复位到正中央（见 MEMORY「startMatch 会把两块
        //   拍子复位到正中央」），`resetBall` 也把相位打回 countdown。
        //   如果不排除，复位那一帧会被算成"单 tick 位移 29.50"，直接击穿速度上限
        //   —— 报出来的是"难度乘数没生效"，真因却是换了一局。
        //   判据：帧差为 1（同一局连续 tick）**且**两帧相位都是 playing 时才采。
        // ★★ 判据（2026-10-11 定稿，抓了三轮现场才立住）：
        //   帧差为 1（同一局的连续 tick）+ 两帧都是 playing + **上一帧拍子在合法范围内**。
        //   ① 前两条排除换局/倒计时复位（`startMatch` 把拍子复位到正中央）。
        //   ② 第三条是本条断言最大的一颗雷，也是最不直观的一条：
        //      "加长/变短"道具会让 `paddleHalf()` 突变 ⇒ `stepPaddles` 里的
        //      `lo = yMin + half` / `hi = yMax - half` 跟着突变 ⇒ **`clamp()` 在
        //      道具生效后的第一帧，把还停在旧边界外的拍子一次性推回新边界内**。
        //      实测现场（dump 出来的）：`pm:[1,1.65]`（AI 拍子 ×1.65 ⇒ half 48→79.2）、
        //      `prevP1=49.7 → p1=79.2`，位移 29.5px/tick，看着像"突破 18px 上限"，
        //      真因是**拍子变长后被夹回合法范围**（服务端行为完全正确、也是必须的，
        //      否则拍子会露出球场边缘）。
        //      ★ 判据写成"上一帧在界外"而不是"`pm` 变了"：道具生效那一帧 `pm`
        //        前后就已经相同了，用 `pm` 变化是**漏判**（实测漏掉 29.4/29.7）。
        //   常量：`PADDLE_H = 96` → `half = 48 * pm`；span 是 `[0, H]` 所以边界就是
        //   `[half, H - half]`（见 server.js 的 `room.slots[].span` 与 stepPaddles）。
        const PADDLE_H = 96;
        const prevHalf = prevPm === null ? PADDLE_H / 2 : (PADDLE_H * prevPm) / 2;
        const prevInRange = prevP1 !== null
          && prevP1 >= prevHalf - 0.5 && prevP1 <= H - prevHalf + 0.5;
        const sameRun = dk === 1 && s.ph === 'playing' && prevPh === 'playing' && prevInRange;
        const d = sameRun ? Math.abs(s.p[1] - prevP1) / dk : 0;
        if (d > maxPerTick) maxPerTick = d;
        // ★ 只在"球在 AI 半场"时采这一项（保留作诊断，主判据已改用全局值）
        if (sameRun && b && b[1] > W / 2 && d > maxPerTickChasing) maxPerTickChasing = d;
      }
      prevK = s.k;
      prevP1 = s.p[1];
      prevPh = s.ph;
      prevPm = s.pm ? s.pm[1] : null;
    }
  }

  clearInterval(driver);
  const res = {
    level,
    joined: A.joined,
    prBothAt,
    maxPerTick,
    maxPerTickChasing,
    aiChances,
    aiHalfFrames,
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
    note(`  └ 仅"球在 AI 半场"时 ${r.maxPerTickChasing.toFixed(2)}（真正跟上限比的那个）`);
    note(`AI 的击球机会 ${r.aiChances} 趟（球在 AI 半场 ${r.aiHalfFrames} 帧），实际击球 ${r.aiHits} 次`);
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
    // ★★ 就位率**不能三档用同一个阈值**（2026-10-11 实测）：
    //   简单档 AI 的速度是 11.9px/tick、瞄准误差 96px —— 球冲到 3/4 场宽时
    //   它**物理上赶不到**，就位率实测会在 39%~81% 之间大幅波动。
    //   那不是缺陷，那正是"简单"两个字的定义。要求它也 ≥60% 就是把难度设计
    //   断言成 bug（12 次里红 1 次，且红的永远是简单档）。
    //   所以：普通/困难档要求真的守住，简单档只要求"显著好于瞎猜"。
    const trackFloor = lv === 0 ? 0.3 : 0.6;
    check(`[${tag}] AI 在球逼近时守在球的位置上（就位率 ≥${(trackFloor * 100).toFixed(0)}%）`,
      r.aiTrackRatio > trackFloor && r.aiTrackSamples > 8,
      `${(r.aiTrackRatio * 100).toFixed(0)}%（${r.aiTrackSamples} 个采样）`);
    //  ★ 简单档**刻意放行**：它的速度乘数只有 0.66（11.9 px/tick），
    //    面对陪练打出的快球真的可能一整局接不住 —— 那是**产品的真实难度**，
    //    不是缺陷。要求"每档每次运行都必须接住"就等于把难度设计断言成 bug。
    //    能力本身由下面那条跨档的总判据覆盖（三档合计 h1 必须够多）。
    if (lv > 0) {
      check(`[${tag}] ★ AI 真的把球打回来了（h1 事件 > 0）`,
        r.aiHits > 0, `h1=${r.aiHits}（共 ${r.aiChances} 趟机会）`);
    } else {
      // 简单档：改成判"确实获得了击球机会"（陪练有效），不判结果
      check(`[${tag}] 球确实飞到了 AI 半场（简单档不要求必接住，只要求机会存在）`,
        r.aiChances > 0, `机会 ${r.aiChances} 趟 / h1=${r.aiHits}`);
    }
    // ★ 上界是确定性的：速度乘数没生效的话，简单档也会跑出 ~18px/tick
    check(`[${tag}] 单 tick 位移没超过本档速度上限`,
      r.maxPerTick <= cap + 1.2, `实测 ${r.maxPerTick.toFixed(2)} > 上限 ${cap.toFixed(1)}`);
    // ★★ 判据用**全局** maxPerTick，不用"球在 AI 半场时"那个子集。
    //   原因（2026-10-11 实测）：AI 是**预测性**移动的 —— `botPerceive` 在球
    //   还没过半场时就定好了瞄准点，于是"球一进 AI 半场它就已经就位"的情形下，
    //   子集里的位移全程接近 0，而真正的满速发生在**球还在我这侧**的那一段。
    //   实测：子集口径偶发报 0.00（AI 半场 134 帧），全局口径稳定贴顶
    //   （三档分别 11.90 / 15.10 / 18.00，与各自上限逐位相同）。
    //   ⇒ 上限是确定性的，AI 一定会跑到它，只要窗口够长（默认 12 秒足够）。
    check(`[${tag}] AI 把本档速度上限用到了（贴近上限，证明乘数真的在生效）`,
      r.maxPerTick >= cap * 0.9,
      `实测 ${r.maxPerTick.toFixed(2)} / 上限 ${cap.toFixed(1)}`);
  }

  // ★★ 这里**刻意不写"就位率随难度递增"**（2026-10-11 实测否掉）。
  //   我一度加上这条，结果 12 次里红 6 次，实测数据是
  //   96/90/83、93/100/75、76/86/79、98/82/100、78/69/73……
  //   ⇒ **就位率与难度之间根本没有稳定关系**：它取决于这一局的球路，
  //   而难度的差异体现在**速度上限**（maxPerTick 精确贴 11.90/15.10/18.00）
  //   和**瞄准误差**（errPx 96/68/58）上，不体现在"球到 3/4 场宽时拍子在哪"。
  //   加这条等于**凭想象给产品规定一条它没有的规律** —— 就是"测试骗人"。
  //   难度差异的证据由上面逐档的"贴近本档上限"承担，那是配置层 + 行为层都成立的。
  const totalSamples = results.reduce((a, r) => a + r.aiTrackSamples, 0);
  check('就位率判据的样本量足够（三档合计 > 30 个采样）',
    totalSamples > 30, `合计 ${totalSamples} 个采样`);

  // 非平凡性：上面那条"没超过上限"不能"因为拍子几乎不动"而白过。
  // 三档各自的"贴近本档上限 90%"已经承担了这个职责（逐档判、口径确定）。
  //
  // ★ 全局 h1 总判据：把"AI 会不会接球"这个**能力**用跨档合计来判，
  //   而不是要求每一档每次运行都必定接住（简单档速度慢，接不住是设计如此）。
  const totalAiHits = results.reduce((a, r) => a + r.aiHits, 0);
  const totalChances = results.reduce((a, r) => a + r.aiChances, 0);
  check('★ 三档合计 AI 确实把球打回来过（这是 AI 会不会接球的总判据）',
    totalAiHits > 0, `合计 h1=${totalAiHits} / 机会 ${totalChances} 趟`);
  // 陪练有效性：三档合计必须真的把球送到过 AI 半场，否则上面那条也是空的
  check('陪练确实把球送到过 AI 半场（否则上面的 h1 判据毫无意义）',
    totalChances >= 3, `合计机会 ${totalChances} 趟`);
  // 这里再补一条**跨档的确定性元检查**：三档实测的上限必须真的是三个不同的数，
  // 否则"分档"这件事根本没发生（比如有人把 SPEED_MUL 写成了常数）。
  const caps = [0, 1, 2].map((lv) => (PADDLE_SPEED * SPEED_MUL[lv]) / TICK_HZ);
  check('三档的速度上限确实是三个逐级升高的不同值（分档不是摆设）',
    caps[0] < caps[1] && caps[1] < caps[2],
    caps.map((c) => c.toFixed(1)).join(' < '));

  // 每一档的实测都必须落在**自己档的**允许区间里 —— 恒等式检验。
  // 简单档突破困难档的上限 = 乘数没生效；困难档跑不到简单档之上 = 乘数被过度限制。
  const easyCap = caps[0];
  let anyOver = null;
  for (const r of results) {
    const c = (PADDLE_SPEED * SPEED_MUL[r.level]) / TICK_HZ;
    if (r.maxPerTick > c + 1.2) anyOver = `${LEVEL_NAMES[r.level]} ${r.maxPerTick.toFixed(2)} > ${c.toFixed(2)}`;
  }
  check('没有任何一档突破自己档的速度上限（乘数是按档生效的）',
    anyOver === null, anyOver || '三档都在各自上限内');
  void easyCap;

  console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
