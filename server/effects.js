'use strict';

/**
 * Shared effect clock: expiry sweep and pause-freeze bookkeeping.
 *
 * 道具（powerups.js）与技能（skills.js）各自负责"怎么产生效果"，但**什么时候过期**、
 * **暂停期间怎么冻结**只有一份实现，就放在这里。两边都不自己算时钟，
 * 所以不会出现"道具冻住了、技能没冻住"这类半吊子状态。
 *
 * @module server/effects
 */

/**
 * Create the shared effect clock.
 *
 * @param {object} deps Room helper needed to recompute derived paddle multipliers.
 * @returns {{trackMods: function(object, number): void, shiftDeadlines: function(object, number): void, togglePause: function(object, number): boolean}} Effect clock API.
 */
function createEffectClock(deps) {
  const { refreshPaddleMul } = deps;

  /**
   * 效果到期复位。必须每 tick 调，否则道具会永久生效。
   *
   * 道具侧的计时器（加长 / 削短 / 加速 / 冰冻 / 双倍 / 隐形 / 弧线）与
   * 技能侧的存活对象（风、黑洞、减速）都在这一趟里清 —— 分成两处写的话，
   * 迟早会漏掉一个，而漏掉的后果不是"效果多留一会儿"：`stepBalls` 是**无条件**
   * 遍历 `room.winds` / `room.holes` 施力与判定的，只 push 不删会让场上越积越多，
   * 而且完全看不出是哪一次技能造成的。
   *
   * @param {object} room Current room state.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {void}
   */
  function trackMods(room, now) {
    refreshPaddleMul(room, now);
    for (let i = 0; i < 2; i += 1) {
      if (room.freezeUntil[i] && now >= room.freezeUntil[i]) room.freezeUntil[i] = 0;
      if (room.doubleUntil[i] && now >= room.doubleUntil[i]) room.doubleUntil[i] = 0;
      if (room.invisUntil[i] && now >= room.invisUntil[i]) room.invisUntil[i] = 0;
    }
    if (room.ballUntil && now >= room.ballUntil) {
      room.ballMul = 1;
      room.ballUntil = 0;
    }
    if (room.curveUntil && now >= room.curveUntil) {
      room.curveUntil = 0;
      room.curveSpin = 0;
    }
    // ★ 风也必须在这里到期清掉。少了这一句的后果**不是"风多吹一会儿"**：
    //   stepBalls 是无条件遍历 room.winds 施力的，而 castWind 只往数组里 push、
    //   从不删除 —— 于是每放一次风就永久多一股力，十分钟后场上的球会被一股
    //   越积越大的合力直接甩出球场，而且完全看不出是哪一次技能造成的。
    if (room.winds.length) {
      const alive = room.winds.filter((w) => w.until > now);
      if (alive.length !== room.winds.length) room.winds = alive;
    }
    // ★ 黑洞与减速也在这里到期清掉。和风同一个坑：`stepBalls` 是无条件遍历
    //   `room.holes` 做判定的，只 push 不删的话场上会越积越多洞，
    //   球一进场就会被一个"早就该消失的洞"吞掉，而且看不出是谁的技能造成的。
    if (room.holes.length) {
      const aliveH = room.holes.filter((h) => h.until > now);
      if (aliveH.length !== room.holes.length) room.holes = aliveH;
    }
    for (let i = 0; i < 2; i += 1) {
      if (room.slowUntil[i] && now >= room.slowUntil[i]) room.slowUntil[i] = 0;
    }
  }

  /**
   * 把房间内所有"挂钟型"的截止时刻整体往后推 ms。
   *
   * ★ 为什么必须有这个函数：这些时间戳全是**绝对**的 Date.now()，而暂停期间挂钟照走。
   *   不推的话，"暂停两分钟"实际等于"所有效果都过期了"：
   *     · 吃到加长 / 双倍得分的人回来发现效果没了（白吃亏）；
   *     · 被冰冻的一方倒是自动解冻了（明明是别人吃到的东西替他解了围）；
   *     · 场上道具全部到寿消失，恢复后还得再等好几秒才刷出来。
   *   暂停的语义是"把**比赛时间**冻住"，所以这些截止时刻必须跟着一起冻。
   *
   * ★ 阶段截止时间 phaseEndsAt 在 countdown 阶段**不在本函数的职责内** ——
   *   stepRoom 在冻结期间每 tick 都会把它重设成"当前 + 倒计时长度"，恢复时又重设一次。
   *   所以这里只管 'over' 那个（冻结期间没人会去碰它，不后移的话解冻那一瞬间就直接开下一局）。
   *   'playing' 阶段这个字段当时用不到。
   *   ★ 实测确认过：把它改成"无条件后移"也不会出错 —— 因为把截止时刻后移"已经过去的那段
   *     时间"在定义上就等于"这段时间没走过"，是自纠正的。写成分情况只为让"谁负责它"有唯一答案。
   *
   * @param {object} room Current room state.
   * @param {number} ms Milliseconds of frozen match time to shift deadlines by.
   * @returns {void}
   */
  function shiftDeadlines(room, ms) {
    if (!(ms > 0)) return;
    const bump = (t) => (t > 0 ? t + ms : 0);
    if (room.phase === 'over') room.phaseEndsAt = bump(room.phaseEndsAt);
    room.nextPowerupAt = bump(room.nextPowerupAt);
    for (const u of room.powerups) u.bornAt += ms;
    for (let i = 0; i < 2; i += 1) {
      room.growUntil[i] = bump(room.growUntil[i]);
      room.shrinkUntil[i] = bump(room.shrinkUntil[i]);
      room.freezeUntil[i] = bump(room.freezeUntil[i]);
      room.doubleUntil[i] = bump(room.doubleUntil[i]);
      room.invisUntil[i] = bump(room.invisUntil[i]);
    }
    room.ballUntil = bump(room.ballUntil);
    room.curveUntil = bump(room.curveUntil);
    // 技能：冷却 / 在刮的风 / 幻影球的剩余时间，全都属于"比赛时间"，一样要冻住。
    // 不冻的话，"暂停十秒"= 免费跳过十秒冷却 —— 谁先按暂停谁先转好技能。
    for (let i = 0; i < room.N; i += 1) room.skillReadyAt[i] = bump(room.skillReadyAt[i]);
    for (let i = 0; i < room.N; i += 1) room.chaosUntil[i] = bump(room.chaosUntil[i]);
    for (const w of room.winds) w.until += ms;
    for (const h of room.holes) h.until += ms;
    for (let i = 0; i < 2; i += 1) room.slowUntil[i] = bump(room.slowUntil[i]);
    for (const b of room.balls) {
      if (b.phantomUntil) b.phantomUntil += ms;
      // ★ 粘住的球也要一起后移：它就是"比赛时间还没走"的那一秒，
      //   不后移的话暂停两秒回来球就自己飞走了 —— 而玩家全程没看见它动。
      if (b.stuck) b.stuck.until += ms;
    }
  }

  /**
   * 切换暂停。**任意一方按下都直接生效** —— 这不是投票，谁按谁说了算：
   * 两个人都能暂停，也都能恢复（对手暂停了你随时能按回去）。
   *
   * 这里只做状态与事件，不碰任何计时器 —— 冻结的进入 / 退出统一由 stepRoom 处理
   * （那样"缺人自动冻结"和"玩家主动暂停"走的是同一条路径，不会有一套被漏掉）。
   *
   * @param {object} room Current room state.
   * @param {number} slot 按下的槽位（只用于显示"是谁按的"）
   * @returns {boolean} 切换之后是否处于暂停
   */
  function togglePause(room, slot) {
    room.userPaused = !room.userPaused;
    room.pausedBy = room.userPaused ? slot : -1;
    // 两端都该听到"有人按了暂停" —— 不然对面会以为是自己卡了
    room.events.push(room.userPaused ? 'pp' : 'pr');
    return room.userPaused;
  }

  return { trackMods, shiftDeadlines, togglePause };
}

module.exports = { createEffectClock };