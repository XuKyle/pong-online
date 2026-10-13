# 双人乒乓球对战（pong-online）

服务端权威的实时对战乒乓球。**所有物理/计分/道具/技能都在服务端算**，浏览器只做两件事：
发输入、画快照。所以两端永远一致，不存在"谁的网络好谁赢"。

- 在线体验：<https://pong-online-battle.app.workbuddy.host/>
- 玩法：1v1 对战 / 人机 / 双人打 AI；九种道具；**双方随时可暂停**；
  **每局自选拍子皮肤（颜色 = 技能）**：灰=没有技能、青=风、黄=幻影、红=超高速。
- 电脑端和手机端是**同一套文件**，靠 media query 切换 —— 没有第二个页面、没有 `/m`。

---

## 跑起来

需要 **Node ≥ 18**（唯一依赖是 `ws`）。

```bash
npm install
npm start                     # 默认监听 3000
# 探针脚本约定本地服务在 3100，建议：
PORT=3100 npm start
```

然后浏览器打开 `http://127.0.0.1:3100/`。想双人玩就再开一个标签页，用房间码加入。

> 手机端就是同一个地址。想在自己手机上试：让手机和电脑在同一个局域网，
> 浏览器打开 `http://<电脑局域网IP>:3100/`。

---

## 想改什么，去哪儿改

服务端拆成了 `server/` 下的若干模块，`server.js` 保留为**兼容入口**：
它装配依赖、提供原有函数名（测试与探针仍按老名字 require 它），并负责 HTTP / WebSocket 传输。

| 想改的东西 | 位置 |
|---|---|
| 球速 / 拍子尺寸 / 手感 | `server.js` **L75** 起的常量区（`BALL_SPEED_START`、`SPEEDUP_PER_HIT`、`PADDLE_SPEED`…） |
| 九种道具的效果 / 半径 / 刷新频率 | `server.js` **L112** 起的道具常量区 ＋ `server/powerups.js` |
| 拍子皮肤与技能 | `server.js` **L175**（`SKINS` 表）＋ `server/skills.js` |
| AI 强度 | `server.js` **L323** 起的人机难度区 ＋ `server/bot.js` |
| 球的运动 / 碰撞 / 反弹 / 防卡死 | `server/physics.js` |
| 建房/加入/掉线重连/开局/计分/阶段流转 | `server/match.js` |
| 效果到期与**暂停冻结**的时钟语义 | `server/effects.js`（全局唯一一份） |
| 胜负判定 / 落点预测（纯函数） | `server/rules.js` |
| HTTP 路由 / WebSocket 连接与消息分发 | `server.js`（传输层，领域模块里没有 socket） |
| 界面配色 / 布局 | `public/index.css`（整份就是原来内联的 `<style>` 块） |
| **手机端布局** | `public/index.css` 的 media query：**L328**（≤760px 窄屏）、**L362**（竖屏）、**L386**（横屏矮窗铺满） |
| 前端各模块 | `public/js/*.js`，依赖见下表 |
| 探针读取钩子 | `public/js/probe.js`（`window.__probe` / `__bgm` / `__setSound` / `__bgmSrc`） |

### 前端模块

`public/index.html` 现在只剩 147 行：DOM 骨架、一行样式表、若干 `<script src>`，以及一段
34 行的引导代码（造上下文 → 按依赖顺序装模块 → 起音频/画布/循环/连接）。
**没有任何散装全局变量**，模块之间只通过 `app.<area>` 互相调用。
用的是 classic script 而不是 `type="module"`，所以**装模块的顺序就是依赖顺序**。

| 模块 | 依赖 | 负责 |
|---|---|---|
| `js/context.js` | —— | 共享状态 `view`、只读表、DOM 句柄、`slotsFor`、`teamOfMine`/`ballVis` |
| `js/audio.js` | context | Web Audio 音效 + 背景音乐（**必须最先装**：capture 相位的解锁监听器） |
| `js/input.js` | context, audio, net | 键盘 / 触摸 / 本地拍子预测 |
| `js/ui.js` | context, input, net | 菜单 / 覆盖层 / 技能按钮 / 局间重选拍子 |
| `js/diagnostics.js` | context | 逐帧取证与页面量表 |
| `js/render.js` | context, audio, diag, input, ui | 画布、每帧循环、所有绘制 |
| `js/network.js` | context, audio, diag, input, render, ui | WebSocket、重连、座位凭证（**最后装**：收到消息要回调上面那些） |
| `js/probe.js` | 全部（只读） | 四个探针钩子（**最后装**：读的是全部就绪后的 app） |

`node tools/check-frontend-smoke.js` 会把菜单 → 建房 → 加入 → 暂停 → 技能 → 退房真跑一遍，
**任何一条页面未捕获异常都算失败**。拆成多文件之后最容易出的错就是"引用还在、声明没了"，
而它常常只在一条平时不走的分支上冒出来（实测 `probe.js` 全绿时被 `probe-bgm` 逮到过）。

页面由 `public/index.html` + `public/index.css` + `public/js/*.js` 组成，
没有构建步骤，改完刷新即生效。

---

## 测试

**先起服务**（`PORT=3100 npm start`），否则这些脚本会连不上：

| 脚本 | 覆盖 | 期望 |
|---|---|---|
| `test-rules.js` | 纯规则/几何/预测/AI 瞄准/隐形球/暂停冻结/皮肤与八种技能 | 392/0 |
| `test-protocol.js` | 协议层（建房/加入/重连/心跳/多球/暂停/皮肤与技能字段） | 86/0 |
| `tools/check-powerup.js` | 道具生成、拾取、归属、事件格式 | 18/0 |
| `tools/check-solo.js` | 人机（AI 真的会接球 + 难度可测） | 35/0 |
| `tools/check-coop.js` | 双人打 AI 的半场划分与边界 | 31/0 |
| `tools/check-collision.js` | 拍子可接区间的暴力扫描 | 16/0 |
| `test-physics-sequence.js` | 球物理的更新顺序（位移 → 撞球 → 墙反弹） | 3/0 |
| `test-lifecycle.js` | 建房/加入/暂停/掉线重连/一局打完/自动开下一局 | 24/0 |
| `test-cdp-compat.js` | `tools/cdp.js` 旧导出与浏览器生命周期模块的兼容 | 通过 |
| `tools/check-frontend-smoke.js` | 前端模块冒烟：走一遍主要流程，**页面任何未捕获异常都算失败** | 24/0 |
| `tools/probe.js` | 真实浏览器双标签页联机 | 70/0 |
| `tools/probe-solo.js` | 真实浏览器人机 | 43/0 |
| `tools/probe-coop.js` | 真实浏览器双人打 AI | 52/0 |
| `tools/probe-bgm.js` | 音频闸门 / 淡入 / 静音 / Range | 26/0 |
| `tools/probe-powerup-fx.js` | 九种道具 + 叠加层**真的画出来了** | 32/0 |
| `tools/probe-mobile.js` | 手机端布局 + 电脑端零回归 + 真实触摸拖动 | 121/0 |
| `tools/probe-crossplay.js` | 一端真电脑 + 一端真手机，同房互通 | 60/0 |
| `tools/probe-skills.js` | 八种技能的浏览器端取证（按钮位置/风向/两端球数/蓄力光圈） | 82/0 |
| `tools/probe-ball-lag.js` | "球穿过拍子"的渲染层取证 | 报告型，不判红 |
| `tools/check-parity.js` | 本地 vs 线上逐字符一致（**发布后**才跑） | 逐字符一致 |
| `tools/probe-remote.js` | 线上长连接 / 空闲存活 / **真的放一次技能并反算风向** | 46/0（线上） |

```bash
node test-rules.js
PROBE_SITE=http://127.0.0.1:3100 node tools/probe-mobile.js
node tools/probe-remote.js https://你的线上地址     # 只在发布后跑
```

浏览器类探针**自己起无头 Edge**（`--headless=new`），不需要你手动开浏览器。
它们各自用不同的调试端口，可以并行跑。**没装 Edge 也能跑** —— 会退到 Chrome / Chromium；
想强制指定就设 `PROBE_BROWSER=<浏览器可执行文件绝对路径>`。
探针的临时 profile 默认落在系统临时目录，想固定位置就设 `PROBE_TMP=<目录>`。

> **这台开发机上有几个已知的环境性失败，不是回归**（文件拆分重构前后一模一样，
> 见 `.dhcoder/plan/plan-20261012-1808-project-file-splitting.md` 的 Known non-regressions）：
> - `probe-mobile.js`：`#pingPill` 基线漂移导致 6 条失败（115/6，总数仍是 121）
> - `probe-bgm.js`：WebAudio 音量衰减时序，1-2 条失败（25/1 或 24/2，总数 26）
> - `probe-skills.js`：headless 下画布帧计数不前进，1 条失败（81/1，总数 82）
>
> 判定是否回归的标准：同一探针**改动前后**的失败条数与原因是否一致，而不是绝对零失败。

---

## ★ 改之前必读（都是踩过的坑，不是风格建议）

1. **`isPhantom(b)` 必须写 `typeof b.phantom === 'number'`**。幻影球用 `phantom` 存**队号**，
   `0` 是合法值 —— 写成真假判断（`!!b.phantom`）会让 0 队的幻影球被当成真球：
   参与碰撞、出界还送分。实测改坏后**一次红 8 条**。
2. **计分只能走 `afterGoal()`**。如果在球出界的地方直接 `+1`，双倍得分就只是"显示的数字变了"，
   胜负判定读到的还是没乘倍率的值 —— 会出现"加分了却不算赢"。
3. **`removeBall()` 里那行"还有真球在飞就别重发"不能删**。少了它，一颗幻影球出界就会把
   正在飞的真球一起换掉（玩家看到"我的球凭空消失重发"）。
4. **服务端反证必须重启进程**。改 `server.js` 不影响已加载的模块（客户端不用管，
   静态文件每次刷新都重读）。改完记得把 3100 上的进程杀掉重开，否则你在对着旧实现跑测试。
5. **不要用 `pointer: coarse` 做手机端断点**。视口尺寸是探针能精确控制的量，
   而 pointer 媒体特性在仿真环境里不可靠 —— **一条没法在测试里复现的断点等于没测过**。
   现在用的是 `max-width: 760px` 和 `orientation: landscape and max-height: 560px`。
6. **探针里不要写 `if (拿到东西) { 一堆 check }`**。条件式断言会**藏故障**：
   实测 7 条依赖断言包在 `if` 里，被破坏时报告是"38 通过 / 1 失败"、总条数从 46 **掉到 39**——
   断言凭空消失，而"消失的断言"和"通过的断言"在报告里长得一模一样。
   要么无条件执行，要么在 `else` 里补一条红的。

更详细的设计原因、**每一条硬约定的来历**、以及所有反证记录，都在
[`docs/开发笔记.md`](docs/开发笔记.md) —— **动手前先读它**，能省掉大量重复踩坑。

---

## 发布与分享

通过 WorkBuddy 的「发布为应用」把这个目录发出去即可（Node 项目，会自动 `npm install` 并启动）。
发布后建议跑一次 `node tools/check-parity.js <域名>` 确认网关没有改动静态资源。

要把**源码**交给别人（让对方也能改），打个 zip 发过去即可：

```bash
node tools/mkzip.js <本目录绝对路径> <输出 zip 路径>
# 例：node tools/mkzip.js "$PWD" ../pong-online-交接包.zip
```

`tools/mkzip.js` 是一个自带的最小 zip 打包器（只依赖 Node 自带的 `zlib`）。
放它进来是有原因的：有些 Windows 机器上 `tar` / `Compress-Archive` 遇到特殊字符文件名时
会产出**坏包** —— 能解开、CRC 也对，但**文件名全变成了目录名**，只有真的逐个比对文件名
才会发现。打完包**一定要解压一遍逐字节比对**，别只看"压缩成功"。

---

## 关于这份代码

原始作者的项目目录是 `F:\WorkBuddy\2026-10-09-21-30-11\pong-online`，
文档里出现的该路径都是**作者机器上的**，你这边直接用自己的目录即可，
代码本身没有硬编码任何绝对路径。
