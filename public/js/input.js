/**
 * 输入：键盘、触摸、以及由它们驱动的本地拍子预测。
 *
 * 这个模块**只上报意图**，不乐观更新任何界面状态 —— 按钮上的字、冷却环一律等快照回来再变。
 * 对外只暴露两样东西：setDir（渲染循环做本地预测时会调它）与三个 request*（按钮和快捷键共用）。
 * 全部发包都走 app.net.send，所以消息排队、连不上时的缓存由网络模块统一处理。
 */

(function (global) {
  'use strict';

  // 上一次已经发给服务端的朝向。用来去重：方向没变就不重复发。
  var sentDir = -99;

  var appCtx = null;
  var view = null;
  var canvas = null;
  var keys = { up: false, down: false };
  var touchTargetY = null;
  var touchActive = false;

  function setDir(d) {
    if (d !== -1 && d !== 0 && d !== 1) d = 0;
    view.dir = d;
    if (d !== sentDir) {
      sentDir = d;
      appCtx.net.send({ t: 'input', dir: d });
    }
  }

  function dirFromKeys() {
    var d = 0;
    if (keys.up) d -= 1;
    if (keys.down) d += 1;
    return d;
  }

  /**
   * 上报一次「暂停 / 继续」。按钮和 P 键都走这里，语义只有一条：
   * **按一下算一下**，切换成什么状态由服务端决定（快照里的 up / pb 才是真值）。
   * 没入座、或者比赛还没跑起来（waiting）时不发 —— 与按钮的显示条件、以及服务端
   * 那句 `room.started &&` 前提保持一致。
   */
  function requestPause() {
    if (view.mySide < 0 || view.phase === 'waiting') return;
    appCtx.net.send({ t: 'pause' });
  }

  /**
   * 上报一次「放技能」。按钮、Q 键、手机点按都走这里。
   *
   * ★ 这里的两道前置检查（有没有技能、在不在冷却）**只是省一次白跑的往返**，
   *   真正的门禁全在服务端（castSkill）。所以它们算错也只会多/少发一条消息，
   *   不会让"放不出来"或者"放出来两次"这种真问题溜过去。
   * ★ 不做任何乐观更新：按钮上的字和冷却环一律等快照回来再变，
   *   和暂停按钮同一个理由 —— 两个人同时按的时候，乐观看的状态和真值会分叉。
   */
  function requestSkill() {
    // 服务端的门禁是"必须 playing"，这里跟着一起挡 —— 倒计时/结束期间按下去
    // 只会白跑一趟，按钮却会闪一下像放出去了
    if (view.mySide < 0 || view.phase !== 'playing') return;
    var skin = view.skins[view.mySide];
    if (!(skin > 0)) return;                                  // 灰板子没有技能
    if ((view.skillCd[view.mySide] || 0) > 0.05) return;       // 冷却中
    appCtx.net.send({ t: 'skill' });
  }

  function onKey(e, down) {
    var k = e.key;
    // ★ 正在输入框里打字时，任何单键快捷键都不该生效。房间码输入框是真实存在的：
    //   在里头敲房间码时按到 m / p，会被当成"静音 / 暂停"——静音那条是本来就有的毛病，
    //   顺手一起挡住。（Enter 提交房间码由输入框自己的 onkeydown 管，不经过这里。）
    var tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    // 静音键放在最前面：否则开局的覆盖层会把后面的分支顺序影响掉
    if (down && (k === 'm' || k === 'M')) { appCtx.audio.toggleSound(); return; }
    // 暂停快捷键。和点按钮走同一条路（只上报意图，界面状态等服务端回话）
    if (down && (k === 'p' || k === 'P')) { requestPause(); return; }
    // 技能快捷键（电脑端）。手机端靠点那个按钮，不走键盘。
    if (down && (k === 'q' || k === 'Q')) { requestSkill(); return; }
    var isUp = (k === 'ArrowUp' || k === 'w' || k === 'W');
    var isDown = (k === 'ArrowDown' || k === 's' || k === 'S');
    if (!isUp && !isDown) return;
    e.preventDefault();
    if (isUp) keys.up = down;
    if (isDown) keys.down = down;
    touchTargetY = null;
    if (view.mySide >= 0) setDir(dirFromKeys());
  }

  // 触屏：★ 绑在 window 上而不是 canvas 上。原因有两个，都是手机上真遇到的事：
  //   1. 手机横屏时球场两侧各有一段留白（球场固定 1.6，屏幕普遍更宽），
  //      拇指落在**自己拍子左边**那片留白里时，以前完全没有反应；
  //   2. 手正压在拍子上拨，手掌就把球挡掉一半。
  //   现在整屏任何位置按下都能拖，玩家可以把手指挪到旁边不碍事的地方。
  //   只排除真正的点击目标（按钮 / 菜单 / 常驻栏 / 横屏提示），免得把点击抢成拖动。
  var touchActive = false;

  function touchHitsUI(target) {
    return !!(target && target.closest
      && target.closest('button, a, input, select, textarea, .overlay, .panelbox, .solobar, .rotatetip'));
  }

  function touchY(ev) {
    var t = ev.touches && ev.touches[0];
    if (!t) return null;
    var rect = canvas.getBoundingClientRect();
    if (!rect.height) return null;
    // 落点允许高于/低于球场：夹到 [0, view.H]，等价于把拍子推到顶/底。
    // 不夹的话在竖屏（画布上下留白很大）会算出一个离谱的目标值。
    var y = (t.clientY - rect.top) / rect.height * view.H;
    if (!isFinite(y)) return null;
    return Math.max(0, Math.min(view.H, y));
  }

  function onTouchStart(e) {
    if (view.mySide < 0) return;
    if (touchHitsUI(e.target)) return;
    var y = touchY(e);
    if (y === null) return;
    touchActive = true;
    touchTargetY = y;
    e.preventDefault();
  }

  function onTouchMove(e) {
    if (!touchActive) return;
    if (view.mySide < 0) { touchActive = false; return; }
    var y = touchY(e);
    if (y === null) return;
    touchTargetY = y;
    e.preventDefault();
  }

  function onTouchEnd(e) {
    if (!touchActive) return;
    touchActive = false;
    touchTargetY = null;
    setDir(0);
    if (e && e.cancelable) e.preventDefault();
  }

  /**
   * 装上输入模块。
   *
   * @param {object} app 应用上下文。
   * @returns {object} 输入模块对外的接口。
   */
  function attach(app) {
    appCtx = app;
    view = app.view;
    canvas = app.dom.canvas;

    window.addEventListener('keydown', function (e) { onKey(e, true); });
    window.addEventListener('keyup', function (e) { onKey(e, false); });
    window.addEventListener('blur', function () {
      keys.up = false; keys.down = false;
      setDir(0);
    });

    // ★ passive:false 是必须的：onTouchStart / onTouchMove 里要 preventDefault，
    //   否则浏览器会先滚动/缩放，手感是"拖不动"。
    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);

    var api = {
      setDir: setDir,
      requestPause: requestPause,
      requestSkill: requestSkill,
      // 渲染循环做本地预测时要读触摸目标（决定这一帧该往哪边走）
      getTouchTargetY: function () { return touchTargetY; },
      // 断线重连后必须清掉去重记忆，否则"当前还是这个朝向"就不会重发，
      // 新连接上的服务端会一直保持上一个方向，直到玩家真的再按一次。
      resetSentDir: function () { sentDir = -99; }
    };
    app.input = api;
    return api;
  }

  global.PongApp = global.PongApp || {};
  global.PongApp.input = attach;
})(window);
