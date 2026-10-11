'use strict';

/**
 * 规则单元测试（离线，不需要服务在跑）。
 *
 * 为什么单独一个文件：胜负规则和道具效果都是纯逻辑，真打满一局要几十秒，
 * 而且 10:10 之后的分支在真实对局里极难复现。直接加载服务端模块来验，
 * 几毫秒就能把边界全覆盖。
 *
 * 用 PONG_NO_LISTEN=1 加载，避免和已经跑着的服务抢端口。
 */

process.env.PONG_NO_LISTEN = '1';
const S = require('./server.js');

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
function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${expected}，实际 ${actual}`);
}

/** 场上 0 号球。球改成数组之后（分裂球）到处都在用它 */
const B0 = (r) => r.balls[0];
/** 把 0 号球摆到指定状态 */
function setBall(r, x, y, vx, vy) {
  const b = r.balls[0];
  b.x = x; b.y = y; b.vx = vx; b.vy = vy;
  return r;
}
/** 让某队丢一球（走真实路径：把球拿走 + 结算比分） */
function concede(r, by) {
  S.afterGoal(r, by, r.balls[0]);
}

/**
 * 造一个"两个真人都在场"的房间。真人 = isLive(p) = p.ws.readyState === 1，
 * 所以这里只需要一个带 readyState 的假 ws —— 这个房间不会真的收发消息
 * （广播在 stepRoom 之外，本文件从不调用它）。
 */
function seat2(code) {
  const r = S.createRoom(code, 'duel');
  const fake = (token) => ({ ws: { readyState: 1 }, token, dir: 0, since: Date.now() });
  r.players[0] = fake('t0');
  r.players[1] = fake('t1');
  return r;
}

console.log('\n========== 规则单元测试 ==========\n');

// ---------- 0. 仪器自检 ----------
// ★ 断言里引用到的服务端常量必须真的被导出。
//   漏导出不会抛错：`x >= undefined` 恒为 false，而 `!(x > undefined)` 恒为 true ——
//   后者是一条**永远绿的假绿**（写反方向的上限断言就正好落进这个坑）。
//   真发生过：`minGap >= 2 * S.POWERUP_R + 20` 里的 POWERUP_R 没导出，
//   阈值算成 NaN，实测 107px 明明够宽松却稳定报红，排查了半天才发现是常量的问题。
//   所以这里先把"量具"本身验一遍，再开始量。
{
  const need = ['POWERUP_R', 'POWERUP_N', 'POWERUP_MAX', 'POWERUP_LIFE_MS',
    'POWERUP_GAP_MS', 'INVIS_MS', 'INVIS_FADE_MS', 'MAX_BALLS', 'SPLIT_SPEED_MUL',
    'POWERUP_MOD_MS', 'CURVE_MS', 'FREEZE_MS', 'SHIELD_MAX',
    // 第 17 节（防竖直卡死 + 加速节奏）要用到的
    'MIN_VX_RATIO', 'UNSTICK_ANG_MIN', 'UNSTICK_ANG_MAX', 'UNSTICK_MIN_SPEED',
    'SPEEDUP_PER_HIT', 'BALL_SPEED_MAX', 'BALL_SPEED_START',
    // 第 18 节（暂停）要用到的
    'COUNTDOWN_MS', 'OVER_HOLD_MS',
    // 第 19 节（皮肤与技能）要用到的
    'SKIN_GRAY', 'SKIN_WIND', 'SKIN_PHANTOM', 'SKIN_BOOST', 'SKIN_N', 'SKILL_CD_MS',
    'WIND_MS', 'WIND_ACC', 'PHANTOM_MS', 'PHANTOM_ANGLE', 'BOOST_SPEED',
    // 第 21 节（第 11 轮的五种新技能 + 局间重选拍子）要用到的
    'SKIN_STICK', 'SKIN_BLACKHOLE', 'SKIN_CHAOS', 'SKIN_BLOCK', 'SKIN_SLOW',
    'STICK_MS', 'HOLE_R', 'HOLE_LIFE_MS', 'HOLE_HALF_DEG', 'CHAOS_MS', 'CHAOS_HALF_DEG',
    'BLOCK_MAX', 'SLOW_MS', 'SLOW_MUL', 'PHANTOM_BOT_SWAY',
    'CURVE_SPIN', 'PADDLE_SPEED'];
  const missing = need.filter((k) => S[k] === undefined);
  check('断言用到的服务端常量都已导出（漏导出会让断言恒真/恒假）',
    missing.length === 0, `缺: ${missing.join(', ')}`);
  // ★ SKILL_CD_MS 是**数组**，不进下面这条"都是数字"的检查 —— 它混进来会稳定报红，
  //   而"它是不是数组、内容对不对"由紧接着的那条专门断言负责。
  //   （同一条 `need` 数组两用：先查"有没有导出"，再按类型分流查"导出的东西是不是那种类型"。）
  const needNum = need.filter((k) => k !== 'SKILL_CD_MS');
  check('导出的常量都不是 NaN / undefined',
    needNum.every((k) => typeof S[k] === 'number' && !Number.isNaN(S[k])),
    needNum.filter((k) => !(typeof S[k] === 'number' && !Number.isNaN(S[k]))).join(', '));
  // ★ 上面那条只验数字常量。函数型导出要单独验 —— 函数漏导出时不是恒真恒假，
  //   而是 "S.xxx is not a function" 直接把整个测试文件崩掉，看起来像测试框架坏了。
  const needFn = ['togglePause', 'shiftDeadlines', 'stepRoom', 'stepBalls', 'applyPowerup',
    'castSkill', 'castWind', 'castPhantom', 'clearSkills', 'isPhantom', 'normSkin',
    'skinHasSkill', 'removeBall', 'broadcastState', 'makeBall',
    // 第 21 节
    'castStick', 'castBlackhole', 'castChaos', 'castBlock', 'castSlow', 'checkBlackhole',
    'pickSkin', 'canPickSkin'];
  const missingFn = needFn.filter((k) => typeof S[k] !== 'function');
  check('断言用到的服务端函数都已导出', missingFn.length === 0, `缺: ${missingFn.join(', ')}`);
  // SKILL_CD_MS 是数组；单独验一下长度与内容，免得后面按下标取到 undefined 却当成 0
  check('SKILL_CD_MS 覆盖了每一种皮肤（灰的没有技能，写 0）',
    Array.isArray(S.SKILL_CD_MS) && S.SKILL_CD_MS.length === S.SKIN_N
      && S.SKILL_CD_MS[0] === 0 && S.SKILL_CD_MS[1] > 0 && S.SKILL_CD_MS[2] > 0 && S.SKILL_CD_MS[3] > 0,
    JSON.stringify(S.SKILL_CD_MS));
}

// ---------- 1. 胜负判定 ----------
console.log('1) 胜负判定（先到 11 分，且净胜 2 分）');
eq('常量：WIN_SCORE 是 11', S.WIN_SCORE, 11);
eq('常量：净胜要求是 2 分', S.WIN_MARGIN, 2);

const W = S.isWin;
check('10:0 不算赢（还没到 11 分）', W(10, 0) === false);
check('11:0 赢', W(11, 0) === true);
check('11:9 赢（净胜 2）', W(11, 9) === true);
check('★ 11:10 不赢（净胜只有 1）', W(11, 10) === false);
check('★ 12:10 赢（连赢两分）', W(12, 10) === true);
check('★ 12:11 不赢', W(12, 11) === false);
check('★ 13:11 赢', W(13, 11) === true);
check('10:10 不赢（平局继续）', W(10, 10) === false);
check('对手 11 分不代表自己赢', W(9, 11) === false);
check('0:11 不赢', W(0, 11) === false);
check('20:18 赢（长盘也守净胜 2）', W(20, 18) === true);
check('20:19 不赢', W(20, 19) === false);

// ---------- 2. 新房间的初始状态 ----------
console.log('\n2) 新房间初始状态');
const room = S.createRoom('TEST01');
check('events 是数组（否则广播时会抛错）', Array.isArray(room.events));
eq('events 初始为空', room.events.length, 0);
eq('场上没有道具', room.powerups.length, 0);
check('球是一个数组（分裂球会让场上同时有多个）',
  Array.isArray(room.balls) && room.balls.length === 1, JSON.stringify(room.balls.length));
check('每个球带稳定 id（客户端靠它做跨快照身份匹配）',
  room.balls.every((b) => typeof b.id === 'number' && b.id > 0), JSON.stringify(room.balls.map((b) => b.id)));
check('拍子倍率初始为 1:1',
  room.paddleMul[0] === 1 && room.paddleMul[1] === 1,
  JSON.stringify(room.paddleMul));
check('球速倍率初始为 1', room.ballMul === 1);
eq('最后击球方初始为空', room.lastHitter, -1);
check('拍子半长 = PADDLE_H/2', S.paddleHalf(room, 0) === 48, String(S.paddleHalf(room, 0)));

// ---------- 3. 道具效果 ----------
console.log('\n3) 道具效果与过期');
const t0 = 1_000_000;

S.applyPowerup(room, 0, 0, t0);
eq('类型0 加长自己：倍率 1.65', room.paddleMul[0], S.PADDLE_GROW);
check('类型0 不影响对手', room.paddleMul[1] === 1, String(room.paddleMul[1]));
check('加长后拍子半长同步变大',
  S.paddleHalf(room, 0) === (96 * S.PADDLE_GROW) / 2,
  String(S.paddleHalf(room, 0)));

const room2 = S.createRoom('TEST02');
S.applyPowerup(room2, 0, 1, t0);
eq('类型1 削短的是对手（side 1）', room2.paddleMul[1], S.PADDLE_SHRINK);
check('类型1 不影响自己', room2.paddleMul[0] === 1, String(room2.paddleMul[0]));

const room3 = S.createRoom('TEST03');
S.applyPowerup(room3, 1, 2, t0);
eq('类型2 球速倍率生效', room3.ballMul, S.BALL_FAST);

// 重复吃同一个道具不应该叠乘
S.applyPowerup(room2, 1, 1, t0);
eq('对方重复被削短仍是同一倍率（不叠乘）', room2.paddleMul[0], S.PADDLE_SHRINK);

// 未到期不应复位
S.trackMods(room, t0 + S.POWERUP_MOD_MS - 500);
eq('未到期时倍率保持', room.paddleMul[0], S.PADDLE_GROW);

// 到期复位
S.trackMods(room, t0 + S.POWERUP_MOD_MS + 1);
eq('到期后拍子倍率复位为 1', room.paddleMul[0], 1);
S.trackMods(room3, t0 + S.POWERUP_MOD_MS + 1);
eq('到期后球速倍率复位为 1', room3.ballMul, 1);

// ---------- 4. 道具归属配合 ----------
console.log('\n4) 道具归属与拍子边界的一致性');
const room4 = S.createRoom('TEST04');
S.applyPowerup(room4, 1, 0, t0);
check('side 1 加长后，它的半长确实变了',
  S.paddleHalf(room4, 1) > 48 && S.paddleHalf(room4, 0) === 48,
  `side0=${S.paddleHalf(room4, 0)} side1=${S.paddleHalf(room4, 1)}`);

// ---------- 5. 新增三种道具 ----------
console.log('\n5) 新增道具：冰冻 / 护盾 / 双倍得分');
eq('道具总数是 9（含分裂球与隐形球）', S.POWERUP_N, 9);

const room5 = S.createRoom('TEST05');
S.applyPowerup(room5, 0, 3, t0);
check('冰冻作用在**对方**身上（不是自己）',
  room5.freezeUntil[1] === t0 + S.FREEZE_MS && room5.freezeUntil[0] === 0,
  `[${room5.freezeUntil}]`);
check('冰冻不叠加时长（取较晚的到期时间）', (() => {
  S.applyPowerup(room5, 0, 3, t0 + 500);
  return room5.freezeUntil[1] === t0 + 500 + S.FREEZE_MS;
})());

S.applyPowerup(room5, 0, 4, t0);
eq('护盾加在自己身上', room5.shield[0], 1);
S.applyPowerup(room5, 0, 4, t0);
eq('护盾可以叠到 2 层', room5.shield[0], 2);
S.applyPowerup(room5, 0, 4, t0);
eq('护盾有上限，不会无限叠', room5.shield[0], S.SHIELD_MAX);

S.applyPowerup(room5, 0, 5, t0);
check('双倍得分记在自己身上',
  room5.doubleUntil[0] === t0 + S.POWERUP_MOD_MS && room5.doubleUntil[1] === 0,
  `[${room5.doubleUntil}]`);

S.trackMods(room5, t0 + S.FREEZE_MS + 600);
eq('冰冻到期后复位', room5.freezeUntil[1], 0);
check('双倍得分还没到期时仍然有效', room5.doubleUntil[0] > 0);
S.trackMods(room5, t0 + S.POWERUP_MOD_MS + 1);
eq('双倍得分到期后复位', room5.doubleUntil[0], 0);

// ---------- 6. 护盾挡球 ----------
console.log('\n6) 护盾：把要出界的球挡回来');
const rz = S.createRoom('TEST06');
rz.shield = [1, 0];
setBall(rz, -5, 250, -300, 0);
check('有护盾时挡下成功', S.useShield(rz, 0) === true);
eq('挡下后消耗一层', rz.shield[0], 0);
check('挡下后球被推回场内且反向',
  B0(rz).x > 0 && B0(rz).vx > 0,
  `x=${B0(rz).x} vx=${B0(rz).vx}`);
check('挡下后记录事件（前端要出音效）', rz.events.includes('k0'), rz.events.join(','));
check('没有护盾就挡不住', S.useShield(rz, 0) === false);

// ---------- 7. 双倍得分 × 胜负判定 ----------
console.log('\n7) 双倍得分与 11 分制（★ 计分必须走 afterGoal）');
{
  const now = Date.now();
  const d1 = S.createRoom('TEST07');
  d1.score = [10, 9];
  d1.doubleUntil = [now + 5000, 0];
  concede(d1, 1);          // side1 丢分 → side0 得分，且它有双倍
  eq('双倍生效时一次加两分', d1.score[0], 12);
  check('12:9 判定获胜', d1.phase === 'over' && d1.winner === 0,
    `phase=${d1.phase} winner=${d1.winner}`);

  const d2 = S.createRoom('TEST08');
  d2.score = [10, 10];
  d2.doubleUntil = [now + 5000, 0];
  concede(d2, 1);
  eq('10 平后双倍拿到 12 分', d2.score[0], 12);
  check('12:10 净胜 2 → 赢', d2.phase === 'over' && d2.winner === 0);

  const d3 = S.createRoom('TEST09');
  d3.score = [9, 10];
  d3.doubleUntil = [now + 5000, 0];
  concede(d3, 1);
  eq('9:10 时双倍拿到 11 分', d3.score[0], 11);
  check('11:10 净胜只有 1 → 不结束', d3.phase !== 'over',
    `phase=${d3.phase}`);

  const d4 = S.createRoom('TEST10');
  d4.score = [4, 9];
  d4.doubleUntil = [0, 0];
  concede(d4, 1);
  eq('没有双倍时只加一分', d4.score[0], 5);
  check('5:9 不结束', d4.phase !== 'over', `phase=${d4.phase}`);

  const d5 = S.createRoom('TEST11');
  d5.score = [4, 9];
  d5.doubleUntil = [now + 5000, 0];
  d5.events = [];
  concede(d5, 1);
  eq('双倍时 4:9 变 6:9', d5.score[0], 6);
  check('双倍得分会额外发一个 x 事件',
    d5.events.includes('g0') && d5.events.includes('x0'), d5.events.join(','));
}

// ---------- 8. 人机对战：座位与在场语义 ----------
console.log('\n8) 人机对战');
const P = S.BOT_PRESETS;
check('难度递进：反应更快 → 误差更小 → 移动更快',
  P[0].thinkMs > P[1].thinkMs && P[1].thinkMs > P[2].thinkMs
  && P[0].errPx > P[1].errPx && P[1].errPx > P[2].errPx
  && P[0].speedMul < P[1].speedMul && P[1].speedMul < P[2].speedMul,
  JSON.stringify(P));

const rs = S.createRoom('BOT001', true, 2);
check('人机房间右侧坐的是 AI', S.isBot(rs.players[1]) === true);
check('AI 没有 ws（走的是另一套在场判定）', rs.players[1].ws === null);
check('AI 被算作在场（否则比赛会一直暂停）', S.isPresent(rs.players[1]) === true);
eq('难度 2 对应「困难」', rs.players[1].cfg.name, '困难');
eq('难度越界会被夹到最大值', S.createRoom('BOT002', true, 99).botLevel, P.length - 1);
eq('难度为负也会被夹到 0', S.createRoom('BOT003', true, -5).botLevel, 0);
check('非人机房间右侧是空的', S.createRoom('BOT004').players[1] === null);
check('机器人不算「活着」（否则人走了房间永远回收不掉）',
  S.isBot(rs.players[1]) && !(rs.players[1].ws), '机器人没有 ws ⇒ anyAlive 为 false');

// ---------- 9. 球路预测 ----------
console.log('\n9) 球路预测（含上下墙折返）');
const H = 500, BR = 9;
/** 参照实现：用极小步长真的把球走一遍，拿它来对照公式 —— 公式错了这一步会抓住 */
function simRefY(ball, faceX, dt) {
  let x = ball.x, y = ball.y, vx = ball.vx, vy = ball.vy;
  for (let g = 0; g < 400000; g += 1) {
    x += vx * dt;
    y += vy * dt;
    if (y - BR < 0) { y = BR; vy = Math.abs(vy); }
    else if (y + BR > H) { y = H - BR; vy = -Math.abs(vy); }
    if ((vx > 0 && x >= faceX) || (vx < 0 && x <= faceX)) return y;
  }
  return null;
}

function mkBall(x, y, vx, vy) {
  const r = S.createRoom('PRED');
  setBall(r, x, y, vx, vy);
  r.ballMul = 1;
  return r;
}

const cases = [
  ['直线无折返', mkBall(400, 250, 100, 0), 700],
  ['直线无折返（斜线）', mkBall(400, 250, 100, 60), 700],
  ['碰一次下墙', mkBall(0, 400, 100, 500), 200],
  ['碰多次（高速斜线）', mkBall(100, 200, 300, 900), 751],
  ['向左飞', mkBall(700, 300, -250, -400), 49],
];
for (const [name, room, faceX] of cases) {
  const got = S.predictY(room, B0(room), faceX);
  const ref = simRefY(B0(room), faceX, 0.0002);
  check(`预测 ${name}`, ref !== null && Math.abs(got - ref) < 2.5,
    `公式=${got.toFixed(2)} 模拟=${ref === null ? 'null' : ref.toFixed(2)}`);
}
check('球速为 0（还没发球）时退回当前 y',
  S.predictY(mkBall(400, 333, 0, 0), B0(mkBall(400, 333, 0, 0)), 700) === 333);
check('预测点在自己身后时退回当前 y',
  S.predictY(mkBall(400, 222, -100, 0), B0(mkBall(400, 222, -100, 0)), 700) === 222);

// ---------- 10. 弧线球（第 7 种道具） ----------
console.log('\n10) 弧线球');
const rc = S.createRoom('CURVE0');
S.applyPowerup(rc, 0, 6, t0);
check('弧线球记下到期时间与角速度',
  rc.curveUntil === t0 + S.CURVE_MS
  && Math.abs(Math.abs(rc.curveSpin) - S.CURVE_SPIN) < 1e-9,
  `until=${rc.curveUntil} spin=${rc.curveSpin}`);
check('弧线球只影响球，不动拍子倍率',
  rc.paddleMul[0] === 1 && rc.paddleMul[1] === 1, JSON.stringify(rc.paddleMul));

S.trackMods(rc, t0 + S.CURVE_MS + 1);
check('到期后角速度必须一起清 0（只清时间的话球会永远拐弯）',
  rc.curveUntil === 0 && rc.curveSpin === 0,
  `until=${rc.curveUntil} spin=${rc.curveSpin}`);

/**
 * 真的把球推一段时间，看它到底有没有拐弯。
 * ★ 这里同时钉住两件事，它们是"用旋转而不是用加速度"的全部理由：
 *   ① 速率必须严格不变 —— 用"加一个横向加速度"写会一路累加，
 *      几秒后球快得没法接，而且会突破 BALL_SPEED_MAX；
 *   ② 轨迹确实弯了 —— 不然这个道具等于没做。
 */
function flyCurve(spin, seconds) {
  const r = S.createRoom('CURVE9');
  const now = Date.now();
  r.serverTime = now;
  r.curveUntil = now + 60000;
  r.curveSpin = spin;
  setBall(r, 200, 250, 400, 0);
  const v0 = Math.hypot(B0(r).vx, B0(r).vy);
  const steps = Math.round(seconds * 240);
  for (let i = 0; i < steps; i += 1) S.stepBalls(r, 1 / 240);
  return { r, v0, v1: Math.hypot(B0(r).vx, B0(r).vy) };
}

const cvp = flyCurve(S.CURVE_SPIN, 1);
check('★ 拐弯期间速率严格不变（与出发时一致）',
  Math.abs(cvp.v1 - cvp.v0) < 1e-6, `${cvp.v0} -> ${cvp.v1}`);
check('★ 轨迹确实弯了：直线飞 1 秒 y 不会变，实际偏了一大截',
  B0(cvp.r).y > 250 + 50, `y=${B0(cvp.r).y.toFixed(1)}`);
check('拐弯后速度方向也变了（不只是位置偏移）',
  B0(cvp.r).vy > 50, `vy=${B0(cvp.r).vy.toFixed(1)}`);

const cvn = flyCurve(-S.CURVE_SPIN, 1);
check('角速度取负就往另一边弯（方向可控，不是随机乱飘）',
  B0(cvn.r).y < 250 - 50, `y=${B0(cvn.r).y.toFixed(1)}`);

const cvs = flyCurve(0, 1);
check('没有弧线球时球走直线（对照组，证明上面两条不是恒真）',
  Math.abs(B0(cvs.r).y - 250) < 1e-6 && Math.abs(cvs.v1 - cvs.v0) < 1e-6,
  `y=${B0(cvs.r).y}`);

// ---------- 11. 双人对抗 AI：布局 ----------
console.log('\n11) 双人对抗 AI 的球场布局');
const c1 = S.createRoom('COOP01', 'coop', 1);
eq('coop 有三个拍子槽位', c1.N, 3);
check('球台比经典模式高（两个真人各守一半才够用）', c1.H > S.H, `coop=${c1.H} duel=${S.H}`);
check('左边两个槽位同属 0 队（他们是一支队伍）',
  c1.slots[0].team === 0 && c1.slots[1].team === 0, JSON.stringify(c1.slots));
eq('右边那个槽位是 1 队', c1.slots[2].team, 1);
check('左边两块拍子各守一半，交界正好在中线',
  c1.slots[0].span[1] === c1.H / 2 && c1.slots[1].span[0] === c1.H / 2,
  JSON.stringify([c1.slots[0].span, c1.slots[1].span]));
check('AI 那块能上下覆盖整个场地',
  c1.slots[2].span[0] === 0 && c1.slots[2].span[1] === c1.H,
  JSON.stringify(c1.slots[2].span));
check('AI 坐在第三个槽位', S.isBot(c1.players[2]) === true);
check('两个真人位一开始是空的（等第二个人用房间码加入）',
  c1.players[0] === null && c1.players[1] === null,
  JSON.stringify(c1.players.map((p) => (p ? 'x' : null))));
check('★ coop 的 AI 比同一档的单人模式更快（它要一个人守整条边）',
  c1.players[2].speedMul > S.makeBot(1).speedMul,
  `coop=${c1.players[2].speedMul} solo=${S.makeBot(1).speedMul}`);
check('coop 的球出速更快（场地更宽，不提速会拖沓）',
  c1.ballSpeed0 > S.createRoom('DUEL01').ballSpeed0,
  `${c1.ballSpeed0} vs ${S.createRoom('DUEL01').ballSpeed0}`);
check('coop 开局把两块拍子摆在各自半场中间',
  c1.paddles[0] === c1.H / 4 && c1.paddles[1] === c1.H * 0.75 && c1.paddles[2] === c1.H / 2,
  JSON.stringify(c1.paddles));
check('经典模式仍然是两条拍子', S.createRoom('DUEL02').N === 2);
check('未知模式名退回经典模式（别把参数写错就当没事）',
  S.normMode('wtf') === 'duel' && S.createRoom('DUEL03', 'wtf').N === 2);

// ---------- 12. coop 里道具按「队」生效 ----------
console.log('\n12) coop 里道具作用于整队');
const c2 = S.createRoom('COOP02', 'coop', 1);
check('起始两块左拍半长相同', S.paddleHalf(c2, 0) === S.paddleHalf(c2, 1));
S.applyPowerup(c2, 0, 0, t0);
check('加长自己 → 左队两块拍子一起变长',
  S.paddleHalf(c2, 0) > 48 && S.paddleHalf(c2, 1) > 48,
  `${S.paddleHalf(c2, 0)} / ${S.paddleHalf(c2, 1)}`);
check('加长不影响 AI 那块', S.paddleHalf(c2, 2) === 48, String(S.paddleHalf(c2, 2)));

const c3 = S.createRoom('COOP03', 'coop', 1);
S.applyPowerup(c3, 0, 1, t0);
check('削短对方 → 削的是 AI 那块', S.paddleHalf(c3, 2) < 48, String(S.paddleHalf(c3, 2)));
check('削短不影响自己这队', S.paddleHalf(c3, 0) === 48);

const c4 = S.createRoom('COOP04', 'coop', 1);
S.applyPowerup(c4, 0, 3, t0);
check('冰冻对方 → 冻的是 1 队（AI 那块拍子）',
  c4.freezeUntil[1] === t0 + S.FREEZE_MS && c4.freezeUntil[0] === 0,
  `[${c4.freezeUntil}]`);
S.applyPowerup(c4, 0, 4, t0);
check('护盾加给整队（记在 0 队头上，不是某个拍子）', c4.shield[0] === 1);

// ---------- 13. coop 里拍子推不出自己那半场 ----------
console.log('\n13) coop 的活动范围限制');
const c5 = S.createRoom('COOP05', 'coop', 1);
const fakeWs = { readyState: 1, send() {} };
// ★ 推的方向必须**朝着分界线**：上半场往下推、下半场往上推。
//   顺手写成"上半场往上、下半场往下"是测不出东西的 —— 那两个方向和全局范围
//   [half, H-half] 的上下限恰好撞在同一个数值上（48 / 752），
//   把 span 限制整段删掉，断言照样全绿。
c5.players[0] = { ws: fakeWs, token: 't0', dir: 1, since: Date.now() };
c5.players[1] = { ws: fakeWs, token: 't1', dir: -1, since: Date.now() };
c5.serverTime = Date.now();
// 一直往分界线推，推足 2 秒（远超走完全程所需）
for (let i = 0; i < 480; i += 1) S.stepPaddles(c5, 1 / 240);
check('★ 上半场那块顶到中线前就被挡住，进不了下半场',
  Math.abs(c5.paddles[0] - (c5.H / 2 - 48)) < 1, `y=${c5.paddles[0]}`);
check('★ 下半场那块也是，顶不回上半场',
  Math.abs(c5.paddles[1] - (c5.H / 2 + 48)) < 1, `y=${c5.paddles[1]}`);
check('两块拍子始终待在自己那半场里（合起来才是一整条边，中间会漏球）',
  c5.paddles[0] <= c5.H / 2 && c5.paddles[1] >= c5.H / 2,
  `${c5.paddles[0]} / ${c5.paddles[1]}`);

// ★ 上面查的是**中心点**。但玩家真正在意的是"拍子整个人都别伸进对面半场" ——
//   所以还要查 y ± 半长 这条完整边界。吃到「加长」之后半长会从 48 变到 79.2，
//   如果夹取用的是写死的 48 而不是 paddleHalf()，这里立刻就会露出来。
const grown = S.createRoom('COOP06', 'coop', 1);
S.applyPowerup(grown, 0, 0, Date.now());            // 0 = 加长自己的拍子
check('道具确实把左队的拍子加长了（前置条件成立，这条不成立下面就没意义）',
  grown.paddleMul[0] > 1, `mul=${grown.paddleMul[0]}`);
grown.players[0] = { ws: fakeWs, token: 'g0', dir: 1, since: Date.now() };
grown.players[1] = { ws: fakeWs, token: 'g1', dir: -1, since: Date.now() };
grown.serverTime = Date.now();
for (let i = 0; i < 480; i += 1) S.stepPaddles(grown, 1 / 240);
const halfG = (96 * grown.paddleMul[0]) / 2;
check('★ 加长后，拍子**整个人**（中心 ± 半长）仍不越中线',
  grown.paddles[0] + halfG <= grown.H / 2 + 0.01
  && grown.paddles[1] - halfG >= grown.H / 2 - 0.01,
  `上 ${grown.paddles[0]}+${halfG} / 下 ${grown.paddles[1]}-${halfG}，中线 ${grown.H / 2}`);
check('★ 加长后整体仍在场地内（没被顶出边界）',
  grown.paddles[0] - halfG >= -0.01
  && grown.paddles[1] + halfG <= grown.H + 0.01,
  `上 ${grown.paddles[0] - halfG} / 下 ${grown.paddles[1] + halfG}`);
// 注：这一条的有效性是靠"临时把 stepPaddles 里的 paddleHalf() 换成常量 48"验出来的
// （换成常量后本组立刻变红）。不要在测试里自己重写一遍 buggy 逻辑再断言它越界 ——
// 那只是同义反复，证明不了任何东西。

// ---------- 14. 分裂球（第 8 种道具）与多球回合 ----------
console.log('\n14) 分裂球 / 多球 / 球球碰撞');
{
  // (a) 原球完全不动，多出一个半速球
  const sp = S.createRoom('SPLIT1');
  setBall(sp, 300, 200, 400, 300);
  const vBase = Math.hypot(B0(sp).vx, B0(sp).vy);
  const before = { x: B0(sp).x, y: B0(sp).y, vx: B0(sp).vx, vy: B0(sp).vy, id: B0(sp).id };
  const ok = S.splitBall(sp);
  check('分裂成功', ok === true);
  eq('场上变成两个球', sp.balls.length, 2);
  check('★ 原球的轨迹与速度**完全没变**（位置/速度逐字段相等）',
    B0(sp).id === before.id
    && B0(sp).x === before.x && B0(sp).y === before.y
    && B0(sp).vx === before.vx && B0(sp).vy === before.vy,
    `改前 ${JSON.stringify(before)} 改后 id=${B0(sp).id} v=(${B0(sp).vx},${B0(sp).vy})`);
  check('★ 新球带一个不同的 id（客户端靠它做身份匹配）',
    sp.balls[1].id !== sp.balls[0].id, `${sp.balls[0].id} vs ${sp.balls[1].id}`);
  const vNew = Math.hypot(sp.balls[1].vx, sp.balls[1].vy);
  check('★ 新球初速度 = 原球的一半',
    Math.abs(vNew - vBase * S.SPLIT_SPEED_MUL) < 1e-9,
    `${vNew.toFixed(3)} vs ${(vBase * S.SPLIT_SPEED_MUL).toFixed(3)}`);
  check('★ 新球从原球的位置出发（不是从场地中心冒出来）',
    Math.abs(sp.balls[1].x - before.x) < 1e-9 && Math.abs(sp.balls[1].y - before.y) < 1e-9,
    `(${sp.balls[1].x},${sp.balls[1].y})`);

  // (b) 新球必须和原球分得开（不能重叠着飞，那样看不出分裂）
  check('★ 两个球的方向不同（否则会重叠在一起飞，看成分裂失败）',
    Math.abs(sp.balls[1].vy - sp.balls[0].vy) > 1e-6
    || Math.abs(sp.balls[1].vx - sp.balls[0].vx) > 1e-6,
    JSON.stringify([sp.balls[0].vx, sp.balls[0].vy, sp.balls[1].vx, sp.balls[1].vy]));

  // 近水平的球（vy≈0）不能靠"上下镜像"分开 —— 镜像后方向完全相同
  const flat = S.createRoom('SPLIT2');
  setBall(flat, 300, 250, 400, 0);
  S.splitBall(flat);
  const sep = Math.abs(flat.balls[1].vy - flat.balls[0].vy);
  check('★ 近水平的球也会被掰开一个角度（vy≈0 时镜像等于没分）',
    sep > 50 && Math.abs(Math.hypot(flat.balls[1].vx, flat.balls[1].vy) - 200) < 1e-6,
    `vy 差 ${sep.toFixed(1)}，新球速率 ${Math.hypot(flat.balls[1].vx, flat.balls[1].vy).toFixed(1)}`);

  // (c) 球数上限
  const cap = S.createRoom('SPLIT3');
  setBall(cap, 300, 250, 400, 200);
  let made = 0;
  for (let i = 0; i < 10; i += 1) if (S.splitBall(cap)) made += 1;
  check(`★ 反复分裂不会无限增长（上限 ${S.MAX_BALLS} 个）`,
    cap.balls.length === S.MAX_BALLS, `实际 ${cap.balls.length} 个，成功分裂 ${made} 次`);

  // (d) 每个球漏了都算丢一分，但场上还有球就不重发
  const multi = S.createRoom('SPLIT4');
  multi.phase = 'playing';                 // createRoom 默认是 countdown，先进入对打阶段
  setBall(multi, 300, 250, 400, 200);
  S.splitBall(multi);
  eq('前置：场上两个球', multi.balls.length, 2);
  const ballA = multi.balls[0];
  S.afterGoal(multi, 0, ballA);            // 左队漏掉第一个
  eq('漏一个球就扣一分', multi.score[1], 1);
  eq('场上还剩一个球', multi.balls.length, 1);
  check('★ 还有球在场上 → **不**重新发球（阶段仍是 playing）',
    multi.phase === 'playing', `phase=${multi.phase}`);
  S.afterGoal(multi, 0, multi.balls[0]);   // 再漏掉第二个
  eq('第二个球漏了再扣一分', multi.score[1], 2);
  check('★ 所有球都没接住 → 这才重新发球（进入倒计时）',
    multi.phase === 'countdown', `phase=${multi.phase}`);
  eq('重新发球后场上只有一个球', multi.balls.length, 1);

  // (e) 等质量弹性碰撞：动量守恒 + 只在靠近时响应
  // ★ 两球必须放在**碰撞距离以内**（直径 18px），摆到 20px 外就什么都不会发生 ——
  //   第一版就是摆远了，结果"动量守恒"和"控制组"两条同时通过，说明整个用例在空转。
  const cc = S.createRoom('COLL1');
  setBall(cc, 380, 250, 300, 0);
  const b2 = S.makeBall(396, 250);
  b2.vx = -200; b2.vy = 0;
  cc.balls.push(b2);
  const px0 = cc.balls[0].vx + cc.balls[1].vx;
  S.resolveBallCollisions(cc);
  check('★ 正碰：沿连心线的动量守恒（等质量 = 交换法向分量）',
    Math.abs((cc.balls[0].vx + cc.balls[1].vx) - px0) < 1e-9,
    `${px0} -> ${cc.balls[0].vx + cc.balls[1].vx}`);
  check('★ 正碰后两球速度互换（300 与 -200 对调）',
    Math.abs(cc.balls[0].vx - (-200)) < 1e-9 && Math.abs(cc.balls[1].vx - 300) < 1e-9,
    `[${cc.balls[0].vx}, ${cc.balls[1].vx}]`);

  // 不在碰撞距离内就不该有任何反应
  const far = S.createRoom('COLL2');
  setBall(far, 100, 250, 300, 0);
  const b3 = S.makeBall(400, 250);
  b3.vx = -300; b3.vy = 0;
  far.balls.push(b3);
  S.resolveBallCollisions(far);
  check('距离够远时互不影响（对照组）',
    far.balls[0].vx === 300 && far.balls[1].vx === -300,
    JSON.stringify(far.balls.map((b) => b.vx)));
  // 也验一次"在距离内但正在分开"→ 必须放过（这是真的在测判据，不是同义反复）
  const parting = S.createRoom('COLL2B');
  setBall(parting, 380, 250, -300, 0);
  const b3b = S.makeBall(396, 250);
  b3b.vx = 300; b3b.vy = 0;
  parting.balls.push(b3b);
  S.resolveBallCollisions(parting);
  check('★ 在碰撞距离内但**正在分开**的两球不该被再弹一次（否则会互相追着弹）',
    parting.balls[0].vx === -300 && parting.balls[1].vx === 300,
    JSON.stringify(parting.balls.map((b) => b.vx)));

  // 重叠但**正在分开**（分裂球刚生成的那一 tick）必须放过
  const sepc = S.createRoom('COLL3');
  setBall(sepc, 300, 250, 300, 200);
  S.splitBall(sepc);
  const vBefore = sepc.balls.map((b) => [b.vx, b.vy]);
  S.resolveBallCollisions(sepc);
  check('★ 刚分裂出来、还重叠但正在分开的两球**不被误判为碰撞**',
    sepc.balls.every((b, i) => b.vx === vBefore[i][0] && b.vy === vBefore[i][1]),
    JSON.stringify(sepc.balls.map((b) => [b.vx, b.vy])));

  // (f) 球球碰撞后速度必须被夹回上限（反隧穿的前提）
  const fast = S.createRoom('COLL4');
  setBall(fast, 380, 250, 900, 0);
  const b4 = S.makeBall(400, 260);
  b4.vx = -900; b4.vy = 0;
  fast.balls.push(b4);
  S.resolveBallCollisions(fast);
  check('★ 斜碰之后每个球的基础速度都被夹回 BALL_SPEED_MAX',
    fast.balls.every((b) => Math.hypot(b.vx, b.vy) <= 900 + 1e-9),
    JSON.stringify(fast.balls.map((b) => Math.hypot(b.vx, b.vy).toFixed(2))));

  // (g) 多球同时推进时，出界的球被移出数组不会让后面的球漏判
  const two = S.createRoom('SPLIT5');
  two.phase = 'playing';
  setBall(two, -20, 250, -400, 0);         // 这个球马上要出界
  const b5 = S.makeBall(400, 250);
  b5.vx = 200; b5.vy = 0;
  two.balls.push(b5);
  const yBefore = b5.y;
  S.stepBalls(two, 1 / 240);
  eq('出界的球被移出场上', two.balls.length, 1);
  check('★ 剩下的球仍然被推进了（没有因为下标前移而漏掉）',
    two.balls[0].x !== 400 || two.balls[0].y !== yBefore,
    `x=${two.balls[0].x} y=${two.balls[0].y}`);
  eq('漏一个球只扣一分', two.score[1], 1);
}



// ---------- 15. 场上可以同时有多个道具 ----------
console.log('\n15) 场上同时挂多个道具');
{
  const pu = S.createRoom('PUMS01');
  pu.phase = 'playing';
  // 球停在刷新区之外，免得它把道具吃掉（吃掉会让数量断言变得不确定）
  setBall(pu, 20, 10, 0, 0);

  let t = Date.now() + 100000;
  pu.nextPowerupAt = t;
  S.stepPowerup(pu, t);
  eq('到点生成第一个道具', pu.powerups.length, 1);

  t += S.POWERUP_GAP_MS;
  S.stepPowerup(pu, t);
  eq('★ 第一个**还在场上**时，第二个也能生成（不是"吃完才来下一个"）',
    pu.powerups.length, 2);

  t += S.POWERUP_GAP_MS;
  S.stepPowerup(pu, t);
  eq(`继续生成到上限 ${S.POWERUP_MAX} 个`, pu.powerups.length, S.POWERUP_MAX);

  t += S.POWERUP_GAP_MS;
  S.stepPowerup(pu, t);
  eq('★ 到上限就不再生成（不设上限会线性堆满整个场地）',
    pu.powerups.length, S.POWERUP_MAX);

  let minGap = Infinity;
  for (let i = 0; i < pu.powerups.length; i += 1) {
    for (let j = i + 1; j < pu.powerups.length; j += 1) {
      minGap = Math.min(minGap, Math.hypot(
        pu.powerups[i].x - pu.powerups[j].x, pu.powerups[i].y - pu.powerups[j].y));
    }
  }
  check('★ 同时存在的道具互相错开（叠在一起会看成"一个道具给了两份效果"）',
    minGap >= 2 * S.POWERUP_R + 20, `最近的两个相距 ${minGap.toFixed(1)}px`);
  check('道具都落在场地中段（不贴边，否则等于白送）',
    pu.powerups.every((u) => u.x >= pu.W * 0.26 - 1 && u.x <= pu.W * 0.74 + 1
      && u.y >= 69 && u.y <= pu.H - 69),
    JSON.stringify(pu.powerups.map((u) => [Math.round(u.x), Math.round(u.y)])));

  // 到期：必须一次清掉**所有**到寿的，不是只清第一个
  pu.nextPowerupAt = t + 1e6;         // 别让它们刚过期就又补上
  S.stepPowerup(pu, t + S.POWERUP_LIFE_MS + 10);
  eq('★ 到寿的道具一次**全部**清掉（不是只清第一个）', pu.powerups.length, 0);

  // 多球时每个球都能吃到道具（不能只看 0 号球）
  const mp = S.createRoom('PUMUL1');
  mp.phase = 'playing';
  setBall(mp, 300, 200, 0, 0);
  const m2 = S.makeBall(500, 300);
  mp.balls.push(m2);
  mp.powerups = [
    { x: 300, y: 200, type: 0, bornAt: t },
    { x: 500, y: 300, type: 4, bornAt: t },
  ];
  mp.nextPowerupAt = t + 1e6;
  S.stepPowerup(mp, t);
  eq('★ 两个球各自吃掉了自己碰到的道具（不能只看 0 号球）', mp.powerups.length, 0);
  check('★ 两个效果都生效了（一个加长、一个护盾，互不覆盖）',
    mp.paddleMul[0] > 1 && mp.shield[0] === 1,
    `mul=${mp.paddleMul[0]} shield=${mp.shield[0]}`);
}



// ---------- 16. 隐形球（第 9 种道具） ----------
console.log('\n16) 隐形球（吃到的人看得见，对面看不见）');
{
  // ★ 用固定的"现在"，不用 Date.now()：下面要按毫秒精确采样整条渐变曲线，
  //   用真实时钟的话采样点会随执行速度漂移，断言就变成时灵时不灵。
  const t0 = 5_000_000;
  const iv = S.createRoom('INVIS1');
  iv.phase = 'playing';
  iv.serverTime = t0;

  check('★ 隐形时长比其它效果短（用户要求"比较短"：其它是 8 秒）',
    S.INVIS_MS < S.POWERUP_MOD_MS,
    `隐形 ${S.INVIS_MS}ms vs 其它 ${S.POWERUP_MOD_MS}ms`);
  check('两端各留了一段渐变（否则球是"啪"地消失、"啪"地又冒出来）',
    S.INVIS_FADE_MS > 0 && 2 * S.INVIS_FADE_MS < S.INVIS_MS,
    `FADE=${S.INVIS_FADE_MS}ms，总长=${S.INVIS_MS}ms`);

  check('没人吃到时两边都看得见球',
    S.invisAlpha(iv, 0, t0) === 1 && S.invisAlpha(iv, 1, t0) === 1);

  S.applyPowerup(iv, 0, 8, t0);   // 0 队（左）吃到 → 1 队（右）被隐形
  eq('★ 吃到的一方**自己照样看得见**（0 队全程 alpha=1）',
    S.invisAlpha(iv, 0, t0 + S.INVIS_MS / 2), 1);
  check('★ 对面被隐形了（1 队身上挂了到期时间）', iv.invisUntil[1] > t0,
    `invisUntil=${JSON.stringify(iv.invisUntil)}`);
  eq('★ 隐形的是**对面**，不是自己', iv.invisUntil[0], 0);

  // ---- 曲线形状：1 → 0 → 1，中间必须真的到 0 ----
  // 这一条是"渐变"这件事的全部内容。★ 采样必须够密：
  //   每 50ms 采一次的话，"淡入方向写反"（remain/FADE 而不是 1-remain/FADE）
  //   在 0/100/400 这三个点上看过去竟然像是单调的，会漏掉。
  //   用 10ms 步长 + 单调性断言才能把它钉死。
  const samples = [];
  for (let d = 0; d <= S.INVIS_MS; d += 10) samples.push(S.invisAlpha(iv, 1, t0 + d));
  const minA = Math.min(...samples);
  const fadeN = Math.round(S.INVIS_FADE_MS / 10);
  const midN = samples.length - 2 * fadeN;
  let downOk = true;
  let upOk = true;
  let zeroRun = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (i <= fadeN && samples[i] > samples[i - 1] + 1e-9) downOk = false;      // 淡出只能降
    if (i >= samples.length - fadeN && samples[i] < samples[i - 1] - 1e-9) upOk = false; // 淡入只能升
    if (samples[i] === 0) zeroRun += 1;
  }
  check('★ 开头是**淡出**（透明度一路只降不升）', downOk, samples.slice(0, 6).join(','));
  check('★ 结尾是**淡入**（透明度一路只升不降）', upOk,
    samples.slice(samples.length - 6).join(','));
  eq('★ 中段**完全看不见**（不是"稍微变淡一点"）', minA, 0);
  check('★ 完全看不见的时间占了大头（否则这道道具等于没生效）',
    zeroRun >= midN - 2, `全隐采样 ${zeroRun} / 中段应约 ${midN}`);
  eq('起点看得见', samples[0], 1);
  eq('终点看得见（不复位的话球会一直半透明下去）', samples[samples.length - 1], 1);
  check('淡出淡入是对称的（同一个 FADE，两端各 ~400ms）',
    Math.abs(samples[fadeN - 1] - samples[samples.length - fadeN]) < 0.15,
    `淡出末 ${samples[fadeN - 1]} vs 淡入首 ${samples[samples.length - fadeN]}`);

  // ---- 隐形不改球的物理 ----
  const bx0 = iv.balls[0].x;
  setBall(iv, 400, 250, 300, 0);
  for (let i = 0; i < 10; i += 1) S.stepBalls(iv, 1 / 240);
  check('★ 隐形期间球照常飞（只是看不见，不是被冻住）',
    iv.balls.length === 1 && iv.balls[0].x > 400,
    `x=${iv.balls[0].x.toFixed(1)}（起始 ${bx0}）`);

  // ---- 到期复位 ----
  S.trackMods(iv, t0 + S.INVIS_MS);
  eq('★ 到期后 trackMods 把隐形清掉（不清就永久看不见了）', iv.invisUntil[1], 0);
  eq('到期后两边都恢复看得见',
    S.invisAlpha(iv, 0, t0 + S.INVIS_MS + 1) + S.invisAlpha(iv, 1, t0 + S.INVIS_MS + 1), 2);

  // ---- 重新发球必须结束隐形 ----
  // 隐形是靠"球还在原来那条轨道上"才能预判的；重新发球换了轨道，
  // 被隐形的人就彻底没有任何信息，那不是"难接"而是"白送一分"。
  S.applyPowerup(iv, 1, 8, t0);        // 这次 1 队吃到 → 0 队被隐形
  check('前置：1 队吃到后 0 队被隐形', iv.invisUntil[0] > t0);
  S.resetBall(iv, 1);
  eq('★ 重新发球时隐形被清掉（否则被隐形的人连新球都看不见）', iv.invisUntil[0], 0);

  // ---- AI 也必须被骗到 ----
  // 不这么做的话，这道道具只在"两个真人"时成立，人机局里吃到它等于什么都没发生。
  const bot = S.createRoom('INVSB1', 'solo', 1);   // solo：0 号位是人，1 号位是 AI
  bot.phase = 'playing';
  const t1 = 8_000_000;
  // ★ 瞄准误差是每球随机掷的，会把断言淹没。扣掉它，只看**它算出来的落点**本身。
  const pred = () => bot.players[1].targetY - bot.players[1].aimErr;
  const think = (t) => {
    bot.serverTime = t;
    bot.players[1].thinkAt = 0;      // 绕开思考间隔，让这一下一定重新算
    S.stepPaddles(bot, 0.001);
  };

  setBall(bot, 400, 100, 300, 0);    // 球在上路朝 AI 飞
  think(t1);                          // 未隐形：看它一眼（这一眼会存进它的"记忆"）
  const predSeen = pred();
  check('对照组：没被隐形时 AI 瞄的是球的**真实**位置',
    Math.abs(predSeen - 100) < 2, `落点=${predSeen.toFixed(1)}`);

  S.applyPowerup(bot, 0, 8, t1 + 20);   // 0 队（人）吃到 → 1 队（AI）被隐形
  check('前置：AI 所在的 1 队被隐形', bot.invisUntil[1] > t1 + 20);

  // 真值挪到完全不同的位置（真值落点与旧落点差 300px 以上）。
  // ★ 两个位置必须挑得**足够远**：随手写的那组（400→300x/60y）算出来的落点
  //   一个是 348、一个是 349，差 1px —— 断言就成了摆设，红绿全看运气。
  setBall(bot, 400, 420, 300, 0);
  think(t1 + 60);
  const predBlind = pred();
  check('★ 被隐形时它**没有**跟着真值走（仍按上次看见的位置推）',
    Math.abs(predBlind - predSeen) < 2,
    `被隐形后仍推 ${predBlind.toFixed(1)}（上次看见时推出的是 ${predSeen.toFixed(1)}）`);

  // 对照：把隐形临时解除，同一颗球它立刻算出完全不同的落点。
  // 这一条是"量具灵敏"的证明 —— 没有它，上面那条可能只是因为预测没变化而侥幸通过。
  const saveInvis = bot.invisUntil[1];
  bot.invisUntil[1] = 0;
  think(t1 + 61);
  const predTrue = pred();
  bot.invisUntil[1] = saveInvis;
  check('★ 对照：一解除隐形，它立刻算出完全不同的落点（量具是灵敏的）',
    Math.abs(predTrue - predBlind) > 200,
    `隐形中 ${predBlind.toFixed(1)} → 解除后 ${predTrue.toFixed(1)}`);

  // 隐形期间新分裂出来的球，它根本不知道存在
  const nb = S.makeBall(300, 80);
  nb.vx = 300; nb.vy = 0;
  bot.balls.push(nb);
  bot.serverTime = t1 + 160;
  bot.players[1].thinkAt = 0;
  S.stepPaddles(bot, 0.001);
  check('★ 隐形期间新出现的球不在它"脑子里"（它不会去追一个不知道存在的球）',
    !(bot.players[1].seen || []).some((s) => s.id === nb.id),
    `它记得的球 id: ${(bot.players[1].seen || []).map((s) => s.id).join(',')}`);
  // 对照组：隐形一结束，它就重新看得见场上所有球
  bot.invisUntil[1] = 0;
  bot.serverTime = t1 + 200;
  bot.players[1].thinkAt = 0;
  S.stepPaddles(bot, 0.001);
  check('对照组：隐形一结束，它马上又看得见全部球（不是永久瞎掉）',
    (bot.players[1].seen || []).length === bot.balls.length,
    `看到 ${(bot.players[1].seen || []).length} / 场上 ${bot.balls.length}`);

  // ---- 多人/多球场景：隐形按**队**生效，不是按拍子 ----
  const cp = S.createRoom('INVCP1', 'coop', 1);
  cp.phase = 'playing';
  cp.serverTime = t0;
  S.applyPowerup(cp, 0, 8, t0 + 1);   // coop 左队吃到 → 右队（AI）被隐形
  check('★ coop 里吃到一次，整队生效（不用逐个拍子刷）',
    cp.invisUntil[1] > t0 && cp.invisUntil[0] === 0,
    JSON.stringify(cp.invisUntil));
  eq('coop 左队的两个拍子位都看得见（按队查一次即可）', S.invisAlpha(cp, 0, t0 + 10), 1);
}



// ---------- 17. 防"竖直卡死" + 击球加速节奏 ----------
// ★ 这一节存在的理由：球只在上下墙之间竖弹时 x 永远不变 ⇒ 永远碰不到拍子
//   ⇒ 这一回合**永远不会结束**（比分不动、也不重新发球）。这是死锁，不是手感问题。
//   两条来路都在 unstickBall 的注释里（等质量碰撞的 dx 项 / 分裂球继承横向占比）。
{
  const DT = 1 / 240;

  // ---- (a) 判据本身就是"横向占比"，所以先把阈值两侧各打一发 ----
  const mk = (vx, speed) => {
    const r = S.createRoom('STK');
    r.paddles = [-1000, 1000];               // 拍子让开，本节只考察球本身
    const vy = Math.sqrt(Math.max(0, speed * speed - vx * vx));
    setBall(r, 400, 250, vx, vy);
    return r;
  };
  const rBelow = mk(0.18 * 430 * 0.99, 430);    // 占比 0.1782，低于阈值
  const rAbove = mk(0.18 * 430 * 1.01, 430);    // 占比 0.1818，高于阈值
  eq('★ 横向占比略低于阈值 → 重瞄（判据真的是比例）', S.unstickBalls(rBelow), 1);
  eq('★ 横向占比略高于阈值 → 一个字节都不动', S.unstickBalls(rAbove), 0);
  check('对照：上面那个没被动的球，速度逐字段没变',
    Math.abs(Math.hypot(B0(rAbove).vx, B0(rAbove).vy) - 430) < 1e-9 &&
    B0(rAbove).vx > 0, `vx=${B0(rAbove).vx}`);

  // ---- (b) 用户点名的那个状态：横向速度**正好是 0** ----
  const r0 = S.createRoom('STK0');
  setBall(r0, 400, 250, 0, 430);
  eq('前置：这是一个横向速度正好为 0 的球', B0(r0).vx, 0);
  eq('★ 横向速度为 0 → 被重瞄', S.unstickBalls(r0), 1);
  check('★ 重瞄后横向速度不再是 0', Math.abs(B0(r0).vx) > 1e-9, `${B0(r0).vx}`);
  check('★ 重瞄只换方向、**不改变速率**（速率是反隧穿论证的前提）',
    Math.abs(Math.hypot(B0(r0).vx, B0(r0).vy) - 430) < 1e-9,
    `${Math.hypot(B0(r0).vx, B0(r0).vy)}`);
  check('★ 重瞄角落在 30°~60°（横向显著推进，又不是一下变成纯水平）',
    Math.abs(B0(r0).vx) / 430 >= Math.cos(S.UNSTICK_ANG_MAX) - 1e-9 &&
    Math.abs(B0(r0).vx) / 430 <= Math.cos(S.UNSTICK_ANG_MIN) + 1e-9,
    `|vx|/speed = ${(Math.abs(B0(r0).vx) / 430).toFixed(4)}`);

  // 左 / 右是随机的（不是永远往同一侧）
  let left = 0; let right = 0;
  for (let i = 0; i < 200; i += 1) {
    const rr = S.createRoom('STKR');
    setBall(rr, 400, 250, 0, 430);
    S.unstickBalls(rr);
    if (B0(rr).vx < 0) left += 1; else right += 1;
  }
  check('★ 重瞄是左右随机的（200 次里两侧都出现过）',
    left > 20 && right > 20, `左 ${left} / 右 ${right}`);

  // 上下倾向沿用原来的
  let up = 0;
  for (let i = 0; i < 50; i += 1) {
    const rr = S.createRoom('STKU');
    setBall(rr, 400, 250, 0, -430);
    S.unstickBalls(rr);
    if (B0(rr).vy < 0) up += 1;
  }
  eq('★ 上扬的球重瞄后仍然上扬（只改左右，不改上下倾向）', up, 50);

  // ---- (c) 速率≈0 的兜底：球不能"重瞄完还是飞不出去" ----
  const rz = S.createRoom('STKZ');
  setBall(rz, 400, 250, 0, 0);
  eq('★ 完全停住的球也会被救（返回真）', S.unstickBalls(rz), 1);
  check('★ 救回来的球速率不低于兜底值（否则等于没救）',
    Math.hypot(B0(rz).vx, B0(rz).vy) >= S.UNSTICK_MIN_SPEED - 1e-9,
    `${Math.hypot(B0(rz).vx, B0(rz).vy)}`);

  // ---- (d) ★ 先证明死锁是真的：走"老路径"（偏偏不调 unstickBalls） ----
  // 拍子摆到场地外，唯一变量就变成"球能不能自己走到出界线"。
  const dead = S.createRoom('STKDEAD');
  dead.phase = 'playing';
  dead.paddles = [-1000, 1000];
  setBall(dead, 400, 250, 0, 430);
  for (let i = 0; i < 240 * 20; i += 1) {
    const bb = B0(dead);
    S.spinBall(dead, bb, DT);                 // 弧线球（这段没吃道具，等于空转）
    bb.x += bb.vx * DT;
    bb.y += bb.vy * DT;
    S.resolveBallCollisions(dead);
    S.stepOneBall(dead, bb);                  // ← 就是不肯调 unstickBalls
    if (dead.phase !== 'playing') break;
  }
  check('★ 复现死锁：不救的竖直球 20 秒里横向一动没动，这一回合永远结束不了',
    Math.abs(B0(dead).x - 400) < 1e-9 && dead.phase === 'playing',
    `x=${B0(dead).x} phase=${dead.phase}`);

  // ---- (e) 修好之后：同样的球必定走出场地、回合能结束 ----
  const live = S.createRoom('STKLIVE');
  live.phase = 'playing';
  live.paddles = [-1000, 1000];
  setBall(live, 400, 250, 0, 430);
  let steps = 0;
  for (let i = 0; i < 240 * 20; i += 1) {
    S.stepBalls(live, DT);
    steps += 1;
    if (live.phase !== 'playing') break;
  }
  check('★ 走真实推进路径（stepBalls）后，同样的竖直球必定出界、回合能结束',
    live.phase !== 'playing', `20 秒后仍是 phase=${live.phase}`);
  check('★ 而且结束得很快（不是靠 20 秒上限蹭过去的）',
    steps / 240 < 12, `用了 ${(steps / 240).toFixed(2)} 秒`);

  // ---- (f) 压力：三球混战，全程任何一帧都不许出现"竖直空转"的球 ----
  const r5 = S.createRoom('STKMIX');
  r5.phase = 'playing';
  r5.paddles = [-1000, 1000];
  setBall(r5, 300, 250, 0, 430);                       // 纯竖直
  const c2 = S.makeBall(300, 250);                     // 和 0 号球完全重合的纯竖直球
  c2.vx = 0; c2.vy = -430;
  r5.balls.push(c2);
  const c3 = S.makeBall(500, 120);                     // 远处再来一个纯竖直
  c3.vx = 0; c3.vy = 430;
  r5.balls.push(c3);
  let bad = 0; let samples = 0; let worst = 1;
  for (let i = 0; i < 240 * 10; i += 1) {
    S.stepBalls(r5, DT);
    for (const b of r5.balls) {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp < 1) continue;                            // 速率无效的跳过，不计入占比
      const ratio = Math.abs(b.vx) / sp;
      if (ratio < worst) worst = ratio;
      if (ratio < S.MIN_VX_RATIO - 1e-9) bad += 1;
      samples += 1;
    }
    if (r5.phase !== 'playing') break;
  }
  check('★ 多球混战全程没有任何一帧出现"竖直空转"的球',
    bad === 0, `越界 ${bad} 次 / 共 ${samples} 次采样（最小占比 ${worst.toFixed(4)}）`);
  check('★ 上面那条不是空转：采样次数足够多', samples > 200, `${samples} 次`);

  // ---- (g) 击球加速节奏：调高了，且仍在可玩范围内 ----
  check('★ 每次击球的加速系数确实调高了（旧值 1.055）',
    S.SPEEDUP_PER_HIT > 1.055, `SPEEDUP_PER_HIT=${S.SPEEDUP_PER_HIT}`);
  check('★ 也没调过头（球速两三拍就顶到上限会很不好接）',
    S.SPEEDUP_PER_HIT < 1.12, `SPEEDUP_PER_HIT=${S.SPEEDUP_PER_HIT}`);
  const hitsOld = Math.ceil(Math.log(S.BALL_SPEED_MAX / S.BALL_SPEED_START) / Math.log(1.055));
  const hitsNew = Math.ceil(Math.log(S.BALL_SPEED_MAX / S.BALL_SPEED_START) / Math.log(S.SPEEDUP_PER_HIT));
  check('★ 从出速打到封顶所需的击球数变少了（节奏更快）',
    hitsNew < hitsOld, `旧 ${hitsOld} 次 → 新 ${hitsNew} 次`);
  // 真的走一遍击球路径，而不是只比常量
  const acc = S.createRoom('STKACC');
  acc.paddles = [250, 250];
  setBall(acc, 41, 250, -430, 0);                     // 贴着左拍面朝左飞
  S.stepOneBall(acc, B0(acc));
  check('★ 击球后速率 = 击球前 × SPEEDUP_PER_HIT（走真实反弹路径）',
    Math.abs(Math.hypot(B0(acc).vx, B0(acc).vy) - 430 * S.SPEEDUP_PER_HIT) < 1e-9,
    `${Math.hypot(B0(acc).vx, B0(acc).vy)} vs ${430 * S.SPEEDUP_PER_HIT}`);
  check('★ 击球后方向翻向对面（不是原地弹回）', B0(acc).vx > 0, `vx=${B0(acc).vx}`);
}



// ---------- 18. 暂停 ----------
console.log('\n18) 暂停（任意一方按都生效，两个人一起玩时都能按）');
{
  // ---- (a) 前置：一局真的在跑 ----
  const base = Date.now();
  const r = seat2('PAUSE1');
  let now = base;
  S.stepRoom(r, now);
  check('前置：两个真人到齐后第一局开了', r.started === true && r.phase === 'countdown',
    `started=${r.started} phase=${r.phase}`);
  now = base + S.COUNTDOWN_MS + 120;
  S.stepRoom(r, now);
  eq('前置：倒计时走完进入 playing', r.phase, 'playing');
  check('前置：球已经发出来了（横向速度不为 0）', Math.abs(B0(r).vx) > 100,
    `vx=${B0(r).vx}`);

  // ---- (b) 1 号位按下暂停 ----
  eq('★ togglePause 返回"现在暂停中"', S.togglePause(r, 1), true);
  eq('★ 记下了是谁按的（槽位号，用来显示"你按的 / 对手按的"）', r.pausedBy, 1);
  const bPos = [B0(r).x, B0(r).y];
  const p0 = r.paddles[0];
  const p1 = r.paddles[1];
  const score0 = JSON.stringify(r.score);
  const tick0 = r.tick;
  r.players[0].dir = -1;                    // 0 号位一直按着"上"，看冻结期间会不会动
  for (let k = 1; k <= 10; k += 1) S.stepRoom(r, (now = base + S.COUNTDOWN_MS + 120 + k * 33));
  check('★ 暂停期间球一动不动', B0(r).x === bPos[0] && B0(r).y === bPos[1],
    `${bPos} -> ${[B0(r).x, B0(r).y]}`);
  check('★ 暂停期间拍子也不动（方向键按着也没用）',
    r.paddles[0] === p0 && r.paddles[1] === p1, `${p0} -> ${r.paddles[0]}`);
  check('★ 暂停期间比分不变', JSON.stringify(r.score) === score0,
    `${score0} -> ${JSON.stringify(r.score)}`);
  check('★ 暂停期间 phase 仍是 playing（球还在画面上，不是被藏起来）',
    r.phase === 'playing', r.phase);
  check('★ 但 tick 仍在推进（服务器没卡死，客户端延迟/心跳照常）', r.tick > tick0,
    `${tick0} -> ${r.tick}`);
  check('★ room.paused 未被污染（"缺人自动冻结"是另一回事）', r.paused === false);

  // ---- (c) 挂钟后移：暂停不该把道具效果耗光 ----
  S.applyPowerup(r, 0, 5, now);             // 5 = 双倍得分，POWERUP_MOD_MS 秒
  check('前置：双倍得分刚生效（剩余 ≈ POWERUP_MOD_MS）',
    Math.abs((r.doubleUntil[0] - now) - S.POWERUP_MOD_MS) < 5,
    `剩余 ${r.doubleUntil[0] - now}ms`);
  // 隐形球：摆成"已经隐了一段时间、正处在完全看不见的那一段"
  //   elapsed = INVIS_MS - remain = 1000 > FADE，remain = 2000 > FADE ⇒ alpha 恰好是 0。
  //   不这么做就是拿 alpha 还在渐变里的时刻做断言，量不出东西。
  r.invisUntil[0] = now + 2000;
  eq('前置：0 队此刻完全看不见球（中间那一段）', S.invisAlpha(r, 0, now), 0);
  for (let k = 1; k <= 300; k += 1) S.stepRoom(r, (now = base + S.COUNTDOWN_MS + 120 + 10 * 33 + k * 33));
  check('★ 暂停约 10 秒后（超过 8 秒的效果时长），双倍得分仍在生效',
    r.doubleUntil[0] - now > 0, `剩余 ${r.doubleUntil[0] - now}ms`);
  check('★ 而且剩余时长几乎没变（是整体后移，不是"重新计时"）',
    Math.abs((r.doubleUntil[0] - now) - S.POWERUP_MOD_MS) < 200,
    `剩余 ${r.doubleUntil[0] - now}ms vs ${S.POWERUP_MOD_MS}ms`);
  // ★ 这条是玩家真能看见的那个症状：暂停期间挂钟一路走，被隐形的人会突然又看见球
  //   （"暂停一下对手就复明了"）。持续后移之后，暂停全程都还是看不见。
  eq('★ 暂停 10 秒期间球始终没"自然复明"（隐形到期时间也一起冻住了）',
    S.invisAlpha(r, 0, now), 0);

  // ---- (d) 换个人按一下就能恢复 ----
  r.players[0].dir = 0;
  eq('★ 另一个人按一下也能恢复（不是只有按暂停的人能恢复）',
    S.togglePause(r, 0), false);
  eq('★ 恢复后"是谁按的"归零', r.pausedBy, -1);
  const ballResume = [B0(r).x, B0(r).y];
  for (let k = 1; k <= 6; k += 1) S.stepRoom(r, (now = now + 33));
  check('★ 恢复后球重新开始动', B0(r).x !== ballResume[0] || B0(r).y !== ballResume[1],
    `${ballResume} -> ${[B0(r).x, B0(r).y]}`);

  // ---- (e) 倒计时阶段的暂停不能把倒计时拉长 ----
  // ★ 这是最容易写错的一条：倒计时的截止时刻在冻结期间每 tick 都被重设成"当前+1.8s"，
  //   若解冻时把它跟别的到期时间一起后移，暂停 4 秒就会变成"恢复后再数 5.8 秒"。
  const rc = seat2('PAUSE2');
  const c0 = Date.now();
  S.stepRoom(rc, c0);
  eq('前置：房间处于倒计时', rc.phase, 'countdown');
  S.togglePause(rc, 0);
  let cn = c0;
  for (let k = 1; k <= 120; k += 1) S.stepRoom(rc, (cn = c0 + k * 33));   // 约 4 秒
  eq('前置：暂停期间仍停在倒计时', rc.phase, 'countdown');
  S.togglePause(rc, 0);
  S.stepRoom(rc, (cn += 33));
  check('★ 倒计时的暂停不会把倒计时加长（恢复后剩余 ≈ 1.8s，不是 1.8s + 暂停时长）',
    rc.phase === 'countdown' && rc.phaseEndsAt - cn <= S.COUNTDOWN_MS + 60,
    `剩余 ${rc.phaseEndsAt - cn}ms（暂停了 ${cn - c0}ms）`);

  // ---- (f) 'over' 阶段的暂停则必须把停留时间一起冻住 ----
  // 与 (e) 正好相反：这个截止时刻冻结期间没人会去重设它，不后移的话
  // 一恢复就立刻开下一局，玩家根本没机会看清"本局结束"。
  const ro = seat2('PAUSE3');
  S.stepRoom(ro, Date.now());
  const o0 = Date.now();
  ro.phase = 'over'; ro.winner = 0; ro.phaseEndsAt = o0 + S.OVER_HOLD_MS;
  S.togglePause(ro, 1);
  let on2 = o0;
  for (let k = 1; k <= 300; k += 1) S.stepRoom(ro, (on2 = o0 + k * 33));   // 约 10 秒
  eq('前置：暂停期间仍停在 over', ro.phase, 'over');
  S.togglePause(ro, 1);
  S.stepRoom(ro, (on2 += 33));
  check('★ 本局结束后的暂停不会在恢复的瞬间就开下一局（那 4 秒停留一起冻住了）',
    ro.phase === 'over' && ro.phaseEndsAt > on2,
    `phase=${ro.phase} 剩余 ${ro.phaseEndsAt - on2}ms`);

  // ---- (g) 第一局还没开始时按下的暂停不能卡住开局 ----
  // 有人先建房、闲着按了一下暂停，第二个人进来时不能永远停在"已暂停"。
  const f1 = S.createRoom('PAUSE4');
  f1.players[0] = { ws: { readyState: 1 }, token: 'a', dir: 0, since: Date.now() };
  S.togglePause(f1, 0);
  eq('前置：这时确实记着"暂停中"', f1.userPaused, true);
  f1.players[1] = { ws: { readyState: 1 }, token: 'b', dir: 0, since: Date.now() };
  S.stepRoom(f1, Date.now());
  check('★ 第一局照常开（开局前的暂停不作数）',
    f1.started === true && f1.phase === 'countdown',
    `started=${f1.started} phase=${f1.phase}`);

  // ---- (h) shiftDeadlines 本身：逐个字段都要后移，且 0 必须保持 0 ----
  const sh = S.createRoom('SHIFT');
  const T = 5000000;
  sh.powerups.push({ x: 1, y: 1, type: 0, bornAt: T });
  sh.nextPowerupAt = T + 3000;
  sh.growUntil[0] = T + 8000;
  sh.shrinkUntil[0] = 0;                    // ★ 没生效的效果，后移之后必须还是 0
  sh.shrinkUntil[1] = T + 500;
  sh.freezeUntil[0] = T + 1600;
  sh.doubleUntil[1] = T + 8000;
  sh.invisUntil[0] = T + 3000;
  sh.ballUntil = T + 8000;
  sh.curveUntil = T + 6000;
  S.shiftDeadlines(sh, 60000);
  const shifted = [
    ['nextPowerupAt', sh.nextPowerupAt - (T + 3000)],
    ['powerup.bornAt', sh.powerups[0].bornAt - T],
    ['growUntil[0]', sh.growUntil[0] - (T + 8000)],
    ['shrinkUntil[1]', sh.shrinkUntil[1] - (T + 500)],
    ['freezeUntil[0]', sh.freezeUntil[0] - (T + 1600)],
    ['doubleUntil[1]', sh.doubleUntil[1] - (T + 8000)],
    ['invisUntil[0]', sh.invisUntil[0] - (T + 3000)],
    ['ballUntil', sh.ballUntil - (T + 8000)],
    ['curveUntil', sh.curveUntil - (T + 6000)],
  ];
  check('★ 每个到期时刻都正好后移了 60000ms',
    shifted.every((x) => x[1] === 60000),
    shifted.filter((x) => x[1] !== 60000).map((x) => `${x[0]}+${x[1]}`).join(', ') || '全部正确');
  eq('★ 没生效的效果（时间戳为 0）后移之后仍然是 0', sh.shrinkUntil[0], 0);
  S.shiftDeadlines(sh, 0);
  eq('后移 0 毫秒是个空操作（别把 0 变成 NaN）', sh.growUntil[0], T + 8000 + 60000);
}

// ---------- 19. 拍子皮肤（= 技能） ----------
console.log('\n19) 拍子皮肤与三个技能（风 / 幻影 / 超高速）');
{
  const T = 1000000;   // 固定的"现在"。用 Date.now() 的话边界断言会变成偶发

  /** 造一个"人都在场、正在打"的房间（mode 传 'coop' 时第三个槽仍然是 AI） */
  function live(mode) {
    const r = S.createRoom(mode === 'coop' ? 'COOP01' : 'LIVE01', mode || 'duel');
    const fake = (t) => ({ ws: { readyState: 1 }, token: t, dir: 0, since: T });
    for (let i = 0; i < r.N; i += 1) if (!S.isBot(r.players[i])) r.players[i] = fake('t' + i);
    r.started = true;
    r.paused = false;
    r.userPaused = false;
    r.phase = 'playing';
    r.serverTime = T;
    return r;
  }
  /** 把 0 号球摆成"从球场正中间水平飞" */
  function fly(r, vx, vy) {
    const b = r.balls[0];
    b.x = r.W / 2; b.y = r.H / 2; b.vx = vx; b.vy = vy === undefined ? 0 : vy;
    return b;
  }
  const speedOf = (b) => Math.hypot(b.vx, b.vy);
  const stepFor = (r, secs) => {
    const n = Math.round(secs * 240);          // 服务端内部是按 1/240 的子步推进的
    for (let i = 0; i < n; i += 1) S.stepBalls(r, 1 / 240);
  };

  // ---- 19.1 风向 = 自己拍子中心 → 球场中心 ----
  {
    const r = live();
    r.skins[0] = S.SKIN_WIND;
    r.skins[1] = S.SKIN_WIND;

    r.paddles[0] = r.H / 2;
    r.skillReadyAt[0] = 0; r.winds = [];
    check('风：左侧的拍子能放出来', S.castSkill(r, 0, T) === true);
    let w = r.winds[0];
    check('★ 拍子在左侧正中央 → 风笔直向右',
      Math.abs(w.dx - 1) < 0.02 && Math.abs(w.dy) < 0.02,
      `dx=${w.dx.toFixed(3)} dy=${w.dy.toFixed(3)}`);
    check('风向是单位向量（不然风力会随距离越远越大）',
      Math.abs(Math.hypot(w.dx, w.dy) - 1) < 1e-6);

    r.paddles[0] = 60;
    r.skillReadyAt[0] = 0; r.winds = [];
    S.castSkill(r, 0, T);
    w = r.winds[0];
    check('★ 拍子在左上 → 风向右下',
      w.dx > 0.2 && w.dy > 0.2, `dx=${w.dx.toFixed(3)} dy=${w.dy.toFixed(3)}`);

    r.paddles[0] = r.H - 60;
    r.skillReadyAt[0] = 0; r.winds = [];
    S.castSkill(r, 0, T);
    w = r.winds[0];
    check('★ 拍子在左下 → 风向右上',
      w.dx > 0.2 && w.dy < -0.2, `dx=${w.dx.toFixed(3)} dy=${w.dy.toFixed(3)}`);

    r.paddles[1] = r.H / 2;
    r.skillReadyAt[1] = 0; r.winds = [];
    check('风：右侧的拍子也能放（两个人都能放）', S.castSkill(r, 1, T) === true);
    w = r.winds[0];
    check('★ 拍子在右侧正中央 → 风笔直向左',
      Math.abs(w.dx + 1) < 0.02 && Math.abs(w.dy) < 0.02,
      `dx=${w.dx.toFixed(3)} dy=${w.dy.toFixed(3)}`);
  }

  // ---- 19.2 风对球的作用：一个式子，四种表现 ----
  {
    const windRight = (paddleY) => {
      const r = live();
      r.skins[0] = S.SKIN_WIND;
      r.paddles[0] = paddleY;
      r.skillReadyAt[0] = 0; r.winds = [];
      S.castSkill(r, 0, T);
      return r;
    };

    let r = windRight(live().H / 2);        // 风笔直向右
    let b = fly(r, 400, 0);
    stepFor(r, 0.25);
    check('★ 顺风：球被推快（该加速就加速）',
      b.vx > 400 + S.WIND_ACC * 0.25 - 25,
      `vx 400 -> ${b.vx.toFixed(0)}（风 0.25 秒该给约 ${(S.WIND_ACC * 0.25).toFixed(0)}）`);

    r = windRight(live().H / 2);
    b = fly(r, -400, 0);
    stepFor(r, 0.25);
    check('★ 逆风：球被拽慢（该减速就减速）', Math.abs(b.vx) < 400 - 40,
      `|vx| 400 -> ${Math.abs(b.vx).toFixed(0)}`);

    // ★ "偏移"是需求点名的四种表现之一，必须有一条能稳定变绿的断言把它钉住。
    //   标定依据（手算 + 实测一致）：拍子在 y=60、球在正中 ⇒ 风方向 dy ≈ 0.460
    //   （(250-60)/|(400-33, 190)| = 190/413.3），0.25 秒后 vy = 300 × 0.460 × 0.25 ≈ 34.5。
    //   所以门槛取 25：明显高于 0（抓得到"风根本没施侧向力"），又不卡小数位。
    //   ★ 曾写成 `> 40` 稳定报红 —— 那是阈值定高了，不是实现错了。别再把门槛往上调。
    r = windRight(60);                      // 风向右下
    b = fly(r, 400, 0);
    const wdir = r.winds[0];                // 步进前先取下来（步进里风可能被清）
    stepFor(r, 0.25);
    check('★ 横穿：球被推偏（该偏移就偏移）', b.vy > 25, `vy 0 -> ${b.vy.toFixed(1)}`);
    // ★ 这一条比上面那条强得多：它盯的是"偏移量等于解析值"，
    //   而不是"偏移量大于某个我拍脑袋定的数"。风力的方向/大小任一处写错都会红。
    check('★ 而且偏移量 = WIND_ACC × 风向垂直分量 × 时间（不是碰巧歪了一点）',
      Math.abs(b.vy - S.WIND_ACC * wdir.dy * 0.25) < 1,
      `${b.vy.toFixed(2)} vs 解析值 ${(S.WIND_ACC * wdir.dy * 0.25).toFixed(2)}`);

    r = windRight(live().H / 2);
    b = fly(r, S.BALL_SPEED_MAX, 0);
    stepFor(r, 0.3);
    check('★ 风不会把球推过 BALL_SPEED_MAX（"子步位移远小于判定窗口"这个反隧穿前提靠的就是它）',
      speedOf(b) <= S.BALL_SPEED_MAX + 0.5,
      `${speedOf(b).toFixed(1)} vs 上限 ${S.BALL_SPEED_MAX}`);

    // ★ 到期必须清掉。不清的话 stepBalls 会**永久**继续施力：每放一次风就多一股合力，
    //   几分钟后球会被一股看不出原因的怪力甩出球场。（这是写测试时抓出来的真 bug）
    r = windRight(live().H / 2);
    b = fly(r, 400, 0);
    r.winds[0].until = T;                   // 已经到点
    r.serverTime = T + 1;
    S.trackMods(r, r.serverTime);
    eq('★ 风到点后从场上被清掉（不然会永久累积施力）', r.winds.length, 0);
    const v0 = b.vx;
    stepFor(r, 0.2);
    check('★ 清掉之后确实不再给球施力了', Math.abs(b.vx - v0) < 1e-6,
      `${v0.toFixed(2)} -> ${b.vx.toFixed(2)}`);
  }

  // ---- 19.3 冷却与门禁 ----
  {
    const r = live();
    r.skins[0] = S.SKIN_WIND;
    r.paddles[0] = r.H / 2;
    r.skillReadyAt[0] = 0;
    check('第一次放技能成功', S.castSkill(r, 0, T) === true);
    eq('★ 冷却长度 = 这个皮肤对应的时长', r.skillReadyAt[0] - T, S.SKILL_CD_MS[S.SKIN_WIND]);
    r.winds = [];                            // 清空，好确认"没放出来"≠"放了但看不见"
    check('★ 冷却期内再按放不出来', S.castSkill(r, 0, T + 1000) === false);
    eq('★ 而且真的没有多出一股风', r.winds.length, 0);
    check('冷却走完之后又能放',
      S.castSkill(r, 0, T + S.SKILL_CD_MS[S.SKIN_WIND]) === true);

    const g = live();
    g.skins[0] = S.SKIN_GRAY;
    check('★ 灰板子（没有技能）按了什么都不发生', S.castSkill(g, 0, T) === false);
    eq('灰板子也不会被写进冷却', g.skillReadyAt[0], 0);

    // 放不出去的时机。任何一条漏掉都会让"技能在暂停里还能放""倒计时就能攒 CD"
    const cases = [
      ['第一局还没开始', (x) => { x.started = false; }],
      ['缺人自动冻结', (x) => { x.paused = true; }],
      ['玩家主动暂停', (x) => { x.userPaused = true; }],
      ['倒计时阶段', (x) => { x.phase = 'countdown'; }],
      ['本局已经结束', (x) => { x.phase = 'over'; }],
    ];
    for (const [label, mut] of cases) {
      const q = live();
      q.skins[0] = S.SKIN_WIND;
      mut(q);
      const got = S.castSkill(q, 0, T);
      check(`★ ${label}时放不出技能`, got === false && q.winds.length === 0 && q.skillReadyAt[0] === 0,
        `返回 ${got}，风 ${q.winds.length} 股，冷却 ${q.skillReadyAt[0]}`);
    }
  }

  // ---- 19.4 幻影球 ----
  {
    const r = live();
    r.skins[0] = S.SKIN_PHANTOM;
    const real = fly(r, 500, 0);
    check('幻影：放得出来', S.castSkill(r, 0, T) === true);
    eq('★ 场上多出一个球', r.balls.length, 2);
    const ph = r.balls[1];
    eq('★ 幻影球标着"属于哪一队"（0 队）', ph.phantom, 0);
    check('★ 真球与幻影球**等速**（真分裂球是"新球半速"，照抄的话对手看谁快就知道该接谁）',
      Math.abs(speedOf(real) - speedOf(ph)) < 0.5,
      `真 ${speedOf(real).toFixed(1)} / 幻 ${speedOf(ph).toFixed(1)}`);
    const angReal = Math.atan2(real.vy, real.vx);
    const angFake = Math.atan2(ph.vy, ph.vx);
    check('★ 两个球对称地偏开（夹角 = 2 × PHANTOM_ANGLE）',
      Math.abs(Math.abs(angReal - angFake) - 2 * S.PHANTOM_ANGLE) < 1e-6,
      `${(Math.abs(angReal - angFake) * 180 / Math.PI).toFixed(1)}°`);
    check('★ 真球也真的被改变了一点方向（需求："原球也会改变一点方向，这个也一样"）',
      Math.abs(angReal) > 0.05, `真球偏了 ${(angReal * 180 / Math.PI).toFixed(1)}°`);

    // 互不碰撞：摆成"重叠且正在靠近"，普通球会交换速度分量
    const a = r.balls[0];
    const c = r.balls[1];
    a.x = 400; a.y = 250; a.vx = 400; a.vy = 0;
    c.x = 402; c.y = 250; c.vx = -400; c.vy = 0;
    const va = a.vx;
    const vc = c.vx;
    S.resolveBallCollisions(r);
    check('★ 幻影球和真球互不碰撞（撞在一起就穿过去）',
      a.vx === va && c.vx === vc, `真 vx=${a.vx} 幻 vx=${c.vx}`);

    const before = r.score.slice();
    c.x = -30; c.y = 250; c.vx = -400; c.vy = 0;
    S.stepOneBall(r, c);
    check('★ 幻影球出界既不加分也不失分（"不会因为这个球实际得分和失分"）',
      r.score[0] === before[0] && r.score[1] === before[1], `${before} -> ${r.score}`);
    check('幻影球出界后从场上消失', r.balls.indexOf(c) < 0);
    check('★ 幻影球出界也不消耗护盾', r.shield[0] === 0 && r.shield[1] === 0);

    // ★★ 反方向也必须钉住：幻影球出界时，只要**还有真球在飞**，就绝不能重发球。
    //   重发会把整个 balls 数组换掉 —— 那颗正在飞的真球会凭空消失、球回到中场，
    //   玩家看到的是"球莫名其妙被重置了"，而且完全找不到原因。
    //   （写反证的 2026-10-10 发现：把 removeBall 里那句护栏删掉时，
    //     19.4 原有的断言**全绿** —— 也就是说这条护栏当时没有任何断言保护。补上。）
    const r5 = live();
    r5.skins[0] = S.SKIN_PHANTOM;
    fly(r5, 500, 0);
    S.castSkill(r5, 0, T);
    const real5 = r5.balls[0];
    real5.x = 300; real5.vx = 400; real5.vy = 0;
    const ph5 = r5.balls[1];
    ph5.x = -30; ph5.vx = -400; ph5.vy = 0;
    S.stepOneBall(r5, ph5);
    eq('★ 幻影球出界时，只要还有真球在飞就绝不重发（重发会连带把真球换掉）', r5.phase, 'playing');
    check('★ 那颗真球被原地留着（没被换掉、速度也没变）',
      r5.balls.indexOf(real5) >= 0 && real5.vx === 400 && real5.x === 300,
      `球数 ${r5.balls.length} vx=${real5.vx} x=${real5.x}`);

    // 到寿消失
    const r2 = live();
    r2.skins[0] = S.SKIN_PHANTOM;
    fly(r2, 500, 0);
    S.castSkill(r2, 0, T);
    eq('放下时场上是两个球', r2.balls.length, 2);
    r2.serverTime = T + S.PHANTOM_MS + 20;
    S.stepBalls(r2, 1 / 240);
    check('★ 到点之后幻影球自己消失', r2.balls.length === 1 && !r2.balls.some(S.isPhantom),
      `球数 ${r2.balls.length}`);

    // ★★ 这条最关键：真球出界算完分之后，如果幻影球还在场上，
    //    "场上还有球"这个判据会把重发球拦住 —— 而幻影球出界**不会**触发 afterGoal，
    //    于是没有任何一条路径会去重发，这一回合永远结束不了。
    const r3 = live();
    r3.skins[0] = S.SKIN_PHANTOM;
    fly(r3, 500, 0);
    S.castSkill(r3, 0, T);
    r3.balls[0].x = -30; r3.balls[0].vx = -400;
    r3.balls[1].x = 300; r3.balls[1].vx = 400;
    S.stepOneBall(r3, r3.balls[0]);
    eq('★ 真球出界照常算分', r3.score[1], 1);
    eq('★ 真球出界 + 幻影还在场 ⇒ 必须立刻重发（否则整局卡死）', r3.phase, 'countdown');
    eq('★ 重发时幻影球一起被清掉', r3.balls.filter(S.isPhantom).length, 0);

    // 幻影不占用分裂球的名额
    const r4 = live();
    r4.skins[0] = S.SKIN_PHANTOM;
    fly(r4, 500, 0);
    S.castSkill(r4, 0, T);
    check('★ 幻影球不占分裂球的名额（占了的话吃分裂球会"没反应"）',
      S.splitBall(r4) === true, `球数 ${r4.balls.length}`);

    // ★ coop：幻影标的是**队**不是**槽位**。写成槽位的话施放方会看见自己的假球。
    const rc = live('coop');
    rc.skins[1] = S.SKIN_PHANTOM;           // 槽位 1 与槽位 0 同属 0 队
    fly(rc, 500, 0);
    S.castSkill(rc, 1, T);
    eq('★ coop 里幻影标的是**队伍**（0）而不是**槽位**（1）', rc.balls[1].phantom, 0);
  }

  // ---- 19.5 超高速 ----
  {
    const r = live();
    r.skins[1] = S.SKIN_BOOST;
    check('超高速：放得出来', S.castSkill(r, 1, T) === true);
    eq('★ 放完是"蓄力"，不是立刻提速', r.boostArmed[1], true);
    eq('★ 没人碰到球时球速不变', speedOf(fly(r, 500, 0)), 500);

    r.paddles[1] = 250;
    const b = r.balls[0];
    b.x = 755; b.y = 250; b.vx = 500; b.vy = 0;
    S.stepBalls(r, 1 / 240);
    check('★ 自己击球之后出速 = BOOST_SPEED',
      Math.abs(speedOf(b) - S.BOOST_SPEED) < 1, `${speedOf(b).toFixed(0)} vs ${S.BOOST_SPEED}`);
    check('★ 而且明显高于常规上限（这才叫"超高速"）',
      S.BOOST_SPEED > S.BALL_SPEED_MAX * 1.3, `${S.BOOST_SPEED} vs ${S.BALL_SPEED_MAX}`);
    eq('★ 蓄力用完就清掉（只对这一板有效）', r.boostArmed[1], false);

    const b2 = r.balls[0];
    b2.x = 755; b2.y = 250; b2.vx = 500; b2.vy = 0;
    S.stepBalls(r, 1 / 240);
    check('★ 接下来那一板回到常规速度', speedOf(b2) <= S.BALL_SPEED_MAX + 0.5,
      `${speedOf(b2).toFixed(0)}`);

    // 别人的拍子不该用掉我的蓄力
    const r2 = live();
    r2.skins[1] = S.SKIN_BOOST;
    S.castSkill(r2, 1, T);
    r2.paddles[0] = 250;
    const c = r2.balls[0];
    c.x = 45; c.y = 250; c.vx = -500; c.vy = 0;
    S.stepBalls(r2, 1 / 240);
    check('★ 对手的拍子击球不会用掉我的蓄力', r2.boostArmed[1] === true);
    check('而且那一板也没有变成超高速', speedOf(c) <= S.BALL_SPEED_MAX + 0.5,
      `${speedOf(c).toFixed(0)}`);

    // 幻影球撞自己拍子也不该吃蓄力
    const r3 = live();
    r3.skins[0] = S.SKIN_BOOST;
    S.castSkill(r3, 0, T);
    r3.paddles[0] = 250;
    r3.balls.push({ id: 9999, x: 45, y: 250, vx: -500, vy: 0, phantom: 0, phantomUntil: T + 5000 });
    S.stepBalls(r3, 1 / 240);
    check('★ 幻影球撞在自己拍子上也不吃掉蓄力（它对自己不可见，吃了就是纯闷亏）',
      r3.boostArmed[0] === true, JSON.stringify(r3.boostArmed));

    // 已经蓄力时再按一次
    const r4 = live();
    r4.skins[1] = S.SKIN_BOOST;
    S.castSkill(r4, 1, T);
    const cd1 = r4.skillReadyAt[1];
    check('★ 已经蓄着力时再按一次会被拒掉（否则白烧 10 秒冷却）',
      S.castSkill(r4, 1, T + 20000) === false);
    eq('★ 而且这次无效按键不会把冷却重新计时', r4.skillReadyAt[1], cd1);
  }

  // ---- 19.6 技能按**槽位**算，不按队 ----
  {
    const r = live('coop');                 // 槽位 0 / 1 同属 0 队，槽位 2 是 AI
    r.skins[0] = S.SKIN_WIND;
    r.skins[1] = S.SKIN_GRAY;
    r.paddles[0] = r.H / 2;
    check('coop：槽位 0 装了风就能放', S.castSkill(r, 0, T) === true);
    check('★ coop：同队的槽位 1 没装技能就放不出来（技能是"这块拍子的"，不是"这一队的"）',
      S.castSkill(r, 1, T) === false && r.winds.length === 1, `风 ${r.winds.length} 股`);
    check('★ AI 的槽位（灰板子）同样放不出来', S.castSkill(r, 2, T) === false);
  }

  // ---- 19.7 每局复位 / 暂停时冷却被冻住 ----
  {
    const r = live();
    r.skins[0] = S.SKIN_WIND;
    r.paddles[0] = r.H / 2;
    S.castSkill(r, 0, T);
    const mine = r.skins[0];
    S.clearSkills(r);
    eq('★ 新一局开始冷却清零（不跨局背冷却）', r.skillReadyAt[0], 0);
    eq('★ 在刮的风也一起清掉', r.winds.length, 0);
    eq('★ 但**皮肤保留** —— 那是玩家选的，不是这一局的临时状态', r.skins[0], mine);

    const p = live();
    p.skins[0] = S.SKIN_WIND;
    p.paddles[0] = p.H / 2;
    S.castSkill(p, 0, T);
    const cdBefore = p.skillReadyAt[0];
    const windBefore = p.winds[0].until;
    S.shiftDeadlines(p, 5000);
    eq('★ 暂停 5 秒，冷却也往后推 5 秒（否则"按暂停"等于白送冷却）',
      p.skillReadyAt[0] - cdBefore, 5000);
    eq('★ 在刮的风同样被冻住', p.winds[0].until - windBefore, 5000);

    const p2 = live();
    p2.skillReadyAt[0] = 0;
    S.shiftDeadlines(p2, 5000);
    eq('★ 没在冷却的槽位后移之后仍然是 0（变成 5000 的话一开局技能就是"冷却中"）',
      p2.skillReadyAt[0], 0);

    const p3 = live();
    p3.skins[0] = S.SKIN_PHANTOM;
    fly(p3, 500, 0);
    S.castSkill(p3, 0, T);
    const pu = p3.balls[1].phantomUntil;
    S.shiftDeadlines(p3, 5000);
    eq('★ 幻影球的剩余时间也随暂停一起后移', p3.balls[1].phantomUntil - pu, 5000);
  }

  // ---- 19.8 几个纯函数的边界 ----
  {
    check('灰 = 没有技能', S.skinHasSkill(S.SKIN_GRAY) === false);
    check('青 / 黄 / 红 都算有技能',
      S.skinHasSkill(S.SKIN_WIND) && S.skinHasSkill(S.SKIN_PHANTOM)
      && S.skinHasSkill(S.SKIN_BOOST));
    check('越界 / 乱值的皮肤编号一律当成灰',
      S.normSkin(99) === S.SKIN_GRAY && S.normSkin(-1) === S.SKIN_GRAY
      && S.normSkin('x') === S.SKIN_GRAY && S.normSkin(undefined) === S.SKIN_GRAY
      && S.normSkin(null) === S.SKIN_GRAY);
    check('合法编号原样返回（含字符串数字）',
      S.normSkin(2) === 2 && S.normSkin('3') === 3);
    // ★ isPhantom 的判据必须是 typeof number，不能是真假判断 —— 0 队是合法值
    check('★ isPhantom 认得出"0 队的幻影球"（写成 if (b.phantom) 会把它当真球：'
      + '接着它会参与真球碰撞、出界还送分）',
      S.isPhantom({ phantom: 0 }) === true && S.isPhantom({}) === false
      && S.isPhantom({ phantom: undefined }) === false && S.isPhantom(null) === false);
  }

  // ---- 19.9 下发给真正发出去的那份包：幻影球与 px 都必须按队过滤 ----
  //   这是整套幻影球设计里**唯一没法靠客户端过滤实现**的部分。
  //   幻影球混在 bs 里、由一个字段标出归属，等于把答案直接写进对方的包里 ——
  //   改一改客户端就全露馅；px 同理（对手一看到自己那格是 0、另一格非 0，就确知有幻影）。
  //   所以这里直接调 broadcastState，把**真正送进 socket 的字符串**抓下来验。
  //   验"客户端不显示"是空证据 —— 数据在包里，改几行客户端就到手了。
  {
    // 给每个槽位装一个记录用的假 socket；真正被测的是他们各自收到的那一份 payload
    const wire = (r) => {
      const per = [];
      for (let i = 0; i < r.N; i += 1) {
        const box = [];
        // ★ 连 bot 座位也装上（coop 里 1 队只有 bot 一个座位，而不装就抓不到 1 队的包）
        r.players[i] = { ws: { readyState: 1, send: (s) => box.push(s) }, token: 't' + i, dir: 0, since: T };
        per.push(box);
      }
      return per;
    };
    const putPhantom = (r, team) => {
      const real = r.balls[0];
      real.x = 400; real.y = 250; real.vx = 500; real.vy = 0;
      const ph = S.makeBall(real.x, real.y);
      ph.vx = 460; ph.vy = 150;
      ph.phantom = team;
      ph.phantomUntil = r.serverTime + S.PHANTOM_MS;
      r.balls.push(ph);
      return ph;
    };
    const lastOf = (box) => JSON.parse(box[box.length - 1]);

    // (a) duel：1 队放幻影 → 0 队的包里必须有它，1 队的包里必须没有
    {
      const r = live();
      r.serverTime = T;
      const ph = putPhantom(r, 1);
      const per = wire(r);
      S.broadcastState(r);
      const forA = lastOf(per[0]);          // 槽位 0 → 0 队（对手）
      const forB = lastOf(per[1]);          // 槽位 1 → 1 队（释放方）
      eq('前置：场上真的是两个球（不然下面两条是空断言）', r.balls.length, 2);
      eq('★ 对手（0 队）的 bs 里看得到幻影球 —— 这才叫"被迷惑"', forA.bs.length, 2);
      eq('★ 释放方（1 队）的 bs 里看不到幻影球', forB.bs.length, 1);
      check('★ 而且释放方收到的那个球是**真球**（不是"随便留一个"）',
        forB.bs.length === 1 && forB.bs[0][0] === r.balls[0].id,
        `留下 id=${forB.bs[0][0]}，真球 id=${r.balls[0].id}，幻影 id=${ph.id}`);
      check('★ 释放方能拿到"幻影还剩几秒"（他需要这个做反馈）',
        forB.px[1] > 0 && forB.px[1] <= S.PHANTOM_MS / 1000,
        JSON.stringify(forB.px));
      check('★ 对手的 px 两格都必须是 0（自己那格是 0、另一格非 0 就等于告诉他"有幻影"）',
        forA.px[0] === 0 && forA.px[1] === 0, JSON.stringify(forA.px));
      // 包结构本身不能因为过滤而分叉：两边字段集合必须一致
      eq('★ 两队的包字段集合完全一致（只是值不同，不许静默多一个字段）',
        Object.keys(forA).sort().join(','), Object.keys(forB).sort().join(','));
      // 反向：不能过滤过头 —— 真球两边的 id 必须都在
      check('★ 过滤只吃幻影球，真球两边都在',
        forA.bs.some((b) => b[0] === r.balls[0].id) && forB.bs.some((b) => b[0] === r.balls[0].id));
    }

    // (b) coop：幻影归 0 队，而 0 队有**两个**槽位 —— 两个都要被过滤（按队，不按槽位）
    {
      const r = live('coop');
      r.serverTime = T;
      putPhantom(r, 0);
      const per = wire(r);
      S.broadcastState(r);
      eq('前置：coop 是 3 个座位', r.N, 3);
      eq('★ coop：同队的两个槽位都看不到自家幻影球（过滤按**队**，不按槽位）',
        lastOf(per[0]).bs.length + lastOf(per[1]).bs.length, 2);
      eq('★ coop：对手（1 队）看到两个球', lastOf(per[2]).bs.length, 2);
      check('★ coop：0 队的两个人都拿到"还剩几秒"的反馈',
        lastOf(per[0]).px[0] > 0 && lastOf(per[1]).px[0] > 0,
        `${JSON.stringify(lastOf(per[0]).px)} / ${JSON.stringify(lastOf(per[1]).px)}`);
      check('★ coop：1 队的 px 两格都是 0', lastOf(per[2]).px.every((v) => v === 0),
        JSON.stringify(lastOf(per[2]).px));
    }

    // (c) 没有幻影球时不许误伤：两边都该看到全部球
    {
      const r = live();
      r.serverTime = T;
      const per = wire(r);
      S.broadcastState(r);
      eq('没有幻影球时，两边看到的球数一致', lastOf(per[0]).bs.length, lastOf(per[1]).bs.length);
      eq('而且就是场上全部球', lastOf(per[0]).bs.length, r.balls.length);
      check('没有幻影球时 px 全 0',
        lastOf(per[0]).px.every((v) => v === 0) && lastOf(per[1]).px.every((v) => v === 0));
    }
  }
}

// ---------- 21. 第 11 轮：五种新技能 + 局间重选拍子 ----------
// 这一节的断言全部打在**服务端真值**上（几何 / 速率 / 计时器 / 下行字段），
// 不去复述客户端画了什么 —— 画面上的东西由浏览器探针（probe-skills）负责。
console.log('21) 第 11 轮：蓝粘球 / 黑黑洞 / 紫乱弹 / 白封锁 / 橙减速 + 局间重选拍子');
{
  const T = 1000000;

  function live(mode, codes) {
    const r = S.createRoom(codes || (mode === 'coop' ? 'COOP01' : 'LIVE01'), mode || 'duel');
    const fake = (t) => ({ ws: { readyState: 1 }, token: t, dir: 0, since: T });
    for (let i = 0; i < r.N; i += 1) if (!S.isBot(r.players[i])) r.players[i] = fake('t' + i);
    r.started = true;
    r.paused = false;
    r.userPaused = false;
    r.phase = 'playing';
    r.serverTime = T;
    return r;
  }
  const wire = (r) => {
    const per = [];
    for (let i = 0; i < r.N; i += 1) {
      const box = [];
      r.players[i] = { ws: { readyState: 1, send: (s) => box.push(s) }, token: 't' + i, dir: 0, since: T };
      per.push(box);
    }
    return per;
  };
  const lastOf = (box) => JSON.parse(box[box.length - 1]);

  // ---- 21.1 常量与技能表 ----
  eq('★ 九种皮肤，索引与服务端 SKINS 一一对应', S.SKIN_N, 9);
  check('★ 五个新皮肤的编号是 4~8（顺序不能变，客户端按同一下标取色）',
    S.SKIN_STICK === 4 && S.SKIN_BLACKHOLE === 5 && S.SKIN_CHAOS === 6
      && S.SKIN_BLOCK === 7 && S.SKIN_SLOW === 8,
    `${S.SKIN_STICK},${S.SKIN_BLACKHOLE},${S.SKIN_CHAOS},${S.SKIN_BLOCK},${S.SKIN_SLOW}`);
  check('★ 九种皮肤的冷却与服务端一致（风10/幻影15/超高速10/粘球10/黑洞10/乱弹15/封锁10/减速10）',
    JSON.stringify(S.SKILL_CD_MS) === JSON.stringify([0, 10000, 15000, 10000, 10000, 10000, 15000, 10000, 10000]),
    JSON.stringify(S.SKILL_CD_MS));
  check('★ 灰之外八种都算"有技能"（漏一种会让那个皮肤变成没法放的摆设）',
    [1, 2, 3, 4, 5, 6, 7, 8].every((s) => S.skinHasSkill(s)) && !S.skinHasSkill(0));

  // ---- 21.2 蓝：粘球 ----
  // 需求："下一次接触到球会把球粘住，1 秒以后自动向正前方释放，速度相当于普通球的初始速度"
  {
    const r = live();
    S.stepRoom; // 只为让下面读起来明显是在测服务端
    eq('前置：蓝拍子在第 4 号皮肤上', S.SKIN_STICK, 4);
    r.skins[0] = S.SKIN_STICK;
    r.skillReadyAt[0] = 0;
    r.serverTime = T;
    check('★ 放蓝技能成功', S.castSkill(r, 0, T) === true);
    eq('★ 武装标记立起来了', r.stickArmed[0], true);
    // 球飞到左拍上
    const b = r.balls[0];
    b.x = 40; b.y = r.paddles[0]; b.vx = -700; b.vy = 120;
    S.stepBalls(r, 0.033);
    check('★ 下一次触球真的把球粘住了（b.stuck 被设上）', !!b.stuck, JSON.stringify(b.stuck));
    eq('★ 粘球后速度清零（不是"还在飞"）', b.vx + b.vy, 0);
    eq('★ 武装标记被消耗掉（一对一，不能粘两板）', r.stickArmed[0], false);
    eq('★ 粘住它的就是那块拍子', b.stuck && b.stuck.slot, 0);
    // 1 秒之后自动向正前方（朝对面）释放，速率 = 普通初始速度
    r.serverTime = b.stuck.until + 1;
    S.stepBalls(r, 0.033);
    check('★ 到点后自动放出去（stuck 被清掉）', !b.stuck);
    eq('★ 释放方向是"向对方半场"（左拍子 → vx > 0）', b.vx > 0, true);
    eq('★ 释放速度 = 普通球的初始速度', Math.round(b.vx), S.BALL_SPEED_START);
    eq('★ 而且一点竖直分量都没有（"正前方"）', Math.round(b.vy), 0);
  }

  // ---- 21.3 黑：黑洞 ----
  // 需求：己方**靠近中间**的半区开洞（左：x ∈ [W/4, W/2]），
  //       球从对面**靠近中间**的半区飞出（左开 → 出在 x ∈ [W/2, 3W/4]），
  //       速率不变，方向朝对方 ±60°。
  {
    const r = live();
    r.skins[1] = S.SKIN_BLACKHOLE;
    r.skillReadyAt[1] = 0;
    r.serverTime = T;
    check('★ 放黑洞成功', S.castSkill(r, 1, T) === true);
    eq('★ 场上刚好一个洞', r.holes.length, 1);
    const h = r.holes[0];
    eq('★ 洞属于放它的那一队', h.team, 1);
    check('★ 右队开洞：落在球场**右半**靠近中间的半区（x ∈ [W/2, 3W/4]）',
      h.x >= r.W / 2 - 1 && h.x <= r.W * 0.75 + 1, `x=${h.x}`);
    // 让球撞进洞：把球摆到洞的位置上、以某个方向飞进去
    const b = r.balls[0];
    b.x = h.x; b.y = h.y; b.vx = 600; b.vy = 300;
    const before = Math.hypot(b.vx, b.vy);
    S.checkBlackhole(r, b);
    check('★ 球真的被吸走了（不再是原来那个坐标）',
      Math.abs(b.x - h.x) > 1 || Math.abs(b.y - h.y) > 1, `${b.x},${b.y}`);
    check('★ 出口落在对面（左半）靠近中间的半区（x ∈ [W/4, W/2]）',
      b.x >= r.W * 0.25 - 1 && b.x <= r.W / 2 + 1, `x=${b.x}`);
    check('★ 出口方向朝对面（右队开洞 → 球往左飞，vx < 0）', b.vx < 0, `vx=${b.vx}`);
    eq('★ 速率严格不变（这是需求的硬要求）', Math.round(Math.hypot(b.vx, b.vy)), Math.round(before));
    const ang = Math.abs(Math.atan2(b.vy, Math.abs(b.vx)));
    check('★ 出射角在 ±60° 之内',
      ang <= (S.HOLE_HALF_DEG * Math.PI / 180) + 0.001, `${(ang * 180 / Math.PI).toFixed(1)}°`);
    eq('★ 一个洞只用一次（用完即消）', r.holes.length, 0);
  }

  // 21.3b 洞的"靠近中间"边界是**真的**有约束，不是随手写了两句恒真的判断。
  //       反复放 200 次，每次都必须在带内 —— 单次采样碰到特例也可能通过。
  {
    let bad = 0;
    for (let k = 0; k < 200; k += 1) {
      const r = live('duel', 'BHK' + (k % 10) + k);
      r.skins[0] = S.SKIN_BLACKHOLE;
      r.serverTime = T;
      r.skillReadyAt[0] = 0;
      if (!S.castSkill(r, 0, T)) continue;
      const h = r.holes[0];
      if (!(h.x >= r.W * 0.25 && h.x <= r.W / 2)) bad += 1;
    }
    eq('★ 左队开洞 200 次，每次都在 x ∈ [W/4, W/2] 里', bad, 0);
  }

  // ---- 21.4 紫：乱弹 ----
  // 需求：10 秒内自己接球，"球不再按常规反弹，随机改变速度和角度，
  //       大概率是加速；角度向对方 ±60°"。cd 15 秒。
  {
    const r = live();
    eq('★ 乱弹的持续时间是 10 秒', S.CHAOS_MS, 10000);
    eq('★ 乱弹的冷却 15 秒', S.SKILL_CD_MS[S.SKIN_CHAOS], 15000);
    r.skins[0] = S.SKIN_CHAOS;
    r.skillReadyAt[0] = 0;
    r.serverTime = T;
    check('★ 放乱弹成功', S.castSkill(r, 0, T) === true);
    eq('★ 计时器立起来了', r.chaosUntil[0], T + S.CHAOS_MS);
    // 打 200 板，看"大概率加速"和"角度在带内"
    //
    // ★★ 阈值不能贴着期望值（2026-10-11 修）。服务端是 `Math.random() < 0.8`
    //   ⇒ 期望加速率 **80%**；旧断言写的是 `>= total * 0.75`。
    //   200 次、p=0.8 时标准差 = √(0.8×0.2/200) ≈ 2.8%，
    //   即阈值只落在期望值**下方 1.8σ** ⇒ 实测连跑 40 次红 2 次
    //   （现场：`加速 149/200`、`加速 148/200`，都是 74%）。
    //   这不是产品波动，是**阈值定得太紧**。修法：阈值放到 0.65
    //   （期望值下方 5.4σ，p<1e-7），同时把样本提到 400 次把 σ 再压一半。
    //   这条断言要证的是"多数是加速，不是一半一半" —— 0.65 完全够，
    //   50% 的假实现照样必红（40 次里 0 次能过）。
    let faster = 0, badAng = 0, total = 0;
    const CHAOS_TRIALS = 400;
    for (let k = 0; k < CHAOS_TRIALS; k += 1) {
      const r2 = live('duel', 'CHS' + (k % 10) + k);
      r2.skins[0] = S.SKIN_CHAOS;
      r2.chaosUntil[0] = T + S.CHAOS_MS;
      r2.serverTime = T;
      const b2 = r2.balls[0];
      b2.x = 40; b2.y = r2.paddles[0]; b2.vx = -700; b2.vy = 0;
      const spd = Math.hypot(b2.vx, b2.vy);
      S.bounceOffPaddle(r2, 0, b2);
      if (!(b2.vx > 0)) { badAng += 1; continue; }   // 必须打回对面
      total += 1;
      const out = Math.hypot(b2.vx, b2.vy);
      if (out > spd) faster += 1;
      const a = Math.abs(Math.atan2(b2.vy, Math.abs(b2.vx)));
      if (a > (S.CHAOS_HALF_DEG * Math.PI / 180) + 0.001) badAng += 1;
    }
    check('★ 乱弹打回对面板 400 次，出射角每次都在 ±60° 内',
      badAng === 0, `越界 ${badAng} 次`);
    check('★ "大概率加速"是真的多数（不是一半一半）',
      faster >= total * 0.65, `加速 ${faster}/${total}（期望 80%）`);
  }

  // 21.4b 没开乱弹时不许乱动：出射角仍由"打中拍子哪里"决定
  {
    const r = live();
    const b = r.balls[0];
    const py = r.paddles[0];
    b.y = py; b.vx = -700; b.vy = 0;   // 打正中 → 应当平着飞回去
    S.bounceOffPaddle(r, 0, b);
    eq('★ 没开乱弹时，打中正中的球竖直分量为 0（角度没被乱改）', Math.round(b.vy), 0);
  }

  // ---- 21.5 白：道具封锁 ----
  // 需求：让对方**下一次**吃到的道具无效；cd 10 秒；**不能叠加**。
  {
    eq('★ 封锁最多 1 层（需求："不能叠加"）', S.BLOCK_MAX, 1);
    const r = live();
    r.skins[0] = S.SKIN_BLOCK;
    r.skillReadyAt[0] = 0;
    r.serverTime = T;
    check('★ 放封锁成功', S.castSkill(r, 0, T) === true);
    eq('★ 挂在**对手**那一队身上（谁放的封谁对面）', r.blockCharges[1], 1);
    eq('★ 自己队不受影响', r.blockCharges[0], 0);
    // 不能叠加：再放一次（先把冷却清零模拟"另一块白拍子"）
    r.skillReadyAt[0] = 0;
    r.serverTime = T;
    const second = S.castSkill(r, 0, T);
    eq('★ 再放一次**放不出去**（已满层）', second, false);
    eq('★ 层数没有被叠成 2', r.blockCharges[1], 1);
    // 而且"放不出去"时**不该扣冷却**（扣了就变成"按一下就白等 10 秒"）
    eq('★ 被拒的那一次没有扣冷却', r.skillReadyAt[0], 0);
    // 对手吃到道具 → 道具被无效化，层数归零
    // ★ 拾取判定是"球撞到道具"（服务端 stepPowerup 里判的），所以必须真把球放上去 ——
    //   只把拍子移过去是没用的（那是另一个判定），第一版就是这么写错的。
    const r2 = live();
    r2.blockCharges[1] = 1;
    const px0 = r2.W - 35;
    const py0 = r2.H / 2;
    r2.powerups.push({ x: px0, y: py0, type: 0, bornAt: T });
    r2.paddles[1] = py0;
    // 第 1 队 = 右边那块拍子；把球摆到道具上
    r2.balls[0].x = px0; r2.balls[0].y = py0;
    r2.balls[0].vx = 0; r2.balls[0].vy = 0;
    r2.serverTime = T;
    // 归属：★ room.lastHitter 是**槽位号**不是队号（coop 里左边两个拍子同属 0 队），
    //   所以要让 1 队拿到道具，得把 lastHitter 设成 1 队那一侧的槽位（duel 里就是 1）。
    r2.lastHitter = 1;
    S.stepPowerup(r2, T);
    eq('★ 那一层被消耗掉了', r2.blockCharges[1], 0);
    eq('★ 道具被吃掉了（不是留在场上）', r2.powerups.length, 0);
    check('★ 而且道具真的**没生效**（没有把效果加到 1 队身上）',
      r2.freezeUntil[1] === 0 || r2.doubleUntil[1] === 0,
      `fz=${r2.freezeUntil[1]} db=${r2.doubleUntil[1]}`);
    check('★ 事件里报告的是"被封掉"（b 前缀），不是"吃到了"（u 前缀）',
      r2.events.some((e) => /^b1/.test(e)), JSON.stringify(r2.events));
  }

  // 21.5b 对照：没有封锁时道具必须**正常生效**（否则"被封掉"那条可能只是因为道具坏了）
  {
    const r3 = live();
    const px1 = r3.W - 35;
    const py1 = r3.H / 2;
    r3.powerups.push({ x: px1, y: py1, type: 0, bornAt: T });
    r3.balls[0].x = px1; r3.balls[0].y = py1;
    r3.balls[0].vx = 0; r3.balls[0].vy = 0;
    r3.lastHitter = 1;
    S.stepPowerup(r3, T);
    eq('★ 对照组：没埋雷时道具被正常吃掉', r3.powerups.length, 0);
    check('★ 对照组：事件是"吃到了"（u 前缀）',
      r3.events.some((e) => /^u1/.test(e)), JSON.stringify(r3.events));
  }

  // ---- 21.6 橙：减速 ----
  // 需求：对方拍子移动速度上限降 30%，持续 2 秒，cd 10 秒。
  {
    eq('★ 减速倍率 0.7（即降 30%）', S.SLOW_MUL, 0.7);
    eq('★ 持续 2 秒', S.SLOW_MS, 2000);
    const r = live();
    r.skins[0] = S.SKIN_SLOW;
    r.skillReadyAt[0] = 0;
    r.serverTime = T;
    check('★ 放减速成功', S.castSkill(r, 0, T) === true);
    eq('★ 加在对手那一队身上', r.slowUntil[1], T + S.SLOW_MS);
    // 实测位移：同样的按住时间，减速方走得少
    const dt = 0.033, sub = 8;
    const r3 = live();
    const p0 = r3.paddles[1];
    r3.players[1].dir = 1;
    for (let i = 0; i < 30; i += 1) S.stepPaddles(r3, dt / sub), S.stepPaddles(r3, 0);
    const moved = Math.abs(r3.paddles[1] - p0);
    const r4 = live();
    r4.slowUntil[1] = T + S.SLOW_MS;
    const q0 = r4.paddles[1];
    r4.players[1].dir = 1;
    for (let i = 0; i < 30; i += 1) S.stepPaddles(r4, dt / sub), S.stepPaddles(r4, 0);
    const movedSlow = Math.abs(r4.paddles[1] - q0);
    check('★ 被减速的拍子确实走得慢一些',
      movedSlow < moved, `正常 ${moved.toFixed(1)} vs 减速 ${movedSlow.toFixed(1)}`);
    check('★ 慢的比例接近 0.7（不是"几乎不动"也不是"没区别"）',
      moved > 5 && Math.abs(movedSlow / moved - S.SLOW_MUL) < 0.06,
      `比值 ${(movedSlow / moved).toFixed(3)}`);
  }

  // ---- 21.7 到期清理：每放一次就永久多一个 = 老坑（风就是这样踩过的） ----
  {
    const r = live();
    r.serverTime = T;
    r.skins[0] = S.SKIN_BLACKHOLE;
    r.skillReadyAt[0] = 0;
    S.castSkill(r, 0, T);
    eq('前置：场上有一个洞', r.holes.length, 1);
    r.serverTime = T + S.HOLE_LIFE_MS + 1000;
    S.trackMods(r, r.serverTime);
    eq('★ 到寿的洞被清掉了（不清就会每放一次永久多一个）', r.holes.length, 0);
    r.slowUntil[1] = T + 100;
    r.serverTime = T + 200;
    S.trackMods(r, r.serverTime);
    eq('★ 到寿的减速被清掉了', r.slowUntil[1], 0);
  }

  // ---- 21.8 暂停：新计时器也必须跟着挂钟后移 ----
  {
    const r = live();
    r.serverTime = T;
    r.chaosUntil[0] = T + S.CHAOS_MS;
    r.slowUntil[1] = T + S.SLOW_MS;
    r.holes.push({ x: 400, y: 250, team: 0, until: T + S.HOLE_LIFE_MS });
    r.balls[0].stuck = { slot: 0, until: T + S.STICK_MS, ox: 40, oy: 250 };
    S.shiftDeadlines(r, 5000);
    eq('★ 乱弹的截止时刻跟着后移', r.chaosUntil[0], T + S.CHAOS_MS + 5000);
    eq('★ 减速的截止时刻跟着后移', r.slowUntil[1], T + S.SLOW_MS + 5000);
    eq('★ 黑洞的截止时刻跟着后移', r.holes[0].until, T + S.HOLE_LIFE_MS + 5000);
    eq('★ 粘球的截止时刻跟着后移', r.balls[0].stuck.until, T + S.STICK_MS + 5000);
  }

  // ---- 21.9 新一局：技能计时器全清 ----
  {
    const r = live();
    r.serverTime = T;
    r.skins[0] = S.SKIN_STICK;
    r.stickArmed[0] = true;
    r.chaosUntil[0] = T + 9999;
    r.blockCharges[1] = 1;
    r.slowUntil[1] = T + 9999;
    r.holes.push({ x: 400, y: 250, team: 0, until: T + 9999 });
    S.clearSkills(r);
    check('★ 武装被清掉', r.stickArmed[0] === false);
    check('★ 乱弹被清掉', r.chaosUntil[0] === 0);
    check('★ 封锁被清掉', r.blockCharges[1] === 0);
    check('★ 减速被清掉', r.slowUntil[1] === 0);
    check('★ 黑洞被清掉', r.holes.length === 0);
    eq('★ 但皮肤**保留**（那是这一场的选择）', r.skins[0], S.SKIN_STICK);
  }

  // ---- 21.10 局间重选拍子 ----
  // 需求原文："无论什么模式，每结束一局都要可以重新选拍子"
  {
    const r = live();
    r.serverTime = T;
    // 对局中不许改
    eq('★ 开打中改皮肤 = 拒绝（否则球飞着还能换技能）', S.pickSkin(r, 0, S.SKIN_BOOST), false);
    eq('★ 而且皮肤没变', r.skins[0], 0);
    // 结算画面（over）也不许改 —— 那时候场上还有上一局的残局
    r.phase = 'over';
    r.reselectPending = true;
    eq('★ 结算画面里也拒绝（这时候换皮肤，玩家会看到上一局残局里自己的拍子变色）',
      S.pickSkin(r, 0, S.SKIN_BOOST), false);
    // 新一局翻开（countdown）才是窗口
    r.phase = 'countdown';
    eq('★ 局间改皮肤成功', S.pickSkin(r, 0, S.SKIN_BOOST), true);
    eq('★ 皮肤真的换了', r.skins[0], S.SKIN_BOOST);
    // ★ 换皮肤 = 换技能，上一种技能挂在自己身上的东西必须一起清
    r.boostArmed[0] = true;
    r.stickArmed[0] = true;
    r.chaosUntil[0] = T + 9999;
    r.phase = 'countdown';
    r.reselectPending = true;
    S.pickSkin(r, 0, S.SKIN_STICK);
    check('★ 换皮肤时把上一种技能的装载一起清掉（不然会出现"红蓄好力、切灰还能打超高速"）',
      r.boostArmed[0] === false && r.stickArmed[0] === false && r.chaosUntil[0] === 0);
    eq('★ 新技能从"可以放"开始', r.skillReadyAt[0], 0);
  }

  // 21.10b 窗口本身：开了之后只在那一段里成立，球一发出去就关
  {
    const r = live();
    r.serverTime = T;
    r.reselectPending = true;
    r.phase = 'countdown';
    const per = wire(r);
    const canNow = [];
    S.broadcastState(r);
    canNow.push(lastOf(per[0]).rsel);
    r.phase = 'playing';
    S.broadcastState(r);
    canNow.push(lastOf(per[0]).rsel);
    check('★ 倒计时期间 rsel=1，开打后 rsel=0（窗口由服务端说了算）',
      canNow[0] === 1 && canNow[1] === 0, JSON.stringify(canNow));
    eq('★ 窗口关闭后 pickSkin 也一并失效', S.pickSkin(r, 0, S.SKIN_BLOCK), false);
  }

  // 21.10c bot 的皮肤不许被改（AI 不选拍子，它的槽位不该冒出按钮或技能）
  {
    const r = live('solo');
    r.serverTime = T;
    r.phase = 'countdown';
    r.reselectPending = true;
    const botSide = r.N - 1;
    eq('前置：最后一个座位确实是 AI', S.isBot(r.players[botSide]), true);
    eq('★ AI 没有技能（灰板子）', r.skins[botSide], 0);
  }

  // ---- 21.11 下行字段按队过滤（白·封锁与幻影球同一条道理） ----
  {
    const r = live();
    r.serverTime = T;
    r.blockCharges = [1, 0];       // 0 队埋了雷，要封 1 队
    const per = wire(r);
    S.broadcastState(r);
    const for0 = lastOf(per[0]);
    const for1 = lastOf(per[1]);
    eq('★ 施放方（0 队）看得到自己挂了几层', for0.bk[0], 1);
    eq('★ 被封锁方（1 队）**看不到**（提前知道就等于会躲道具，技能废一半）', for1.bk[0], 0);
    check('★ 两队的包字段集合完全一致（只是值不同，不许静默多一个字段）',
      JSON.stringify(Object.keys(for0).sort()) === JSON.stringify(Object.keys(for1).sort()),
      `${Object.keys(for0).length} vs ${Object.keys(for1).length}`);
  }

  // ---- 21.12 幻影球对 AI 生效（需求："黄拍子的幻影球好像对电脑无效"） ----
  {
    eq('★ 幻影球给 AI 的额外瞄准偏差是个正数（0 就等于 AI 完全不上当）',
      S.PHANTOM_BOT_SWAY > 0, true);
  }
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
process.exit(fail === 0 ? 0 : 1);