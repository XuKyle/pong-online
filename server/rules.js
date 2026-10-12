'use strict';

/**
 * Pure game rules and trajectory calculations.
 *
 * @module server/rules
 */

/**
 * Determine whether the player has won under the target-score and win-margin rules.
 *
 * @param {number} my Player's score.
 * @param {number} foe Opponent's score.
 * @param {number} [winScore=11] Score required to reach the winning threshold.
 * @param {number} [winMargin=2] Minimum score lead required to win.
 * @returns {boolean} Whether the player has won.
 */
function isWin(my, foe, winScore = 11, winMargin = 2) {
  return my >= winScore && my - foe >= winMargin;
}

/**
 * Predict a ball's vertical position when it reaches a vertical face, reflecting off the walls.
 *
 * @param {{ballMul?: number, H: number}} room Room geometry and ball speed multiplier.
 * @param {{x: number, y: number, vx: number, vy: number}} ball Ball position and velocity.
 * @param {number} faceX Target x-coordinate.
 * @param {number} [ballR=9] Ball radius used to calculate the wall-reflection span.
 * @returns {number} Predicted y-coordinate, or the current y when prediction is not forward-safe.
 */
function predictY(room, ball, faceX, ballR = 9) {
  const multiplier = room.ballMul || 1;
  const vx = ball.vx * multiplier;
  const vy = ball.vy * multiplier;
  if (Math.abs(vx) < 1) return ball.y;
  const time = (faceX - ball.x) / vx;
  if (!(time > 0)) return ball.y;

  const span = room.H - 2 * ballR;
  let position = (ball.y + vy * time - ballR) / span;
  position -= Math.floor(position / 2) * 2;
  const triangle = position <= 1 ? position : 2 - position;
  return ballR + triangle * span;
}

module.exports = { isWin, predictY };
