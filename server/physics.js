'use strict';

/**
 * Ball creation and server-authoritative ball physics.
 *
 * Room lifecycle, miss diagnostics, and score settlement remain outside this
 * module and are supplied as callbacks. This keeps physics independent from
 * HTTP, WebSocket, and the server entry point.
 *
 * @module server/physics
 */

/**
 * Create ball physics functions with explicit constants and room helpers.
 *
 * @param {object} deps Physics constants, room helpers, and server callbacks.
 * @returns {object} Ball construction, stepping, collision, and shield APIs.
 */
function createPhysics(deps) {
  const {
    BALL_R,
    BALL_SPEED_START,
    BALL_SPEED_MAX,
    SPEEDUP_PER_HIT,
    MAX_BOUNCE_ANGLE,
    PADDLE_W,
    PADDLE_MARGIN,
    MAX_BALLS,
    SPLIT_SPEED_MUL,
    MIN_VX_RATIO,
    UNSTICK_ANG_MIN,
    UNSTICK_ANG_MAX,
    UNSTICK_MIN_SPEED,
    WIND_ACC,
    BOOST_SPEED,
    STICK_MS,
    CHAOS_HALF_DEG,
    HOLE_R,
    HOLE_HALF_DEG,
    clamp,
    isPhantom,
    paddleHalf,
    recordMissApproach,
    afterGoal,
  } = deps;

  // One monotonically increasing sequence is shared across rooms and resets.
  let ballSeq = 0;

  /**
   * Construct a stationary ball with a stable identity.
   *
   * @param {number} x Initial horizontal position.
   * @param {number} y Initial vertical position.
   * @returns {object} New ball state.
   */
  function makeBall(x, y) {
    ballSeq += 1;
    return { id: ballSeq, x, y, vx: 0, vy: 0 };
  }

  /**
   * 分裂球：**原球一点都不动**（轨迹、速度、方向全不变），额外多出一个球。
   *
   * 新球的初速度 = 分裂瞬间原球速度的一半（见 SPLIT_SPEED_MUL）。
   *   · 只有一半速，两个球会明显错开：快的先到，慢的后到，
   *     变成"先应付这个再补那个"，而不是两个同时砸到脸上；
   *   · 方向取原球竖直方向的**镜像**（vy 取反）：两球立刻朝上下分开，
   *     视觉上就是一个"人"字，一眼能看出是分裂出来的。
   *     vy 接近 0 时镜像等于原样，两球会重叠在一起飞 —— 所以这种时候改成
   *     按固定角度偏转，保证它们一定分得开。
   *
   * 到上限就不分（见 MAX_BALLS）：再分下去就是弹幕了。
   *
   * @param {object} room Current room state.
   * @returns {boolean} Whether a new ball was created.
   */
  function splitBall(room) {
    // ★ 只数**真球**：幻影球是假的，它占了名额会让"分裂球"变成"吃了没反应"；
    //   而且源球也必须是真球 —— 从一个幻影球上分裂出来，生出来的还是假的，
    //   两个假球会一起穿透真球，观感非常诡异。
    const real = room.balls.filter((b) => !isPhantom(b));
    if (real.length >= MAX_BALLS) return false;
    const src = real[0];
    if (!src) return false;

    const speed = Math.hypot(src.vx, src.vy) * SPLIT_SPEED_MUL;
    if (speed < 1) return false;                     // 球还没发出去，没什么可分的

    const dir = Math.atan2(src.vy, src.vx);
    const mirror = Math.abs(Math.sin(dir)) > 0.2
      ? -dir                                          // 常规：按水平轴镜像
      : (Math.sin(dir) >= 0 ? dir + 0.6 : dir - 0.6);  // 近水平：硬掰开一个角度

    const b = makeBall(src.x, src.y);
    b.vx = Math.cos(mirror) * speed;
    b.vy = Math.sin(mirror) * speed;
    room.balls.push(b);
    return true;
  }

  /**
   * 重新发球：清掉隐形与最后击球方，回到倒计时阶段。
   *
   * ★ 重新发球时隐形必须结束。
   *   隐形是靠"球还在原来那条轨道上"才能预判的；一旦重新发球，
   *   轨道本身换了，被隐形的人就彻底没有任何信息了 —— 那不是"难接"，
   *   是"白送一分"。所以每次重新发球都把隐形清掉，
   *   它的作用范围严格限定在"吃到它的那一个回合"。
   *
   * @param {object} room Current room state.
   * @param {number} serveTo Team receiving the next serve.
   * @returns {void}
   */
  function resetBall(room, serveTo) {
    const b = makeBall(room.W / 2, room.H / 2);
    room.balls = [b];
    room.serveTo = serveTo;
    room.lastHitter = -1;
    room.invisUntil = [0, 0];
    room.phase = 'countdown';
    room.phaseEndsAt = Date.now() + deps.COUNTDOWN_MS;
  }

  /**
   * 发球：把中线上的球按接收方方向打出去。
   *
   * 发球方 = 接球方的对面。取那一队的第一个槽位当"最后击球者"，
   * 这样球一发出去就撞到道具时，归属也有明确答案。
   *
   * @param {object} room Current room state.
   * @returns {void}
   */
  function launchBall(room) {
    const dir = room.serveTo === 0 ? -1 : 1;   // 发给哪一队，球就往哪边飞
    const angle = (Math.random() * 2 - 1) * (MAX_BOUNCE_ANGLE * 0.55);
    const b = room.balls[0];
    if (!b) return;
    b.vx = dir * room.ballSpeed0 * Math.cos(angle);
    b.vy = room.ballSpeed0 * Math.sin(angle);
    const servingTeam = 1 - room.serveTo;
    room.lastHitter = room.slots.findIndex((s) => s.team === servingTeam);
    room.phase = 'playing';
  }

  /**
   * Apply paddle contact, skill effects, and the outgoing velocity.
   *
   * @param {object} room Current room state.
   * @param {number} slot Contacted paddle slot.
   * @param {object} ball Contacted ball.
   * @returns {void}
   */
  function bounceOffPaddle(room, slot, ball) {
    const py = room.paddles[slot];
    const half = paddleHalf(room, slot);
    let rel = clamp((ball.y - py) / half, -1, 1);
    // ★ 弧线球期间，把"被带了一下"的观感做出来：出射角按当前弯曲方向偏一点点，
    //   否则球会被拍子拍直，玩家根本看不出自己刚才吃到的效果还在生效。
    if (room.curveSpin && room.curveUntil > room.serverTime) {
      rel = clamp(rel + room.curveSpin * 0.9, -1, 1);
    }

    // ★★ 蓝（粘球）优先于一切：它把球**粘住**，这一板根本不产生反弹。
    //   放在最前面是为了让"粘住"能压过红/紫——不然先算出射速再被粘住，
    //   那一下的出速就白算了，表现上会出现"球弹出去的瞬间又被拽回来"。
    //   只认真球、只认自己按了技能的那块拍子（和红色蓄力同一个理由）。
    if (!isPhantom(ball) && room.stickArmed[slot]) {
      room.stickArmed[slot] = false;
      ball.stuck = {
        slot,
        until: room.serverTime + STICK_MS,
        // 粘住期间每帧把球摆到这个相对位置（拍子中心再往外一点）
        ox: room.slots[slot].edge === 'left'
          ? PADDLE_W / 2 + BALL_R + 1
          : -(PADDLE_W / 2 + BALL_R + 1),
        oy: clamp(ball.y - py, -half, half),
      };
      ball.vx = 0;
      ball.vy = 0;
      room.lastHitter = slot;
      room.events.push(`h${slot}`);
      return;
    }

    // 红色技能蓄的力只对**真球**生效，而且只认**这块拍子**：
    //   · 幻影球是自己放出去骗人的，撞回自己拍子上还要吃掉一次蓄力 —— 玩家看不见它，
    //     只会觉得"我明明按了红色却什么都没发生"，属于纯闷亏；
    //   · 别人把球打回来不该用掉我的蓄力（这是"我下次击球"的技能）。
    const boosted = !isPhantom(ball) && !!room.boostArmed[slot];
    if (boosted) room.boostArmed[slot] = false;
    const outDir = room.slots[slot].edge === 'left' ? 1 : -1;
    // ★ 紫（乱弹）：10 秒内自己接球不再走常规反弹 —— 角度与速率都随机重掷。
    //   仍然夹 BALL_SPEED_MAX：它是"改变球速的路径"之一，不夹会把球推过反隧穿前提。
    const chaos = !isPhantom(ball) && !boosted && room.chaosUntil[slot] > room.serverTime;
    let speed;
    let angle;
    if (chaos) {
      // 80% 加速（×1.00~1.35）、20% 微减速（×0.85~1.00）—— 期望值是净加速，
      // 但偶尔慢一下让对手也摸不准节奏。需求原话就是"大概率是加速"。
      const fast = Math.random() < 0.8;
      const multiplier = fast ? 1 + Math.random() * 0.35 : 0.85 + Math.random() * 0.15;
      speed = Math.min(Math.hypot(ball.vx, ball.vy) * multiplier, BALL_SPEED_MAX);
      // 方向朝对方、±60°（和黑洞出洞同一套规则）
      angle = (Math.random() * 2 - 1) * (CHAOS_HALF_DEG * Math.PI / 180);
    } else {
      speed = boosted
        ? BOOST_SPEED
        : Math.min(Math.hypot(ball.vx, ball.vy) * SPEEDUP_PER_HIT, BALL_SPEED_MAX);
      angle = rel * MAX_BOUNCE_ANGLE;
    }
    ball.vx = outDir * speed * Math.cos(angle);
    ball.vy = speed * Math.sin(angle);
    // 位置推到拍子外侧，防止下一步又判定为碰撞而卡住
    ball.x = outDir > 0
      ? PADDLE_MARGIN + PADDLE_W + BALL_R + 0.5
      : room.W - PADDLE_MARGIN - PADDLE_W - BALL_R - 0.5;
    room.lastHitter = slot;
    delete room.lastMissApproach[ball.id];
    room.events.push(`h${slot}`);
    if (boosted) room.events.push(`y${slot}`);   // 这一板是超高速，音效要听得出不一样
  }

  /**
   * 弧线球：把速度矢量旋转一个小角度。
   * ★ 用旋转而不是"加一个横向加速度"，是因为旋转是正交变换 ——
   *   速率严格不变，球不会因为拐弯越飞越快、也不会突破 BALL_SPEED_MAX。
   *   用加速度写的话每子步都在累加，几秒后球就快得没法接了。
   * ★ 分裂出来的球同样吃这个旋转（"受有关球的道具影响"）：
   *   两个球同向旋转但因为初始方向不同，会画出两条分开的弧线，观感很好。
   *
   * @param {object} room Current room state.
   * @param {object} ball Ball to rotate.
   * @param {number} dt Simulation substep in seconds.
   * @returns {void}
   */
  function spinBall(room, ball, dt) {
    if (!room.curveSpin || room.curveUntil <= room.serverTime) return;
    const angle = room.curveSpin * dt;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const vx = ball.vx * cosine - ball.vy * sine;
    const vy = ball.vx * sine + ball.vy * cosine;
    ball.vx = vx;
    ball.vy = vy;
  }

  /**
   * Resolve contact against paddles on one side of the court.
   *
   * @param {object} room Current room state.
   * @param {object} ball Ball being checked.
   * @param {string} edge Paddle edge name.
   * @returns {boolean} Whether a paddle was hit.
   */
  function hitEdgePaddles(room, ball, edge) {
    for (let slot = 0; slot < room.N; slot += 1) {
      if (room.slots[slot].edge !== edge) continue;
      if (Math.abs(ball.y - room.paddles[slot]) <= paddleHalf(room, slot) + BALL_R) {
        bounceOffPaddle(room, slot, ball);
        return true;
      }
    }
    return false;
  }

  /**
   * 球与球的碰撞：等质量完全弹性碰撞。
   *
   * 等质量时结论非常干净 —— **交换沿连心线方向的速度分量**，垂直分量不动。
   * 所以不需要动量/能量方程，一行就能写：
   *     v1' = v1 - ((v1-v2)·n) n
   *     v2' = v2 - ((v2-v1)·n) n
   *
   * ★ 只处理"正在靠近"的那一对。这一条不是优化，是**必须的**：
   *   分裂球生成时两个球是同一个位置（距离 0），随后才分开。如果无脑把重叠的
   *   两球推开，刚分裂出来的一对会被立刻弹向奇怪的方向，看起来像分裂失败。
   *   "只在靠近时响应"天然放过了这种"重叠但正在分开"的情况，也正是台球的物理。
   *
   * ★ 碰完必须把基础速度夹回 BALL_SPEED_MAX。斜碰会改变各自的速度大小
   *   （只有正碰才两头都不变），不夹的话会慢慢漂到上限之上 ——
   *   而"子步位移远小于判定窗口"这个反隧穿前提，正是靠这个上限保证的。
   *
   * @param {object} room Current room state.
   * @returns {void}
   */
  function resolveBallCollisions(room) {
    const balls = room.balls;
    const minDist = BALL_R * 2;
    for (let i = 0; i < balls.length; i += 1) {
      for (let j = i + 1; j < balls.length; j += 1) {
        const a = balls[i];
        const b = balls[j];
        // ★ 幻影球和任何球都不碰撞（包括另一个幻影球）—— 需求原话是"撞在一起就穿过去"。
        //   这也是这套假象唯一的破绽，交付说明里如实写了。
        if (isPhantom(a) || isPhantom(b)) continue;
        // ★ 粘住的球也不参与碰撞：它贴在拍子上，别的球撞上来会把它推开。
        if (a.stuck || b.stuck) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minDist * minDist) continue;
        const d = Math.sqrt(d2);
        // 完全重合：连心线没有定义，方向无从谈起 —— 直接放过。
        // 分裂球生成的那一 tick 正好命中这里，等同"分开后再算"，是想要的行为。
        if (d < 1e-6) continue;
        dx /= d;
        dy /= d;
        // 沿连心线的相对速度。> 0 表示正在靠近
        const approach = (a.vx - b.vx) * dx + (a.vy - b.vy) * dy;
        if (approach <= 0) continue;
        a.vx -= approach * dx;
        a.vy -= approach * dy;
        b.vx += approach * dx;
        b.vy += approach * dy;
        for (const q of [a, b]) {
          const sp = Math.hypot(q.vx, q.vy);
          if (sp > BALL_SPEED_MAX) {
            q.vx = (q.vx / sp) * BALL_SPEED_MAX;
            q.vy = (q.vy / sp) * BALL_SPEED_MAX;
          }
        }
        room.events.push('cc');    // 撞球的音效（两种球互撞，和拍子音分开）
      }
    }
  }

  /**
   * 防"竖直卡死"：球的横向速度掉到 0 附近时，给它重新瞄一个方向。
   *
   * ★ 为什么必须防 —— 这不是"节奏不好看"，是**整局死锁**：
   *   球只在上下墙之间竖直弹时，它的 x 永远不变，于是永远碰不到任何拍子，
   *   这一回合永远不会结束（比分不动、也不会重新发球）。
   *   现实中两条来路：
   *     ① **等质量弹性碰撞**。连心线接近竖直时交换的是 vy，而 vx 会被
   *        `a.vx -= approach * dx` 顺手改掉一点（dx 是连心线的横向分量）——
   *        刚好抹平就是 0。更要命的是：**一旦变纯竖直，两个竖直球正碰
   *        只会互换 vy，vx 依然是 0** —— 这个状态是自锁的，不会自己恢复。
   *     ② **分裂球**。源球接近竖直时走"水平轴镜像"分支，新球的
   *        vx = 0.5 × 源球 vx，横向占比与源球完全一样 ⇒ 源球竖直，分出来的也竖直。
   *   （弧线球能把速度矢量旋转到接近竖直，所以这条路不是理论上的。）
   *
   * ★ 只旋转、**不改变速率**：速率大小是"反隧穿"论证的前提（子步位移必须远小于
   *   判定窗口，靠的就是 BALL_SPEED_MAX 这个上限）。在这里给它加速度会把那个
   *   前提弄脏，所以只换方向。重瞄角取 30°~60°：横向推进显著，同时又比纯水平
   *   更快产生上下变化，观感上是"球忽然拐了一下"，不是"球瞬移了"。
   *
   * ★ 判据用"占速率的比例"而不是绝对阈值：速率会一路涨到 900，
   *   固定阈值的含义会随球速漂移，写到后面就形同虚设。
   *
   * @param {object} ball 球
   * @returns {boolean} 真的重瞄了才返回 true（调用方据此统计）
   */
  function unstickBall(ball) {
    // ★ 粘住的球 vx=vy=0，正好命中下面那条"速率兜底"分支 —— 会被重瞄出去，
    //   表现就是"刚粘住就被甩飞"。它本来就该停着，直接跳过。
    if (ball.stuck) return false;
    const sp = Math.hypot(ball.vx, ball.vy);
    // 正常情况：速率有效、横向占比够大 ⇒ 球正在横穿场地，一个字都别动
    if (sp >= 1 && Math.abs(ball.vx) >= sp * MIN_VX_RATIO) return false;

    // 速率兜底：`sp ≈ 0` 的球（现有物理下达不到，因为速率只会变大或保持不变）
    // 一旦出现就是永久停住，所以重瞄后至少得让它能横穿场地。
    // 不做上限裁剪 —— 这里只换方向，速率是多少就还是多少。
    const speed = Math.max(sp, UNSTICK_MIN_SPEED);
    const sign = Math.random() < 0.5 ? -1 : 1;                  // 往左还是往右：随机
    const ang = UNSTICK_ANG_MIN + Math.random() * (UNSTICK_ANG_MAX - UNSTICK_ANG_MIN);
    // 上下倾向沿用原来的（该往上就还往上）；原本正好水平就随机给一个。
    const vsign = ball.vy < 0 ? -1 : (ball.vy > 0 ? 1 : (Math.random() < 0.5 ? -1 : 1));
    ball.vx = sign * speed * Math.cos(ang);
    ball.vy = vsign * speed * Math.sin(ang);
    return true;
  }

  /**
   * 对场上每个球做一次防卡死检查，返回被重瞄的球数。
   * ★ 必须在 resolveBallCollisions **之后**调用：正是那次碰撞可能把球打成竖直，
   *   放在前面等于拿"碰撞前的速度"做判断，刚被打竖直的球要等下一个子步才被救。
   *
   * @param {object} room Current room state.
   * @returns {number} Number of balls re-aimed.
   */
  function unstickBalls(room) {
    let count = 0;
    for (const ball of room.balls) if (unstickBall(ball)) count += 1;
    return count;
  }

  /**
   * Resolve walls, paddle contact, phantom removal, shield, and goal callbacks.
   *
   * @param {object} room Current room state.
   * @param {object} ball Ball to resolve.
   * @returns {void}
   */
  function stepOneBall(room, ball) {
    // ★ 粘住的球不参与任何碰撞与出界判定：它被"挂"在拍子上，
    //   走这段会每子步被自己的拍子弹一次（表现上就是"粘不住，一直弹"）。
    //   它的位置完全由 stepBalls 那段负责。
    if (ball.stuck) return;

    // 上下墙
    if (ball.y - BALL_R < 0) {
      ball.y = BALL_R;
      ball.vy = Math.abs(ball.vy);
    } else if (ball.y + BALL_R > room.H) {
      ball.y = room.H - BALL_R;
      ball.vy = -Math.abs(ball.vy);
    }

    const leftFace = PADDLE_MARGIN + PADDLE_W;
    const rightFace = room.W - PADDLE_MARGIN - PADDLE_W;

    if (ball.vx < 0 && ball.x - BALL_R <= leftFace && ball.x > PADDLE_MARGIN - 30) {
      const hit = hitEdgePaddles(room, ball, 'left');
      if (!hit) recordMissApproach(room, ball, 'left', leftFace);
    } else if (ball.vx > 0 && ball.x + BALL_R >= rightFace
        && ball.x < room.W - PADDLE_MARGIN + 30) {
      const hit = hitEdgePaddles(room, ball, 'right');
      if (!hit) recordMissApproach(room, ball, 'right', rightFace);
    }

    // ★ 幻影球：墙和拍子都照常（不然对手一眼就看出它是穿模的幽灵），
    //   但出界**既不判分也不消耗护盾**（需求原话："不会因为这个球实际得分和失分"）。
    //   直接返回，不往下走那段计分逻辑。
    if (isPhantom(ball)) {
      if (ball.x + BALL_R < 0 || ball.x - BALL_R > room.W) removeBall(room, ball);
      return;
    }

    // 出界：先给护盾一次机会，挡不住才算失分
    if (ball.x + BALL_R < 0) {
      if (!useShield(room, 0, ball)) afterGoal(room, 0, ball);
    } else if (ball.x - BALL_R > room.W) {
      if (!useShield(room, 1, ball)) afterGoal(room, 1, ball);
    }
  }

  /**
   * 把一个球从场上拿走（出界 / 到寿）。**只给幻影球用** —— 真球的移除在 afterGoal 里，
   * 那条路径还要顺带结算比分。
   *
   * ★ 拿走之后必须检查"场上还有没有真球"。漏了这一步会让整局彻底卡死：
   *   真球已经出界、分数也结算过了，而幻影球出界又**不会**触发 afterGoal，
   *   于是没有任何一条路径会去重新发球 —— 比分不动、球也不再出现，这一局就死在那儿了。
   *
   * @param {object} room Current room state.
   * @param {object} ball Phantom ball to remove.
   * @returns {void}
   */
  function removeBall(room, ball) {
    const index = room.balls.indexOf(ball);
    if (index >= 0) room.balls.splice(index, 1);
    if (room.phase !== 'playing') return;
    if (room.balls.some((candidate) => !isPhantom(candidate))) return;
    resetBall(room, room.serveTo);
  }

  /**
   * 黑（黑洞）：球碰到自己开的洞就"穿"到对面靠中间的半区随机位置。
   *
   * ★ 三条要点：
   *   ① 只认**自己开的洞**对**所有球**生效 —— 洞是场地的一部分，不是谁的私产。
   *      但出口位置由**开洞方的队伍**决定（洞在左就在右边出），所以这里读 h.team。
   *   ② 速率严格保持（需求原话"速率和进入黑洞时相同"）：只重掷方向，不乘任何系数。
   *      也因此**不需要**再夹 BALL_SPEED_MAX —— 进来的速率本来就已经被夹过了。
   *   ③ 出洞方向是"朝对方"、±HOLE_HALF_DEG。以左队开洞为例：球从 x∈[0.25W,0.5W]
   *      的洞里进去，从 x∈[0.5W,0.75W] 出来，方向以**正右**为 0°、上下随机 ±60°。
   *
   * ★ 洞用完就消：一个洞只送走一个球。不然球会反复被同一个洞抛来抛去。
   *
   * @param {object} room Current room state.
   * @param {object} ball Ball to test.
   * @returns {boolean} Whether a black hole transported the ball.
   */
  function checkBlackhole(room, ball) {
    if (!room.holes.length) return false;
    const now = room.serverTime;
    for (let i = 0; i < room.holes.length; i += 1) {
      const h = room.holes[i];
      if (h.until <= now) continue;
      const dx = ball.x - h.x;
      const dy = ball.y - h.y;
      if (dx * dx + dy * dy > HOLE_R * HOLE_R) continue;

      const speed = Math.hypot(ball.vx, ball.vy);
      // 速率兜底：极低速的球（理论到不了）也给一个能飞出去的值，免得出洞就卡住
      const sp = Math.max(speed, UNSTICK_MIN_SPEED);
      // 出口：洞在**己方靠中半区**，出口在**对方靠中半区** —— 左右镜像。
      const left = room.slots.find((s) => s.team === h.team);
      const holeOnLeft = left ? left.edge === 'left' : true;
      const x0 = holeOnLeft ? room.W * 0.50 : room.W * 0.25;
      const x1 = holeOnLeft ? room.W * 0.75 : room.W * 0.50;
      const pad = BALL_R + 4;
      const yLo = pad;
      const yHi = room.H - pad;
      ball.x = x0 + Math.random() * (x1 - x0);
      ball.y = yLo + Math.random() * Math.max(1, yHi - yLo);
      // 方向：朝对方（洞在左 → 向右），±60°
      const outDir = holeOnLeft ? 1 : -1;
      const ang = (Math.random() * 2 - 1) * (HOLE_HALF_DEG * Math.PI / 180);
      ball.vx = outDir * sp * Math.cos(ang);
      ball.vy = sp * Math.sin(ang);
      // 洞用完即消 —— 否则同一个洞会把球反复吞吐
      room.holes.splice(i, 1);
      room.events.push(`w${h.team}`);   // 黑洞音效
      return true;
    }
    return false;
  }

  /**
   * 推进场上**所有**球。
   * 顺序：先全部旋转+位移，再两两解球球碰撞，最后逐球做墙/拍子/出界。
   * ★ 碰撞必须放在全部位移之后：否则先动的球会拿"别人的旧位置"去判定，
   *   两个球会像穿过去一样互相漏掉。
   *
   * @param {object} room Current room state.
   * @param {number} dt Simulation substep in seconds.
   * @returns {void}
   */
  function stepBalls(room, dt) {
    const mul = room.ballMul;
    const winds = room.winds;
    for (const b of room.balls) {
      // ★★ 蓝（粘球）：先处理粘住的球，它走**完全不同**的一条路 ——
      //   不施力、不旋转、不位移，只是被"挂"在自己拍子上。
      //   放在最前面是为了让下面那些"施力 / 夹速率"的代码一行都不碰它：
      //   给它加风、或者让它按自己的速度动，都会让"粘住"当场失效。
      if (b.stuck) {
        if (room.serverTime >= b.stuck.until) {
          // 到点：朝正前方（自己这一侧的水平方向）以普通发球初速放出去。
          // ★ 方向是**水平**，不是"朝球场中心" —— 需求原话是"向正前方释放"。
          const sd = room.slots[b.stuck.slot];
          const outDir = sd && sd.edge === 'left' ? 1 : -1;
          b.stuck = null;
          b.vx = outDir * BALL_SPEED_START;
          b.vy = 0;
          b.x = outDir > 0
            ? PADDLE_MARGIN + PADDLE_W + BALL_R + 0.5
            : room.W - PADDLE_MARGIN - PADDLE_W - BALL_R - 0.5;
          room.events.push('hS');   // 释放音效，和普通击球区分开
        } else {
          // 粘住中：位置跟着拍子走（拍子动了球也跟着，这才是"粘"）
          const sl = room.slots[b.stuck.slot];
          const px = sl.edge === 'left'
            ? PADDLE_MARGIN + PADDLE_W / 2
            : room.W - PADDLE_MARGIN - PADDLE_W / 2;
          b.x = px + b.stuck.ox;
          b.y = room.paddles[b.stuck.slot] + b.stuck.oy;
          b.vx = 0;
          b.vy = 0;
          continue;
        }
      }
      spinBall(room, b, dt);        // 弧线球：先转向，再按新方向前进
      // 风：给球加一个沿风向的加速度。顺风的球被推快、逆风的被拽慢、横穿的被推偏、
      //   本来就慢的球会被吹得直接转向 —— 四种表现都是这一个式子的结果（见 WIND_ACC）。
      for (let i = 0; i < winds.length; i += 1) {
        b.vx += winds[i].dx * WIND_ACC * dt;
        b.vy += winds[i].dy * WIND_ACC * dt;
      }
      // ★ 加完风必须把速率夹回上限：风是**唯一**能把球推过 BALL_SPEED_MAX 的路径，
      //   而"子步位移远小于判定窗口"这个反隧穿前提正是靠这个上限保证的。
      //   夹的是**速率**不是分量 —— 分量各夹各的会把方向掰弯，球会莫名其妙拐一下。
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > BALL_SPEED_MAX) {
        b.vx = (b.vx / sp) * BALL_SPEED_MAX;
        b.vy = (b.vy / sp) * BALL_SPEED_MAX;
      }
      b.x += b.vx * mul * dt;
      b.y += b.vy * mul * dt;
      // ★ 黑（黑洞）：只认真球，判定放在位移之后（这样"这一子步里穿过洞"也能抓到）。
      if (!isPhantom(b)) checkBlackhole(room, b);
    }

    resolveBallCollisions(room);
    // ★ 紧跟碰撞之后：碰撞本身就能把球打成"纯竖直"（见 unstickBall），
    //   不在这里救，球就会永远在上下墙之间竖弹、这一回合永远结束不了。
    unstickBalls(room);
    // 复制一份再遍历：出界的球会在 afterGoal 里被移出 room.balls，
    // 直接遍历原数组会因为下标前移而漏掉后面的球。
    for (const b of room.balls.slice()) {
      if (room.phase !== 'playing') break;   // 期间可能因分出胜负/重发球切了阶段
      // 幻影球到寿：悄悄消失，不算分（对手只会看到"球没了"）。
      if (isPhantom(b) && b.phantomUntil && room.serverTime >= b.phantomUntil) {
        removeBall(room, b);
        continue;
      }
      stepOneBall(room, b);
    }
  }

  /**
   * 护盾：球马上要出界时消耗一层，把球弹回场内。
   * 参数是**队伍**号 —— coop 里护盾属于左边这一整队，两个人共享。
   * 返回 true 表示这次被挡下了，调用方不该再判失分。
   *
   * @param {object} room Current room state.
   * @param {number} side Team whose shield is consumed.
   * @param {object} [ball] Ball being saved; defaults to the first room ball.
   * @returns {boolean} Whether a shield blocked the goal.
   */
  function useShield(room, side, ball) {
    if (room.shield[side] <= 0) return false;
    const b = ball || room.balls[0];
    if (!b) return false;
    room.shield[side] -= 1;

    // 推回场内并反向。稍微提一点速，否则低速救球会贴着底线反复来回
    b.x = side === 0 ? BALL_R + 2 : room.W - BALL_R - 2;
    const speed = Math.min(Math.hypot(b.vx, b.vy) * 1.04, BALL_SPEED_MAX);
    const angle = (Math.random() * 2 - 1) * MAX_BOUNCE_ANGLE * 0.6;
    b.vx = (side === 0 ? 1 : -1) * speed * Math.cos(angle);
    b.vy = speed * Math.sin(angle);
    // 救球的人算最后击球方，撞到道具归他那一队
    const own = room.slots.findIndex((s) => s.team === side);
    room.lastHitter = own < 0 ? 0 : own;
    room.events.push(`k${side}`);
    return true;
  }

  return {
    makeBall,
    splitBall,
    resetBall,
    launchBall,
    bounceOffPaddle,
    spinBall,
    hitEdgePaddles,
    resolveBallCollisions,
    unstickBall,
    unstickBalls,
    stepOneBall,
    removeBall,
    checkBlackhole,
    stepBalls,
    useShield,
  };
}

module.exports = { createPhysics };
