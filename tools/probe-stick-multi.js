'use strict';

/**
 * Browser probe for sticky-ball identity in a multi-ball match.
 *
 * @file
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const C = require('./cdp.js');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PROBE_SM_PORT) || 3113;
const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9433;
const SITE = `http://127.0.0.1:${PORT}`;
const TMP_DIR = process.env.PROBE_TMP || path.join(os.tmpdir(), 'pong-probe');
const SHOT_DIR = path.join(__dirname, 'shots');
const FRAME_PATCH = `(() => {
  const frames = [];
  let current = null;
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (callback) {
    return raf.call(window, function (time) {
      current = [];
      frames.push(current);
      if (frames.length > 60) frames.shift();
      return callback(time);
    });
  };
  const arc = CanvasRenderingContext2D.prototype.arc;
  CanvasRenderingContext2D.prototype.arc = function (x, y, r, a0, a1) {
    if (!current) { current = []; frames.push(current); }
    current.push([x, y, r, a0, a1]);
    return arc.apply(this, arguments);
  };
  window.__takeBallFrame = function () {
    const isBall = (a) => a[2] >= 8.7 && a[2] <= 9.3
      && Math.abs(a[3]) < 0.01 && Math.abs(a[4] - Math.PI * 2) < 0.01;
    let best = [];
    for (const frame of frames) {
      if (frame.filter(isBall).length > best.filter(isBall).length) best = frame;
    }
    frames.length = 0;
    current = null;
    return best.filter(isBall);
  };
})()`;

/**
 * Print a named probe assertion and update totals.
 *
 * @param {string} label Assertion description.
 * @param {boolean} condition Whether the assertion passed.
 * @param {string} [detail] Failure detail.
 * @returns {void}
 */
function check(label, condition, detail = '') {
  if (condition) console.log(`  [ok]   ${label}`);
  else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

let failures = 0;

/**
 * Wait for the local server health endpoint.
 *
 * @returns {Promise<boolean>} Whether the service became available.
 */
async function waitServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${SITE}/healthz`);
      if (response.ok) return true;
    } catch (error) { /* server is starting */ }
    await C.sleep(200);
  }
  return false;
}

/**
 * Click a visible overlay button by its displayed label.
 *
 * @param {object} session CDP session.
 * @param {string} label Visible button label.
 * @returns {Promise<boolean>} Whether the button was found and clicked.
 */
async function clickButton(session, label) {
  const point = await C.evalx(session, `(() => {
    const button = [...document.querySelectorAll('#overlayBody button')]
      .find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  })()`);
  if (!point) return false;
  await C.realClick(session, point[0], point[1]);
  return true;
}

/**
 * Run the multi-ball sticky-ball browser probe and clean up all spawned processes.
 *
 * @returns {Promise<void>} Resolves after reporting probe results.
 */
async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PONG_DEBUG_STICK_MULTI: '1',
      TEMP: TMP_DIR,
      TMP: TMP_DIR,
    },
    stdio: 'ignore',
  });
  let browser = null;
  let session = null;
  let profile = null;

  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    check('调试服务启动', await waitServer());
    browser = C.startEdge({ dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'sticky-multi' });
    profile = browser.profile;
    check('无头浏览器已就绪', await C.waitEdgeReady(DBG_PORT));
    session = await C.openPage({ dbgPort: DBG_PORT }, 'about:blank');
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: FRAME_PATCH });
    await session.send('Page.navigate', { url: SITE });
    check('游戏页面已就绪', await C.waitReady(session, '粘球多球探针'));
    await C.waitFor(session, 'window.__probe().connected === true', 10000, 'WebSocket');
    check('已选择单人 AI 模式', await clickButton(session, '单人打 AI'));
    check('已进入房间', await C.waitFor(session, 'window.__probe().mySide >= 0', 10000, '入房'));

    let captured = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await C.probe(session);
      if (state.phase === 'playing') {
        await C.evalx(session, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const balls = await C.evalx(session, 'window.__takeBallFrame()');
        if (Array.isArray(state.stuckBall) && state.stuckBall.length === 4) {
          captured = { state, balls: Array.isArray(balls) ? balls : [] };
          if (captured.balls.length >= 2) break;
        }
      }
      await C.sleep(40);
    }

    check('捕获到正在粘住的球', !!captured);
    if (captured) {
      const { state, balls } = captured;
      check('sk2 是 [球id, x, y, 槽位]', state.stuckBall.length === 4
        && Number.isInteger(state.stuckBall[0]), JSON.stringify(state.stuckBall));
      check('sk2 球 ID 存在于快照', state.ballIds.includes(state.stuckBall[0]),
        JSON.stringify(state.ballIds));
      check('服务端同时有至少两颗球', state.ballIds.length >= 2, String(state.ballIds.length));
      check('画布中同一帧仍绘制至少两颗球', balls.length >= 2, String(balls.length));
      if (balls.length >= 2) {
        const separate = balls.some((ball, index) => balls.slice(index + 1)
          .some((other) => Math.hypot(ball[0] - other[0], ball[1] - other[1]) > 18));
        check('被粘球和移动球没有叠在同一位置', separate, JSON.stringify(balls));
        await C.shot(session, SHOT_DIR, 'stick-multi.png');
      }
    }
  } finally {
    if (session && session.ws) {
      try { session.ws.close(); } catch (error) { /* already closed */ }
    }
    if (browser && browser.child) C.killEdge(browser.child);
    if (server && server.pid) server.kill('SIGTERM');
    if (profile) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { /* cleanup best effort */ }
    }
  }

  console.log(`\n========== 粘球多球探针：失败 ${failures} ==========\n`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
