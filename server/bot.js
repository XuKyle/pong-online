'use strict';

/**
 * AI player behavior for the authoritative game server.
 *
 * The module does not import the server entry point. Callers provide the small
 * set of constants and room helpers needed by the AI so the behavior can be
 * tested without opening HTTP or WebSocket listeners.
 *
 * @module server/bot
 */

/**
 * Create the AI behavior functions with explicit server-domain dependencies.
 *
 * @param {{BOT_PRESETS: Array<{name: string, thinkMs: number, errPx: number, speedMul: number}>, BALL_R: number, PADDLE_MARGIN: number, PADDLE_W: number, PADDLE_SPEED: number, PHANTOM_BOT_SWAY: number, SUB_DT: number, clamp: function(number, number, number): number, isPhantom: function(object): boolean, paddleHalf: function(object, number): number, predictY: function(object, object, number): number}} deps AI constants and pure room helpers.
 * @returns {{makeBot: function(number, number=): object, mostUrgentBall: function(object, boolean, Array=): object|null, botPerceive: function(object, number, number): void, botSteer: function(object, number): void}} AI behavior API.
 */
function createBotBehavior(deps) {
  const {
    BOT_PRESETS,
    BALL_R,
    PADDLE_MARGIN,
    PADDLE_W,
    PADDLE_SPEED,
    PHANTOM_BOT_SWAY,
    SUB_DT,
    clamp,
    isPhantom,
    paddleHalf,
    predictY,
  } = deps;

  /**
   * Create a room player controlled by the AI.
   *
   * @param {number} level Requested difficulty index.
   * @param {number} [speedBoost=1] Mode-level speed multiplier.
   * @returns {object} AI player state compatible with a human player record.
   */
  function makeBot(level, speedBoost = 1) {
    const lv = clamp(level, 0, BOT_PRESETS.length - 1);
    const cfg = BOT_PRESETS[lv];
    return {
      bot: true,
      level: lv,
      cfg,
      token: null,
      ws: null,
      dir: 0,
      since: Date.now(),
      thinkAt: 0,
      aimErr: 0,
      chasing: false,
      chaseId: 0,
      seen: [],
      speedMul: cfg.speedMul * (speedBoost || 1),
    };
  }

  /**
   * Select the ball that will reach one paddle edge first.
   *
   * @param {object} room Current room state.
   * @param {boolean} goingRight Whether the target edge is on the right.
   * @param {Array<object>} [list] AI-visible ball list; defaults to room balls.
   * @returns {object|null} Most urgent visible ball, or null when none approaches.
   */
  function mostUrgentBall(room, goingRight, list = room.balls) {
    const faceX = goingRight
      ? room.W - PADDLE_MARGIN - PADDLE_W - BALL_R
      : PADDLE_MARGIN + PADDLE_W + BALL_R;
    let best = null;
    let bestT = Infinity;
    for (const b of list) {
      const vx = b.vx * (room.ballMul || 1);
      if (goingRight ? vx <= 1 : vx >= -1) continue;
      const t = (faceX - b.x) / vx;
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = b;
      }
    }
    return best;
  }

  /**
   * Update one AI player's remembered vision and target position.
   *
   * @param {object} room Current room state.
   * @param {number} slot AI paddle slot index.
   * @param {number} now Current server timestamp in milliseconds.
   * @returns {void}
   */
  function botPerceive(room, slot, now) {
    const p = room.players[slot];
    const cfg = p.cfg;
    const team = room.slots[slot].team;
    const mine = room.slots[slot].edge === 'right';
    const blind = room.invisUntil[team] > now;
    const vision = room.balls.filter((b) => !isPhantom(b) || b.phantom !== team);
    if (!blind) {
      p.seen = [];
      for (const b of vision) {
        p.seen.push({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, phantom: b.phantom });
      }
    }
    const seen = blind ? (p.seen || []) : vision;
    const b = mostUrgentBall(room, mine, seen);
    if (!b) {
      p.chasing = false;
      p.chaseId = 0;
      return;
    }
    const chasing = mine ? b.vx > 0 : b.vx < 0;
    const phantomErr = b.phantom === undefined ? 0 : PHANTOM_BOT_SWAY;
    if (chasing && p.chaseId !== b.id) {
      p.aimErr = (Math.random() * 2 - 1) * cfg.errPx
        + (Math.random() * 2 - 1) * phantomErr;
    }
    p.chaseId = chasing ? b.id : 0;
    p.chasing = chasing;

    if (now < p.thinkAt) return;
    p.thinkAt = now + cfg.thinkMs;

    const faceX = mine
      ? room.W - PADDLE_MARGIN - PADDLE_W - BALL_R
      : PADDLE_MARGIN + PADDLE_W + BALL_R;
    if (chasing) {
      p.targetY = predictY(room, b, faceX) + p.aimErr;
    } else {
      const [yMin, yMax] = room.slots[slot].span;
      p.targetY = (yMin + yMax) / 2 + (Math.random() * 2 - 1) * (yMax - yMin) * 0.09;
    }
  }

  /**
   * Steer one AI paddle continuously toward its latest target.
   *
   * @param {object} room Current room state.
   * @param {number} slot AI paddle slot index.
   * @returns {void}
   */
  function botSteer(room, slot) {
    const p = room.players[slot];
    const half = paddleHalf(room, slot);
    const [yMin, yMax] = room.slots[slot].span;
    const mid = (yMin + yMax) / 2;
    const lo = yMin + half;
    const hi = yMax - half;
    const target = hi < lo ? mid : clamp(p.targetY === undefined ? mid : p.targetY, lo, hi);
    const d = target - room.paddles[slot];
    const dead = Math.max(3, PADDLE_SPEED * (p.speedMul || 1) * SUB_DT * 1.5);
    p.dir = Math.abs(d) < dead ? 0 : (d > 0 ? 1 : -1);
  }

  return { makeBot, mostUrgentBall, botPerceive, botSteer };
}

module.exports = { createBotBehavior };
