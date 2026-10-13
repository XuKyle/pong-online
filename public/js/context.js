/**
 * 应用上下文：共享状态、只读表、DOM 句柄。
 *
 * 这是唯一**被所有模块共享**的东西。它不是一个全局变量的集合 ——
 * 每个模块都通过参数拿到它，只读别人挂在它上面的 API，
 * 不去翻 window 上的散装变量（唯一例外是文件末尾那四个探针钩子，
 * 它们是给外部探针用的契约，不算模块间通信）。
 *
 * 依赖方向：context 在最底，其余模块（audio / input / ui / network / render /
 * diagnostics）都只依赖它，彼此之间通过 app.<area> 上的方法调用，
 * 不共享闭包变量，也不互相加载。
 */

(function (global) {
  'use strict';

  // ---------- 与服务端共用的常量（必须保持一致） ----------
  // ★ 场地尺寸 W / H 是**可变的**（各模式不一样，coop 的球台更高），所以它们不在这里，
  //   而是放在 app.view.W / app.view.H —— 服务端每帧把真实尺寸放在快照的 wh 里下发，
  //   收到就改这两个字段，渲染代码全部读它们，换场地不需要改任何绘制逻辑。
  var PADDLE_W = 14, PADDLE_H = 96, PADDLE_MARGIN = 26, BALL_R = 9;
  var PADDLE_SPEED = 540;
  var WIN_SCORE = 11, WIN_MARGIN = 2;
  var POWERUP_R = 21;   // 必须和服务端一致，否则画出的大小和实际碰撞范围对不上
  var POWERUP_MAX = 3;  // 场上最多同时几个。只用于诊断上报，绘制是按服务端下发的数组逐个画
  var TICK_HZ = 30;
  // ★ 必须与服务端一致。只用来把"风还剩几秒"归一成 0~1 好算渐入渐出 ——
  //   风的真正时长、施力大小全在服务端，客户端一秒钟都不参与物理。
  //   （这条是探针在真实浏览器里抓出来的：漏了它 drawWind 会直接抛异常，
  //     而异常发生在 loop 里 draw() 之后、requestAnimationFrame 之前 ⇒ **整个渲染循环当场停摆**，
  //     画面冻住但按钮还在更新，看着像"卡了"。）
  var WIND_MS = 1000;
  // ★ 黑洞的两个数也必须在客户端有一份（与服务端一致）：
  //   HOLE_R 决定"画出来的洞"和"真的能吸到球的半径"看起来是不是同一个东西
  //   —— 画小了会让人觉得球擦着洞边飞过却没进去，画大了会让人觉得明明进了却没吸走。
  //   HOLE_LIFE_MS 用来把"还剩几秒"归一成 0~1，好让洞到寿前收缩一下。
  var HOLE_R = 34;
  var HOLE_LIFE_MS = 12000;

  /**
   * 拍子布局。必须与服务端的 buildSlots 完全一致。
   * edge = 贴哪条边；team = 属于哪一队（决定配色与共享的道具效果）；span = 中心活动范围。
   * 客户端原本用不到 span（位置是服务端算好的），但**本地预测**需要它 ——
   * 不然 coop 里上半场那个玩家能把自己的拍子推出半场。
   */
  function slotsFor(mode, h) {
    if (mode === 'coop') {
      return [
        { edge: 'left', team: 0, span: [0, h / 2] },
        { edge: 'left', team: 0, span: [h / 2, h] },
        { edge: 'right', team: 1, span: [0, h] }
      ];
    }
    return [
      { edge: 'left', team: 0, span: [0, h] },
      { edge: 'right', team: 1, span: [0, h] }
    ];
  }

  var COL = {
    court: '#0d1220',
    wall: '#1b2540',
    mid: '#1e2a42',
    p0: '#4da3ff',
    p1: '#ff7a59',
    ball: '#eef4ff',
    text: '#8fa3bf',
    faint: '#5b6b88',
    good: '#4ade80'
  };

  /**
   * coop 专用配色：**按槽位**取色，不是按队伍。
   * 经典模式里两侧各是一队，一队一个颜色就够了；但 coop 里两名真人站在**同一条边**上、
   * 只是各守半场 —— 沿用"按队配色"的话两人会是一模一样的蓝，根本分不清谁是谁。
   * 顺序固定为 [上半场, 下半场, AI]，两个客户端看到的颜色一致（不是"各自眼里的自己一个色"），
   * 这样一边喊"你往左一点"时，双方指的确实是同一条拍子。
   * 蓝 / 黄绿 / 橙红 三色在深色场地上两两都拉得开。
   */
  var COOP_COL = ['#4da3ff', '#a3e635', '#ff7a59'];
  // 被冰冻时整体换冰色（仍然保持三条互不相同，否则冻住之后又分不清了）
  var COOP_COL_FROZEN = ['#9fd8ff', '#dcffa8', '#ffc0ae'];

  // 道具外观：索引与服务端的类型编号一一对应。
  // 都只用几何符号和 ASCII（❄ 除外），不用 emoji —— emoji 在很多字体下会被渲染成
  // 彩色图形，和这里的扁平风格冲突，而且尺寸不可控。
  var POWERUP_STYLE = [
    { c: '#4ade80', label: '+' },    // 0 加长自己的拍子
    { c: '#f87171', label: '–' },    // 1 削短对方的拍子
    { c: '#fbbf24', label: '»' },    // 2 球加速
    { c: '#7dd3fc', label: '❄' },    // 3 冰冻对方的拍子
    { c: '#a78bfa', label: '◍' },    // 4 护盾：挡一次失分
    { c: '#f0abfc', label: '2×' },   // 5 双倍得分（8 秒内自己进球算两分）
    { c: '#5eead4', label: '~' },    // 6 弧线球（球一路拐弯，轨迹发飘）
    { c: '#fdba74', label: 'Y' },    // 7 分裂球（原球不变，多出一个半速的球）
    // 8 隐形球。用"近乎无色的白"是有意的：其它八款都是饱和色，
    // 只有它是"没有颜色"，一眼就读得出这是"让东西看不见"的那一款。
    { c: '#e2e8f0', label: '◌' }
  ];
  var LEVEL_NAMES = ['简单', '普通', '困难'];

  /* 道具的一句话简介（给玩家看的，和 POWERUP_STYLE 一一对应）。
     与服务端 castPowerup 的实际效果对齐；改效果时**必须同时改这里**，
     否则玩家读到的是说明书、打起来是另一回事。 */
  var POWERUP_DESC = [
    '自己拍子变长，好接球',
    '对手拍子变短，容易漏',
    '球加速飞出去',
    '冻住对手拍子一会儿',
    '挡一次失分（对方进球不算）',
    '8 秒内自己进球算两分',
    '球一路拐弯，轨迹发飘',
    '多出一个半速的球，两个都算',
    '自己这队的球一会儿看不见'
  ];

  // ---------- 拍子皮肤（颜色 = 技能） ----------
  // 下标必须与服务端的 SKINS 一一对应：
  //   0 灰（无技能）/ 1 青（风）/ 2 黄（幻影）/ 3 红（超高速）/
  //   4 蓝（粘球）/ 5 黑（黑洞）/ 6 紫（乱弹）/ 7 白（道具封锁）/ 8 橙（减速）
  var SKIN_NAMES = ['灰', '青', '黄', '红', '蓝', '黑', '紫', '白', '橙'];
  var SKIN_DESC = ['无技能', '风', '幻影', '超高速', '粘球', '黑洞', '乱弹', '封锁', '减速'];
  // 按钮上写的字（灰没有按钮，空着）—— 一律**单字**，按钮只有 38px 宽。
  var SKIN_GLYPH = ['', '风', '幻', '速', '粘', '洞', '乱', '封', '缓'];
  // 技能说明。★ 写在**选择面板自己那一块**里（而不是下面一行小字），
  //   因为九种皮肤靠一行提示根本讲不完，而玩家选的时候需要看到它到底干什么。
  var SKIN_TIP = [
    '没有技能，靠手感硬打。',
    '放一阵风推球，1 秒；朝对面球门中心吹。',
    '放个幻影球，5 秒；对手会看见两个球。',
    '下一板击球超高速（比普通上限还快）。',
    '下一板把球粘住，1 秒后朝对面平推出去。',
    '自己半场开黑洞，球从对面半场随机飞出。',
    '10 秒内自己击球角度速度都乱，多半加速。',
    '对手下一个吃到的道具直接失效。',
    '对手拍子变慢 30%，2 秒。'
  ];
  // 服务端配色必须能一眼对应上。
  // ★ 蓝/黑/紫/白/橙这五款要能和既有的青/黄/红区分开，所以都取了名实相符的正色：
  //   蓝用粘胶的湖蓝（不是青）、黑用近黑的墨色（在深色球场上有描边才看得见）、
  //   紫用乱弹的紫罗兰、白用封锁的灰白、橙用减速的橙黄。
  var SKIN_COL = ['#8a93a6', '#22d3ee', '#fbbf24', '#ef4444', '#3b82f6', '#64748b', '#a855f7', '#e2e8f0', '#fb923c'];
  // 被冰冻时整体换冰色，但仍然保持九个皮肤互不相同（否则冻住之后又分不清了）
  var SKIN_COL_FROZEN = ['#9fb0c8', '#9fe8f5', '#f5dfa0', '#f0a8a8', '#a8c8f0', '#aab4c4', '#d0b0f0', '#eef2f8', '#f8d0a0'];
  // ★ 必须与服务端的 SKILL_CD_MS 一致。只用来画冷却环（--p 的分子），
  //   能不能放、还剩多久都以服务端下发的 sc 为准 —— 这里错了只会让环画得不圆。
  var SKIN_CD_S = [0, 10, 15, 10, 10, 10, 15, 10, 10];

  // ---------- DOM 句柄 ----------
  // 一次性查好缓存起来。整段脚本原本散在几个位置声明，顺序无所谓 ——
  // 脚本在 </body> 前，这些元素此刻都已经在文档里了。
  function cacheDom(doc) {
    return {
      canvas: doc.getElementById('game'),
      ctx: doc.getElementById('game').getContext('2d'),
      overlay: doc.getElementById('overlay'),
      overlayBody: doc.getElementById('overlayBody'),
      netBadge: doc.getElementById('netBadge'),
      pauseBtn: doc.getElementById('pauseBtn'),
      stage: doc.querySelector('.stage'),
      skillBtnEls: [
        doc.getElementById('skillBtn0'),
        doc.getElementById('skillBtn1'),
        doc.getElementById('skillBtn2')
      ],
      // 诊断量表（下方"取证面板"那一排）
      elTransport: doc.getElementById('mTransport'),
      elRtt: doc.getElementById('mRtt'),
      elRate: doc.getElementById('mRate'),
      elTickRate: doc.getElementById('mTickRate'),
      elSnaps: doc.getElementById('mSnaps'),
      elDrops: doc.getElementById('mDrops'),
      elVerdict: doc.getElementById('verdict'),
      pingPill: doc.getElementById('pingPill')
    };
  }


  /**
   * 造一个应用上下文。只被 index.html 末尾的引导代码调用一次。
   *
   * @param {Document} doc 宿主文档。
   * @returns {object} app —— 之后每个模块都拿它当第一个参数。
   */
  function createContext(doc) {
    var dom = cacheDom(doc);

    // ---------- 视图状态 ----------
    // 整份快照派生的状态都在这里。除了下面那几个字段，其余只由 network 写、其余模块读。
    var view = {
      // 场地尺寸：与服务端下发的 wh 同步（见文件头说明）
      W: 800,
      H: 500,

      mySide: -1,
      code: '',
      connected: false,
      wsUrl: '',
      extensions: '',
      handshakeMs: 0,

      mode: 'duel',             // duel | solo | coop
      slots: slotsFor('duel', 500),
      phase: 'waiting',
      // 真人主动暂停。★ 与 phase 是**两个独立状态**：暂停期间 phase 还是 playing，
      //   画面上球还在（只是冻住不动）—— 若把它并进 phase 走 waiting 分支，那条分支
      //   压根不画球，一按暂停球就从画面上消失，看着像球被吞了。
      userPaused: false,
      pausedBy: -1,             // 是谁按的（槽位号，-1 = 没暂停）
      // ★ 球是一个**数组**（分裂球会让场上同时有多个）。
      //   服务端每个球都带 id，客户端按 id 维护它的平滑位置和尾迹 ——
      //   不能用下标当身份：某个球出界后数组整体前移，剩下的球会被
      //   从"上一个球的位置"平滑地滑过去，看起来像瞬移。
      balls: [],                // 服务端真值 [{ id, x, y }]
      ballDisps: {},            // id -> { x, y } 画出来的位置（指数平滑，抹平 30Hz 台阶）
      tails: {},                // id -> [{x,y}] 弧线球尾迹
      paddles: [250, 250],   // 初始画在中线（H/2，服务端下发真值前用默认值）
      paddleDisp: [250, 250],
      paddleMul: [1, 1],        // 拍子长度倍率，决定画多长
      powerups: [],             // 场上道具数组 [[x, y, type], ...] —— 可以同时有多个
      freeze: [0, 0],           // 各队冰冻剩余秒数（>0 就是被冻着）
      shield: [0, 0],           // 各队护盾剩余层数
      double: [0, 0],           // 各队双倍得分是否生效
      invis: [0, 0],            // 各队"看不见球"还剩几秒（>0 就是被隐形了）
      invisAlpha: [1, 1],       // 各队**当前看到的球**的不透明度（1 看得见 / 0 看不见）
      curve: 0,                 // 弧线球：非 0 表示球在拐弯（值是带符号的角速度）
      // 皮肤与技能。★ 全部按**槽位**（不是按队）：coop 里左边两个人同队，但各有各的技能。
      skins: [0, 0],            // 各槽位的皮肤（0 灰 / 1 青 / 2 黄 / 3 红）
      skillCd: [0, 0],          // 各槽位技能冷却剩余秒数（0 = 可以放）
      boostArmed: [0, 0],       // 各槽位"下次击球超高速"是否已经蓄好力
      winds: [],                // 正在刮的风 [[dx, dy, 剩余秒], ...]（可以同时有多股）
      phantom: [0, 0],          // 各队幻影球还剩几秒（只给释放方看，给的是"还在生效"的反馈）
      // ---- 第 11 轮五种新技能的对外状态（全部由服务端下发，客户端只负责画） ----
      stickArmed: [],           // 各槽位"下一板会粘住球"是否已武装
      stuckBall: 0,             // 正被粘住的球 [x, y, 槽位] 或 0（画的时候要硬贴在拍子上）
      holes: [],                // 黑洞 [[x, y, 剩余秒, 队伍], ...]
      chaos: [],                // 各槽位"乱弹"还剩几秒
      blockCharges: [],         // 各队还有几层道具封锁（对手那一格服务端会抹成 0）
      slowLeft: [],             // 各队拍子被减速还剩几秒
      canReselect: false,       // 局间可以重新选拍子（服务端下发的窗口）
      solo: false,              // 对手是 AI
      coop: false,              // 双人对抗 AI
      botLevel: 1,
      botName: '',
      score: [0, 0],
      present: [0, 0],
      winner: -1,
      pointWinners: [],       // 每分的赢家（队伍号），按得分先后；局终画布上画逐分明细用
      serverTick: 0,
      countdownMs: 0,

      dir: 0,

      rtt: 0,
      rttSum: 0,
      rttCount: 0,
      snaps: 0,
      lastSnapAt: 0,
      matchId: '',
      matchFrames: [],
      matchFrameLimit: 18000,
      matchFrameNo: 0,
      reportedMatchId: '',
      serverClockOffset: 0,
      serverClockSynced: false,
      clockSyncRtt: Infinity,
      lastSnapshotServerTime: 0,
      pendingPingWall: Object.create(null),
      intervals: [],
      drops: 0,
      lastTick: 0,
      lastTickAt: 0,
      tickRate: 0,
      tkWinStart: 0,      // 频率统计窗口的起点时刻
      tkWinBase: 0        // 窗口起点处的 tick 值
      };
  /** 我属于哪一队。view.mySide 是**槽位**号；coop 里左边两个槽位同属 0 队 */
  function teamOfMine() {
    var sl = view.slots[view.mySide];
    return sl ? sl.team : -1;
  }

  /**
   * 我这一侧**看到的球**有多不透明（1 = 完全看得见，0 = 完全看不见）。
   *
   * 隐形球是"吃到的人看得见、对面看不见"。透明度曲线由服务端算好下发
   * （见服务端 invisAlpha），这里只把"我属于哪一队"映射到那个数组上 ——
   * 渐变只有一份实现，两边不可能各算各的然后悄悄错位。
   *
   * ★ 这是**客户端**过滤，不是"服务端不给你发坐标"：快照里的球位置双方都收得到。
   *   所以严格说，改了客户端的人能作弊看见球。这是个休闲双人游戏，
   *   对手本来就能扭头看你的屏幕，为此把每个座位的快照拆开发并不值当。
   *   对不作弊的玩家，"看不见"就是真的看不见，与服务端权威的判定也完全一致
   *   （球打到拍子上的判定从来只在服务端做）。
   */
  function ballVis() {
    var t = teamOfMine();
    if (t < 0) return 1;                        // 没入座（还在菜单里）不隐藏
    var a = view.invisAlpha[t];
    return typeof a === 'number' ? a : 1;
  }

    // 只读表挂上去，让各模块用 app.COL / app.SKIN_COL 取，不用再各自定义一份。
    var app = {
      dom: dom,
      view: view,
      COL: COL,
      COOP_COL: COOP_COL,
      COOP_COL_FROZEN: COOP_COL_FROZEN,
      POWERUP_STYLE: POWERUP_STYLE,
      POWERUP_DESC: POWERUP_DESC,
      POWERUP_R: POWERUP_R,
      POWERUP_MAX: POWERUP_MAX,
      PADDLE_W: PADDLE_W,
      PADDLE_H: PADDLE_H,
      PADDLE_MARGIN: PADDLE_MARGIN,
      BALL_R: BALL_R,
      PADDLE_SPEED: PADDLE_SPEED,
      LEVEL_NAMES: LEVEL_NAMES,
      SKIN_NAMES: SKIN_NAMES,
      SKIN_DESC: SKIN_DESC,
      SKIN_GLYPH: SKIN_GLYPH,
      SKIN_TIP: SKIN_TIP,
      SKIN_COL: SKIN_COL,
      SKIN_COL_FROZEN: SKIN_COL_FROZEN,
      SKIN_CD_S: SKIN_CD_S,
      WIN_SCORE: WIN_SCORE,
      WIN_MARGIN: WIN_MARGIN,
      slotsFor: slotsFor,
      // 两个"我这一侧"的纯查询：渲染画谁的颜色、探针报什么、以及失分取证
      // 都要用它们，所以放最底，谁都能读，也谁都只有一份实现。
      teamOfMine: teamOfMine,
      ballVis: ballVis,
      WIND_MS: WIND_MS,
      HOLE_R: HOLE_R,
      HOLE_LIFE_MS: HOLE_LIFE_MS
    };
    return app;
  }

  global.PongApp = { createContext: createContext };
})(window);
