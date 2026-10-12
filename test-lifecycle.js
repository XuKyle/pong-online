'use strict';

/**
 * 端到端房间生命周期自测：建房 → 加入 → 暂停/恢复 → 掉线/重连 → 一局打完 → 自动开下一局。
 * 目的：Phase 6 把房间与对局生命周期搬进 server/match.js 之后，
 * 用真实 WebSocket 走一遍完整流程，确认传输层与领域层的边界没有漏掉任何一条副作用。
 */

const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3100;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

/**
 * Report one assertion and keep going after a failure.
 *
 * @param {string} label Behavior being checked.
 * @param {boolean} cond Assertion result.
 * @param {string} [extra] Detail shown on failure.
 * @returns {void}
 */
function check(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  [ok]   ${label}`);
  } else {
    fail += 1;
    console.error(`  [FAIL] ${label}${extra ? `  -> ${extra}` : ''}`);
    process.exitCode = 1;
  }
}

function makeClient(name) {
  const ws = new WebSocket(WS_URL);
  const c = { name, ws, got: Object.create(null), states: [], waiters: Object.create(null) };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'state') {
      c.states.push(m);
      if (c.states.length > 600) c.states.shift();
    }
    c.got[m.t] = m;
    const w = c.waiters[m.t];
    if (w) { c.waiters[m.t] = []; w.forEach((fn) => fn(m)); }
  });
  ws.on('error', () => {});
  c.open = () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  c.wait = (t, ms = 8000) => new Promise((res, rej) => {
    if (c.got[t]) return res(c.got[t]);
    (c.waiters[t] = c.waiters[t] || []).push(res);
    setTimeout(() => rej(new Error(`${name} 等待 ${t} 超时`)), ms);
    return undefined;
  });
  c.send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.latest = () => c.states[c.states.length - 1] || null;
  return c;
}

/**
 * Wait until the latest snapshot satisfies a predicate.
 *
 * @param {object} c Client handle.
 * @param {function(object): boolean} pred Snapshot condition.
 * @param {number} [ms=8000] Maximum wait.
 * @returns {Promise<boolean>} Whether the condition became true.
 */
async function waitSnap(c, pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = c.latest();
    if (s && pred(s)) return true;
    await sleep(120);
  }
  return false;
}

async function main() {
  console.log(`\n目标: ${WS_URL}\n`);

  // ---------- 1. 建房 / 加入 ----------
  console.log('1) 建房与加入');
  const a = makeClient('A');
  await a.open();
  a.send({ t: 'create', mode: 'duel', skin: 0 });
  const ja = await a.wait('joined');
  const code = ja.code;
  const tokenA = ja.token;

  const b = makeClient('B');
  await b.open();
  b.send({ t: 'join', code, skin: 0 });
  const jb = await b.wait('joined');

  check('建房方坐 0 号位、加入方坐 1 号位', ja.side === 0 && jb.side === 1, `${ja.side}/${jb.side}`);
  check('加入方拿到的 token 与建房方不同（座位各自独立）', tokenA !== jb.token);
  check('房间号一致', ja.code === jb.code);

  const started = await waitSnap(a, (s) => s.ph === 'playing', 8000);
  check('人齐之后自动开打（playing）', started, `phase=${a.latest() && a.latest().ph}`);

  // ---------- 2. 暂停 / 恢复 ----------
  console.log('\n2) 暂停与恢复');
  a.send({ t: 'pause' });
  await waitSnap(b, (s) => s.up === 1, 5000);
  check('★ 一方按下后另一方也暂停（暂停是房间级的）', a.latest().up === 1 && b.latest().up === 1);
  check('★ 两边都知道是谁按的（都指向 0 号位）', a.latest().pb === 0 && b.latest().pb === 0);
  check('★ 暂停是独立字段：phase 仍然是 playing（客户端才画球）',
    a.latest().ph === 'playing', `ph=${a.latest().ph}`);

  const frozen = a.latest().bs.map((x) => `${x[0]}|${x[1]}|${x[2]}`);
  await sleep(2500);
  check('★ 暂停期间比赛时间真的没走（球没动）',
    JSON.stringify(a.latest().bs.map((x) => `${x[0]}|${x[1]}|${x[2]}`)) === JSON.stringify(frozen));

  b.send({ t: 'pause' });
  await waitSnap(a, (s) => s.up === 0, 5000);
  check('★ 另一边按一下就能恢复（不必是按停的那个人）', a.latest().up === 0 && b.latest().up === 0);
  check('★ 恢复后"是谁按的"清掉了', a.latest().pb === -1);

  // ---------- 3. 掉线 / 重连 ----------
  console.log('\n3) 掉线与重连');
  const tokenB = jb.token;
  const beforeDrop = a.latest().s.slice();
  const matchNoBefore = a.latest().k;
  b.ws.close();
  await waitSnap(a, (s) => s.pr[1] === 0, 5000);
  check('★ 对手断开后立刻被标成不在场', a.latest().pr[1] === 0);

  const b2 = makeClient('B2');
  await b2.open();
  b2.send({ t: 'rejoin', code, token: tokenB });
  const rj = await b2.wait('rejoined');
  check('★ 凭原 token 回到原座位', rj.code === code && rj.side === 1, `side=${rj.side}`);
  await waitSnap(a, (s) => s.pr[1] === 1, 5000);
  check('★ 重连后在场标记恢复', a.latest().pr[1] === 1);

  b2.send({ t: 'pause' });
  await waitSnap(a, (s) => s.up === 1, 5000);
  b2.send({ t: 'pause' });
  await waitSnap(a, (s) => s.up === 0, 5000);
  check('★ 换连接之后照样能暂停（token 校验通过）', true);

  const bad = makeClient('BAD');
  await bad.open();
  bad.send({ t: 'rejoin', code, token: 'not-a-real-token' });
  const err = await bad.wait('error');
  check('★ 错误 token 被拒（座位不给出借）', /座位已失效/.test(err.msg), err.msg);
  bad.ws.close();

  // ---------- 4. 一局打完 / 自动开下一局 ----------
  console.log('\n4) 得分与下一局（需要打满一局，给足时间）');
  const over = await waitSnap(a, (s) => s.ph === 'over', 180000);
  if (!over) {
    check('一局能打到 over', false, `phase=${a.latest() && a.latest().ph} k=${a.latest() && a.latest().k}`);
  } else {
    const overSnap = a.latest();
    check('★ 一局结束后有明确的胜方', overSnap.wn === 0 || overSnap.wn === 1, `wn=${overSnap.wn}`);
    check('★ 两边看到的胜方一致', b2.latest().wn === overSnap.wn);
    check('★ 结算画面带上了失分取证记录（missLog）', Array.isArray(overSnap.mr) && overSnap.mr.length >= 1);
    check('★ 胜方那一队的分数先到 WIN_SCORE', Math.max(...overSnap.s) >= 11, JSON.stringify(overSnap.s));
    check('★ 并且净胜至少 2 分', Math.abs(overSnap.s[0] - overSnap.s[1]) >= 2, JSON.stringify(overSnap.s));

    const nextRound = await waitSnap(a, (s) => s.ph !== 'over' && s.ph !== 'waiting' && s.k > matchNoBefore + 10, 30000);
    check('★ 一局打完自动开下一局（阶段自己走回 countdown/playing）', nextRound,
      `phase=${a.latest() && a.latest().ph}`);
    if (nextRound) {
      check('★ 新一局比分归零', JSON.stringify(a.latest().s) === '[0,0]', JSON.stringify(a.latest().s));
      check('★ 局号变了（matchId 递增）', a.latest().mi !== overSnap.mi, `${overSnap.mi} -> ${a.latest().mi}`);
    }
  }

  check('★ 重连前后比分没有被重置（中途没有偷偷开新局）',
    JSON.stringify(beforeDrop) === JSON.stringify(a.latest().s) || a.latest().ph === 'over',
    `before=${JSON.stringify(beforeDrop)} after=${JSON.stringify(a.latest().s)}`);

  a.ws.close();
  b2.ws.close();
  await sleep(300);

  console.log(`\n========== 生命周期：通过 ${pass} / 失败 ${fail} ==========\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});