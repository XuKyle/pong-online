'use strict';

/**
 * 手机端布局探测（真实浏览器 + 真实触摸事件）。
 *
 * 用法：
 *   node tools/probe-mobile.js --baseline            # 先采电脑端几何基线（**改代码之前**跑）
 *   PROBE_SITE=http://127.0.0.1:3100 node tools/probe-mobile.js
 *
 * 为什么要有 --baseline 这一步：
 *   "加了手机端但不影响电脑端"这句话，光看代码是证明不了的 —— CSS 里加一条 media query
 *   看起来无害，但很容易顺手改到一个共用选择器（比如给 .stage 加了 min-height），
 *   于是电脑端跟着变了一点点，肉眼又看不出来。这里把**电脑端每一个元素的矩形**存下来，
 *   改完逐项比对，差 0.5px 就报红。
 *
 * 为什么量的是矩形而不是截图：
 *   截图只能证明"看起来差不多"，比对矩形能证明"每个盒子一个像素都没动"。
 *
 * ★ 基线是**跟着当前线上版重新采过**的，不是永远不变的一份快照。重采过两次：
 *   ① 2026-10-10 加暂停功能（页眉多一个按钮 + 操作说明那行多了一句 P 快捷键）之后，
 *   基线重采，并按元素逐条比对过前后差异，结论是：
 *     · 唯一真实的位移是 .tip 第一行末尾那个 <br> 在同一行内右移（行数、y、盒子尺寸都没变）；
 *     · 其余"变化"全是"中间插了一个 SPAN.keys，于是后面同名元素的编号整体后移一位"
 *       造成的假差异（新的 keys@5 与旧的 keys@4 坐标完全相同）。
 *   ② 2026-10-10 加拍子皮肤 / 技能（菜单多一行"选拍子"：4 个色块 + 一行说明；
 *      页眉操作说明里多一个 Q 键提示）之后，基线重采，逐元素比对结论是：
 *     · 真实位移**只有一处**：菜单面板本身变高 355.8 → 471.4（+115.6px）。
 *       多出来的就是色块行 53.6 + 皮肤说明 32 + 一点行距。面板垂直居中，
 *       于是面板顶部上移 57.8px、色块行**之后**的元素整体下移 57.8px ——
 *       位移量严格等于 ±(115.6/2)，和"只加了一行"完全吻合（不是"凑合能看"）。
 *     · 菜单以外**一个盒子都没动**：页眉 / .stage / .meters / .tip 的位置尺寸全等。
 *     · .tip 里的 SPAN.keys 那串位移是假差异，同 ①：新插的 Q 提示排在第五个，
 *       后面同名元素整体后移一位（新的 keys@6 与旧的 keys@5 坐标完全相同）。
 *     · 新增 15 个 key，全在菜单里或 .tip 里：.skinrow / 4 个 BUTTON.swatch（连同
 *       各自的字形 <I>）/ 皮肤说明 DIV.hint / 皮肤那行的 DIV.seglabel / .tip 的 Q 提示 /
 *       三个 [0,0,0,0] 的 #skillBtn*。最后那三个和 #pauseBtn 一样，顺手把
 *       "菜单态下桌面页不能多出可见的技能按钮"也钉住了。
 *    重采前后的两份文件都在：tools/mobile-baseline.pre-skin.json 是这一轮之前的、
 *    tools/mobile-baseline.pre-pause.json 是加暂停功能之前的，想复核差异可以直接对比。
 * ★ 新基线里 `#pauseBtn` / `#pingPill` / `#rotateHint` / `#skillBtn0..2` 都是 [0,0,0,0]
 *   —— 它们是 display:none（桌面端的菜单态不显示）。
 *
 * ★ 量之前必须先把随网络变化的东西冻结成常量（见 freezeForMeasure）。
 *   否则"连接中→已连接"这种文字宽度变化会让 .hright 的 x 位移 4px，
 *   被误判成布局回归 —— 那不是代码变了，是测量时刻不同。
 */

const fs = require('fs');
const path = require('path');
const C = require('./cdp.js');

const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9411;
const SITE = process.env.PROBE_SITE || 'http://127.0.0.1:3100';
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
const BASELINE_FILE = path.join(__dirname, 'mobile-baseline.json');

const BASELINE_MODE = process.argv.includes('--baseline');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
const note = (m) => console.log(`  · ${m}`);

// ---------- 在页面里执行的测量代码 ----------

/** 把随连接状态变化的内容写成常量，让两次测量可比 */
const FREEZE = `(() => {
  const b = document.getElementById('netBadge');
  if (b) { b.textContent = '已连接'; b.className = 'badge ok'; }
  document.querySelectorAll('.m .v').forEach((el) => { el.textContent = '—'; });
  const v = document.getElementById('verdict');
  if (v) v.textContent = 'x';
  return true;
})()`;

/**
 * 遍历 .wrap 下每一个元素，记录 tag#id.class → [x, y, w, h]。
 * 同名元素自动加 @2 @3 后缀。★ 不能用下标做 key：新增一个元素会让后面所有下标平移，
 * 于是每一行都对不上，报出来的 diff 全是噪音。
 */
const GEOM = `(() => {
  const out = {};
  const seen = {};
  const all = document.querySelectorAll('.wrap, .wrap *');
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    let key = el.tagName + (el.id ? '#' + el.id : '') + cls;
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] > 1) key += '@' + seen[key];
    const b = el.getBoundingClientRect();
    out[key] = [
      Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10,
      Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10
    ];
  }
  return out;
})()`;

/** 手机端体检：溢出、隐藏/显示、触控目标尺寸 */
const HEALTH = `(() => {
  const de = document.documentElement;
  const vis = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    // ★ shown 看的是**矩形有没有面积**，不是自己的 display。
    //   被父级 display:none 藏起来时，元素自己的 computed display 仍是 'block'，
    //   只看 display 会把"整块被藏了"误判成"还在显示"。
    const shown = cs.display !== 'none' && b.width > 0 && b.height > 0;
    // ★ 但"有面积"仍然 ≠ "看得见" —— 被别的东西盖住时矩形照样有面积。
    //   要问"这点上最上面的是谁"，可 elementFromPoint **会跳过 pe:none 的元素**，
    //   而只读徽章 / 延迟胶囊正是 pe:none（横屏块 header .hright 设的）：
    //   直接问会拿到下面那层，得到恒假的"被盖住"。
    //   所以先把该元素临时放行再问，问完立刻还原 —— 页面的持久状态一点不动。
    //   这样量到的才是真问题：**如果它能被点，这点上最上面的是不是它**。
    let coverEl = null;
    let onTop = false;
    if (shown) {
      const saved = el.style.pointerEvents;
      el.style.pointerEvents = 'auto';
      coverEl = document.elementFromPoint(Math.round(b.x + b.width / 2),
        Math.round(b.y + b.height / 2));
      el.style.pointerEvents = saved;
      onTop = !!(coverEl && (coverEl === el || el.contains(coverEl)));
    }
    const dsc = (e) => (e ? e.tagName + (e.id ? '#' + e.id : '')
      + (typeof e.className === 'string' && e.className ? '.' + e.className : '') : null);
    return { display: cs.display, shown: shown, onTop: onTop, cover: dsc(coverEl),
             w: Math.round(b.width), h: Math.round(b.height),
             x: Math.round(b.x), y: Math.round(b.y) };
  };
  // ★ 返回对象而不是数组：断言里写 s.stage.y / .h 比写 [1] / [3] 难错得多。
  //   （第一版返回的是数组，于是 s.stage.h 恒为 undefined，三条断言"失败"，
  //     实际是球场尺寸完全正确 —— 量具写错会把好状态报成坏状态。）
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y),
             w: Math.round(b.width), h: Math.round(b.height) };
  };
  const small = [];
  document.querySelectorAll('button, [role=button], input').forEach((el) => {
    const b = el.getBoundingClientRect();
    if (b.height <= 0 || b.width <= 0) return;
    if (b.height < 32 || b.width < 32) {
      small.push((el.id || el.className || el.tagName) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    }
  });
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    overflowX: de.scrollWidth - de.clientWidth,
    overflowY: de.scrollHeight - de.clientHeight,
    stage: r('.stage'), canvas: r('#game'),
    meters: vis('.meters'), tip: vis('.tip'), solobar: vis('.solobar'),
    netBadge: vis('#netBadge'), ping: vis('#pingPill'), rotate: vis('#rotateHint'),
    header: r('header'), wrap: r('.wrap'),
    stageAR: getComputedStyle(document.querySelector('.stage')).aspectRatio,
    small
  };
})()`;

/** 菜单能不能完整看到：滚到顶量第一个按钮、滚到底量最后一个按钮 */
const MENU_FIT = `(() => {
  const o = document.getElementById('overlay');
  if (!o || o.classList.contains('hidden')) return { hidden: true };
  const rects = () => [...document.querySelectorAll('#overlayBody button')]
    .map((b) => b.getBoundingClientRect());
  o.scrollTop = 0;
  const up = rects();
  const firstTop = up.length ? Math.min(...up.map((b) => b.top)) : null;
  o.scrollTop = o.scrollHeight;
  const dn = rects();
  const lastBottom = dn.length ? Math.max(...dn.map((b) => b.bottom)) : null;
  const pb = document.getElementById('overlayBody').getBoundingClientRect();
  const needScroll = o.scrollHeight - o.clientHeight;
  o.scrollTop = 0;
  const pbTop = document.getElementById('overlayBody').getBoundingClientRect();
  return { hidden: false, vh: window.innerHeight, needScroll: Math.round(needScroll),
           count: dn.length, firstTop: Math.round(firstTop), lastBottom: Math.round(lastBottom),
           panelH: Math.round(pb.height), panelTop: Math.round(pbTop.top),
           panelBottomAtEnd: Math.round(pb.bottom) };
})()`;

/**
 * 电脑端基线要在**多个视口**下采样。
 *
 * ★ 只测 1280×820 是不够的 —— 那个尺寸下 .stage 的宽度被 max-width:940px 卡住了，
 *   `--reserve`（"页眉+面板占掉多少高度"）改多少都不会影响结果，于是"改坏了也测不出来"。
 *   必须包含一个**高度受限**的视口（这里的 1280×700 / 1024×640），
 *   reserve 才是真正在起作用的那个变量。
 */
const DESKTOP_VIEWPORTS = [
  { w: 1280, h: 820, name: '1280x820' },
  { w: 1280, h: 700, name: '1280x700' },
  { w: 1024, h: 640, name: '1024x640' },
];

/**
 * 提示条是不是**真的看得见**。
 *
 * ★ 只量矩形面积是不够的：竖屏时菜单是整屏抽屉，一句留在文档流里的提示会被它
 *   完整盖住 —— 矩形有面积、断言通过，玩家却一个字看不到。第一版就是这么写的，
 *   截图一看才发现提示根本不在画面上。
 *   用 elementFromPoint 打它的中心：返回的是它自己（或它的后代），才算真的在最上层。
 */
const HINT_CHECK = `(() => {
  const h = document.getElementById('rotateHint');
  if (!h) return { missing: true };
  const cs = getComputedStyle(h);
  const b = h.getBoundingClientRect();
  if (cs.display === 'none' || b.width === 0) return { shown: false };
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const top = document.elementFromPoint(cx, cy);
  // ★ 只在**菜单滚到底**（= 玩家为了点最后几个按钮必须到达的位置）时判重叠。
  //   不在初始滚动位置判：九宫格把菜单撑到 710px 之后，顶部对齐的菜单在 640/568
  //   高视口里必然向屏幕下方溢出，未滚动时"下半截按钮"和提示条当然相交 ——
  //   那些按钮此刻在滚动区外、本来就不可点，相交不构成抢点击。
  //   真正要保证的命题是：玩家滚到能看见最后一个按钮的那一刻，按钮不被压住。
  const ov = document.querySelector('.overlay');
  const prev = ov ? ov.scrollTop : 0;
  if (ov) ov.scrollTop = 1e9;
  const btns = [...document.querySelectorAll('#overlayBody button')]
    .map((el) => el.getBoundingClientRect());
  const overlap = btns.filter((r) => !(r.bottom <= b.top || r.top >= b.bottom
    || r.right <= b.left || r.left >= b.right)).length;
  const scrolled = ov ? Math.round(ov.scrollTop) : 0;
  const lastBottom = btns.length ? Math.round(Math.max(...btns.map((r) => r.bottom))) : 0;
  if (ov) ov.scrollTop = prev;
  return { shown: true, topEl: top ? (top.id || top.className || top.tagName) : null,
           isOnTop: !!top && (top === h || h.contains(top)),
           overlap, scrolled, lastBottom, y: Math.round(b.top), h: Math.round(b.height) };
})()`;

async function setViewport(sess, w, h, dsf, mobile) {
  await sess.send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: dsf, mobile: !!mobile,
    screenOrientation: w >= h
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 },
  });
  if (mobile) {
    await sess.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await sess.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  // 媒体查询是按视口算的，改完必须让浏览器重新排版并等一帧
  await C.sleep(320);
}

async function reload(sess, url) {
  await sess.send('Page.navigate', { url });
  await C.waitReady(sess, '页面');
  await C.sleep(400);
}

/** 真实触摸滑动：一次 touchStart → 多次 touchMove → touchEnd */
async function touchDrag(sess, x, y0, y1, steps) {
  const n = steps || 8;
  await sess.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }],
  });
  for (let i = 1; i <= n; i += 1) {
    const y = y0 + (y1 - y0) * (i / n);
    await sess.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x, y, id: 1 }],
    });
    await C.sleep(28);
  }
  await sess.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** 真实触摸点一下（手指不移动）。用来验证"手指点按钮"这条路真的通 */
async function touchTap(sess, x, y) {
  await sess.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x, y, id: 1 }],
  });
  await C.sleep(70);
  await sess.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function clickBtnText(sess, text) {
  // ★ 必须先 scrollIntoView 再取 rect：九宫格把菜单撑高之后，中后段的按钮
  //   （"单人打 AI" / 皮肤格）会被推到折叠线以下，rect 中心点落到视口外，
  //   鼠标事件发过去等于没点 —— 报出来却是"入房超时"，与"产品坏了"完全同形。
  const box = await C.evalx(sess, `(() => {
    const el = [...document.querySelectorAll('#overlayBody button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) return null;
  await sess.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await C.sleep(30);
  await sess.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return box;
}

/**
 * 等菜单真的关掉（真的进对局了）。
 *
 * ★★ 为什么必须等：`touchHitsUI()` 会把落在覆盖层 / 面板 / 常驻栏上的触摸**有意排除**
 *    （那是设计：免得"点按钮"被抢成"拖拍子"）。所以菜单还开着的时候，
 *    那一下拖动会**静默失效** —— 报出来是"手指下滑，拍子没反应"，看着像触摸坏了，
 *    其实那一下压根没被当成拖动。
 *    这一条真红过：探针 107/1，唯一那条红就是它。根因是菜单多了一行皮肤之后，
 *    "点完模式按钮"到"菜单真的关掉"之间的时序挪了几百毫秒，
 *    于是拖动正好落在覆盖层还没关的那一小段里（一次性调试脚本量出来的：
 *    那一刻 `elementFromPoint` 命中的是 `.overlay`，`pointer-events:auto`）。
 *    —— 不是产品回归，是探针少了一个前置条件。
 */
async function waitInPlay(sess, label) {
  return C.waitFor(sess, 'window.__probe && window.__probe().overlayHidden === true',
    12000, label || '菜单关闭');
}

async function main() {
  const { child } = C.startEdge({ dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'edge-mobile' });
  const ok = await C.waitEdgeReady(DBG_PORT);
  if (!ok) { console.log('  ! Edge 没起来'); process.exit(1); }

  let sess = null;
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    sess = await C.openPage({ dbgPort: DBG_PORT }, SITE);

    if (BASELINE_MODE) {
      const out = {};
      for (const v of DESKTOP_VIEWPORTS) {
        await setViewport(sess, v.w, v.h, 1, false);
        await reload(sess, SITE);
        await C.evalx(sess, FREEZE);
        out[v.name] = await C.evalx(sess, GEOM);
        console.log(`  ${v.name}: ${Object.keys(out[v.name]).length} 个元素`);
      }
      fs.writeFileSync(BASELINE_FILE, JSON.stringify(out, null, 1));
      console.log(`电脑端基线已写入 ${BASELINE_FILE}（来源 ${SITE}）`);
      return;
    }

    if (!fs.existsSync(BASELINE_FILE)) {
      console.log('  ! 没有基线文件，先跑 node tools/probe-mobile.js --baseline');
      process.exit(1);
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));

    // ================= 0. 量具自检 =================
    console.log('\n0. 量具自检');
    const probeOk = await C.waitReady(sess, '页面');
    check('页面就绪，__probe 可用', probeOk);
    const baselineNames = Object.keys(baseline);
    check('基线包含多个视口（只测一档会漏掉被测变量失效的尺寸）',
      baselineNames.length >= 3, baselineNames.join(','));
    check('每个视口的基线都不是空的',
      baselineNames.every((n) => Object.keys(baseline[n]).length > 25),
      baselineNames.map((n) => n + ':' + Object.keys(baseline[n]).length).join(' '));

    // ================= 1. 电脑端零回归 =================
    console.log('\n1. 电脑端必须一个像素都不动');
    for (const v of DESKTOP_VIEWPORTS) {
      if (!baseline[v.name]) { check(`基线里有 ${v.name}`, false, '基线缺这一档'); continue; }
      await setViewport(sess, v.w, v.h, 1, false);
      await reload(sess, SITE);
      const iw = await C.evalx(sess, 'window.innerWidth');
      // 防"设备仿真串台"：上一轮是手机仿真，没清干净的话这里就不是桌面视口，
      // 比出来的"零变化"毫无意义
      check(`${v.name} 视口确实是桌面宽度 ${v.w}`, iw === v.w, `实际 ${iw}`);
      await C.evalx(sess, FREEZE);

      const base = baseline[v.name];
      const nowG = await C.evalx(sess, GEOM);
      const moved = [];
      const gone = [];
      for (const k of Object.keys(base)) {
        if (!(k in nowG)) { gone.push(k); continue; }
        const a = base[k]; const b = nowG[k];
        const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]),
          Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
        if (d > 0.5) moved.push(`${k} ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      }
      check(`${v.name} 原有元素一个都没消失`, gone.length === 0, gone.slice(0, 5).join(' | '));
      check(`${v.name} 原有元素位置/尺寸零变化`, moved.length === 0, moved.slice(0, 6).join(' | '));
      if (moved.length === 0) note(`${v.name}: 比对 ${Object.keys(base).length} 个元素，全部零位移`);
    }

    // ★ 元检查：证明上面那几条"零变化"不是空断言 ——
    //   1280×700 这种矮窗口下，球场宽度是被 --reserve 决定的（不受 max-width:940px 限制）。
    //   如果这个尺寸下球场宽度恰好等于 940，说明 reserve 没在起作用，上面的比对就白比了。
    await setViewport(sess, 1280, 700, 1, false);
    await reload(sess, SITE);
    const stageAtShort = await C.evalx(sess, `(() => {
      const b = document.querySelector('.stage').getBoundingClientRect();
      return [Math.round(b.width), Math.round(b.height)];
    })()`);
    check('★ 1280×700 下球场宽度由 --reserve 决定（说明这块比对是有效的）',
      stageAtShort[0] < 940, `球场宽 ${stageAtShort[0]}`);

    await setViewport(sess, 1280, 820, 1, false);
    await reload(sess, SITE);
    const dHealth = await C.evalx(sess, HEALTH);
    check('电脑端没有横向溢出', dHealth.overflowX <= 1, String(dHealth.overflowX));
    check('电脑端 .meters 面板仍然显示',
      dHealth.meters && dHealth.meters.shown, JSON.stringify(dHealth.meters));
    check('电脑端操作/道具说明仍然显示',
      dHealth.tip && dHealth.tip.shown, JSON.stringify(dHealth.tip));
    check('★ 电脑端不出现手机专属的延迟胶囊',
      dHealth.ping && !dHealth.ping.shown, JSON.stringify(dHealth.ping));
    check('★ 电脑端不出现横屏提示',
      dHealth.rotate && !dHealth.rotate.shown, JSON.stringify(dHealth.rotate));
    await C.shot(sess, SHOT_DIR, 'mobile-desktop-1280.png');

    // ================= 2. 竖屏 =================
    console.log('\n2. 竖屏手机');
    const portraits = [
      { w: 390, h: 844, dsf: 3, name: '390x844' },
      { w: 360, h: 640, dsf: 2, name: '360x640' },
      { w: 320, h: 568, dsf: 2, name: '320x568' },
    ];
    for (const p of portraits) {
      await setViewport(sess, p.w, p.h, p.dsf, true);
      await reload(sess, SITE);
      const s = await C.evalx(sess, HEALTH);
      console.log(`  -- ${p.name} --`);
      check(`${p.name} 无横向溢出`, s.overflowX <= 1, String(s.overflowX));
      check(`${p.name} 链路实测面板已隐藏`,
        s.meters && !s.meters.shown, JSON.stringify(s.meters));
      check(`${p.name} 操作/道具说明已隐藏`,
        s.tip && !s.tip.shown, JSON.stringify(s.tip));
      check(`${p.name} 顶部有延迟读数`,
        s.ping && s.ping.shown && s.ping.w > 0, JSON.stringify(s.ping));
      // ★ 竖屏**菜单态**下胶囊被整屏菜单抽屉盖住，是设计如此（抽屉就是主界面，
      //   不该在它上面再浮一个延迟读数）。所以这里不判 onTop ——
      //   它的判据在"竖屏对局中"那一节：抽屉一收起，胶囊就必须浮在最上层。
      check(`${p.name} 提示横屏`,
        s.rotate && s.rotate.shown, JSON.stringify(s.rotate));
      const hh = await C.evalx(sess, HINT_CHECK);
      check(`${p.name} 提示条真的浮在菜单上面（elementFromPoint 命中它，不是被盖住）`,
        hh.shown && hh.isOnTop, JSON.stringify(hh));
      check(`${p.name} 滚到底时提示条不压住任何菜单按钮`, hh.overlap === 0, JSON.stringify(hh));
      check(`${p.name} 触控目标全部 ≥32x32`, s.small.length === 0, s.small.join(' | '));
      check(`${p.name} 球场完整落在视口内`,
        s.stage && s.stage.y >= 0 && s.stage.y + s.stage.h <= p.h + 1,
        JSON.stringify(s.stage));
      // 竖屏球场只有两百来像素高，菜单塞不进去 —— 必须已经改成整屏可滚
      const pf = await C.evalx(sess, MENU_FIT);
      check(`${p.name} 菜单最后一个按钮能滚到（不被球场裁掉）`,
        !pf.hidden && pf.lastBottom <= pf.vh + 1, JSON.stringify(pf));
      check(`${p.name} 菜单整块能滚到（连底部提示文字都不被裁）`,
        !pf.hidden && pf.panelTop >= -1 && pf.panelBottomAtEnd <= pf.vh + 1,
        JSON.stringify(pf));
      note(`菜单 ${pf.count} 个按钮，面板高 ${pf.panelH}px，需滚动 ${pf.needScroll}px`);

      // ---- 图鉴展开后菜单还能不能滚到底 ----
      // ★ 收起时图鉴只占一行，所以上面那些"能滚到"的断言其实**没覆盖展开态**。
      //   展开后面板会多出十八行（约 +500px），必须单独验一次：
      //   能滚到最底（底部提示文字不被裁）、且图鉴的按钮本身也在视口内。
      const opened = await C.evalx(sess, `(() => {
        const t = document.querySelector('#overlayBody .codex-toggle');
        if (!t) return { missing: true };
        t.scrollIntoView({ block: 'nearest' });
        t.click();
        const ov = document.querySelector('.overlay');
        ov.scrollTop = 1e9;
        const btns = [...document.querySelectorAll('#overlayBody button')]
          .map((el) => el.getBoundingClientRect());
        const body = document.querySelector('#overlayBody .codex-body');
        const rows = body.querySelectorAll('.codex-row').length;
        const last = document.querySelector('#overlayBody .hint');
        return {
          rows,
          display: getComputedStyle(body).display,
          lastBottom: Math.round(last.getBoundingClientRect().bottom),
          vh: window.innerHeight,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          toggleInView: (() => {
            const r = document.querySelector('#overlayBody .codex-toggle').getBoundingClientRect();
            return r.top >= -1 && r.bottom <= window.innerHeight + 1;
          })(),
          small: btns.filter((r) => r.width > 0 && (r.width < 32 || r.height < 32)).length,
        };
      })()`);
      check(`${p.name} ★ 图鉴展开后确实是十八行（收起时没覆盖到这一态）`,
        opened.rows === 18, JSON.stringify({ rows: opened.rows }));
      check(`${p.name} ★ 图鉴展开后底部提示文字仍能滚到（不被裁）`,
        opened.lastBottom <= opened.vh + 1, JSON.stringify(opened));
      check(`${p.name} ★ 图鉴展开后没有横向溢出`,
        opened.overflowX <= 1, String(opened.overflowX));
      check(`${p.name} ★ 图鉴展开后所有按钮仍然 ≥32x32`,
        opened.small === 0, String(opened.small));

      await C.shot(sess, SHOT_DIR, `mobile-portrait-${p.name}.png`);
    }

    // ================= 3. 横屏铺满 =================
    console.log('\n3. 横屏手机：球场铺满屏幕');
    const lands = [
      { w: 844, h: 390, dsf: 3, name: '844x390' },
      { w: 667, h: 375, dsf: 2, name: '667x375' },
    ];
    for (const L of lands) {
      await setViewport(sess, L.w, L.h, L.dsf, true);
      await reload(sess, SITE);
      const s = await C.evalx(sess, HEALTH);
      console.log(`  -- ${L.name} --`);
      check(`${L.name} 无横向溢出`, s.overflowX <= 1, String(s.overflowX));
      check(`${L.name} 无纵向滚动（页面不滚）`, s.overflowY <= 1, String(s.overflowY));
      check(`${L.name} 球场高度铺满视口`, s.stage && Math.abs(s.stage.h - L.h) <= 1,
        `stage.h=${s.stage && s.stage.h} 视口=${L.h}`);
      check(`${L.name} 球场宽度不超过视口`, s.stage && s.stage.w <= L.w + 1, JSON.stringify(s.stage));
      check(`${L.name} 页眉不占纵向空间（球场从顶部开始）`,
        s.stage && s.stage.y <= 1, JSON.stringify(s.stage));
      check(`${L.name} 链路实测面板已隐藏`,
        s.meters && !s.meters.shown, JSON.stringify(s.meters));
      check(`${L.name} 顶部有延迟读数`,
        s.ping && s.ping.shown && s.ping.w > 0, JSON.stringify(s.ping));
      check(`${L.name} ★ 延迟胶囊真的画在最上层（没被球场盖住）`,
        s.ping && s.ping.onTop, JSON.stringify(s.ping));
      check(`${L.name} 已经是横屏了就不该再提示横屏`,
        s.rotate && !s.rotate.shown, JSON.stringify(s.rotate));
      check(`${L.name} 触控目标全部 ≥32x32`, s.small.length === 0, s.small.join(' | '));

      // 横屏只有 375~390 高，而菜单内容有四百多像素 —— 很容易被 .stage 的
      // overflow:hidden 裁掉，表现为"开始按钮根本点不到"。滚到两头各量一次。
      const fit = await C.evalx(sess, MENU_FIT);
      check(`${L.name} 菜单里按钮齐全`, fit.count >= 4, JSON.stringify(fit));
      check(`${L.name} 菜单第一个按钮在屏幕内`,
        !fit.hidden && fit.firstTop >= -1, JSON.stringify(fit));
      check(`${L.name} 菜单最后一个按钮能滚到（不被裁掉）`,
        !fit.hidden && fit.lastBottom <= fit.vh + 1, JSON.stringify(fit));
      check(`${L.name} 菜单整块能滚到（连底部提示文字都不被裁）`,
        !fit.hidden && fit.panelTop >= -1 && fit.panelBottomAtEnd <= fit.vh + 1,
        JSON.stringify(fit));
      note(`菜单 ${fit.count} 个按钮，需滚动 ${fit.needScroll}px`);

      await C.shot(sess, SHOT_DIR, `mobile-landscape-${L.name}.png`);
    }

    // ================= 4. 触摸拖动真的能控拍子 =================
    console.log('\n4. 触摸拖动控拍子（真实触摸事件）');
    await setViewport(sess, 844, 390, 3, true);
    await reload(sess, SITE);
    await clickBtnText(sess, '单人打 AI');
    const entered = await C.waitFor(sess, 'window.__probe && window.__probe().mySide >= 0', 12000, '进入人机');
    check('横屏下能进入对局并拿到自己的座位', !!entered);
    // ★ 拖拍子之前必须先等菜单关掉：覆盖层还在的时候触摸会被有意排除（见 waitInPlay）。
    const menuGone = await waitInPlay(sess, '横屏菜单关闭');
    check('前置：菜单真的关掉了（覆盖层挡着的时候触摸会被有意排除，那一下根本不算拖动）',
      menuGone === true);

    const st = await C.evalx(sess, `(() => {
      const p = window.__probe();
      return { side: p.mySide, disp: p.paddleDisp[p.mySide], disp0: p.paddle[0],
               stage: (() => { const b = document.querySelector('.stage').getBoundingClientRect();
                 return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })() };
    })()`);
    note(`座位 ${st.side}，起始 paddleDisp=${st.disp}`);

    // 对局中胶囊是浮在球场上的 —— 这正是"有没有被球场盖住"唯一能暴露出来的时机
    const hp = await C.evalx(sess, HEALTH);
    check('★ 对局中延迟胶囊仍画在最上层（浮在球场上没被盖住）',
      hp.ping && hp.ping.shown && hp.ping.onTop, JSON.stringify(hp.ping));

    // ---- 4a. 常驻栏必须让开自己拍子的活动带，而且要拆成两排 ----
    // 用户反馈：横屏时这条栏贴在左下角，正好压在自己拍子上。
    check('人机模式下真人固定坐左边（"让开左半场"这个前提才成立）',
      st.side === 0, `mySide=${st.side}`);

    const bar = await C.evalx(sess, `(() => {
      const el = document.getElementById('soloBar');
      const sm = document.getElementById('soloText');
      const bt = document.getElementById('soloLeave');
      if (!el || !sm || !bt) return null;
      const b = el.getBoundingClientRect();
      const s = sm.getBoundingClientRect();
      const t = bt.getBoundingClientRect();
      return {
        shown: getComputedStyle(el).display !== 'none',
        x: Math.round(b.x), right: Math.round(window.innerWidth - b.right),
        w: Math.round(b.width), h: Math.round(b.height),
        labelBottom: Math.round(s.bottom), btnTop: Math.round(t.top),
      };
    })()`);
    check('横屏对局中常驻栏是显示的', !!bar && bar.shown, JSON.stringify(bar));

    // 自己（左边）那根拍子在屏幕上的列：场地左边距 26 + 拍宽 14，画布宽 800。
    // 拍子只上下动，所以它的"活动带"就是这一整列 —— 只要横向上不重叠就永远不挡。
    const PAD_L = st.stage[0] + st.stage[2] * (26 / 800);
    const PAD_R = st.stage[0] + st.stage[2] * ((26 + 14) / 800);
    check('★ 常驻栏整体在自己拍子的右边（不再压住活动带）',
      !!bar && bar.x >= PAD_R,
      `栏 x=${bar && bar.x}，自己拍子 x∈[${PAD_L.toFixed(0)},${PAD_R.toFixed(0)}]`);
    check('★ 常驻栏贴着屏幕最右边',
      !!bar && bar.right <= 24, `距右缘 ${bar && bar.right}px`);
    check('★ 常驻栏是两排（文字在上、按钮在下，不并排）',
      !!bar && bar.labelBottom <= bar.btnTop + 1,
      `文字底 ${bar && bar.labelBottom} vs 按钮顶 ${bar && bar.btnTop}`);
    note(`常驻栏 ${bar && bar.w}x${bar && bar.h}，距屏幕右缘 ${bar && bar.right}px`);

    // 拖到球场偏下的位置
    const cx = st.stage[0] + st.stage[2] / 2;
    const yTop = st.stage[1] + st.stage[3] * 0.18;
    const yBot = st.stage[1] + st.stage[3] * 0.82;
    await touchDrag(sess, cx, yTop, yBot, 8);
    await C.sleep(300);
    const afterDown = await C.evalx(sess, `window.__probe().paddleDisp[window.__probe().mySide]`);
    await touchDrag(sess, cx, yBot, yTop, 8);
    await C.sleep(300);
    const afterUp = await C.evalx(sess, `window.__probe().paddleDisp[window.__probe().mySide]`);
    note(`下拖后 ${afterDown}，上拖后 ${afterUp}`);
    check('★ 手指下滑，拍子跟着往下走（不是没反应）', afterDown > st.disp + 40,
      `起始 ${st.disp} -> ${afterDown}`);
    check('★ 手指上滑，拍子跟着往上走', afterUp < afterDown - 40, `${afterDown} -> ${afterUp}`);

    // ---- 4b. 手指落在拍子【左边】的留白里也要能控拍子 ----
    // 用户报的就是这个：以前监听挂在 canvas 上，球场两侧的留白完全没反应；
    // 而手正压在拍子上会挡住球，所以必须允许把手挪到旁边去。
    const leftZoneX = st.stage[0] - 45;
    check('横屏时球场左侧确实有留白可以落指', st.stage[0] >= 50,
      `stage.x=${st.stage[0]}，落点 x=${leftZoneX}`);
    const beforeZone = await C.evalx(sess, `window.__probe().paddleDisp[window.__probe().mySide]`);
    await touchDrag(sess, leftZoneX, yTop, yBot, 10);
    await C.sleep(350);
    const afterZone = await C.evalx(sess, `window.__probe().paddleDisp[window.__probe().mySide]`);
    check('★ 手指落在拍子左边的留白里，拍子照样跟着走（整屏可拖）',
      afterZone > beforeZone + 40, `${beforeZone} -> ${afterZone}`);

    // ---- 4c. 常驻栏上的触摸不能被抢成拖动 ----
    const btnRect = await C.evalx(sess, `(() => {
      const b = document.getElementById('soloLeave').getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    })()`);
    const beforeBtn = await C.evalx(sess, `window.__probe().paddleDisp[window.__probe().mySide]`);
    // 起点落在按钮上、然后往上滑 120px：若监听没有排除点击目标，拍子会跟着走 ~150px
    await touchDrag(sess, btnRect[0] + btnRect[2] / 2, btnRect[1] + btnRect[3] / 2,
      btnRect[1] + btnRect[3] / 2 - 120, 5);
    await C.sleep(350);
    const afterBtn = await C.evalx(sess, `window.__probe().paddleDisp[window.__probe().mySide]`);
    check('★ 在常驻栏上滑动不会误拖拍子（点击目标不被抢）',
      Math.abs(afterBtn - beforeBtn) < 12, `${beforeBtn} -> ${afterBtn}`);
    const stillIn = await C.evalx(sess, 'window.__probe().mySide >= 0');
    check('常驻栏上的触摸没有误触「返回菜单」', stillIn === true);
    // 对局中的样子才是真正要看的：菜单态看不出"胶囊浮在球场上会不会挡住球"
    await C.shot(sess, SHOT_DIR, 'mobile-landscape-inplay.png');

    // ---- 4d. 暂停按钮：横屏下必须真的**点得到** ----
    // 横屏块里页眉是整条 pe:none 的浮层，只有 .soundbtn 被逐层放行；
    // 暂停按钮复用了同一个类，所以"它能不能被点到"必须实测，不能靠推定。
    const pb = await C.evalx(sess, `(() => {
      const b = document.getElementById('pauseBtn');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      // ★ 先用**没有动过手脚的**样式问一次 —— 这才是"按现在这份 CSS，
      //   这一点上最上面的是谁"。反证 F8 实测过：把横屏块里的
      //   header .soundbtn { pointer-events: auto; } 那一行删掉，
      //   下面那条"临时放行"的命中断言**照样全绿**，因为它测的是
      //   "如果它能被点，它在不在最上层"，对"它到底能不能被点"完全是瞎的。
      //   两条问的是不同的问题，都得留。
      const topRaw = document.elementFromPoint(cx, cy);
      const hitRaw = !!(topRaw && (topRaw === b || b.contains(topRaw)));
      const rawEl = topRaw ? (topRaw.tagName + (topRaw.id ? '#' + topRaw.id : '')) : null;
      // ★ elementFromPoint 会跳过 pe:none 的元素，所以再临时放行、问完立刻还原
      //   （页面的持久状态一个字节都不动）。问的是"如果它能被点，这点上最上面的是不是它"。
      const saved = b.style.pointerEvents;
      b.style.pointerEvents = 'auto';
      const top = document.elementFromPoint(cx, cy);
      b.style.pointerEvents = saved;
      return {
        shown: cs.display !== 'none' && r.width > 0 && r.height > 0,
        text: b.textContent,
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.left), y: Math.round(r.top),
        hitRaw: hitRaw,
        rawEl: rawEl,
        hitSelf: !!(top && (top === b || b.contains(top))),
        topEl: top ? (top.tagName + (top.id ? '#' + top.id : '')) : null,
      };
    })()`);
    check('横屏对局中暂停按钮是显示的（且写着「暂停」）',
      !!pb && pb.shown && pb.text === '暂停', JSON.stringify(pb));
    check('★ 暂停按钮 ≥32x32（手指点得准）',
      !!pb && pb.w >= 32 && pb.h >= 32, JSON.stringify(pb));
    check('★ 按现在这份 CSS（不临时放行）这一点上最上面的就是暂停按钮本身',
      !!pb && pb.hitRaw, JSON.stringify(pb));
    check('★ 暂停按钮真的在最上层（横屏页眉整条 pe:none，只有按钮被放行）',
      !!pb && pb.hitSelf, JSON.stringify(pb));

    // 用手指点它 —— 用真实触摸事件，而不是 element.click()：
    // 要验证的正是"这根手指落在按钮上时，不会被整屏拖动逻辑抢成移动拍子"。
    await touchTap(sess, pb.x + pb.w / 2, pb.y + pb.h / 2);
    const paused = await C.waitFor(sess, 'window.__probe().userPaused === true', 3000, '触摸暂停');
    check('★ 手指点一下暂停按钮，比赛真的暂停了', paused === true);
    // ★ 必须等本地平滑把画面追平再采样。服务端在收到暂停的下一 tick 就把球冻住了，
    //   但客户端**画出来的**位置是指数逼近服务端值的（落后量 ≈ 球速/26，最多几十像素），
    //   球停下之后它还要再收几百毫秒才真正贴住。采样太早会把这段收敛尾巴
    //   当成"暂停了球还在动"（实测差 0.3~0.5px 报红）。
    await C.sleep(700);
    const pv = await C.evalx(sess, `(() => {
      const p = window.__probe();
      return { txt: p.pauseBtnText, by: p.pausedBy, my: p.mySide, ball: p.ballDisp.slice() };
    })()`);
    check('暂停后按钮自己变成「继续」', pv.txt === '继续', JSON.stringify(pv));
    check('记录的是"我按的"（pausedBy 是我的座位）', pv.by === pv.my, JSON.stringify(pv));
    await C.sleep(1000);
    const pv2 = await C.evalx(sess, 'window.__probe().ballDisp.slice()');
    check('★ 暂停期间手机上画出来的球也停住了',
      pv2[0] === pv.ball[0] && pv2[1] === pv.ball[1], `${pv.ball} -> ${pv2}`);
    await C.shot(sess, SHOT_DIR, 'mobile-landscape-paused.png');

    await touchTap(sess, pb.x + pb.w / 2, pb.y + pb.h / 2);
    const resumed = await C.waitFor(sess, 'window.__probe().userPaused === false', 3000, '触摸恢复');
    check('★ 同一个人再点一下就能恢复', resumed === true);
    // ★ 不能只看"隔 900ms 的两个采样点位置是否相同" —— 刚进球那一下球会被重置到
    //   球场正中、并停在倒计时里（实测撞到过 400,250 -> 400,250 的假红）。
    //   这里要测的性质是"恢复之后球会重新动"，所以用有界重试：
    //   4 秒内只要出现过一次位移就算过，超时才判红。
    const pv3 = await C.evalx(sess, 'window.__probe().ballDisp.slice()');
    let pvMoved = false;
    for (let t = 0; t < 16 && !pvMoved; t += 1) {
      await C.sleep(250);
      const pvN = await C.evalx(sess, 'window.__probe().ballDisp.slice()');
      pvMoved = pvN[0] !== pv3[0] || pvN[1] !== pv3[1];
    }
    check('★ 恢复后球重新动起来（4 秒内出现过位移即算过；进球重置会短暂停在中场）',
      pvMoved, `起点 ${pv3}`);

    // ---- 4e. 更窄的横屏（667×375，iPhone SE / 8 那种）----
    // 这个尺寸下球场宽 600，两侧各只剩 33px 留白，而这一栏横着有近百像素 ——
    // **任何**能点得到的常驻栏都放不进那 33px，压到球场右缘是几何上躲不掉的。
    // 所以这里不判"零重叠"（做不到，判了就是一条注定红的假要求），只判真正要紧的
    // 那条 —— 它绝不能压到**自己**的拍子活动带 —— 并把压掉多少球场如实报出来。
    await setViewport(sess, 667, 375, 2, true);
    await reload(sess, SITE);
    await clickBtnText(sess, '单人打 AI');
    const entered2 = await C.waitFor(sess, 'window.__probe && window.__probe().mySide >= 0',
      12000, '进入人机（窄横屏）');
    check('667x375 也能进入对局并拿到座位', !!entered2);
    await waitInPlay(sess, '窄横屏菜单关闭');
    const nr = await C.evalx(sess, `(() => {
      const q = (s) => { const b = document.querySelector(s).getBoundingClientRect();
        return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
      const st = q('.stage');
      const bar = q('#soloBar');
      const p = window.__probe();
      // 场地坐标 -> 屏幕：左拍 x∈[26,40]，右拍 x∈[800-26-14,800-26]，画布宽固定 800
      const sx = (x) => st[0] + st[2] * (x / 800);
      const over = (a0, a1) => !(bar[0] >= sx(a1) || bar[0] + bar[2] <= sx(a0));
      return { stage: st, bar: bar, mySide: p.mySide,
               courtRight: Math.round(st[0] + st[2]),
               overCourt: Math.max(0, Math.round(st[0] + st[2] - bar[0])),
               overOwn: over(26, 40), overAI: over(760, 774) };
    })()`);
    check('★ 667x375：常驻栏仍然不压自己的拍子活动带',
      nr.mySide === 0 && nr.overOwn === false, JSON.stringify(nr));
    note(`667x375：栏 ${JSON.stringify(nr.bar)} 球场右缘 ${nr.courtRight}`
      + ` ⇒ 压住球场 ${nr.overCourt}px；压到 AI 拍子列=${nr.overAI}`);
    await C.shot(sess, SHOT_DIR, 'mobile-landscape-narrow-inplay.png');

    // 竖屏进对局：验证提示横屏那句话在真正玩的时候也还在
    await setViewport(sess, 390, 844, 3, true);
    await reload(sess, SITE);
    await clickBtnText(sess, '单人打 AI');
    await C.waitFor(sess, 'window.__probe && window.__probe().mySide >= 0', 12000, '竖屏进人机');
    await waitInPlay(sess, '竖屏菜单关闭');
    const pIn = await C.evalx(sess, HEALTH);
    check('竖屏对局中仍然提示横屏', pIn.rotate && pIn.rotate.shown,
      JSON.stringify(pIn.rotate));
    check('竖屏对局中球场仍在视口内',
      pIn.stage && pIn.stage.y >= 0 && pIn.stage.y + pIn.stage.h <= 845,
      JSON.stringify(pIn.stage));
    // 抽屉一收起，胶囊就必须重新浮在最上层 —— 这才是它的判据
    //（菜单态下它被抽屉盖住是设计如此，所以那条断言不放在菜单那一节）
    check('★ 竖屏对局中延迟胶囊浮在最上层（抽屉收起后没被别的盖住）',
      pIn.ping && pIn.ping.shown && pIn.ping.onTop, JSON.stringify(pIn.ping));
    await C.shot(sess, SHOT_DIR, 'mobile-portrait-inplay.png');

    // ================= 5. 控制台干净 =================
    console.log('\n5. 控制台');
    const errs = sess.errors.filter((e) => !/favicon|ERR_ABORTED/i.test(e));
    check('零报错 / 零未捕获异常 / 零网络失败', errs.length === 0, errs.slice(0, 4).join(' | '));

    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    if (fail > 0) process.exitCode = 1;
  } finally {
    try { if (sess) sess.ws.close(); } catch (e) { /* ignore */ }
    C.killEdge(child);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
