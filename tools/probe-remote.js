'use strict';
// 远程探针：验证「发布环境（反向代理之后）」WebSocket 长连接到底能不能用。
// 本地环回通过不代表线上通过 —— 中间隔着代理，upgrade 握手可能被拦、空闲连接可能被回收。
// 这个脚本就是这个问题的唯一证据来源。
//
// 用法: node tools/probe-remote.js [baseUrl] [idleMs]

const WebSocket = require('ws');

const BASE = (process.argv[2] || 'https://pong-online-battle.app.workbuddy.host').replace(/\/+$/, '');
const WS_URL = BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws';
const IDLE_MS = Number(process.argv[3] || 60000);

let pass = 0;
let fail = 0;
const failures = [];

function check(ok, name, detail) {
  const tail = detail ? '  \u2014 ' + detail : '';
  if (ok) {
    pass += 1;
    console.log('  \u2713 ' + name + tail);
  } else {
    fail += 1;
    failures.push(name);
    console.log('  \u2717 ' + name + tail);
  }
}
function note(msg) { console.log('    \u00b7 ' + msg); }
function section(n, s) {
  const bar = '\u2500'.repeat(Math.max(4, 46 - s.length));
  console.log('\n\u2500\u2500 ' + n + '. ' + s + ' ' + bar);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 一个可观测的连接 ----------
function connect(label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ev = {
      state: [], joined: null, error: null, pong: [],
      close: null, upgrade: null, handshakeStatus: null,
    };
    let settled = false;

    const ws = new WebSocket(WS_URL, {
      origin: BASE,
      handshakeTimeout: 20000,
      perMessageDeflate: false,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch (e) {}
      reject(new Error('握手超时（20s 内未完成 upgrade）'));
    }, 21000);

    ws.on('upgrade', (res) => {
      ev.upgrade = res.headers;
      ev.handshakeStatus = res.statusCode;
    });

    ws.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        label, ws, ev,
        handshakeMs: Date.now() - t0,
        send: (o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} },
        last: () => (ev.state.length ? ev.state[ev.state.length - 1].d : null),
        statesIn: (ms) => {
          const t = Date.now();
          return ev.state.filter((s) => t - s.at <= ms);
        },
      });
    });

    ws.on('unexpected-response', (req, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const extra = res.headers && res.headers.server ? ' (server: ' + res.headers.server + ')' : '';
      reject(new Error('upgrade 被拒：HTTP ' + res.statusCode + extra));
    });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.t === 'state') ev.state.push({ at: Date.now(), d: m });
      else if (m.t === 'joined' || m.t === 'rejoined') ev.joined = m;
      else if (m.t === 'error') ev.error = m;
      else if (m.t === 'pong') ev.pong.push({ at: Date.now(), d: m });
    });

    ws.on('close', (code, reason) => {
      ev.close = { code, reason: String(reason || ''), at: Date.now() };
    });

    ws.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

function hz(conn, windowMs) {
  const arr = conn.statesIn(windowMs);
  if (arr.length < 3) return 0;
  const span = (arr[arr.length - 1].at - arr[0].at) / 1000;
  return span > 0 ? (arr.length - 1) / span : 0;
}

function gapStats(conn, n) {
  const arr = conn.ev.state.slice(-n);
  const g = [];
  for (let i = 1; i < arr.length; i += 1) g.push(arr[i].at - arr[i - 1].at);
  if (!g.length) return null;
  const sorted = g.slice().sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] };
}

// ---------- 主流程 ----------
(async () => {
  console.log('目标页面 : ' + BASE);
  console.log('实时通道 : ' + WS_URL);
  console.log('空闲观察 : ' + (IDLE_MS / 1000) + 's\n');

  section(1, 'HTTPS 静态与健康检查');
  try {
    const h = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(15000) });
    const txt = await h.text();
    check(h.ok, 'GET /healthz 可达', 'HTTP ' + h.status);
    // 注意：发布环境的网关接管了 /healthz 这个保留路径，返回的是它自己的格式
    // ({"code":200,"msg":"Health Checked","data":"Pod alive"})，而不是应用写的那份字段。
    // 所以只断言「这是一个表示健康的成功响应」，不去绑定应用侧的自定义字段。
    const appFormat = /"ok"\s*:\s*true/.test(txt);
    const gatewayFormat = /"code"\s*:\s*200/.test(txt) && /alive|ok/i.test(txt);
    check(appFormat || gatewayFormat, 'healthz 表示服务健康', txt.slice(0, 90));
    if (!appFormat && gatewayFormat) {
      note('该路径被平台网关接管：返回的是网关格式，应用自己写的字段读不到。');
      note('结论：想暴露自定义健康/调试端点，不要用 /healthz 这个名字，换个路径即可。');
    }
  } catch (e) {
    check(false, 'GET /healthz 可达', e.message);
  }
  try {
    const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(15000) });
    const html = await r.text();
    check(r.ok, 'GET / 可达', 'HTTP ' + r.status + ', ' + html.length + ' 字节');
    check(/<canvas/i.test(html), '主页含 canvas 画布');
  } catch (e) {
    check(false, 'GET / 可达', e.message);
  }

  section(2, 'WebSocket 握手（整个方案成立的前提）');
  let A;
  try {
    A = await connect('A');
    check(true, 'wss 握手成功', A.handshakeMs + 'ms');
    if (A.ev.upgrade) {
      const srv = A.ev.upgrade.server || '(未暴露)';
      note('代理/服务标识: ' + srv);
    }
  } catch (e) {
    check(false, 'wss 握手成功', e.message);
    console.log('\n!! 握手失败 —— 代理未放行 upgrade，长连接方案在发布环境不可用。');
    console.log('!! 下一步应退化到 SSE + 普通 POST 上报。');
    process.exit(1);
  }

  section(3, '创建房间');
  // ★ 建房时**带上皮肤**（1 = 青色 = 风）。皮肤是"进场时选好的"，只在 create/join
  //   那一次传，没有单独的改皮肤消息。这里带上的目的只有一个：让第 12 节能真的
  //   在线上放一次技能。灰板（默认）放技能会被服务端按"这块拍子没有技能"拒掉，
  //   那样我们就只能验"字段存在"、验不了整条链路。
  A.send({ t: 'create', skin: 1 });
  await sleep(1800);
  const code = A.ev.joined && A.ev.joined.code;
  check(!!A.ev.joined, '房主收到 joined', A.ev.joined ? JSON.stringify(A.ev.joined) : '无响应');
  check(!!code && /^[A-Z0-9]{6}$/.test(code), '拿到 6 位房间码', String(code));
  check(A.ev.joined && A.ev.joined.side === 0, '房主坐左侧 (side=0)',
    A.ev.joined ? 'side=' + A.ev.joined.side : '-');

  section(4, '第二端凭房间码加入');
  let B;
  try {
    B = await connect('B');
    check(true, '第二端 wss 握手成功', B.handshakeMs + 'ms');
  } catch (e) {
    check(false, '第二端 wss 握手成功', e.message);
    process.exit(1);
  }
  // B 选 3 = 红色（超高速）。两端皮肤**故意不同**：只有不同，第 12 节才能证明 sk
  //   是**按槽位**下发的 —— 两端都设成同一个值的话，就分不出"真的按槽位发了两份"
  //   和"服务端只存了一个数、两边都发它"。
  B.send({ t: 'join', code, skin: 3 });
  await sleep(1800);
  check(!!B.ev.joined, '第二端收到 joined', B.ev.joined ? JSON.stringify(B.ev.joined) : '无响应');
  check(B.ev.joined && B.ev.joined.side === 1, '第二端坐右侧 (side=1)',
    B.ev.joined ? 'side=' + B.ev.joined.side : '-');
  check(!B.ev.error, '加入过程无错误', B.ev.error ? B.ev.error.msg : '无');

  section(5, '服务端物理在推进（比赛状态机）');
  await sleep(4000);
  const phases = new Set(A.ev.state.map((s) => s.d.ph));
  check(A.ev.state.length > 50, 'A 端持续收到状态快照', A.ev.state.length + ' 条');
  check(!phases.has(undefined) && phases.size > 0, '快照带阶段字段',
    '出现过的阶段: ' + Array.from(phases).join(', '));

  section(6, '广播频率与抖动（真实网络）');
  const hzA = hz(A, 4000);
  const hzB = hz(B, 4000);
  check(hzA > 24 && hzA < 36, 'A 端频率 ≈30Hz', hzA.toFixed(1) + ' Hz');
  check(hzB > 24 && hzB < 36, 'B 端频率 ≈30Hz', hzB.toFixed(1) + ' Hz');
  const gs = gapStats(A, 150);
  if (gs) {
    check(gs.p95 < 160, '快照间隔 p95 < 160ms',
      'p50=' + gs.p50 + 'ms  p95=' + gs.p95 + 'ms  max=' + gs.max + 'ms');
  }

  section(7, '跨端可见（联机游戏成立的核心）');
  const bStart = A.last();
  const p1Before = bStart ? bStart.p[1] : null;
  B.send({ t: 'input', dir: -1 });
  await sleep(700);
  B.send({ t: 'input', dir: 0 });
  await sleep(300);
  const p1After = A.last().p[1];
  check(p1Before !== null, '读到 B 的拍子初始位置', 'p[1]=' + p1Before);
  check(p1After < p1Before - 20, 'A 端看见 B 的拍子上移',
    p1Before + ' \u2192 ' + p1After + ' (\u0394' + Math.round(p1After - p1Before) + ')');

  const aStart = B.last();
  const p0Before = aStart.p[0];
  A.send({ t: 'input', dir: 1 });
  await sleep(700);
  A.send({ t: 'input', dir: 0 });
  await sleep(300);
  const p0After = B.last().p[0];
  check(p0After > p0Before + 20, 'B 端看见 A 的拍子下移',
    p0Before + ' \u2192 ' + p0After + ' (\u0394+' + Math.round(p0After - p0Before) + ')');

  section(8, '往返延迟');
  const sentAt = Date.now();
  A.send({ t: 'ping', ts: sentAt });
  await sleep(1200);
  if (A.ev.pong.length) {
    const rtt = A.ev.pong[A.ev.pong.length - 1].at - sentAt;
    check(rtt >= 0 && rtt < 400, 'ping/pong 往返可用', rtt + 'ms');
    note('这是 Node 客户端的实测值；浏览器端通常相近或略低。');
  } else {
    check(false, 'ping/pong 往返可用', '未收到 pong');
  }

  section(9, '空闲连接是否被代理回收（' + (IDLE_MS / 1000) + ' 秒静置）');
  let D;
  try {
    D = await connect('D');
  } catch (e) {
    check(false, '空闲探针连接建立', e.message);
  }
  if (D) {
    note('这个连接不建房、不发言，全程无应用层流量，只有服务端 25s 心跳。');
    note('页面打开后停在菜单页等一会儿，走的就是这条路径。');
    let tick = 0;
    const total = Math.ceil(IDLE_MS / 10000);
    const hb = setInterval(() => {
      tick += 1;
      const alive = D.ws.readyState === 1;
      console.log('    \u00b7 静置 ' + (tick * 10) + 's / ' + (IDLE_MS / 1000) + 's  \u2014 连接' +
        (alive ? '存活' : '已断开') + (D.ev.close ? ' (' + D.ev.close.code + ')' : ''));
    }, 10000);
    await sleep(IDLE_MS);
    clearInterval(hb);
    check(D.ws.readyState === 1 && !D.ev.close, '空闲 ' + (IDLE_MS / 1000) + 's 未被掐断',
      D.ev.close ? 'close code=' + D.ev.close.code : '仍存活');
    try { D.ws.close(); } catch (e) {}
  }

  section(10, '对局期间连接稳定性');
  check(!A.ev.close && !B.ev.close, 'A/B 全程无意外断开',
    (A.ev.close ? 'A关闭 ' + A.ev.close.code + ' ' : '') + (B.ev.close ? 'B关闭 ' + B.ev.close.code : '') || '无');
  check(!A.ev.error && !B.ev.error, '未发生协议级错误');

  section(11, '新版本功能是否真的随这次同步上线');
  // 只验「旧功能没坏」是不够的 —— 同步的目的是把道具 / 事件 / 拍子倍率带上去。
  // 这三样都由服务端广播，所以从线上快照里直接读得到。
  const snap = A.last();
  check(snap && Array.isArray(snap.pm) && snap.pm.length === 2 && snap.pm.every((v) => isFinite(v)),
    '快照带拍子倍率 pm（2 个有限数）', snap ? JSON.stringify(snap.pm) : '-');
  check(snap && Array.isArray(snap.ev), '快照带事件通道 ev（数组）',
    snap ? JSON.stringify(snap.ev) : '-');
  // ★ 字段名是 **us**（数组，可以同时有多个道具），不是单球时代的单数 `u`。
  //   读错名字不会报错：`snap.u` 恒为 undefined，"是 0 或者是三元组"两边都不成立，
  //   于是稳定报红、看起来像"线上的道具功能没同步上去"。跟 `s.b` → `bs` 是同一类坑。
  check(snap && Array.isArray(snap.us)
    && snap.us.every((u) => Array.isArray(u) && u.length === 3),
    '快照带道具数组 us（空数组，或每项 [x,y,type]）',
    snap ? JSON.stringify(snap.us) : '-');

  // 道具应该在开局约 4.5s 后出现。等它一次，确认生成逻辑在线上真的在跑。
  //
  // ★ 事件必须累积着看，不能每秒取一次"最新快照"。
  //   服务端发完就清空 events，一个事件只存在于【那一条】快照里（约 33ms），
  //   按 1Hz 采样最新快照，命中率只有 3% 左右 —— 会误报成"事件通道坏了"。
  //   所以这里改为扫描连接累积下来的全部快照。
  note('等待道具生成（开局约 4.5s 后出现第一个）…');
  let scanned = A.ev.state.length;   // 只扫这次窗口内新到的快照
  const seenU = [];
  const seenEv = {};
  let mulChanged = null;
  let maxOnField = 0;                // 场上同时挂着的道具最多几个
  let maxFieldShot = null;           // 拍到的那一刻长什么样（当证据用）
  let outOfRange = null;             // 出现过越界的类型编号（有的话说明上线的是旧代码）
  for (let i = 0; i < 28; i += 1) {
    await sleep(1000);
    const fresh = A.ev.state.slice(scanned);
    scanned = A.ev.state.length;
    for (const item of fresh) {
      const s = item.d;
      const us = Array.isArray(s.us) ? s.us : [];
      if (us.length && !seenU.length) seenU.push(JSON.stringify(us));
      if (us.length > maxOnField) { maxOnField = us.length; maxFieldShot = JSON.stringify(us); }
      // 类型编号只有 0..POWERUP_N-1 合法。线上如果还在发更小的编号，
      // 说明网关后面跑的是**旧版本**，新道具根本没上去 —— 这比"没看到道具"更值得报警。
      for (const u of us) {
        if (!outOfRange && Number.isInteger(u[2]) && !(u[2] >= 0 && u[2] <= 8)) outOfRange = u[2];
      }
      (s.ev || []).forEach((e) => { seenEv[e] = (seenEv[e] || 0) + 1; });
      if (!mulChanged && s.pm && (s.pm[0] !== 1 || s.pm[1] !== 1)) mulChanged = JSON.stringify(s.pm);
    }
  }
  const evNames = Object.keys(seenEv);
  check(seenU.length > 0, '线上观察到道具生成', seenU.length ? seenU[0] : '未出现');
  check(outOfRange === null, '道具类型编号都在 0..8（说明上线的是含新道具的版本）',
    outOfRange === null ? `未出现越界编号；场上最多同时 ${maxOnField} 个`
      : `出现了编号 ${outOfRange}`);
  check(evNames.length > 0, '线上观察到离散事件（音效依赖它）',
    evNames.length ? evNames.map((k) => k + '×' + seenEv[k]).join(', ') : '无');
  // ★ 同时挂多个道具**不做断言**：球或 AI 随时可能把某个道具吃掉，
  //   这一局恰好没拍到两个同时在场上完全正常。只记录实测值，不制造偶发红。
  if (maxOnField >= 2) note(`★ 拍到场上同时有 ${maxOnField} 个道具：${maxFieldShot}`);
  else note(`本次窗口内场上最多只挂到 ${maxOnField} 个（多半是被吃掉了，不作为失败）`);
  if (mulChanged) note('期间拍到倍率变化: ' + mulChanged + '（说明有人吃到道具）');
  else note('期间道具未被吃到 —— 球是随机的，吃不到属正常，不作为失败。');

  section(12, '拍子皮肤 = 技能 是否真的随这次同步上线');
  // 光验"字段存在"是不够硬的（虽然旧版本连字段都没有，存在性本身就有区分度）。
  // 这一节**真的在线上放一次技能**：A 建房时选了青色（风），所以这块拍子是有点技能的。
  // 如果网关后面跑的还是旧 server.js，A 的 sk 会恒为 0，放技能会被服务端按
  // "这块拍子没有技能"拒掉，wf 永远为空 —— 下面的断言会红。
  const s12 = A.last();
  check(s12 && Array.isArray(s12.sk) && s12.sk.length === 2
    && s12.sk.every((v) => Number.isInteger(v) && v >= 0 && v <= 3),
    '快照带皮肤数组 sk（2 个 0..3 整数）', s12 ? JSON.stringify(s12.sk) : '-');
  // ★ 字段名是 **sk / sc / bo / wf / px**。读错名字不会报错，只会恒为 undefined，
  //   于是"稳定报红、看起来像线上的技能功能没同步上去" —— 和 `u` → `us`、
  //   `b` → `bs` 是同一类坑，所以这里点名每一个字段并验形状。
  check(s12 && Array.isArray(s12.sk) && s12.sk[0] === 1 && s12.sk[1] === 3,
    '★ 进场时选的皮肤被服务端记住了（A=1 青/风，B=3 红/超高速）',
    s12 && s12.sk ? JSON.stringify(s12.sk) : '-');
  check(s12 && Array.isArray(s12.sc) && s12.sc.length === 2
    && s12.sc.every((v) => isFinite(v) && v >= 0),
    '快照带技能冷却 sc（2 个非负秒数）', s12 ? JSON.stringify(s12.sc) : '-');
  check(s12 && Array.isArray(s12.bo) && s12.bo.length === 2
    && s12.bo.every((v) => v === 0 || v === 1),
    '快照带超高速蓄力标记 bo（2 个 0/1）', s12 ? JSON.stringify(s12.bo) : '-');
  check(s12 && Array.isArray(s12.wf), '快照带风数组 wf（数组）', s12 ? JSON.stringify(s12.wf) : '-');
  check(s12 && Array.isArray(s12.px) && s12.px.length === 2 && s12.px.every((v) => isFinite(v)),
    '快照带幻影计时 px（2 个数字）', s12 ? JSON.stringify(s12.px) : '-');

  // 技能只在 phase === 'playing' 放得出去。一局打满 11 分后有 4 秒 'over' 停场，
  // 所以这里**必须等**而不是假定 —— 停在 'over' 那 4 秒里放技能是被服务端正当拒掉的。
  let s12playing = false;
  for (let i = 0; i < 60 && !s12playing; i += 1) {
    const cur = A.last();
    s12playing = !!(cur && cur.ph === 'playing');
    if (!s12playing) await sleep(500);
  }
  check(s12playing, '前置：对局进入 playing（技能只在此时放得出去）',
    A.last() ? String(A.last().ph) : '-');

  {
    const pre = A.last();
    check(!!(pre.sc && pre.sc[0] === 0), '前置：A 的技能已就绪（sc[0] === 0）',
      pre.sc ? JSON.stringify(pre.sc) : '-');

    // ★★ 关键：**一直按住向上、中途不发 dir:0**，让拍子始终贴在上墙。
    //   理由有二：
    //   ① 位置确定。顶到夹取边界之后再按也不会动，所以"放技能那一刻拍子在哪"是个常量，
    //      不随运气变。拍子停在正中央竖直位置时 dy≈0，方向断言会退化成几乎恒真的空断言。
    //   ② 必须能扛住开局的**复位**。`startMatch` 会把两块拍子复位到正中央 ——
    //      所以"先顶到位、再慢慢等 playing"是错的：你等到的可能是下一局，
    //      那时拍子已经回到中间了。持续按住就没有这个缝。
    A.send({ t: 'input', dir: -1 });
    await sleep(1500);        // 540px/s，从最远处顶到上墙也就 0.5s，留足余量

    let wind = null;
    let tries = 0;
    for (let a = 0; a < 4 && !wind; a += 1) {
      // 等到 playing 就**立刻**按技能，中间不插任何耗时动作。
      // ★ 这一点是实测逼出来的：两端都不陪练的局里，一个回合是
      //   「countdown 1.8s → playing 一两秒（球飞过去）→ 进球 → 又是 countdown」，
      //   **playing 窗口很短**。第一版写成"先等 playing、再去顶拍子（1.65s）"，
      //   三次尝试全都在按下之前就离开 playing 了，探针报出「按了 0 次」——
      //   看着像产品的技能坏了，其实是探针自己把窗口耗完了。
      let ok = false;
      for (let i = 0; i < 120; i += 1) {
        const cur = A.last();
        if (cur && cur.ph === 'playing') { ok = true; break; }
        await sleep(250);
      }
      if (!ok) continue;
      tries += 1;
      const scan0 = A.ev.state.length;
      A.send({ t: 'skill' });
      // 风只活 1 秒，而且下一条快照就可能带上它 —— 所以这里采样要密（120ms）。
      for (let i = 0; i < 14 && !wind; i += 1) {
        await sleep(120);
        for (const it of A.ev.state.slice(scan0)) {
          if (it.d && Array.isArray(it.d.wf) && it.d.wf.length) { wind = it.d; break; }
        }
      }
      if (!wind) note('第 ' + tries + ' 次按技能没等到风 —— 重试（撞上进球 / 回合结束属正常）');
    }
    A.send({ t: 'input', dir: 0 });   // 收手

    check(!!wind, '★ 线上真的吹起了一阵风（wf 非空）—— 技能链路在发布环境可用',
      wind ? JSON.stringify(wind.wf) : '按了 ' + tries + ' 次，每次 2.4 秒内 wf 都一直为空');

    // ★★ 下面 7 条**故意不放进 `if (wind)`**，而是拿着可能为 null 的 wind 无条件判。
    //   反证实测过：写成 `if (wind) { …7 条… }` 时，"没风"那一版只报 1 条红、总计数从
    //   46 掉到 39 —— 7 条断言凭空**消失**，报告读起来像"38 通过 1 失败"的轻微故障。
    //   ★ 消失的断言和通过的断言在报告里长得一模一样，这就是"条件式断言会藏故障"。
    //     整段（含上面的 `if (s12playing)`）都改成无条件执行，条数恒为 46：
    //     没风时这 7 条一起红，原因一栏写"无风可判"。
    const v = wind && Array.isArray(wind.wf) && wind.wf[0] ? wind.wf[0] : null;
    const why = v ? null : '无风可判（上游「吹起了一阵风」那条已经红了）';
    const dx = v ? v[0] : NaN;
    const dy = v ? v[1] : NaN;

    check(!!v && Math.abs(Math.hypot(dx, dy) - 1) < 0.02, '★ 风向量是单位向量（长度 ≈ 1）',
      v ? '长度=' + Math.hypot(dx, dy).toFixed(4) : why);
    // 需求原话：「拍子在左上 ⇒ 风向右下吹」。此刻拍子被顶在上墙，所以 dx>0 且 dy>0。
    check(!!v && dx > 0 && dy > 0, '★ 风向朝右下方（A 的拍子被顶在左上角）',
      v ? `dx=${dx}  dy=${dy}` : why);

    // 方向必须严格等于「拍子中心 → 球场中心」的连线。用**同一条快照**里的拍子高度反算：
    //   拍子中心 x = PADDLE_MARGIN + PADDLE_W/2 = 26 + 7 = 33（左侧），球场中心 (400, 250)。
    //   把 A 的拍子顶到上墙再放，就是为了让 dy 有可观的量 —— 拍子停在正中央时 dy≈0，
    //   方向断言会退化成"dx>0"这种几乎恒真的空断言。
    const py = v && wind.p ? wind.p[0] : null;
    let dirOk = false;
    let dirDetail = why;
    if (v) {
      if (typeof py !== 'number') {
        dirDetail = '同一条快照里读不到拍子高度 p[0]，方向无从反算';
      } else {
        const rawX = 400 - 33;
        const rawY = 250 - py;
        const el = Math.hypot(rawX, rawY);
        const ex = rawX / el;
        const ey = rawY / el;
        dirOk = Math.abs(dx - ex) < 0.02 && Math.abs(dy - ey) < 0.02;
        dirDetail = `实测(${dx.toFixed(3)}, ${dy.toFixed(3)})  期望(${ex.toFixed(3)}, ${ey.toFixed(3)})  拍子y=${py}`;
      }
    }
    check(dirOk, '★ 风向 == 拍子中心 → 球场中心（用同一快照的拍子高度反算）', dirDetail);

    // 风是**场上的物理**，两端都看得见 —— 与 px（幻影计时，只发给释放方）正好相反。
    // 拿这条反衬"按队过滤"那条：不是所有新字段都该私有。
    const bl = B.last();
    check(!!(bl && Array.isArray(bl.wf) && bl.wf.length),
      '★ 对手那端也能看到这阵风（风是公开的物理，不像幻影要藏）',
      bl && Array.isArray(bl.wf) ? JSON.stringify(bl.wf) : why);

    const post = A.last();
    check(!!(post.sc && post.sc[0] > 0), '★ 放完技能后 A 立刻进入冷却（sc[0] > 0）',
      post.sc ? JSON.stringify(post.sc) : '-');
    check(!!(post.sc && post.sc[0] <= 10), '冷却不超过风的 CD（10 秒）',
      post.sc ? post.sc[0] + 's' : '-');
    // 对手没放技能，冷却仍是 0 —— 冷却必须**按槽位**，不能是房间级的一个数。
    check(!!(post.sc && post.sc[1] === 0), '★ B 没放技能，它的冷却仍是 0（冷却按槽位存）',
      post.sc ? JSON.stringify(post.sc) : '-');
  }

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(52));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) {
    console.log('  失败项:');
    failures.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(52));

  try { A.ws.close(); } catch (e) {}
  try { B.ws.close(); } catch (e) {}
  await sleep(300);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n探针异常终止: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
