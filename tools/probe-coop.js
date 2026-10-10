'use strict';

/**
 * 「双人对抗 AI」的前端验证：在真实浏览器里开两个标签页，真的联机打一局。
 *
 * 协议层的 check-coop.js 能证明"座位分对了、AI 真的在接球"，
 * 但证明不了画布上发生了什么：
 *   · 三条拍子有没有都画出来、左边两条是不是各守一半
 *   · 画布宽高比有没有跟着变成 960x800（写死 8/5 会把场地压扁）
 *   · ★ 本地预测有没有把拍子夹在自己那半场里 ——
 *     服务端值一定是对的，但玩家的手感来自本地预测那一层，
 *     它要是越界，就会看到拍子"冲过中线又被拽回来"的抖动。
 *   · 第二个人加入前，第一个人得看到"等待队友"而不是"等待对手"
 *
 * 两个标签页必须在**同一个浏览器实例**里，sessionStorage 才是各自独立的 ——
 * 这正是当初选 sessionStorage 而不是 localStorage 的原因，这里顺带回归一次。
 *
 * 用法: PROBE_SITE=http://127.0.0.1:3100 node tools/probe-coop.js
 */

const fs = require('fs');
const path = require('path');
const C = require('./cdp.js');

const SITE = process.env.PROBE_SITE || 'http://127.0.0.1:3100';
const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9461;
// 探针的临时目录（无头浏览器的 profile 都落这里）。
// ★ 原来是**硬编码** 'F:\WorkBuddyData\wbtemp' —— 换台机器没这个目录就直接 mkdir 失败，
//   接手的人第一步就卡住。现在：PROBE_TMP 优先 → 本机那个 F 盘目录（本机 C 盘紧张，
//   profile 不能落系统 Temp）→ 系统临时目录。
const TMP_DIR = process.env.PROBE_TMP || (
  fs.existsSync('F:\\WorkBuddyData\\wbtemp')
    ? 'F:\\WorkBuddyData\\wbtemp'
    : path.join(require('os').tmpdir(), 'pong-probe')
);
const SHOT_DIR = path.join(__dirname, 'shots');

const CW = 960;
const CH = 800;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
const note = (m) => console.log(`  · ${m}`);

/**
 * 页面内"自动击球"。用**和真人一模一样的键盘事件**驱动，不碰任何内部状态。
 *
 * 为什么需要它：coop 里两名真人如果只是被钉在某个位置，接不到球就一直丢分，
 * 而规则是"谁丢分就把球发给谁" —— 球会反复往左出界、再发回左边，
 * 右侧的 AI 整场都摸不到球。这时候"AI 拍子在动"这条断言就变成了
 * 在赌"这次发球会不会被接住"，红绿全看运气。
 *
 * 两个页面都装上它，球才能在左边被回过去、真正打到 AI 面前。
 * 判断用 paddleDisp（画出来的位置）而不是服务端值 —— 和真人看到的画面一致。
 */
const AUTO_PLAY = `(() => {
  window.__coopAuto = true;
  var up = false, down = false;
  function setKeys(u, d) {
    if (u !== up) { up = u; window.dispatchEvent(new KeyboardEvent(u ? 'keydown' : 'keyup', { key: 'ArrowUp' })); }
    if (d !== down) { down = d; window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key: 'ArrowDown' })); }
  }
  function frame() {
    if (!window.__coopAuto) { setKeys(false, false); return; }
    var p = window.__probe();
    var b = p && p.balls && p.balls[0];
    if (!p || !b || p.mySide < 0) { requestAnimationFrame(frame); return; }
    var d = b[1] - p.paddleDisp[p.mySide];
    if (Math.abs(d) > 3) setKeys(d < 0, d > 0);
    else setKeys(false, false);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})()`;

/** ★ 不能用选择器点：菜单里「单人打 AI」和「双人打 AI」同类按钮，按选择器会点错那个 */
async function clickBtnText(sess, text) {
  const box = await C.evalx(sess, `(() => {
    const el = [...document.querySelectorAll('#overlayBody button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
  })()`);
  if (!box) return null;
  await C.realClick(sess, box.x, box.y);
  return box;
}

const overlayText = (sess) => C.evalx(sess, 'document.getElementById("overlayBody").textContent');

/**
 * 点菜单里第 idx 块皮肤色块。
 * ★ 用**真鼠标**点（realClick），不用 `el.click()` —— 这条路径要证明的是"人点得到"，
 *   而 el.click() 绕过了命中测试，被别的元素盖住也照样"成功"。
 */
async function clickSwatch(sess, idx) {
  const box = await C.evalx(sess, `(() => {
    const el = document.querySelectorAll('#overlayBody .skinrow .swatch')[${idx}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
  })()`);
  if (!box) return null;
  await C.realClick(sess, box.x, box.y);
  return box;
}

/**
 * 直接读画布像素，量"场地左边缘 → 拍子左边缘"那条缝里最长的竖条有多少像素。
 * 用来验旧的"哪条是我的"平行白线确实删掉了 —— 它当时就画在这条缝里（离拍子 5px），
 * 净高 73px。只看左缝：两条真人拍子都在左边，右边那条是 AI，从来没画过这个标记。
 *
 * 三个必须排除掉的东西：
 *   · 球 —— 圆的直径会被算成一条"竖条"（按球心半径 14 挖掉）；
 *   · 护盾亮条 —— 它就画在场地左边（x=7），是真的竖条。所以要求 shield 为 0；
 *   · 球的**拖尾** —— 球贴着左边缘飞出去时，拖尾在这条缝里也可能是一段线。
 *
 * ★ 挖球必须用 `ballDisps`（**画出来的**位置）而不是 `balls`（服务端真值）：
 *   客户端对球做了指数平滑，真值最多领先画面 59px。球从左边飞出去的那几帧，
 *   真值已经在 x<0，而屏幕上那个球还在缝里 —— 拿真值当遮罩就漏掉了它，
 *   18px 高的球体在缝里正好是个 >4 的"竖条"。**这就是这条断言偶发报红的原因**
 *   （2026-10-10 实测，本地跑十几次里偶尔红一次，线上对照全绿）。
 *   分裂球之后场上最多 3 个球，所以也不能只挖 balls[0]（旧实现就是这样）。
 *
 * ★ 单帧判据还会被"路过的球 / 拖尾"干扰，所以 `strayLinePair` 取两帧，
 *   要求**同一个 x** 上两帧都长 ⇒ 只有静止的线才满足，移动的东西两帧对不上。
 */
async function strayLineOnce(sess) {
  return C.evalx(sess, `(() => {
    const p = window.__probe();
    const cv = document.getElementById('game');
    const g = cv.getContext('2d');
    const s = p.geom.dpr;
    const x1 = Math.max(1, Math.floor((p.geom.margin - 2) * s));
    const y0 = Math.ceil(4 * s), y1 = Math.floor((p.geom.court[1] - 4) * s);
    const meta = {
      worst: -1, worstX: -1, cols: x1, phase: p.phase, shield: p.shield[0],
      cvW: cv.width, cvH: cv.height, courtW: p.geom.court[0], courtH: p.geom.court[1],
      dpr: s, holes: 0,
    };
    // ★ 前提：画布尺寸必须和场地成正比。不成立时（例如换模式后画布还没重设）
    //   下面这套"场地坐标 × dpr → 画布像素"的映射会越界，读出来全是无意义的数据。
    //   先明确报出前提不成立，别让它级联成一条看不懂的"有竖线"。
    const mapOk = cv.width === p.geom.court[0] * s && cv.height === p.geom.court[1] * s
      && x1 <= cv.width && y1 <= cv.height && y1 > y0;
    if (!mapOk) return Object.assign(meta, { mapOk: false });
    const h = y1 - y0;
    const img = g.getImageData(0, y0, x1, h).data;
    // 遮罩 = 画出来的球（ballDisps）+ 服务端真值（双保险），全部球都要挖
    const holes = [];
    for (const d of (p.ballDisps || [])) holes.push([d[0], d[1]]);
    for (const d of (p.balls || [])) holes.push([d[0], d[1]]);
    meta.holes = holes.length;
    let worst = 0, worstX = -1;
    for (let x = 0; x < x1; x += 1) {
      let run = 0, best = 0;
      for (let y = 0; y < h; y += 1) {
        const cx = x / s, cy = (y0 + y) / s;
        let masked = false;
        for (let k = 0; k < holes.length; k += 1) {
          if (Math.hypot(cx - holes[k][0], cy - holes[k][1]) < 14) { masked = true; break; }
        }
        if (masked) { run = 0; continue; }
        const i = (y * x1 + x) * 4;
        const isCourt = Math.abs(img[i] - 13) <= 14
          && Math.abs(img[i + 1] - 18) <= 14
          && Math.abs(img[i + 2] - 32) <= 16;
        if (isCourt) run = 0; else { run += 1; if (run > best) best = run; }
      }
      if (best > worst) { worst = best; worstX = x; }
    }
    return Object.assign(meta, { mapOk: true, worst, worstX });
  })()`);
}

/**
 * 取两帧（间隔 ~450ms）。只有**静止的线**才会在同一个 x 上两帧都长；
 * 路过的球、拖尾在两帧里对不上同一个 x，因此不会被误判成"杂线"。
 *
 * ★ 取第一帧前先等 ~250ms（≈7 帧）：画布只在下一次 draw() 时才更新，
 *   若在"上一状态刚画完、下一帧还没来"的瞬间读取，读到的是一张**旧画面**——
 *   这条断言是"没有杂线"，读到旧画面属于**漏报方向**，比误报更危险。
 *   （实测：往渲染里注入一条 73px 的线后立刻采样，帧1 读到 2px、帧2 才读到 73px。）
 *
 * @returns {object} 单帧的字段 + { isLine, lineX, lineLen, a, b }
 */
async function strayLinePair(sess) {
  await C.sleep(250);
  const a = await strayLineOnce(sess);
  await C.sleep(450);
  const b = await strayLineOnce(sess);
  // 两帧都要满足前提，否则整对作废（mapOk 交给上层断言）
  const mapOk = a.mapOk && b.mapOk;
  const sameX = Math.abs(a.worstX - b.worstX) <= 1;
  const isLine = mapOk && a.worst > 4 && b.worst > 4 && sameX;
  return Object.assign({}, a, {
    a, b, isLine, mapOk,
    lineX: a.worstX, lineLen: Math.max(a.worst, b.worst),
    // 取两帧里更"脏"的那帧给上层显示，免得误报被藏起来
    worst: Math.max(a.worst, b.worst),
    worstX: a.worst >= b.worst ? a.worstX : b.worstX,
  });
}

/** 扫到"没有护盾"的那一对帧为止 —— 护盾亮条本身就是要排除的东西 */
async function strayLineNoShield(sess, tries = 12) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await strayLinePair(sess);
    if (last.shield === 0) return last;
    await C.sleep(400);
  }
  return last;
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { child, profile } = C.startEdge({
    dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'edgecoop',
  });

  let A = null;
  let B = null;

  try {
    console.log(`站点: ${SITE}`);
    if (!await C.waitEdgeReady(DBG_PORT)) throw new Error('调试端口没起来');

    // ---------- 1. 房主建房 ----------
    console.log('\n1) 第一个人：点「双人打 AI」建房');
    A = await C.openPage({ dbgPort: DBG_PORT }, SITE);
    const readyA = await C.waitReady(A, '房主');
    check('房主页面加载并完成脚本初始化', readyA);
    if (!readyA) throw new Error('页面未就绪');
    await C.waitFor(A, 'window.__probe().connected === true', 10000, 'WebSocket 连接');

    const cs = await clickSwatch(A, 1);      // 房主：青（风）
    check('房主在菜单里选好了拍子（青 = 风）', !!cs, JSON.stringify(cs));
    const clicked = await clickBtnText(A, '双人打 AI');
    check('点到了「双人打 AI」而不是别的同级按钮', !!clicked, clicked ? clicked.text : 'null');
    const inRoom = await C.waitFor(A, 'window.__probe().mySide >= 0', 10000, '建房');
    check('房主已入房', inRoom === true);

    let pa = await C.probe(A);
    check('★ 前端拿到的模式是 coop', pa.mode === 'coop', String(pa.mode));
    check('房主坐在 0 号槽位（上半场）', pa.mySide === 0, String(pa.mySide));
    check('★ 画布按 coop 的场地比例重建（960x800，不是写死的 800x500）',
      pa.canvasSize[0] === CW && pa.canvasSize[1] === CH,
      JSON.stringify(pa.canvasSize));
    check('前端记录了三条拍子的槽位',
      pa.slotEdges.join(',') === 'left,left,right', JSON.stringify(pa.slotEdges));
    check('★ 左边两条属于同一队、各自只守半个半场',
      pa.slotTeams.join(',') === '0,0,1'
      && JSON.stringify(pa.slotSpans[0]) === '[0,400]'
      && JSON.stringify(pa.slotSpans[1]) === '[400,800]',
      JSON.stringify(pa.slotSpans));
    check('AI 那条的槽位能覆盖整个场地',
      JSON.stringify(pa.slotSpans[2]) === '[0,800]', JSON.stringify(pa.slotSpans[2]));
    check('画面里有三条拍子', pa.paddle.length === 3, JSON.stringify(pa.paddle));
    check('两条左拍各在自己半场的中间',
      Math.abs(pa.paddle[0] - CH / 4) < 3 && Math.abs(pa.paddle[1] - CH * 0.75) < 3,
      JSON.stringify(pa.paddle));

    // ★ 配色：两名真人站在**同一条边**上，光靠"左/右"分不出谁是谁，
    //   所以 coop 必须按槽位分色（经典模式的"按队分色"在这里会给出两条一样的蓝）。
    const cols = pa.paddleColors;
    check('★ 三条拍子三色互不相同（两个真人不再是一模一样的蓝）',
      cols.length === 3 && new Set(cols).size === 3, JSON.stringify(cols));
    check('★ 两个真人的颜色都和 AI 的不同',
      cols[0] !== cols[2] && cols[1] !== cols[2], JSON.stringify(cols));

    // ★ 旧的"哪条是我的"标记是在拍子**旁边**画的一条平行白线（xL-5 / xR+W+5）。
    //   它和拍子之间隔着几像素背景，看着就是一根没人管的杂线 —— 用户要求去掉。
    //   这里直接读画布像素来验（见 strayLine 的说明）。
    const strip = await strayLineNoShield(A);
    check('扫描前提：画布尺寸与场地成正比（不成立时像素映射没有意义）',
      strip.mapOk,
      `canvas ${strip.cvW}x${strip.cvH} / court ${strip.courtW}x${strip.courtH} / dpr ${strip.dpr}`);
    check('扫描时没有护盾（护盾亮条本身就是竖条，会干扰判据）',
      strip.shield === 0, `shield=${strip.shield}`);
    check('★ 房主这边，拍子旁边那条平行竖线已经没了',
      strip.mapOk && !strip.isLine,
      strip.mapOk
        ? `缝里最长的竖条：帧1 ${strip.a.worst}px@x=${strip.a.worstX} / `
          + `帧2 ${strip.b.worst}px@x=${strip.b.worstX}（旧标记线是 73px，判据要求同一个 x 上两帧都长）`
        : '像素映射不成立，无法判定');
    note(`扫描区 ${strip.cols} 列 × 场地内高，phase=${strip.phase}，挖掉 ${strip.holes} 个球心`);

    // 队友还没来：遮罩得留着，而且文案说的必须是"队友"不是"对手"
    const txt = await overlayText(A);
    check('★ 队友没来时写的是「等待队友」，不是「等待对手」',
      /等待队友/.test(txt || ''), (txt || '').slice(0, 60));
    check('遮罩还没撤掉（人没齐不该开局）', pa.overlayHidden === false);
    const code = pa.code;
    check('拿到了 6 位房间码', /^[A-Z0-9]{6}$/.test(code || ''), String(code));

    // ---------- 2. 第二个人从邀请链接进来 ----------
    console.log('\n2) 第二个人：走邀请链接进来');
    B = await C.openPage({ dbgPort: DBG_PORT }, SITE + '?room=' + code);
    const readyB = await C.waitReady(B, '队友');
    check('队友页面加载并完成脚本初始化', readyB);
    if (!readyB) throw new Error('第二个页面未就绪');

    // ★ 邀请链接**不再自动入房**：链接只把房间码预填进菜单，队友还要自己选拍子、点「加入」。
    //   不这么改的话，从链接进来的人永远选不了皮肤 —— 而皮肤就是技能，
    //   coop 恰恰是"两个真人各一个技能"的模式，漏掉他就等于这模式的新功能对半失效。
    const pre = await C.waitFor(B,
      "(document.querySelector('#overlayBody .joinrow input') || {}).value || ''",
      8000, '菜单预填房间码');
    check('★ 邀请链接把房间码预填进菜单（不是直接把人塞进房间）', pre === code,
      `预填「${pre}」vs 房间码「${code}」`);
    const noIn = await C.probe(B);
    check('★ 此刻确实还没入房（证明"打开链接就自动进"这条老路径已经没了）',
      noIn.mySide === -1, String(noIn.mySide));
    const bs2 = await clickSwatch(B, 2);     // 队友：黄（幻影）
    check('队友也选好了自己的拍子（黄 = 幻影）', !!bs2, JSON.stringify(bs2));

    // ★ 真正点「加入」。★ 这一下不能省 —— 第一版只点了皮肤就等着入房，
    //   结果整段（座位 / 皮肤 / 技能按钮 / 三色一致 …）连锁报红，
    //   而现象是"队友没进来"，很容易被误读成"邀请链接坏了"。
    const tapJoin = await clickBtnText(B, '加入');
    check('队友点到了「加入」按钮', !!tapJoin, JSON.stringify(tapJoin));

    const inB = await C.waitFor(B, 'window.__probe().mySide >= 0', 12000, '队友入房');
    check('★ 队友从链接进来、自己选好拍子、点「加入」之后成功入房', inB === true);

    let pb = await C.probe(B);
    check('★ 队友坐在 1 号槽位（下半场）', pb.mySide === 1, String(pb.mySide));
    check('队友看到的房间码与房主一致', pb.code === code, `${pb.code} vs ${code}`);
    check('队友看到的模式与场地也和房主一致',
      pb.mode === 'coop' && pb.canvasSize[0] === CW && pb.canvasSize[1] === CH,
      `${pb.mode} ${JSON.stringify(pb.canvasSize)}`);
    // ★ 断言里必须同时钉住"两边都真的入了座"：只写 `pa.mySide !== pb.mySide` 的话，
    //   队友根本没进房（mySide = -1）时它照样通过 —— 一条能被"什么都没发生"满足的断言。
    check('★ 两个标签页各自持有独立座位（sessionStorage 的意义）',
      pa.mySide === 0 && pb.mySide === 1, `房主 ${pa.mySide} / 队友 ${pb.mySide}`);
    // ★ 皮肤是"这块拍子的"，而 coop 里左边两条拍子属于**同一队** ——
    //   两个人各选各的、各有一个技能，正是这一轮要验的东西。
    //   AI 那条槽位必须保持灰（需求：AI 暂时不能选）。
    check('★ 两个真人各带自己的皮肤生效（房主青=1 / 队友黄=2），AI 那条保持灰=0',
      JSON.stringify(pb.skins) === '[1,2,0]', JSON.stringify(pb.skins));
    const pa2 = await C.probe(A);
    check('★ 房主那边也看到了两人的皮肤，两端完全一致（否则谁是什么技能两边说法不一）',
      JSON.stringify(pa2.skins) === JSON.stringify(pb.skins),
      `房主=${JSON.stringify(pa2.skins)} 队友=${JSON.stringify(pb.skins)}`);
    // ★ 技能按钮：两个真人各一个，AI 那条没有。
    //   验的是"按钮真的显示在页面上"（shown 由 display + 实际尺寸算出来），不是"逻辑上应该有"。
    await C.waitFor(B, "window.__probe().phase !== 'waiting'", 6000, '比赛开始');
    const pb2 = await C.probe(B);
    check('★ 两个真人各有一个技能按钮（青「风」+ 黄「幻」），AI 那条没有 —— 需求说 AI 暂不选皮肤',
      pb2.skillBtns[0].shown === true && pb2.skillBtns[1].shown === true
      && pb2.skillBtns[2].shown === false,
      JSON.stringify(pb2.skillBtns.map((b) => (b ? b.shown : null))));
    check('★ 而且两条真人按钮分得清"哪个是我的"（自己的没有 foreign 类）',
      /foreign/.test(pb2.skillBtns[0].cls) && !/foreign/.test(pb2.skillBtns[1].cls),
      `槽0=${pb2.skillBtns[0].cls} 槽1=${pb2.skillBtns[1].cls}`);
    // 颜色必须两端一致：否则一人说"你那条蓝的往左"，对方眼里的蓝是另一条
    check('★ 两个客户端看到的三色完全一致（喊"蓝色的那条"时指的是同一条）',
      JSON.stringify(pb.paddleColors) === JSON.stringify(pa.paddleColors),
      `${JSON.stringify(pa.paddleColors)} vs ${JSON.stringify(pb.paddleColors)}`);

    // 队友这边也要查一遍：他的拍子在下半场，是另一个 mySide 分支
    const stripB = await strayLineNoShield(B);
    check('★ 队友这边，拍子旁边那条平行竖线也没了',
      stripB.mapOk && !stripB.isLine,
      stripB.mapOk
        ? `缝里最长的竖条：帧1 ${stripB.a.worst}px@x=${stripB.a.worstX} / `
          + `帧2 ${stripB.b.worst}px@x=${stripB.b.worstX}（旧标记线是 73px）`
        : `像素映射不成立（canvas ${stripB.cvW}x${stripB.cvH}）`);

    // ---------- 3. 两人到齐 ----------
    console.log('\n3) 两人到齐，比赛开始');
    const allIn = await C.waitFor(A,
      'window.__probe().present.join(",") === "1,1,1"', 12000, '三人到齐');
    check('房主看到三个人都在场', allIn === true);
    const hid = await C.waitFor(A, 'window.__probe().overlayHidden === true', 8000, '撤遮罩');
    check('人齐后遮罩自动撤掉（场地让出来了）', hid === true);
    const playing = await C.waitFor(A,
      '["playing","countdown"].includes(window.__probe().phase)', 12000, '开球');
    check('比赛真的跑起来了', playing === true);

    // ---------- 4. 本地预测的半场限制 ----------
    console.log('\n4) 打一会儿：本地预测有没有把拍子夹在自己半场');
    await C.sleep(1200);

    // ★ 每个页面按键盘前都要先把它带到前台。
    //   浏览器会把**后台标签页的 requestAnimationFrame 节流到几乎不跑**，
    //   而本地预测正好写在 rAF 循环里 —— 后台那个页面的 paddleDisp 会一动不动，
    //   看起来就像"半场限制把拍子钉死了"。实测：不切前台时房主只挪了 50px。
    //   （服务端不受影响，它收到按键照样推进 —— 所以现象是"客户端跟不上、服务端是对的"。）
    await A.send('Page.bringToFront');
    await C.sleep(150);

    // 房主（上半场）一直往下推 —— 分界线就在下面，是最容易越界的方向
    await C.key(A, 'keyDown', 'ArrowDown', 40);
    await C.sleep(1600);
    const pdA = await C.probe(A);
    await C.key(A, 'keyUp', 'ArrowDown', 40);
    check('★ 房主一路往下推，本地预测的拍子没有越过中线',
      pdA.paddleDisp[0] <= CH / 2 + 1, `paddleDisp[0]=${pdA.paddleDisp[0]}`);
    check('★ 而且确实推到了分界线附近（不是压根没动）',
      pdA.paddleDisp[0] > CH / 2 - 60,
      `paddleDisp[0]=${pdA.paddleDisp[0]}（服务端 paddle[0]=${pdA.paddle[0]}）`);
    check('服务端看到的也是夹住的（两边一致）',
      pdA.paddle[0] <= CH / 2 + 1, `paddle[0]=${pdA.paddle[0]}`);

    // 队友（下半场）一直往上推
    await B.send('Page.bringToFront');
    await C.sleep(150);
    await C.key(B, 'keyDown', 'ArrowUp', 38);
    await C.sleep(1600);
    const pdB = await C.probe(B);
    await C.key(B, 'keyUp', 'ArrowUp', 38);
    check('★ 队友一路往上推，也没越过中线',
      pdB.paddleDisp[1] >= CH / 2 - 1, `paddleDisp[1]=${pdB.paddleDisp[1]}`);
    check('★ 并且推到了分界线附近', pdB.paddleDisp[1] < CH / 2 + 60,
      `paddleDisp[1]=${pdB.paddleDisp[1]}（服务端 paddle[1]=${pdB.paddle[1]}）`);

    // ---------- 5. AI 在动 + 截图 ----------
    console.log('\n5) 右侧那条 AI 拍子');
    // ★ 三件事缺一不可，少一件这条断言就是在赌运气：
    //   ① 采样前先把**页面 A 切到前台**。第 4 节为了给队友按键把 B 切到了前台，
    //      而**后台标签页的 requestAnimationFrame 是停摆的** —— 自动击球装在 A 上
    //      也不会跑。实测（PROBE_TRACE=1）就是这么一回事：飞向左半场的球全落在 A
    //      那一半，没人接，一直丢分。
    //   ② 给两名真人都装上自动击球（用和真人一样的键盘事件）。
    //      不装的话，规则是"谁丢分就把球发给谁"，两个钉在中路的真人接不到球，
    //      球就反复往左出界、再发回左边，右侧的 AI 整场摸不到球 —— 拍子不动是对的。
    //   ③ 循环等"球真的朝 AI 飞过来"再开始量拍子。球发到下半场那半边时没人接，
    //      只有被前台那位接住的回合球才会飞向 AI —— 这不是每次发球都成立的。
    await A.send('Page.bringToFront');
    await C.sleep(200);
    await C.evalx(A, AUTO_PLAY);
    await C.evalx(B, AUTO_PLAY);
    check('两个页面都装上了自动击球（前台那个才会真的跑）',
      await C.evalx(A, 'window.__coopAuto === true') === true
      && await C.evalx(B, 'window.__coopAuto === true') === true);

    // 采样到"AI 的拍子确实动过"为止（最多 60 秒）。
    //   为什么不设固定窗口：球的去向不由我们决定 —— 规则是"谁丢分就把球发给谁"，
    //   而球发到下半场那半边时没人接，只有被前台那位接住的回合球才会飞向 AI。
    //   实测（PROBE_TRACE=1）能看到连续好几秒球一次都没往右走过。
    //   为什么不跟真值比对"它该不该接到"：普通档 AI 本来就**设计成会漏掉两成球**，
    //   拿单次接没接住做断言只会时红时绿。这条断言要证的是**渲染这一层**：
    //   AI 的拍子是不是真的被服务端状态驱动着，而不是画了一条静止的装饰条。
    //   （AI 打得准不准由 check-solo 的"盯球比例"和 check-coop 的击球事件统计管。）
    const aiYs = [];
    let rightFrames = 0;      // 球正朝 AI 飞的帧数 —— 失败时用来说明"机会到底有没有出现"
    let prevX = null;
    const spanOf = () => (aiYs.length ? Math.max(...aiYs) - Math.min(...aiYs) : 0);
    const tAi = Date.now();
    while (Date.now() - tAi < 60000 && spanOf() <= 20) {
      const p = await C.probe(A);
      const b = (p.balls || [])[0] || [0, 0];
      const blind = (p.invis && p.invis[1] > 0) || false;
      const frozen = (p.freeze && p.freeze[1] > 0) || false;
      if (prevX !== null && b[0] > prevX) rightFrames += 1;   // 球的 x 在涨 = 朝 AI 飞
      prevX = b[0];
      // 被隐形球蒙住 / 被冰冻时拍子本来就不该动，这些帧不能算进"它有没有动"
      if (p.phase !== 'waiting' && !blind && !frozen) aiYs.push(p.paddle[2]);
      await C.sleep(80);
    }
    await C.evalx(A, 'window.__coopAuto = false; 1');
    await C.evalx(B, 'window.__coopAuto = false; 1');
    if (process.env.PROBE_TRACE === '1') {
      note(`采样 ${aiYs.length} 帧，拍y: ${aiYs.map((y) => y.toFixed(0)).join(' ')}`);
    }
    check('★ AI 的拍子在动（不是钉死的装饰）', spanOf() > 20,
      `AI 拍子的 y 波动只有 ${spanOf().toFixed(1)}（${aiYs.length} 帧可用采样，`
      + `其中 ${rightFrames} 帧球正朝 AI 飞）`);
    check('AI 的拍子留在场地内', aiYs.every((y) => y >= 0 && y <= CH),
      aiYs.length ? `${Math.min(...aiYs)} ~ ${Math.max(...aiYs)}` : '没有采到样本');

    await C.shot(A, SHOT_DIR, 'coop-host.png');
    await C.shot(B, SHOT_DIR, 'coop-guest.png');
    note('已截图 coop-host.png（房主视角）与 coop-guest.png（队友视角）');

    // ---------- 6. 页面报错 ----------
    console.log('\n6) 页面报错检查');
    const errsA = A.errors.filter((e) => e.indexOf('[网络]') !== 0);
    const errsB = B.errors.filter((e) => e.indexOf('[网络]') !== 0);
    check('房主页面没有未捕获异常', errsA.length === 0, errsA.slice(0, 3).join(' ; '));
    check('队友页面没有未捕获异常', errsB.length === 0, errsB.slice(0, 3).join(' ; '));

    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  } catch (e) {
    console.log('\n探针中断: ' + e.message + '\n');
    fail += 1;
  } finally {
    try { if (A) A.ws.close(); } catch (e) {}
    try { if (B) B.ws.close(); } catch (e) {}
    await C.sleep(300);
    C.killEdge(child);
    await C.sleep(600);
    console.log(`（浏览器进程已清理，profile: ${profile}）`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

main();
