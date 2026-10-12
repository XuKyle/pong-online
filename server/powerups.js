'use strict';

/**
 * Power-up lifecycle: spawn, pickup, effect application, and per-match reset.
 *
 * "什么时候过期"与"暂停怎么冻结"由 server/effects.js 独占，本模块只负责
 * "怎么产生效果"。分裂球交给 server/physics.js，护盾消耗在物理里结算。
 *
 * @module server/powerups
 */

/**
 * Create the power-up behavior functions with explicit dependencies.
 *
 * @param {object} deps Power-up constants, the spawn-type picker, and the ball splitter.
 * @returns {object} Power-up spawn, pickup, effect, and reset API.
 */
function createPowerupBehavior(deps) {
  const {
    POWERUP_MOD_MS,
    POWERUP_MAX,
    POWERUP_R,
    pickType,
    PU_FIRST_MS,
    PU_GAP_MS,
    PU_LIFE_MS,
    BALL_R,
    MAX_BALLS,
    BALL_FAST,
    FREEZE_MS,
    SHIELD_MAX,
    CURVE_MS,
    CURVE_SPIN,
    INVIS_MS,
    INVIS_FADE_MS,
    PADDLE_GROW,
    PADDLE_SHRINK,
    clamp,
    splitBall,
  } = deps;

  /**
   * 每局开始 / 结束时把道具侧状态清干净。
   *
   * ★ 黑洞、道具封锁、减速也在这里清 —— 它们的效果由技能产生，但同样属于"这一局"。
   *   技能侧（clearSkills）也清了一遍：两边都清是有意的，谁先调用都不会漏掉。
   *
   * @param {object} room Current room state.
   * @returns {void}
   */
  function clearPowerups(room) {
    room.powerups = [];
    room.nextPowerupAt = Date.now() + PU_FIRST_MS;
    room.paddleMul = [1, 1];
    room.growUntil = [0, 0];
    room.shrinkUntil = [0, 0];
    room.ballMul = 1;
    room.ballUntil = 0;
    room.freezeUntil = [0, 0];
    room.doubleUntil = [0, 0];
    room.invisUntil = [0, 0];
    room.shield = [0, 0];
    room.curveUntil = 0;
    room.curveSpin = 0;
    room.lastHitter = -1;
    room.holes = [];
    room.blockCharges = [0, 0];
    room.slowUntil = [0, 0];
    // 局间"可以重新选拍子"的窗口：本局进过 over 并翻到下一局时打开，
    //   球真的发出去时关上（见 broadcastState 开头与 pickSkin）。
    room.reselectPending = false;
  }

  /**
   * 由两个计时器**算出**拍子倍率。抽成独立函数是为了让 applyPowerup 之后
   * 立刻就能拿到正确的倍率 —— 否则会有一 tick 的窗口里"效果生效了但拍子还是旧长度"，
   * 而客户端画拍子用的就是这个值，看起来就是"吃了加长但拍子没变长"。
   *
   * @param {object} room Current room state.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {void}
   */
  function refreshPaddleMul(room, now) {
    for (let i = 0; i < 2; i += 1) {
      const grow = room.growUntil[i] > now;
      const shrink = room.shrinkUntil[i] > now;
      if (!grow) room.growUntil[i] = 0;
      if (!shrink) room.shrinkUntil[i] = 0;
      // ★ 两个效果同时生效时**相乘**（1.65 × 0.62 ≈ 1.02），即"一加一减正好抵消"。
      //   注意不能写成 Math.min（谁更极端谁赢）：那样一次削短会把正在生效的加长
      //   一起抹掉，而且削短到期时还会把加长的剩余时间也清了 —— 纯闷亏。
      room.paddleMul[i] = (grow ? PADDLE_GROW : 1) * (shrink ? PADDLE_SHRINK : 1);
    }
  }

  /**
   * 应用一个道具。who / foe 都是**队伍**号 —— coop 里左边两个拍子属于同一队，
   * 所以"加长自己的拍子"会同时加长它的上半场和下半场两个拍子，这正是想要的效果。
   *
   * @param {object} room Current room state.
   * @param {number} who Team picking up the power-up.
   * @param {number} type Power-up index.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {void}
   */
  function applyPowerup(room, who, type, now) {
    const foe = 1 - who;
    if (type === 0) {
      room.growUntil[who] = now + POWERUP_MOD_MS;     // 自己的拍子变长（只动自己的计时器）
    } else if (type === 1) {
      room.shrinkUntil[foe] = now + POWERUP_MOD_MS;   // 对方拍子变短（只动对方的计时器）
    } else if (type === 2) {
      room.ballMul = BALL_FAST;                        // 球加速
      room.ballUntil = now + POWERUP_MOD_MS;
    } else if (type === 3) {
      // 冰冻：直接覆盖，不叠加时长（叠加会变成连续冻结，等于剥夺对方整队）
      room.freezeUntil[foe] = Math.max(room.freezeUntil[foe], now + FREEZE_MS);
    } else if (type === 4) {
      room.shield[who] = Math.min(SHIELD_MAX, room.shield[who] + 1);        // 护盾 +1 层
    } else if (type === 5) {
      room.doubleUntil[who] = now + POWERUP_MOD_MS;    // 接下来 8 秒自己进球算两分
    } else if (type === 6) {
      // 弧线球：拐弯方向在吃到的那一瞬间就定下来，一整段持续同一个方向。
      // 若每 tick 重掷方向，球会在空中左右乱抖，看着像掉帧而不是"飘"。
      room.curveUntil = now + CURVE_MS;
      room.curveSpin = Math.random() < 0.5 ? -CURVE_SPIN : CURVE_SPIN;
    } else if (type === 7) {
      splitBall(room);
    } else if (type === 8) {
      // 隐形球：**对方**被隐形，自己照常看得见。
      // 用 Math.max 而不是直接覆盖：万一对方也刚吃到、正被隐形着，
      // 不该被这一下"缩短"（道具只该让人更难受，不该替对方解围）。
      room.invisUntil[foe] = Math.max(room.invisUntil[foe], now + INVIS_MS);
    }
    // 加长/削短是"算出来的"，这里立刻重算一次，别让倍率落后一 tick
    refreshPaddleMul(room, now);
  }

  /**
   * 某一队**当前看到的球**有多不透明（1 = 完全看得见，0 = 完全看不见）。
   *
   * ★ 透明度在服务端算好再下发，而不是把时长发给客户端让它自己算。
   *   这条曲线有三个阶段（淡出 / 全隐 / 淡入），客户端再实现一遍就等于同一套数学
   *   写了两份，任何一边改了另一边的表现就会静默错位 —— 而错位恰好表现为
   *   "渐变没了、变成硬切"，正是这次要避免的东西。
   *
   *   曲线（elapsed = 已过去多久，remain = 还剩多久）：
   *     elapsed < FADE  → 1 - elapsed/FADE   （淡出：1 → 0）
   *     remain  < FADE  → 1 - remain/FADE    （淡入：0 → 1）
   *     中间            → 0                  （完全看不见）
   *   两头都留渐变、中间真的落到 0 —— 要的是"看不到"，不是"稍微变淡"。
   *   ★ 淡入那一段必须是 1 - remain/FADE。写成 remain/FADE 的话，
   *     曲线会变成 0 → 1 → 一路降回 0 → 最后一刻又跳回 1 来回抖，
   *     表面上"有透明度变化"，实际看是球闪了一下才回来。
   *
   * @param {object} room Current room state.
   * @param {number} team Team whose visibility is being sampled.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {number} Opacity between 0 and 1.
   */
  function invisAlpha(room, team, now) {
    const until = room.invisUntil[team];
    if (!until || now >= until) return 1;
    const remain = until - now;
    const elapsed = INVIS_MS - remain;
    if (elapsed < INVIS_FADE_MS) return clamp(1 - elapsed / INVIS_FADE_MS, 0, 1);
    if (remain < INVIS_FADE_MS) return clamp(1 - remain / INVIS_FADE_MS, 0, 1);
    return 0;
  }

  /**
   * 生成一个道具。
   * 位置落在中段区域：太靠边等于白送，太靠中间又会被乱球轻易蹭到。
   * ★ 多个并存时必须**互相错开**，否则两个圈会叠在一起，视觉上分不清是一个还是两个，
   *   而且球一穿过去会连着吃掉两个（观感上像是"一个道具给了两份效果"）。
   *
   * @param {object} room Current room state.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {{x: number, y: number, type: number, bornAt: number}} New power-up.
   */
  function spawnPowerup(room, now) {
    // ★ 场上球已经到上限时，不再生成分裂球 ——
    //   否则只能眼睁睁看着一个吃不到的分裂球在那儿转，吃了还什么都没发生。
    const atBallCap = room.balls.length >= MAX_BALLS;
    let type = deps.pickType(atBallCap);
    if (type === 7 && atBallCap) type = 0;
    const minGap = POWERUP_R * 2 + 34;
    let x = room.W * 0.26 + Math.random() * room.W * 0.48;
    let y = 70 + Math.random() * (room.H - 140);
    for (let tries = 0; tries < 20; tries += 1) {
      const tooClose = room.powerups.some((u) => Math.hypot(u.x - x, u.y - y) < minGap);
      if (!tooClose) break;
      x = room.W * 0.26 + Math.random() * room.W * 0.48;
      y = 70 + Math.random() * (room.H - 140);
    }
    return { x, y, type, bornAt: now };
  }

  /**
   * 道具的生成 / 过期 / 被球碰到。只在 playing 阶段调用。
   *
   * 场上道具是**数组**，可以同时存在最多 POWERUP_MAX 个：
   *   · 生成 —— 到点就补，不看场上还剩几个（这样节奏才是稳定的，而不是
   *     "捡完才排下一个"那种由玩家行为决定的忽快忽慢）；
   *   · 过期 —— 一次把所有到寿的都清掉，不是只清第一个；
   *   · 拾取 —— 每 tick 只吃**最近**的一个。两个圈偶尔重叠时按数组顺序吃会让人
   *     分不清自己吃的到底是哪个，按距离取最近才符合直觉。
   *
   * @param {object} room Current room state.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {void}
   */
  function stepPowerup(room, now) {
    // 生成
    if (now >= room.nextPowerupAt) {
      room.nextPowerupAt = now + PU_GAP_MS;
      if (room.powerups.length < POWERUP_MAX) room.powerups.push(spawnPowerup(room, now));
    }

    // 过期
    if (room.powerups.length) {
      const alive = room.powerups.filter((u) => now - u.bornAt <= PU_LIFE_MS);
      if (alive.length !== room.powerups.length) room.powerups = alive;
    }

    // 拾取：逐个球去找它够得着、且还没被吃掉的最近的那一个。
    // ★ 必须逐个球遍历：多球时"某个球碰到了道具"和"另一个球碰到了另一个道具"
    //   是完全可能同时发生的，只看 0 号球会漏掉后面那些球的碰撞。
    const reach = BALL_R + POWERUP_R;
    const eaten = [];
    for (const ball of room.balls) {
      let best = -1;
      let bestD2 = Infinity;
      for (let i = 0; i < room.powerups.length; i += 1) {
        if (eaten.indexOf(i) >= 0) continue;
        const u = room.powerups[i];
        const dx = ball.x - u.x;
        const dy = ball.y - u.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= reach * reach && d2 < bestD2) { bestD2 = d2; best = i; }
      }
      if (best < 0) continue;
      eaten.push(best);
      const u = room.powerups[best];
      // 归属规则：谁最后把球打出去，这个道具就算哪一队的。直觉上最好理解。
      // ★ lastHitter 是**槽位**，要折算成队伍 —— coop 里左边两个拍子都属于 0 队。
      const lh = room.lastHitter;
      const who = lh >= 0 && lh < room.N ? room.slots[lh].team : 0;
      // ★ 白（道具封锁）：**被封锁方**吃到的道具直接作废，并且消耗掉一层封锁。
      //   这一步必须挡在 applyPowerup 之前 —— 放在里面就晚了（效果已经生效）。
      //   事件也换成"被封锁"那一款，否则玩家会看到"我明明吃到了却什么都没发生"
      //   而对面则完全不知道自己的技能起效了。
      if (room.blockCharges[who] > 0) {
        room.blockCharges[who] -= 1;
        room.events.push(`b${who}${u.type}`);   // b + 队伍 + 道具类型：前端放"被封"的音效
      } else {
        applyPowerup(room, who, u.type, now);
        room.events.push(`u${who}${u.type}`);
      }
    }
    if (eaten.length) {
      // 从后往前删，避免下标前移漏删
      eaten.sort((a, b) => b - a).forEach((i) => room.powerups.splice(i, 1));
    }
  }

  return {
    clearPowerups,
    refreshPaddleMul,
    applyPowerup,
    invisAlpha,
    spawnPowerup,
    stepPowerup,
  };
}

module.exports = { createPowerupBehavior };