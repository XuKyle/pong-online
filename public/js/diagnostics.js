/**
 * 取证与量表：把"这一局打下来客户端看到的和��务端的差多少"记下来。
 *
 * 这一层**不参与玩法**，一行都不改。它只做三件事：
 *   · recordMatchFrame 每帧记一帧（球、拍子、时钟），一局满了就报上去；
 *   · noteSnapshot 每收到一次状态就看一眼比分：**我方丢分的那一瞬间**，
 *     立刻把"画面上画出来的球和拍子位置"打进浏览器控制台；
 *   · renderMeters 把往返时延、快照频率、丢帧数刷到页面上的量表里。
 *
 * 服务端在每局结束时下发 mr（失分取证），这里拿它和本地的帧序列做比对，
 * 用来回答"球为什么看着穿过了拍子"这类问题 —— 那需要客户端**真的记帧**，
 * 光看代码或截图都验不了。
 *
 * 两种输出分工：
 *   · 丢分**当时**（noteSnapshot）：第一现场，"我看到的位置"，立刻可抄去对比；
 *   · 一局**打完**（emitMatchReport）：把服务端判定和本地帧逐条对齐，
 *     给出"判漏了 / 画面可接 / 一致"的结论。
 */

(function (global) {
  'use strict';

  var appCtx = null;
  var view = null;

  var elTransport = null, elRtt = null, elRate = null, elTickRate = null;
  var elSnaps = null, elDrops = null, elVerdict = null, pingPill = null;

  var PADDLE_H = 0, BALL_R = 0, WIN_SCORE = 0;

  function recordMatchFrame(ts) {
    if (view.phase !== 'playing' || !view.matchId || view.mySide < 0) return;
    var perfNow = performance.now();
    var wallNow = Date.now();
    var balls = view.balls.map(function (b) {
      var d = view.ballDisps[b.id] || { x: b.x, y: b.y };
      return {
        id: b.id,
        server: [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10],
        rendered: [Math.round(d.x * 10) / 10, Math.round(d.y * 10) / 10]
      };
    });
    var paddles = view.paddles.map(function (y, i) {
      var slot = view.slots[i] || { team: i, edge: 'unknown' };
      var half = PADDLE_H * (view.paddleMul[slot.team] || 1) / 2;
      return {
        slot: i,
        team: slot.team,
        edge: slot.edge,
        serverY: Math.round(y * 10) / 10,
        renderedY: Math.round((view.paddleDisp[i] || 0) * 10) / 10,
        catchHalfHeight: Math.round((half + BALL_R) * 10) / 10
      };
    });
    view.matchFrames.push({
      frameNo: ++view.matchFrameNo,
      perfMs: Math.round((typeof ts === 'number' ? ts : perfNow) * 10) / 10,
      clientWallMs: wallNow,
      estimatedServerMs: wallNow + view.serverClockOffset,
      serverTick: view.lastTick,
      snapshotAgeMs: view.serverClockSynced && view.lastSnapshotServerTime
        ? Math.max(0, Math.round(wallNow + view.serverClockOffset - view.lastSnapshotServerTime))
        : null,
      rttMs: Math.round(view.rtt),
      balls: balls,
      paddles: paddles
    });
    if (view.matchFrames.length > view.matchFrameLimit) {
      view.matchFrames.splice(0, 3000);
    }
  }

  function compareMissWithClientFrame(miss) {
    var approach = miss.approach;
    if (!approach || !approach.closest || !miss.ball || miss.ball.id === null) {
      return { verdict: '证据不足：服务端未记录到球接近拍面的判定窗口', miss: miss };
    }
    var targetTick = approach.tick + 1;
    var targetServerTime = approach.serverTime;
    var nearest = null;
    var nearestScore = Infinity;
    for (var i = 0; i < view.matchFrames.length; i += 1) {
      var frame = view.matchFrames[i];
      var ball = frame.balls.find(function (b) { return b.id === miss.ball.id; });
      if (!ball) continue;
      var tickGap = Math.abs(frame.serverTick - targetTick);
      var timeGap = Math.abs(frame.estimatedServerMs - targetServerTime);
      var score = view.serverClockSynced ? timeGap * 100 + tickGap : tickGap * 100 + timeGap;
      if (score < nearestScore) {
        nearestScore = score;
        nearest = { frame: frame, ball: ball, tickGap: tickGap, timeGapMs: timeGap };
      }
    }
    var paddle = nearest && nearest.frame.paddles.find(function (p) {
      return p.slot === approach.closest.slot;
    });
    var serverMargin = approach.closest.catchMargin;
    if (!nearest || !paddle) {
      return {
        verdict: '证据不足：本地没有找到同一球与对应球拍的动画帧',
        miss: miss,
        serverCatchMargin: serverMargin,
        comparedFrame: nearest ? nearest.frame : null
      };
    }
    var clientMargin = Math.abs(nearest.ball.rendered[1] - paddle.renderedY) - paddle.catchHalfHeight;
    var aligned = view.serverClockSynced
      ? nearest.timeGapMs <= Math.max(150, view.rtt + 50)
      : nearest.tickGap <= 2;
    var verdict;
    if (serverMargin < -0.5) {
      verdict = '服务端判定疑似异常：服务端记录显示球在接球范围内却仍记失分';
    } else if (!aligned) {
      verdict = '证据不足：客户端帧与服务端失分时刻未能可靠对齐';
    } else if (clientMargin < -0.5) {
      verdict = view.rtt >= 120 || (nearest.frame.snapshotAgeMs || 0) >= 100
        || nearest.tickGap >= 3
        ? '客户端画面显示可接、服务端判定漏接：疑似传输/快照延迟造成观感不一致'
        : '客户端画面显示可接、服务端判定漏接：疑似插值或本地拍子预测差异，暂不能归因于网络延迟';
    } else {
      verdict = '客户端画面与服务端判定一致：该帧球未进入拍子的接球范围';
    }
    return {
      verdict: verdict,
      myTeam: appCtx.teamOfMine(),
      isMyTeamConceded: miss.concededBy === appCtx.teamOfMine(),
      serverCatchMargin: serverMargin,
      clientRenderedCatchMargin: Math.round(clientMargin * 10) / 10,
      clientVisibleBall: nearest.ball.rendered,
      clientVisiblePaddleY: paddle.renderedY,
      renderedVsSnapshotDelta: [
        Math.round((nearest.ball.rendered[0] - nearest.ball.server[0]) * 10) / 10,
        Math.round((nearest.ball.rendered[1] - nearest.ball.server[1]) * 10) / 10
      ],
      paddleSlot: paddle.slot,
      tickDifference: nearest.tickGap,
      estimatedTimeDifferenceMs: Math.round(nearest.timeGapMs),
      rttMs: nearest.frame.rttMs,
      snapshotAgeMs: nearest.frame.snapshotAgeMs,
      serverApproach: approach,
      serverMiss: miss,
      nearestClientFrame: nearest.frame
    };
  }

  function emitMatchReport(message) {
    if (!message.mi || !Array.isArray(message.mr) || view.reportedMatchId === message.mi) return;
    view.reportedMatchId = message.mi;

    // ---------- 得分报告：谁赢了哪一分 ----------
    // mr 的每条就是一次失分 = 一分，且按得分先后排列，所以"逐分明细"直接读它：
    // 第 i 分的赢家 = mr[i-1].scorer。先给这张表（谁赢了哪一分、当时比分、
    // tick、服务端拍子最近余量），再给下面那份逐条对齐的详细对照。
    var myTeam = appCtx.teamOfMine();
    var teamLabel = function (team) {
      return team === myTeam ? '我方' : (view.solo ? (view.botName || 'AI') : '对方');
    };
    var score = [0, 0];
    var perPoint = message.mr.map(function (ms, i) {
      score[ms.scorer] += 1;
      var closest = ms.approach && ms.approach.closest;
      return {
        第几分: i + 1,
        赢家: teamLabel(ms.scorer),
        当时比分: score[0] + ':' + score[1],
        tick: ms.tick,
        服务端拍子余量px: closest ? closest.catchMargin : null
      };
    });
    console.log('[Pong 本局得分报告] ' + message.mi + ' · 最终 ' + message.s.join(':')
      + ' · 获胜方: ' + teamLabel(message.wn));
    console.table(perPoint);

    var comparisons = message.mr.map(compareMissWithClientFrame);
    var serverSuspects = comparisons.filter(function (c) {
      return c.verdict.indexOf('服务端判定疑似异常') === 0;
    }).length;
    var apparentClientCatches = comparisons.filter(function (c) {
      return c.verdict.indexOf('客户端画面显示可接') === 0;
    }).length;
    var insufficient = comparisons.filter(function (c) {
      return c.verdict.indexOf('证据不足') === 0;
    }).length;
    var verdict = serverSuspects
      ? '发现服务端判定疑点，优先检查碰撞判定逻辑。'
      : apparentClientCatches
        ? '至少有一分客户端画面看似可接而服务端记为漏接；结合 RTT / 快照年龄判断是网络延迟还是本地渲染预测偏差。'
        : '未发现客户端画面与服务端判定明确冲突；证据不足的项目需要结合实际网络复现。';
    console.groupCollapsed('[Pong 本局失分对照报告] ' + message.mi
      + ' · 最终比分 ' + message.s.join(':'));
    console.log({
      matchId: message.mi,
      finalScore: message.s,
      winnerTeam: message.wn,
      localTeam: appCtx.teamOfMine(),
      serverMissCount: message.mr.length,
      perPoint: perPoint,
      clientFramesCaptured: view.matchFrames.length,
      clientFrameLimitReached: view.matchFrameNo > view.matchFrameLimit,
      serverClockOffsetMs: view.serverClockSynced ? Math.round(view.serverClockOffset) : null,
      clockSyncRttMs: view.clockSyncRtt === Infinity ? null : Math.round(view.clockSyncRtt),
      summary: {
        serverRuleSuspects: serverSuspects,
        clientFrameAppearedCatchable: apparentClientCatches,
        insufficientEvidence: insufficient
      },
      verdict: verdict,
      points: comparisons
    });
    console.groupEnd();
  }

  // ---------- 丢分取证：我方丢分的**那一刻**，把画面上画出来的位置打进控制台 ----------
  // 用法：球穿板的时候，丢分那一瞬间控制台会多一条橙色 [Pong 丢分取证]，
  // 里面是"你看到的"球和拍子位置（rendered），同时附上同一刻的服务端真值（server）。
  //   · renderedCatchMargin < 0 ⇒ 画面上球就在拍子能接的范围内，服务端却判了丢分
  //     ⇒ 拿 rttMs / snapshotAgeMs 判断是不是网速把服务端拍子拖慢了（疑似判定错位）；
  //   · renderedCatchMargin ≥ 0 ⇒ 画面上拍子也不在球的位置 ⇒ 真是够不着，服务端没错。
  // 逐条对齐服务端的详细结论仍在一局打完后的 emitMatchReport 里，这里只是第一现场。
  var lastScore = null;
  var prevBallIds = null;

  function noteSnapshot(m) {
    if (!Array.isArray(m.s) || view.mySide < 0) return;
    var newIds = [];
    for (var i = 0; i < (m.bs || []).length; i += 1) newIds.push(m.bs[i][0]);
    var gone = [];
    if (prevBallIds) {
      for (var g = 0; g < prevBallIds.length; g += 1) {
        if (newIds.indexOf(prevBallIds[g]) < 0) gone.push(prevBallIds[g]);
      }
    }
    prevBallIds = newIds;

    var conceded = false;
    if (lastScore) {
      // 比分回落后说明是新一局（比分重置），不算丢分
      var fresh = m.s[0] < lastScore[0] || m.s[1] < lastScore[1];
      conceded = !fresh && m.s[1 - appCtx.teamOfMine()] > lastScore[1 - appCtx.teamOfMine()];
    }
    lastScore = m.s.slice();
    if (!conceded) return;
    dumpConceded(gone);
  }

  function dumpConceded(goneIds) {
    var myTeam = appCtx.teamOfMine();
    // 找"刚消失的那颗球"（出界被移除的）在本地帧序列里的最后一帧 ——
    // 那就是"丢分前一刻我看到的画面"。帧是 recordMatchFrame 每帧记的，
    // 球的位置分"画出来的 rendered"和"服务端真值 server"两份。
    var last = null;
    for (var f = view.matchFrames.length - 1; f >= 0; f -= 1) {
      var frame = view.matchFrames[f];
      for (var b = 0; b < frame.balls.length; b += 1) {
        if (goneIds.indexOf(frame.balls[b].id) >= 0) {
          last = { frame: frame, ball: frame.balls[b] };
          break;
        }
      }
      if (last) break;
    }
    if (!last) {
      console.warn('[Pong 丢分取证] 比分 ' + lastScore.join(':') + '，我方丢分，但没找到丢分前的本地帧');
      return;
    }
    var fr = last.frame, ball = last.ball;
    // 我方这边所有拍子（coop 是同一侧两个槽位），取画面上离球最近的那块
    var paddle = null, margin = Infinity;
    for (var p = 0; p < fr.paddles.length; p += 1) {
      var pd = fr.paddles[p];
      if (pd.team !== myTeam) continue;
      var mg = Math.abs(ball.rendered[1] - pd.renderedY) - pd.catchHalfHeight;
      if (mg < margin) { margin = mg; paddle = pd; }
    }
    if (!paddle) {
      console.warn('[Pong 丢分取证] 比分 ' + lastScore.join(':') + '，我方丢分，但帧里没有我方拍子');
      return;
    }
    var verdict = margin < 0
      ? '画面上球就在拍子能接的范围内，服务端却判了丢分 —— 疑似网速把服务端拍子拖慢造成判定错位，'
        + '结合 RTT（' + fr.rttMs + 'ms）/ 快照年龄（' + (fr.snapshotAgeMs === null ? '?' : fr.snapshotAgeMs + 'ms') + '）判断'
      : '画面上拍子也不在球的位置（差 ' + margin.toFixed(1) + 'px）—— 真是够不着，服务端判定没错';
    console.warn('[Pong 丢分取证] 比分 ' + lastScore.join(':') + '，我方丢分（tick ' + fr.serverTick
      + '，RTT ' + fr.rttMs + 'ms）：' + verdict);
    console.log({
      比分: lastScore,
      serverTick: fr.serverTick,
      rttMs: fr.rttMs,
      快照年龄ms: fr.snapshotAgeMs,
      球_画面上: ball.rendered,      // [x, y] 我眼睛看到的球
      球_服务端真值: ball.server,      // [x, y] 同一刻服务端认为的球
      球_画面滞后: [
        Math.round((ball.rendered[0] - ball.server[0]) * 10) / 10,
        Math.round((ball.rendered[1] - ball.server[1]) * 10) / 10
      ],
      我的拍子_画面上Y: paddle.renderedY,
      我的拍子_服务端Y: paddle.serverY,
      接球半高: paddle.catchHalfHeight,     // |球Y - 拍Y| ≤ 这个值才算接得住
      画面接球余量px: Math.round(margin * 10) / 10,   // < 0 = 画面上球在拍子范围内
      结论: verdict
    });
  }

  // 手机端顶部的延迟胶囊（句柄在上面的 dom 别名里）。桌面端它是 display:none，
  // 更新它没有任何副作用。

  function renderMeters() {
    if (!view.connected) {
      elTransport.textContent = '—';
    } else if (view.mySide < 0) {
      elTransport.textContent = 'WebSocket ✓';
    } else {
      elTransport.textContent = 'WebSocket ✓';
    }

    elRtt.textContent = view.rttCount ? Math.round(view.rtt) + ' ms' : '—';

    // 手机端只保留这一个数：延迟。阈值按"还能不能正常玩"定，
    // 不按"好看"定 —— 80ms 以内基本无感，180ms 以上接球已经得靠预判了。
    if (pingPill) {
      if (view.rttCount) {
        var msR = Math.round(view.rtt);
        pingPill.textContent = msR + ' ms';
        pingPill.className = 'badge ping ' + (msR < 80 ? 'ok' : (msR < 180 ? 'warn' : 'bad'));
      } else {
        pingPill.textContent = '—';
        pingPill.className = 'badge ping';
      }
    }

    elDrops.textContent = String(view.drops);
    elSnaps.textContent = String(view.snaps);

    if (view.intervals.length > 12) {
      var sum = 0;
      for (var i = 0; i < view.intervals.length; i++) sum += view.intervals[i];
      var avg = sum / view.intervals.length;
      elRate.innerHTML = (1000 / avg).toFixed(1) + '<small>/秒</small>';
    } else {
      elRate.textContent = '—';
    }

    elTickRate.innerHTML = view.tickRate
      ? view.tickRate.toFixed(1) + '<small>次/秒</small>'
      : '—';

    // 结论：只有在真的收到足够快照后才下判断
    if (!view.connected) {
      elVerdict.textContent = '当前未连接。';
    } else if (view.snaps < 10) {
      elVerdict.textContent = '长连接已建立，正在采集数据…';
    } else if (view.drops === 0 && view.intervals.length > 12) {
      var s = 0;
      for (var j = 0; j < view.intervals.length; j++) s += view.intervals[j];
      var a = 1000 / (s / view.intervals.length);
      elVerdict.innerHTML = '<b>长连接可用。</b>连接方式是原生 WebSocket，没有降级到轮询，'
        + '说明发布环境放行了升级握手。服务器每秒稳定推 ' + a.toFixed(1) + ' 次状态，'
        + '往返延迟 ' + Math.round(view.rtt) + ' 毫秒，期间没有掉线。';
    } else if (view.drops > 0) {
      elVerdict.innerHTML = '<b>连接可用但不够稳。</b>已经掉线 ' + view.drops
        + ' 次，自动重连生效了。如果是一玩就断，多半是中间的代理在回收空闲连接。';
    }
  }

  /**
   * 装上诊断模块。**必须**在 render 之前调用：渲染循环每帧要记一帧。
   *
   * @param {object} app 应用上下文。
   * @returns {object} 诊断模块对外的接口。
   */
  function attach(app) {
    appCtx = app;
    view = app.view;

    elTransport = app.dom.elTransport;
    elRtt = app.dom.elRtt;
    elRate = app.dom.elRate;
    elTickRate = app.dom.elTickRate;
    elSnaps = app.dom.elSnaps;
    elDrops = app.dom.elDrops;
    elVerdict = app.dom.elVerdict;
    pingPill = app.dom.pingPill;
    PADDLE_H = app.PADDLE_H;
    BALL_R = app.BALL_R;
    WIN_SCORE = app.WIN_SCORE;

    // 面板低频刷新，别把主线程拖慢
    setInterval(renderMeters, 400);

    var api = {
      recordMatchFrame: recordMatchFrame,
      noteSnapshot: noteSnapshot,
      renderMeters: renderMeters,
      emitMatchReport: emitMatchReport
    };
    app.diag = api;
    return api;
  }

  global.PongApp = global.PongApp || {};
  global.PongApp.diagnostics = attach;
})(window);
