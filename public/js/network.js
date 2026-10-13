/**
 * 网络：WebSocket 连接、掉线重连、往返时延测量，以及断线重连用的座位凭证。
 *
 * 这个模块是**唯一**碰 WebSocket 的地方，也是唯一发包的入口
 * （挂到 app.net.send 上）。连不上时建房/加入会被排队，连上后补发 ——
 * 所以"点了按钮没反应"和"点得太快丢了"是两回事，这里只管前者。
 *
 * 凭证存 sessionStorage 而不是 localStorage：座位属于「这个标签页」。
 * 若用 localStorage，同一浏览器开第二个标签页试玩时会读到第一个的凭证，
 * 拿着对方的身份去重连，把对方挤下线 —— 想在本地双开自测就直接中招。
 */

(function (global) {
  'use strict';

  var appCtx = null;
  var view = null;

  var sock = null;
  var retryTimer = null;
  var retryDelay = 800;
  var closingByUs = false;
  var pingTimer = null;
  var pendingSends = [];
  var pendingTimer = null;
  // URL 里带进来的邀请码，只在首次连接时用一次
  var pendingCode = null;
  // 建房/加入这类"没有连接也���该记住意图"的消息
  var QUEUEABLE = { create: 1, join: 1 };

  // ---------- 会话（用于断线重连） ----------
  // 用 sessionStorage 而不是 localStorage：座位属于「这个标签页」。
  // 若用 localStorage，同一浏览器开第二个标签页试玩时会读到第一个的凭证，
  // 拿着对方的身份去重连，把对方挤下线 —— 想在本地双开自测就直接中招。
  // sessionStorage 每个标签页独立，刷新仍在，关掉即清。
  var SESSION_KEY = 'pong-online-session-v1';

  function saveSession(code, token, side) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: code, token: token, side: side }));
    } catch (e) {}
  }
  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  // ---------- 画布尺寸 ----------

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  // 连上之后该干什么，只在这里判断一次。
  // 之前这段逻辑散在 onopen 和启动流程两处，会同时触发导致界面来回跳。
  function onConnected() {
    // 断线期间用户已经点了"建房 / 加入" → 以那个意图为准。
    // 不能先自动坐回旧座位：那会连发两条 join，把房间搞乱。
    if (flushPending()) return;

    var s = readSession();

    // 座位还在：优先坐回原位，比分和场上位置都能保住
    if (s && s.code && s.token && (!pendingCode || pendingCode === s.code)) {
      send({ t: 'rejoin', code: s.code, token: s.token });
      return;
    }

    // 带着邀请码进来的：把菜单打开、把码替你填好，让**从链接进来的人也能选拍子**。
    // ★ 以前这里是"直接 join"，代价是拿链接的人永远没有机会选皮肤 —— 而皮肤就是技能，
    //   等于一半的玩家用不了这个功能。现在改成停在菜单上，多一次点击换每个人都能挑。
    if (pendingCode) {
      var code = pendingCode;
      pendingCode = null;          // 用掉就清掉，防止重连时重复加入
      clearSession();
      appCtx.ui.showMenu(null, code);
      return;
    }

    appCtx.ui.showMenu();
  }

  function connect() {
    if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;

    appCtx.ui.setBadge('连接中…', 'warn');
    var startedAt = performance.now();
    var url = wsUrl();
    view.wsUrl = url;

    try {
      sock = new WebSocket(url);
    } catch (e) {
      onDown('无法创建连接');
      return;
    }

    sock.onopen = function () {
      view.connected = true;
      view.handshakeMs = Math.round(performance.now() - startedAt);
      view.extensions = sock.extensions || '';
      retryDelay = 800;
      appCtx.input.resetSentDir();   // 换连接了，朝向要重新报一次，别让去重把它吃掉
      appCtx.ui.setBadge('已连接', 'ok');
      startPing();
      onConnected();
      appCtx.diag.renderMeters();
    };

    sock.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleServer(m);
    };

    sock.onclose = function () {
      if (closingByUs) { closingByUs = false; return; }
      onDown('连接已断开');
    };

    sock.onerror = function () {
      // 具体原因由 onclose 处理，这里不重复计数
    };
  }

  function onDown(reason) {
    view.connected = false;
    view.drops += 1;
    appCtx.ui.setBadge('已断线，重连中…', 'bad');
    appCtx.ui.showDisconnected(reason);
    appCtx.diag.renderMeters();

    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      retryDelay = Math.min(retryDelay * 1.6, 5000);
      connect();
    }, retryDelay);
  }

  var pingTimer = null;
  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    var ping = function () {
      if (sock && sock.readyState === 1) {
        var ts = Math.round(performance.now());
        var wall = Date.now();
        view.pendingPingWall[ts] = wall;
        var pendingTs = Object.keys(view.pendingPingWall);
        while (pendingTs.length > 8) delete view.pendingPingWall[pendingTs.shift()];
        sock.send(JSON.stringify({ t: 'ping', ts: ts }));
      }
    };
    ping();
    pingTimer = setInterval(ping, 2000);
  }

  // ---- 断线期间的"用户意图"要先攒着，不能丢 ----
  // ★ 这里踩过一个完全不报错的坑：leaveRoom() 是"关连接 → 120ms 后再连"，
  //   而 send() 在 socket 没 open 时是静默 return 的。用户点完「返回菜单」立刻
  //   再点「人机对战」，create 就被丢掉了 —— 可按钮已经被它自己改成禁用的
  //   "开局中…"。界面看着一切正常，实际永远进不去，只能刷新页面重来。
  var pendingSends = [];
  // 只有明确的用户意图值得补发。input / ping 是高频状态，补发出去的只会是过期数据
  var QUEUEABLE = { create: 1, join: 1 };
  var pendingTimer = null;

  function send(obj) {
    if (sock && sock.readyState === 1) { sock.send(JSON.stringify(obj)); return; }

    if (!QUEUEABLE[obj.t]) return;
    pendingSends.push(obj);

    // 兜底：连接要是迟迟回不来，别让按钮一直卡在"开局中…"，把菜单还给用户
    if (!pendingTimer) {
      pendingTimer = setTimeout(function () {
        pendingTimer = null;
        if (!pendingSends.length) return;
        pendingSends = [];
        appCtx.ui.showMenu('刚才没连上，再点一次试试。');
      }, 5000);
    }
  }

  /** 连接就绪后补发攒下的意图；真发了东西就返回 true */
  function flushPending() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (!pendingSends.length) return false;
    var q = pendingSends;
    pendingSends = [];
    for (var i = 0; i < q.length; i += 1) {
      if (sock && sock.readyState === 1) sock.send(JSON.stringify(q[i]));
    }
    return true;
  }

  function handleServer(m) {
    switch (m.t) {
      case 'pong': {
        var rtt = performance.now() - m.ts;
        view.rtt = rtt;
        view.rttSum += rtt;
        view.rttCount += 1;
        var sentWall = view.pendingPingWall[m.ts];
        delete view.pendingPingWall[m.ts];
        if (typeof sentWall === 'number' && typeof m.st === 'number'
            && (!view.serverClockSynced || rtt <= view.clockSyncRtt)) {
          view.serverClockOffset = m.st - (sentWall + (Date.now() - sentWall) / 2);
          view.serverClockSynced = true;
          view.clockSyncRtt = rtt;
        }
        break;
      }
      case 'joined':
      case 'rejoined': {
        view.mySide = m.side;
        view.code = m.code;
        view.matchId = '';
        view.matchFrames = [];
        view.matchFrameNo = 0;
        view.reportedMatchId = '';
        // 刚坐下一定是"还没开打"：把上一次对局残留的阶段与暂停状态清掉，
        // 否则从一局里退出来再进新房时，那一瞬间按钮会按旧阶段的判断显示出来。
        view.phase = 'waiting';
        view.userPaused = false;
        view.pausedBy = -1;
        // 模式与场地尺寸在建房/入座时就定下来了，等第一帧快照会太晚 ——
        // 等待面板上要写"等队友"还是"等对手"、画布多高，这里就得知道
        appCtx.render.setMode(m.mode || (m.solo ? 'solo' : 'duel'), m.wh);
        if (typeof m.level === 'number' && m.level >= 0) view.botLevel = m.level;
        view.botName = m.botName || (view.solo ? LEVEL_NAMES[view.botLevel] : '');
        saveSession(m.code, m.token, m.side);   // 注意：token 仅存本机，不外传
        appCtx.ui.syncSoloBar();
        appCtx.ui.syncPauseBtn();
        appCtx.ui.showWaiting();
        appCtx.diag.renderMeters();
        break;
      }
      case 'error': {
        var msg = m.msg || '出错了';
        if (msg.indexOf('座位') >= 0 || msg.indexOf('不存在') >= 0) clearSession();
        // 加入失败时把刚才那个码填回去，省得用户重新敲
        appCtx.ui.showMenu(msg, appCtx.ui.takeLastJoinCode());
        break;
      }
      case 'state': {
        var now = performance.now();
        var snapshotGapMs = view.lastSnapAt ? now - view.lastSnapAt : 0;
        if (view.lastSnapAt) {
          var gap = snapshotGapMs;
          view.intervals.push(gap);
          if (view.intervals.length > 90) view.intervals.shift();
        }
        view.lastSnapAt = now;
        view.lastSnapshotServerTime = typeof m.st === 'number' ? m.st : 0;
        view.snaps += 1;

        // 场地尺寸每帧随包下发。尺寸变了说明模式变了（例如刷新后重连进的是另一个模式），
        // 这时要把整个布局换掉 —— 否则会拿旧场地的坐标去画新场地。
        if (m.wh && (view.W !== m.wh[0] || view.H !== m.wh[1])) appCtx.render.setMode(m.md || view.mode, m.wh);
        else if (m.md && m.md !== view.mode) appCtx.render.setMode(m.md, m.wh);

        if (m.mi && m.mi !== view.matchId) {
          view.matchId = m.mi;
          view.matchFrames = [];
          view.matchFrameNo = 0;
          view.reportedMatchId = '';
        }
        view.phase = m.ph;
        // 真人主动暂停。★ 单独读，不从 ph 反推 —— 见 view.userPaused 的注释。
        //   服务端下发的 up 已经是"真正生效"的那个值（第一局还没开始时按下的暂停不算数）。
        view.userPaused = m.up === 1;
        view.pausedBy = typeof m.pb === 'number' ? m.pb : -1;
        appCtx.ui.syncPauseBtn();
        appCtx.render.applyBallSnapshot(m.bs);
        view.paddles = m.p.slice();
        view.score = m.s;
        view.present = m.pr;
        view.winner = m.wn;
        view.countdownMs = m.cd || 0;
        view.powerups = m.us || [];
        view.curve = m.cv || 0;
        if (m.pm) view.paddleMul = m.pm;
        // 新增的状态：被冻、护盾层数、双倍得分
        if (m.fz) view.freeze = m.fz;
        if (m.sh) view.shield = m.sh;
        if (m.db) view.double = m.db;
        // 隐形球的剩余秒数（做提示）与观看透明度（做渲染）。
        // ★ 两个字段都要：iv 是给"还剩多久"这句话用的，ia 才是画球用的。
        //   只用 ia 的话，渐变两端（1→0 刚起步、0→1 快到 1）判不出"到底在不在隐形"，
        //   提示语会一闪一闪。只用 iv 的话，渐变曲线就得在客户端再实现一遍。
        if (m.iv) view.invis = m.iv;
        if (m.ia) view.invisAlpha = m.ia;
        // 皮肤与技能。全部以服务端为准（客户端一个字节都不猜）。
        //   sk 是**每个槽位**的皮肤，不只自己那个 —— 拍子颜色要靠它画。
        if (m.sk && m.sk.length) view.skins = m.sk;
        if (m.sc) view.skillCd = m.sc;
        if (m.bo) view.boostArmed = m.bo;
        view.winds = m.wf || [];       // 风没了就该立刻停，所以这里不用 || 保留旧值
        if (m.px) view.phantom = m.px;
        // 第 11 轮新增的五个技能的对外字段。
        //   sa 粘球已武装 / sk2 正被粘住的球 / hh 黑洞 / ch 乱弹剩余 / bk 封锁层数 / sl 减速剩余
        view.stickArmed = m.sa || [];
        view.stuckBall = m.sk2 || 0;
        view.holes = m.hh || [];
        view.chaos = m.ch || [];
        view.blockCharges = m.bk || [];
        view.slowLeft = m.sl || [];
        // 局间"可以重新选拍子"的窗口。★ 放在 syncSkillBtns 之前 ——
        //   打开面板会把 overlay 露出来，技能按钮要重新算一次遮挡关系。
        view.canReselect = m.rsel === 1;
        appCtx.ui.syncReselect(view.canReselect);
        appCtx.ui.syncSkillBtns();
        if (m.ph === 'over' && m.mr) appCtx.diag.emitMatchReport(m);

        // 事件是"这一批快照里发生的事"，服务端发完即清。
        // 主循环一轮可能推进多个 tick 才广播一次，所以这里可能一次收到多个事件。
        if (m.ev && m.ev.length) {
          for (var ei = 0; ei < m.ev.length; ei += 1) appCtx.audio.playEvent(m.ev[ei]);
        }

        if (m.k !== view.lastTick) {
          var t = performance.now();
          // ★ 用固定时间窗求平均，而不是逐次差分。
          //   主循环为了对齐固定步长，偶尔会在一轮里补两个 tick（Δk=2 而 Δt 只有 33ms），
          //   逐次差分会被这一下瞬间拉到 50~60 —— 面板上的数字乱跳，看着像服务端跑飞了，
          //   其实服务端一直稳稳地 30Hz。窗口法把这种抖动平均掉。
          if (!view.tkWinStart) {
            view.tkWinStart = t;
            view.tkWinBase = m.k;
          } else if (t - view.tkWinStart >= 2000) {
            var span = (t - view.tkWinStart) / 1000;
            var dk = m.k - view.tkWinBase;
            // 防除零 + 防污染：span 为 0 会算出 Infinity，
            // 而 Infinity 乘 0.7 仍然是 Infinity，一旦写进去就永远收敛不回来。
            if (span > 0.5 && dk > 0) {
              var rate = dk / span;
              if (isFinite(rate) && rate > 0) {
                view.tickRate = view.tickRate ? view.tickRate * 0.7 + rate * 0.3 : rate;
              }
            }
            view.tkWinStart = t;
            view.tkWinBase = m.k;
          }
          view.lastTickAt = t;
          view.lastTick = m.k;
        }

        // 所有座位都在场就把覆盖层撤掉，把场地让出来。
        // ★ coop 有三个座位（两个真人 + AI），要三个都到齐才算"人齐了" ——
        //   写成 present[0] && present[1] 会让第二个真人还没进来时就开局。
        if (view.mySide >= 0 && view.present.length === view.slots.length
            && view.present.every(function (v) { return v === 1; })) {
          if (!overlay.classList.contains('hidden')) appCtx.ui.hideOverlay();
        }
        break;
      }
      default: break;
    }
  }

  // ---------- 调试面板 ----------

  /**
   * 读一次 URL 上的邀请码。`?room=XXXXXX` 进来的人**不自动入房** ——
   * 码只用来把输入框预填好，选完拍子点「加入」才真的进（那样才有机会选皮肤）。
   *
   * ★ 原来这段是引导流程里的一个 IIFE，搬过来之后顺手把它并进 attach：
   *   整个页面只有这一处读 URL 的房间码，少一处将来改漏的可能。
   *
   * @returns {void}
   */
  function readInviteCode() {
    var params = new URLSearchParams(location.search);
    var r = (params.get('room') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(r)) return;
    pendingCode = r;
    // 邀请码指向另一个房间时，旧座位就没意义了，丢掉以免坐回去
    var s = readSession();
    if (s && s.code !== pendingCode) clearSession();
  }

  /**
   * 装上网络模块。**必须**在 ui / render / diagnostics 之后调用：
   * 收到消息时要回调它们。
   *
   * @param {object} app 应用上下文。
   * @returns {object} 网络模块对外的接口。
   */
  function attach(app) {
    appCtx = app;
    view = app.view;
    readInviteCode();

    var api = {
      send: send,
      connect: connect,
      clearSession: clearSession,
      // "我自己要退房"：关连接时不能让 onclose 把它当成掉线去重连。
      closeByUs: function () {
        closingByUs = true;
        try { if (sock) sock.close(); } catch (e) {}
      },
      // 退出房间时把"从链接带进来的码"也一起忘掉，否则下次重连还会自动往那儿冲
      forgetPendingCode: function () { pendingCode = null; }
    };
    app.net = api;
    return api;
  }

  global.PongApp = global.PongApp || {};
  global.PongApp.network = attach;
})(window);
