'use strict';

/**
 * Offline characterization tests for the ball physics update sequence.
 *
 * @file
 */

process.env.PONG_NO_LISTEN = '1';
const assert = require('node:assert/strict');
const S = require('./server');

/**
 * Create a room fixture that is already in active play.
 *
 * @param {string} code Stable test room code.
 * @returns {object} Active duel room.
 */
function playingRoom(code) {
  const room = S.createRoom(code);
  room.phase = 'playing';
  room.started = true;
  room.paddles = [-1000, 1000];
  room.events = [];
  room.serverTime = 100000;
  room.ballMul = 1;
  room.curveUntil = 0;
  room.curveSpin = 0;
  room.winds = [];
  room.holes = [];
  return room;
}

/**
 * Run an assertion and print a concise result for this offline suite.
 *
 * @param {string} label Behavior being characterized.
 * @param {function(): void} assertion Assertion callback.
 * @returns {void}
 */
function check(label, assertion) {
  try {
    assertion();
    console.log(`  [ok]   ${label}`);
  } catch (error) {
    console.error(`  [FAIL] ${label}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('\n========== 球物理顺序特征测试（离线） ==========\n');

// stepBalls must move all balls before resolving pairwise collisions. The
// fixture starts with separated balls; their movement brings them into range.
{
  const room = playingRoom('PHYSSEQ1');
  const a = room.balls[0];
  a.x = 390; a.y = 250; a.vx = 100; a.vy = 0;
  const b = S.makeBall(411, 250);
  b.vx = -100; b.vy = 0;
  room.balls.push(b);

  S.stepBalls(room, 0.1);

  check('整批位移之后才处理球球碰撞', () => {
    assert.ok(a.vx < 0, `第一个球应反向，vx=${a.vx}`);
    assert.ok(b.vx > 0, `第二个球应反向，vx=${b.vx}`);
    assert.ok(room.events.includes('cc'), `缺少碰撞事件：${room.events}`);
  });
}

// A black hole crossed during movement must be tested after the position has
// advanced, not only at the ball's pre-step coordinates.
{
  const room = playingRoom('PHYSSEQ2');
  const ball = room.balls[0];
  ball.x = 350; ball.y = 250; ball.vx = 400; ball.vy = 0;
  room.holes = [{ x: 390, y: 250, team: 0, until: room.serverTime + 1000 }];
  const speedBefore = Math.hypot(ball.vx, ball.vy);

  S.stepBalls(room, 0.1);

  check('位移之后立即检测黑洞并保留球速', () => {
    assert.deepEqual(room.holes, []);
    assert.ok(room.events.includes('w0'), `缺少黑洞事件：${room.events}`);
    assert.ok(ball.x >= room.W / 2 && ball.x <= room.W * 0.75, `出口 x=${ball.x}`);
    assert.ok(Math.abs(Math.hypot(ball.vx, ball.vy) - speedBefore) < 1e-9);
  });
}

// Wall response happens after movement in stepOneBall and clamps the ball to
// the wall radius while reflecting only the vertical velocity.
{
  const room = playingRoom('PHYSSEQ3');
  const ball = room.balls[0];
  ball.x = 400; ball.y = 10; ball.vx = 100; ball.vy = -100;

  S.stepBalls(room, 0.1);

  check('子步位移后执行上下墙反弹并校正位置', () => {
    assert.equal(ball.y, S.BALL_R);
    assert.equal(ball.vy, 100);
  });
}

console.log('\n========== 球物理顺序：完成 ==========\n');
