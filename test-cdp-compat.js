'use strict';

/**
 * Automated compatibility checks for the shared CDP utility exports.
 *
 * @file
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const browser = require('./tools/cdp-browser');
const cdp = require('./tools/cdp');

/**
 * Verify legacy and extracted browser lifecycle APIs remain compatible.
 *
 * @returns {Promise<void>} Resolves when every compatibility assertion passes.
 */
async function main() {
  const legacyExports = [
    'EDGE_CANDIDATES', 'sleep', 'startEdge', 'waitEdgeReady', 'killEdge',
    'connectTarget', 'evalx', 'newTab', 'openPage', 'waitReady', 'waitFor',
    'probe', 'key', 'realClick', 'shot',
  ];
  for (const name of legacyExports) {
    assert.ok(name in cdp, `legacy tools/cdp.js export missing: ${name}`);
  }

  for (const name of ['EDGE_CANDIDATES', 'startEdge', 'waitEdgeReady', 'killEdge']) {
    assert.ok(name in browser, `tools/cdp-browser.js export missing: ${name}`);
    assert.strictEqual(cdp[name], browser[name], `${name} must be forwarded by tools/cdp.js`);
  }
  assert.ok(Array.isArray(cdp.EDGE_CANDIDATES));
  assert.ok(cdp.EDGE_CANDIDATES.every((candidate) => typeof candidate === 'string'));

  const customBrowser = '/tmp/custom-probe-browser';
  const withOverride = spawnSync(process.execPath, [
    '-e', "process.stdout.write(require('./tools/cdp-browser').EDGE_CANDIDATES[0])",
  ], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, PROBE_BROWSER: customBrowser },
  });
  assert.equal(withOverride.status, 0, withOverride.stderr);
  assert.equal(withOverride.stdout, customBrowser, 'PROBE_BROWSER must be the first candidate');

  const cleanEnv = { ...process.env };
  delete cleanEnv.PROBE_BROWSER;
  const withoutOverride = spawnSync(process.execPath, [
    '-e', "const c=require('./tools/cdp-browser').EDGE_CANDIDATES; if(c.some(x=>typeof x!=='string')) process.exit(2); process.stdout.write(c[0])",
  ], {
    cwd: __dirname,
    encoding: 'utf8',
    env: cleanEnv,
  });
  assert.equal(withoutOverride.status, 0, withoutOverride.stderr);
  assert.equal(withoutOverride.stdout, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true });
    assert.equal(await browser.waitEdgeReady(9333, 1), true, 'ready browser should return true');
    global.fetch = async () => ({ ok: false });
    assert.equal(await browser.waitEdgeReady(9333, 1), false, 'non-ready browser should time out');
  } finally {
    global.fetch = originalFetch;
  }

  const originalExistsSync = fs.existsSync;
  try {
    fs.existsSync = () => false;
    assert.throws(
      () => browser.startEdge({ dbgPort: 9333, tmpDir: '/tmp' }),
      /找不到 Edge 可执行文件/,
      'missing browser should produce a clear error',
    );
  } finally {
    fs.existsSync = originalExistsSync;
  }

  console.log('CDP compatibility checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
