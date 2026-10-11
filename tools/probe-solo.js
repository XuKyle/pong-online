'use strict';

/**
 * 人机对战的前端验证（真实浏览器）。
 *
 * 为什么要单独做：协议层能证明"AI 会打球"，证明不了**前端把人机模式接对了**。
 * 特别是这几处只有在浏览器里点一遍才会暴露：
 *   · 菜单里的「人机对战」按钮与三档难度选择真的可用
 *   · 点完之后界面真的换成了人机（而不是还显示邀请链接让人去拉人）
 *   · 常驻的「返回菜单」真的能退出（solo 时画布上没有遮罩，退出入口只在这里）
 *
 * 用法: PROBE_SITE=http://127.0.0.1:3100 node tools/probe-solo.js
 */

const fs = require('fs');
const path = require('path');
const C = require('./cdp.js');

const DBG_PORT = Number(process.env.PROBE_DBG_PORT) || 9401;
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

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [ok]   ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}
const note = (m) => console.log(`  · ${m}`);

/** 真实鼠标点一个元素：先用 rect 求中心，再派发真事件（isTrusted 才算用户手势） */
async function clickSel(sess, sel) {
  const box = await C.evalx(sess, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    // ★ 先滚进视野再取坐标（菜单比以前长了，理由同 clickBtnText）
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
  })()`);
  if (!box) return null;
  await C.realClick(sess, box.x, box.y);
  return box;
}

/**
 * 按按钮文案精确点击。
 * ★ 不能用 `#overlayBody button.ghost` —— 菜单里「加入」也是 ghost，
 *   按选择器会点到第一个（加入），而不是「人机对战」。这种错点不会报错，
 *   只会让后续所有断言都跑在错误的界面上。
 */
async function clickBtnText(sess, text) {
  const box = await C.evalx(sess, `(() => {
    const el = [...document.querySelectorAll('#overlayBody button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    // ★ 必须**先滚进视野**再取坐标。菜单是可滚动的（手机端是整屏抽屉），
    //   而第 12 轮把皮肤选择从一行四个色块改成九宫格之后，菜单明显变长了 ——
    //   "单人打 AI"在 1280×820 里被推到了折叠线以下，真实鼠标按 rect 中心点就
    //   落在视口外，点了等于没点（症状是"入房超时 / side=-1"，看着像产品坏了）。
    //   probe-skills 的 clickEl 一直这么做，这里补上。
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
  })()`);
  if (!box) return null;
  await C.realClick(sess, box.x, box.y);
  return box;
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const { edge, child, profile } = C.startEdge({
    dbgPort: DBG_PORT, tmpDir: TMP_DIR, profileName: 'edgesolo',
  });
  console.log(`浏览器: ${edge}\n页面:   ${SITE}\n`);

  let sess = null;
  try {
    if (!await C.waitEdgeReady(DBG_PORT)) throw new Error('调试端口没起来');

    console.log('1) 打开页面');
    sess = await C.openPage({ dbgPort: DBG_PORT }, SITE);
    const ready = await C.waitReady(sess, 'S');
    check('页面加载并完成脚本初始化', ready);
    if (!ready) throw new Error('页面未就绪');

    // 量具自检：先证明取值通道是活的
    const sanity = await C.evalx(sess, '1+1');
    check('取值通道正常（1+1=2）', sanity === 2, `得到 ${sanity}`);

    await C.waitFor(sess, 'window.__probe().connected === true', 10000, 'WebSocket 连接');
    const p0 = await C.probe(sess);
    check('WebSocket 已连接', p0.connected === true);
    check('初始停在菜单（未入房）', p0.mySide === -1, `mySide=${p0.mySide}`);

    console.log('\n2) 菜单里确实有人机入口与三档难度');
    const menu = await C.evalx(sess, `(() => {
      const btns = [...document.querySelectorAll('#overlayBody button')].map(b => b.textContent);
      const segs = [...document.querySelectorAll('#overlayBody .seg')].map(b => b.textContent);
      return { btns, segs };
    })()`);
    check('菜单里有「人机对战」按钮', menu.btns.indexOf('单人打 AI') >= 0, JSON.stringify(menu.btns));
    check('菜单里仍有「创建房间」（双人）', menu.btns.indexOf('创建房间') >= 0);
    check('菜单里有「加入」（双人）', menu.btns.indexOf('加入') >= 0);
    check('难度有三档且顺序正确',
      menu.segs.join(',') === '简单,普通,困难', JSON.stringify(menu.segs));
    check('默认选中「普通」',
      (await C.evalx(sess, "document.querySelectorAll('.seg')[1].className")).indexOf('on') >= 0);

    console.log('\n3) 选「困难」并开局');
    const seg = await clickSel(sess, '#overlayBody .segrow .seg:nth-child(3)');
    check('点到了第三档难度', !!seg, seg ? seg.text : 'null');
    const onCls = await C.evalx(sess, "document.querySelectorAll('.seg')[2].className");
    check('点完之后「困难」被标为选中', onCls.indexOf('on') >= 0, onCls);

    const soloBox = await clickBtnText(sess, '单人打 AI');
    note(`点击的按钮文案: ${soloBox ? soloBox.text : 'null'}`);
    check('确实点到了「人机对战」而不是别的 ghost 按钮',
      !!soloBox && soloBox.text === '单人打 AI', soloBox ? soloBox.text : 'null');

    const joined = await C.waitFor(sess, 'window.__probe().mySide >= 0', 10000, '入房');
    check('人机开局成功（进入房间）', joined === true);

    const p1 = await C.probe(sess);
    check('前端识别为 solo 模式', p1.solo === true, JSON.stringify(p1.solo));
    check('难度带到前端（困难 = 2）', p1.botLevel === 2, String(p1.botLevel));
    check('对手名称正确', p1.botName === '困难', String(p1.botName));
    check('坐在左边（side 0）', p1.mySide === 0, String(p1.mySide));

    console.log('\n4) 界面切到人机，且不需要第二个人');
    const hid = await C.waitFor(sess, 'window.__probe().overlayHidden === true', 5000,
      '遮罩自动隐藏（AI 算在场）');
    check('遮罩自动撤掉（直接能看到比赛）', hid === true);
    const bar = await C.evalx(sess, `(() => {
      const b = document.getElementById('soloBar');
      const lab = document.getElementById('soloLabel');
      return { display: getComputedStyle(b).display, label: lab ? lab.textContent : null };
    })()`);
    check('常驻栏已显示', bar.display !== 'none', JSON.stringify(bar));
    check('常驻栏写明对手是 AI·困难',
      !!bar.label && bar.label.indexOf('AI') >= 0 && bar.label.indexOf('困难') >= 0, String(bar.label));

    const noInvite = await C.evalx(sess,
      "document.querySelectorAll('#overlayBody .code').length === 0");
    check('没有显示邀请房间码（人机不需要邀请）', noInvite === true);

    console.log('\n5) 观察：比赛在跑，AI 在动');
    // ★ 这里**不能固定只看 6 秒**。这一节真人是完全不动的（按键测试在下一节），
    //   两边拍子都停在中心时，球会打一条水平直线 —— AI 算出来的落点自始至终都是 250，
    //   于是"拍子一动不动"是**正确行为**，不是"AI 成了装饰"。
    //   实测：对照组 20 个采样里有 17 个都是 250，只在最后 0.9 秒才动；固定窗口
    //   一旦整段落进这种回合就必红（线上约 1/4 概率）。
    //   ⇒ 改成"等到它真动过为止（上限 40 秒）"。
    //   ★ 这样写**不是**自证（没有"绿了就提前退出所以恒绿"）：
    //     真坏掉的 AI 永远不会动 ⇒ 循环跑满 40 秒也等不到 ⇒ span 仍是 0 ⇒ 照样红。
    //     提前退出只是"一旦看到它动就可以不再等"，判据本身仍然是可反驳的。
    //   另外把"AI 被隐形球蒙住 / 被冰冻"的帧排除掉 —— 那两种状态下拍子本来就该停。
    const a0 = await C.probe(sess);
    const samples = [];
    const tStart = Date.now();
    let moved = false;
    // ★ 最短窗口 2.5 秒，不是"能提前退就提前退"。
    //   客户端算 tickRate 用的是 2 秒滑动窗口（见 index.html 里 `t - view.tkWinStart >= 2000`），
    //   起步值是 0，攒不满 2 秒它就一直是 0 —— 提前退出会让下面那条"推进频率 30Hz"假红。
    const MIN_WINDOW_MS = 2500;
    const usableYs = () => samples.filter((r) => !r.blind && !r.frozen).map((r) => r.y);
    while (Date.now() - tStart < 40000) {
      await C.sleep(300);
      const s = await C.probe(sess);
      const b0 = (s.balls || [])[0] || [0, 0];
      samples.push({
        y: s.paddle[1],
        bx: b0[0],
        by: b0[1],
        n: (s.balls || []).length,
        blind: (s.invis && s.invis[1] > 0) || false,   // 1 队 = AI 被隐形
        frozen: (s.freeze && s.freeze[1] > 0) || false,
        ph: s.phase,
        sc: s.score,
      });
      const u = usableYs();
      const spent = Date.now() - tStart;
      if (spent >= MIN_WINDOW_MS && u.length >= 3
          && Math.max(...u) - Math.min(...u) > 20) { moved = true; break; }
    }
    const elapsed = (Date.now() - tStart) / 1000;
    const a1 = await C.probe(sess);

    const hz = (a1.snaps - a0.snaps) / elapsed;
    check('持续收到状态快照', hz > 24 && hz < 36, `实测 ${hz.toFixed(1)} 次/秒（窗口 ${elapsed.toFixed(1)}s）`);
    check('服务端推进频率正常', a1.tickRate > 27 && a1.tickRate < 33, `${a1.tickRate} 次/秒`);
    check('没有掉线', a1.drops === 0, String(a1.drops));
    check('比赛处于比赛阶段（不是等待）', a1.phase !== 'waiting', String(a1.phase));

    const usable = usableYs();
    const span = usable.length ? Math.max(...usable) - Math.min(...usable) : 0;
    const blindN = samples.filter((r) => r.blind).length;
    const frozenN = samples.filter((r) => r.frozen).length;
    check('★ AI 的拍子确实在动（不是钉死的）', moved && usable.length >= 5 && span > 20,
      moved
        ? `${elapsed.toFixed(1)} 秒内纵向跨度 ${span.toFixed(0)}px（${usable.length} 个可用采样）`
        : `等了 ${elapsed.toFixed(0)} 秒一次都没动过 —— 可用采样 ${usable.length} 个（另有 `
          + `${blindN} 帧被隐形 / ${frozenN} 帧被冰冻），跨度 ${span.toFixed(0)}px`);
    if (blindN || frozenN) {
      note(`排除 ${blindN} 帧被隐形 / ${frozenN} 帧被冰冻（这两种状态下拍子本来就该停）`);
    }
    note(`AI 拍子采样: ${samples.map((r) => r.y.toFixed(0)).join(', ')}`);
    // 红了就把每帧摊开：这一窗里球到底有没有朝 AI 飞过、AI 有没有被蒙住。
    // 只在失败时打印（成功时打这一大坨没人看），是"红了能自解释"的最低成本做法。
    if (!moved) {
      note('失败明细: 序号 拍y  球x  球y 球数 阶段      比分   盲 冻');
      samples.forEach((r, i) => note(
        `  ${String(i).padStart(2)} ${String(r.y).padStart(6)} ${String(Math.round(r.bx)).padStart(5)}`
        + ` ${String(Math.round(r.by)).padStart(5)} ${String(r.n).padStart(4)} ${String(r.ph).padEnd(9)}`
        + ` ${JSON.stringify(r.sc).padEnd(7)} ${r.blind ? 'B' : '-'}${r.frozen ? 'F' : '-'}`));
    }

    console.log('\n6) 真按键：我的拍子能动');
    const before = await C.probe(sess);
    await C.key(sess, 'rawKeyDown', 'ArrowUp', 38);
    await C.sleep(700);
    await C.key(sess, 'keyUp', 'ArrowUp', 38);
    await C.sleep(400);
    const after = await C.probe(sess);
    check('按 ↑ 后自己的拍子上移',
      after.paddle[0] < before.paddle[0] - 20,
      `${before.paddle[0]} -> ${after.paddle[0]}`);

    console.log('\n7) ★ 刚退出就马上再开一局（socket 还在重连窗口里）');
    // 刻意在同一个 tick 里连点两下。
    // leaveRoom() 关掉连接后要等 120ms 才重连，而 sock.close() 是同步把
    // readyState 打到 2(CLOSING) 的 —— 这个窗口比一次 CDP 往返还宽，真人完全
    // 可能踩进去。早年间 send() 在这里静默 return，而按钮已经把自己禁用了，
    // 结果就是"点不动也退不出"，只能刷新页面。
    const race = await C.evalx(sess, `(() => {
      const hit = (el) => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        }));
      };
      const leave = document.getElementById('soloLeave');
      if (!leave) return { ok: false, why: '找不到「返回菜单」' };
      hit(leave);
      // 记下"退出后、重开前"的中间态，确认退出本身是干净的
      const mid = {
        mySide: window.__probe().mySide,
        barHidden: getComputedStyle(document.getElementById('soloBar')).display === 'none',
        segs: document.querySelectorAll('#overlayBody .seg').length,
      };
      const solo = [...document.querySelectorAll('#overlayBody button')]
        .find((b) => b.textContent.trim() === '单人打 AI');
      if (!solo) return { ok: false, why: '退出后菜单里没有「人机对战」', mid };
      hit(solo);
      return { ok: true, mid, disabled: solo.disabled, text: solo.textContent };
    })()`);
    check('退出与重开能在同一个 tick 内接连完成', !!(race && race.ok === true),
      JSON.stringify(race));
    if (race && race.mid) {
      check('退出那一下是干净的（回到菜单、常驻栏收起）',
        race.mid.mySide === -1 && race.mid.barHidden === true && race.mid.segs === 3,
        JSON.stringify(race.mid));
    }
    // ★ 不能只等 `mySide >= 0`：退出与重开挤在同一个 tick 里，那一刻读到的
    //   mySide / score 有可能还是**退出前那一局**的残留值（实测踩到过：明明是重开的新局，
    //   却读到旧局的 score=[0,1]）。新的一局必然是一个新的房间码 —— 用它当判据。
    const codeBefore = p1.code;
    check('重开前先记下了旧房间码（下面靠它确认换的是新房间）',
      /^[A-Z0-9]{6}$/.test(codeBefore || ''), String(codeBefore));
    const joined2 = await C.waitFor(sess,
      `window.__probe().mySide >= 0 && window.__probe().code !== ${JSON.stringify(codeBefore)}`,
      8000, '第二次入房');
    check('★ 立刻重开一局真的进去了（create 没被丢掉）', joined2 === true);
    check('★ 而且换的是一个**新房间**（不是又坐回旧那局）',
      joined2 === true && (await C.probe(sess)).code !== codeBefore,
      `old=${codeBefore} now=${joined2 ? (await C.probe(sess)).code : '?'}`);
    // ★ 房间码换新 ≠ 比分已经换新。`code` 在入房回执那一刻就变了，而 `view.score`
    //   要等**新房间的第一帧快照**到达才刷 —— 中间那段空窗里读到的还是上一局的比分。
    //   上一局如果是 0:1（真人这一节不动，接不到就丢一分），这里就会红成
    //   "side=0 score=[0,1]"：看着像"重开没清零"，其实只是**读早了**。
    //   （线上 RTT 让这段空窗比本地明显得多 —— 本地全绿、线上约 1/4 概率红。）
    //   新房间必定先经过 countdown + 0:0，所以等这一帧真的出现再断言。
    const fresh = await C.waitFor(sess,
      `(() => { const p = window.__probe();
         return (p.code !== ${JSON.stringify(codeBefore)} && p.score[0] === 0 && p.score[1] === 0)
           ? { code: p.code, score: p.score, side: p.mySide } : null; })()`,
      8000, '新房间的第一帧（比分归零）');
    const p2 = await C.probe(sess);
    check('重开的是人机局，难度仍是「困难」',
      p2.solo === true && p2.botLevel === 2, `solo=${p2.solo} level=${p2.botLevel}`);
    check('坐在左边，比分从头开始',
      p2.mySide === 0 && !!fresh,
      `side=${p2.mySide} code=${p2.code} 新房间首帧=${fresh ? JSON.stringify(fresh.score) : '没等到'}`);

    const barAgain = await C.evalx(sess, `(() => {
      const b = document.getElementById('soloBar');
      return { display: getComputedStyle(b).display,
               label: (document.getElementById('soloLabel') || {}).textContent };
    })()`);
    check('常驻栏又出现了（退出入口没丢）',
      barAgain.display !== 'none' && String(barAgain.label).indexOf('AI') >= 0,
      JSON.stringify(barAgain));

    console.log('\n8) 页面报错检查');
    const errs = sess.errors.filter((e) => e.indexOf('[网络]') !== 0);
    check('没有未捕获异常', errs.length === 0, errs.slice(0, 3).join(' ; '));

    console.log('\n9) 普通的「返回菜单」');
    const left = await clickSel(sess, '#soloLeave');
    check('点到了「返回菜单」', !!left, left ? left.text : 'null');
    const back = await C.waitFor(sess, 'window.__probe().mySide === -1', 8000, '回到菜单');
    check('确实退出了房间', back === true);
    const barAfter = await C.evalx(sess,
      "getComputedStyle(document.getElementById('soloBar')).display");
    check('常驻栏已隐藏', barAfter === 'none', barAfter);
    const menuBack = await C.evalx(sess,
      "document.querySelectorAll('#overlayBody .seg').length");
    check('回到了菜单（难度选择又出现了）', menuBack === 3, String(menuBack));

    // 截图时回到人机局内，方便肉眼看画面
    console.log('\n10) 再来一局并截图');
    await clickSel(sess, '#overlayBody .segrow .seg:nth-child(3)');
    await clickBtnText(sess, '单人打 AI');
    await C.waitFor(sess, 'window.__probe().mySide >= 0', 8000, '第三次入房');
    await C.sleep(3000);
    await C.shot(sess, SHOT_DIR, 'solo-ai.png');
    const size = fs.statSync(path.join(SHOT_DIR, 'solo-ai.png')).size;
    check('截图非空', size > 3000, `${size}B`);
    const ps = await C.probe(sess);
    note(`截图时状态: solo=${ps.solo} 难度=${ps.botName} 比分=${JSON.stringify(ps.score)} `
      + `冻结=${JSON.stringify(ps.freeze)} 护盾=${JSON.stringify(ps.shield)} 双倍=${JSON.stringify(ps.double)}`);
    check('新道具状态字段都到位',
      Array.isArray(ps.freeze) && Array.isArray(ps.shield) && Array.isArray(ps.double));
    // 上一次踩过的坑：第三次入房其实没进去，截图拍的是菜单，而这里只看字段类型，
    // 于是"全绿"。场景断言必须落到"确实在人机局里"。
    check('截图这一刻确实在人机局里',
      ps.solo === true && ps.mySide === 0 && ps.botName === '困难',
      `solo=${ps.solo} side=${ps.mySide} bot=${ps.botName}`);

    console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========\n`);
  } catch (e) {
    console.log('\n探针中断: ' + e.message + '\n');
    fail += 1;
  } finally {
    try { if (sess) sess.ws.close(); } catch (e) {}
    await C.sleep(300);
    C.killEdge(child);
    await C.sleep(800);
    console.log(`（浏览器进程已清理，profile: ${profile}）`);
    process.exit(fail === 0 ? 0 : 1);
  }
}

main();
