'use strict';

/**
 * 双人实时对战乒乓球 —— 服务端权威架构
 *
 * 设计要点（也是这次探针要验证的东西）：
 *   1. 游戏状态只存在于这里，玩家电脑只负责"上报按键"和"把收到的画面画出来"。
 *   2. 模拟以固定步长推进，与网络广播频率解耦 —— 广播 30Hz，内部再细分 8 次积分，
 *      避免球速快时穿过球拍（隧穿）。
 *   3. 所有下行消息带服务器时间戳，客户端据此估算延迟。
 *   4. 依赖只有 ws —— 不手写 WebSocket 帧解析，否则我自己的 bug 会被误判成
 *      "链路的锅"，那这次探针就白测了。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { isWin: evaluateWin, predictY: calculatePredictY } = require('./server/rules');
const { createBotBehavior } = require('./server/bot');
const { createPhysics } = require('./server/physics');
const { createPowerupBehavior } = require('./server/powerups');
const { createSkillBehavior } = require('./server/skills');
const { createEffectClock } = require('./server/effects');
const { createMatchLifecycle } = require('./server/match');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 场地与物理参数（逻辑坐标，客户端按画布等比缩放） ----------
// ★ 场地尺寸是**按房间**的（room.W / room.H），不再是全局常量 ——
//   新模式需要一个明显更高的球台。这两个常量只是经典模式的默认值。
const W = 800;
const H = 500;

// 各模式的场地。
// coop 高 800：每半场 400，虽然比经典模式单人守的 500 略紧，但有两个人一起守，
// 实际压力反而小得多；宽度顺带从 800 提到 960，免得球台变得太瘦。
const COURT = {
  duel: { W: 800, H: 500 },
  solo: { W: 800, H: 500 },
  coop: { W: 960, H: 800 },
};

/**
 * 每个模式的拍子布局。
 *   edge = 拍子贴哪条边（left / right）
 *   team = 属于哪一队（0 = 左队，1 = 右队）—— 计分 / 护盾 / 双倍 / 冰冻全都按**队**算，
 *          所以 coop 里左边两个拍子天然共享同一份比分、同一份道具效果
 *   span = 拍子中心的活动范围 [yMin, yMax]
 * coop 是唯一「一队有多个拍子」的模式：左队拆成上半场和下半场各一个。
 *
 * ★ 为什么把「槽位」和「队伍」拆开：整个服务端的 `side` 参数（计分、护盾、冰冻…）
 *   语义其实一直是**队伍**，只有 room.paddles 的数组下标是**槽位**。
 *   拆开后，coop 只需要改槽位表，计分那一整条链路一行都不用动。
 */
function buildSlots(mode, h) {
  if (mode === 'coop') {
    return [
      { edge: 'left', team: 0, span: [0, h / 2] },
      { edge: 'left', team: 0, span: [h / 2, h] },
      { edge: 'right', team: 1, span: [0, h] },
    ];
  }
  return [
    { edge: 'left', team: 0, span: [0, h] },
    { edge: 'right', team: 1, span: [0, h] },
  ];
}

// 哪个槽位预置 AI。这些座位不对外开放，也不会被真人的掉线宽限顶替。
const BOT_SLOT = { duel: [], solo: [1], coop: [2] };

const PADDLE_W = 14;
const PADDLE_H = 96;
const PADDLE_MARGIN = 26;
const BALL_R = 9;
const PADDLE_SPEED = 540;        // px/s
const BALL_SPEED_START = 430;    // px/s
const BALL_SPEED_MAX = 900;
// ★ 每被拍子打中一次，球速乘以这个系数（封顶 BALL_SPEED_MAX）。
//   1.055 → 1.075：从出速爬到封顶所需击球数由 ~14 次降到 ~11 次，
//   手感上"打着打着就快起来"来得更早，而不是要在长回合里慢慢熬。
//   ★ 必须是**逐次相乘**，不能写成"每次加一个常量"：加法是线性增长，
//     十几拍之后球速会远超设计预期，根本没法接（弧线球那段注释里是同一个坑）。
const SPEEDUP_PER_HIT = 1.075;
const MAX_BOUNCE_ANGLE = Math.PI / 3.2;   // 约 56 度，防止球变成纯上下运动
// coop 里 AI 要一个人守整条右边（800px 高），所以额外给它一个速度倍率。
// 不加速它连"从一端赶到另一端"都来不及 —— 这是玩法必需，不是难度调味。
const COOP_BOT_SPEED_MUL = 1.4;
// coop 场地更宽，球要飞更久；把出速略提一点，免得节奏比经典模式拖沓。
const COOP_BALL_SPEED = 480;
// 乒乓球规则：先到 11 分、且净胜 2 分才算赢一局（10:10 之后必须连赢两分）
const WIN_SCORE = 11;
const WIN_MARGIN = 2;

// ---------- 道具 ----------
// 七种效果全部设计成"对拾取方有利"，不做负面道具 ——
// 休闲对战里被随机罚一下只会让人恼火，不会让人觉得有趣。
// 半径和刷新频率是"体感"参数：太小或太慢，一局也吃不到一个，加了等于没加。
// 实测原始参数下 20 秒里球自然碰到 0 次，所以把半径和频率都调松了。
//
//   0 = 加长自己的拍子   1 = 削短对方的拍子   2 = 球加速
//   3 = 冰冻对方的拍子   4 = 护盾（挡一次失分）  5 = 双倍得分
//   6 = 弧线球（接下来几秒球一路拐弯，轨迹发飘）
//   7 = 分裂球（原球不变，额外多出一个半速的球；**每个球漏了都算丢一分**）
//   8 = 隐形球（吃到的人看得见球，**对面看不见**，只能靠预判；进出场都是渐变）
//
// 类型 5 会改比分，所以计分必须统一走 afterGoal（不能在 stepBall 里直接 +1），
// 否则倍率只在"看起来"加了分，胜负判定用的还是旧值。
const POWERUP_R = 21;
const POWERUP_N = 9;
// ★ 这三个数是"体感"参数，只能靠实测标定，不能凭感觉写：
//   · 太慢 —— 二十秒里球一次都碰不到，加了等于没加（最初的 4500/6500 就是这个毛病）；
//   · 太快 —— 场上永远挂着两三个，比分变成道具随机数而不是技术。
//   标定结果见 tools/check-powerup.js 的"拾取节奏"一节（会直接打印每分钟拾取次数）。
const POWERUP_FIRST_MS = 1500;    // 开局多久后出现第一个
const POWERUP_GAP_MS = 3000;      // 之后每隔多久补一个
const POWERUP_LIFE_MS = 11000;    // 没人碰就自己消失，避免场上一直挂着
const POWERUP_MOD_MS = 8000;      // 效果持续时长
// 同一时刻最多几个。★ 道具改成"场上可以同时有多个"之后这个上限必须存在：
// 没有上限时没人捡就会线性堆积，最后半个场地全是圈，连球都看不清。
const POWERUP_MAX = 3;
const PADDLE_GROW = 1.65;
const PADDLE_SHRINK = 0.62;
const BALL_FAST = 1.34;
const FREEZE_MS = 1600;           // 冰冻时长。再长就不是"失误一下"而是"直接送分"
const SHIELD_MAX = 2;             // 护盾最多存两层，防止一直吃一直叠到无解
// 弧线球：实现上不是"加一个横向加速度"，而是**每个子步把速度矢量旋转一个小角度**。
//   · 旋转是正交变换，速率严格不变 —— 球不会因为拐弯越飞越快，更不会突破
//     BALL_SPEED_MAX（用"加加速度"写就会累积，几秒后球快得根本没法接）；
//   · 轨迹是一段正圆，看起来正好就是"飘"。
// 0.35 rad/s ≈ 20°/秒：一次横穿（约 1.5 秒）横向偏移约 40px，相对拍子半长 48px，
// 是"看得出来、需要调整、但接得到"的量级 —— 再大就纯粹是运气了。
// ★ 0.35 → 0.55（≈ 31.5°/秒）：用户反馈"弧线看不出来，弧线球的弧线再大一点"。
//   0.55 时一次横穿横向偏移约 95px ≈ 两个拍子半长，轨迹明显是一个圆弧，
//   而球速本身不变（旋转是正交变换，见 spinBall），所以只是"球会拐"而不是"球变快"。
//   上限在哪里：约 0.9 之后一整条横穿的偏移会超过一个拍子的活动范围，
//   接球变成纯运气。0.55 离那里还有距离。
const CURVE_MS = 6000;
const CURVE_SPIN = 0.55;
// 分裂球的初速度 = 分裂瞬间原球速度的**一半**。
// 定成一半而不是"一样快"，是因为一样快会让两个球以同样的节奏同时到达两侧，
// 接球变成纯手速；一半速度会让它们明显错开，变成"先应付快的、再补慢的"。
const SPLIT_SPEED_MUL = 0.5;
// 场上同时最多几个球。
// ★ 分裂是可以反复吃的（吃到一次变两个），不设上限就会指数增长：
//   三次分裂 8 个球，场地直接变成弹幕，既接不住也看不清。
//   定 3 是"明显变热闹但还看得过来"的量级。
const MAX_BALLS = 3;

// ---------- 防"竖直卡死" ----------
// 球只在上下墙之间竖直弹时，x 永远不变 ⇒ 永远碰不到任何拍子 ⇒ 这一回合
// **永远不会结束**（不是"节奏慢"，是整局死在那儿）。来路见 unstickBall 的注释。
// 下面几个数是"安全 + 手感"的折中，改动前先想清楚：
const MIN_VX_RATIO = 0.18;              // 横向分量至少要占速率的 18%（≈ 离垂直不超过 79.6°）
const UNSTICK_ANG_MIN = Math.PI / 6;    // 重瞄角度下限 30°（横向一定要有显著推进）
const UNSTICK_ANG_MAX = Math.PI / 3;    // 重瞄角度上限 60°（不要一下又变成纯水平）
const UNSTICK_MIN_SPEED = 180;          // 速率兜底（px/s）：速率本身接近 0 时也要能飞出去

// ---------- 隐形球 ----------
// 被隐形的是**对面那一队**，吃到的人自己看得见球。
// 时长特意取得比其它效果短（其余是 8 秒）：其余效果是"难受一下"，
// 这个是"完全失去信息"，一场球里给 3 秒已经是"这一分大概率丢了"的量级。
// 两端各留一段渐变（见 INVIS_FADE_MS），免得球"啪"地消失、"啪"地又冒出来 ——
// 突然消失会让人以为是自己卡了或者渲染坏了，渐变才读得出"这是道具造成的"。
const INVIS_MS = 3000;
const INVIS_FADE_MS = 400;

// ---------- 拍子皮肤（= 技能） ----------
// 皮肤就是拍子颜色，颜色就是技能。灰色 = 没有技能。
// ★ 皮肤**只**决定"这个槽位有什么主动技能 / 拍子画成什么颜色"，不改任何物理参数 ——
//   所以它对"服务端权威"那条链路是零侵入的：没选皮肤的人和以前完全一样。
const SKINS = ['gray', 'cyan', 'yellow', 'red', 'blue', 'black', 'purple', 'white', 'orange'];
const SKIN_N = SKINS.length;
const SKIN_GRAY = 0;      // 没有技能
const SKIN_WIND = 1;      // 青：刮一阵风
const SKIN_PHANTOM = 2;   // 黄：幻影球
const SKIN_BOOST = 3;     // 红：下次击球超高速
const SKIN_STICK = 4;     // 蓝：下一次接球把球粘住 1 秒，然后朝正前方放出去
const SKIN_BLACKHOLE = 5; // 黑：己方半区随机开一个黑洞，球从对方半区随机位置飞出
const SKIN_CHAOS = 6;     // 紫：10 秒内自己接球改为随机变角 + 大概率加速
const SKIN_BLOCK = 7;     // 白：让对方下一次吃到的道具无效
const SKIN_SLOW = 8;      // 橙：对方拍子移动速度上限 -30%，持续 2 秒
/** 每个技能的冷却（毫秒）。下标就是皮肤编号；灰的没有技能，写 0。 */
const SKILL_CD_MS = [0, 10000, 15000, 10000, 10000, 10000, 15000, 10000, 10000];

/**
 * 风：从**自己拍子中心**指向**球场中心**的一股加速度，持续 1 秒。
 *
 * ★ 为什么用"加速度"而不是"直接改速度"：需求原话是"该减速减速、该偏移偏移、
 *   该加速加速，甚至球本身移动的慢，可能还会被吹变向" —— 这四种表现其实是**同一个
 *   式子**的四个结果：把方向单位向量乘一个固定的加速度加到球的速度上，
 *   顺风的球得到加速、逆风的球得到减速、横穿的球被推偏、本来就慢的球直接被吹得转向。
 *   分情况写反而会写出四段互相打架的逻辑。
 *
 * ★ 力度标定（300 px/s²）：持续 1 秒 ⇒ 垂直分量最多位移 0.5·300·1² = 150px，
 *   约等于 3 个拍子半长（48px），足以让一次接球变成接不到；顺风则把出速从 430 推到 730。
 *   再大就是"闭着眼按都得分"，那就不是技能而是抽奖了。
 * ★ 300 → 380（用户："风的效果再强一点"）：垂直位移 150px → 190px（约 4 个拍子半长），
 *   顺风出速 430 → 810。仍然夹速率上限，所以不会把球推过 BALL_SPEED_MAX 那条反隧穿前提。
 */
const WIND_MS = 1000;
const WIND_ACC = 380;

/**
 * 幻影球：一个"只有对手看得见"的假球，用来做"分裂球"的假象。
 *
 * ★ 真球和幻影球必须**等速**且**对称**偏开：真分裂球是"原球不变 + 新球半速"，
 *   那种一眼就能从速度上认出哪个是真的 —— 幻影球一旦照抄，对手只要看谁快就知道该接谁，
 *   技能等于白做。这里改成两个球都以原来的速率、朝两边各偏 PHANTOM_ANGLE。
 *
 * ★ 它和真球**互不碰撞**（撞上就穿过去）：这一条是需求明确要的，也是这套假象的
 *   唯一破绽 —— 对手真的会看到两个球交叉着穿过去。这一点在交付说明里如实写清楚。
 */
const PHANTOM_MS = 5000;
const PHANTOM_ANGLE = 0.30;   // 约 17°
/**
 * 幻影球对 **AI** 的额外瞄准偏差（px）。
 *
 * ★ 为什么需要这个数：幻影球是"看起来和真球一模一样的假球"，AI 看不见"哪个是假的"
 *   ——这一点和真人一样。但如果 AI 精确地追着幻影球跑到它的落点上，表现会很怪：
 *   它不是"被骗"，而是"像个追踪机器人一样执行了一个错误目标"。
 *   加上一层随机偏差之后，AI 有时被带偏得远、有时刚好也覆盖到真球的来路，
 *   看起来就是"被假动作晃了一下，有时晃到了有时没晃到"。
 * ★ 定 46px：约等于一个拍子半长（48px）。再大就是"完全放弃"，再小等于没加。
 */
const PHANTOM_BOT_SWAY = 46;

/**
 * 超高速：红色技能蓄力后，下一次击球的出速。
 *
 * ★ 刻意**高于** BALL_SPEED_MAX（900）。反隧穿的前提是"每个子步的位移远小于判定窗口"，
 *   而拍子/墙/出界全都是**半空间判定**（`b.x - BALL_R <= face`），另有一条 30px 的护栏
 *   （`b.x > PADDLE_MARGIN - 30`）。1400 px/s 时子步位移 = 1400/240 ≈ 5.8px，
 *   离 30px 的护栏还差得远，不会被穿过去。
 * ★ 击球之后球并不会一直这么快：下一次被拍子碰到时走的是常规公式
 *   （`min(hypot * SPEEDUP_PER_HIT, BALL_SPEED_MAX)`），会被夹回 900 —— 这就是想要的
 *   "这一下特别快，接下来恢复常态"。
 * ★ 1400 → 1820（用户："红拍子使用技能接球后的速度再快 30%"）：
 *   子步位移 = 1820/240 ≈ 7.6px，仍然远小于 30px 护栏，反隧穿前提不变。
 *   0.3 这个倍率不是随手写的 —— 是需求原话里的数，别再"顺手调圆"。
 */
const BOOST_SPEED = 1820;

// ---------- 第 11 轮新增的五个技能 ----------

/**
 * 蓝：粘球。放技能之后，**自己**下一次击球时球会被"粘"在拍子上，1 秒后
 * 朝正前方（自己这一侧的正前方 = 水平方向）以普通发球初速放出去。
 *
 * ★ "1 秒以后自动向正前方释放"——定成 BALL_SPEED_START（430）而不是 0：
 *   粘住的这一秒里球停在拍子上（位置跟着拍子走），时间一到就弹出去。
 *   速率用普通发球初速，是需求原话（"速度相当于普通球的初始速度"）。
 * ★ 粘住期间球**不参与碰撞**（不然它贴在拍子上会每子步被弹一次），
 *   但**仍然要参与出界/计分判定**——它停在拍子外侧、本来也不会出界。
 *   用一个 `b.stuck = { slot, until }` 标记，在 stepBalls 里最先处理。
 */
const STICK_MS = 1000;

/**
 * 黑：黑洞。技能发动时在**己方靠中间的那半区**随机位置开一个洞，
 * 球进入洞以后，从**对方靠中间的那半区**随机位置以**相同的速率**飞出来，
 * 方向是朝对方、以正右（或正左）为 0°、上下 60° 之内随机。
 *
 * ★ 区间定义（用户在需求里用手画了一遍，这里是那句话的翻译）：
 *   设自己队在左。屏幕从左到右 0 → 1：
 *     · 黑洞中心 x ∈ [0.25W, 0.50W]（"四分之一到二分之一"），y 在球场内随机；
 *     · 飞出点 x ∈ [0.50W, 0.75W]（"二分之一到四分之三"），y 在球场内随机。
 *   自己队在右时**整体镜像**：x → W - x。
 *   所以黑洞永远在自己这半边的"靠中间"那一块、出口永远在对面靠中间那一块。
 * ★ 球速严格保持（需求原话"速率和进入黑洞时相同"）：只换方向、不乘任何系数。
 * ★ 出洞方向是"朝对方"，不是"继续原来的方向"——这是需求明确要的
 *   （"不管进入黑洞时是什么方向"）。
 */
const HOLE_R = 34;                 // 黑洞半径（视觉与进入判定共用）
const HOLE_LIFE_MS = 12000;        // 没人进就自己消失，避免场上长期挂着一个洞
const HOLE_HALF_DEG = 60;          // 出洞方向的半角（±60°）

/**
 * 紫：乱弹。10 秒内，自己每次接球不再走常规反弹，而是随机改角度 + **大概率加速**。
 *
 * ★ "大概率是加速"要真的做成大概率，否则这个技能会变成"有时帮自己有时害自己"。
 *   做法：80% 的击球走 `×[1.0, 1.35]` 的加速，20% 走 `×[0.85, 1.0]` 的微减速。
 *   期望值是净加速，但偶尔慢一下让对手也摸不准节奏。
 * ★ 出射方向朝对方、±60°（和黑洞同一套"朝对方半区随机"的规则）。
 * ★ 仍然夹 BALL_SPEED_MAX —— 它是"改变球速的路径"之一，
 *   不夹的话十几次击球就能把球推到反隧穿前提之外。
 */
const CHAOS_MS = 10000;
const CHAOS_HALF_DEG = 60;

/**
 * 白：道具封锁。放技能之后，**对方**下一次吃到的道具无效（不产生任何效果）。
 * CD 10 秒，**不能叠加**（连按两下只算一层，不能存两次）。
 *
 * ★ 用"剩余层数"而不是"布尔"：需求说"不能叠加"，所以按到上限就不再增加。
 *   层数是 1 就够用（对手吃一次就消耗掉），上限也定 1 —— 定 2 就等于能叠加了。
 * ★ 无效的是"下一次**吃到**的"，不是"下一个生成的道具"：
 *   判定点在 stepPowerup 的拾取分支，消耗在 applyPowerup 之前。
 */
const BLOCK_MAX = 1;

/**
 * 橙：减速。放技能之后，对方拍子的移动速度上限降到 70%，持续 2 秒。
 *
 * ★ 是"上限"而不是"给一个负加速度"—— 需求原话"拍子移动速度上限降低30%"，
 *   所以直接乘在 stepPaddles 的 speed 上，而不是改某个速度积分。
 *   生效期间玩家照样能推，只是推得慢。
 * ★ 按**队**生效（和冰冻一样）：coop 里左边两个人一起变慢，
 *   因为"对面那个人放技能"针对的是你这一队，不是某一个座位。
 */
const SLOW_MS = 2000;
const SLOW_MUL = 0.7;

// ---------- 人机难度 ----------
// 难度由三个旋钮共同决定：
//   thinkMs  —— 反应间隔。球飞过来只有零点几秒，反应慢就来不及更新落点。
// ★ 命中率 = P(|瞄准误差| + 停位偏差 > 57px)。
//   停位偏差约 4px，所以「接不到的比例」≈ (errPx - 53) / errPx：
//   96 → 约 45%；68 → 约 22%；58 → 约 9%。再叠上大角度球走不到位的漏接。
const BOT_PRESETS = [
  { name: '简单', thinkMs: 320, errPx: 96, speedMul: 0.66 },
  { name: '普通', thinkMs: 190, errPx: 68, speedMul: 0.84 },
  { name: '困难', thinkMs: 100, errPx: 58, speedMul: 1.0 },
];

const TICK_HZ = 30;
// 调试开关：开着才会在快照里带 AI 的内部决策（方向/目标/瞄准误差）
const DEBUG_BOT = process.env.PONG_DEBUG_BOT === '1';
// 调试开关：强制生成指定类型的道具，用来把六种道具一一定格截图。
// 支持逗号分隔的列表并按生成次数轮转（PONG_FORCE_PU=0,1,2,3,4,5），
// 这样一局就能把六种都过一遍。默认 null（随机），线上不会走到这条分支。
const FORCE_PU = (() => {
  if (process.env.PONG_FORCE_PU === undefined) return null;
  const list = String(process.env.PONG_FORCE_PU).split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < POWERUP_N);
  return list.length ? list : null;
})();
const puSeq = { i: 0 };
// 调试开关：定时把三种"有画面表现"的效果刷到 0 号位身上，好让前端探针把
// 冰冻 / 护盾 / 双倍得分三个叠加层逐一拍照取证。真人吃到道具是随机的，
// 靠等就是碰运气 —— 这是节拍器，不是玩法，默认关闭。
const DEBUG_FX = process.env.PONG_DEBUG_FX === '1';
// 调试开关：让球一直带弧线，好把"拐弯的尾迹"定格截图。
// 弧线球得靠球随机撞上道具才生效，靠等就是碰运气 —— 和 DEBUG_FX 一个道理。
const DEBUG_CURVE = process.env.PONG_DEBUG_CURVE === '1';
// 强制类型那个开关同时也是"快进开关"：它的用途就是"把六种道具一一定格截图"。
// ★ 实测正常节奏下一轮要 19.5 秒（存活 13s + 间隔 6.5s，没人吃的话），
//   要轮到第六种得等 100 秒以上。所以在这个开关下把节奏压紧。
//   线上不带这个环境变量，走的一定是正常参数。
const PU_FIRST_MS = FORCE_PU ? 900 : POWERUP_FIRST_MS;
const PU_GAP_MS = FORCE_PU ? 1500 : POWERUP_GAP_MS;
const PU_LIFE_MS = FORCE_PU ? 3000 : POWERUP_LIFE_MS;
const DT = 1 / TICK_HZ;
const SUBSTEPS = 8;
const SUB_DT = DT / SUBSTEPS;
const COUNTDOWN_MS = 1800;
const OVER_HOLD_MS = 4000;

const ROOM_IDLE_MS = 3 * 60 * 1000;   // 双方都掉线后保留多久
const SLOT_GRACE_MS = 90 * 1000;      // 掉线后保留座位多久，供重连

// ---------- 小工具 ----------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;   // 拍子倍率这类小数要保留两位

// ---------- 球 ----------
// 球从一个变成多个（分裂球）之后，"哪个是哪个"必须能被客户端认出来。
// id 只增不减，用来做跨快照的身份匹配；不要用数组下标当身份 ——
// 下标会在某个球出界后整体前移。
// 计数器已经跟着实现搬进 server/physics.js，这里只保留兼容入口。
function makeBall(x, y) {
  return physics.makeBall(x, y);
}

let tokenSeq = 0;
function newToken() {
  tokenSeq += 1;
  return `${Date.now().toString(36)}${tokenSeq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

// 去掉了容易看错的 O / I / 0 / 1
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i += 1) {
      c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(c)) return c;
  }
}

// ---------- 房间 ----------
/** 机器人没有 ws —— 所有"这个座位算不算在场"的判断都必须走这里，不能直接看 ws */
const isBot = (p) => !!(p && p.bot);
const isLive = (p) => !!(p && p.ws && p.ws.readyState === 1);
const isPresent = (p) => isBot(p) || isLive(p);

/**
 * 这个球是不是幻影球（假球）。
 * ★ 必须用 `typeof === 'number'` 而不是真假判断：`b.phantom` 存的是**拥有它的队伍号**，
 *   而 0 队是完全合法的值 —— 写成 `if (b.phantom)` 会让"0 队放的幻影球"被当成真球，
 *   于是它不但会参与真球碰撞，出界还会给对手送一分。这是最容易写错、又最难看出来的一处。
 */
const isPhantom = (b) => !!(b && typeof b.phantom === 'number');

/** 把客户端传来的皮肤编号夹成一个合法下标。乱七八糟的值一律当"灰"（没技能） */
function normSkin(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < SKIN_N ? n : SKIN_GRAY;
}

/** 局间允许改皮肤吗：窗口开着、且这一局还没真的开打 */
function canPickSkin(room, now) {
  return room.reselectPending && room.phase !== 'playing' && room.phase !== 'over'
    && !room.userPaused && now - room.lastActivity < 20000;
}

/**
 * 局间改皮肤。改为 0 也允许（"我这局不要技能了"），所以不做 `!skin` 判断。
 * ★ 切皮肤意味着换技能，手上那块拍子的"蓄力 / 粘球"就不再属于它了，
 *   必须一起清 —— 否则会出现"红拍子蓄好力，切回灰拍子还能打出一发超高速"。
 *   只清自己那个槽位，冷却也一并归零（新技能从"可以放"开始，和 startMatch 一致）。
 * ★ 在这里点皮肤**不能**顺带延长窗口：lastActivity 只在真正改的时候刷新一下活跃时间，
 *   但窗口本身由 reselectPending 决定，不会被刷新续命（见 canPickSkin 的判据）。
 */
function pickSkin(room, slot, skin) {
  if (!room.reselectPending) return false;
  if (room.phase === 'over') return false;
  if (room.phase === 'playing') return false;
  if (room.userPaused) return false;
  const v = normSkin(skin);
  if (room.skins[slot] === v) return true;   // 选的是同一个：算成功，别搅乱计时
  room.skins[slot] = v;
  room.boostArmed[slot] = false;
  room.stickArmed[slot] = false;
  room.chaosUntil[slot] = 0;
  room.skillReadyAt[slot] = 0;
  return true;
}

/** 把各种历史写法归一成三种模式。旧的 createRoom(code, true, level) 等价于 'solo' */
function normMode(mode) {
  if (mode === true || mode === 'solo') return 'solo';
  if (mode === 'coop') return 'coop';
  return 'duel';
}

/**
 * Create an AI player through the extracted behavior module.
 *
 * @param {number} level Requested difficulty index.
 * @param {number} [speedBoost=1] Mode-level speed multiplier.
 * @returns {object} AI player state compatible with a human player record.
 */
function makeBot(level, speedBoost = 1) {
  return botBehavior.makeBot(level, speedBoost);
}

/**
 * 造一个新房间（并把 AI 放进它该坐的槽位）。
 * 房间状态形状与它的全部字段说明在 server/match.js。
 */
function createRoom(code, mode, level) {
  return match.createRoom(code, mode, level);
}

/**
 * 只算真人。机器人不算"活着" —— 否则人走了房间永远回收不掉。
 * 实现位于 server/match.js。
 */
function anyAlive(room) {
  return match.anyAlive(room);
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

// 只把**传输层的活**交给房间生命周期模块：ws 仍由连接管理持有，
// 模块通过 player 记录读写它，并显式声明自己的副作用，不用直接摸 socket。
function wsPlayer(ws, code, side, token) {
  ws.player = { code, side, token };
}

// ---------- 道具、技能与效果时钟 ----------
/**
 * 领域模块在这里装配，依赖全部显式注入：下面那些同名函数只是兼容入口。
 * 依赖方向是单向的 —— 道具 / 技能 / 时钟都不 require 本文件，也不互相 require。
 */

/** 下一个道具的类型。强制类型开关（FORCE_PU）按顺序循环，普通局随机。 */
function pickPowerupType() {
  return FORCE_PU
    ? FORCE_PU[puSeq.i++ % FORCE_PU.length]
    : Math.floor(Math.random() * POWERUP_N);
}

const powerupBehavior = createPowerupBehavior({
  POWERUP_MOD_MS,
  POWERUP_MAX,
  POWERUP_R,
  pickType: pickPowerupType,
  PU_FIRST_MS,
  PU_GAP_MS,
  PU_LIFE_MS,
  BALL_R,
  MAX_BALLS,
  BALL_FAST,
  FREEZE_MS,
  SHIELD_MAX,
  CURVE_MS,
  CURVE_SPIN,
  INVIS_MS,
  INVIS_FADE_MS,
  PADDLE_GROW,
  PADDLE_SHRINK,
  clamp,
  splitBall,
});

const skillBehavior = createSkillBehavior({
  SKILL_CD_MS,
  SKIN_N,
  SKIN_GRAY,
  SKIN_WIND,
  SKIN_PHANTOM,
  SKIN_BOOST,
  SKIN_STICK,
  SKIN_BLACKHOLE,
  SKIN_CHAOS,
  SKIN_BLOCK,
  SKIN_SLOW,
  WIND_MS,
  PHANTOM_MS,
  PHANTOM_ANGLE,
  HOLE_R,
  HOLE_LIFE_MS,
  CHAOS_MS,
  BLOCK_MAX,
  SLOW_MS,
  PADDLE_MARGIN,
  PADDLE_W,
  isPhantom,
  makeBall,
});

// 效果时钟：到期清理与暂停冻结只有这一份实现（道具侧与技能侧都在这一趟里清）。
const effectClock = createEffectClock({
  refreshPaddleMul: powerupBehavior.refreshPaddleMul,
});

/**
 * 房间与对局生命周期。ws 只作为玩家记录上的引用传进去，模块自己不 send，
 * 需要回执时由 joinedPayload / handleRejoin 显式拿回去交给连接管理。
 */
const match = createMatchLifecycle({
  COURT,
  BOT_PRESETS,
  BOT_SLOT,
  COOP_BOT_SPEED_MUL,
  COOP_BALL_SPEED,
  BALL_SPEED_START,
  PU_FIRST_MS,
  SKIN_GRAY,
  SLOT_GRACE_MS,
  OVER_HOLD_MS,
  COUNTDOWN_MS,
  SUBSTEPS,
  SUB_DT,
  CURVE_SPIN,
  clamp,
  isBot,
  isLive,
  isPresent,
  isPhantom,
  isWin,
  normMode,
  buildSlots,
  normSkin,
  makeBot,
  makeBall,
  r1,
  clearPowerups,
  clearSkills,
  resetBall,
  launchBall,
  shiftDeadlines,
  trackMods,
  stepPaddles,
  stepBalls,
  stepPowerup,
  applyPowerup,
  debugShowcaseFx,
  DEBUG_FX,
  DEBUG_CURVE,
  wsPlayer,
});

/** 每局开始时清空场上道具与残留效果。实现位于 server/powerups.js。 */
function clearPowerups(room) {
  powerupBehavior.clearPowerups(room);
}

/** 每局开始时清空技能冷却与蓄力（皮肤保留）。实现位于 server/skills.js。 */
function clearSkills(room) {
  skillBehavior.clearSkills(room);
}

/**
 * 把房间内所有"挂钟型"的截止时刻整体往后推。
 * 实现位于 server/effects.js —— 暂停的冻结语义只有那一份。
 */
function shiftDeadlines(room, ms) {
  effectClock.shiftDeadlines(room, ms);
}

/**
 * 切换暂停。**任意一方按下都直接生效** —— 这不是投票，谁按谁说了算。
 * 实现位于 server/effects.js。
 */
function togglePause(room, slot) {
  return effectClock.togglePause(room, slot);
}

// ---------- 技能 ----------
// 施放、冷却与复位在 server/skills.js；下面保留同名兼容入口。
/** 这个皮肤有没有主动技能（灰的没有） */
function skinHasSkill(skin) {
  return skillBehavior.skinHasSkill(skin);
}

/** 青：刮一阵风。风向 = 拍子中心 → 球场中心的单位向量。 */
function castWind(room, slot, now) {
  return skillBehavior.castWind(room, slot, now);
}

/** 黄：放出一个幻影球（真球与幻影球等速对称偏开）。 */
function castPhantom(room, slot, now) {
  return skillBehavior.castPhantom(room, slot, now);
}

/** 蓝：武装"下一次接球粘住"。真正的粘发生在 bounceOffPaddle 里。 */
function castStick(room, slot) {
  return skillBehavior.castStick(room, slot);
}

/** 黑：在己方靠中间的那半区随机开一个黑洞。 */
function castBlackhole(room, slot, now) {
  return skillBehavior.castBlackhole(room, slot, now);
}

/** 紫：开启 10 秒的"乱弹"状态。 */
function castChaos(room, slot, now) {
  return skillBehavior.castChaos(room, slot, now);
}

/** 白：给对方挂一层"下一次吃到的道具无效"（不叠加，也不消耗冷却）。 */
function castBlock(room, slot) {
  return skillBehavior.castBlock(room, slot);
}

/** 橙：把对方整队的拍子速度上限降到 SLOW_MUL。 */
function castSlow(room, slot, now) {
  return skillBehavior.castSlow(room, slot, now);
}

/**
 * 放技能。返回 true 表示这次真的放出去了（冷却被消耗）。
 * 门禁：没开局 / 暂停中 / 非 playing 阶段 / 无技能 / 冷却中 / 红色已蓄力。
 */
function castSkill(room, slot, now) {
  return skillBehavior.castSkill(room, slot, now);
}

/**
 * 某个槽位上拍子的半长（会被道具缩放）。
 * ★ 参数是**槽位**下标，不是队伍 —— 内部再映射到队伍去取倍率。
 *   碰撞判定、活动范围、反弹角度计算都必须走这个函数，
 *   只要有一处还在用常量 PADDLE_H / 2，就会出现"看着打到了却没弹回来"。
 */
function paddleHalf(room, slot) {
  const team = room.slots[slot] ? room.slots[slot].team : slot;
  return (PADDLE_H * room.paddleMul[team]) / 2;
}

/**
 * 应用一个道具。who / foe 都是**队伍**号 —— coop 里左边两个拍子属于同一队，
 * 所以"加长自己的拍子"会同时加长它的上半场和下半场两个拍子。
 * 实现位于 server/powerups.js。
 */
function applyPowerup(room, who, type, now) {
  powerupBehavior.applyPowerup(room, who, type, now);
}

/**
 * 分裂球：**原球一点都不动**（轨迹、速度、方向全不变），额外多出一个球。
 *
 * 新球的初速度 = 分裂瞬间原球速度的一半（见 SPLIT_SPEED_MUL）。
 *   · 只有一半速，两个球会明显错开：快的先到，慢的后到，
 *     变成"先应付这个再补那个"，而不是两个同时砸到脸上；
 *   · 方向取原球竖直方向的**镜像**（vy 取反）：两球立刻朝上下分开，
 *     视觉上就是一个"人"字，一眼能看出是分裂出来的。
 *     vy 接近 0 时镜像等于原样，两球会重叠在一起飞 —— 所以这种时候改成
 *     按固定角度偏转，保证它们一定分得开。
 *
 * 到上限就不分（见 MAX_BALLS）：再分下去就是弹幕了。
 *
 * 服务端兼容入口保留原函数签名，实现位于 server/physics.js。
 */
function splitBall(room) {
  return physics.splitBall(room);
}

/**
 * 由两个计时器**算出**拍子倍率。抽成独立函数是为了让 applyPowerup 之后
 * 立刻就能拿到正确的倍率 —— 否则会有一 tick 的窗口里"效果生效了但拍子还是旧长度"。
 * 实现位于 server/powerups.js。
 */
function refreshPaddleMul(room, now) {
  powerupBehavior.refreshPaddleMul(room, now);
}

/**
 * 效果到期复位。必须每 tick 调，否则道具会永久生效。
 * 实现位于 server/effects.js —— 道具侧与技能侧的效果都在这一趟里清，
 * 拆成两处写的话迟早会漏掉一个。
 */
function trackMods(room, now) {
  effectClock.trackMods(room, now);
}

/**
 * 某一队**当前看到的球**有多不透明（1 = 完全看得见，0 = 完全看不见）。
 * 三段曲线（淡出 / 全隐 / 淡入）在服务端算好后下发，客户端不再实现一遍。
 * 实现位于 server/powerups.js。
 */
function invisAlpha(room, team, now) {
  return powerupBehavior.invisAlpha(room, team, now);
}

/** 道具的生成 / 过期 / 被球碰到。只在 playing 阶段调用 */
/**
 * 生成一个道具。位置落在中段区域，且与场上其它道具互相错开。
 * 实现位于 server/powerups.js。
 */
function spawnPowerup(room, now) {
  return powerupBehavior.spawnPowerup(room, now);
}

/**
 * 道具的生成 / 过期 / 被球碰到。只在 playing 阶段调用。
 * 实现位于 server/powerups.js。
 */
function stepPowerup(room, now) {
  powerupBehavior.stepPowerup(room, now);
}

/**
 * 球物理在这里装配。所有常量、纯房间辅助函数与结算回调都显式注入，
 * server/physics.js 不反向 require 本文件。下面那些同名函数只是兼容入口。
 */
const physics = createPhysics({
  BALL_R,
  BALL_SPEED_START,
  BALL_SPEED_MAX,
  SPEEDUP_PER_HIT,
  MAX_BOUNCE_ANGLE,
  PADDLE_W,
  PADDLE_MARGIN,
  MAX_BALLS,
  SPLIT_SPEED_MUL,
  MIN_VX_RATIO,
  UNSTICK_ANG_MIN,
  UNSTICK_ANG_MAX,
  UNSTICK_MIN_SPEED,
  WIND_ACC,
  BOOST_SPEED,
  STICK_MS,
  CHAOS_HALF_DEG,
  HOLE_R,
  HOLE_HALF_DEG,
  COUNTDOWN_MS,
  clamp,
  isPhantom,
  paddleHalf,
  recordMissApproach,
  afterGoal,
});

/**
 * 重新发球：清掉隐形与最后击球方，回到倒计时阶段。
 * 兼容入口 —— 实现位于 server/physics.js。
 */
function resetBall(room, serveTo) {
  physics.resetBall(room, serveTo);
}

/**
 * 发球：把中线上的球按接收方方向打出去，并把阶段切到 playing。
 * 兼容入口 —— 实现位于 server/physics.js。
 */
function launchBall(room) {
  physics.launchBall(room);
}

/**
 * 开新一局：清零比分、重排拍子、清掉本局的道具与技能效果，然后重新发球。
 * 实现位于 server/match.js。
 */
function startMatch(room) {
  match.startMatch(room);
}

/**
 * 球拍反弹：出射角由"打中拍子哪个位置"决定，中间平着飞，边缘角度大。
 * 兼容入口 —— 实现与理由注释位于 server/physics.js。
 */
function bounceOffPaddle(room, slot, b) {
  physics.bounceOffPaddle(room, slot, b);
}

/**
 * 弧线球：把速度矢量旋转一个小角度（正交变换，速率严格不变）。
 * 兼容入口 —— 实现与理由注释位于 server/physics.js。
 */
function spinBall(room, b, dt) {
  physics.spinBall(room, b, dt);
}

/** 球是否撞上了贴在某条边上的某个拍子。撞到就弹一次并返回 true。 */
function hitEdgePaddles(room, b, edge) {
  return physics.hitEdgePaddles(room, b, edge);
}

/**
 * 球与球的碰撞：等质量完全弹性碰撞（等质量下交换沿连心线方向的速度分量）。
 * 兼容入口 —— 实现与推导注释位于 server/physics.js。
 */
function resolveBallCollisions(room) {
  physics.resolveBallCollisions(room);
}

/**
 * 防"竖直卡死"：球的横向速度掉到 0 附近时，给它重新瞄一个方向。
 * 兼容入口 —— 实现与原因分析位于 server/physics.js。
 *
 * @param {object} b 球
 * @returns {boolean} 真的重瞄了才返回 true（调用方据此统计）
 */
function unstickBall(b) {
  return physics.unstickBall(b);
}

/**
 * 对场上每个球做一次防卡死检查，返回被重瞄的球数。
 * ★ 必须在 resolveBallCollisions **之后**调用。
 */
function unstickBalls(room) {
  return physics.unstickBalls(room);
}

/**
 * 单个球的墙 / 拍子 / 出界判定。出界时会把球从场上移除并结算比分。
 * 兼容入口 —— 实现与注释位于 server/physics.js。
 */
function stepOneBall(room, b) {
  physics.stepOneBall(room, b);
}

/**
 * 把一个球从场上拿走（出界 / 到寿）。**只给幻影球用** —— 真球的移除在 afterGoal 里，
 * 那条路径还要顺带结算比分。
 * 兼容入口 —— 实现与死锁说明位于 server/physics.js。
 */
function removeBall(room, b) {
  physics.removeBall(room, b);
}

/**
 * 黑（黑洞）：球碰到自己开的洞就"穿"到对面靠中间的半区随机位置。
 * 兼容入口 —— 实现与规则要点位于 server/physics.js。
 */
function checkBlackhole(room, b) {
  return physics.checkBlackhole(room, b);
}

/**
 * 推进场上**所有**球。
 * 顺序：先全部旋转+位移，再两两解球球碰撞，最后逐球做墙/拍子/出界。
 * ★ 碰撞必须放在全部位移之后：否则先动的球会拿"别人的旧位置"去判定，
 *   两个球会像穿过去一样互相漏掉。
 * 兼容入口 —— 实现与注释位于 server/physics.js。
 */
function stepBalls(room, dt) {
  physics.stepBalls(room, dt);
}

/**
 * 护盾：球马上要出界时消耗一层，把球弹回场内。
 * 参数是**队伍**号 —— coop 里护盾属于左边这一整队，两个人共享。
 * 返回 true 表示这次被挡下了，调用方不该再判失分。
 * 兼容入口 —— 实现与注释位于 server/physics.js。
 */
function useShield(room, side, ball) {
  return physics.useShield(room, side, ball);
}

/**
 * 乒乓球胜负判定：先到 11 分、且净胜 2 分。
 * 服务端兼容入口保留原函数签名，纯规则实现位于 server/rules.js。
 */
function isWin(my, foe) {
  return evaluateWin(my, foe, WIN_SCORE, WIN_MARGIN);
}

function recordMissApproach(room, ball, edge, faceX) {
  const paddles = [];
  let closest = null;
  for (let slot = 0; slot < room.N; slot += 1) {
    if (room.slots[slot].edge !== edge) continue;
    const half = paddleHalf(room, slot);
    const centerDelta = Math.abs(ball.y - room.paddles[slot]);
    const margin = centerDelta - half - BALL_R;
    const paddle = {
      slot,
      team: room.slots[slot].team,
      y: r1(room.paddles[slot]),
      half: r1(half),
      centerDelta: r1(centerDelta),
      catchMargin: r1(margin),
    };
    paddles.push(paddle);
    if (!closest || margin < closest.catchMargin) closest = paddle;
  }
  if (!closest) return;
  const previous = room.lastMissApproach[ball.id];
  if (previous && previous.edge === edge && previous.closest.catchMargin <= closest.catchMargin) return;
  room.lastMissApproach[ball.id] = {
    ballId: ball.id,
    tick: room.tick,
    substep: room.substep,
    serverTime: room.serverTime,
    edge,
    faceX,
    ball: { x: r1(ball.x), y: r1(ball.y), vx: r1(ball.vx), vy: r1(ball.vy) },
    paddles,
    closest,
  };
}

/**
 * 记录一次失分时服务端实际使用的球 / 拍子位置。
 * @param {object} room 当前房间
 * @param {number} concededBy 失分队伍
 * @param {object} ball 出界球
 * @returns {void}
 */
/**
 * 记录一次失分的取证信息。实现位于 server/match.js。
 */
function recordMiss(room, concededBy, ball) {
  match.recordMiss(room, concededBy, ball);
}

/**
 * 结算一个进球：计分、判胜负、必要时重新发球。
 * 实现位于 server/match.js。
 */
function afterGoal(room, concededBy, ball) {
  match.afterGoal(room, concededBy, ball);
}

/**
 * 挑出"最快就要打到某条边"的那个球。多球时 AI 只可能处理最紧急的一个 ——
 * 同时照顾两个球是做不到的，硬要平均分配反而两个都接不到。
 * 服务端兼容入口保留原函数签名，AI 实现位于 server/bot.js。
 */
function mostUrgentBall(room, goingRight, list) {
  return botBehavior.mostUrgentBall(room, goingRight, list);
}

/**
 * 预测球到达某条竖线时的 y 坐标，含上下墙反射。
 * 服务端兼容入口保留原函数签名，纯计算实现位于 server/rules.js。
 */
function predictY(room, b, faceX) {
  return calculatePredictY(room, b, faceX, BALL_R);
}

/**
 * Extracted AI behavior is assembled here with explicit dependencies. The AI
 * module never imports this entry point; all live calls go through the wrapper
 * functions below so the public API and call sites stay unchanged.
 */
const botBehavior = createBotBehavior({
  BOT_PRESETS,
  BALL_R,
  PADDLE_MARGIN,
  PADDLE_W,
  PADDLE_SPEED,
  PHANTOM_BOT_SWAY,
  SUB_DT,
  clamp,
  isPhantom,
  paddleHalf,
  predictY,
});

/**
 * Update an AI player's remembered vision and target.
 *
 * @param {object} room Current room state.
 * @param {number} slot AI paddle slot index.
 * @param {number} now Current server timestamp.
 * @returns {void}
 */
function botPerceive(room, slot, now) {
  botBehavior.botPerceive(room, slot, now);
}

/**
 * Steer an AI paddle toward its current target.
 *
 * @param {object} room Current room state.
 * @param {number} slot AI paddle slot index.
 * @returns {void}
 */
function botSteer(room, slot) {
  botBehavior.botSteer(room, slot);
}

function stepPaddles(room, dt) {
  const now = room.serverTime;
  for (let i = 0; i < room.N; i += 1) {
    const p = room.players[i];
    if (!isPresent(p)) continue;
    if (isBot(p)) {
      botPerceive(room, i, now);   // 感知：限频，这是反应时间
      botSteer(room, i);           // 操控：必须每 tick 调，否则拍子会在目标两侧摆
    }
    // 冻结按队生效：coop 里冻的是整队，左边两个拍子会一起停
    if (room.freezeUntil[room.slots[i].team] > now) continue;
    const dir = p.dir || 0;
    if (dir === 0) continue;
    const half = paddleHalf(room, i);   // 拍子变长后，上下活动范围要跟着收
    const [yMin, yMax] = room.slots[i].span;
    const lo = yMin + half;
    const hi = yMax - half;
    if (hi < lo) {
      room.paddles[i] = (yMin + yMax) / 2;
      continue;
    }
    const speed = PADDLE_SPEED * (p.speedMul || 1)
      // ★ 橙（减速）：作用在**速度上限**上，不是"给一个负加速度"（需求原话就是"上限降低"）。
      //   这一行是它唯一的生效点，本地预测那边还有一条对应的（客户端也得跟着慢，
      //   不然自己看自己没慢、只有对手那边慢，像在瞬移）。
      * (room.slowUntil[room.slots[i].team] > now ? SLOW_MUL : 1);
    room.paddles[i] = clamp(room.paddles[i] + dir * speed * dt, lo, hi);
  }
}

/**
 * 推进一个房间一个 tick：冻结处理、开局、阶段状态机与模拟子步。
 * 实现位于 server/match.js。
 */
function stepRoom(room, now) {
  match.stepRoom(room, now);
}

// 只给探针取证用。效果的画面归谁：
//   冰冻是"冻对方"，所以想冻 0 号位就得记在 1 号位头上；
//   护盾和双倍是自益，记在 0 号位头上；
//   隐形是"让对面看不见"，所以记在 1 号位头上 → 被隐形的是 0 号位，
//   也就是人机局里的真人 —— 探针才能从"玩家这一侧"验到渐变确实发生了。
const DEBUG_FX_CYCLE_MS = 3000;
const DEBUG_FX_SEQ = [[1, 3], [0, 4], [0, 5], [1, 8]];
function debugShowcaseFx(room, now) {
  const slot = Math.floor(now / DEBUG_FX_CYCLE_MS) % DEBUG_FX_SEQ.length;
  if (room.fxSlot === slot) return;
  room.fxSlot = slot;
  applyPowerup(room, DEBUG_FX_SEQ[slot][0], DEBUG_FX_SEQ[slot][1], now);
}

function broadcastState(room) {
  // ★ 局间选拍子（"每结束一局都能重新选拍子"）。
  //   房间进过一次 over 之后，**下一个非 over 阶段**就是"新一局刚开始"。
  //   在这两个时刻之间 room.phase 一直是 'over'，所以"当前是 over"本身不够 ——
  //   那样会把整段结算时间都变成可改皮肤的窗口；而 over 期间场上还躺着上一局的残局，
  //   这时候换皮肤，玩家看到的是"结算画面里我的拍子变色了"。
  //   只有真的翻开新一局（startMatch 把 phase 设成 countdown）才算窗口打开，
  //   而窗口在**球真的发出去**（phase 变成 playing）时关闭 —— 这样没人能在球飞的时候换拍子。
  //   ★ 顺序不能反：**先**关窗、**再**算本次要下发的值。
  //     反过来的话，"进入 playing 的那一帧"会先报一个 1 再关 —— 客户端收到 1 就会弹面板，
  //     而那一刻球已经在飞了，等于窗口形同虚设（测试里就是这么抓到它的）。
  if (room.phase === 'playing') room.reselectPending = false;
  const canReselect = room.reselectPending && room.phase !== 'over';
  // 对外只暴露四种阶段：缺人或没开过局时一律显示 waiting
  const phase = room.paused || !room.started ? 'waiting' : room.phase;
  const botSlot = room.N - 1;
  // 各队幻影球剩余秒数（全量）。下发时按队抹掉对方那一格，见 payloadFor。
  const pxAll = [0, 1].map((t) => {
    const ph = room.balls.find((b) => isPhantom(b) && b.phantom === t);
    return ph && ph.phantomUntil > room.serverTime
      ? r2((ph.phantomUntil - room.serverTime) / 1000)
      : 0;
  });
  const payload = {
    t: 'state',
    st: room.serverTime,
    ph: phase,
    // 真人主动暂停（1 = 暂停中）。★ 必须**单独一个字段**，不能并进 ph：
    //   并进去客户端就会走 waiting 分支，而那条分支压根不画球 —— 一按暂停球就消失了。
    //   这里报的是**真正生效**的值（第一局还没开始时那个暂停是不算数的，见 stepRoom）。
    up: room.started && room.userPaused ? 1 : 0,
    // 是谁按的暂停（槽位号，-1 = 没在暂停）。客户端据此说"你按的 / 对手按的"。
    pb: room.started && room.userPaused ? room.pausedBy : -1,
    cd: phase === 'countdown' ? Math.max(0, room.phaseEndsAt - room.serverTime) : 0,
    // 场地尺寸随包下发 —— 各模式不一样，客户端按它设画布宽高比并做等比缩放
    wh: [room.W, room.H],
    // 拍子位置数组：经典模式 2 个，coop 3 个（左上 / 左下 / 右）
    p: room.paddles.map(r1),
    // 场上球：数组，每项 [id, x, y]。id 用来做跨快照的身份匹配
    // （分裂球会让场上同时有多个球，下标不能当身份）
    // ★ 这一项**按队过滤**，见函数末尾那句 —— 不在这个对象字面量里。
    bs: null,
    s: room.score,
    mi: room.matchId,
    mr: phase === 'over' ? room.missLog : null,
    k: room.tick,
    wn: room.winner,
    pr: room.players.map((p) => (isPresent(p) ? 1 : 0)),
    // 模式。md 决定布局与文案，solo/coop 是给老客户端与探针留的兼容字段
    md: room.mode,
    solo: room.solo ? 1 : 0,
    coop: room.coop ? 1 : 0,
    bl: room.botLevel,
    // 场上道具：空数组 = 没有；否则是 [[x, y, 类型], ...]，**可以同时有多个**
    us: room.powerups.map((u) => [r1(u.x), r1(u.y), u.type]),
    // 拍子长度倍率 —— 客户端必须按它画拍子，否则视觉长度和实际判定对不上
    pm: [r2(room.paddleMul[0]), r2(room.paddleMul[1])],
    // 冰冻剩余秒数（0 = 没被冻）。客户端据此画冰霜并把拍子变灰。按队生效
    fz: [
      Math.max(0, r1((room.freezeUntil[0] - room.serverTime) / 1000)),
      Math.max(0, r1((room.freezeUntil[1] - room.serverTime) / 1000)),
    ],
    // 护盾剩余层数（次数制，不是时间制）
    sh: [room.shield[0], room.shield[1]],
    // 双倍得分是否生效
    db: [
      room.doubleUntil[0] > room.serverTime ? 1 : 0,
      room.doubleUntil[1] > room.serverTime ? 1 : 0,
    ],
    // 隐形球：各队**看不见球**还剩几秒（0 = 没在隐形）。
    //   用途是给被隐形的人一句"还剩多久"的提示 —— 不给的话他会以为是自己掉线了。
    iv: [
      Math.max(0, r2((room.invisUntil[0] - room.serverTime) / 1000)),
      Math.max(0, r2((room.invisUntil[1] - room.serverTime) / 1000)),
    ],
    // 隐形球：各队**当前看到的球**的不透明度（1 = 看得见，0 = 完全看不见）。
    //   ★ 曲线由服务端算好（见 invisAlpha），客户端就照这个值画 —— 渐变只有一份实现。
    ia: [r2(invisAlpha(room, 0, room.serverTime)), r2(invisAlpha(room, 1, room.serverTime))],
    // 弧线球：非 0 表示球正在拐弯，值是角速度（带符号 = 拐弯方向）。
    // 客户端拿它画弯曲尾迹 —— 不画的话玩家只会觉得"球好像有点飘"，说不出为什么
    cv: room.curveUntil > room.serverTime ? r2(room.curveSpin) : 0,
    // 本轮的离散事件（击球 / 得分 / 道具 / 结束），供前端触发音效
    ev: room.events,
    // ---- 皮肤与技能 ----
    // 每个槽位选的皮肤（0 灰 / 1 青 / 2 黄 / 3 红）。客户端据此给拍子上色，
    //   并决定自己那个技能按钮长什么样 —— 所以**所有**槽位都要下发，不只自己那个。
    sk: room.skins,
    // 技能冷却剩余秒数（按槽位，0 = 可以放）
    sc: room.skins.map((_, i) => Math.max(0, r1((room.skillReadyAt[i] - room.serverTime) / 1000))),
    // 超高速是否已经蓄好力（按槽位，1 = 下一次击球会是超高速）
    bo: room.boostArmed.map((v) => (v ? 1 : 0)),
    // 正在刮的风：[[dx, dy, 剩余秒], ...]。dx/dy 是**单位向量**，
    //   客户端拿它画气流；服务端才是真正施力的那一方，客户端只负责表现。
    wf: room.winds.map((w) => [r2(w.dx), r2(w.dy), Math.max(0, r2((w.until - room.serverTime) / 1000))]),
    // ---- 第 11 轮新增技能的对外字段 ----
    // 蓝：哪几个槽位已经武装了"粘球"（1 = 下一次击球会把球粘住）。**公开**——
    //   对手看得见"对面举着粘球"，才有反应空间；这跟幻影球的私有字段不是一回事。
    sa: room.stickArmed.map((v) => (v ? 1 : 0)),
    // 蓝：正在被粘住的球（[x, y] 或 0）。客户端据此把球画在拍子上 ——
    //   ★ 必须**单独下发**，不能只靠 bs 里的坐标：粘住的球坐标由服务端每 tick
    //   跟着拍子算，客户端平滑一下就会"飘"在拍子旁边，看起来没粘住。
    //   下发这个标记让客户端把它**硬贴**在拍子上（绕过平滑）。
    sk2: (() => {
      const s = room.balls.find((b) => b.stuck);
      return s ? [r1(s.x), r1(s.y), s.stuck.slot] : 0;
    })(),
    // 黑：场上所有黑洞 [[x, y, 剩余秒, 开洞方队伍], ...]（可以同时有多个）
    hh: room.holes.map((h) => [r1(h.x), r1(h.y), Math.max(0, r2((h.until - room.serverTime) / 1000)), h.team]),
    // 紫：各槽位"乱弹"还剩几秒（0 = 没生效）
    ch: room.chaosUntil.map((t) => Math.max(0, r1((t - room.serverTime) / 1000))),
    // 白：各队还有几层"道具封锁"（对手吃到道具时消耗）。
    //   ★ 只给**施放方**看自己挂着的那一格：封锁是"我埋的雷"，
    //   被封锁方不该被提前告知（否则他会刻意躲道具，技能就废了一半）。
    //   所以和 px 一样，在 payloadFor 里按队抹掉对方那一格。
    bk: room.blockCharges.slice(),
    // 橙：各队拍子被减速还剩几秒（0 = 没生效）
    sl: room.slowUntil.map((t) => Math.max(0, r1((t - room.serverTime) / 1000))),
    // 局间"可以重新选拍子"的窗口（1 = 开着）。客户端据此弹选拍子面板。
    //   ★ 由服务端说了算，不是客户端自己按 phase 猜 —— 窗口的开与关都挂在
    //   "服务端真的翻了新一局/真的发了球"这两个事实上（见本函数开头那段注释）。
    rsel: canReselect ? 1 : 0,
    // 幻影球还剩几秒（按**队**，0 = 没有）。只给**释放方**当作"还在生效"的反馈 ——
    //   对手那边什么都不显示，他连场上有两个球这件事都不该被提示。
    //   ★ 这里先算**全量**，真正下发前在 payloadFor 里按队把它抹掉（见那一段的注释）。
    //     不能就地改 payload.px：第二次 stringify 会拿到第一次改过的数组。
    px: pxAll,
    // 调试用：只在显式开了环境变量时输出 AI 的内部决策（方向 / 目标 / 瞄准误差）。
    // 默认关闭 —— 线上不该因为这个多传字段。
    bt: DEBUG_BOT && isBot(room.players[botSlot])
      ? [
        room.players[botSlot].dir || 0,
        r1(room.players[botSlot].targetY || 0),
        r2(room.players[botSlot].aimErr || 0),
      ]
      : 0,
  };

  // ★ 球列表**按队分别下发**，这是整套幻影球的关键。
  //   幻影球的全部意义就是"释放方看不见它"，而它混在 bs 里、由一个字段标出归属的话，
  //   等于把答案直接写进了对方的包里 —— 改一改客户端就全露馅了。
  //   隐身球当初可以走客户端过滤（见 index.html 里 ballVis 的注释），因为它骗的是
  //   "反应"；幻影球骗的是"信息"，被看穿就等于技能不存在，所以这里宁可多拼一份 JSON。
  //   最多两个队，缓存一下就是每帧最多两次 stringify。
  const cache = [null, null];
  const payloadFor = (team) => {
    if (cache[team]) return cache[team];
    payload.bs = room.balls
      .filter((b) => !(isPhantom(b) && b.phantom === team))
      .map((b) => [b.id, r1(b.x), r1(b.y)]);
    // ★ px 也按队过滤，和 bs 同一个理由。
    //   原本是"整个数组原样下发、客户端只看自己那一格" —— 那样等于把"对手正在放幻影"
    //   写进了对手的包里：他一看到自己这格是 0、另一格非 0，就确知场上有幻影。
    //   bs 那一段刚说过"改一改客户端就露馅了"，同一个理由必须一致适用，
    //   不能只在 bs 上讲究、在 px 上偷懒。
    //   客户端本来就只读自己那一格（index.html 里 `view.phantom[mtp]`），过滤掉不影响它。
    payload.px = pxAll.map((v, t) => (t === team ? v : 0));
    // ★ bk（白·道具封锁）同理按队过滤：封锁是"我埋在对手脚下的雷"，
    //   被封锁方不该在快照里看到"我这一格有几层"—— 那等于提前告诉他"下个道具无效"，
    //   他会刻意躲开道具，技能就废了一半。只让**施放方**看到自己挂了几层。
    payload.bk = room.blockCharges.map((v, t) => (t === team ? v : 0));
    cache[team] = JSON.stringify(payload);
    return cache[team];
  };
  for (let i = 0; i < room.N; i += 1) {
    const p = room.players[i];
    if (p && p.ws && p.ws.readyState === 1) p.ws.send(payloadFor(room.slots[i].team));
  }
  // ★ 事件必须"发完再清"。主循环一轮可能推进多个 tick 才广播一次，
  //   若在 stepRoom 开头就清空，前面那几个 tick 的事件会被吞掉。
  room.events.length = 0;
}

// ---------- 入座 / 离座 ----------
// 座位与 token 的规则在 server/match.js；ws 只作为玩家记录上的引用传进去，
// 模块自己不 send、不认识 WebSocket。
/**
 * 把一个真人连接放到某个槽位上（皮肤在入座那一刻定下）。
 * 实现位于 server/match.js。
 */
function seatPlayer(room, ws, side, token, skin) {
  match.seatPlayer(room, ws, side, token, skin);
}

/**
 * 挑一个可以坐下来的槽位：优先空位，其次顶替掉线超时的真人位（绝不顶 AI）。
 * 实现位于 server/match.js。
 */
function findSeat(room) {
  return match.findSeat(room);
}

/** 发给客户端的入座回执。三种模式共用，客户端靠 mode 决定自己的布局与文案 */
function joinedPayload(room, code, side, token, host) {
  return {
    t: 'joined',
    code,
    side,
    token,
    host,
    mode: room.mode,
    solo: room.solo ? 1 : 0,
    coop: room.coop ? 1 : 0,
    level: room.botLevel,
    botName: room.botLevel >= 0 ? BOT_PRESETS[room.botLevel].name : '',
    wh: [room.W, room.H],
    n: room.N,
  };
}

/**
 * 建房。房间生命周期在 server/match.js，这里只负责取房间号、
 * 登记房间、座位，然后把 joined 回执交给连接管理发出去。
 */
function handleCreate(ws, mode, level, skin) {
  if (ws.player) return send(ws, { t: 'error', msg: '你已经在房间里了' });
  const md = normMode(mode);
  const code = newCode();
  const room = createRoom(code, md, level);
  rooms.set(code, room);
  const token = newToken();
  seatPlayer(room, ws, 0, token, skin);
  send(ws, joinedPayload(room, code, 0, token, true));
  console.log(`[room] ${code} created mode=${md}${md === 'duel' ? '' : ` level=${room.botLevel}`}`);
}

function handleJoin(ws, code, skin) {
  if (ws.player) return send(ws, { t: 'error', msg: '你已经在房间里了' });
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'error', msg: '房间不存在或已过期' });
  // 一对一的人机房只有一个真人位，不对外开放。
  // ★ coop 房不一样 —— 它有两个真人位，第二位玩家就是靠 join 进来的。
  if (room.mode === 'solo') return send(ws, { t: 'error', msg: '这是人机对战的房间，不能加入' });
  const side = findSeat(room);
  if (side < 0) return send(ws, { t: 'error', msg: '房间已满' });
  const token = newToken();
  seatPlayer(room, ws, side, token, skin);
  send(ws, joinedPayload(room, code, side, token, false));
  console.log(`[room] ${code} joined as slot ${side} (mode=${room.mode})`);
}

function handleRejoin(ws, code, token) {
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'error', msg: '房间已不存在' });
  const side = match.rejoinPlayer(room, ws, token);
  if (side >= 0) {
    send(ws, { ...joinedPayload(room, code, side, token, false), t: 'rejoined' });
    console.log(`[room] ${code} rejoined slot ${side}`);
    return;
  }
  send(ws, { t: 'error', msg: '座位已失效，请重新加入' });
}

function handleInput(ws, dir) {
  if (!ws.player) return;
  const room = rooms.get(ws.player.code);
  if (!room) return;
  const p = room.players[ws.player.side];
  if (!p || p.token !== ws.player.token) return;
  p.dir = dir === -1 || dir === 1 ? dir : 0;
  room.lastActivity = Date.now();
}

/**
 * 玩家按下「暂停 / 继续」。
 * ★ 这里刻意**不做**"必须另一边也同意"的判断 —— 需求就是"每个人点都会生效"，
 *   所以只要还坐在这个房间里（token 没换）就能按。代价是两个人对着按会来回切，
 *   那是这条规则本身的含义（谁按谁说了算），不是 bug。
 */
function handlePause(ws) {
  if (!ws.player) return;
  const room = rooms.get(ws.player.code);
  if (!room) return;
  const p = room.players[ws.player.side];
  // 座位可能已经易主（掉线超时被顶替），别让旧连接还能操作新玩家的房间
  if (!p || p.token !== ws.player.token) return;
  togglePause(room, ws.player.side);
  room.lastActivity = Date.now();
}

/**
 * 玩家按下「技能」。语义只有一条：**放一下**，冷却与能不能放全由服务端说了算。
 * 客户端那边按钮只是"上报意图"，它显示的字和冷却环都跟着快照走。
 *
 * ★ 和 handlePause 一样要校验 token：掉线超时后座位可能已经易主，
 *   旧连接不该还能替新房主放技能。
 */
function handleSkill(ws) {
  if (!ws.player) return;
  const room = rooms.get(ws.player.code);
  if (!room) return;
  const p = room.players[ws.player.side];
  if (!p || p.token !== ws.player.token) return;
  castSkill(room, ws.player.side, Date.now());
  room.lastActivity = Date.now();
}

/**
 * 玩家在**局间**换了拍子（皮肤）。
 *
 * ★ 与 seatPlayer 的分工：seatPlayer 管"入座那一刻选什么"，这个管"每一局之间改主意"。
 *   需求是"无论什么模式，每结束一局都要可以重新选拍子"，所以改皮肤**不是**入座特权。
 * ★ 三道闸门，缺一不可：
 *   ① token 匹配（掉线后座位可能已经易主，旧连接不能替新房主换皮肤）；
 *   ② 座位必须已经存在（`!room.players[side]` 时不去创建 —— 顺手创建等于绕过 findSeat
 *      与真人/AI 座位规则，会凭空多出一个没有连接管理的座位）；
 *   ③ 只在局间窗口里生效（`pickSkin` 里有判断，不在窗口里就静默丢弃）。
 *   ③ 是"服务端权威"的关键：客户端什么时候弹面板是它自己的事，能不能改由这里说了算。
 */
function handleSkin(ws, skin) {
  if (!ws.player) return;
  const room = rooms.get(ws.player.code);
  if (!room) return;
  const side = ws.player.side;
  const p = room.players[side];
  if (!p || p.token !== ws.player.token) return;
  pickSkin(room, side, skin);
  room.lastActivity = Date.now();
}

function handleClose(ws) {
  if (!ws.player) return;
  const room = rooms.get(ws.player.code);
  if (!room) return;
  match.releasePlayer(room, ws, ws.player.side, ws.player.token);
}

// ---------- HTTP：静态文件 + 健康检查 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  // 音频。缺了 .mp3 就是 application/octet-stream，有的浏览器会直接拒播
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

const startedAt = Date.now();

const server = http.createServer((req, res) => {
  const rawPath = (req.url || '/').split('?')[0];
  const urlPath = decodeURIComponent(rawPath);

  if (urlPath === '/healthz') {
    const body = JSON.stringify({
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rooms: rooms.size,
      clients: wss ? wss.clients.size : 0,
      tickHz: TICK_HZ,
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(body);
  }

  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }

    // ★ 必须支持 Range：Chromium 播 mp3 第一发请求就带 Range: bytes=0-。
    //   如果一律回 200 + 全量，小文件看不出来，但 7MB 的 BGM 每次循环回绕、
    //   每次拖动进度条都要重新下载一整首。
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (Number.isNaN(start) || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    // 用流而不是 readFile：没必要为了发一个 7MB 的文件先把它整个读进内存
    fs.createReadStream(full).pipe(res);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.player = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'ping':
        send(ws, { t: 'pong', ts: m.ts, st: Date.now() });
        break;
      case 'create':
        // mode 是新写法（duel / solo / coop）；solo 布尔是给还没刷新的老页面留的
        handleCreate(ws, m.mode !== undefined ? m.mode : !!m.solo,
          Number(m.level) || 0, m.skin);
        break;
      case 'join':
        handleJoin(ws, String(m.code || '').trim().toUpperCase(), m.skin);
        break;
      case 'skin':
        // 局间换拍子。**不是**入座消息：只改 skin，不动座位、不动连接身份。
        handleSkin(ws, m.skin);
        break;
      case 'rejoin':
        handleRejoin(ws, String(m.code || '').trim().toUpperCase(), String(m.token || ''));
        break;
      case 'input':
        handleInput(ws, Number(m.dir));
        break;
      case 'skill':
        // 和 pause 一样**没有**参数：语义是"放一下"。
        // 冷却够不够、这一局有没有在跑、这块拍子到底有没有技能，全在服务端判。
        handleSkill(ws);
        break;
      case 'pause':
        // 故意**没有** on/off 参数：语义是"按了一下"（切换），与"当前是不是暂停"无关。
        // 做成显式状态的话，对面已经暂停时你再按一下就成了空操作 —— 而需求是
        // "每个人点都会生效"，所以走切换。客户端的状态一律以服务端快照为准。
        handlePause(ws);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

// 离线测试只加载纯逻辑：既不监听端口，也不启动任何常驻定时器。
if (process.env.PONG_NO_LISTEN !== '1') {
  // 保活：既是探针要观察的点，也防止中间设备把空闲连接回收掉
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 25000);

  // ---------- 主循环 ----------
  // 为什么不用 setInterval(fn, 1000/30)：Windows 的定时器粒度约 15.6ms，
  // 33.33ms 会被系统向上取整成 46.8ms，实测只有 21.5Hz —— 平台不同球速就不一样。
  // 改成「高频轮询 + 固定步长累加器」：轮询只管看看欠了多少时间，模拟始终按
  // 33.33ms 的固定步长推进，长期平均频率因此与操作系统无关。
  const STEP_MS = 1000 / TICK_HZ;
  let timeDebt = 0;
  let lastPump = Date.now();

  setInterval(() => {
    const now = Date.now();
    timeDebt += now - lastPump;
    lastPump = now;

    // 进程被卡住（GC、宿主机抢占）后不要一次性追补几十个 tick，否则会瞬移
    if (timeDebt > 250) timeDebt = 250;

    let stepped = false;
    while (timeDebt >= STEP_MS) {
      for (const room of rooms.values()) stepRoom(room, now);
      timeDebt -= STEP_MS;
      stepped = true;
    }

    // 一个轮次里补了多个 tick 也只广播一次，避免客户端收到间隔忽大忽小的快照
    if (stepped) {
      for (const room of rooms.values()) broadcastState(room);
    }
  }, 8);

  // 回收空房间
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (!anyAlive(room) && now - room.lastActivity > ROOM_IDLE_MS) {
        rooms.delete(code);
        console.log(`[room] ${code} reclaimed`);
      }
    }
}, 30000);

  server.listen(PORT, HOST, () => {
    console.log(`pong-online listening on http://${HOST}:${PORT}`);
  });
}

// 供离线单元测试使用的内部逻辑与常量。
// 有了它，"10:10 之后到底什么时候结束"这种边界就能几毫秒验证完，
// 不必真的把一局打到 12:10。
module.exports = {
  isWin,
  predictY,
  applyPowerup,
  trackMods,
  useShield,
  afterGoal,
  createRoom,
  makeBot,
  isBot,
  isPresent,
  paddleHalf,
  buildSlots,
  normMode,
  stepBalls,
  stepOneBall,
  resolveBallCollisions,
  // 暂停：切换函数 + 挂钟后移。两个都要导出，否则离线测不了
  //（漏导出不会报错，只会让断言恒真/恒假 —— 见 test-rules.js 第 0 节）
  togglePause,
  shiftDeadlines,
  stepRoom,
  COUNTDOWN_MS,
  OVER_HOLD_MS,
  // 皮肤与技能。同上，断言要引用的常量必须导出（漏了会让断言恒真/恒假）。
  SKINS,
  SKIN_N,
  SKIN_GRAY,
  SKIN_WIND,
  SKIN_PHANTOM,
  SKIN_BOOST,
  SKIN_STICK,
  SKIN_BLACKHOLE,
  SKIN_CHAOS,
  SKIN_BLOCK,
  SKIN_SLOW,
  SKILL_CD_MS,
  STICK_MS,
  HOLE_R,
  HOLE_LIFE_MS,
  HOLE_HALF_DEG,
  CHAOS_MS,
  CHAOS_HALF_DEG,
  BLOCK_MAX,
  SLOW_MS,
  SLOW_MUL,
  PHANTOM_BOT_SWAY,
  castStick,
  castBlackhole,
  castChaos,
  castBlock,
  castSlow,
  checkBlackhole,
  WIND_MS,
  WIND_ACC,
  PHANTOM_MS,
  PHANTOM_ANGLE,
  BOOST_SPEED,
  castSkill,
  castWind,
  castPhantom,
  bounceOffPaddle,
  clearSkills,
  isPhantom,
  normSkin,
  skinHasSkill,
  pickSkin,
  canPickSkin,
  removeBall,
  // ★ 下发函数也要导出：幻影球"按队过滤 bs / px"这件事**没法靠客户端过滤实现**，
  //   只能在服务端这一层验。导出它之后测试可以直接把真正发出去的字符串抓下来断言，
  //   而不是去验"客户端不显示"（那根本证明不了对手的包里没有答案）。
  broadcastState,
  // ★ 防卡死的两个函数 + 它的判据常量。曾经漏导出 POWERUP_R 让断言恒假，
  //   所以凡是断言要引用的常量都在这里列全（section 0 的自检会核对）。
  unstickBall,
  unstickBalls,
  MIN_VX_RATIO,
  UNSTICK_ANG_MIN,
  UNSTICK_ANG_MAX,
  UNSTICK_MIN_SPEED,
  SPEEDUP_PER_HIT,
  BALL_SPEED_MAX,
  BALL_SPEED_START,
  PADDLE_SPEED,
  splitBall,
  mostUrgentBall,
  makeBall,
  MAX_BALLS,
  SPLIT_SPEED_MUL,
  stepPaddles,
  stepPowerup,
  spawnPowerup,
  resetBall,
  spinBall,
  BOT_PRESETS,
  BOT_SLOT,
  COURT,
  POWERUP_N,
  POWERUP_R,
  INVIS_MS,
  INVIS_FADE_MS,
  invisAlpha,
  CURVE_MS,
  CURVE_SPIN,
  COOP_BOT_SPEED_MUL,
  COOP_BALL_SPEED,
  WIN_SCORE,
  WIN_MARGIN,
  PADDLE_GROW,
  PADDLE_SHRINK,
  BALL_FAST,
  POWERUP_MOD_MS,
  POWERUP_MAX,
  POWERUP_LIFE_MS,
  POWERUP_GAP_MS,
  FREEZE_MS,
  SHIELD_MAX,
  PADDLE_H,
  BALL_R,
  PADDLE_MARGIN,
  PADDLE_W,
  H,
  W,
};
