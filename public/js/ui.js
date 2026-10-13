/**
 * 界面：菜单、覆盖层、技能按钮、局间重选拍子，以及"我选的皮肤"这份本机偏好。
 *
 * 这个模块只**画界面**和**上报意图**。它不判断"现在能不能改" —— 按钮显不显示、
 * 暂停成没成、技能放不放得出来，一律读服务端快照，本地不做乐观更新。
 *
 * DOM id 与 class 一个都没改：探针按 id 取元素，页面也靠这些 id 互相挂事件。
 */

(function (global) {
  'use strict';

  var appCtx = null;
  var view = null;
  var overlay = null;
  var overlayBody = null;
  var netBadge = null;
  var pauseBtn = null;
  var skillBtnEls = null;
  var canvas = null;

  var SKIN_NAMES = null, SKIN_DESC = null, SKIN_GLYPH = null, SKIN_TIP = null;
  var SKIN_COL = null, SKIN_CD_S = null, POWERUP_STYLE = null, POWERUP_DESC = null;
  var LEVEL_NAMES = null;

  // AI 难度，默认"普通"。菜单里的三个档就是它，属于纯界面状态 ——
  // 真正生效由服务端按它建房，玩家自己那份不进任何游戏逻辑。
  var aiLevel = 1;

  // 刚才尝试加入的房间码。加入失败时服务端回到 'error'，由网络模块来取走它
  // 填回输入框，省得用户重新敲一遍。取走即清空 —— 同���个码只补一次。
  var lastJoinCode = null;

  // ---------- 我选的皮肤 ----------
  // 存在本机（localStorage）而不是服务端：它是"我的偏好"，换房间、换对手都该跟着我走。
  // ★ 带邀请链接进来的人是**自动加入**的、看不到菜单，所以这一份存储就是他们的皮肤来源。
  var SKIN_KEY = 'pong.skin';
  function readSkin() {
    try {
      var v = Number(localStorage.getItem(SKIN_KEY));
      return (Number.isInteger(v) && v >= 0 && v < SKIN_COL.length) ? v : 0;
    } catch (e) { return 0; }
  }
  function saveSkin(v) {
    try { localStorage.setItem(SKIN_KEY, String(v)); } catch (e) {}
  }
  var mySkin = readSkin();

  /**
   * 生成一整块"选拍子"面板（九宫格）。菜单与**局间重选**共用同一份 DOM 构造，
   * 只有标题和"选完之后干什么"不一样。
   *
   * ★ 为什么不做成两套：皮肤表、配色、说明文案有 9 项 × 4 张表，
   *   复制成两份就等于以后每次加皮肤都要改两处，漏一处就会出现
   *   "菜单里能选、局间选不到"这种只有特定路径才暴露的 bug。
   * ★ `onPick(idx)` 在点击时被调用（菜单里只改本地选择，局间要顺手发出去）。
   */
  function buildSkinPicker(opts) {
    var box = document.createElement('div');
    box.className = 'skinpick';

    var head = document.createElement('div');
    head.className = 'skinpick-head';
    head.textContent = opts && opts.title ? opts.title : '我的拍子（颜色 = 技能）';

    var grid = document.createElement('div');
    // ★ 保留 `skinrow` 这个类名是**有意的**：五个探针（probe / probe-coop /
    //   probe-crossplay / probe-skills / probe-mobile）都用
    //   `#overlayBody .skinrow .swatch` 这个选择器点皮肤。
    //   新网格换的是**布局**（3 列九宫格）与**内容**（每格带技能说明），
    //   不换"它是一个装皮肤按钮的行"。类名留着，探针一行都不用改，
    //   也就不会有"测试跟着实现一起改"这种把 bug 一起改掉的事。
    grid.className = 'skingrid skinrow';

    var cells = [];
    var cur = -1;
    function paint(idx) {
      cur = idx;
      for (var i = 0; i < cells.length; i += 1) {
        var on = i === idx;
        cells[i].bar.className = 'sp-bar' + (on ? ' on' : '');
        cells[i].root.className = 'sp swatch' + (on ? ' on' : '');
      }
    }
    for (var si = 0; si < SKIN_NAMES.length; si += 1) {
      (function (idx) {
        var b = document.createElement('button');
        b.className = 'sp swatch';
        b.type = 'button';
        // 里面那一小条用真实的皮肤色画出来 —— 光写"青/黄/红"看不出到底什么颜色
        var bar = document.createElement('i');
        bar.className = 'sp-bar';
        bar.style.background = SKIN_COL[idx];
        var nm = document.createElement('b');
        nm.className = 'sp-name';
        nm.textContent = SKIN_NAMES[idx] + (SKIN_DESC[idx] === '无技能' ? '' : ' · ' + SKIN_DESC[idx]);
        var tip = document.createElement('span');
        tip.className = 'sp-tip';
        tip.textContent = SKIN_TIP[idx];
        b.appendChild(bar);
        b.appendChild(nm);
        b.appendChild(tip);
        b.onclick = function () {
          paint(idx);
          if (opts && opts.onPick) opts.onPick(idx);
        };
        cells.push({ root: b, bar: bar });
        grid.appendChild(b);
      })(si);
    }
    paint(typeof opts.cur === 'number' ? opts.cur : mySkin);
    box.appendChild(head);
    box.appendChild(grid);

    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.style.marginTop = '8px';
    hint.textContent = '颜色就是技能：灰 = 没有技能，其余八种各有各的技能。（AI 不选拍子。）';
    box.appendChild(hint);
    box.__paint = paint;
    return box;
  }

  /**
   * 「图鉴」：拍子九种 + 道具九种，各一行图标 + 一句话。
   *
   * 为什么做成**默认收起的折叠块**而不是直接铺开：
   *   菜单本来就已经被九宫格撑到 ~680px，再铺十八行说明会把它推过一千像素，
   *   矮视口上"创建房间"要滚好几屏才够得着 —— 那是把"方便查"变成"妨碍进游戏"。
   *   收起时只占一行（18×1.6 高度），想看的人点一下就在原地展开。
   * ★ 拍子侧的数据源就是菜单里那套（SKIN_* 四个数组），不另抄一份 —— 抄了迟早
   *   会出现"菜单写风、图鉴写幻影"这种两边不同步的错。
   */
  function buildCodex() {
    var wrap = document.createElement('div');
    wrap.className = 'codex';

    var btn = document.createElement('button');
    btn.className = 'codex-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '▸ 拍子 & 道具简介';

    var body = document.createElement('div');
    body.className = 'codex-body';
    body.style.display = 'none';

    function addTitle(t) {
      var d = document.createElement('div');
      d.className = 'codex-title';
      d.textContent = t;
      body.appendChild(d);
    }
    function addRow(color, glyph, name, desc) {
      var r = document.createElement('div');
      r.className = 'codex-row';
      var chip = document.createElement('i');
      chip.className = 'codex-chip';
      chip.style.background = color;
      var b = document.createElement('b');
      b.className = 'codex-glyph';
      b.textContent = glyph || '';
      chip.appendChild(b);
      var tx = document.createElement('span');
      tx.className = 'codex-text';
      var nm = document.createElement('b');
      nm.textContent = name;
      var ds = document.createElement('span');
      ds.className = 'codex-desc';
      ds.textContent = ' — ' + desc;
      tx.appendChild(nm);
      tx.appendChild(ds);
      r.appendChild(chip);
      r.appendChild(tx);
      body.appendChild(r);
    }

    addTitle('拍子（颜色 = 技能，释放：鼠标点 / 键盘 Q / 手机上球场边上的圆钮）');
    for (var i = 0; i < SKIN_NAMES.length; i += 1) {
      addRow(SKIN_COL[i], SKIN_GLYPH[i],
        SKIN_NAMES[i] + (SKIN_DESC[i] === '无技能' ? '' : ' · ' + SKIN_DESC[i]),
        SKIN_TIP[i] + (SKIN_CD_S[i] ? '（冷却 ' + SKIN_CD_S[i] + ' 秒）' : ''));
    }
    addTitle('道具（中场随机冒出来，谁碰到归谁）');
    for (var j = 0; j < POWERUP_STYLE.length; j += 1) {
      addRow(POWERUP_STYLE[j].c, POWERUP_STYLE[j].label,
        '道具 ' + (j + 1), POWERUP_DESC[j] || '');
    }

    btn.onclick = function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      btn.textContent = (open ? '▸' : '▾') + ' 拍子 & 道具简介';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      // 展开之后面板会一下子变高，按钮可能被推到视口外 —— 拉回来
      if (!open) btn.scrollIntoView({ block: 'nearest' });
    };

    wrap.appendChild(btn);
    wrap.appendChild(body);
    return wrap;
  }

  function showMenu(errMsg, prefill) {
    overlay.classList.remove('hidden');
    overlayBody.innerHTML = '';
    var h = document.createElement('h2');
    h.textContent = '双人实时对战';
    var p = document.createElement('p');
    // 带着邀请码进来时把话说清楚：码已经替你填好了，选完拍子点「加入」就行。
    // ★ 这一段是有意为之 —— 从链接进来的人也要能选拍子，所以不再"打开链接就自动进房"。
    p.textContent = errMsg
      ? errMsg
      : (prefill
        ? '已为你填好房间码 ' + prefill + '。选好拍子，点「加入」就能进。'
        : '创建房间拿到一个码，把链接发给朋友，两边就能实时打。');

    // ---- 拍子皮肤（颜色 = 技能） ----
    var skinBox = buildSkinPicker({
      title: '我的拍子（颜色 = 技能）',
      cur: mySkin,
      onPick: function (idx) { mySkin = idx; saveSkin(idx); }
    });
    var skinLabel = skinBox;
    var skinHint = document.createElement('div');
    skinHint.className = 'hint';
    skinHint.style.display = 'none';

    var createBtn = document.createElement('button');
    createBtn.className = 'primary';
    createBtn.textContent = '创建房间';
    createBtn.onclick = function () {
      createBtn.disabled = true;
      createBtn.textContent = '创建中…';
      appCtx.net.clearSession();
      appCtx.net.send({ t: 'create', skin: mySkin });
    };

    var row = document.createElement('div');
    row.className = 'joinrow';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 6;
    input.placeholder = '房间码';
    input.value = prefill || '';
    input.oninput = function () {
      input.value = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    };
    input.onkeydown = function (e) { if (e.key === 'Enter') joinBtn.click(); };

    var joinBtn = document.createElement('button');
    joinBtn.className = prefill ? 'primary' : 'ghost';
    if (prefill) joinBtn.style.width = 'auto';
    joinBtn.textContent = '加入';
    joinBtn.onclick = function () {
      var c = (input.value || '').trim().toUpperCase();
      if (c.length !== 6) { p.textContent = '房间码是 6 位，检查一下。'; return; }
      joinBtn.disabled = true;
      joinBtn.textContent = '加入中…';
      lastJoinCode = c;
      appCtx.net.clearSession();
      appCtx.net.send({ t: 'join', code: c, skin: mySkin });
    };

    row.appendChild(input);
    row.appendChild(joinBtn);

    // ---- 打 AI：单人和双人两个入口，共用同一档难度 ----
    var divider = document.createElement('div');
    divider.className = 'divider';
    divider.textContent = '或者';

    var segLabel = document.createElement('div');
    segLabel.className = 'seglabel';
    segLabel.textContent = 'AI 难度';

    var seg = document.createElement('div');
    seg.className = 'segrow';
    var segBtns = [];
    for (var li = 0; li < LEVEL_NAMES.length; li += 1) {
      (function (lv) {
        var b = document.createElement('button');
        b.className = 'seg' + (lv === aiLevel ? ' on' : '');
        b.textContent = LEVEL_NAMES[lv];
        b.onclick = function () {
          aiLevel = lv;
          for (var q = 0; q < segBtns.length; q += 1) {
            segBtns[q].className = 'seg' + (q === lv ? ' on' : '');
          }
        };
        segBtns.push(b);
        seg.appendChild(b);
      })(li);
    }

    var aiRow = document.createElement('div');
    aiRow.className = 'duorow';

    var soloBtn = document.createElement('button');
    soloBtn.className = 'ghost';
    soloBtn.textContent = '单人打 AI';
    soloBtn.onclick = function () {
      soloBtn.disabled = true;
      soloBtn.textContent = '开局中…';
      appCtx.net.clearSession();
      appCtx.net.send({ t: 'create', mode: 'solo', level: aiLevel, skin: mySkin });
    };

    var coopBtn = document.createElement('button');
    coopBtn.className = 'ghost';
    coopBtn.textContent = '双人打 AI';
    coopBtn.onclick = function () {
      coopBtn.disabled = true;
      coopBtn.textContent = '开局中…';
      appCtx.net.clearSession();
      appCtx.net.send({ t: 'create', mode: 'coop', level: aiLevel, skin: mySkin });
    };

    aiRow.appendChild(soloBtn);
    aiRow.appendChild(coopBtn);

    overlayBody.appendChild(h);
    overlayBody.appendChild(p);
    overlayBody.appendChild(skinLabel);
    overlayBody.appendChild(skinHint);
    overlayBody.appendChild(createBtn);
    overlayBody.appendChild(row);
    overlayBody.appendChild(divider);
    overlayBody.appendChild(segLabel);
    overlayBody.appendChild(seg);
    overlayBody.appendChild(aiRow);
    overlayBody.appendChild(buildCodex());

    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '「双人打 AI」是两个人各守球台的一半，一起对付右边更快的 AI ——'
      + '开好房把链接发给朋友就行。同一个房间最多两个人。';
    overlayBody.appendChild(hint);
  }

  /**
   * 暂停按钮。只在「已经坐下 且 阶段不是 waiting」时出现 —— waiting 既包括
   * "对手还没进来"，也包括"缺人自动冻结"，那两种情况下比赛本来就没在跑，
   * 摆一个暂停按钮只会让人以为按了会有什么变化。
   *
   * ★ 标签一律以**服务端快照**为准，绝不乐观翻转：按下之后到下一帧快照之间
   *   若又按了一下（两个人同时按就会这样），乐观看的状态立刻和真实状态分叉，
   *   而分叉之后按钮上写的字恰好是反的 —— 那比慢 30ms 难受得多。
   */
  function syncPauseBtn() {
    if (!pauseBtn) return;
    var show = view.mySide >= 0 && view.phase !== 'waiting';
    pauseBtn.style.display = show ? '' : 'none';
    var p = show && !!view.userPaused;
    var want = p ? '继续' : '暂停';
    if (pauseBtn.textContent !== want) pauseBtn.textContent = want;
    var cls = 'soundbtn' + (p ? ' active' : '');
    if (pauseBtn.className !== cls) pauseBtn.className = cls;
  }

  /**
   * 技能按钮的显隐与内容。每个**有技能**的槽位一个，位置由 layoutSkillBtns 每帧算。
   *
   * ★ 别人的按钮只当仪表盘：看得见队友/对手的技能好没好，但点不动
   *   （`.foreign` 上了 pointer-events:none）。需求要的是"每个拍子边上都有自己的技能"，
   *   把这个布局摆出来才算数；同时又不该让人误以为能替对面按。
   * ★ AI 是灰板子，所以 coop 里第三个槽位不会冒出按钮来。
   */
  function syncSkillBtns() {
    for (var i = 0; i < skillBtnEls.length; i += 1) {
      var el = skillBtnEls[i];
      if (!el) continue;
      var skin = view.skins[i];
      // ★ 条件里的 `phase !== 'waiting'` 不能省：等待面板是盖在球场上的整块遮罩，
      //   而技能按钮是 position:fixed + z-index:5 —— 不收起来的话它会浮在菜单上面。
      //   这也和暂停按钮的显示条件一致（都只在"比赛真的在跑"的时候出现）。
      var has = view.mySide >= 0 && view.phase !== 'waiting'
        && i < view.slots.length && typeof skin === 'number' && skin > 0;
      el.style.display = has ? 'flex' : 'none';
      if (!has) continue;

      var mine = i === view.mySide;
      var live = view.phase === 'playing';       // 只有 playing 期间技能才真的放得出去
      var cd = view.skillCd[i] || 0;
      // 0.05s 的容差：服务端下发的是四舍五入到 0.1 的小数，正好卡在 0 附近时
      // 用严格 > 0 判断会让按钮在"就绪/冷却"之间闪一下。
      var cooling = cd > 0.05;
      var ready = cd <= 0.05 && (mine ? live : true);
      var txt = cooling ? String(Math.ceil(cd)) : SKIN_GLYPH[skin];
      if (el.textContent !== txt) el.textContent = txt;
      var total = SKIN_CD_S[skin] || 1;
      el.style.setProperty('--p', (cooling ? Math.min(1, cd / total) : 0).toFixed(3));
      el.style.color = ready ? SKIN_COL[skin] : '#7c8aa5';
      el.title = SKIN_NAMES[skin] + ' · ' + SKIN_DESC[skin]
        + (mine ? '（电脑上也能按 Q）' : '（对手的技能）');
      var cls = 'skillbtn' + (mine ? (ready ? ' ready' : '') : ' foreign');
      if (el.className !== cls) el.className = cls;
    }
    // ★ 摆完位置要立刻算一次，不能只等 loop 里的那一帧：
    //   rAF 在**后台标签页**会被浏览器暂停（实测：另一个标签页被打开后，
    //   本页的按钮全部停在 left:0/top:0，因为 layoutSkillBtns 一帧都没跑）。
    //   快照是 WebSocket 推的，后台照样到，所以挂在这里能让位置与"页面在不在前台"无关。
    layoutSkillBtns();
  }

  /**
   * 把技能按钮摆在**固定的角落**：自己半场的左上角。
   *
   * ★ 为什么不再跟着拍子走：手机端那条拍子是被手指盖住的，按钮跟着它走就等于
   *   "技能按钮永远在手指底下"——玩家得先挪开手指才能点，而挪开手指球就漏了。
   *   固定住之后按钮位置恒为常量：单手也能按，肌肉记忆能成立。
   * ★ "自己半场的左上"在三种情况下分别是：
   *   · 双人（duel）：我在左边 → 球场左上；我在右边 → **球场右上**。
   *     （"自己半场的左上"从对面看过去就是右上，所以按 edge 镜像。）
   *   · 人机（solo）：我永远是左边那一块，就是球场左上。
   *   · 合作（coop）：两个真人各占自己半场的左上，纵向**错开一行**（上面那个贴顶、
   *     下面那个往下挪一个按钮高），否则两块拍子高度相近时按钮会叠在一起。
   * ★ .stage 有 overflow:hidden，所以还得是 position:fixed（见 CSS 里的注释）；
   *   这里只负责算 left/top。
   */
  function layoutSkillBtns() {
    if (view.mySide < 0) return;
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var size = 38;
    var pad = 8;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var vtop = Math.max(0, r.top);
    var vbot = Math.min(vh, r.bottom);
    // ★★ 必须避开页眉那条横带。
    //   手机横屏时页眉是 position:absolute 浮在球场上（右边一排按钮：声音 / 暂停 / 徽章），
    //   而**技能按钮也固定在左上/右上** —— 第一版就是这么写的，结果手机端
    //   "点技能按钮"的触摸落在了暂停按钮身上（探针实测：中心点上是 pauseBtn），
    //   也就是**暂停按钮把技能按钮盖住了**：想放技能却把比赛暂停了。
    //   这里把页眉的实际底边量出来，按钮从它下面开始排。
    //   桌面端页眉不在球场上（球场上边在页眉下面），量出来是 0，一行都不影响。
    var headEl = document.querySelector('header');
    var reserve = 0;
    if (headEl) {
      var hb = headEl.getBoundingClientRect();
      // 只在页眉真的压在球场上沿时才让位（横屏块的情形）
      if (hb.height > 0 && hb.bottom > vtop) reserve = Math.max(0, hb.bottom - vtop);
    }
    var count = 0;
    var total = 0;
    for (var q = 0; q < skillBtnEls.length; q += 1) {
      var eq = skillBtnEls[q];
      if (eq && eq.style.display !== 'none') total += 1;
    }
    for (var i = 0; i < skillBtnEls.length; i += 1) {
      var el = skillBtnEls[i];
      if (!el || el.style.display === 'none') continue;
      var sl = view.slots[i];
      if (!sl) continue;
      var leftSide = sl.edge !== 'right';
      // ★ 就是**球场内**的左上角，不再有"往球场外侧推"的分支。
      //   第一版这里写了一句"外侧塞得下就摆外侧"，结果按钮跑到画面左边缘外面
      //   （实测 132 < 球场左边 178）—— 那既不是"半场左上"，也让"固定"失去意义。
      var x = leftSide ? r.left + pad : r.right - pad - size;
      var y = vtop + reserve + pad;
      // coop 里同一半场有两个真人：纵向错开一行，否则两块拍子高度相近时按钮会叠住
      if (total > 1) {
        var row = 0;
        for (var k = 0; k < i; k += 1) {
          var ek = skillBtnEls[k];
          if (ek && ek.style.display !== 'none') row += 1;
        }
        var sameHalf = false;
        for (var m = 0; m < skillBtnEls.length; m += 1) {
          if (m === i) continue;
          var em = skillBtnEls[m];
          if (!em || em.style.display === 'none') continue;
          var sm = view.slots[m];
          if (sm && (sm.edge !== 'right') === leftSide) sameHalf = true;
        }
        if (sameHalf) y = vtop + reserve + pad + row * (size + 6);
      }
      if (y + size > vbot - 2) y = Math.max(vtop + pad, vbot - size - pad);
      var xx = Math.round(Math.max(2, Math.min(vw - size - 2, x)));
      var yy = Math.round(Math.max(2, Math.min(vh - size - 2, y)));
      var key = xx + ',' + yy;
      if (el.__xy !== key) {
        el.__xy = key;
        el.style.left = xx + 'px';
        el.style.top = yy + 'px';
      }
      count += 1; void count;
    }
  }

  function initSkillBtns() {
    for (var i = 0; i < skillBtnEls.length; i += 1) {
      (function (idx) {
        var el = skillBtnEls[idx];
        if (!el) return;
        el.onclick = function () {
          // 别人的按钮本来就点不到（pointer-events:none），这里再挡一道，
          // 免得以后有人手滑把那条 CSS 去掉就变成"能替对面放技能"。
          if (idx !== view.mySide) return;
          appCtx.input.requestSkill();
        };
      })(i);
    }
    syncSkillBtns();
  }

  /** AI 模式的常驻栏。这两个模式下画布上不会再有遮罩，退出入口得挂在这里 */
  function syncSoloBar() {
    var bar = document.getElementById('soloBar');
    var txt = document.getElementById('soloText');
    var lab = document.getElementById('soloLabel');
    if (!bar) return;
    if (view.solo && view.mySide >= 0) {
      bar.style.display = 'flex';
      // coop 里还得告诉每个人"你守哪半场"，否则两个人不知道自己该管哪一块
      var mine = view.coop ? (view.mySide === 0 ? '你守上半场 · ' : '你守下半场 · ') : '对手 ';
      if (txt && txt.childNodes[0]) txt.childNodes[0].nodeValue = mine;
      if (lab) lab.textContent = 'AI · ' + (view.botName || LEVEL_NAMES[view.botLevel] || '普通');
    } else {
      bar.style.display = 'none';
    }
  }

  function initSoloBar() {
    var btn = document.getElementById('soloLeave');
    if (btn) btn.onclick = function () { leaveRoom(); };
  }

  function initPauseBtn() {
    if (!pauseBtn) return;
    // 只上报"我按了一下"，具体切到什么状态以服务端快照为准。
    // 也正因为这样，这里不需要 disabled / 防连点 —— 连点两次就是切两次，
    // 而需求正是"每个人点都会生效"。
    pauseBtn.onclick = function () { appCtx.input.requestPause(); };
    syncPauseBtn();
  }

  /** 退出当前房间回到菜单。人机和双人两条路都走这里，避免两套逻辑跑偏 */
  function leaveRoom() {
    appCtx.net.clearSession();
    appCtx.net.closeByUs();
    view.mySide = -1;
    view.code = '';
    view.solo = false;
    view.coop = false;
    view.phase = 'waiting';
    view.userPaused = false;
    view.pausedBy = -1;
    // 技能按钮/冷却也要清干净：不清的话退出房间那一瞬间，球场上还挂着上一个人的
    // 技能按钮（它挂在 .wrap 上、不随遮罩一起消失）
    view.skins = [0, 0];
    view.skillCd = [0, 0];
    view.boostArmed = [0, 0];
    view.winds = [];
    view.phantom = [0, 0];
    syncSoloBar();
    syncPauseBtn();
    syncSkillBtns();
    // 断开后重新连一次，拿一个干净的新连接再建房
    setTimeout(function () { appCtx.net.connect(); }, 120);
    showMenu();
  }

  function showWaiting() {
    overlay.classList.remove('hidden');
    overlayBody.innerHTML = '';

    var h = document.createElement('h2');
    h.textContent = view.coop ? '双人打 AI' : (view.solo ? '单人打 AI' : '房间已就绪');

    // 单人打 AI 没有队友要邀请，所以不显示房间码和邀请链接 ——
    // 摆一个没人会用的邀请链接只会让人以为还要再找个人才能开始。
    // 这个面板其实只会闪一下（AI 永远"在场"，第一帧快照就把遮罩撤了），
    // 常驻的退出入口在画布下方的 soloBar。
    if (view.solo && !view.coop) {
      var sp = document.createElement('p');
      sp.innerHTML = '对手：<b>AI · ' + (view.botName || LEVEL_NAMES[view.botLevel] || '普通')
        + '</b><br>倒计时结束后自动开球，先到 11 分赢。';
      overlayBody.appendChild(h);
      overlayBody.appendChild(sp);
      return;
    }

    var code = document.createElement('div');
    code.className = 'code';
    code.textContent = view.code;

    // coop 要等的是队友（他会坐进下半场），不是对手 —— 文案说清这个差别
    var p = document.createElement('p');
    p.innerHTML = view.coop
      ? '把下面这个链接发给队友，他打开后选好拍子、点「加入」，坐在<b>下半场</b>。<br>两个人都到齐后比赛自动开始。'
      : '把下面这个链接发给朋友，他打开后选好拍子、点「加入」就能进来。<br>两个人都进来后比赛自动开始。';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'primary';
    copyBtn.textContent = '复制邀请链接';
    copyBtn.onclick = function () {
      var link = location.origin + location.pathname + '?room=' + view.code;
      var done = function () {
        copyBtn.textContent = '已复制 ✓';
        setTimeout(function () { copyBtn.textContent = '复制邀请链接'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, function () { fallbackCopy(link, done); });
      } else {
        fallbackCopy(link, done);
      }
    };

    var stat = document.createElement('p');
    stat.style.marginTop = '14px';
    stat.innerHTML = '<span class="waitdot">●</span> '
      + (view.coop ? '等待队友加入…' : '等待对手加入…');
    stat.id = 'waitStat';

    var row = document.createElement('div');
    row.className = 'joinrow';
    var leave = document.createElement('button');
    leave.className = 'ghost';
    leave.style.width = '100%';
    leave.textContent = '离开房间';
    leave.onclick = function () { leaveRoom(); };
    row.appendChild(leave);

    overlayBody.appendChild(h);
    overlayBody.appendChild(code);
    overlayBody.appendChild(p);
    overlayBody.appendChild(copyBtn);
    overlayBody.appendChild(stat);
    overlayBody.appendChild(row);
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  function showDisconnected(reason) {
    if (view.mySide < 0) {
      overlay.classList.remove('hidden');
      overlayBody.innerHTML = '';
      var h = document.createElement('h2');
      h.textContent = '连接中断';
      var p = document.createElement('p');
      p.textContent = reason + '，正在自动重连。你的座位会保留一会儿。';
      overlayBody.appendChild(h);
      overlayBody.appendChild(p);
    }
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  // ---------- 局终结算弹出框 ----------
  // 一局打完，用覆盖层弹出**逐分明细**（哪一分归谁），替代画布上那几行字。
  // 数据：view.pointWinners 由 network.js 从服务端 mr 取（scorer 序列），
  //       比分 / 胜方在 view.score / view.winner。
  // ★ 每局只弹一次：view.matchId 每局都换（服务端 matchNo 自增），拿它当键。
  // ★ over 阶段"人齐了就撤覆盖层"的自动清理会跳过（network.js 里），
  //   所以下一局倒计时开始时才由那条逻辑把弹框收掉。
  var settlementShownFor = '';
  function showSettlement() {
    if (view.phase !== 'over' || view.winner < 0) return;
    if (!view.matchId || settlementShownFor === view.matchId) return;
    var pw = view.pointWinners;
    if (!pw || !pw.length) return;
    settlementShownFor = view.matchId;

    var myT = appCtx.teamOfMine();
    var label = function (team) {
      return team === myT
        ? (view.coop ? '我方' : '我')
        : (view.solo ? (view.botName || 'AI') : '对手');
    };

    overlayBody.innerHTML = '';
    var h = document.createElement('h2');
    h.textContent = '本局结束';
    var p = document.createElement('p');
    p.textContent = (view.winner === myT
      ? (view.coop ? '你们赢了' : '你赢了')
      : (view.solo ? 'AI 赢了' : '对手赢了'))
      + ' · ' + view.score[0] + ' : ' + view.score[1];

    // 逐分表：第一列行标签，后面每分一列。
    // 谁赢的那一分，谁那一行对应列打 ✓（绿色），另一边给个浅色点。
    var table = document.createElement('div');
    table.className = 'settle';
    table.style.gridTemplateColumns = '44px repeat(' + pw.length + ', 22px)';
    function row(tag, team) {
      var t = document.createElement('span');
      t.className = 'lbl' + (team !== null && team === view.winner ? ' win' : '');
      t.textContent = tag;
      table.appendChild(t);
      for (var i = 0; i < pw.length; i += 1) {
        var c = document.createElement('span');
        if (team === null) { c.className = 'num'; c.textContent = i + 1; }
        else {
          c.className = pw[i] === team ? 'hit' : 'miss';
          c.textContent = pw[i] === team ? '✓' : '·';
        }
        table.appendChild(c);
      }
    }
    row('', null);
    row(label(0), 0);
    row(label(1), 1);

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '下一局马上开始…';

    var wrap = document.createElement('div');
    wrap.className = 'settle-wrap';
    wrap.appendChild(table);
    overlayBody.appendChild(h);
    overlayBody.appendChild(p);
    overlayBody.appendChild(wrap);
    overlayBody.appendChild(hint);
    overlay.classList.remove('hidden');
  }

  // 局间重选拍子。需求："无论什么模式，每结束一局都要可以重新选拍子"。
  // ★ 触发源是服务端下发的 rsel（不是客户端自己拿 phase 猜）：
  //   窗口什么时候开（真的翻了新一局）与什么时候关（球真的发出去了）都是服务端的事实，
  //   客户端只负责把它画出来。这样两边不会对"现在能不能改"有分歧。
  // ★ 面板**不进入** view.phase 那套状态机：它是一层临时浮层，
  //   关掉之后露出的是正常的倒计时画面，球还在动。所以不能用 showWaiting 那套。
  var reselectOn = false;
  var reselectBox = null;

  function closeReselect() {
    if (!reselectOn) return;
    reselectOn = false;
    reselectBox = null;
    hideOverlay();
    overlayBody.innerHTML = '';
  }

  function openReselect() {
    if (reselectOn) return;
    reselectOn = true;
    overlay.classList.remove('hidden');
    overlayBody.innerHTML = '';
    var h = document.createElement('h2');
    h.textContent = '新一局 · 换拍子';
    var p = document.createElement('p');
    p.textContent = '球发出去之前都能换。选完这块面板会自动收起 —— 选中的拍子颜色就是它的技能。';
    overlayBody.appendChild(h);
    overlayBody.appendChild(p);
    var box = buildSkinPicker({
      title: '我的拍子（颜色 = 技能）',
      cur: typeof view.skins[view.mySide] === 'number' ? view.skins[view.mySide] : mySkin,
      onPick: function (idx) {
        mySkin = idx;
        saveSkin(idx);
        appCtx.net.send({ t: 'skin', skin: idx });
        // 选完立刻收起：让玩家能马上看见倒计时和球场。
        // ★ 不动按钮上的"已选"状态 —— 下一次打开面板时 cur 以**服务端下发的 sk** 为准，
        //   所以如果服务端拒了（窗口已经关了），玩家看到的还是服务端认的那个。
        closeReselect();
      }
    });
    reselectBox = box;
    overlayBody.appendChild(box);
    layoutSkillBtns();
  }

  function syncReselect(want) {
    if (want) openReselect();
    else closeReselect();
  }

  /** 右上角那个网络角标 */
  function setBadge(text, cls) {
    netBadge.textContent = text;
    netBadge.className = 'badge' + (cls ? ' ' + cls : '');
  }

  /**
   * 装上界面模块。里面的三个 init* 函数会在这里按原来的顺序跑一遍。
   *
   * @param {object} app 应用上下文。
   * @returns {object} 界面模块对外的接口。
   */
  function attach(app) {
    appCtx = app;
    view = app.view;
    overlay = app.dom.overlay;
    overlayBody = app.dom.overlayBody;
    netBadge = app.dom.netBadge;
    pauseBtn = app.dom.pauseBtn;
    skillBtnEls = app.dom.skillBtnEls;
    canvas = app.dom.canvas;
    SKIN_NAMES = app.SKIN_NAMES;
    SKIN_DESC = app.SKIN_DESC;
    SKIN_GLYPH = app.SKIN_GLYPH;
    SKIN_TIP = app.SKIN_TIP;
    SKIN_COL = app.SKIN_COL;
    SKIN_CD_S = app.SKIN_CD_S;
    POWERUP_STYLE = app.POWERUP_STYLE;
    POWERUP_DESC = app.POWERUP_DESC;
    LEVEL_NAMES = app.LEVEL_NAMES;
    mySkin = readSkin();

    initSkillBtns();
    initSoloBar();
    initPauseBtn();

    var api = {
      showMenu: showMenu,
      showWaiting: showWaiting,
      showDisconnected: showDisconnected,
      showSettlement: showSettlement,
      hideOverlay: hideOverlay,
      setBadge: setBadge,
      syncPauseBtn: syncPauseBtn,
      syncSkillBtns: syncSkillBtns,
      layoutSkillBtns: layoutSkillBtns,
      syncSoloBar: syncSoloBar,
      syncReselect: syncReselect,
      getSkin: function () { return mySkin; },
      // 取走"刚才那个加入失败的房间码"（没有就返回 null）。只清一次。
      takeLastJoinCode: function () { var c = lastJoinCode; lastJoinCode = null; return c; }
    };
    app.ui = api;
    return api;
  }

  global.PongApp = global.PongApp || {};
  global.PongApp.ui = attach;
})(window);
