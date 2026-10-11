'use strict';

/**
 * 碰撞判定的**暴力扫描**测试（离线，不需要服务在跑）。
 *
 * 要回答的问题：玩家报告"偶尔球会穿过我的拍子"。
 * 这可能是两种完全不同的原因：
 *   A) 服务端判定有洞 —— 球明明该弹却飞过去了（真 bug，会改变胜负）；
 *   B) 网络 / 渲染的时序差 —— 判定没问题，只是你**眼睛看到的时刻**和
 *      服务端**判定的时刻**不是同一个瞬间。
 *
 * 这个文件只负责把 A 彻底排除（B 由 probe-ball-lag.js 负责）。
 * 做法不是"跑几发看看"，而是把**拍子放在什么位置能接到**这整个区间扫出来，
 * 然后检查四条真正成立的不变式：
 *   1) 区间**连续** —— 内部出现空洞就说明球会"漏"过去（隧穿）；
 *   2) 区间**覆盖**几何上应该接到的全部位置 —— 不该把该接的判成不接；
 *   3) 0° 直球时区间**严格对称**在穿越点上 —— 无系统性偏移；
 *   4) 区间**不会离谱地宽** —— 拍子不能变成"擦一下就吸住"。
 *
 * ★ 曾经写过第 5 条"区间中心必须对准穿越点"，那是**错的**：球撞上下墙折返后，
 *   判定窗口会顺着 y 漂移的方向变宽，区间天然不对称（实测 -30° 时中心偏 13.75px）。
 *   把它当断言就会把正确实现判成红。所以中心只对 0° 直球断言。
 */

process.env.PONG_NO_LISTEN = '1';
const S = require('../server.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  [ok]   ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined && extra !== '' ? '  -> ' + extra : ''}`);
  }
}

console.log('\n========== 碰撞判定扫描测试 ==========\n');

const SUB_DT = 1 / 30 / 8;               // 与 server.js 一致：30Hz × 8 子步
const R = S.BALL_R;
const PADDLE_W = S.PADDLE_W;
const PADDLE_MARGIN = S.PADDLE_MARGIN;
const HALF_BASE = S.PADDLE_H / 2;        // 标准拍子的半长 = 48
const DUEL = S.COURT.duel;
const SPEED_MAX = 900;                   // BALL_SPEED_MAX
const MUL_FAST = S.BALL_FAST;            // 球加速道具倍率
const SUB_TRAVEL_MAX = (SPEED_MAX * MUL_FAST) / 240;      // 子步内最大位移
// x 方向的判定窗口深度：b.x ∈ (PADDLE_MARGIN-30, PADDLE_MARGIN+PADDLE_W+R]
const X_DEPTH = 30 + PADDLE_W + R;
// 窗口内 y 最多漂移多少：只取决于角度，与速度无关
const Y_DRIFT_MAX = X_DEPTH * Math.tan(Math.PI / 3.2);

// ---------------------------------------------------------------
// 最小驱动器：直接推进 stepBall，绕开 stepRoom（那需要真人连接 + 等倒计时）
// ---------------------------------------------------------------
function makeRoom(mode, paddleMul) {
  const room = S.createRoom('CL' + Math.random().toString(36).slice(2, 8).toUpperCase(), mode, -1);
  room.phase = 'playing';
  room.started = true;
  room.curveUntil = 0;
  room.curveSpin = 0;
  room.events = [];
  room.paddleMul = [paddleMul, paddleMul];
  return room;
}

/**
 * 朝左边打一发。paddleY = -1e6 表示"左边没有拍子"，用来测球的穿越点。
 * 返回 { kind:'hit'|'pass'|'cross', crossY }
 *   hit —— 被 0 号拍子弹回；pass —— 从左边界漏出去了；cross —— 只测穿越点
 */
function shoot(opts) {
  const {
    mode = 'duel', speed, mul = 1, angleDeg = 0, paddleY,
    paddleMul = 1, crossOnly = false, right = false, ballY = DUEL.H / 2,
  } = opts;
  const room = makeRoom(mode, paddleMul);
  room.paddles = room.slots.map((s) => (s.span[0] + s.span[1]) / 2);
  room.paddles[right ? 1 : 0] = paddleY;
  room.ballMul = mul;
  const b = room.balls[0];
  const a = (angleDeg * Math.PI) / 180;
  const dir = right ? 1 : -1;
  b.x = room.W / 2;
  b.y = ballY;
  b.vx = dir * speed * Math.cos(a);
  b.vy = speed * Math.sin(a);

  const faceX = right ? room.W - PADDLE_MARGIN - PADDLE_W : PADDLE_MARGIN + PADDLE_W;
  const hitTag = right ? 'h1' : 'h0';
  let crossY = null;
  for (let i = 0; i < 8000; i += 1) {
    S.stepBalls(room, SUB_DT);
    const inFace = right ? b.x + R >= faceX : b.x - R <= faceX;
    if (crossY === null && inFace) crossY = b.y;
    if (crossOnly) {
      if (crossY !== null) return { kind: 'cross', crossY };
      continue;
    }
    let hit = false;
    let goal = false;
    for (const e of room.events) {
      if (e === hitTag) hit = true;
      if (e[0] === 'g' || e[0] === 'o') goal = true;
    }
    room.events = [];
    if (hit) return { kind: 'hit', crossY };
    if (goal) return { kind: 'pass', crossY };
  }
  return { kind: 'timeout', crossY };
}

/** 该配置下拍子的半长（跟服务端 paddleHalf 同一套算法，避免又写一个 /2） */
function halfOf(paddleMul) {
  return (S.PADDLE_H * paddleMul) / 2;
}

/**
 * 扫出"拍子放在哪儿能接到"的整个区间。
 * 返回 { yCross, hitCount, lo, hi, width, interiorGaps, covered, need, half, symmetric }
 */
function sweepPaddle(fixed, range = 110, stepPx = 0.5) {
  const half = halfOf(fixed.paddleMul || 1);
  const need = half + R;
  const probe = shoot(Object.assign({}, fixed, { paddleY: -1e6, crossOnly: true }));
  const yCross = probe.crossY;

  const pts = [];
  for (let d = -range; d <= range + 1e-9; d += stepPx) {
    const py = yCross + d;
    pts.push({ py, hit: shoot(Object.assign({}, fixed, { paddleY: py })).kind === 'hit' });
  }

  // 内部空洞：hit → miss → hit 才算洞（区间两端之外的 miss 不算）
  const interiorGaps = [];
  let seenHit = false;
  let openGap = null;
  for (const p of pts) {
    if (p.hit) {
      if (openGap) { interiorGaps.push(openGap); openGap = null; }
      seenHit = true;
    } else if (seenHit) {
      if (!openGap) openGap = { from: p.py, to: p.py };
      else openGap.to = p.py;
    }
  }

  const hits = pts.filter((p) => p.hit).map((p) => p.py);
  const lo = hits.length ? Math.min(...hits) : NaN;
  const hi = hits.length ? Math.max(...hits) : NaN;
  const width = hits.length ? hi - lo + stepPx : 0;
  // 覆盖：实测区间必须**包含**几何上应该接到的整段 [yCross ± need]
  // （留 0.5px 的栅格 rounding）
  const covered = hits.length > 0 && lo <= yCross - need + stepPx && hi >= yCross + need - stepPx;
  // 对称：只在 0° 直球时断言（无 y 漂移，区间必须严格对称）
  const symmetric = hits.length > 0
    && Math.abs((yCross - lo) - (hi - yCross)) <= 1.5;
  // 宽度上限：2×need 加上窗口内最大 y 漂移，再多就是"擦一下就吸住"了
  const widthCap = 2 * need + Y_DRIFT_MAX + 1;
  return { yCross, hitCount: hits.length, lo, hi, width, interiorGaps, covered, need, half, symmetric, widthCap };
}

/** 一个配置的完整体检，红/绿都靠它 */
function verdict(cfg, range = 130) {
  const s = sweepPaddle(cfg, range, 0.5);
  const why = !s.hitCount ? '一个位置都接不到'
    : s.interiorGaps.length ? `有 ${s.interiorGaps.length} 个内部空洞`
      : !s.covered ? `区间不够宽（实测 ${s.width.toFixed(1)}px，需覆盖 ${(2 * s.need).toFixed(1)}px）`
        : s.width > s.widthCap ? `区间过宽（${s.width.toFixed(1)}px > 上限 ${s.widthCap.toFixed(1)}px）`
          : '';
  return { ok: why === '', s, why };
}

// ---------------------------------------------------------------
// 0) 量具标定
// ---------------------------------------------------------------
console.log('0) 量具标定');
console.log(`         经典场地 ${DUEL.W}×${DUEL.H}，拍子半长 ${HALF_BASE}，判定窗口 ±${HALF_BASE + R}px，x 窗口深 ${X_DEPTH}px`);
check(
  `每个子步最多走 ${SUB_TRAVEL_MAX.toFixed(2)}px，远小于判定窗口高度 ${(2 * (HALF_BASE + R)).toFixed(0)}px`,
  SUB_TRAVEL_MAX < (2 * (HALF_BASE + R)) / 10,
  `${SUB_TRAVEL_MAX.toFixed(2)}px`
);
check(
  `每个子步最多走 ${SUB_TRAVEL_MAX.toFixed(2)}px，也远小于 x 窗口深度 ${X_DEPTH}px`,
  SUB_TRAVEL_MAX < X_DEPTH / 5,
  `${SUB_TRAVEL_MAX.toFixed(2)}px`
);
{
  // ★ 先证明体检函数在坏情况下真的会红，否则后面所有绿灯都不算数
  const good = verdict({ speed: 700, mul: 1, angleDeg: 0 });
  const bad = verdict({ speed: SPEED_MAX, mul: MUL_FAST * 45, angleDeg: 0 }, 300);
  check('★ 量具自检：正常配置 → 体检通过（基线）', good.ok, good.why);
  check('★ 量具自检：子步位移放大到 ≫ 判定窗口 → 体检**必须报红**', bad.ok === false,
    `坏配置竟然通过了（实测可接 ${bad.s.hitCount} 个位置）`);
}

// ---------------------------------------------------------------
// 1) 正中心必中
// ---------------------------------------------------------------
console.log('\n1) 正中心必中（拍子正好挡在球路上，必须弹回）');
{
  const angles = [0, 8, -8, 20, -20, 35, -35, 50, -50];
  const speeds = [430, 700, 900];
  const muls = [1, 1.2, MUL_FAST];
  const pMuls = [S.PADDLE_SHRINK, 1, S.PADDLE_GROW];
  let cases = 0;
  const misses = [];
  for (const angleDeg of angles) {
    for (const speed of speeds) {
      for (const mul of muls) {
        for (const paddleMul of pMuls) {
          const half = halfOf(paddleMul);
          const probe = shoot({ speed, mul, angleDeg, paddleY: -1e6, crossOnly: true });
          if (probe.crossY === null) continue;
          // 穿越点贴墙时拍子放不下 —— 那不是判定问题，是几何上够不着，跳过
          if (probe.crossY - half < 0 || probe.crossY + half > DUEL.H) continue;
          cases += 1;
          const r = shoot({ speed, mul, angleDeg, paddleY: probe.crossY, paddleMul });
          if (r.kind !== 'hit') misses.push(`v=${speed}×${mul} a=${angleDeg}° pM=${paddleMul} -> ${r.kind}`);
        }
      }
    }
  }
  check(`正中心必中：${cases} 组全过（速度 × 球速倍率 × 角度 × 拍长）`, misses.length === 0, misses.slice(0, 4).join(' | '));
}

// ---------------------------------------------------------------
// 2) 可接区间连续性
// ---------------------------------------------------------------
console.log('\n2) 可接区间连续性（内部零空洞 = 隧穿不可能）');
{
  const configs = [
    { speed: 430, mul: 1, angleDeg: 0 },
    { speed: 900, mul: 1, angleDeg: 0 },
    { speed: 900, mul: MUL_FAST, angleDeg: 0 },
    { speed: 900, mul: MUL_FAST, angleDeg: 20 },
    { speed: 900, mul: MUL_FAST, angleDeg: -20 },
    { speed: 900, mul: MUL_FAST, angleDeg: 40 },
    { speed: 900, mul: MUL_FAST, angleDeg: -40 },
    { speed: 900, mul: MUL_FAST, angleDeg: 56 },
    { speed: 650, mul: MUL_FAST, angleDeg: -56 },
    { speed: 900, mul: MUL_FAST, angleDeg: 0, paddleMul: S.PADDLE_SHRINK },
    { speed: 900, mul: MUL_FAST, angleDeg: 0, paddleMul: S.PADDLE_GROW },
  ];
  let holes = 0;
  const empty = [];
  for (const c of configs) {
    const s = sweepPaddle(c, 130, 0.5);
    holes += s.interiorGaps.length;
    // ★ "零空洞"不等于"没问题"：区间整个变成空（一个位置都接不到）也是漏球，
    //   而且更严重。所以必须同时要求命中数 > 0。
    if (s.hitCount === 0) empty.push(`${Math.round(c.speed * c.mul)}px/s ${c.angleDeg}° ×${c.paddleMul || 1}`);
    console.log(`         · 球速 ${Math.round(c.speed * c.mul)}px/s 角度 ${String(c.angleDeg).padStart(3)}° 拍长×${c.paddleMul || 1}`
      + ` → 可接区间 [${s.lo.toFixed(1)}, ${s.hi.toFixed(1)}] 宽 ${s.width.toFixed(1)}px（上限 ${s.widthCap.toFixed(1)}） 洞 ${s.interiorGaps.length}`);
  }
  check('★ 每个配置都**真的接得到**（可接区间非空）', empty.length === 0, `整个接不到的配置：${empty.join(' | ')}`);
  check('★ 全部配置的可接区间内部**零空洞**（隧穿不可能发生）', holes === 0, `空洞合计 ${holes}`);
}

// ---------------------------------------------------------------
// 3) 应接尽接 / 对称 / 宽度有界
// ---------------------------------------------------------------
console.log('\n3) 应接尽接 + 直球对称 + 宽度有界');
{
  const configs = [
    { speed: 430, mul: 1, angleDeg: 0 },
    { speed: 900, mul: MUL_FAST, angleDeg: 0 },
    { speed: 900, mul: MUL_FAST, angleDeg: 30 },
    { speed: 900, mul: MUL_FAST, angleDeg: -30 },
    { speed: 700, mul: 1, angleDeg: 0, paddleMul: S.PADDLE_SHRINK },
    { speed: 700, mul: 1, angleDeg: 0, paddleMul: S.PADDLE_GROW },
  ];
  const notCovered = [];
  const asym = [];
  const tooWide = [];
  for (const c of configs) {
    const s = sweepPaddle(c, 150, 0.5);
    console.log(`         · v=${Math.round(c.speed * c.mul)} a=${String(c.angleDeg).padStart(3)}° 拍长×${c.paddleMul || 1}`
      + ` → 宽 ${s.width.toFixed(1)}px（需覆盖 ${(2 * s.need).toFixed(1)}，上限 ${s.widthCap.toFixed(1)}）`
      + ` 上下不对称度 ${Math.abs((s.yCross - s.lo) - (s.hi - s.yCross)).toFixed(2)}px`);
    if (!s.covered) notCovered.push(`v=${Math.round(c.speed * c.mul)} a=${c.angleDeg}° pM=${c.paddleMul || 1}`);
    if (c.angleDeg === 0 && !s.symmetric) asym.push(`v=${Math.round(c.speed * c.mul)} pM=${c.paddleMul || 1}: 偏 ${Math.abs((s.yCross - s.lo) - (s.hi - s.yCross)).toFixed(2)}px`);
    if (s.width > s.widthCap) tooWide.push(`v=${Math.round(c.speed * c.mul)} a=${c.angleDeg}°: ${s.width.toFixed(1)}px`);
  }
  check('★ 实测可接区间**覆盖**几何上应该接到的全部位置（应接尽接）', notCovered.length === 0, notCovered.join(' | '));
  check('★ 0° 直球时区间严格对称在穿越点上（无系统性偏移）', asym.length === 0, asym.join(' | '));
  check(`★ 区间宽度不超过 2×窗口 + 窗口内最大 y 漂移（拍子不会"擦一下就吸住"）`, tooWide.length === 0, tooWide.join(' | '));
}

// ---------------------------------------------------------------
// 4) 右侧镜像 + coop 中线不是死区
// ---------------------------------------------------------------
console.log('\n4) 右侧镜像 & coop 中线');
{
  const rightCfg = verdict({ speed: 900, mul: MUL_FAST, angleDeg: 0, right: true }, 120);
  check(`右拍的可接区间同样连续且覆盖到位（实测 ${rightCfg.s.hitCount} 个位置可接）`, rightCfg.ok, rightCfg.why);

  const coop = S.createRoom('COOPCL', 'coop', 0);
  const spanTop = coop.slots[0].span;
  const mid = coop.H / 2;
  const unreachable = [];
  for (const pMul of [S.PADDLE_SHRINK, 1, S.PADDLE_GROW]) {
    const half = halfOf(pMul);
    const lo = spanTop[0] + half;      // 拍子中心能到的最小 y（与 stepPaddles 的 clamp 一致）
    const hi = spanTop[1] - half;
    const nearest = Math.min(Math.abs(mid - lo), Math.abs(mid - hi));   // 离中线最近能到多远
    const need = half + R;
    const ok = nearest <= need;
    if (!ok) unreachable.push(`拍长×${pMul}`);
    console.log(`         · 拍长×${pMul}：拍子中心离中线最近 ${nearest.toFixed(1)}px，判定窗口 ${need.toFixed(1)}px ${ok ? '✓' : '✗'}`);
  }
  check('★ coop 里正好压在**中线**上的球，上边那位任何拍长都还够得着（中线不是死区）', unreachable.length === 0, unreachable.join(' '));
}

// ---------------------------------------------------------------
// 5) 长时间对打：球永远碰不到"接触面"以内
// ---------------------------------------------------------------
console.log('\n5) 长时间对打（运行时反隧穿）');
{
  const room = makeRoom('duel', 1);
  const midY = room.H / 2;
  room.paddles = [midY, midY];
  const b = room.balls[0];
  b.x = room.W / 2; b.y = midY; b.vx = -SPEED_MAX; b.vy = 0;
  const leftPlane = PADDLE_MARGIN + PADDLE_W + R;
  const rightPlane = room.W - PADDLE_MARGIN - PADDLE_W - R;
  let hits = 0;
  let minGap = 1e9;
  let lastHit = -1e9;
  let worstLeft = 1e9;
  let worstRight = -1e9;
  for (let i = 0; i < 30000; i += 1) {
    S.stepBalls(room, SUB_DT);
    worstLeft = Math.min(worstLeft, b.x);
    worstRight = Math.max(worstRight, b.x);
    for (const e of room.events) {
      if (e === 'h0' || e === 'h1') {
        hits += 1;
        minGap = Math.min(minGap, i - lastHit);
        lastHit = i;
      }
    }
    room.events = [];
    if (room.phase !== 'playing') {
      b.x = room.W / 2; b.y = midY;
      b.vx = (Math.random() < 0.5 ? -1 : 1) * SPEED_MAX; b.vy = 0;
      room.phase = 'playing';
      room.paddles = [midY, midY];
    }
  }
  check(`长时间对打命中 ${hits} 次（拍子挡得住）`, hits > 100, `hits=${hits}`);
  check('相邻两次命中至少隔 100 个判定子步（不会在原地反复判定）', minGap >= 100, `最小间隔 ${minGap}`);
  check(`★ 球的 x 从未越过左侧接触面（实测最小 ${worstLeft.toFixed(2)} ≥ ${leftPlane}）`, worstLeft >= leftPlane,
    `越过了 ${(leftPlane - worstLeft).toFixed(2)}px`);
  check(`★ 球的 x 从未越过右侧接触面（实测最大 ${worstRight.toFixed(2)} ≤ ${rightPlane}）`, worstRight <= rightPlane,
    `越过了 ${(worstRight - rightPlane).toFixed(2)}px`);
}

console.log(`\n========== 碰撞判定：通过 ${pass} 项，失败 ${fail} 项 ==========\n`);
process.exit(fail === 0 ? 0 : 1);
