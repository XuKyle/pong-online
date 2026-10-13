/**
 * 渲染：画布尺寸、逐帧循环、以及所有把 view 画成像素的函数。
 *
 * 客户端**一秒钟都不参与物理** —— 球的位置一律来自服务端快照。
 * 这里做的只有两件事：把离散快照平滑成看起来连续的位置（拍子本地预测、
 * 球位置指数平滑、弧线尾迹），以及按 view 把画面画出来。
 *
 * ★ 每帧的顺序不能动：先本地预测拍子，再更新球的平滑位置，再按真实 dt
 *   推进音量状态机，最后才 fitCanvas / draw / 记一帧取证。
 *   fitCanvas 放在 draw 之前，是因为它可能改画布尺寸，而 canvas 一改尺寸
 *   就会清空内容 —— 放后面等于这一帧白画。
 */

(function (global) {
  'use strict';

  var appCtx = null;
  var view = null;
  var canvas = null;
  var ctx = null;
  var stage = null;

  // devicePixelRatio。夹到 2 是为了不让 3x 屏把每帧的位图撑大到拖不动。
  var dpr = 1;
  var lastFrame = 0;

  // 只读表
  var COL = null, COOP_COL = null, COOP_COL_FROZEN = null;
  var POWERUP_STYLE = null, POWERUP_R = 0, LEVEL_NAMES = null;
  var SKIN_COL = null, SKIN_COL_FROZEN = null;
  var WIND_MS = 0, HOLE_R = 0, HOLE_LIFE_MS = 0, WIN_SCORE = 0;
  var PADDLE_W = 0, PADDLE_H = 0, PADDLE_MARGIN = 0, BALL_R = 0, PADDLE_SPEED = 0;
  function applyBallSnapshot(list) {
    var incoming = list || [];
    var seen = {};
    var next = [];
    for (var i = 0; i < incoming.length; i += 1) {
      var b = incoming[i];                     // [id, x, y]
      var id = b[0];
      seen[id] = true;
      next.push({ id: id, x: b[1], y: b[2] });
      if (!view.ballDisps[id]) {
        view.ballDisps[id] = { x: b[1], y: b[2] };
        view.tails[id] = [];
      }
    }
    view.balls = next;
    for (var k in view.ballDisps) {
      if (!seen[k]) { delete view.ballDisps[k]; delete view.tails[k]; }
    }
  }

  function setMode(mode, wh) {
    view.mode = mode || 'duel';
    if (wh && wh.length === 2) { view.W = wh[0]; view.H = wh[1]; }
    view.slots = appCtx.slotsFor(view.mode, view.H);
    view.coop = view.mode === 'coop';
    view.solo = view.mode !== 'duel';
    // 位置也要跟着重置。只调数组长度、留着上一局的残留位置的话，
    // 换模式后的那一帧会把拍子画在错误的地方 —— 实测：从经典双人（两条都在 250）
    // 切到 coop 时，下半场那条（span [400,800]，中点 600）会先出现在 250，
    // 也就是**上半场里**。用各槽位 span 的中点，和服务端 createRoom 的做法保持一致。
    view.paddles = view.slots.map(function (s) { return (s.span[0] + s.span[1]) / 2; });
    view.paddleDisp = view.paddles.slice();
    view.tails = {};
    // ★ 技能相关的数组长度必须跟着**槽位数**走。经典双人是 2 个槽、coop 是 3 个，
    //   数组留着上一局的长度会多出（或缺少）一个槽位，表现是"某个按钮一直显示冷却中"。
    //   真实的皮肤值由下一帧快照带下来（服务端才是权威），这里先清成灰。
    view.skins = view.slots.map(function () { return 0; });
    view.skillCd = view.slots.map(function () { return 0; });
    view.boostArmed = view.slots.map(function () { return 0; });
    view.winds = [];
    view.phantom = [0, 0];
    // ★★ 必须**立刻**把画布尺寸同步过来。只改 view.W/view.H 而不重设 canvas 的话，会留下一帧
    //   「场地已经是新模式的尺寸、画布还是旧的」的状态：
    //     · 那 16ms 里画面比例是错的（coop 的 960×800 会被画进 800×500 的位图里）；
    //     · 页面用来定场地比例的 CSS 变量 --ar 也跟着滞后一帧；
    //     · 探针在这一帧读 canvasSize 会拿到旧值，和 court 对不上（实测踩到过）。
    //   fitCanvas() 是幂等的（尺寸没变就不动 canvas），所以放在这里没有副作用。
    fitCanvas();
  }

  var dpr = 1;
  function fitCanvas() {
    var want = Math.min(window.devicePixelRatio || 1, 2);
    dpr = want;
    if (canvas.width !== view.W * dpr || canvas.height !== view.H * dpr) {
      canvas.width = view.W * dpr;
      canvas.height = view.H * dpr;
    }
    // 宽高比交给 CSS 变量：各模式的场地尺寸不同，写死 8/5 会把 coop 压扁
    if (stage) stage.style.setProperty('--ar', (view.W / view.H).toFixed(4));
  }

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * 拍子的**身份色**（描边用）。
   * coop 按**槽位**取色（两名真人在同一条边上，按队取色会变成两条一模一样的蓝），
   * 经典双人 / 人机按**队伍**取色（两侧各一队，本来就不一样）。
   *
   * ★ 加了皮肤系统之后，这个颜色从"填充"退成了"描边"，但**不能删**：
   *   填充现在是玩家自选的皮肤色，而 coop 里两个人完全可能都选灰 ——
   *   只按皮肤上色的话，两条灰板子又分不清谁是谁了（这正是当初做槽位配色的原因）。
   *   填皮肤色、描身份色，两个诉求同时满足。
   */
  function paddleFill(si, frozen) {
    var sl = view.slots[si];
    if (view.coop) return (frozen ? COOP_COL_FROZEN : COOP_COL)[si];
    if (frozen) return sl.team === 0 ? '#9fd8ff' : '#ffc0ae';
    return sl.team === 0 ? COL.p0 : COL.p1;
  }

  /** 拍子的**皮肤色**（填充用）= 这个槽位选的技能的颜色。灰 = 没有技能 */
  function skinFill(si, frozen) {
    var s = view.skins[si];
    if (!(s > 0) && s !== 0) return SKIN_COL[0];
    return (frozen ? SKIN_COL_FROZEN : SKIN_COL)[s] || SKIN_COL[0];
  }

  /** 红色技能蓄力中：拍子外面套一圈呼吸的光，"下一板是超高速"一眼可见 */
  function drawArmed(si, px, ph) {
    var pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
    ctx.save();
    ctx.globalAlpha = 0.30 + 0.45 * pulse;
    ctx.strokeStyle = SKIN_COL[3];
    ctx.lineWidth = 3;
    rr(px - 5, view.paddleDisp[si] - ph / 2 - 5, PADDLE_W + 10, ph + 10, 10);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 黑洞。画成一个把周围光吸进去的暗漩涡：外圈微弱的紫黑光晕 + 内部几圈
   * 反向旋转的椭圆弧 + 中心一个纯黑盘。
   *
   * ★ 为什么不是"一个黑圆点"：球场底色本来就是深蓝，纯黑圆点在它上面几乎看不见，
   *   玩家会以为球是"莫名其妙自己飞走了"。必须给它一圈**比底色更亮**的光晕当轮廓。
   * ★ 剩下的秒数内会缓慢收缩（life 从 1 到 0），给玩家"它快关了"的提示 ——
   *   否则球飞进去却没被吸走（刚好到寿消失）时，看着像技能没生效。
   */
  function drawBlackhole(hx, hy, left) {
    var t = performance.now() / 1000;
    var life = Math.max(0, Math.min(1, (left || 0) / (HOLE_LIFE_MS / 1000)));
    var r = HOLE_R * (0.72 + 0.28 * Math.min(1, life * 3));
    ctx.save();
    // 外光晕：两圈，越外越淡
    for (var gi = 0; gi < 2; gi += 1) {
      ctx.beginPath();
      ctx.arc(hx, hy, r + 10 + gi * 9, 0, Math.PI * 2);
      ctx.strokeStyle = '#a855f7';
      ctx.globalAlpha = 0.20 - gi * 0.08;
      ctx.lineWidth = 3 - gi;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 中心的黑盘
    ctx.beginPath();
    ctx.arc(hx, hy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#05070d';
    ctx.fill();
    // 吸进去的螺旋：三段不同半径、不同转速的弧
    ctx.lineCap = 'round';
    for (var k = 0; k < 3; k += 1) {
      var rr2 = r * (0.34 + k * 0.24);
      var sp = 1.6 + k * 0.9;
      var a0 = t * sp + k * 2.1;
      ctx.beginPath();
      ctx.arc(hx, hy, rr2, a0, a0 + Math.PI * 0.9);
      ctx.strokeStyle = k === 0 ? '#e9d5ff' : '#c084fc';
      ctx.globalAlpha = 0.9 - k * 0.22;
      ctx.lineWidth = 2.2 - k * 0.5;
      ctx.stroke();
    }
    // 出口侧的箭标：洞开在自己半场，球会从**对面**同侧位置飞出。
    //   画一个小箭头指向对面，省得玩家以为球是随机乱飞的。
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    var ax = left ? hx + r + 13 : hx - r - 13;
    var dir = left ? 1 : -1;
    ctx.moveTo(ax, hy - 5);
    ctx.lineTo(ax + dir * 8, hy);
    ctx.lineTo(ax, hy + 5);
    ctx.strokeStyle = '#c084fc';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  /** 紫色乱弹生效中的拍子：绕一圈跳动的电光点，表示"我这一板不按常理出牌" */
  /** 蓝色"粘球已武装"的光圈。与 drawArmed（红色蓄力）同一形状、不同颜色与节奏 ——
   *  两个都是"下一板会不一样"的预告，但方向相反（一个是打得更狠、一个是抓住不放），
   *  所以用不同颜色 + 更慢的呼吸，让玩家一眼分得清自己举着的是哪一个。 */
  function drawStickArmed(si, px, ph) {
    var pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    ctx.save();
    ctx.globalAlpha = 0.30 + 0.45 * pulse;
    ctx.strokeStyle = SKIN_COL[4];
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    rr(px - 5, view.paddleDisp[si] - ph / 2 - 5, PADDLE_W + 10, ph + 10, 10);
    ctx.stroke();
    ctx.restore();
  }

  /** 橙色"被减速"的罩子。减速是别人加在你身上的，所以画成**压力**的样子：
   *  一层压扁的半透明橙罩 + 上下两条向内的短横线（像被夹住了）。 */
  function drawSlowed(si, px, ph) {
    var cy = view.paddleDisp[si];
    var pulse = 0.5 + 0.5 * Math.sin(performance.now() / 320);
    ctx.save();
    ctx.strokeStyle = SKIN_COL[8];
    ctx.globalAlpha = 0.35 + 0.30 * pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px - 4, cy - ph / 2 - 6);
    ctx.lineTo(px + PADDLE_W + 4, cy - ph / 2 - 6);
    ctx.moveTo(px - 4, cy + ph / 2 + 6);
    ctx.lineTo(px + PADDLE_W + 4, cy + ph / 2 + 6);
    ctx.stroke();
    // 两条向内的箭头：明确"这块拍子变慢了"
    ctx.globalAlpha = 0.55;
    for (var k = 0; k < 2; k += 1) {
      var yy = cy + (k ? ph / 2 + 6 : -ph / 2 - 6);
      var mx = px + PADDLE_W / 2;
      ctx.beginPath();
      ctx.moveTo(mx - 9, yy + (k ? -5 : 5));
      ctx.lineTo(mx, yy);
      ctx.lineTo(mx + 9, yy + (k ? -5 : 5));
      ctx.stroke();
    }
    ctx.restore();
  }

  function frac(v) { return v - Math.floor(v); }

  /** 确定性伪随机：同一个下标每次都得到同一个数。
   *  ★ 不能用 Math.random —— 每帧重掷会让气流线原地乱跳，看起来是噪点而不是风。 */
  function hashF(i, k) { return frac(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453); }

  /** 紫色乱弹生效中的拍子：绕一圈跳动的电光弧，表示"我这一板不按常理出牌"。
   *  ★ 必须画出来：乱弹改的是**出射角**，球一离拍就看不出来是哪来的，
   *   不标在拍子上的话玩家只会觉得"我这一板怪怪的"，说不出为什么。 */
  function drawChaos(si, px, ph) {
    var t = performance.now() / 1000;
    var cy = view.paddleDisp[si];
    ctx.save();
    ctx.strokeStyle = SKIN_COL[6];
    ctx.lineWidth = 2;
    for (var k = 0; k < 3; k += 1) {
      var a = t * (2.4 + k * 1.3) + k * 2.1;
      var rx = 11 + k * 4;
      var ry = ph / 2 + 5 + k * 3;
      ctx.globalAlpha = 0.55 - k * 0.14;
      ctx.beginPath();
      ctx.ellipse(px + PADDLE_W / 2, cy, rx, ry, 0, a, a + 1.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 一阵风。画成沿风向扫过整个球场的一束气流线。
   *
   * 每条线的基准位置铺满球场，再按"相位 + 自己的随机偏移"沿风向平移 ——
   * 相位只跟时间走，所以线条是**匀速平移**而不是闪烁的。
   * 两端各留一段渐入渐出（fade），免得风"啪"地出现、"啪"地消失。
   *
   * ★ 画在球和拍子**下面**：风是氛围，把球糊住就本末倒置了。
   * ★ 方向取自服务端下发的单位向量 —— 客户端不自己算方向，否则两边一旦不一致，
   *   玩家会看到"风吹这边、球往那边走"。施力和表现必须是同一个方向。
   */
  function drawWind(w, idx) {
    var dx = w[0];
    var dy = w[1];
    var total = WIND_MS / 1000;
    var life = Math.max(0, Math.min(1, w[2] / total));      // 1 = 刚放出，0 = 快没了
    var fade = Math.min(1, (1 - life) * 7) * Math.min(1, life * 7);
    if (fade <= 0.01) return;
    var diag = Math.sqrt(view.W * view.W + view.H * view.H);
    var phase = (performance.now() / 620 + idx * 0.37) % 1;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#67e8f9';
    for (var i = 0; i < 26; i += 1) {
      var r1 = hashF(i, 1);
      var r2 = hashF(i, 2);
      var r3 = hashF(i, 3);
      var off = (((r3 + phase) % 1) * 2 - 1) * diag;
      var x = r1 * view.W + dx * off;
      var y = r2 * view.H + dy * off;
      if (x < -60 || x > view.W + 60 || y < -60 || y > view.H + 60) continue;
      var len = 30 + r3 * 55;
      ctx.globalAlpha = fade * (0.14 + 0.30 * r1);
      ctx.lineWidth = 1.4 + r2 * 1.8;
      ctx.beginPath();
      ctx.moveTo(x - dx * len, y - dy * len);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPowerup(x, y, type) {
    var st = POWERUP_STYLE[type] || POWERUP_STYLE[0];
    var pulse = 0.5 + 0.5 * Math.sin(performance.now() / 190);

    // 外圈脉冲，让它在深色场地上足够显眼
    ctx.beginPath();
    ctx.arc(x, y, POWERUP_R + 4 + pulse * 3, 0, Math.PI * 2);
    ctx.strokeStyle = st.c;
    ctx.globalAlpha = 0.16 + 0.14 * pulse;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, POWERUP_R, 0, Math.PI * 2);
    ctx.fillStyle = st.c;
    ctx.globalAlpha = 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, POWERUP_R, 0, Math.PI * 2);
    ctx.strokeStyle = st.c;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 单字符用大号，两字符（如 "2×"）得缩一号，否则会顶出圆圈
    ctx.font = '700 ' + (st.label.length > 1 ? 15 : 21) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = st.c;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(st.label, x, y + 1);
  }

  /** 拍子被冰冻的标记。放在场地内侧固定距离，避免贴着边被裁掉 */
  function drawFrozen(slot, secs) {
    var sl = view.slots[slot];
    var x = sl.edge === 'left'
      ? PADDLE_MARGIN + PADDLE_W + 30
      : view.W - PADDLE_MARGIN - PADDLE_W - 30;
    ctx.font = '700 13px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8fd6ff';
    ctx.fillText('❄ ' + secs.toFixed(1) + 's', x, view.paddleDisp[slot]);
  }

  /** 护盾：贴在底线内侧的一道亮条，上面的 ×N 是剩余次数（按队，不是按拍子） */
  function drawShield(slot) {
    var sl = view.slots[slot];
    var n = view.shield[sl.team];
    if (!n) return;
    var y = view.paddleDisp[slot];
    var x = sl.edge === 'left' ? 7 : view.W - 7;
    var half = PADDLE_H * 0.66;

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y - half);
    ctx.lineTo(x, y + half);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // ×N 只标在该队的第一个拍子上 —— coop 里左队有两块拍子，
    // 每块都写一遍会让人以为有两个独立的护盾
    var firstOfTeam = view.slots.findIndex(function (s) { return s.team === sl.team; }) === slot;
    if (!firstOfTeam) return;
    ctx.font = '700 12px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×' + n, x, y - half - 12);
  }

  /**
   * 暂停提示里那句"是谁按的"。
   * coop 里守同一条边的另一位是**队友**，说成"对手"会把人看糊涂。
   */
  function pauseWhoText() {
    if (view.pausedBy < 0) return '';
    if (view.pausedBy === view.mySide) return '你按下的暂停';
    return (view.coop ? '队友' : '对手') + '按下的暂停';
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.W, view.H);

    ctx.fillStyle = COL.court;
    ctx.fillRect(0, 0, view.W, view.H);

    // 上下墙
    ctx.fillStyle = COL.wall;
    ctx.fillRect(0, 0, view.W, 3);
    ctx.fillRect(0, view.H - 3, view.W, 3);

    // 中线
    ctx.setLineDash([14, 18]);
    ctx.strokeStyle = COL.mid;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(view.W / 2, 0);
    ctx.lineTo(view.W / 2, view.H);
    ctx.stroke();
    ctx.setLineDash([]);

    // coop：左半边被一条水平线分成上下两个半场，两个真人各守一半。
    // ★ 只画左半边 —— 右边整条都是 AI 一个人的，画过去会让人以为它也分成了两段。
    if (view.coop) {
      ctx.setLineDash([10, 14]);
      ctx.strokeStyle = 'rgba(77,163,255,0.30)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, view.H / 2);
      ctx.lineTo(view.W / 2, view.H / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 比分
    ctx.font = '500 62px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(143,163,191,0.22)';
    ctx.fillText(String(view.score[0]), view.W / 2 - 90, 78);
    ctx.fillText(String(view.score[1]), view.W / 2 + 90, 78);

    // 双倍得分生效时挂在比分外侧。不加这个标记，分数一次跳两分会被当成 bug
    ctx.font = '700 15px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = '#f0abfc';
    if (view.double[0]) ctx.fillText('×2', view.W / 2 - 148, 78);
    if (view.double[1]) ctx.fillText('×2', view.W / 2 + 148, 78);

    // AI 模式：把对手是谁写出来，免得以为在跟真人打
    if (view.solo) {
      ctx.font = '400 12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COL.faint;
      ctx.fillText('AI · ' + (view.botName || LEVEL_NAMES[view.botLevel] || '普通'),
        view.W / 2 + 90, 112);
      // coop：左边那半场是两个人合作守的，标一下，免得以为对面只有一个人
      if (view.coop) ctx.fillText('2 人合作', view.W / 2 - 90, 112);
    }

    // 10 平之后把规则摆出来，免得人以为"怎么赢了还不结束"
    var s0 = view.score[0], s1 = view.score[1];
    if (view.phase === 'playing' && s0 >= WIN_SCORE - 1 && s1 >= WIN_SCORE - 1
        && Math.abs(s0 - s1) <= 1) {
      ctx.font = '400 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COL.good;
      ctx.fillText('追分中 · 需净胜 2 分', view.W / 2, 122);
    }

    // 隐形球的提示。★ 两个方向都必须写：
    //   · 被隐形的人要知道"球是隐形了，不是我卡了/渲染坏了"，还得知道还剩多久，
    //     否则他只会觉得游戏出 bug 了 —— 这道道具的整个体验就毁在这儿；
    //   · 吃到的人要知道"这一下生效了"，不然他从头到尾没有任何反馈。
    if (view.phase === 'playing' || view.phase === 'countdown') {
      var mt = appCtx.teamOfMine();
      var ft = mt < 0 ? -1 : 1 - mt;
      ctx.font = '400 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      if (mt >= 0 && view.invis[mt] > 0) {
        ctx.fillStyle = '#fca5a5';
        ctx.fillText('球被隐形 · 靠预判 ' + view.invis[mt].toFixed(1) + 's', view.W / 2, 146);
      } else if (ft >= 0 && view.invis[ft] > 0) {
        ctx.fillStyle = '#86efac';
        ctx.fillText('对手看不见球 ' + view.invis[ft].toFixed(1) + 's', view.W / 2, 146);
      }
    }

    // 幻影球生效中。★ 只给**释放方**看，而且只写"还在生效"、一个字都不提位置 ——
    //   对手那边连"场上有两个球"都不该被提示，那正是这个技能的全部意义。
    if (view.phase === 'playing' && view.mySide >= 0) {
      var mtp = appCtx.teamOfMine();
      if (mtp >= 0 && view.phantom[mtp] > 0) {
        ctx.font = '400 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = SKIN_COL[2];
        ctx.fillText('幻影生效中 ' + view.phantom[mtp].toFixed(1) + 's', view.W / 2, 168);
      }
    }

    // 风：沿风向扫过整个球场的气流线。画在道具 / 球 / 拍子**下面** —— 它是氛围，
    // 把球糊住就本末倒置了。场上可能同时有多股（两个人都是青拍子），逐个画。
    for (var wi = 0; wi < view.winds.length; wi += 1) {
      var ww = view.winds[wi];
      if (ww && ww.length === 3) drawWind(ww, wi);
    }

    // 道具（球拍下面一层，避免盖住拍子）。场上可以**同时挂多个**，逐个画。
    // ★ 不能只画第一个：服务端会同时下发好几个，漏画会让玩家看到
    //   "球撞到了看不见的东西"。
    for (var ui = 0; ui < view.powerups.length; ui += 1) {
      var uu = view.powerups[ui];
      if (uu && uu.length === 3) drawPowerup(uu[0], uu[1], uu[2]);
    }

    // 黑洞：画在道具**上面**、球和拍子**下面**。
    // ★ 层次是有讲究的：球要能被看见"飞进洞"，所以球在洞之上；
    //   而洞本身要压在道具上，否则道具飘过来会把洞盖住，看着像洞没了。
    // ★ 黑洞只有真球会进，幻影球不受影响（服务端那道 isPhantom 判断），
    //   所以这里照画，不需要按队过滤。
    for (var hi = 0; hi < view.holes.length; hi += 1) {
      var hh2 = view.holes[hi];
      if (hh2 && hh2.length === 4) drawBlackhole(hh2[0], hh2[1], hh2[3] === appCtx.teamOfMine());
    }

    // 球拍：长度按服务端下发的倍率画，条数与位置按槽位表（经典 2 条，coop 3 条）。
    // ★ 必须跟着倍率走，否则吃到"加长"后会看着明明碰到了却没弹回来。
    var xL = PADDLE_MARGIN;
    var xR = view.W - PADDLE_MARGIN - PADDLE_W;

    // ★ 这里原来还会在"自己那块拍子"旁边（xL-5 / xR+PADDLE_W+5）画一条**平行白线**，
    //   用来标出哪条是自己的。但它和拍子中间隔着几像素背景，看着就是一根没人管的杂线，
    //   用户明确要求去掉 —— 已删，且不加替代物（描边、箭头之类一律不加）。
    //   现在靠这两样认自己的拍子：① coop 里两名真人**各是一个颜色**（见 paddleFill）；
    //   ② 底部常驻栏写着「你守上半场 / 下半场」。经典双人模式按一下方向键也就知道了。
    for (var si = 0; si < view.slots.length; si += 1) {
      var sl = view.slots[si];
      var ph = PADDLE_H * view.paddleMul[sl.team];
      var px = sl.edge === 'left' ? xL : xR;
      // 被冰冻时拍子换冰色。只冻住不说明原因，人会以为是自己键盘坏了
      var frz = view.freeze[sl.team] > 0;
      rr(px, view.paddleDisp[si] - ph / 2, PADDLE_W, ph, 7);
      // 填 = 皮肤色（= 技能），描 = 身份色。
      // ★ 两样都要，理由见 paddleFill 的注释：颜色现在由玩家自选，coop 里两个人
      //   完全可能都选灰，只按皮肤上色就分不清谁是谁了。
      ctx.fillStyle = skinFill(si, frz);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = paddleFill(si, frz);
      ctx.stroke();
      if (view.boostArmed[si]) drawArmed(si, px, ph);
      // 粘球已武装（蓝）：和自己蓄力光圈同一类的"预告"——公开的，
      //   对手看得见"对面举着粘球"才有反应空间。
      if (view.stickArmed[si]) drawStickArmed(si, px, ph);
      // 乱弹生效中（紫）：绕拍子的电光弧
      if (view.chaos[si] > 0) drawChaos(si, px, ph);
      // 被减速（橙）：拍子上叠一层橙的减速罩
      if (view.slowLeft[view.slots[si].team] > 0) drawSlowed(si, px, ph);
      if (frz) drawFrozen(si, view.freeze[sl.team]);
    }
    for (var sj = 0; sj < view.slots.length; sj += 1) {
      if (view.shield[view.slots[sj].team] > 0) drawShield(sj);
    }

    // 球（分裂球会让这里有好几个，逐个画）
    // ★ 隐形球生效时，被隐形的那一队看到的是"透明的球"：透明度由服务端下发。
    //   全透明时**连尾迹都不画**（只跳过球体、留着尾迹等于还是看得见），
    //   而且要"提前返回"到下一颗球，不能只把 alpha 设成 0 就往下走。
    var vis = appCtx.ballVis();
    if (view.phase === 'playing' || view.phase === 'over') {
      for (var bi2 = 0; bi2 < view.balls.length; bi2 += 1) {
        var ball = view.balls[bi2];
        var bd = view.ballDisps[ball.id];
        if (!bd) continue;
        if (vis <= 0.004) continue;              // 看不见就是看不见，什么都不画
        // ★ sk2 是 [球id, x, y, 槽位]。多球时只对 id 匹配的球取消平滑；
        //   不能把被粘球的位置套给其它球，否则它们会叠到一起，看起来像消失了。
        var stuckHere = view.stuckBall && view.stuckBall.length === 4
          && view.stuckBall[0] === ball.id ? view.stuckBall : 0;
        var bx = stuckHere ? stuckHere[1] : bd.x;
        var by = stuckHere ? stuckHere[2] : bd.y;
        // 弧线球生效时画一串渐隐的尾迹 —— 不画的话玩家只会觉得"球有点飘"，
        // 完全看不出是被道具影响了，也不知道往哪边飘
        var tail = view.tails[ball.id] || [];
        if (view.curve && tail.length > 1) {
          for (var ti = 0; ti < tail.length; ti += 1) {
            var tq = ti / tail.length;
            ctx.globalAlpha = tq * 0.42 * vis;
            ctx.beginPath();
            ctx.arc(tail[ti].x, tail[ti].y, BALL_R * (0.25 + tq * 0.7), 0, Math.PI * 2);
            ctx.fillStyle = view.curve > 0 ? '#7dd3fc' : '#c4b5fd';
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        ctx.arc(bx, by, BALL_R, 0, Math.PI * 2);
        ctx.fillStyle = view.curve ? '#5eead4' : COL.ball;
        ctx.globalAlpha = vis;
        ctx.fill();
        ctx.globalAlpha = 1;
        // 被粘住时套一圈蓝晕 + 一根"还剩多久"的短弧，让"1 秒后自动放出去"可预期
        if (stuckHere) {
          var t2 = performance.now() / 1000;
          ctx.beginPath();
          ctx.arc(bx, by, BALL_R + 5, 0, Math.PI * 2);
          ctx.strokeStyle = SKIN_COL[4];
          ctx.globalAlpha = 0.75;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(bx, by, BALL_R + 5, -Math.PI / 2, -Math.PI / 2 + (t2 % 1) * Math.PI * 2);
          ctx.strokeStyle = '#ffffff';
          ctx.globalAlpha = 0.9;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // 倒计时
    if (view.phase === 'countdown') {
      var secs = Math.ceil(view.countdownMs / 1000);
      ctx.font = '500 20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COL.text;
      ctx.fillText(secs > 0 ? secs + '' : '开始', view.W / 2, view.H / 2 + 4);
    }

    // 结束
    if (view.phase === 'over' && view.winner >= 0) {
      ctx.font = '500 26px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COL.good;
      ctx.fillText('本局结束', view.W / 2, view.H / 2 - 16);
      ctx.font = '400 15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COL.text;
      // ★ winner 是**队伍**号，mySide 是槽位号。coop 里左边两个座位同属 0 队，
      //   直接拿 mySide 去比，会让守下半场的那位永远看到"对手赢了"。
      var winTxt = view.winner === appCtx.teamOfMine()
        ? (view.coop ? '你们赢了' : '你赢了')
        : (view.solo ? 'AI 赢了' : '对手赢了');
      ctx.fillText(winTxt + ' · ' + view.score[0] + ' : ' + view.score[1], view.W / 2, view.H / 2 + 16);
    }

    // 缺人 / 暂停提示
    if (view.mySide >= 0 && view.phase === 'waiting') {
      var hasPeer = view.present.length === view.slots.length
        && view.present.every(function (v) { return v === 1; });
      ctx.font = '400 15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COL.faint;
      ctx.fillText(hasPeer
        ? '已暂停'
        : (view.coop ? '等待队友加入…' : '等待对手加入…'), view.W / 2, view.H / 2 + 60);
    }

    // 暂停（真人按的）。
    // ★ 与"缺人自动冻结"分开：那种情况 phase 是 waiting，上面刚画过"等待对手加入…"，
    //   这里再糊一层就是两行字叠在一起。
    // ★ 画在所有运动物体**之后**，所以球会被压暗 —— 要的就是"停住了"的观感，
    //   而不是"球不动了但界面毫无变化"（那样人只会以为自己卡了或者对面掉线了）。
    if (view.userPaused && view.mySide >= 0 && view.phase !== 'waiting') {
      ctx.fillStyle = 'rgba(9, 13, 24, 0.58)';
      ctx.fillRect(0, 0, view.W, view.H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '500 26px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#e8eefb';
      ctx.fillText('已暂停', view.W / 2, view.H / 2 - 20);
      ctx.font = '400 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COL.text;
      ctx.fillText(pauseWhoText(), view.W / 2, view.H / 2 + 12);
      ctx.fillText('任意一方点「继续」即可恢复', view.W / 2, view.H / 2 + 36);
    }

    // 断线时在画面上直说，别让人以为是自己的操作卡住了
    if (view.mySide >= 0 && !view.connected) {
      ctx.fillStyle = 'rgba(9, 13, 24, 0.74)';
      ctx.fillRect(0, 0, view.W, view.H);
      ctx.font = '500 20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#ffb4a2';
      ctx.fillText('连接断开，正在重连…', view.W / 2, view.H / 2);
      ctx.font = '400 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = COL.text;
      ctx.fillText('重连后会自动坐回原位，比分不会丢', view.W / 2, view.H / 2 + 26);
    }
  }

  var lastFrame = 0;
  function loop(ts) {
    var dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 0.05) : 0.016;
    lastFrame = ts;

    // 暂停中**不做本地预测**：服务端此时根本不推进拍子，本地先动起来的话，
    // 恢复那一刻会被"与服务器对账"那一句拽回去（看起来像抖了一下），
    // 而且暂停时把拍子挪走本来也算不上是"暂停"。触摸目标一起冻住，理由相同。
    var frozen = !!view.userPaused;

    // 自己的拍子本地预测：立刻响应操作，不等服务器回话
    if (view.mySide >= 0 && !frozen && view.slots[view.mySide]) {
      var i = view.mySide;
      var mi = view.slots[i];
      var d = view.dir;
      var myHalf = (PADDLE_H * view.paddleMul[mi.team]) / 2;   // 拍子变长后边界也跟着变
      // ★ 活动范围要按模式收窄：coop 里守上半场那位不能把拍子推过半场线。
      //   不收的话本地预测会先冲出去、再被服务器拽回来，看起来像在抖。
      var lo = mi.span[0] + myHalf;
      var hi = mi.span[1] - myHalf;
      if (d !== 0 && hi >= lo) {
        view.paddleDisp[i] = Math.max(lo,
          Math.min(hi, view.paddleDisp[i] + d * PADDLE_SPEED * dt));
      }
      // 与服务器对账：只有偏差很大才拉回，避免正常情况下的抖动
      var diff = view.paddles[i] - view.paddleDisp[i];
      if (Math.abs(diff) > 50) view.paddleDisp[i] += diff * 0.25;
    }

    // 其余拍子与球：向服务器值收敛，抹平 30Hz 的台阶。
    // ★ 落后量 ≈ 球速/26（与帧率无关），这是这个游戏里"看到的球"和
    //   "服务端判定的球"之间唯一的时差来源，改动前先看清这一点。
    var k = Math.min(1, dt * 26);
    for (var pi = 0; pi < view.slots.length; pi += 1) {
      if (pi === view.mySide) continue;
      view.paddleDisp[pi] += (view.paddles[pi] - view.paddleDisp[pi]) * k;
    }

    // 球：逐个 id 收敛并采样尾迹
    for (var bi = 0; bi < view.balls.length; bi += 1) {
      var bb = view.balls[bi];
      var dp = view.ballDisps[bb.id];
      if (!dp) continue;                      // 理论上不会发生（贴快照时已建）
      dp.x += (bb.x - dp.x) * k;
      dp.y += (bb.y - dp.y) * k;

      var tail = view.tails[bb.id] || (view.tails[bb.id] = []);
      // 位置突然跳变（发球、得分后重新开球、分裂出来的新球）就把旧尾巴丢掉，
      // 否则会从上一个落点拉出一条横贯全场的假弧线
      var tl = tail[tail.length - 1];
      if (tl && Math.abs(dp.x - tl.x) + Math.abs(dp.y - tl.y) > 120) tail.length = 0;
      tail.push({ x: dp.x, y: dp.y });
      if (tail.length > 18) tail.shift();
    }

    // 触摸目标跟随
    var touchTargetY = appCtx.input.getTouchTargetY();
    if (touchTargetY !== null && view.mySide >= 0 && !frozen) {
      var td = touchTargetY - view.paddleDisp[view.mySide];
      appCtx.input.setDir(Math.abs(td) > 8 ? (td > 0 ? 1 : -1) : 0);
    }

    appCtx.audio.bgmTick(dt);   // 用真实 dt；音量状态机不该被游戏的暂停冻住

    fitCanvas();
    appCtx.ui.layoutSkillBtns();   // 技能按钮每帧跟着自己的拍子走（拍子一直在动）
    draw();
    appCtx.diag.recordMatchFrame(ts);
    requestAnimationFrame(loop);
  }
  /**
   * 装上渲染模块。
   *
   * @param {object} app 应用上下文。
   * @returns {object} 渲染模块对外的接口。
   */
  function attach(app) {
    appCtx = app;
    view = app.view;
    canvas = app.dom.canvas;
    ctx = app.dom.ctx;
    stage = app.dom.stage;

    COL = app.COL;
    COOP_COL = app.COOP_COL;
    COOP_COL_FROZEN = app.COOP_COL_FROZEN;
    POWERUP_STYLE = app.POWERUP_STYLE;
    POWERUP_R = app.POWERUP_R;
    LEVEL_NAMES = app.LEVEL_NAMES;
    SKIN_COL = app.SKIN_COL;
    SKIN_COL_FROZEN = app.SKIN_COL_FROZEN;
    WIND_MS = app.WIND_MS;
    HOLE_R = app.HOLE_R;
    HOLE_LIFE_MS = app.HOLE_LIFE_MS;
    WIN_SCORE = app.WIN_SCORE;
    PADDLE_W = app.PADDLE_W;
    PADDLE_H = app.PADDLE_H;
    PADDLE_MARGIN = app.PADDLE_MARGIN;
    BALL_R = app.BALL_R;
    PADDLE_SPEED = app.PADDLE_SPEED;

    window.addEventListener('resize', fitCanvas);

    var api = {
      fitCanvas: fitCanvas,
      loop: loop,
      setMode: setMode,
      applyBallSnapshot: applyBallSnapshot,
      // 探针要核对"画出来的拍子是什么颜色"，这两条被 window.__probe 直接调用
      paddleFill: paddleFill,
      skinFill: skinFill
    };
    app.render = api;
    return api;
  }

  global.PongApp = global.PongApp || {};
  global.PongApp.render = attach;
})(window);
