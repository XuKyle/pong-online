'use strict';

/**
 * 道具生成验证（纯协议层，不需要浏览器）。
 *
 * 为什么"被吃到"不做硬断言：球得恰好从道具旁经过才会触发，那是个概率事件。
 * 把概率事件写成断言，测试就会时红时绿 —— 那种测试比没有还糟。
 * 所以：生成做硬断言，吃到只作观察输出。
 */

const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3100;
const WSU = `ws://127.0.0.1:${PORT}/ws`;
const OBSERVE_MS = Number(process.env.OBSERVE_MS) || 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
function note(m) { console.log(`  · ${m}`); }

function client(name) {
  const ws = new WebSocket(WSU);
  const c = { name, ws, joined: null, states: [] };
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
  console.log(`\n目标: ${WSU}\n观察 ${OBSERVE_MS / 1000} 秒\n`);

  const A = client('A');
  const B = client('B');
  await A.open();
  await B.open();

  A.send({ t: 'create' });
  while (!A.joined) await sleep(60);
  B.send({ t: 'join', code: A.joined.code });
  while (!B.joined) await sleep(60);

  console.log('1) 双方入场');
  check('A 建房', A.joined.side === 0, JSON.stringify(A.joined));
  check('B 加入', B.joined.side === 1, JSON.stringify(B.joined));

  // ---------- 观察 ----------
  let spawnCount = 0;
  let eatCount = 0;
  let mulChanged = false;
  let lastType = null;
  let prevCount = 0;
  let maxOnField = 0;
  let minGapSeen = Infinity;
  const seenTypes = new Set();
  const posBad = [];

  const t0 = Date.now();
  while (Date.now() - t0 < OBSERVE_MS) {
    await sleep(100);
    const s = A.last();
    if (!s) continue;

    // 场上道具是**数组**（可以同时有多个）：us = [[x, y, 类型], ...]
    const list = Array.isArray(s.us) ? s.us : [];
    if (list.length > maxOnField) maxOnField = list.length;
    if (list.length > prevCount) spawnCount += list.length - prevCount;
    prevCount = list.length;
    for (let i = 0; i < list.length; i += 1) {
      const u = list[i];
      if (!Array.isArray(u) || u.length !== 3) continue;
      seenTypes.add(u[2]);
      lastType = u[2];
      // 位置得在场地内，而且不该贴着墙
      if (u[0] < 40 || u[0] > 760 || u[1] < 40 || u[1] > 460) {
        posBad.push(`${u[0]},${u[1]}`);
      }
      // 同时存在多个时必须互相错开，否则两个圈叠在一起会看成"一个道具给了两份效果"
      for (let j = i + 1; j < list.length; j += 1) {
        const d = Math.hypot(u[0] - list[j][0], u[1] - list[j][1]);
        if (d < minGapSeen) minGapSeen = d;
      }
    }

    if (Array.isArray(s.pm) && (s.pm[0] !== 1 || s.pm[1] !== 1)) mulChanged = true;

    if (Array.isArray(s.ev)) {
      for (const e of s.ev) {
        if (typeof e === 'string' && e.charAt(0) === 'u') eatCount += 1;
      }
    }
  }

  console.log('\n2) 道具生成');
  check('场上出现过道具', spawnCount > 0, `生成 ${spawnCount} 次`);
  check('道具位置都在场地内且不贴墙', posBad.length === 0,
    posBad.length ? posBad.slice(0, 3).join(' | ') : '全部正常');
  check('道具类型编号在合法范围（0..8，含分裂球与隐形球）',
    [...seenTypes].every((t) => Number.isInteger(t) && t >= 0 && t <= 8),
    `出现过的类型: ${[...seenTypes].join(',') || '无'}`);
  console.log('\n2b) 同时存在多个道具');
  note(`场上同时出现过的最大数量: ${maxOnField}`);
  check('★ 同一时刻出现过 ≥ 2 个道具（不是"一个吃完才来下一个"）',
    maxOnField >= 2, `最多只同时出现 ${maxOnField} 个`);
  check('★ 同时出现的道具之间留有间距（不会叠在一起看不清）',
    minGapSeen === Infinity || minGapSeen >= 2 * 21 + 20,
    minGapSeen === Infinity ? '未观察到两个同时存在' : `最近的两个相距 ${minGapSeen.toFixed(1)}px`);

  console.log('\n3) 观察项（概率事件，不硬断言）');
  note(`被吃到的次数: ${eatCount}`);
  note(`拍子/球速倍率出现过变化: ${mulChanged ? '是' : '否'}`);
  note(eatCount === 0 && !mulChanged
    ? '本轮球没有经过道具 —— 这不代表道具坏了，只是没撞上'
    : '道具确实被吃到并生效了');

  // 事件格式检查（只要有就得是合法格式）
  const evShapes = new Set();
  for (const s of A.states) {
    if (!Array.isArray(s.ev)) continue;
    for (const e of s.ev) evShapes.add(typeof e === 'string' ? e.charAt(0) : 'BAD');
  }
  console.log('\n4) 事件字段');
  check('ev 里没有非法条目', !evShapes.has('BAD'), [...evShapes].join(','));
  check('ev 出现过击球或得分事件（说明事件通道在工作）',
    evShapes.has('h') || evShapes.has('g'),
    `出现过的事件类型: ${[...evShapes].join(',') || '无'}`);

  console.log('\n5) 新增状态字段（冰冻 / 护盾 / 双倍得分）');
  const s0 = A.last();
  check('快照带冰冻字段 fz（两个数）',
    Array.isArray(s0.fz) && s0.fz.length === 2 && s0.fz.every((v) => v >= 0),
    JSON.stringify(s0.fz));
  check('快照带护盾字段 sh（两个整数）',
    Array.isArray(s0.sh) && s0.sh.length === 2 && s0.sh.every((v) => Number.isInteger(v)),
    JSON.stringify(s0.sh));
  check('快照带双倍得分字段 db（0/1）',
    Array.isArray(s0.db) && s0.db.length === 2 && s0.db.every((v) => v === 0 || v === 1),
    JSON.stringify(s0.db));

  // 事件里出现过的类型要能对上号
  note(`出现过的事件首字母: ${[...evShapes].join(',')}`);
  check('k（护盾挡球）与 x（双倍得分）没有非法格式',
    !evShapes.has('BAD'), '若出现即说明协议破了');

  console.log('\n6) 新增快照字段（模式 / 场地尺寸 / 弧线球）');
  check('快照带模式字段 md', typeof s0.md === 'string' && s0.md.length > 0, String(s0.md));
  check('快照带场地尺寸 wh（两个正数）',
    Array.isArray(s0.wh) && s0.wh.length === 2 && s0.wh[0] > 0 && s0.wh[1] > 0,
    JSON.stringify(s0.wh));
  check('这一局是经典模式，场地仍是 800x500',
    s0.md === 'duel' && s0.wh[0] === 800 && s0.wh[1] === 500,
    `${s0.md} ${JSON.stringify(s0.wh)}`);
  check('快照带弧线球字段 cv（数值，0 表示没在拐弯）',
    typeof s0.cv === 'number', String(s0.cv));
  check('经典模式下发两条拍子位置',
    Array.isArray(s0.p) && s0.p.length === 2, JSON.stringify(s0.p));

  console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  try { A.ws.close(); B.ws.close(); } catch (e) {}
  await sleep(200);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
