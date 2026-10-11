'use strict';
// 线上实拍：新增的两个道具（分裂球 7 / 隐形球 8）在**部署后的线上站点**上到底长什么样。
//
// 动机：`probe-powerup-fx.js` 是靠服务端环境变量 `PONG_FORCE_PU` 轮转道具类型来逐个抓拍的，
// 那只有本地能跑 —— 线上没法强推某种道具。但这两个效果在**客户端**是看得见的：
// 快照里带场上道具的类型（us）和被隐形方看到的球的不透明度（ia）。
// 所以可以"等它自己出现"再抓，并且真的走了网关、真的跑在线上服务端上。
// 这比"本地截图 + 逐字符一致"更进一步：那条只证明代码一样，这条证明**线上真的跑起来了**。
//
// 抓四张：
//   live-pu-split.png  分裂球图标在场
//   live-split.png     分裂生效（场上两颗球）
//   live-pu-invis.png  隐形球图标在场
//   live-invis.png     隐形生效（球从我这边消失）
//
// 用法: node tools/shot-live-powerup.js [baseUrl]

const fs = require('fs');
const path = require('path');
const C = require('./cdp.js');

const SITE = (process.argv[2] || 'https://pong-online-battle.app.workbuddy.host').replace(/\/+$/, '');
const SHOT_DIR = path.join(__dirname, 'shots');
const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9481;
// 探针的临时目录（无头浏览器的 profile 都落这里）。
// ★ 原来是**硬编码** 'F:\WorkBuddyData\wbtemp' —— 换台机器没这个目录就直接 mkdir 失败，
//   接手的人第一步就卡住。现在：PROBE_TMP 优先 → 本机那个 F 盘目录（本机 C 盘紧张，
//   profile 不能落系统 Temp）→ 系统临时目录。
const TMP_DIR = process.env.PROBE_TMP || (
  fs.existsSync('F:\\WorkBuddyData\\wbtemp')
    ? 'F:\\WorkBuddyData\\wbtemp'
    : path.join(require('os').tmpdir(), 'pong-probe')
);
const DEADLINE_MS = Number(process.env.PROBE_DEADLINE || 240000);

// ★ 真人必须**真的打球**，不能钉在中间。
//   钉住的话回合极短：球经常还没飞到道具上就先从自己这边出界了，
//   于是"分裂真的生效""隐形真的生效"两张图全靠运气（实测 180 秒也没抓到）。
//   装上自动击球后回合变长、球来回横穿，碰到道具的次数是数量级的差别。
//   ★ 自动击球只在**前台标签页**里跑得动（后台标签页的 requestAnimationFrame 是停摆的），
//     这里只有一个页面，所以没问题。
const AUTO_PLAY = `(() => {
  window.__autoPlay = true;
  var up = false, down = false;
  function setKeys(u, d) {
    if (u !== up) { up = u; window.dispatchEvent(new KeyboardEvent(u ? 'keydown' : 'keyup', { key: 'ArrowUp' })); }
    if (d !== down) { down = d; window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key: 'ArrowDown' })); }
  }
  function frame() {
    if (!window.__autoPlay) { setKeys(false, false); return; }
    var p = window.__probe();
    var b = p && p.balls && p.balls[0];
    if (!p || !b || p.mySide < 0) { requestAnimationFrame(frame); return; }
    var mine = (p.paddleDisp && p.paddleDisp[p.mySide] !== undefined)
      ? p.paddleDisp[p.mySide] : p.paddle[p.mySide];
    var d = b[1] - mine;
    if (Math.abs(d) > 3) setKeys(d < 0, d > 0);
    else setKeys(false, false);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})()`;

// 本轮要抓的四张图。开跑前先删掉旧的：
//   留着上一次的会把"这次没抓到"伪装成"这次抓到了" —— 文件在磁盘上看起来一样。
const WANT_SHOTS = ['live-pu-split.png', 'live-split.png', 'live-pu-invis.png', 'live-invis.png'];

let pass = 0;
let fail = 0;
// ★ 签名必须是 (name, cond, extra) —— 跟 probe-solo / probe-remote 一致。
//   写成 (ok, name, extra) 而调用时按 (name, cond) 传的话，`ok` 拿到的是名字字符串
//   （恒真），断言就**永远绿**：一个永远绿的断言比没有断言更糟，它会掩盖真故障。
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
const note = (m) => console.log(`  · ${m}`);
const sleep = C.sleep;

/** 按可见文字点一个按钮（真实鼠标手势 —— element.click() 不算用户手势） */
async function clickText(sess, text) {
  const box = await C.evalx(sess, `(() => {
    const el = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) return false;
  await C.realClick(sess, box.x, box.y);
  return true;
}

(async () => {
  let edge = null;
  let sess = null;
  try {
    // 先清掉旧图，避免"上一轮的截图冒充这一轮的结果"
    WANT_SHOTS.forEach((f) => { try { fs.unlinkSync(path.join(SHOT_DIR, f)); } catch (e) { /* 本来就没有 */ } });

    edge = C.startEdge({ dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'edgelive-pu' });
    if (!await C.waitEdgeReady(DBG_PORT)) throw new Error('调试端口没起来');
    sess = await C.openPage({ dbgPort: DBG_PORT }, SITE);
    if (!await C.waitReady(sess, '线上站点')) throw new Error('页面没就绪');
    const host = await C.evalx(sess, 'location.host');
    note(`已打开 ${SITE}  (host=${host})`);

    await sleep(600);
    check('线上站点能开局（点到了「单人打 AI」）', await clickText(sess, '单人打 AI'));
    const joined = await C.waitFor(sess, 'window.__probe().mySide >= 0', 12000, '入房');
    check('确实进了房间', joined !== null);
    // ★ 这条是"打的是线上"的硬证据：跑在别的域名上就等于没测线上。
    check('跑在线上域名上（不是本地 127.0.0.1）',
      host === new URL(SITE).host && !/localhost|127\.0\.0\.1/.test(host), String(host));

    await C.evalx(sess, AUTO_PLAY);
    check('装上了自动击球（否则回合太短，球碰不到道具）',
      await C.evalx(sess, 'window.__autoPlay === true') === true);

    console.log('\n2) 等分裂球 / 隐形球自己出现（道具每 3 秒生成一个，类型随机）');
    const got = { puSplit: false, split: false, puInvis: false, invis: false };
    let firstSeen = null;
    let samples = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < DEADLINE_MS) {
      await sleep(150);
      const p = await C.probe(sess);
      samples += 1;
      const us = p.powerups || [];
      const types = us.map((u) => u[2]);
      if (!firstSeen && types.length) firstSeen = types.slice();
      // 技能球图标在场
      if (!got.puSplit && types.indexOf(7) >= 0) {
        got.puSplit = true;
        await C.shot(sess, SHOT_DIR, 'live-pu-split.png');
        note(`分裂球图标在场 (${JSON.stringify(us)}) → live-pu-split.png`);
      }
      if (!got.puInvis && types.indexOf(8) >= 0) {
        got.puInvis = true;
        await C.shot(sess, SHOT_DIR, 'live-pu-invis.png');
        note(`隐形球图标在场 (${JSON.stringify(us)}) → live-pu-invis.png`);
      }
      // 分裂真的生效：场上不止一颗球
      if (!got.split && (p.balls || []).length >= 2) {
        got.split = true;
        await C.shot(sess, SHOT_DIR, 'live-split.png');
        note(`场上 ${p.balls.length} 颗球（分裂生效）→ live-split.png`);
      }
      // 隐形真的生效：我这一侧看到的球完全不透明 = 0
      const ia = p.invisAlpha || [1, 1];
      if (!got.invis && ia[0] < 0.05) {
        got.invis = true;
        await C.shot(sess, SHOT_DIR, 'live-invis.png');
        note(`我这边看到的球透明度 ${ia[0]}（完全看不见）→ live-invis.png`);
      }
      if (got.puSplit && got.split && got.puInvis && got.invis) break;
    }
    note(`采样 ${samples} 次，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s；首次见到的道具类型 ${firstSeen ? firstSeen.join(',') : '无'}`);

    console.log('\n3) 断言');
    // ★ 这里刻意分成两档，因为两者的**可复现性**完全不同：
    //   「道具图标出现过」是可靠的 —— 图标在场停留 11 秒，而某种类型约每 27 秒出现一次，
    //     240 秒窗口里几乎必然出现；这是断言。
    //   「道具被吃到、效果真的生效」要看**球有没有恰好撞上它**，本质是运气 —— 
    //     实测有一轮跑满 180 秒也没吃到。把随机的东西做成断言，只会得到一个
    //     时红时绿的测试，那比没有测试更糟（本项目的既定规矩）。所以只报不判。
    check('★ 线上见到了分裂球图标并抓到图', got.puSplit, 'live-pu-split.png');
    check('★ 线上见到了隐形球图标并抓到图', got.puInvis, 'live-pu-invis.png');
    if (got.split) note('★ 抓到了「分裂生效」：场上有两颗球 → live-split.png');
    else note('这一轮没抓到「分裂生效」（球没吃到那个道具）—— 不作失败，图已清掉避免冒充');
    if (got.invis) note('★ 抓到了「隐形生效」：我这边看到的球透明度为 0 → live-invis.png');
    else note('这一轮没抓到「隐形生效」（球没吃到那个道具）—— 不作失败');

    console.log('\n' + '='.repeat(52));
    console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  } catch (e) {
    console.log('\n!! 出错: ' + (e && e.message));
    fail += 1;
  } finally {
    try { if (sess) sess.ws.close(); } catch (e) { /* ignore */ }
    await sleep(300);
    if (edge) C.killEdge(edge.child);
    await sleep(600);
    console.log('（浏览器进程已清理）');
    process.exit(fail === 0 ? 0 : 1);
  }
})();
