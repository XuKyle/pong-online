'use strict';

/**
 * Player-triggered skills: casting, cooldowns, and per-match reset.
 *
 * 技能效果本身对房间做的改动（风、黑洞、幻影球）就在这里落地，
 * 而"什么时候过期 / 暂停怎么冻结"由 server/effects.js 独占。
 *
 * @module server/skills
 */

/**
 * Create the skill behavior functions with explicit dependencies.
 *
 * @param {object} deps Skill constants, room helpers, and ball construction.
 * @returns {object} Skill casting, cooldown, and reset API.
 */
function createSkillBehavior(deps) {
  const {
    SKILL_CD_MS,
    SKIN_N,
    SKIN_GRAY,
    SKIN_WIND,
    SKIN_PHANTOM,
    SKIN_BOOST,
    SKIN_STICK,
    SKIN_BLACKHOLE,
    SKIN_CHAOS,
    SKIN_BLOCK,
    SKIN_SLOW,
    WIND_MS,
    PHANTOM_MS,
    PHANTOM_ANGLE,
    HOLE_R,
    HOLE_LIFE_MS,
    CHAOS_MS,
    BLOCK_MAX,
    SLOW_MS,
    PADDLE_MARGIN,
    PADDLE_W,
    isPhantom,
    makeBall,
  } = deps;

  /**
   * 每局开始时把技能相关的东西清干净。
   * ★ 刻意**不动 room.skins** —— 那是玩家在菜单里选的，属于"这一场"而不是"这一局"，
   *   清掉的话第二局开始所有人都会变回灰板子。
   * ★ 冷却也一起清：新的一局从"技能就绪"开始，免得上一局的冷却跨局带到下一局。
   *
   * @param {object} room Current room state.
   * @returns {void}
   */
  function clearSkills(room) {
    room.winds = [];
    room.holes = [];
    for (let i = 0; i < room.N; i += 1) {
      room.skillReadyAt[i] = 0;
      room.boostArmed[i] = false;
      room.stickArmed[i] = false;
      room.chaosUntil[i] = 0;
    }
    for (let i = 0; i < 2; i += 1) {
      room.blockCharges[i] = 0;
      room.slowUntil[i] = 0;
    }
  }

  /** 这个皮肤有没有主动技能（灰的没有） */
  function skinHasSkill(skin) {
    return Number.isInteger(skin) && skin > SKIN_GRAY && skin < SKIN_N && SKILL_CD_MS[skin] > 0;
  }

  /**
   * 青：刮一阵风。
   * 风向 = 自己拍子中心 → 球场中心 的**单位向量**。
   *   · 拍子在左侧正中央 ⇒ 方向正好是 (+1, 0)，笔直往右吹；
   *   · 拍子在左上 ⇒ 方向是右下方。
   * 这正是需求描述的那个规则，而且是"从拍子指向中心"而不是"从中心指向拍子"。
   *
   * ★ 用**拍子的实时位置**而不是槽位中点：技能是"从我现在站的地方吹出去"，
   *   玩家把拍子挪到上方再按，风就该往右下走。用中点会让方向跟玩家的操作无关。
   *
   * @param {object} room Current room state.
   * @param {number} slot Caster's paddle slot.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {boolean} Always true unless the paddle sits exactly at court center.
   */
  function castWind(room, slot, now) {
    const sl = room.slots[slot];
    const px = sl.edge === 'left'
      ? PADDLE_MARGIN + PADDLE_W / 2
      : room.W - PADDLE_MARGIN - PADDLE_W / 2;
    const py = room.paddles[slot];
    let dx = room.W / 2 - px;
    let dy = room.H / 2 - py;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return false;      // 理论上到不了（拍子在边上），留个守门
    dx /= len;
    dy /= len;
    room.winds.push({ dx, dy, until: now + WIND_MS, seed: Math.random() * 1000 });
    return true;
  }

  /**
   * 黄：放出一个幻影球。
   * 真球与幻影球各自朝两边偏 PHANTOM_ANGLE、速率不变 —— 见 PHANTOM_ANGLE 的注释，
   * 等速对称是"对手分不出哪个是假的"的前提。
   *
   * @param {object} room Current room state.
   * @param {number} slot Caster's paddle slot.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {boolean} Whether a phantom ball was created.
   */
  function castPhantom(room, slot, now) {
    const team = room.slots[slot].team;
    const src = room.balls.find((b) => !isPhantom(b));
    if (!src) return false;
    const speed = Math.hypot(src.vx, src.vy);
    if (speed < 1) return false;          // 球还没发出去，没什么可迷惑的
    const base = Math.atan2(src.vy, src.vx);
    const sgn = Math.random() < 0.5 ? 1 : -1;
    const aReal = base + sgn * PHANTOM_ANGLE;
    const aFake = base - sgn * PHANTOM_ANGLE;
    src.vx = Math.cos(aReal) * speed;
    src.vy = Math.sin(aReal) * speed;
    const ph = makeBall(src.x, src.y);
    ph.vx = Math.cos(aFake) * speed;
    ph.vy = Math.sin(aFake) * speed;
    ph.phantom = team;                    // 归哪一队 —— 该队**看不到**它（见 broadcastState）
    ph.phantomUntil = now + PHANTOM_MS;
    room.balls.push(ph);
    return true;
  }

  /**
   * 蓝：武装"下一次接球粘住"。真正的粘发生在 bounceOffPaddle 里
   * （见那里的 `room.stickArmed[slot]` 分支）—— 技能本身只是把开关打开。
   *
   * @param {object} room Current room state.
   * @param {number} slot Caster's paddle slot.
   * @returns {boolean} Always true.
   */
  function castStick(room, slot) {
    room.stickArmed[slot] = true;
    return true;
  }

  /**
   * 黑：在己方靠中间的那半区随机开一个黑洞。
   *
   * ★ 区间是"自己这边的靠中半区"：左队 → x ∈ [0.25W, 0.50W]，右队整体镜像。
   *   用 **有效** 区间避开左右两条拍子列与上下墙 —— 洞开在拍子身上或者压着墙，
   *   玩家既看不清也容易误判，而且视觉上像是"洞卡在墙里"。
   * ★ y 也要留边：半径 HOLE_R 的洞贴着上下墙会露出一半。
   *
   * @param {object} room Current room state.
   * @param {number} slot Caster's paddle slot.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {boolean} Always true.
   */
  function castBlackhole(room, slot, now) {
    const sl = room.slots[slot];
    const left = sl.edge === 'left';
    const x0 = left ? room.W * 0.25 : room.W * 0.75;
    const x1 = left ? room.W * 0.50 : room.W * 0.50;
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    const pad = HOLE_R + 6;
    const yLo = PADDLE_MARGIN + pad;
    const yHi = room.H - PADDLE_MARGIN - pad;
    const x = lo + Math.random() * (hi - lo);
    const y = yLo + Math.random() * Math.max(1, yHi - yLo);
    room.holes.push({
      x, y, team: sl.team, until: now + HOLE_LIFE_MS,
      // 视觉用：每个洞给一个固定相位，免得两个洞的呼吸完全同步
      seed: Math.random() * 1000,
    });
    return true;
  }

  /**
   * 紫：开启 10 秒的"乱弹"状态（自己接球走随机角 + 大概率加速）。
   *
   * @param {object} room Current room state.
   * @param {number} slot Caster's paddle slot.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {boolean} Always true.
   */
  function castChaos(room, slot, now) {
    room.chaosUntil[slot] = now + CHAOS_MS;
    return true;
  }

  /**
   * 白：给对方挂一层"下一次吃到的道具无效"。
   * ★ 不能叠加：已经是满层就直接返回 false（**不消耗冷却**）——
   *   这样连按两下不会白烧 10 秒 CD，玩家不用猜"我这下浪费了没有"。
   *
   * @param {object} room Current room state.
   * @param {number} slot Caster's paddle slot.
   * @returns {boolean} Whether a new block charge was armed.
   */
  function castBlock(room, slot) {
    const team = room.slots[slot].team;
    const foe = 1 - team;
    if (room.blockCharges[foe] >= BLOCK_MAX) return false;
    room.blockCharges[foe] = BLOCK_MAX;
    return true;
  }

  /**
   * 橙：把对方整队的拍子速度上限降到 SLOW_MUL，持续 SLOW_MS。
   *
   * @param {object} room Current room state.
   * @param {number} slot Caster's paddle slot.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {boolean} Always true.
   */
  function castSlow(room, slot, now) {
    const foe = 1 - room.slots[slot].team;
    room.slowUntil[foe] = Math.max(room.slowUntil[foe], now + SLOW_MS);
    return true;
  }

  /**
   * 放技能。返回 true 表示这次真的放出去了（冷却被消耗）。
   *
   * ★ 门禁按"技能能不能真的产生作用"来设，一条都不能省：
   *   · `room.started` —— 第一局还没开始时按下去没有任何意义；
   *   · `paused / userPaused` —— 比赛时间冻着的时候不该有任何操作生效（否则暂停期间
   *     放技能，恢复那一刻效果已经过半了）；
   *   · `phase === 'playing'` —— countdown 时球还没发出去（风没处吹、幻影球没有源球），
   *     over 时这一局已经结束了；
   *   · 冷却 —— 见 skillReadyAt；
   *   · 红色已经蓄着力时再按一次 —— 白烧 10 秒冷却，直接拒掉。
   *
   * @param {object} room Current room state.
   * @param {number} slot Caster's paddle slot.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {boolean} Whether the skill was actually cast.
   */
  function castSkill(room, slot, now) {
    if (!room.started) return false;
    if (room.paused || room.userPaused) return false;
    if (room.phase !== 'playing') return false;
    const skin = room.skins[slot];
    if (!skinHasSkill(skin)) return false;
    if (room.skillReadyAt[slot] > now) return false;
    if (skin === SKIN_BOOST && room.boostArmed[slot]) return false;

    if (skin === SKIN_WIND) {
      if (!castWind(room, slot, now)) return false;
    } else if (skin === SKIN_PHANTOM) {
      if (!castPhantom(room, slot, now)) return false;
    } else if (skin === SKIN_BOOST) {
      room.boostArmed[slot] = true;
    } else if (skin === SKIN_STICK) {
      if (!castStick(room, slot)) return false;
    } else if (skin === SKIN_BLACKHOLE) {
      if (!castBlackhole(room, slot, now)) return false;
    } else if (skin === SKIN_CHAOS) {
      if (!castChaos(room, slot, now)) return false;
    } else if (skin === SKIN_BLOCK) {
      if (!castBlock(room, slot)) return false;   // 已经封着对方了 → 不消耗冷却
    } else if (skin === SKIN_SLOW) {
      if (!castSlow(room, slot, now)) return false;
    }
    room.skillReadyAt[slot] = now + SKILL_CD_MS[skin];
    room.events.push(`v${slot}${skin}`);   // v + 槽位 + 皮肤：前端按皮肤放不同的音效
    return true;
  }

  return {
    clearSkills,
    skinHasSkill,
    castWind,
    castPhantom,
    castStick,
    castBlackhole,
    castChaos,
    castBlock,
    castSlow,
    castSkill,
  };
}

module.exports = { createSkillBehavior };