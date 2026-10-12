'use strict';

/**
 * 无头浏览器的查找、启动、就绪检测与清理。
 *
 * @module cdp-browser
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Edge 排在首位以保持项目探针的渲染环境稳定；其他浏览器作为跨平台兜底。
const EDGE_CANDIDATES = [
  process.env.PROBE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 启动无头浏览器并返回进程和临时 profile 路径。
 *
 * @param {{dbgPort: number, tmpDir: string, profileName?: string}} opts 启动参数。
 * @returns {{edge: string, child: import('child_process').ChildProcess, profile: string}} 浏览器进程信息。
 */
function startEdge(opts) {
  const profile = path.join(opts.tmpDir, (opts.profileName || 'edgeprobe') + '_' + Date.now());
  const edge = EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!edge) throw new Error('找不到 Edge 可执行文件');

  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${opts.dbgPort}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=OverscrollHistoryNavigation',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    'about:blank',
  ], {
    env: { ...process.env, TEMP: opts.tmpDir, TMP: opts.tmpDir },
    stdio: 'ignore',
    detached: false,
  });

  return { edge, child, profile };
}

/**
 * 轮询浏览器调试端口，直到浏览器就绪或达到重试次数。
 *
 * @param {number} dbgPort 远程调试端口。
 * @param {number} [tries=100] 最大轮询次数。
 * @returns {Promise<boolean>} 浏览器是否就绪。
 */
async function waitEdgeReady(dbgPort, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
      if (response.ok) return true;
    } catch (error) {
      // 浏览器尚未启动完成，继续轮询。
    }
    await sleep(200);
  }
  return false;
}

/**
 * 尽力终止无头浏览器进程。
 *
 * @param {import('child_process').ChildProcess} child 浏览器子进程。
 * @returns {void}
 */
function killEdge(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch (error) {
    // 清理阶段忽略已经退出的进程。
  }
}

module.exports = { EDGE_CANDIDATES, startEdge, waitEdgeReady, killEdge };
