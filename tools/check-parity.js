'use strict';
// 一致性校验：远端拿到的页面，是否与本地源码逐字节相同。
// 动机：远程探针发现平台网关会改写 /healthz 的响应体，那么它有没有顺手改动
// 静态资源？如果 HTML 被改动而没人发现，就是典型的「静默降级」。

const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'https://pong-online-battle.app.workbuddy.host').replace(/\/+$/, '');
const FILES = ['', 'index.html'];

const norm = (s) => s.replace(/\r\n/g, '\n');

(async () => {
  const localPath = path.join(__dirname, '..', 'public', 'index.html');
  const local = norm(fs.readFileSync(localPath, 'utf8'));
  console.log('本地 public/index.html: ' + local.length + ' 字符');

  let allSame = true;
  for (const f of FILES) {
    const url = BASE + '/' + f;
    let remote;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      remote = norm(await r.text());
      console.log('\n远端 ' + url);
      console.log('  HTTP     : ' + r.status);
      console.log('  content-type: ' + (r.headers.get('content-type') || '-'));
      console.log('  content-encoding: ' + (r.headers.get('content-encoding') || '-'));
      console.log('  字符数   : ' + remote.length);
    } catch (e) {
      console.log('\n远端 ' + url + ' 取回失败: ' + e.message);
      allSame = false;
      continue;
    }

    if (local === remote) {
      console.log('  一致性   : 完全一致 (逐字符相同)');
      continue;
    }

    allSame = false;
    let i = 0;
    const n = Math.min(local.length, remote.length);
    while (i < n && local[i] === remote[i]) i += 1;
    console.log('  一致性   : 不一致，首个差异在第 ' + i + ' 个字符');
    console.log('  本地  : ' + JSON.stringify(local.slice(Math.max(0, i - 70), i + 90)));
    console.log('  远端  : ' + JSON.stringify(remote.slice(Math.max(0, i - 70), i + 90)));
    console.log('  长度差: ' + (remote.length - local.length));
  }

  // 关键标记：确认业务逻辑没被替换
  console.log('\n关键代码标记检查:');
  const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(15000) });
  const html = norm(await r.text());
  const marks = [
    ["location.protocol === 'https:' ? 'wss:' : 'ws:'", '按协议自动选 wss/ws'],
    ["'/ws'", 'WebSocket 挂在 /ws'],
    ['sessionStorage', '座位凭证用 sessionStorage'],
    ['__probe', '状态读取钩子存在'],
    ['hideOverlay', '入房后隐藏遮罩'],
    ['ArrowUp', '键盘上方向'],
  ];
  for (const [needle, label] of marks) {
    const ok = html.indexOf(needle) >= 0;
    console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + label);
    if (!ok) allSame = false;
  }

  console.log('\n结论: ' + (allSame ? '远端与本地源码一致，网关未改动静态资源' : '存在差异，需要人工确认'));
  process.exit(allSame ? 0 : 1);
})().catch((e) => {
  console.error('校验失败: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
