/**
 * 声音：Web Audio 合成的音效 + 背景音乐。
 *
 * 这是**第一个被拆出来**的模块，也是依赖最干净的一个：除了 app.view.mySide
 * （音效要判断"这一下是不是我这边"，用来决定音色），它不碰任何别的区域。
 *
 * ★ 注册顺序有讲究，务必保持：bgmArm 挂在 **capture** 相位，
 *   而按键处理挂在默认的 bubble 相位。capture 一定先于 bubble 跑完整个路径，
 *   所以"按 M 关掉声音"时，bgmArm 已经先被触发过一次了 —— 两者顺序反了的话，
 *   关掉声音的那一下会漏掉一次恢复机会。
 */

(function (global) {
  'use strict';

  // ================= 声音 =================
  // 全部用 Web Audio 实时合成，不引任何音频文件。
  // 理由：音效是"几十毫秒的短音"，用文件反而要处理加载时机和延迟，
  //       合成是零加载、零额外资源、时间精确。
  var audioCtx = null;
  var soundOn = true;

  // attach() 拿到的 app.view。playEvent 是模块级的，拿不到 attach 的局部变量，
  //   所以走这个槽位 —— 它只被读一次（判断"这一下是不是我这边"）。
  var appView = null;

  function ac() {
    if (!audioCtx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try { audioCtx = new Ctor(); } catch (e) { return null; }
    }
    if (audioCtx.state === 'suspended') {
      var r = audioCtx.resume();
      if (r && r.catch) r.catch(function () {});
    }
    return audioCtx;
  }

  /**
   * 合成一声短音。
   * 频率用指数滑音（exponentialRamp）而不是线性：听感上滑音才是均匀的。
   * 包络两端都留 0.0001 而不是 0 —— 指数插值的目标值不能是 0，否则会抛错。
   */
  function blip(o) {
    if (!soundOn) return;
    var c = ac();
    if (!c) return;
    var t0 = c.currentTime + (o.delay || 0);
    var dur = o.dur || 0.08;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.sweep) osc.frequency.exponentialRampToValueAtTime(o.sweep, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain || 0.12, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function sfxHit() {
    // 每下略微变调，连打时不会像复读机
    var f = 430 + Math.random() * 70;
    blip({ freq: f, sweep: f * 0.55, type: 'square', dur: 0.055, gain: 0.075 });
  }
  function sfxScore() {
    blip({ freq: 320, sweep: 170, type: 'triangle', dur: 0.16, gain: 0.13 });
    blip({ freq: 210, sweep: 120, type: 'triangle', dur: 0.22, gain: 0.1, delay: 0.1 });
  }
  function sfxPower(mine) {
    if (mine) {
      blip({ freq: 540, sweep: 820, type: 'sine', dur: 0.09, gain: 0.11 });
      blip({ freq: 820, sweep: 1180, type: 'sine', dur: 0.13, gain: 0.1, delay: 0.075 });
    } else {
      // 对手吃到道具：给一个低沉的提醒，别让人以为是自己拿到了
      blip({ freq: 300, sweep: 220, type: 'sine', dur: 0.14, gain: 0.08 });
    }
  }
  function sfxSave(mine) {
    // 护盾救球：上滑的清脆音。必须和普通击球明显不同，
    // 否则玩家分不清"我打到了球"和"我的护盾替我挡了一分"。
    var f = mine ? 700 : 520;
    blip({ freq: f, sweep: f * 1.8, type: 'sine', dur: 0.13, gain: 0.1 });
  }
  function sfxDouble(mine) {
    // 双倍得分：两声短促上行，提示"这一分算了两分"
    var f = mine ? 620 : 440;
    blip({ freq: f, sweep: f, type: 'triangle', dur: 0.09, gain: 0.11 });
    blip({ freq: f * 1.5, sweep: f * 1.5, type: 'triangle', dur: 0.12, gain: 0.11, delay: 0.08 });
  }
  /**
   * 有人按了暂停 / 继续。
   * ★ 两端都会响：对面按下暂停时你也该听得出来，否则你只会觉得"球怎么忽然不动了"。
   *   暂停用下行音、继续用上行音，方向本身就把状态说清楚了。
   */
  function sfxPause(on) {
    var f = on ? 520 : 380;
    blip({ freq: f, sweep: on ? f * 0.6 : f * 1.7, type: 'sine', dur: 0.13, gain: 0.09 });
  }
  /**
   * 有人放了技能。三种技能给三种音色，别人放的给一个低一号的版本 ——
   * 和 sfxPower 一个道理：分不清"我放的"和"他放的"会让整个技能系统没有实感。
   * @param {number} skin 皮肤编号（1 青 / 2 黄 / 3 红）
   * @param {boolean} mine 是不是我放的
   */
  function sfxSkill(skin, mine) {
    var lift = mine ? 1 : 0.72;
    if (skin === 1) {
      // 风：一片"呼"上来的气流声（低→高再回落，像一阵风掠过）
      blip({ freq: 240 * lift, sweep: 700 * lift, type: 'sine', dur: 0.30, gain: 0.075 });
      blip({ freq: 420 * lift, sweep: 300 * lift, type: 'sine', dur: 0.26, gain: 0.05, delay: 0.14 });
    } else if (skin === 2) {
      // 幻影：两下几乎重合的音，听感上就是"分裂"了
      blip({ freq: 600 * lift, sweep: 900 * lift, type: 'triangle', dur: 0.10, gain: 0.10 });
      blip({ freq: 615 * lift, sweep: 915 * lift, type: 'triangle', dur: 0.10, gain: 0.09, delay: 0.05 });
    } else if (skin === 3) {
      // 超高速：蓄力音，一串紧凑的上行
      blip({ freq: 380 * lift, sweep: 1150 * lift, type: 'square', dur: 0.19, gain: 0.075 });
    }
  }
  /** 超高速真的打出去了。必须和普通击球明显不同，否则玩家不知道那一板生效了 */
  function sfxBoost(mine) {
    var f = mine ? 900 : 660;
    blip({ freq: f, sweep: f * 0.45, type: 'square', dur: 0.09, gain: 0.11 });
  }
  function sfxOver(won) {
    if (won) {
      blip({ freq: 520, sweep: 520, type: 'triangle', dur: 0.14, gain: 0.12 });
      blip({ freq: 660, sweep: 660, type: 'triangle', dur: 0.14, gain: 0.12, delay: 0.13 });
      blip({ freq: 880, sweep: 880, type: 'triangle', dur: 0.28, gain: 0.13, delay: 0.26 });
    } else {
      blip({ freq: 400, sweep: 380, type: 'triangle', dur: 0.18, gain: 0.1 });
      blip({ freq: 280, sweep: 200, type: 'triangle', dur: 0.3, gain: 0.1, delay: 0.16 });
    }
  }

  /** 服务端在快照里带下来的离散事件 → 对应音效 */
  function playEvent(code) {
    var kind = code.charAt(0);
    if (kind === 'h') {
      sfxHit();
    } else if (kind === 'g') {
      sfxScore();
    } else if (kind === 'u') {
      var who = Number(code.charAt(1));
      sfxPower(who === appView.mySide);
    } else if (kind === 'k') {
      sfxSave(Number(code.charAt(1)) === appView.mySide);      // 护盾挡下一分
    } else if (kind === 'x') {
      sfxDouble(Number(code.charAt(1)) === appView.mySide);    // 这一分是双倍
    } else if (kind === 'o') {
      sfxOver(Number(code.charAt(1)) === appView.mySide);
    } else if (kind === 'p') {
      sfxPause(code.charAt(1) === 'p');     // pp = 暂停，pr = 继续
    } else if (kind === 'v') {
      // v + 槽位 + 皮肤：放技能
      sfxSkill(Number(code.charAt(2)) || 0, Number(code.charAt(1)) === appView.mySide);
    } else if (kind === 'y') {
      // y + 槽位：这一板是超高速
      sfxBoost(Number(code.charAt(1)) === appView.mySide);
    }
  }

  // ---------- 背景音乐 ----------
  // ★ 不用 base64 内嵌：这首 mp3 有 7MB，内嵌会让 HTML 涨到 10MB，
  //   打开先愣几秒。放成独立文件用相对路径引，浏览器按 Range 分段取，边下边放。
  var BGM_SRC = 'audio/bgm-ramble.mp3';
  // base 是"目标音量"。用户反馈偏大，从 0.30 调到 0.24（约 −20%，听感上是小半档）。
  var BGM = { el: null, base: 0.24, cur: 0, ready: false, failed: false };

  function bgmInit() {
    if (BGM.el) return;
    var el = document.createElement('audio');
    el.src = BGM_SRC;
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    el.addEventListener('canplaythrough', function () { BGM.ready = true; });
    // 音乐加载失败绝不能影响游戏：只是没声音，比赛照常
    el.addEventListener('error', function () { BGM.failed = true; BGM.ready = false; });
    BGM.el = el;
  }

  /**
   * 自动播放闸门。
   * Chromium 在页面拿到用户手势之前不许出声，play() 返回的是被拒的 Promise
   * （不抛异常，忘了 catch 就是一条 unhandled rejection）。
   * 所以初始化时试一次是不够的 —— 必须挂到每次交互上重试。
   * 内部先判 paused，挂在热路径上也只是一次属性读，不需要 once 标记。
   */
  function bgmArm() {
    if (!soundOn) return;
    bgmInit();
    if (!BGM.el || !BGM.el.paused) return;
    var p = BGM.el.play();
    if (p && p.catch) p.catch(function () {});
  }

  function bgmTarget() {
    if (!soundOn || BGM.failed) return 0;
    return BGM.base;
  }

  /** 音量状态机：由游戏状态算出目标，每帧让实际值逼近它。淡入/静音都走这一条路 */
  function bgmTick(rdt) {
    var el = BGM.el;
    if (!el) return;

    // ★ 没在播的时候音量必须恒为 0。被自动播放策略拦住的这段时间里如果照常推进，
    //   cur 会悄悄爬到满值，用户第一次点击就是"啪"一下满音量起播，淡入等于白写。
    if (el.paused) { BGM.cur = 0; el.volume = 0; return; }

    var want = bgmTarget();
    // 两档时间常数：还没爬到一半用慢档（这就是淡入），过半转快档收尾。
    // 判据必须是相对量 —— 写成 cur < 0.02 这种固定小值，一超过就跳快档，等于没淡入。
    var tau = (want > BGM.cur && BGM.cur < BGM.base * 0.5) ? 0.6 : 0.14;
    BGM.cur += (want - BGM.cur) * (1 - Math.exp(-rdt / tau));
    if (BGM.cur < 0.005) BGM.cur = 0;      // 指数逼近永远到不了 0，-46dB 直接钳零
    el.volume = Math.min(1, Math.max(0, BGM.cur));
  }

  function bgmSyncUI() {
    var btn = document.getElementById('sfxBtn');
    if (!btn) return;
    btn.textContent = soundOn ? '🔊' : '🔇';
    btn.className = 'soundbtn' + (soundOn ? '' : ' off');
  }

  function toggleSound() {
    soundOn = !soundOn;
    if (soundOn) bgmArm();
    bgmSyncUI();
  }


  /**
   * 装上声音模块。**必须**在其他模块之前调用：它注册的是 capture 相位的监听器。
   *
   * @param {object} app 应用上下文。
   * @returns {object} 声音模块对外的接口。
   */
  function attach(app) {
    appView = app.view;

    window.addEventListener('pointerdown', bgmArm, true);   // capture：不被 stopPropagation 挡掉
    window.addEventListener('keydown', bgmArm, true);
    window.addEventListener('touchstart', bgmArm, true);

    document.addEventListener('visibilitychange', function () {
      if (!BGM.el) return;
      if (document.hidden) BGM.el.pause();    // 切走就停：省电，也免得以为还在跑
      else bgmArm();
    });

    // 声音开关按钮。
    var btn = document.getElementById('sfxBtn');
    if (btn) btn.onclick = function () { toggleSound(); };
    bgmSyncUI();

    /**
     * 探针用的只读快照。window.__bgm / __probe 读它，不直接碰内部状态。
     *
     * @returns {object} 音频运行期状态。
     */
    function snapshot() {
      return {
        src: BGM_SRC,
        base: BGM.base,
        cur: BGM.cur,
        ready: BGM.ready,
        failed: BGM.failed,
        want: bgmTarget(),
        soundOn: soundOn,
        ctxState: audioCtx ? audioCtx.state : null,
        el: BGM.el,
        target: bgmTarget
      };
    }

    /**
     * 唯一从外部改声音开关的入口（探针的 window.__setSound 用）。
     *
     * @param {boolean} on Whether sound should be on.
     * @returns {void}
     */
    function setSound(on) {
      soundOn = !!on;
      bgmSyncUI();
    }

    var api = {
      // 启动时提前把 mp3 挂上：等第一次点击就能直接响。
      // bgmInit 自身有 `if (BGM.el) return` 的幂等保护，重复调用无害。
      init: bgmInit,
      playEvent: playEvent,
      bgmTick: bgmTick,
      toggleSound: toggleSound,
      bgmSyncUI: bgmSyncUI,
      snapshot: snapshot,
      setSound: setSound
    };
    app.audio = api;
    return api;
  }

  global.PongApp = global.PongApp || {};
  global.PongApp.audio = attach;
})(window);
