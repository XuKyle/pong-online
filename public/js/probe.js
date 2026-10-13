/**
 * 探针钩子：浏览器探针读取页面状态的唯一入口。
 *
 * ★ 这四个名字、字段名、取整口径都是**对外契约** —— tools/ 下的探针按字面量取，
 *   改动任何一个都会让"探针红了"却不知道是页面坏了还是接口改了。
 *   新增字段随便加，**改名/改口径不行**；要改就先改探针。
 *
 * ★ 它装在**最后**：读的是所有模块装好之后的 app，所以这里不需要任何初始化。
 */

(function (global) {
  'use strict';

  function install(app) {
    // 下面这些名字原来都是那个 IIFE 里的闭包变量。搬进模块之后它们各有各的归属，
    // 所以统一在这里从 app 上取一份 —— 字段名和取整口径一个字都没动。
    var view = app.view;
    var overlay = app.dom.overlay;
    var pauseBtn = app.dom.pauseBtn;
    var canvas = app.dom.canvas;
    var skillBtnEls = app.dom.skillBtnEls;
    var mySkin = app.ui.getSkin();
    var POWERUP_MAX = app.POWERUP_MAX;
    var POWERUP_STYLE = app.POWERUP_STYLE;
    var SKIN_COL = app.SKIN_COL;
    var SKIN_NAMES = app.SKIN_NAMES;
    var SKIN_GLYPH = app.SKIN_GLYPH;
    var SKIN_CD_S = app.SKIN_CD_S;
    var WIN_SCORE = app.WIN_SCORE;
    var WIN_MARGIN = app.WIN_MARGIN;
    var PADDLE_MARGIN = app.PADDLE_MARGIN;
    var PADDLE_W = app.PADDLE_W;
    var PADDLE_H = app.PADDLE_H;
    var ballVis = app.ballVis;
    var teamOfMine = app.teamOfMine;
    var paddleFill = app.render.paddleFill;
    var skinFill = app.render.skinFill;

    // 给自动化测试读取内部状态用，正常玩不受影响
    window.__probe = function () {
      return {
        connected: view.connected,
        mySide: view.mySide,
        code: view.code,
        phase: view.phase,
        score: view.score.slice(),
        snaps: view.snaps,
        rtt: Math.round(view.rtt),
        drops: view.drops,
        samples: view.intervals.length,
        tickRate: Math.round(view.tickRate * 10) / 10,
        tickRaw: view.tickRate,     // 未取整的原始值：出问题时一眼能分辨"还没算出来"还是"被污染"
        paddle: view.paddles.slice(),
        // 本地预测位置。服务端值一定是被夹住的，光看它验不出客户端的范围限制 ——
        // coop 里"上半场那位推不过中线"主要发生在本地预测这一层。
        paddleDisp: view.paddleDisp.map(function (v) { return Math.round(v * 10) / 10; }),
        tail: view.balls.length ? (view.tails[view.balls[0].id] || []).length : 0,
        // 场上**所有**球的服务端真值 [[x,y], ...]（分裂球会不止一个）
        balls: view.balls.map(function (b) { return [Math.round(b.x), Math.round(b.y)]; }),
        ballIds: view.balls.map(function (b) { return b.id; }),
        // **画出来**的所有球（平滑之后的位置）
        ballDisps: view.balls.map(function (b) {
          var d = view.ballDisps[b.id] || { x: b.x, y: b.y };
          return [Math.round(d.x * 10) / 10, Math.round(d.y * 10) / 10];
        }),
        // 兼容字段：0 号球。单球模式（未吃分裂球）下与 balls[0] / ballDisps[0] 完全相同，
        // 这样既有探针不必改。多球时以 balls / ballDisps 为准。
        ball: view.balls.length ? [Math.round(view.balls[0].x), Math.round(view.balls[0].y)] : [0, 0],
        ballDisp: (function () {
          if (!view.balls.length) return [0, 0];
          var d0 = view.ballDisps[view.balls[0].id] || { x: view.balls[0].x, y: view.balls[0].y };
          return [Math.round(d0.x * 10) / 10, Math.round(d0.y * 10) / 10];
        })(),
        present: view.present.slice(),
        overlayHidden: overlay.classList.contains('hidden'),
        // 真人主动暂停：状态 + 是谁按的 + 按钮当时写着什么/在不在
        userPaused: !!view.userPaused,
        pausedBy: view.pausedBy,
        pauseBtnText: pauseBtn ? pauseBtn.textContent : null,
        pauseBtnShown: !!(pauseBtn && pauseBtn.style.display !== 'none'),
        // ---- 皮肤与技能 ----
        skins: view.skins.slice(),
        skillCd: view.skillCd.slice(),
        boostArmed: view.boostArmed.slice(),
        winds: view.winds.map(function (w) { return w.slice(); }),
        phantom: view.phantom.slice(),
        stickArmed: view.stickArmed.slice(),
        stuckBall: view.stuckBall ? view.stuckBall.slice() : 0,
        holes: view.holes.map(function (h) { return h.slice(); }),
        chaos: view.chaos.slice(),
        blockCharges: view.blockCharges.slice(),
        slowLeft: view.slowLeft.slice(),
        canReselect: view.canReselect,
        mySkin: view.mySide >= 0 ? (view.skins[view.mySide] || 0) : -1,
        // 菜单里"我当前选的"那一个（还没入房时也有效）。
        // 和 mySkin 分开：mySkin 是**服务端确认过的**、入房后才有效；
        // menuSkin 是本地的选择，用来验证"点了色块到底生效没有"。
        menuSkin: app.ui.getSkin(),
        skinColors: SKIN_COL.slice(),
        skinNames: SKIN_NAMES.slice(),
        skinGlyphs: SKIN_GLYPH.slice(),
        skinCdSec: SKIN_CD_S.slice(),
        // 拍子**画出来**的填充色（皮肤色）。和 paddleColors（身份色，描边用）分开报，
        // 探针就能分别核对"颜色 = 技能"和"coop 里两条拍子互相分得开"这两条。
        paddleSkin: view.slots.map(function (_, i) { return app.render.skinFill(i, false); }),
        // 技能按钮的**实际状态**，不是"按逻辑推出来的"：位置、显隐、写了什么字、类名。
        // 探针要在真实布局上核对（比如"它到底有没有盖住球场"），不能靠复述代码里的判断。
        skillBtns: skillBtnEls.map(function (el, i) {
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return {
            shown: el.style.display !== 'none' && r.width > 0,
            text: el.textContent,
            cls: el.className,
            x: Math.round(r.left), y: Math.round(r.top),
            w: Math.round(r.width), h: Math.round(r.height),
            mine: i === view.mySide,
            skin: view.skins[i] || 0
          };
        }),
        handshakeMs: view.handshakeMs,
        canvasSize: [canvas.width, canvas.height],
        // 场上道具：**数组**（可以同时有好几个），每一项是 [x, y, 类型]
        powerups: view.powerups.map(function (u) { return u.slice(); }),
        puMax: POWERUP_MAX,
        // 让探针能核对"九种道具都有专属样式"，而不是全都静默落到兜底那一款
        puKinds: POWERUP_STYLE.length,
        puGlyphs: POWERUP_STYLE.map(function (s) { return s.label; }),
        paddleMul: view.paddleMul.slice(),
        freeze: view.freeze.slice(),
        shield: view.shield.slice(),
        double: view.double.slice(),
        // 隐形球：各队"看不见球"还剩几秒 / 各队看到的球有多不透明（1 = 看得见）。
        // ★ 球到底画了没有不属于这两个值 —— 探针要自己去画布上取证（抓 arc 调用），
        //   否则就变成"拿输入断言输入"了。
        invis: view.invis.slice(),
        invisAlpha: view.invisAlpha.slice(),
        // 我这一侧的观看透明度（ballVis 的返回值），以及"我是不是被隐形了"
        ballVis: app.ballVis(),
        myTeam: app.teamOfMine(),
        solo: view.solo,
        coop: view.coop,
        mode: view.mode,
        // 布局探针要能核对"左边两条各守半场、右边一条守全场"
        slotEdges: view.slots.map(function (s) { return s.edge; }),
        slotTeams: view.slots.map(function (s) { return s.team; }),
        slotSpans: view.slots.map(function (s) { return s.span.slice(); }),
        // 拍子**画出来**的颜色（不是"按队推出来"的）。coop 里两名真人必须各不相同，
        // 靠这个能在探针里直接断言，不用去比截图颜色。
        paddleColors: view.slots.map(function (_, i) { return app.render.paddleFill(i, false); }),
        // 供探针做像素级检查。canvas 像素坐标 = 场地坐标 × dpr
        geom: {
          court: [view.W, view.H], margin: PADDLE_MARGIN,
          paddleW: PADDLE_W, paddleH: PADDLE_H,
          dpr: canvas.width / view.W
        },
        curve: view.curve,
        botLevel: view.botLevel,
        botName: view.botName,
        bgmBase: app.audio.snapshot().base,
        bgmSrc: app.audio.snapshot().src,
        winScore: WIN_SCORE,
        winMargin: WIN_MARGIN
      };
    };

    // BGM 专用钩子：音频"有没有在响"是运行期状态，光看代码和截图都验不了。
    // 读的都是 app.audio.snapshot()，探针看到的字段和取值口径与搬动之前完全一致。
    window.__bgm = function () {
      var a = app.audio.snapshot();
      var el = a.el;
      if (!el) {
        return { el: null, soundOn: a.soundOn, src: a.src, ready: a.ready, failed: a.failed };
      }
      return {
        src: el.currentSrc || el.src,
        loop: el.loop,
        paused: el.paused,
        volume: Math.round(el.volume * 10000) / 10000,
        readyState: el.readyState,
        duration: Math.round((el.duration || 0) * 100) / 100,
        cur: Math.round(a.cur * 10000) / 10000,
        want: Math.round(a.want * 10000) / 10000,
        base: a.base,
        ready: a.ready,
        failed: a.failed,
        soundOn: a.soundOn,
        ctxState: a.ctxState,
        btn: (document.getElementById('sfxBtn') || {}).textContent || ''
      };
    };
    window.__setSound = function (on) { app.audio.setSound(on); return window.__bgm(); };
    window.__bgmSrc = function () { return app.audio.snapshot().src; };
  }

  global.PongApp = global.PongApp || {};
  global.PongApp.probe = install;
})(window);
