'use strict';

/**
 * 本地协议自测：模拟两个玩家，把服务端跑一遍。
 * 目的：在拿去测网络之前，先确认「房间 / 输入 / 物理 / 重连」本身是对的。
 * 否则一旦线上表现异常，就分不清是链路的锅还是逻辑的锅。
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3100;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const HTTP_URL = `http://127.0.0.1:${PORT}`;

const H = 500;
const PADDLE_H = 96;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  [ok]   ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

/** 相等断言。期望值先写、实际值后写 —— 失败信息里好读。 */
function eq(name, actual, expected) {
  check(name, actual === expected, `得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

function makeClient(name) {
  const ws = new WebSocket(WS_URL);
  const c = {
    name,
    ws,
    got: Object.create(null),
    states: [],
    waiters: Object.create(null),
  };

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.t === 'state') {
      c.states.push(m);
      if (c.states.length > 400) c.states.shift();
    }
    c.got[m.t] = m;
    const w = c.waiters[m.t];
    if (w) {
      c.waiters[m.t] = [];
      w.forEach((fn) => fn(m));
    }
  });

  ws.on('error', () => {});

  c.open = () => new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  c.wait = (t, ms = 6000) => new Promise((res, rej) => {
    if (c.got[t]) return res(c.got[t]);
    (c.waiters[t] = c.waiters[t] || []).push(res);
    setTimeout(() => rej(new Error(`${name} 等待 ${t} 超时`)), ms);
    return undefined;
  });

  c.clear = (t) => { delete c.got[t]; };

  c.send = (o) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(o));
  };

  c.latest = () => c.states[c.states.length - 1] || null;

  return c;
}

/** 等某个客户端看到指定阶段。返回 false = 超时（调用方自己决定算不算失败） */
async function waitPhase(c, ph, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = c.latest();
    if (s && s.ph === ph) return true;
    await sleep(150);
  }
  return false;
}

function getHttp(path) {
  return new Promise((res, rej) => {
    const req = http.get(HTTP_URL + path, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => res({ status: r.statusCode, body }));
    });
    req.on('error', rej);
    req.setTimeout(4000, () => { req.destroy(new Error('http timeout')); });
  });
}

async function main() {
  console.log(`\n目标: ${WS_URL}\n`);

  // --- 1. HTTP 层 ---
  console.log('1) HTTP 服务');
  try {
    const h = await getHttp('/healthz');
    check('健康检查返回 200', h.status === 200, `status=${h.status}`);
    const j = JSON.parse(h.body);
    check('健康检查内容正常', j.ok === true && j.tickHz === 30, h.body);
  } catch (e) {
    check('健康检查可访问', false, e.message);
    console.log('\n服务端没起来，后面的测试没法继续。');
    process.exit(1);
  }

  try {
    const p = await getHttp('/');
    check('首页返回 HTML', p.status === 200 && /<canvas/i.test(p.body),
      `status=${p.status}, len=${p.body.length}`);
  } catch (e) {
    check('首页可访问', false, e.message);
  }

  // --- 2. 房间 ---
  console.log('\n2) 房间建立');
  const A = makeClient('A');
  const B = makeClient('B');
  await A.open();
  await B.open();
  check('两个客户端都完成 WebSocket 握手', A.ws.readyState === 1 && B.ws.readyState === 1);

  A.send({ t: 'create' });
  const joinedA = await A.wait('joined');
  check('A 创建房间成功', !!joinedA.code && joinedA.side === 0, JSON.stringify(joinedA));
  check('房间码为 6 位', /^[A-Z0-9]{6}$/.test(joinedA.code), joinedA.code);

  B.send({ t: 'join', code: joinedA.code.toLowerCase() });   // 故意用小写，验证服务端会归一化
  const joinedB = await B.wait('joined');
  check('B 用小写房间码也能加入', joinedB.side === 1, JSON.stringify(joinedB));

  const C = makeClient('C');
  await C.open();
  C.send({ t: 'join', code: joinedA.code });
  const errC = await C.wait('error');
  check('第三个人被拒绝', /满/.test(errC.msg || ''), JSON.stringify(errC));
  C.ws.close();

  // --- 3. 状态广播 ---
  console.log('\n3) 状态广播');
  await sleep(1200);
  check('A 收到状态快照', A.states.length > 5, `收到 ${A.states.length} 条`);
  check('B 收到状态快照', B.states.length > 5, `收到 ${B.states.length} 条`);

  const s0 = A.latest();
  check('快照带服务器时间戳', typeof s0.st === 'number' && s0.st > 1600000000000);
  check('快照带双方在线标记', Array.isArray(s0.pr) && s0.pr[0] === 1 && s0.pr[1] === 1,
    JSON.stringify(s0.pr));

  const gapStart = A.states.length;
  const tMark = Date.now();
  await sleep(2000);
  const got = A.states.length - gapStart;
  const measuredHz = got / ((Date.now() - tMark) / 1000);
  check('广播频率接近 30Hz', measuredHz > 24 && measuredHz < 36, `实测 ${measuredHz.toFixed(1)} Hz`);

  const kb = JSON.stringify(s0).length / 1024;
  check('单条快照小于 0.5KB', kb < 0.5, `${kb.toFixed(2)} KB`);

  // --- 4. 输入 ---
  console.log('\n4) 输入与本地状态');
  B.send({ t: 'input', dir: -1 });
  await sleep(700);
  const sUp = B.latest();
  check('B 按下后自己的拍子上移', sUp.p[1] < H / 2 - 40, `paddle[1]=${sUp.p[1]}`);
  check('A 那边也看到了 B 的拍子', A.latest().p[1] < H / 2 - 40);

  B.send({ t: 'input', dir: 0 });
  await sleep(150);

  B.send({ t: 'input', dir: 1 });
  await sleep(900);
  const sDown = B.latest();
  check('B 下移后回到下方', sDown.p[1] > H / 2 + 60, `paddle[1]=${sDown.p[1]}`);

  // 边界夹取
  B.send({ t: 'input', dir: 1 });
  await sleep(1600);
  const sEdge = B.latest();
  check('拍子不会跑出下边界', sEdge.p[1] <= H - PADDLE_H / 2 + 0.01, `paddle[1]=${sEdge.p[1]}`);
  B.send({ t: 'input', dir: 0 });

  // 非法输入不应崩
  B.send({ t: 'input', dir: 999 });
  await sleep(200);
  check('非法方向值被忽略且服务端存活', !!B.latest() && B.ws.readyState === 1);

  // --- 5. 比赛推进 ---
  console.log('\n5) 比赛推进与得分');
  // 把 B 的拍子放回中间，让球有来有回
  B.send({ t: 'input', dir: -1 });
  await sleep(400);
  B.send({ t: 'input', dir: 0 });

  const phaseSeen = new Set();
  const scoreStart = JSON.stringify(A.latest().s);
  const snapsBefore = A.states.length;
  const t0 = Date.now();
  let ballMoved = false;
  let prevBalls = null;

  while (Date.now() - t0 < 22000) {
    await sleep(200);
    const s = A.latest();
    if (!s) continue;
    phaseSeen.add(s.ph);
    // ★ 球改成**数组**了（分裂球会让场上同时有多个），快照字段是 bs = [[id, x, y], ...]。
    //   单球时代的 `s.b` 早就不存在了 —— 而原来的写法刚好把读空字段这件事躲了过去：
    //   `prevBall && s.b[0] !== ...` 里 prevBall 一直是 undefined，于是整条断言
    //   **永远为假**、静默红了整整一个版本，看起来却像"球真的没动"。
    //   现在按 **id** 比对（不能用下标：某个球出界后数组整体前移）。
    if (prevBalls && Array.isArray(s.bs)) {
      const prev = new Map(prevBalls.map((b) => [b[0], b[1] + '|' + b[2]]));
      if (s.bs.some((b) => prev.has(b[0]) && prev.get(b[0]) !== b[1] + '|' + b[2])) {
        ballMoved = true;
      }
    }
    prevBalls = s.bs;
    if (JSON.stringify(s.s) !== scoreStart) break;
  }

  // ★ 先说清楚这个观测窗口到底有没有收到数据。
  //   不加这一条时，窗口内一帧没收到会让下面两条断言报出**误导性**的结论：
  //   "只见过 countdown" + "球没动"，看起来像服务端卡在倒计时里 —— 实际是我方没数据。
  //   实测偶发过一次（连跑三次，第三次中招），每次都去服务端找假 bug。
  //   服务端"没推进"和我方"没收到"必须能分开。
  const freshSnaps = A.states.length - snapsBefore;
  check('观测窗口内确实收到了新快照（这是下面两条结论的前提）', freshSnaps >= 5,
    `22s 窗口里只收到 ${freshSnaps} 帧`);

  check('出现过 playing 阶段', phaseSeen.has('playing'), [...phaseSeen].join(','));
  check('球确实在移动', ballMoved);

  // 球的身份与新增字段的协议层检查。
  // 这些字段前端全靠它，缺了不会报错、只会画错 —— 所以在协议这一层就要钉住。
  const states = A.states;
  const bsShape = states.every((s) => Array.isArray(s.bs)
    && s.bs.every((b) => Array.isArray(b) && b.length === 3
      && Number.isInteger(b[0]) && Number.isFinite(b[1]) && Number.isFinite(b[2])));
  check('★ 每个球都是 [id, x, y]，且 id 是整数（客户端靠 id 认球）', bsShape,
    JSON.stringify((states[states.length - 1] || {}).bs));
  const idsUnique = states.every((s) => new Set(s.bs.map((b) => b[0])).size === s.bs.length);
  check('同一帧里球的 id 不重复（重复就认不出是哪个球了）', idsUnique);
  const ivOk = states.every((s) => Array.isArray(s.iv) && s.iv.length === 2
    && s.iv.every((v) => Number.isFinite(v) && v >= 0));
  check('★ 快照带隐形剩余秒数 iv（两个非负数）', ivOk,
    JSON.stringify((states[states.length - 1] || {}).iv));
  const iaOk = states.every((s) => Array.isArray(s.ia) && s.ia.length === 2
    && s.ia.every((v) => v >= 0 && v <= 1));
  check('★ 快照带观看透明度 ia（两个 0..1 的数，1 = 看得见）', iaOk,
    JSON.stringify((states[states.length - 1] || {}).ia));
  // 暂停字段：正常对局里必须是"没暂停"（0 / -1），否则客户端会一直挂着暂停遮罩
  const upOk = states.every((s) => s.up === 0 || s.up === 1);
  check('★ 快照带暂停字段 up（0/1），正常对局里是 0', upOk && A.latest().up === 0,
    `up=${A.latest().up}`);
  const pbOk = states.every((s) => Number.isInteger(s.pb));
  check('★ 快照带"是谁按的暂停" pb（整数，没暂停时是 -1）',
    pbOk && A.latest().pb === -1, `pb=${A.latest().pb}`);
  check('比分发生过变化（有人得分）',
    JSON.stringify(A.latest().s) !== scoreStart,
    `当前比分 ${JSON.stringify(A.latest().s)}`);

  // --- 5b. 暂停 / 继续 ---
  // 需求：两个玩家一起玩时，**两个人都能按暂停、也都能按开始**，谁按都生效。
  console.log('\n5b) 暂停：两边各按一次都要生效');
  const playing = await waitPhase(A, 'playing');
  check('前置：对局正在推进（下面几条的前提）', playing, '等待 playing 阶段超时');

  A.send({ t: 'pause' });
  await sleep(450);
  const paA = A.latest();
  const paB = B.latest();
  check('★ 左边按下暂停后，服务端状态变成"暂停中"', paA.up === 1, `up=${paA.up}`);
  check('★ 右边也看到了暂停（不是只有按的人自己知道）', paB.up === 1, `up=${paB.up}`);
  check('★ 下发了"是谁按的"（上/下都要能看到这句提示）',
    paA.pb === 0 && paB.pb === 0, `A.pb=${paA.pb} B.pb=${paB.pb}`);
  check('★ 暂停时阶段仍是 playing（球留在画面上，不是被藏起来）',
    paA.ph === 'playing' && paB.ph === 'playing', `A=${paA.ph} B=${paB.ph}`);

  const frozeBall = JSON.stringify(A.latest().bs);
  const frozeTick = A.latest().k;
  const frozeP1 = A.latest().p[1];
  // 暂停期间让右边一直按着"上"：拍子也不许动
  B.send({ t: 'input', dir: -1 });
  await sleep(1000);
  check('★ 暂停期间球一动不动', JSON.stringify(A.latest().bs) === frozeBall,
    `${frozeBall} -> ${JSON.stringify(A.latest().bs)}`);
  check('★ 暂停期间另一边的拍子也动不了（方向键按着没用）',
    A.latest().p[1] === frozeP1, `${frozeP1} -> ${A.latest().p[1]}`);
  check('★ 但服务端仍在推进 tick（不是卡死，延迟/心跳照常）',
    A.latest().k > frozeTick + 15, `tick ${frozeTick} -> ${A.latest().k}`);
  B.send({ t: 'input', dir: 0 });
  await sleep(200);

  B.send({ t: 'pause' });
  await sleep(450);
  check('★ 右边按一下就能恢复（不必是"按暂停的那个人"才能恢复）',
    A.latest().up === 0 && B.latest().up === 0,
    `A.up=${A.latest().up} B.up=${B.latest().up}`);
  check('恢复后"是谁按的"也清掉了', A.latest().pb === -1, `pb=${A.latest().pb}`);
  const resumeBall = JSON.stringify(A.latest().bs);
  await sleep(900);
  check('★ 恢复后球又开始动了', JSON.stringify(A.latest().bs) !== resumeBall,
    `${resumeBall} -> ${JSON.stringify(A.latest().bs)}`);

  // --- 6. 断线重连 ---
  console.log('\n6) 断线重连');
  const tokenB = joinedB.token;
  const scoreBefore = JSON.stringify(A.latest().s);
  B.ws.close();
  await sleep(600);
  check('B 掉线后 A 看到对方离线',
    A.latest().pr[1] === 0, JSON.stringify(A.latest().pr));

  const B2 = makeClient('B2');
  await B2.open();
  B2.send({ t: 'rejoin', code: joinedA.code, token: tokenB });
  const rej = await B2.wait('rejoined');
  check('凭 token 重连成功并坐回原位', rej.side === 1, JSON.stringify(rej));

  await sleep(800);
  check('重连后 A 重新看到对方在线', A.latest().pr[1] === 1);
  check('重连期间比分保留', JSON.stringify(A.latest().s) === scoreBefore,
    `${scoreBefore} -> ${JSON.stringify(A.latest().s)}`);

  // 过期 token
  const B3 = makeClient('B3');
  await B3.open();
  B3.send({ t: 'rejoin', code: joinedA.code, token: 'bogus-token' });
  const errTok = await B3.wait('error');
  check('伪造 token 被拒绝', !!errTok.msg, JSON.stringify(errTok));
  B3.ws.close();

  // --- 7. 边界情况 ---
  console.log('\n7) 边界情况');
  const D = makeClient('D');
  await D.open();
  D.send({ t: 'join', code: 'ZZZZZZ' });
  const errRoom = await D.wait('error');
  check('加入不存在的房间有明确提示', /不存在/.test(errRoom.msg || ''), JSON.stringify(errRoom));

  D.send({ t: 'input', dir: -1 });
  // 没入座就发暂停：服务端必须直接忽略（拿不到 ws.player），而不是崩掉
  D.send({ t: 'pause' });
  await sleep(150);
  check('未进房间就发输入 / 暂停不会崩', D.ws.readyState === 1);
  D.ws.close();

  // 乱数据
  const E = makeClient('E');
  await E.open();
  E.ws.send('this is not json');
  E.ws.send(JSON.stringify({ nope: 1 }));
  E.ws.send(JSON.stringify({ t: 'unknown-action' }));
  await sleep(300);
  check('垃圾消息不会让服务端崩溃', E.ws.readyState === 1);
  E.ws.close();

  // --- 8. 心跳 ---
  console.log('\n8) 应用层心跳');
  A.clear('pong');
  A.send({ t: 'ping', ts: 12345 });
  const pong = await A.wait('pong');
  check('ping/pong 正常回环', pong.ts === 12345 && typeof pong.st === 'number',
    JSON.stringify(pong));

  await sleep(300);

  // --- 9. 皮肤与技能（第 10 轮） ---
  // 这一节在**协议层**要钉住的东西和三件事有关：
  //   ① create / join 会带上 skin，且服务端把它归一化后**下发给所有人**（客户端要给拍子上色）；
  //   ② skill 消息没有参数，一切判定在服务端（冷却 / 阶段 / 这块拍子到底有没有技能）；
  //   ③ ★ 幻影球对释放方**不在 bs 里**、对对手在 —— 这条只能在协议层验。
  //      它是整套设计里唯一没法靠客户端过滤完成的部分（见 server.js broadcastState 的注释）。
  console.log('\n9) 皮肤与技能');

  /**
   * 等到两边都收到**同一帧**（k 相同）再取样。
   * ★ 不这么做，"对手多一个球"的结论可能只是两边采样错位（一边是上一帧、一边是这一帧，
   *   中间正好赶上进球/分裂）。同一帧才是可比的。
   */
  async function syncPair(x, y, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const a = x.latest();
      const b = y.latest();
      if (a && b && a.k === b.k) return { a, b };
      await sleep(40);
    }
    return { a: x.latest(), b: y.latest() };
  }

  /**
   * 放技能并重试。
   * ★ 必须重试：进球之后有几秒倒计时，撞上那段会被服务端的"phase === playing"门禁拒掉 ——
   *   那是设计如此，不是 bug。冒烟脚本第一版就是栽在这里，白排查了一轮。
   * ★ 只适合"效果不受进球影响"的技能（风 —— resetBall 不清 winds）。
   */
  async function castUntil(c, ok, tries = 16) {
    for (let i = 0; i < tries; i += 1) {
      const s = c.latest();
      if (s && s.ph === 'playing') {
        c.send({ t: 'skill' });
        await sleep(240);
        if (ok()) return true;
      } else {
        await sleep(250);
      }
    }
    return false;
  }

  /**
   * 等一个"短时间内不会进球"的取样窗口。
   *
   * ★ 为什么非要这个：**进球会把幻影球一起清掉** —— 真球出界 ⇒ afterGoal 发现场上
   *   一个真球都不剩 ⇒ resetBall 把整个 balls 数组换掉，幻影球随之消失（设计如此，
   *   和分裂球道具一样"作用范围限这个回合"）。所以"随便挑个 playing 时刻就放幻影"
   *   会撞上重发球：240ms 后一看 px=0、球数也没变，看着像技能没生效，实际是窗口选错了。
   *   这个坑真踩过（第一版就是这么红的）。
   *
   * 判据取"球的 x 离两边球门都 ≥ 280px"：球速上限 900px/s ⇒ 至少 0.31 秒安全，
   * 而取样只等 150ms。比"必须是刚开球那一刻"好等得多，窗口也够。
   * 对红色同样要用：球撞到拍子就会把蓄力消耗掉，"刚放完 bo=1"会被一板打没。
   */
  async function waitOpenWindow(c, ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = c.latest();
      if (s && s.ph === 'playing' && Array.isArray(s.bs) && s.bs.length === 1) {
        const x = s.bs[0][1];
        if (x > 280 && x < 520) return true;
      }
      await sleep(30);
    }
    return false;
  }

  // ---- 9a. skin 随 create / join 上传，并且两边都看得到 ----
  const F = makeClient('F');            // 青色（风）
  const G = makeClient('G');            // 黄色（幻影）
  await F.open();
  await G.open();
  F.send({ t: 'create', skin: 1 });
  const joinedF = await F.wait('joined');
  G.send({ t: 'join', code: joinedF.code, skin: 2 });
  const joinedG = await G.wait('joined');
  check('前置：新房间两人各坐一边', joinedF.side === 0 && joinedG.side === 1,
    `${joinedF.side}/${joinedG.side}`);
  await sleep(400);

  const skF0 = F.latest();
  check('★ 选的皮肤随 create/join 传上去，并且两边看到的都一样（客户端要给对手的拍子也上色）',
    JSON.stringify(skF0.sk) === '[1,2]' && JSON.stringify(G.latest().sk) === '[1,2]',
    `F=${JSON.stringify(skF0.sk)} G=${JSON.stringify(G.latest().sk)}`);

  // ---- 9b. 技能相关字段的形状 ----
  const fStates = () => F.states;
  const shapeOk = fStates().every((s) => Array.isArray(s.sk) && s.sk.length === 2
    && s.sk.every((v) => Number.isInteger(v) && v >= 0 && v <= 3));
  check('★ 快照带每个槽位的皮肤编号 sk（两个 0..3 的整数）', shapeOk,
    JSON.stringify(skF0.sk));
  const scOk = fStates().every((s) => Array.isArray(s.sc) && s.sc.length === 2
    && s.sc.every((v) => Number.isFinite(v) && v >= 0));
  check('★ 快照带技能冷却剩余秒数 sc（两个非负数，0 = 可以放）', scOk,
    JSON.stringify(skF0.sc));
  const boOk = fStates().every((s) => Array.isArray(s.bo) && s.bo.length === 2
    && s.bo.every((v) => v === 0 || v === 1));
  check('★ 快照带"超高速是否已蓄力" bo（两个 0/1）', boOk, JSON.stringify(skF0.bo));
  const wfOk = fStates().every((s) => Array.isArray(s.wf)
    && s.wf.every((w) => Array.isArray(w) && w.length === 3
      && w.every((v) => Number.isFinite(v))));
  check('★ 快照带正在刮的风 wf（每项 [dx, dy, 剩余秒]）', wfOk,
    JSON.stringify(skF0.wf));
  const pxOk = fStates().every((s) => Array.isArray(s.px) && s.px.length === 2
    && s.px.every((v) => Number.isFinite(v) && v >= 0));
  check('★ 快照带幻影剩余秒数 px（两个非负数）', pxOk, JSON.stringify(skF0.px));
  check('开局时没有人处在冷却里（sc 全 0，否则一开局技能就是"冷却中"）',
    skF0.sc.every((v) => v === 0), JSON.stringify(skF0.sc));

  // ---- 9c. 门禁：比赛还没推进到 playing 时按了不算数 ----
  // 这一刻还在倒计时里（刚 join 完 0.4 秒）。位置正好用来验门禁。
  const cdPre = JSON.stringify(F.latest().sc);
  F.send({ t: 'skill' });
  await sleep(350);
  check('★ 倒计时期间按技能：不进冷却、也没多出一股风（门禁生效）',
    JSON.stringify(F.latest().sc) === cdPre && F.latest().wf.length === 0,
    `sc=${JSON.stringify(F.latest().sc)} wf=${JSON.stringify(F.latest().wf)}`);

  // ---- 9d. 青色：风 ----
  const fPlay = await waitPhase(F, 'playing');
  check('前置：对局推进到 playing（下面几条的前提）', fPlay, '等待 playing 超时');
  const gotWind = await castUntil(F, () => (F.latest().wf || []).length > 0);
  check('★ 青色放得出风（消息走通、服务端认这块拍子）', gotWind,
    JSON.stringify(F.latest().wf));
  const w0 = (F.latest().wf || [])[0] || [0, 0, 0];
  check('★ 风的 dx/dy 是单位向量（客户端直接拿它画气流线，不单位化就会长短不一）',
    Math.abs(Math.hypot(w0[0], w0[1]) - 1) < 0.02,
    `|w|=${Math.hypot(w0[0], w0[1]).toFixed(3)}`);
  check('★ 左边放的风方向朝右（拍子中心 → 球场中心，dx 恒为正）', w0[0] > 0,
    JSON.stringify(w0));
  check('★ 风剩余秒数 ≤ WIND_MS（1 秒）', w0[2] > 0 && w0[2] <= 1.01,
    `剩余 ${w0[2]}s`);
  check('★ 对手也看得到这股风（风是扫过整个屏幕的，只有自己看得见就成"球自己乱动"了）',
    (G.latest().wf || []).length > 0, JSON.stringify(G.latest().wf));
  check('★ 放完进入冷却，长度 = 这个皮肤对应的时长（10 秒）',
    F.latest().sc[0] > 9 && F.latest().sc[0] <= 10,
    `sc[0]=${F.latest().sc[0]}`);

  const cdThen = F.latest().sc[0];
  F.send({ t: 'skill' });
  await sleep(400);
  check('★ 冷却期内再按被拒，而且**冷却不会重新计时**（否则连按就等于白续 10 秒）',
    F.latest().sc[0] > 0 && F.latest().sc[0] <= cdThen,
    `${cdThen} -> ${F.latest().sc[0]}`);

  // ---- 9e. 黄色：幻影（★ 本节的核心） ----
  const windowOk = await waitOpenWindow(G);
  check('前置：等到一个"短时间内不会进球"的取样窗口（下面几条的前提，理由见 waitOpenWindow）',
    windowOk, `ph=${G.latest().ph} bs=${JSON.stringify(G.latest().bs)}`);

  const { a: beforeF, b: beforeG } = await syncPair(F, G);
  check('前置：取样前两边处于同一帧（否则下面"多一个球"可能只是采样错位）',
    beforeF.k === beforeG.k, `${beforeF.k} vs ${beforeG.k}`);
  eq('前置：此刻场上只有一个球（不然"多一个"就是空断言）', beforeG.bs.length, 1);

  G.send({ t: 'skill' });
  await sleep(150);
  const { a: afterF, b: afterG } = await syncPair(F, G);
  check('前置：效果生效后两边仍是同一帧', afterF.k === afterG.k,
    `${afterF.k} vs ${afterG.k}`);
  check('★ 技能被服务端接受（进了冷却）—— 这是下面三条能成立的前提，'
    + '它红了说明是"没放出去"，而不是"放出去了看不见"',
    afterG.sc[1] > 0, `sc[1]=${afterG.sc[1]}`);
  eq('★ 幻影球让**对手**（F）多看到一个球 —— 这才叫"被迷惑"',
    afterF.bs.length - beforeF.bs.length, 1);
  eq('★ 而释放方（G）自己看到的球数不变（那正是这个技能的全部意义）',
    afterG.bs.length - beforeG.bs.length, 0);
  check('★ 释放方拿到"还剩几秒"的反馈', afterG.px[1] > 0 && afterG.px[1] <= 5.01,
    JSON.stringify(afterG.px));
  check('★ 对手的 px 两格都是 0 —— 只看自己那格是 0、另一格非 0 就等于告诉他"有幻影"',
    afterF.px[0] === 0 && afterF.px[1] === 0, JSON.stringify(afterF.px));
  check('★ 两队的包字段集合一致（只是值不同，不许静默多一个字段）',
    Object.keys(afterF).sort().join(',') === Object.keys(afterG).sort().join(','),
    `${Object.keys(afterF).length} vs ${Object.keys(afterG).length}`);
  check('★ 幻影进冷却，长度 = 15 秒', G.latest().sc[1] > 14 && G.latest().sc[1] <= 15,
    `sc[1]=${G.latest().sc[1]}`);

  // ---- ★ 9e-2. 蓝粘球在多球场上必须按球 ID 识别（2026-10-11 修复） ----
  // sk2 非 0 时必须提供 [球id, x, y, 槽位]，且 id 应属于当前快照中的球。
  {
    const state = G.latest();
    const sk2Ok = state.sk2 === 0
      || (Array.isArray(state.sk2) && state.sk2.length === 4
        && Number.isInteger(state.sk2[0])
        && state.sk2.every((value) => typeof value === 'number'));
    check('★ sk2 非 0 时是带球 ID 的四元组 [球id, x, y, 槽位]', sk2Ok,
      `sk2=${JSON.stringify(state.sk2)}`);
    if (state.sk2 !== 0) {
      check('★ sk2 球 ID 指向当前快照中的球',
        (state.bs || []).some((ball) => ball[0] === state.sk2[0]),
        `sk2[0]=${state.sk2[0]} 球 IDs=${JSON.stringify((state.bs || []).map((ball) => ball[0]))}`);
    }
  }

  // ---- 9f. 红色：超高速（蓄力）+ 灰板子按了白按 ----
  const P = makeClient('P');            // 红色
  const Q = makeClient('Q');            // 故意发个非法编号 99，验服务端归一化成灰
  await P.open();
  await Q.open();
  P.send({ t: 'create', skin: 3 });
  const joinedP = await P.wait('joined');
  Q.send({ t: 'join', code: joinedP.code, skin: 99 });
  await Q.wait('joined');
  await sleep(400);
  check('★ 非法皮肤编号（99）被归一化成灰（0），不是原样下发',
    JSON.stringify(P.latest().sk) === '[3,0]', JSON.stringify(P.latest().sk));

  P.send({ t: 'skill' });
  await sleep(350);
  check('★ 倒计时期间按红色：不会蓄力', P.latest().bo[0] === 0,
    JSON.stringify(P.latest().bo));

  const pPlay = await waitPhase(P, 'playing');
  check('前置：新房间推进到 playing', pPlay, '等待 playing 超时');
  const wOk = await waitOpenWindow(P);
  check('前置：等到一个安全窗口（这条同时保证"蓄力不会被下一板立刻打掉"）', wOk,
    `ph=${P.latest().ph} bs=${JSON.stringify(P.latest().bs)}`);
  P.send({ t: 'skill' });
  await sleep(150);
  check('★ 红色放得出来：放完是"已蓄力"（下一次击球才提速，不是立刻提速）',
    P.latest().bo[0] === 1, JSON.stringify(P.latest().bo));
  check('★ 红色进冷却，长度 = 10 秒', P.latest().sc[0] > 9 && P.latest().sc[0] <= 10,
    `sc[0]=${P.latest().sc[0]}`);

  const boCd = P.latest().sc[0];
  P.send({ t: 'skill' });
  await sleep(300);
  // ★ 这里只断言"冷却没被重新计时"。不断言 bo[0] 仍为 1 —— 球撞到拍子会正当消耗掉蓄力，
  //   而这一层控制不了球在哪。"再按被拒"本身的确定性验证在 test-rules 第 19.5 节。
  check('★ 已经蓄着力时再按不会把冷却重新计时（否则连按就等于白续 10 秒）',
    P.latest().sc[0] > 0 && P.latest().sc[0] <= boCd,
    `${boCd} -> ${P.latest().sc[0]}`);

  Q.send({ t: 'skill' });
  await sleep(350);
  check('★ 灰板子（没有技能）按了也没用，而且**不进冷却**（不是"进了冷却但没效果"）',
    Q.latest().bo[1] === 0 && Q.latest().sc[1] === 0 && Q.latest().wf.length === 0,
    `bo=${JSON.stringify(Q.latest().bo)} sc=${JSON.stringify(Q.latest().sc)}`);

  // ---- 9g. 技能不是无成本：两人各自独立计时 ----
  check('★ 冷却按**槽位**各算各的（P 在冷却里不影响 Q）',
    P.latest().sc[0] > 0 && Q.latest().sc[1] === 0,
    `P=${P.latest().sc[0]} Q=${Q.latest().sc[1]}`);

  await sleep(200);

  console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);

  A.ws.close();
  B2.ws.close();
  F.ws.close();
  G.ws.close();
  P.ws.close();
  Q.ws.close();
  await sleep(200);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`\n测试中断: ${e.message}\n`);
  process.exit(2);
});
