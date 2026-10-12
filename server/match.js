'use strict';

/**
 * Match and room lifecycle: room creation, seating, match start/reset,
 * scoring, and the per-tick phase state machine.
 *
 * 这个模块拿不到 socket、也不发任何包：传输层把连接交给它（ws 记录进玩家身上），
 * 需要回话时通过 `joinedPayload` / `rejoinedPayload` 显式拿回执，由连接管理去发。
 * 反过来，本模块也不认识 HTTP / WebSocket —— 上面那个薄薄的一层负责桥接。
 *
 * 时钟语义（到���复位、暂停冻结）不在这里，而在 server/effects.js。
 *
 * @module server/match
 */

/**
 * Create the room and match lifecycle functions with explicit dependencies.
 *
 * @param {object} deps Match constants, room helpers, and simulation entry points.
 * @returns {object} Room lifecycle and match state-machine API.
 */
function createMatchLifecycle(deps) {
  const {
    COURT,
    BOT_PRESETS,
    BOT_SLOT,
    COOP_BOT_SPEED_MUL,
    COOP_BALL_SPEED,
    BALL_SPEED_START,
    PU_FIRST_MS,
    SKIN_GRAY,
    SLOT_GRACE_MS,
    OVER_HOLD_MS,
    COUNTDOWN_MS,
    SUBSTEPS,
    SUB_DT,
    CURVE_SPIN,
    clamp,
    isBot,
    isLive,
    isPresent,
    isPhantom,
    isWin,
    normMode,
    buildSlots,
    normSkin,
    makeBot,
    makeBall,
    r1,
    clearPowerups,
    clearSkills,
    resetBall,
    launchBall,
    shiftDeadlines,
    trackMods,
    stepPaddles,
    stepBalls,
    stepPowerup,
    applyPowerup,
    debugShowcaseFx,
    DEBUG_FX,
    DEBUG_CURVE,
    wsPlayer,
  } = deps;

  /**
   * 造一个新房间，并把 AI 放进它该坐的槽位。
   * 它没有 ws，其余流程与真人玩家完全一致。
   *
   * @param {string} code Room code.
   * @param {string} mode Requested mode; normalized here.
   * @param {number} level Requested AI difficulty index.
   * @returns {object} Fresh room state.
   */
  function createRoom(code, mode, level) {
    const md = normMode(mode);
    const court = COURT[md];
    const slots = buildSlots(md, court.H);
    const midOf = (s) => (s.span[0] + s.span[1]) / 2;
    const room = {
      code,
      mode: md,
      solo: md !== 'duel',      // 对手是不是 AI（外广播字段，历史探针在读）
      coop: md === 'coop',
      botLevel: md === 'duel' ? -1 : clamp(Number(level) || 0, 0, BOT_PRESETS.length - 1),
      // ---- 场地与拍子布局（按房间，不再是全局常量）----
      W: court.W,
      H: court.H,
      slots,                    // [{ edge, team, span }]
      N: slots.length,          // 拍子槽位数：经典 2，coop 3
      players: new Array(slots.length).fill(null),
      paddles: slots.map(midOf),
      ballSpeed0: md === 'coop' ? COOP_BALL_SPEED : BALL_SPEED_START,
      // ★ 球是**数组**（分裂球会让场上同时存在多个球）。
      //   每个球带一个稳定 id：客户端靠它把"上一帧的球"和"这一帧的球"对上号。
      //   没有 id 时，一旦某个球出界被移出数组，后面所有球的位置都会整体错位，
      //   客户端会把剩下的球从旧位置平滑地"滑"到新位置 —— 看起来像球在瞬移。
      balls: [makeBall(court.W / 2, court.H / 2)],
      score: [0, 0],
      matchNo: 0,
      matchId: '',
      missLog: [],
      lastMissApproach: Object.create(null),
      substep: -1,
      phase: 'countdown', // countdown | playing | over（对外的 waiting 由 paused/started 推导）
      phaseEndsAt: 0,
      serveTo: 0,       // 下一次发球朝向哪一队（0 = 发给左队）
      tick: 0,
      winner: -1,
      started: false,   // 是否已经开过第一局；决定要不要初始化比分
      paused: true,     // 缺人时冻结比赛，但不作废比分
      // ★ 真人主动暂停（**任意一方按下即生效**，见 togglePause）。它与上面的 `paused`
      //   刻意分成两个字段，因为语义完全不同：`paused` 是"缺人"的自动结果，
      //   这个只由玩家按下产生。合成一个字段会立刻带来两个真问题：
      //     ① 广播里的 ph 会变成 waiting，而客户端在 waiting 下**根本不画球** ——
      //        一按暂停球就从画面上消失，看着像球被吞了；
      //     ② "等对手回来"和"有人按了暂停"要给的提示语完全不一样。
      userPaused: false,
      pausedBy: -1,     // 是谁按的（**槽位号**，-1 = 当前没暂停）
      frozenAt: 0,      // 上一次"冻结推进"的时刻（0 = 没在冻结）—— 见 stepRoom 里那句后移
      // ---- 道具与临时效果 ----
      powerups: [],                         // 场上道具 [{ x, y, type, bornAt }] —— 可以同时有多个
      nextPowerupAt: Date.now() + PU_FIRST_MS,
      lastHitter: -1,                       // 最后击球的**槽位**，决定球撞到的道具归哪一队
      // 拍子长度倍率按**队**算，但它是由下面两个计时器**算出来**的，不是直接写的。
      // ★ 拆成两个计时器是"多个效果能共存"的核心：加长和削短必须各自计时。
      //   合用一个计时器时，对方在你加长中途削你一下，削短到期会把倍率复位成 1 ——
      //   你那 8 秒的加长被顺带清掉，而且界面上没有任何提示，属于纯闷亏。
      paddleMul: [1, 1],
      growUntil: [0, 0],                    // "加长自己"到期时间（按队）
      shrinkUntil: [0, 0],                  // "削短对方"到期时间（按队）
      ballMul: 1,                           // 球速倍率：只缩放位移、不动 vx/vy，避免反复乘除漂移
      ballUntil: 0,
      freezeUntil: [0, 0],                  // 某队的拍子被冰冻到什么时候
      doubleUntil: [0, 0],                  // 某队双倍得分到什么时候
      // 某队的球被隐形到什么时候（**被隐形方**存这里：0 队吃了就写 1 队）。
      // 按**队**而不是按球：隐形是"看不见场上所有球"，不是"某一个球隐形了"。
      invisUntil: [0, 0],
      shield: [0, 0],                       // 护盾剩余层数（不是时间制，是次数制）
      curveUntil: 0,                        // 弧线球效果到期时间
      curveSpin: 0,                         // 弧线角速度（rad/s，带符号 = 拐弯方向）
      // ---- 皮肤与技能 ----
      // ★ 全部按**槽位**存，不按队伍：coop 里左边两个人是同队，但各有各的技能和冷却。
      //   这也是它们不能并进 applyPowerup 那套"按队生效"的数组里的原因。
      skins: slots.map(() => SKIN_GRAY),    // 每个槽位选的皮肤（0 = 灰，没技能）
      skillReadyAt: slots.map(() => 0),     // 冷却到期时刻（0 = 随时可放）
      boostArmed: slots.map(() => false),   // 红色：已经蓄好力、等下一次击球
      winds: [],                            // 正在刮的风 [{ dx, dy, until, seed }] —— 可以同时有多股
      // ★ 蓝（粘球）：**按槽位**武装，和其他"下一次击球"类技能一个套路。
      //   存布尔而不是时间戳：它表示"已经按下技能，等着粘下一板"，
      //   真正计时的是球被粘住那一刻（b.stuck.until）。
      stickArmed: slots.map(() => false),
      // ★ 紫（乱弹）：按**槽位**（是"我自己接球变乱"，不是"这一队"）
      chaosUntil: slots.map(() => 0),
      // ★ 黑（黑洞）：场上可以同时存在多个洞（两个人都是黑拍子），所以是数组。
      //   每一项 { x, y, team, until }：team 是**开洞那一方**，决定出口在哪半边。
      holes: [],
      // ★ 白（道具封锁）：**剩余层数**（按队）。对手吃到道具时消耗一层。
      //   上限 BLOCK_MAX = 1 ⇒ 结构上就不可能叠加。
      blockCharges: [0, 0],
      // ★ 橙（减速）：某队拍子速度上限降到 SLOW_MUL 直到什么时候（按队，和冰冻一样）
      slowUntil: [0, 0],
      events: [],                           // 本轮离散事件，广播后清空（供前端出音效）
      serverTime: Date.now(),
      lastActivity: Date.now(),
    };
    const boost = md === 'coop' ? COOP_BOT_SPEED_MUL : 1;
    for (const i of BOT_SLOT[md]) room.players[i] = makeBot(room.botLevel, boost);
    return room;
  }

  /**
   * 开新一局：清零比分、重排拍子、清掉本局的道具与技能效果，然后重新发球。
   *
   * @param {object} room Current room state.
   * @returns {void}
   */
  function startMatch(room) {
    room.score = [0, 0];
    room.matchNo += 1;
    room.matchId = `${room.code}-${room.matchNo}`;
    room.missLog = [];
    room.lastMissApproach = Object.create(null);
    room.substep = -1;
    room.paddles = room.slots.map((s) => (s.span[0] + s.span[1]) / 2);
    room.winner = -1;
    clearPowerups(room);           // 新一局清空场上道具与残留效果
    clearSkills(room);             // 技能冷却 / 蓄力 / 在刮的风也一起复位（皮肤保留）
    resetBall(room, Math.random() < 0.5 ? 0 : 1);
  }

  /**
   * 记录一次失分的取证信息。
   *
   * @param {object} room Current room state.
   * @param {number} concededBy Team that let the ball through.
   * @param {object} ball Ball that went out.
   * @returns {void}
   */
  function recordMiss(room, concededBy, ball) {
    const id = room.missLog.length + 1;
    room.missLog.push({
      id,
      matchId: room.matchId,
      serverTime: room.serverTime,
      tick: room.tick,
      substep: room.substep,
      scorer: 1 - concededBy,
      concededBy,
      ball: {
        id: ball ? ball.id : null,
        x: ball ? r1(ball.x) : null,
        y: ball ? r1(ball.y) : null,
        vx: ball ? r1(ball.vx) : null,
        vy: ball ? r1(ball.vy) : null,
      },
      approach: ball ? (room.lastMissApproach[ball.id] || null) : null,
    });
    if (ball) delete room.lastMissApproach[ball.id];
  }

  /**
   * 结算一个进球：计分、判胜负、必要时重新发球。
   *
   * ★ 先把这个漏掉的球从场上拿走。剩下的球继续在场上飞 ——
   *   "一回合要所有球都没接住才重发"就体现在这里。
   *
   * ★ 计分只能在这里做。若留在 stepBalls 里直接 +1，双倍得分就只是"显示的分数变了"，
   *   胜负判定读到的还是没乘倍率的值 —— 会出现"加分了却不算赢"的怪事。
   *
   * @param {object} room Current room state.
   * @param {number} concededBy Team that let the ball through.
   * @param {object} ball Ball that went out.
   * @returns {void}
   */
  function afterGoal(room, concededBy, ball) {
    recordMiss(room, concededBy, ball);
    if (ball) {
      const i = room.balls.indexOf(ball);
      if (i >= 0) room.balls.splice(i, 1);
    }

    // ★ 原实现写的是 room.score[concededBy]（**失分方**的分数），判定对象就错了。
    //   症状：先到 WIN_SCORE 的一方不会赢，反而在自己丢下一个球时把胜利判给对手；
    //   而且只要失分方分数够，比赛就莫名结束。胜负只能看得分方的分数。
    const scorer = 1 - concededBy;

    const now = Date.now();
    const gain = room.doubleUntil[scorer] > now ? 2 : 1;
    room.score[scorer] += gain;

    const my = room.score[scorer];
    const foe = room.score[concededBy];

    room.events.push(`g${scorer}`);   // 得分音效
    if (gain === 2) room.events.push(`x${scorer}`);   // 这一分是双倍，得说清楚

    if (isWin(my, foe)) {
      room.phase = 'over';
      room.winner = scorer;
      room.phaseEndsAt = Date.now() + OVER_HOLD_MS;
      // ★ 这一局结束了 ⇒ 下一局开始时要给玩家一次重选拍子的机会。
      //   标记在这里立、由 startMatch 翻开（phase 变 countdown）、发球时关掉。
      room.reselectPending = true;
      // 场上还剩的球全部冻住（不是只冻第一个，否则多球时还有球在飞）
      for (const b of room.balls) { b.vx = 0; b.vy = 0; }
      room.events.push(`o${scorer}`);   // 一局结束
      return;
    }

    // ★ 只有场上一个**真球**都不剩了才重新发球。
    //   还有球在飞就继续打 —— 这就是"所有球都没接住才重发"。
    // ★ 判据必须是"真球"而不是 balls.length：幻影球是假的，让它把回合吊住的话，
    //   这一回合会变成"真球已经出界算过分、却还在等一个不算分的假球飞完"的怪状态。
    //   顺带一提，resetBall 会把整个数组换掉，所以重发时幻影球自然一起消失。
    if (!room.balls.some((b) => !isPhantom(b))) resetBall(room, concededBy);   // 谁丢分，球发给谁
  }

  /**
   * 只算真人。机器人不算"活着" —— 否则人走了房间永远回收不掉，
   * 而且"双方都在"会永远成立，比分会一直空转。
   *
   * @param {object} room Current room state.
   * @returns {boolean} Whether at least one human connection is open.
   */
  function anyAlive(room) {
    return room.players.some(isLive);
  }

  /**
   * 把一个真人连接放到某个槽位上。
   * 皮肤只在**入座那一刻**确定。掉线重连走的是 rejoinPlayer（不经过这里），
   * 所以重连回来还是原来那块拍子 —— 换了皮肤会让对手的认知错位。
   *
   * @param {object} room Current room state.
   * @param {object} ws Player connection, stored on the player record only.
   * @param {number} side Paddle slot index.
   * @param {string} token Rejoin token minted for this seat.
   * @param {number} skin Requested skin index.
   * @returns {void}
   */
  function seatPlayer(room, ws, side, token, skin) {
    room.players[side] = { ws, token, dir: 0, since: Date.now() };
    room.skins[side] = normSkin(skin);
    wsPlayer(ws, room.code, side, token);
    room.lastActivity = Date.now();
  }

  /**
   * 挑一个可以坐下来的槽位。
   * 优先真正的空位；若都被占但有人掉线，则顶替掉线的那个座位，保证随时能开始玩。
   *
   * @param {object} room Current room state.
   * @returns {number} Slot index, or -1 when the room is full.
   */
  function findSeat(room) {
    for (let i = 0; i < room.N; i += 1) if (!room.players[i]) return i;
    const now = Date.now();
    for (let i = 0; i < room.N; i += 1) {
      const p = room.players[i];
      // ★ 机器人的座位绝不能被真人顶替。它没有 ws，会被下面那句判成"掉线"，
      //   于是 90 秒后随便谁一加入就坐到了 AI 身上，人机对战忽然变成一个人空转。
      if (isBot(p)) continue;
      const dead = !p.ws || p.ws.readyState > 1;
      if (dead && now - p.since > SLOT_GRACE_MS) return i;
    }
    return -1;
  }

  /**
   * 断线重连：把新连接接回原座位。座位与 token 都保留，所以皮肤和比分不丢。
   *
   * @param {object} room Current room state.
   * @param {object} ws Player connection, stored on the player record only.
   * @param {string} token Token handed out when the seat was first taken.
   * @returns {number} Slot index that was reclaimed, or -1 when the token no longer matches.
   */
  function rejoinPlayer(room, ws, token) {
    for (let i = 0; i < room.N; i += 1) {
      const p = room.players[i];
      if (p && !isBot(p) && p.token === token) {
        p.ws = ws;
        p.dir = 0;
        p.since = Date.now();
        wsPlayer(ws, room.code, i, token);
        room.lastActivity = Date.now();
        return i;
      }
    }
    return -1;
  }

  /**
   * 连接断开：保留座位与 token 等着重连，只把朝向归零。
   *
   * @param {object} room Current room state.
   * @param {object} ws Closed player connection.
   * @param {number} side Paddle slot index held by this connection.
   * @param {string} token Token the connection was holding.
   * @returns {void}
   */
  function releasePlayer(room, ws, side, token) {
    const p = room.players[side];
    if (p && p.token === token) {
      p.dir = 0;
      // 保留座位与 token，等待重连；ws 仍指向已关闭的连接，anyAlive 会正确判定
      room.lastActivity = Date.now();
    }
  }

  /**
   * 推进一个房间一个 tick：处理冻结、开局、阶段状态机与模拟。
   *
   * @param {object} room Current room state.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {void}
   */
  function stepRoom(room, now) {
    room.serverTime = now;

    // 机器人永远"在场"，所以人机模式不会因为缺人而暂停
    const bothPresent = room.players.every(isPresent);
    room.paused = !bothPresent;

    // 玩家主动暂停（任意一方按下即生效，见 togglePause）。
    // ★ `room.started` 这个前提不能省：先建房的那个人闲得按一下暂停，第二个人进来
    //   就会卡在"已暂停"、第一局永远开不了 —— 而那时候两边都还没打过球，
    //   "恢复"按钮在没开过局的房间里也不该有意义。
    const userFrozen = room.started && room.userPaused;
    const frozen = room.paused || userFrozen;

    // 缺人：冻结比赛。比分、球的位置都原样保留，人回来接着打。
    // 倒计时的截止时刻往后推，避免他重连回来时倒计时已经悄悄走完。
    if (frozen) {
      // ★ 冻结期间**每个 tick** 都把挂钟型截止时刻按"上一 tick 到现在过了多久"同步后移，
      //   等价于"比赛时间彻底静止"。为什么要持续做而不是解冻时补一次：
      //   服务端每个快照都会用这些时间戳**算**出下发的字段（冰冻还剩几秒 fz、
      //   球的不透明度 ia、双倍得分是否生效 db）。只在解冻那一刻补的话，暂停期间
      //   这些字段会一路走到"已过期" —— 玩家看到的是"暂停中对手忽然又能看见球了"
      //   "双倍得分显示成没了，一恢复又冒出来"。持续后移则全程都是暂停前那一刻的值。
      //   （这条是实测踩出来的：第一版就是"解冻时补一次"，test-rules 第 18 节直接报红。）
      // ★ 它同时也是自纠正的：把一个截止时刻后移"已经过去的那段时间"，定义上就等于
      //   "这段时间没走过"。所以哪怕别处再多移一次，也不会把它推到未来去。
      if (room.frozenAt) shiftDeadlines(room, now - room.frozenAt);
      room.frozenAt = now;
      if (room.phase === 'countdown') room.phaseEndsAt = now + COUNTDOWN_MS;
      room.tick += 1;
      return;
    }

    // 刚从冻结里出来。
    if (room.frozenAt) {
      // 补上"最后一次冻结 tick → 解冻 tick"之间那一小段，然后收工
      shiftDeadlines(room, now - room.frozenAt);
      room.frozenAt = 0;
      // ★ 倒计时重新数一整段。冻结期间它每 tick 都被重设成"当前 + 1.8s"，本来就已经
      //   是"完整一段"了，这里再设一次是为了让"谁负责它"只有一个答案：countdown 的
      //   截止时刻**只由这两处重设**，shiftDeadlines 里那句 `phase === 'over'` 的
      //   分支永远轮不到 countdown。恢复后给一整段倒计时，玩家有时间把手放回拍子上。
      if (room.phase === 'countdown') room.phaseEndsAt = now + COUNTDOWN_MS;
    }

    // 人齐了但还没开过第一局 —— 只有这时候才允许重置比分
    if (!room.started) {
      startMatch(room);
      room.started = true;
    }

    trackMods(room, now);   // 道具效果到期复位（漏了这句道具就会永久生效）

    if (room.phase === 'over') {
      if (now >= room.phaseEndsAt) startMatch(room);   // 一局打完自动开下一局
      room.tick += 1;
      return;
    }

    if (room.phase === 'countdown') {
      for (let i = 0; i < SUBSTEPS; i += 1) stepPaddles(room, SUB_DT);
      if (now >= room.phaseEndsAt) launchBall(room);
      room.tick += 1;
      return;
    }

    // playing：先按细分的固定步长推进，再判定
    for (let i = 0; i < SUBSTEPS; i += 1) {
      room.substep = i;
      stepPaddles(room, SUB_DT);
      if (room.phase !== 'playing') break;   // 中间可能因得分切换了阶段
      stepBalls(room, SUB_DT);
    }
    stepPowerup(room, now);   // 生成 / 过期 / 被球碰到
    if (DEBUG_FX) debugShowcaseFx(room, now);
    // 取证用：把弧线一直续上，让探针有时间截图
    if (DEBUG_CURVE && room.curveUntil < now) {
      room.curveUntil = now + 60000;
      room.curveSpin = CURVE_SPIN;
    }
    room.tick += 1;
  }

  return {
    createRoom,
    startMatch,
    recordMiss,
    afterGoal,
    anyAlive,
    seatPlayer,
    findSeat,
    rejoinPlayer,
    releasePlayer,
    stepRoom,
  };
}

module.exports = { createMatchLifecycle };