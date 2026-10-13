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
// 调试开关：发球时立刻造出"一颗球被粘住 + 另一颗球在飞"的多球局面，
// 好让前端探针取证"粘球不能让其它球消失"这件事。靠真人接到粘球、且场上
// 恰好还有别的球（分裂球/幻影球）是碰运气，测不出稳定结论。默认关闭。
const DEBUG_STICK_MULTI = process.env.PONG_DEBUG_STICK_MULTI === '1';
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
let ballSeq = 0;
function makeBall(x, y) {
  ballSeq += 1;
  return { id: ballSeq, x, y, vx: 0, vy: 0 };
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
 * 造一个 AI 玩家。刻意长得像真人玩家对象，好让 stepPaddles / 广播复用同一套代码。
 * speedBoost 是模式级的额外倍率（coop 里 AI 要覆盖整条 800px 的边，必须更快）。
 */
function makeBot(level, speedBoost) {
  const lv = clamp(level, 0, BOT_PRESETS.length - 1);
  const cfg = BOT_PRESETS[lv];
  return {
    bot: true,
    level: lv,
    cfg,
    token: null,
    ws: null,
    dir: 0,
    since: Date.now(),
    thinkAt: 0,       // 下次思考的时刻
    aimErr: 0,        // 这一球的固定瞄准误差
    chasing: false,   // 上一 tick 球是不是朝它飞 —— 用来判断"新的一球开始了"
    chaseId: 0,       // 正在追的那个球的 id（多球时用来判断"换球了没"）
    seen: [],         // 它**脑子里的球**：不隐形时每 tick 刷新，被隐形时冻结（见 botPerceive）
    speedMul: cfg.speedMul * (speedBoost || 1),
  };
}

function createRoom(code, mode, level) {
  const md = normMode(mode);
  const court = COURT[md];
  const slots = buildSlots(md, court.H);
  const midOf = (s) => (s.span[0] + s.span[1]) / 2;
  const room = {
    code,
    mode: md,
    solo: md !== 'duel',      // 对手是不是 AI（外广播字段，历史探针在读）
    coop: md === 'coop',
    botLevel: md === 'duel' ? -1 : clamp(Number(level) || 0, 0, BOT_PRESETS.length - 1),
    // ---- 场地与拍子布局（按房间，不再是全局常量）----
    W: court.W,
    H: court.H,
    slots,                    // [{ edge, team, span }]
    N: slots.length,          // 拍子槽位数：经典 2，coop 3
    players: new Array(slots.length).fill(null),
    paddles: slots.map(midOf),
    ballSpeed0: md === 'coop' ? COOP_BALL_SPEED : BALL_SPEED_START,
    // ★ 球是**数组**（分裂球会让场上同时存在多个球）。
    //   每个球带一个稳定 id：客户端靠它把"上一帧的球"和"这一帧的球"对上号。
    //   没有 id 时，一旦某个球出界被移出数组，后面所有球的位置都会整体错位，
    //   客户端会把剩下的球从旧位置平滑地"滑"到新位置 —— 看起来像球在瞬移。
    balls: [makeBall(court.W / 2, court.H / 2)],
    score: [0, 0],
    phase: 'countdown', // countdown | playing | over（对外的 waiting 由 paused/started 推导）
    phaseEndsAt: 0,
    serveTo: 0,       // 下一次发球朝向哪一队（0 = 发给左队）
    tick: 0,
    winner: -1,
    started: false,   // 是否已经开过第一局；决定要不要初始化比分
    paused: true,     // 缺人时冻结比赛，但不作废比分
    // ★ 真人主动暂停（**任意一方按下即生效**，见 togglePause）。它与上面的 `paused`
    //   刻意分成两个字段，因为语义完全不同：`paused` 是"缺人"的自动结果，
    //   这个只由玩家按下产生。合成一个字段会立刻带来两个真问题：
    //     ① 广播里的 ph 会变成 waiting，而客户端在 waiting 下**根本不画球** ——
    //        一按暂停球就从画面上消失，看着像球被吞了；
    //     ② "等对手回来"和"有人按了暂停"要给的提示语完全不一样。
    userPaused: false,
    pausedBy: -1,     // 是谁按的（**槽位号**，-1 = 当前没暂停）
    frozenAt: 0,      // 上一次"冻结推进"的时刻（0 = 没在冻结）—— 见 stepRoom 里那句后移
    // ---- 道具与临时效果 ----
    powerups: [],                         // 场上道具 [{ x, y, type, bornAt }] —— 可以同时有多个
    nextPowerupAt: Date.now() + PU_FIRST_MS,
    lastHitter: -1,                       // 最后击球的**槽位**，决定球撞到的道具归哪一队
    // 拍子长度倍率按**队**算，但它是由下面两个计时器**算出来**的，不是直接写的。
    // ★ 拆成两个计时器是"多个效果能共存"的核心：加长和削短必须各自计时。
    //   合用一个计时器时，对方在你加长中途削你一下，削短到期会把倍率复位成 1 ——
    //   你那 8 秒的加长被顺带清掉，而且界面上没有任何提示，属于纯闷亏。
    paddleMul: [1, 1],
    growUntil: [0, 0],                    // "加长自己"到期时间（按队）
    shrinkUntil: [0, 0],                  // "削短对方"到期时间（按队）
    ballMul: 1,                           // 球速倍率：只缩放位移、不动 vx/vy，避免反复乘除漂移
    ballUntil: 0,
    freezeUntil: [0, 0],                  // 某队的拍子被冰冻到什么时候
    doubleUntil: [0, 0],                  // 某队双倍得分到什么时候
    // 某队的球被隐形到什么时候（**被隐形方**存这里：0 队吃了就写 1 队）。
    // 按**队**而不是按球：隐形是"看不见场上所有球"，不是"某一个球隐形了"。
    invisUntil: [0, 0],
    shield: [0, 0],                       // 护盾剩余层数（不是时间制，是次数制）
    curveUntil: 0,                        // 弧线球效果到期时间
    curveSpin: 0,                         // 弧线角速度（rad/s，带符号 = 拐弯方向）
    // ---- 皮肤与技能 ----
    // ★ 全部按**槽位**存，不按队伍：coop 里左边两个人是同队，但各有各的技能和冷却。
    //   这也是它们不能并进 applyPowerup 那套"按队生效"的数组里的原因。
    skins: slots.map(() => SKIN_GRAY),    // 每个槽位选的皮肤（0 = 灰，没技能）
    skillReadyAt: slots.map(() => 0),     // 冷却到期时刻（0 = 随时可放）
    boostArmed: slots.map(() => false),   // 红色：已经蓄好力、等下一次击球
    winds: [],                            // 正在刮的风 [{ dx, dy, until, seed }] —— 可以同时有多股
    // ★ 蓝（粘球）：**按槽位**武装，和其他"下一次击球"类技能一个套路。
    //   存布尔而不是时间戳：它表示"已经按下技能，等着粘下一板"，
    //   真正计时的是球被粘住那一刻（b.stuck.until）。
    stickArmed: slots.map(() => false),
    // ★ 紫（乱弹）：按**槽位**（是"我自己接球变乱"，不是"这一队"）
    chaosUntil: slots.map(() => 0),
    // ★ 黑（黑洞）：场上可以同时存在多个洞（两个人都是黑拍子），所以是数组。
    //   每一项 { x, y, team, until }：team 是**开洞那一方**，决定出口在哪半边。
    holes: [],
    // ★ 白（道具封锁）：**剩余层数**（按队）。对手吃到道具时消耗一层。
    //   上限 BLOCK_MAX = 1 ⇒ 结构上就不可能叠加。
    blockCharges: [0, 0],
    // ★ 橙（减速）：某队拍子速度上限降到 SLOW_MUL 直到什么时候（按队，和冰冻一样）
    slowUntil: [0, 0],
    events: [],                           // 本轮离散事件，广播后清空（供前端出音效）
    serverTime: Date.now(),
    lastActivity: Date.now(),
  };
  // 把 AI 放进它该坐的槽位。它没有 ws，其余流程与真人玩家完全一致。
  const boost = md === 'coop' ? COOP_BOT_SPEED_MUL : 1;
  for (const i of BOT_SLOT[md]) room.players[i] = makeBot(room.botLevel, boost);
  return room;
}

// 只算真人。机器人不算"活着" —— 否则人走了房间永远回收不掉，
// 而且"双方都在"会永远成立，比分会一直空转。
function anyAlive(room) {
  return room.players.some(isLive);
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

// ---------- 道具与临时效果 ----------
function clearPowerups(room) {
  room.powerups = [];
  room.nextPowerupAt = Date.now() + PU_FIRST_MS;
  room.paddleMul = [1, 1];
  room.growUntil = [0, 0];
  room.shrinkUntil = [0, 0];
  room.ballMul = 1;
  room.ballUntil = 0;
  room.freezeUntil = [0, 0];
  room.doubleUntil = [0, 0];
  room.invisUntil = [0, 0];
  room.shield = [0, 0];
  room.curveUntil = 0;
  room.curveSpin = 0;
  room.lastHitter = -1;
  // ★ 黑洞、道具封锁、减速也属于"这一局的效果"，新一局跟着清。
  //   （clearSkills 里也清了一遍 —— 两边都清是有意的：clearPowerups 只管道具侧，
  //    clearSkills 管技能侧，谁先调用都不会漏掉这几个字段。）
    room.holes = [];
    room.blockCharges = [0, 0];
    room.slowUntil = [0, 0];
    // 局间"可以重新选拍子"的窗口：本局进过 over 并翻到下一局时打开，
    //   球真的发出去时关上（见 broadcastState 开头与 pickSkin）。
    room.reselectPending = false;
  }

/**
 * 每局开始时把技能相关的东西清干净。
 * ★ 刻意**不动 room.skins** —— 那是玩家在菜单里选的，属于"这一场"而不是"这一局"，
 *   清掉的话第二局开始所有人都会变回灰板子。
 * ★ 冷却也一起清：新的一局从"技能就绪"开始，免得上一局的冷却跨局带到下一局。
 */
function clearSkills(room) {
  room.winds = [];
  room.holes = [];
  for (let i = 0; i < room.N; i += 1) {
    room.skillReadyAt[i] = 0;
    room.boostArmed[i] = false;
    room.stickArmed[i] = false;
    room.chaosUntil[i] = 0;
  }
  for (let i = 0; i < 2; i += 1) {
    room.blockCharges[i] = 0;
    room.slowUntil[i] = 0;
  }
}

/**
 * 把房间内所有"挂钟型"的截止时刻整体往后推 ms。
 *
 * ★ 为什么必须有这个函数：这些时间戳全是**绝对**的 Date.now()，而暂停期间挂钟照走。
 *   不推的话，"暂停两分钟"实际等于"所有效果都过期了"：
 *     · 吃到加长 / 双倍得分的人回来发现效果没了（白吃亏）；
 *     · 被冰冻的一方倒是自动解冻了（明明是别人吃到的东西替他解了围）；
 *     · 场上道具全部到寿消失，恢复后还得再等好几秒才刷出来。
 *   暂停的语义是"把**比赛时间**冻住"，所以这些截止时刻必须跟着一起冻。
 *
 * ★ 阶段截止时间 phaseEndsAt 在 countdown 阶段**不在本函数的职责内** ——
 *   stepRoom 在冻结期间每 tick 都会把它重设成"当前 + 倒计时长度"，恢复时又重设一次。
 *   所以这里只管 'over' 那个（冻结期间没人会去碰它，不后移的话解冻那一瞬间就直接开下一局）。
 *   'playing' 阶段这个字段当时用不到。
 *   ★ 实测确认过：把它改成"无条件后移"也不会出错 —— 因为把截止时刻后移"已经过去的那段
 *     时间"在定义上就等于"这段时间没走过"，是自纠正的。写成分情况只为让"谁负责它"有唯一答案。
 */
function shiftDeadlines(room, ms) {
  if (!(ms > 0)) return;
  const bump = (t) => (t > 0 ? t + ms : 0);
  if (room.phase === 'over') room.phaseEndsAt = bump(room.phaseEndsAt);
  room.nextPowerupAt = bump(room.nextPowerupAt);
  for (const u of room.powerups) u.bornAt += ms;
  for (let i = 0; i < 2; i += 1) {
    room.growUntil[i] = bump(room.growUntil[i]);
    room.shrinkUntil[i] = bump(room.shrinkUntil[i]);
    room.freezeUntil[i] = bump(room.freezeUntil[i]);
    room.doubleUntil[i] = bump(room.doubleUntil[i]);
    room.invisUntil[i] = bump(room.invisUntil[i]);
  }
  room.ballUntil = bump(room.ballUntil);
  room.curveUntil = bump(room.curveUntil);
  // 技能：冷却 / 在刮的风 / 幻影球的剩余时间，全都属于"比赛时间"，一样要冻住。
  // 不冻的话，"暂停十秒"= 免费跳过十秒冷却 —— 谁先按暂停谁先转好技能。
  for (let i = 0; i < room.N; i += 1) room.skillReadyAt[i] = bump(room.skillReadyAt[i]);
  for (let i = 0; i < room.N; i += 1) room.chaosUntil[i] = bump(room.chaosUntil[i]);
  for (const w of room.winds) w.until += ms;
  for (const h of room.holes) h.until += ms;
  for (let i = 0; i < 2; i += 1) room.slowUntil[i] = bump(room.slowUntil[i]);
  for (const b of room.balls) {
    if (b.phantomUntil) b.phantomUntil += ms;
    // ★ 粘住的球也要一起后移：它就是"比赛时间还没走"的那一秒，
    //   不后移的话暂停两秒回来球就自己飞走了 —— 而玩家全程没看见它动。
    if (b.stuck) b.stuck.until += ms;
  }
}

/**
 * 切换暂停。**任意一方按下都直接生效** —— 这不是投票，谁按谁说了算：
 * 两个人都能暂停，也都能恢复（对手暂停了你随时能按回去）。
 *
 * 这里只做状态与事件，不碰任何计时器 —— 冻结的进入 / 退出统一由 stepRoom 处理
 * （那样"缺人自动冻结"和"玩家主动暂停"走的是同一条路径，不会有一套被漏掉）。
 *
 * @param {object} room 房间
 * @param {number} slot 按下的槽位（只用于显示"是谁按的"）
 * @returns {boolean} 切换之后是否处于暂停
 */
function togglePause(room, slot) {
  room.userPaused = !room.userPaused;
  room.pausedBy = room.userPaused ? slot : -1;
  // 两端都该听到"有人按了暂停" —— 不然对面会以为是自己卡了
  room.events.push(room.userPaused ? 'pp' : 'pr');
  return room.userPaused;
}

// ---------- 技能 ----------
/** 这个皮肤有没有主动技能（灰的没有） */
function skinHasSkill(skin) {
  return Number.isInteger(skin) && skin > SKIN_GRAY && skin < SKIN_N && SKILL_CD_MS[skin] > 0;
}

/**
 * 青：刮一阵风。
 * 风向 = 自己拍子中心 → 球场中心 的**单位向量**。
 *   · 拍子在左侧正中央 ⇒ 方向正好是 (+1, 0)，笔直往右吹；
 *   · 拍子在左上 ⇒ 方向是右下方。
 * 这正是需求描述的那个规则，而且是"从拍子指向中心"而不是"从中心指向拍子"。
 *
 * ★ 用**拍子的实时位置**而不是槽位中点：技能是"从我现在站的地方吹出去"，
 *   玩家把拍子挪到上方再按，风就该往右下走。用中点会让方向跟玩家的操作无关。
 */
function castWind(room, slot, now) {
  const sl = room.slots[slot];
  const px = sl.edge === 'left'
    ? PADDLE_MARGIN + PADDLE_W / 2
    : room.W - PADDLE_MARGIN - PADDLE_W / 2;
  const py = room.paddles[slot];
  let dx = room.W / 2 - px;
  let dy = room.H / 2 - py;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return false;      // 理论上到不了（拍子在边上），留个守门
  dx /= len;
  dy /= len;
  room.winds.push({ dx, dy, until: now + WIND_MS, seed: Math.random() * 1000 });
  return true;
}

/**
 * 黄：放出一个幻影球。
 * 真球与幻影球各自朝两边偏 PHANTOM_ANGLE、速率不变 —— 见 PHANTOM_ANGLE 的注释，
 * 等速对称是"对手分不出哪个是假的"的前提。
 */
function castPhantom(room, slot, now) {
  const team = room.slots[slot].team;
  const src = room.balls.find((b) => !isPhantom(b));
  if (!src) return false;
  const speed = Math.hypot(src.vx, src.vy);
  if (speed < 1) return false;          // 球还没发出去，没什么可迷惑的
  const base = Math.atan2(src.vy, src.vx);
  const sgn = Math.random() < 0.5 ? 1 : -1;
  const aReal = base + sgn * PHANTOM_ANGLE;
  const aFake = base - sgn * PHANTOM_ANGLE;
  src.vx = Math.cos(aReal) * speed;
  src.vy = Math.sin(aReal) * speed;
  const ph = makeBall(src.x, src.y);
  ph.vx = Math.cos(aFake) * speed;
  ph.vy = Math.sin(aFake) * speed;
  ph.phantom = team;                    // 归哪一队 —— 该队**看不到**它（见 broadcastState）
  ph.phantomUntil = now + PHANTOM_MS;
  room.balls.push(ph);
  return true;
}

/**
 * 蓝：武装"下一次接球粘住"。真正的粘发生在 bounceOffPaddle 里
 * （见那里的 `room.stickArmed[slot]` 分支）—— 技能本身只是把开关打开。
 */
function castStick(room, slot) {
  room.stickArmed[slot] = true;
  return true;
}

/**
 * 黑：在己方靠中间的那半区随机开一个黑洞。
 *
 * ★ 区间是"自己这边的靠中半区"：左队 → x ∈ [0.25W, 0.50W]，右队整体镜像。
 *   用 **有效** 区间避开左右两条拍子列与上下墙 —— 洞开在拍子身上或者压着墙，
 *   玩家既看不清也容易误判，而且视觉上像是"洞卡在墙里"。
 * ★ y 也要留边：半径 HOLE_R 的洞贴着上下墙会露出一半。
 */
function castBlackhole(room, slot, now) {
  const sl = room.slots[slot];
  const left = sl.edge === 'left';
  const x0 = left ? room.W * 0.25 : room.W * 0.75;
  const x1 = left ? room.W * 0.50 : room.W * 0.50;
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const pad = HOLE_R + 6;
  const yLo = PADDLE_MARGIN + pad;
  const yHi = room.H - PADDLE_MARGIN - pad;
  const x = lo + Math.random() * (hi - lo);
  const y = yLo + Math.random() * Math.max(1, yHi - yLo);
  room.holes.push({
    x, y, team: sl.team, until: now + HOLE_LIFE_MS,
    // 视觉用：每个洞给一个固定相位，免得两个洞的呼吸完全同步
    seed: Math.random() * 1000,
  });
  return true;
}

/** 紫：开启 10 秒的"乱弹"状态（自己接球走随机角 + 大概率加速） */
function castChaos(room, slot, now) {
  room.chaosUntil[slot] = now + CHAOS_MS;
  return true;
}

/**
 * 白：给对方挂一层"下一次吃到的道具无效"。
 * ★ 不能叠加：已经是满层就直接返回 false（**不消耗冷却**）——
 *   这样连按两下不会白烧 10 秒 CD，玩家不用猜"我这下浪费了没有"。
 */
function castBlock(room, slot) {
  const team = room.slots[slot].team;
  const foe = 1 - team;
  if (room.blockCharges[foe] >= BLOCK_MAX) return false;
  room.blockCharges[foe] = BLOCK_MAX;
  return true;
}

/** 橙：把对方整队的拍子速度上限降到 SLOW_MUL，持续 SLOW_MS */
function castSlow(room, slot, now) {
  const foe = 1 - room.slots[slot].team;
  room.slowUntil[foe] = Math.max(room.slowUntil[foe], now + SLOW_MS);
  return true;
}

/**
 * 放技能。返回 true 表示这次真的放出去了（冷却被消耗）。
 *
 * ★ 门禁按"技能能不能真的产生作用"来设，一条都不能省：
 *   · `room.started` —— 第一局还没开始时按下去没有任何意义；
 *   · `paused / userPaused` —— 比赛时间冻着的时候不该有任何操作生效（否则暂停期间
 *     放技能，恢复那一刻效果已经过半了）；
 *   · `phase === 'playing'` —— countdown 时球还没发出去（风没处吹、幻影球没有源球），
 *     over 时这一局已经结束了；
 *   · 冷却 —— 见 skillReadyAt；
 *   · 红色已经蓄着力时再按一次 —— 白烧 10 秒冷却，直接拒掉。
 */
function castSkill(room, slot, now) {
  if (!room.started) return false;
  if (room.paused || room.userPaused) return false;
  if (room.phase !== 'playing') return false;
  const skin = room.skins[slot];
  if (!skinHasSkill(skin)) return false;
  if (room.skillReadyAt[slot] > now) return false;
  if (skin === SKIN_BOOST && room.boostArmed[slot]) return false;

  if (skin === SKIN_WIND) {
    if (!castWind(room, slot, now)) return false;
  } else if (skin === SKIN_PHANTOM) {
    if (!castPhantom(room, slot, now)) return false;
  } else if (skin === SKIN_BOOST) {
    room.boostArmed[slot] = true;
  } else if (skin === SKIN_STICK) {
    if (!castStick(room, slot)) return false;
  } else if (skin === SKIN_BLACKHOLE) {
    if (!castBlackhole(room, slot, now)) return false;
  } else if (skin === SKIN_CHAOS) {
    if (!castChaos(room, slot, now)) return false;
  } else if (skin === SKIN_BLOCK) {
    if (!castBlock(room, slot)) return false;   // 已经封着对方了 → 不消耗冷却
  } else if (skin === SKIN_SLOW) {
    if (!castSlow(room, slot, now)) return false;
  }
  room.skillReadyAt[slot] = now + SKILL_CD_MS[skin];
  room.events.push(`v${slot}${skin}`);   // v + 槽位 + 皮肤：前端按皮肤放不同的音效
  return true;
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
 * 所以"加长自己的拍子"会同时加长它的上半场和下半场两个拍子，这正是想要的效果。
 */
function applyPowerup(room, who, type, now) {
  const foe = 1 - who;
  if (type === 0) {
    room.growUntil[who] = now + POWERUP_MOD_MS;     // 自己的拍子变长（只动自己的计时器）
  } else if (type === 1) {
    room.shrinkUntil[foe] = now + POWERUP_MOD_MS;   // 对方拍子变短（只动对方的计时器）
  } else if (type === 2) {
    room.ballMul = BALL_FAST;                        // 球加速
    room.ballUntil = now + POWERUP_MOD_MS;
  } else if (type === 3) {
    // 冰冻：直接覆盖，不叠加时长（叠加会变成连续冻结，等于剥夺对方整队）
    room.freezeUntil[foe] = Math.max(room.freezeUntil[foe], now + FREEZE_MS);
  } else if (type === 4) {
    room.shield[who] = Math.min(SHIELD_MAX, room.shield[who] + 1);        // 护盾 +1 层
  } else if (type === 5) {
    room.doubleUntil[who] = now + POWERUP_MOD_MS;    // 接下来 8 秒自己进球算两分
  } else if (type === 6) {
    // 弧线球：拐弯方向在吃到的那一瞬间就定下来，一整段持续同一个方向。
    // 若每 tick 重掷方向，球会在空中左右乱抖，看着像掉帧而不是"飘"。
    room.curveUntil = now + CURVE_MS;
    room.curveSpin = Math.random() < 0.5 ? -CURVE_SPIN : CURVE_SPIN;
  } else if (type === 7) {
    splitBall(room);
  } else if (type === 8) {
    // 隐形球：**对方**被隐形，自己照常看得见。
    // 用 Math.max 而不是直接覆盖：万一对方也刚吃到、正被隐形着，
    // 不该被这一下"缩短"（道具只该让人更难受，不该替对方解围）。
    room.invisUntil[foe] = Math.max(room.invisUntil[foe], now + INVIS_MS);
  }
  // 加长/削短是"算出来的"，这里立刻重算一次，别让倍率落后一 tick
  refreshPaddleMul(room, now);
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
 */
function splitBall(room) {
  // ★ 只数**真球**：幻影球是假的，它占了名额会让"分裂球"变成"吃了没反应"；
  //   而且源球也必须是真球 —— 从一个幻影球上分裂出来，生出来的还是假的，
  //   两个假球会一起穿透真球，观感非常诡异。
  const real = room.balls.filter((b) => !isPhantom(b));
  if (real.length >= MAX_BALLS) return false;
  const src = real[0];
  if (!src) return false;

  const speed = Math.hypot(src.vx, src.vy) * SPLIT_SPEED_MUL;
  if (speed < 1) return false;                     // 球还没发出去，没什么可分的

  let dir = Math.atan2(src.vy, src.vx);
  const mirror = Math.abs(Math.sin(dir)) > 0.2
    ? -dir                                          // 常规：按水平轴镜像
    : (Math.sin(dir) >= 0 ? dir + 0.6 : dir - 0.6);  // 近水平：硬掰开一个角度

  const b = makeBall(src.x, src.y);
  b.vx = Math.cos(mirror) * speed;
  b.vy = Math.sin(mirror) * speed;
  room.balls.push(b);
  return true;
}

/**
 * 由两个计时器**算出**拍子倍率。抽成独立函数是为了让 applyPowerup 之后
 * 立刻就能拿到正确的倍率 —— 否则会有一 tick 的窗口里"效果生效了但拍子还是旧长度"，
 * 而客户端画拍子用的就是这个值，看起来就是"吃了加长但拍子没变长"。
 */
function refreshPaddleMul(room, now) {
  for (let i = 0; i < 2; i += 1) {
    const grow = room.growUntil[i] > now;
    const shrink = room.shrinkUntil[i] > now;
    if (!grow) room.growUntil[i] = 0;
    if (!shrink) room.shrinkUntil[i] = 0;
    // ★ 两个效果同时生效时**相乘**（1.65 × 0.62 ≈ 1.02），即"一加一减正好抵消"。
    //   注意不能写成 Math.min（谁更极端谁赢）：那样一次削短会把正在生效的加长
    //   一起抹掉，而且削短到期时还会把加长的剩余时间也清了 —— 纯闷亏。
    room.paddleMul[i] = (grow ? PADDLE_GROW : 1) * (shrink ? PADDLE_SHRINK : 1);
  }
}

/** 效果到期复位。必须每 tick 调，否则道具会永久生效 */
function trackMods(room, now) {
  refreshPaddleMul(room, now);
  for (let i = 0; i < 2; i += 1) {
    if (room.freezeUntil[i] && now >= room.freezeUntil[i]) room.freezeUntil[i] = 0;
    if (room.doubleUntil[i] && now >= room.doubleUntil[i]) room.doubleUntil[i] = 0;
    if (room.invisUntil[i] && now >= room.invisUntil[i]) room.invisUntil[i] = 0;
  }
  if (room.ballUntil && now >= room.ballUntil) {
    room.ballMul = 1;
    room.ballUntil = 0;
  }
  if (room.curveUntil && now >= room.curveUntil) {
    room.curveUntil = 0;
    room.curveSpin = 0;
  }
  // ★ 风也必须在这里到期清掉。少了这一句的后果**不是"风多吹一会儿"**：
  //   stepBalls 是无条件遍历 room.winds 施力的，而 castWind 只往数组里 push、
  //   从不删除 —— 于是每放一次风就永久多一股力，十分钟后场上的球会被一股
  //   越积越大的合力直接甩出球场，而且完全看不出是哪一次技能造成的。
  if (room.winds.length) {
    const alive = room.winds.filter((w) => w.until > now);
    if (alive.length !== room.winds.length) room.winds = alive;
  }
  // ★ 黑洞与减速也在这里到期清掉。和风同一个坑：`stepBalls` 是无条件遍历
  //   `room.holes` 做判定的，只 push 不删的话场上会越积越多洞，
  //   球一进场就会被一个"早就该消失的洞"吞掉，而且看不出是谁的技能造成的。
  if (room.holes.length) {
    const aliveH = room.holes.filter((h) => h.until > now);
    if (aliveH.length !== room.holes.length) room.holes = aliveH;
  }
  for (let i = 0; i < 2; i += 1) {
    if (room.slowUntil[i] && now >= room.slowUntil[i]) room.slowUntil[i] = 0;
  }
}

/**
 * 某一队**当前看到的球**有多不透明（1 = 完全看得见，0 = 完全看不见）。
 *
 * ★ 透明度在服务端算好再下发，而不是把时长发给客户端让它自己算。
 *   这条曲线有三个阶段（淡出 / 全隐 / 淡入），客户端再实现一遍就等于同一套数学
 *   写了两份，任何一边改了另一边的表现就会静默错位 —— 而错位恰好表现为
 *   "渐变没了、变成硬切"，正是这次要避免的东西。
 *
 *   曲线（elapsed = 已过去多久，remain = 还剩多久）：
 *     elapsed < FADE  → 1 - elapsed/FADE   （淡出：1 → 0）
 *     remain  < FADE  → 1 - remain/FADE    （淡入：0 → 1）
 *     中间            → 0                  （完全看不见）
 *   两头都留渐变、中间真的落到 0 —— 要的是"看不到"，不是"稍微变淡"。
 *   ★ 淡入那一段必须是 1 - remain/FADE。写成 remain/FADE 的话，
 *     曲线会变成 0 → 1 → 一路降回 0 → 最后一刻又跳回 1 来回抖，
 *     表面上"有透明度变化"，实际看是球闪了一下才回来。
 */
function invisAlpha(room, team, now) {
  const until = room.invisUntil[team];
  if (!until || now >= until) return 1;
  const remain = until - now;
  const elapsed = INVIS_MS - remain;
  if (elapsed < INVIS_FADE_MS) return clamp(1 - elapsed / INVIS_FADE_MS, 0, 1);
  if (remain < INVIS_FADE_MS) return clamp(1 - remain / INVIS_FADE_MS, 0, 1);
  return 0;
}

/** 道具的生成 / 过期 / 被球碰到。只在 playing 阶段调用 */
/**
 * 生成一个道具。
 * 位置落在中段区域：太靠边等于白送，太靠中间又会被乱球轻易蹭到。
 * ★ 多个并存时必须**互相错开**，否则两个圈会叠在一起，视觉上分不清是一个还是两个，
 *   而且球一穿过去会连着吃掉两个（观感上像是"一个道具给了两份效果"）。
 */
function spawnPowerup(room, now) {
  // ★ 场上球已经到上限时，不再生成分裂球 ——
  //   否则只能眼睁睁看着一个吃不到的分裂球在那儿转，吃了还什么都没发生。
  const atBallCap = room.balls.length >= MAX_BALLS;
  let type = FORCE_PU
    ? FORCE_PU[puSeq.i++ % FORCE_PU.length]
    : Math.floor(Math.random() * POWERUP_N);
  if (type === 7 && atBallCap) type = 0;
  const minGap = POWERUP_R * 2 + 34;
  let x = room.W * 0.26 + Math.random() * room.W * 0.48;
  let y = 70 + Math.random() * (room.H - 140);
  for (let tries = 0; tries < 20; tries += 1) {
    const tooClose = room.powerups.some((u) => Math.hypot(u.x - x, u.y - y) < minGap);
    if (!tooClose) break;
    x = room.W * 0.26 + Math.random() * room.W * 0.48;
    y = 70 + Math.random() * (room.H - 140);
  }
  return { x, y, type, bornAt: now };
}

/**
 * 道具的生成 / 过期 / 被球碰到。只在 playing 阶段调用。
 *
 * 场上道具是**数组**，可以同时存在最多 POWERUP_MAX 个：
 *   · 生成 —— 到点就补，不看场上还剩几个（这样节奏才是稳定的，而不是
 *     "捡完才排下一个"那种由玩家行为决定的忽快忽慢）；
 *   · 过期 —— 一次把所有到寿的都清掉，不是只清第一个；
 *   · 拾取 —— 每 tick 只吃**最近**的一个。两个圈偶尔重叠时按数组顺序吃会让人
 *     分不清自己吃的到底是哪个，按距离取最近才符合直觉。
 */
function stepPowerup(room, now) {
  // 生成
  if (now >= room.nextPowerupAt) {
    room.nextPowerupAt = now + PU_GAP_MS;
    if (room.powerups.length < POWERUP_MAX) room.powerups.push(spawnPowerup(room, now));
  }

  // 过期
  if (room.powerups.length) {
    const alive = room.powerups.filter((u) => now - u.bornAt <= PU_LIFE_MS);
    if (alive.length !== room.powerups.length) room.powerups = alive;
  }

  // 拾取：逐个球去找它够得着、且还没被吃掉的最近的那一个。
  // ★ 必须逐个球遍历：多球时"某个球碰到了道具"和"另一个球碰到了另一个道具"
  //   是完全可能同时发生的，只看 0 号球会漏掉后面那些球的碰撞。
  const reach = BALL_R + POWERUP_R;
  const eaten = [];
  for (const ball of room.balls) {
    let best = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < room.powerups.length; i += 1) {
      if (eaten.indexOf(i) >= 0) continue;
      const u = room.powerups[i];
      const dx = ball.x - u.x;
      const dy = ball.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= reach * reach && d2 < bestD2) { bestD2 = d2; best = i; }
    }
    if (best < 0) continue;
    eaten.push(best);
    const u = room.powerups[best];
    // 归属规则：谁最后把球打出去，这个道具就算哪一队的。直觉上最好理解。
    // ★ lastHitter 是**槽位**，要折算成队伍 —— coop 里左边两个拍子都属于 0 队。
    const lh = room.lastHitter;
    const who = lh >= 0 && lh < room.N ? room.slots[lh].team : 0;
    // ★ 白（道具封锁）：**被封锁方**吃到的道具直接作废，并且消耗掉一层封锁。
    //   这一步必须挡在 applyPowerup 之前 —— 放在里面就晚了（效果已经生效）。
    //   事件也换成"被封锁"那一款，否则玩家会看到"我明明吃到了却什么都没发生"
    //   而对面则完全不知道自己的技能起效了。
    if (room.blockCharges[who] > 0) {
      room.blockCharges[who] -= 1;
      room.events.push(`b${who}${u.type}`);   // b + 队伍 + 道具类型：前端放"被封"的音效
    } else {
      applyPowerup(room, who, u.type, now);
      room.events.push(`u${who}${u.type}`);
    }
  }
  if (eaten.length) {
    // 从后往前删，避免下标前移漏删
    eaten.sort((a, b) => b - a).forEach((i) => room.powerups.splice(i, 1));
  }
}

function resetBall(room, serveTo) {
  const b = makeBall(room.W / 2, room.H / 2);
  room.balls = [b];
  room.serveTo = serveTo;
  room.lastHitter = -1;
  // ★ 重新发球时隐形必须结束。
  //   隐形是靠"球还在原来那条轨道上"才能预判的；一旦重新发球，
  //   轨道本身换了，被隐形的人就彻底没有任何信息了 —— 那不是"难接"，
  //   是"白送一分"。所以每次重新发球都把隐形清掉，
  //   它的作用范围严格限定在"吃到它的那一个回合"。
  room.invisUntil = [0, 0];
  room.phase = 'countdown';
  room.phaseEndsAt = Date.now() + COUNTDOWN_MS;
}

function launchBall(room) {
  const dir = room.serveTo === 0 ? -1 : 1;   // 发给哪一队，球就往哪边飞
  const angle = (Math.random() * 2 - 1) * (MAX_BOUNCE_ANGLE * 0.55);
  const b = room.balls[0];
  if (!b) return;
  b.vx = dir * room.ballSpeed0 * Math.cos(angle);
  b.vy = room.ballSpeed0 * Math.sin(angle);
  // 发球方 = 接球方的对面。取那一队的第一个槽位当"最后击球者"，
  // 这样球一发出去就撞到道具时，归属也有明确答案。
  const servingTeam = 1 - room.serveTo;
  room.lastHitter = room.slots.findIndex((s) => s.team === servingTeam);
  room.phase = 'playing';
  // ★ 调试：造出"一颗粘住 + 一颗在飞"的多球局面（默认关闭，线上走不到）。
  //   0 号球挂在左拍上，另外生成一颗向右飞的真球 —— 正是玩家报的那个场景。
  if (DEBUG_STICK_MULTI) {
    const stickSlot = room.slots.findIndex((s) => s.edge === 'left');
    if (stickSlot >= 0) {
      b.stuck = {
        slot: stickSlot,
        until: room.serverTime + STICK_MS,
        ox: PADDLE_W / 2 + BALL_R + 1,
        oy: 0,
      };
      b.vx = 0;
      b.vy = 0;
      // 第二颗：往右飞，和粘住的那颗同时存在
      const b2 = makeBall(room.W * 0.35, room.H * 0.35);
      b2.vx = 380;
      b2.vy = 140;
      room.balls.push(b2);
    }
  }
}

function startMatch(room) {
  room.score = [0, 0];
  room.paddles = room.slots.map((s) => (s.span[0] + s.span[1]) / 2);
  room.winner = -1;
  clearPowerups(room);           // 新一局清空场上道具与残留效果
  clearSkills(room);             // 技能冷却 / 蓄力 / 在刮的风也一起复位（皮肤保留）
  resetBall(room, Math.random() < 0.5 ? 0 : 1);
}

/** 球拍反弹：出射角由"打中拍子哪个位置"决定，中间平着飞，边缘角度大 */
function bounceOffPaddle(room, slot, b) {
  const py = room.paddles[slot];
  const half = paddleHalf(room, slot);
  let rel = clamp((b.y - py) / half, -1, 1);
  // ★ 弧线球期间，把"被带了一下"的观感做出来：出射角按当前弯曲方向偏一点点，
  //   否则球会被拍子拍直，玩家根本看不出自己刚才吃到的效果还在生效。
  if (room.curveSpin && room.curveUntil > room.serverTime) {
    rel = clamp(rel + room.curveSpin * 0.9, -1, 1);
  }
  // ★★ 蓝（粘球）优先于一切：它把球**粘住**，这一板根本不产生反弹。
  //   放在最前面是为了让"粘住"能压过红/紫——不然先算出射速再被粘住，
  //   那一下的出速就白算了，表现上会出现"球弹出去的瞬间又被拽回来"。
  //   只认真球、只认自己按了技能的那块拍子（和红色蓄力同一个理由）。
  if (!isPhantom(b) && room.stickArmed[slot]) {
    room.stickArmed[slot] = false;
    b.stuck = {
      slot,
      until: room.serverTime + STICK_MS,
      // 粘住期间每帧把球摆到这个相对位置（拍子中心再往外一点）
      ox: room.slots[slot].edge === 'left' ? PADDLE_W / 2 + BALL_R + 1 : -(PADDLE_W / 2 + BALL_R + 1),
      oy: clamp(b.y - py, -half, half),
    };
    b.vx = 0;
    b.vy = 0;
    room.lastHitter = slot;
    room.events.push(`h${slot}`);
    return;
  }
  // 红色技能蓄的力只对**真球**生效，而且只认**这块拍子**：
  //   · 幻影球是自己放出去骗人的，撞回自己拍子上还要吃掉一次蓄力 —— 玩家看不见它，
  //     只会觉得"我明明按了红色却什么都没发生"，属于纯闷亏；
  //   · 别人把球打回来不该用掉我的蓄力（这是"我下次击球"的技能）。
  const boosted = !isPhantom(b) && !!room.boostArmed[slot];
  if (boosted) room.boostArmed[slot] = false;
  const outDir = room.slots[slot].edge === 'left' ? 1 : -1;
  // ★ 紫（乱弹）：10 秒内自己接球不再走常规反弹 —— 角度与速率都随机重掷。
  //   仍然夹 BALL_SPEED_MAX：它是"改变球速的路径"之一，不夹会把球推过反隧穿前提。
  const chaos = !isPhantom(b) && !boosted && room.chaosUntil[slot] > room.serverTime;
  let speed;
  let angle;
  if (chaos) {
    // 80% 加速（×1.00~1.35）、20% 微减速（×0.85~1.00）—— 期望值是净加速，
    // 但偶尔慢一下让对手也摸不准节奏。需求原话就是"大概率是加速"。
    const fast = Math.random() < 0.8;
    const k = fast ? 1 + Math.random() * 0.35 : 0.85 + Math.random() * 0.15;
    speed = Math.min(Math.hypot(b.vx, b.vy) * k, BALL_SPEED_MAX);
    // 方向朝对方、±60°（和黑洞出洞同一套规则）
    angle = (Math.random() * 2 - 1) * (CHAOS_HALF_DEG * Math.PI / 180);
  } else {
    speed = boosted
      ? BOOST_SPEED
      : Math.min(Math.hypot(b.vx, b.vy) * SPEEDUP_PER_HIT, BALL_SPEED_MAX);
    angle = rel * MAX_BOUNCE_ANGLE;
  }
  b.vx = outDir * speed * Math.cos(angle);
  b.vy = speed * Math.sin(angle);
  // 位置推到拍子外侧，防止下一步又判定为碰撞而卡住
  b.x = outDir > 0
    ? PADDLE_MARGIN + PADDLE_W + BALL_R + 0.5
    : room.W - PADDLE_MARGIN - PADDLE_W - BALL_R - 0.5;
  room.lastHitter = slot;
  room.events.push(`h${slot}`);
  if (boosted) room.events.push(`y${slot}`);   // 这一板是超高速，音效要听得出不一样
}

/**
 * 弧线球：把速度矢量旋转一个小角度。
 * ★ 用旋转而不是"加一个横向加速度"，是因为旋转是正交变换 ——
 *   速率严格不变，球不会因为拐弯越飞越快、也不会突破 BALL_SPEED_MAX。
 *   用加速度写的话每子步都在累加，几秒后球就快得没法接了。
 * ★ 分裂出来的球同样吃这个旋转（"受有关球的道具影响"）：
 *   两个球同向旋转但因为初始方向不同，会画出两条分开的弧线，观感很好。
 */
function spinBall(room, b, dt) {
  if (!room.curveSpin || room.curveUntil <= room.serverTime) return;
  const a = room.curveSpin * dt;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const vx = b.vx * c - b.vy * s;
  const vy = b.vx * s + b.vy * c;
  b.vx = vx;
  b.vy = vy;
}

/** 球是否撞上了贴在某条边上的某个拍子。撞到就弹一次并返回 true。 */
function hitEdgePaddles(room, b, edge) {
  for (let i = 0; i < room.N; i += 1) {
    if (room.slots[i].edge !== edge) continue;
    if (Math.abs(b.y - room.paddles[i]) <= paddleHalf(room, i) + BALL_R) {
      bounceOffPaddle(room, i, b);
      return true;
    }
  }
  return false;
}

/**
 * 球与球的碰撞：等质量完全弹性碰撞。
 *
 * 等质量时结论非常干净 —— **交换沿连心线方向的速度分量**，垂直分量不动。
 * 所以不需要动量/能量方程，一行就能写：
 *     v1' = v1 - ((v1-v2)·n) n
 *     v2' = v2 - ((v2-v1)·n) n
 *
 * ★ 只处理"正在靠近"的那一对。这一条不是优化，是**必须的**：
 *   分裂球生成时两个球是同一个位置（距离 0），随后才分开。如果无脑把重叠的
 *   两球推开，刚分裂出来的一对会被立刻弹向奇怪的方向，看起来像分裂失败。
 *   "只在靠近时响应"天然放过了这种"重叠但正在分开"的情况，也正是台球的物理。
 *
 * ★ 碰完必须把基础速度夹回 BALL_SPEED_MAX。斜碰会改变各自的速度大小
 *   （只有正碰才两头都不变），不夹的话会慢慢漂到上限之上 ——
 *   而"子步位移远小于判定窗口"这个反隧穿前提，正是靠这个上限保证的。
 */
function resolveBallCollisions(room) {
  const balls = room.balls;
  const minDist = BALL_R * 2;
  for (let i = 0; i < balls.length; i += 1) {
    for (let j = i + 1; j < balls.length; j += 1) {
      const a = balls[i];
      const b = balls[j];
      // ★ 幻影球和任何球都不碰撞（包括另一个幻影球）—— 需求原话是"撞在一起就穿过去"。
      //   这也是这套假象唯一的破绽，交付说明里如实写了。
      if (isPhantom(a) || isPhantom(b)) continue;
      // ★ 粘住的球也不参与碰撞：它贴在拍子上，别的球撞上来会把它推开。
      if (a.stuck || b.stuck) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist) continue;
      const d = Math.sqrt(d2);
      // 完全重合：连心线没有定义，方向无从谈起 —— 直接放过。
      // 分裂球生成的那一 tick 正好命中这里，等同"分开后再算"，是想要的行为。
      if (d < 1e-6) continue;
      dx /= d;
      dy /= d;
      // 沿连心线的相对速度。> 0 表示正在靠近
      const approach = (a.vx - b.vx) * dx + (a.vy - b.vy) * dy;
      if (approach <= 0) continue;
      a.vx -= approach * dx;
      a.vy -= approach * dy;
      b.vx += approach * dx;
      b.vy += approach * dy;
      for (const q of [a, b]) {
        const sp = Math.hypot(q.vx, q.vy);
        if (sp > BALL_SPEED_MAX) {
          q.vx = (q.vx / sp) * BALL_SPEED_MAX;
          q.vy = (q.vy / sp) * BALL_SPEED_MAX;
        }
      }
      room.events.push('cc');    // 撞球的音效（两种球互撞，和拍子音分开）
    }
  }
}

/**
 * 防"竖直卡死"：球的横向速度掉到 0 附近时，给它重新瞄一个方向。
 *
 * ★ 为什么必须防 —— 这不是"节奏不好看"，是**整局死锁**：
 *   球只在上下墙之间竖直弹时，它的 x 永远不变，于是永远碰不到任何拍子，
 *   这一回合永远不会结束（比分不动、也不会重新发球）。
 *   现实中两条来路：
 *     ① **等质量弹性碰撞**。连心线接近竖直时交换的是 vy，而 vx 会被
 *        `a.vx -= approach * dx` 顺手改掉一点（dx 是连心线的横向分量）——
 *        刚好抹平就是 0。更要命的是：**一旦变纯竖直，两个竖直球正碰
 *        只会互换 vy，vx 依然是 0** —— 这个状态是自锁的，不会自己恢复。
 *     ② **分裂球**。源球接近竖直时走"水平轴镜像"分支，新球的
 *        vx = 0.5 × 源球 vx，横向占比与源球完全一样 ⇒ 源球竖直，分出来的也竖直。
 *   （弧线球能把速度矢量旋转到接近竖直，所以这条路不是理论上的。）
 *
 * ★ 只旋转、**不改变速率**：速率大小是"反隧穿"论证的前提（子步位移必须远小于
 *   判定窗口，靠的就是 BALL_SPEED_MAX 这个上限）。在这里给它加速度会把那个
 *   前提弄脏，所以只换方向。重瞄角取 30°~60°：横向推进显著，同时又比纯水平
 *   更快产生上下变化，观感上是"球忽然拐了一下"，不是"球瞬移了"。
 *
 * ★ 判据用"占速率的比例"而不是绝对阈值：速率会一路涨到 900，
 *   固定阈值的含义会随球速漂移，写到后面就形同虚设。
 *
 * @param {object} b 球
 * @returns {boolean} 真的重瞄了才返回 true（调用方据此统计）
 */
function unstickBall(b) {
  // ★ 粘住的球 vx=vy=0，正好命中下面那条"速率兜底"分支 —— 会被重瞄出去，
  //   表现就是"刚粘住就被甩飞"。它本来就该停着，直接跳过。
  if (b.stuck) return false;
  const sp = Math.hypot(b.vx, b.vy);
  // 正常情况：速率有效、横向占比够大 ⇒ 球正在横穿场地，一个字都别动
  if (sp >= 1 && Math.abs(b.vx) >= sp * MIN_VX_RATIO) return false;

  // 速率兜底：`sp ≈ 0` 的球（现有物理下达不到，因为速率只会变大或保持不变）
  // 一旦出现就是永久停住，所以重瞄后至少得让它能横穿场地。
  // 不做上限裁剪 —— 这里只换方向，速率是多少就还是多少。
  const speed = Math.max(sp, UNSTICK_MIN_SPEED);
  const sign = Math.random() < 0.5 ? -1 : 1;                  // 往左还是往右：随机
  const ang = UNSTICK_ANG_MIN + Math.random() * (UNSTICK_ANG_MAX - UNSTICK_ANG_MIN);
  // 上下倾向沿用原来的（该往上就还往上）；原本正好水平就随机给一个。
  const vsign = b.vy < 0 ? -1 : (b.vy > 0 ? 1 : (Math.random() < 0.5 ? -1 : 1));
  b.vx = sign * speed * Math.cos(ang);
  b.vy = vsign * speed * Math.sin(ang);
  return true;
}

/**
 * 对场上每个球做一次防卡死检查，返回被重瞄的球数。
 * ★ 必须在 resolveBallCollisions **之后**调用：正是那次碰撞可能把球打成竖直，
 *   放在前面等于拿"碰撞前的速度"做判断，刚被打竖直的球要等下一个子步才被救。
 */
function unstickBalls(room) {
  let n = 0;
  for (const b of room.balls) if (unstickBall(b)) n += 1;
  return n;
}

/** 单个球的墙 / 拍子 / 出界判定。出界时会把球从场上移除并结算比分。 */
function stepOneBall(room, b) {
  // ★ 粘住的球不参与任何碰撞与出界判定：它被"挂"在拍子上，
  //   走这段会每子步被自己的拍子弹一次（表现上就是"粘不住，一直弹"）。
  //   它的位置完全由 stepBalls 那段负责。
  if (b.stuck) return;

  // 上下墙
  if (b.y - BALL_R < 0) {
    b.y = BALL_R;
    b.vy = Math.abs(b.vy);
  } else if (b.y + BALL_R > room.H) {
    b.y = room.H - BALL_R;
    b.vy = -Math.abs(b.vy);
  }

  const leftFace = PADDLE_MARGIN + PADDLE_W;
  const rightFace = room.W - PADDLE_MARGIN - PADDLE_W;

  if (b.vx < 0 && b.x - BALL_R <= leftFace && b.x > PADDLE_MARGIN - 30) {
    hitEdgePaddles(room, b, 'left');
  } else if (b.vx > 0 && b.x + BALL_R >= rightFace && b.x < room.W - PADDLE_MARGIN + 30) {
    hitEdgePaddles(room, b, 'right');
  }

  // ★ 幻影球：墙和拍子都照常（不然对手一眼就看出它是穿模的幽灵），
  //   但出界**既不判分也不消耗护盾**（需求原话："不会因为这个球实际得分和失分"）。
  //   直接返回，不往下走那段计分逻辑。
  if (isPhantom(b)) {
    if (b.x + BALL_R < 0 || b.x - BALL_R > room.W) removeBall(room, b);
    return;
  }

  // 出界：先给护盾一次机会，挡不住才算失分
  if (b.x + BALL_R < 0) {
    if (!useShield(room, 0, b)) afterGoal(room, 0, b);
  } else if (b.x - BALL_R > room.W) {
    if (!useShield(room, 1, b)) afterGoal(room, 1, b);
  }
}

/**
 * 把一个球从场上拿走（出界 / 到寿）。**只给幻影球用** —— 真球的移除在 afterGoal 里，
 * 那条路径还要顺带结算比分。
 *
 * ★ 拿走之后必须检查"场上还有没有真球"。漏了这一步会让整局彻底卡死：
 *   真球已经出界、分数也结算过了，而幻影球出界又**不会**触发 afterGoal，
 *   于是没有任何一条路径会去重新发球 —— 比分不动、球也不再出现，这一局就死在那儿了。
 */
function removeBall(room, b) {
  const i = room.balls.indexOf(b);
  if (i >= 0) room.balls.splice(i, 1);
  if (room.phase !== 'playing') return;
  if (room.balls.some((q) => !isPhantom(q))) return;   // 还有真球在飞，什么都不用做
  resetBall(room, room.serveTo);
}

/**
 * 推进场上**所有**球。
 * 顺序：先全部旋转+位移，再两两解球球碰撞，最后逐球做墙/拍子/出界。
 * ★ 碰撞必须放在全部位移之后：否则先动的球会拿"别人的旧位置"去判定，
 *   两个球会像穿过去一样互相漏掉。
 */
/**
 * 黑（黑洞）：球碰到自己开的洞就"穿"到对面靠中间的半区随机位置。
 *
 * ★ 三条要点：
 *   ① 只认**自己开的洞**对**所有球**生效 —— 洞是场地的一部分，不是谁的私产。
 *      但出口位置由**开洞方的队伍**决定（洞在左就在右边出），所以这里读 h.team。
 *   ② 速率严格保持（需求原话"速率和进入黑洞时相同"）：只重掷方向，不乘任何系数。
 *      也因此**不需要**再夹 BALL_SPEED_MAX —— 进来的速率本来就已经被夹过了。
 *   ③ 出洞方向是"朝对方"、±HOLE_HALF_DEG。以左队开洞为例：球从 x∈[0.25W,0.5W]
 *      的洞里进去，从 x∈[0.5W,0.75W] 出来，方向以**正右**为 0°、上下随机 ±60°。
 *
 * ★ 洞用完就消：一个洞只送走一个球。不然球会反复被同一个洞抛来抛去。
 */
function checkBlackhole(room, b) {
  if (!room.holes.length) return false;
  const now = room.serverTime;
  for (let i = 0; i < room.holes.length; i += 1) {
    const h = room.holes[i];
    if (h.until <= now) continue;
    const dx = b.x - h.x;
    const dy = b.y - h.y;
    if (dx * dx + dy * dy > HOLE_R * HOLE_R) continue;

    const speed = Math.hypot(b.vx, b.vy);
    // 速率兜底：极低速的球（理论到不了）也给一个能飞出去的值，免得出洞就卡住
    const sp = Math.max(speed, UNSTICK_MIN_SPEED);
    // 出口：洞在**己方靠中半区**，出口在**对方靠中半区** —— 左右镜像。
    const left = room.slots.find((s) => s.team === h.team);
    const holeOnLeft = left ? left.edge === 'left' : true;
    const x0 = holeOnLeft ? room.W * 0.50 : room.W * 0.25;
    const x1 = holeOnLeft ? room.W * 0.75 : room.W * 0.50;
    const pad = BALL_R + 4;
    const yLo = pad;
    const yHi = room.H - pad;
    b.x = x0 + Math.random() * (x1 - x0);
    b.y = yLo + Math.random() * Math.max(1, yHi - yLo);
    // 方向：朝对方（洞在左 → 向右），±60°
    const outDir = holeOnLeft ? 1 : -1;
    const ang = (Math.random() * 2 - 1) * (HOLE_HALF_DEG * Math.PI / 180);
    b.vx = outDir * sp * Math.cos(ang);
    b.vy = sp * Math.sin(ang);
    // 洞用完即消 —— 否则同一个洞会把球反复吞吐
    room.holes.splice(i, 1);
    room.events.push(`w${h.team}`);   // 黑洞音效
    return true;
  }
  return false;
}

function stepBalls(room, dt) {
  const mul = room.ballMul;
  const winds = room.winds;
  for (const b of room.balls) {
    // ★★ 蓝（粘球）：先处理粘住的球，它走**完全不同**的一条路 ——
    //   不施力、不旋转、不位移，只是被"挂"在自己拍子上。
    //   放在最前面是为了让下面那些"施力 / 夹速率"的代码一行都不碰它：
    //   给它加风、或者让它按自己的速度动，都会让"粘住"当场失效。
    if (b.stuck) {
      if (room.serverTime >= b.stuck.until) {
        // 到点：朝正前方（自己这一侧的水平方向）以普通发球初速放出去。
        // ★ 方向是**水平**，不是"朝球场中心" —— 需求原话是"向正前方释放"。
        const sd = room.slots[b.stuck.slot];
        const outDir = sd && sd.edge === 'left' ? 1 : -1;
        b.stuck = null;
        b.vx = outDir * BALL_SPEED_START;
        b.vy = 0;
        b.x = outDir > 0
          ? PADDLE_MARGIN + PADDLE_W + BALL_R + 0.5
          : room.W - PADDLE_MARGIN - PADDLE_W - BALL_R - 0.5;
        room.events.push('hS');   // 释放音效，和普通击球区分开
      } else {
        // 粘住中：位置跟着拍子走（拍子动了球也跟着，这才是"粘"）
        const sl = room.slots[b.stuck.slot];
        const px = sl.edge === 'left'
          ? PADDLE_MARGIN + PADDLE_W / 2
          : room.W - PADDLE_MARGIN - PADDLE_W / 2;
        b.x = px + b.stuck.ox;
        b.y = room.paddles[b.stuck.slot] + b.stuck.oy;
        b.vx = 0;
        b.vy = 0;
        continue;
      }
    }
    spinBall(room, b, dt);        // 弧线球：先转向，再按新方向前进
    // 风：给球加一个沿风向的加速度。顺风的球被推快、逆风的被拽慢、横穿的被推偏、
    //   本来就慢的球会被吹得直接转向 —— 四种表现都是这一个式子的结果（见 WIND_ACC）。
    for (let i = 0; i < winds.length; i += 1) {
      b.vx += winds[i].dx * WIND_ACC * dt;
      b.vy += winds[i].dy * WIND_ACC * dt;
    }
    // ★ 加完风必须把速率夹回上限：风是**唯一**能把球推过 BALL_SPEED_MAX 的路径，
    //   而"子步位移远小于判定窗口"这个反隧穿前提正是靠这个上限保证的。
    //   夹的是**速率**不是分量 —— 分量各夹各的会把方向掰弯，球会莫名其妙拐一下。
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > BALL_SPEED_MAX) {
      b.vx = (b.vx / sp) * BALL_SPEED_MAX;
      b.vy = (b.vy / sp) * BALL_SPEED_MAX;
    }
    b.x += b.vx * mul * dt;
    b.y += b.vy * mul * dt;
    // ★ 黑（黑洞）：只认真球，判定放在位移之后（这样"这一子步里穿过洞"也能抓到）。
    if (!isPhantom(b)) checkBlackhole(room, b);
  }
  resolveBallCollisions(room);
  // ★ 紧跟碰撞之后：碰撞本身就能把球打成"纯竖直"（见 unstickBall），
  //   不在这里救，球就会永远在上下墙之间竖弹、这一回合永远结束不了。
  unstickBalls(room);
  // 复制一份再遍历：出界的球会在 afterGoal 里被移出 room.balls，
  // 直接遍历原数组会因为下标前移而漏掉后面的球。
  for (const b of room.balls.slice()) {
    if (room.phase !== 'playing') break;   // 期间可能因分出胜负/重发球切了阶段
    // 幻影球到寿：悄悄消失，不算分（对手只会看到"球没了"）。
    if (isPhantom(b) && b.phantomUntil && room.serverTime >= b.phantomUntil) {
      removeBall(room, b);
      continue;
    }
    stepOneBall(room, b);
  }
}

/**
 * 护盾：球马上要出界时消耗一层，把球弹回场内。
 * 参数是**队伍**号 —— coop 里护盾属于左边这一整队，两个人共享。
 * 返回 true 表示这次被挡下了，调用方不该再判失分。
 */
function useShield(room, side, ball) {
  if (room.shield[side] <= 0) return false;
  const b = ball || room.balls[0];
  if (!b) return false;
  room.shield[side] -= 1;

  // 推回场内并反向。稍微提一点速，否则低速救球会贴着底线反复来回
  b.x = side === 0 ? BALL_R + 2 : room.W - BALL_R - 2;
  const speed = Math.min(Math.hypot(b.vx, b.vy) * 1.04, BALL_SPEED_MAX);
  const angle = (Math.random() * 2 - 1) * MAX_BOUNCE_ANGLE * 0.6;
  b.vx = (side === 0 ? 1 : -1) * speed * Math.cos(angle);
  b.vy = speed * Math.sin(angle);
  // 救球的人算最后击球方，撞到道具归他那一队
  const own = room.slots.findIndex((s) => s.team === side);
  room.lastHitter = own < 0 ? 0 : own;
  room.events.push(`k${side}`);
  return true;
}

/**
 * 乒乓球胜负判定：先到 11 分、且净胜 2 分。
 * 单独抽成纯函数是为了能验证边界 —— 真打满 11 分要好几十秒，
 * 而 10:10 之后的分支恰恰是最容易写错的地方（11:10 不结束、12:10 才结束）。
 */
function isWin(my, foe) {
  return my >= WIN_SCORE && my - foe >= WIN_MARGIN;
}

function afterGoal(room, concededBy, ball) {
  // ★ 先把这个漏掉的球从场上拿走。剩下的球继续在场上飞 ——
  //   "一回合要所有球都没接住才重发"就体现在这里。
  if (ball) {
    const i = room.balls.indexOf(ball);
    if (i >= 0) room.balls.splice(i, 1);
  }

  // ★ 原实现写的是 room.score[concededBy]（**失分方**的分数），判定对象就错了。
  //   症状：先到 WIN_SCORE 的一方不会赢，反而在自己丢下一个球时把胜利判给对手；
  //   而且只要失分方分数够，比赛就莫名结束。胜负只能看得分方的分数。
  const scorer = 1 - concededBy;

  // ★ 计分只能在这里做。若留在 stepBall 里直接 +1，双倍得分就只是"显示的分数变了"，
  //   胜负判定读到的还是没乘倍率的值 —— 会出现"加分了却不算赢"的怪事。
  const now = Date.now();
  const gain = room.doubleUntil[scorer] > now ? 2 : 1;
  room.score[scorer] += gain;

  const my = room.score[scorer];
  const foe = room.score[concededBy];

  room.events.push(`g${scorer}`);   // 得分音效
  if (gain === 2) room.events.push(`x${scorer}`);   // 这一分是双倍，得说清楚

  if (isWin(my, foe)) {
    room.phase = 'over';
    room.winner = scorer;
    room.phaseEndsAt = Date.now() + OVER_HOLD_MS;
    // ★ 这一局结束了 ⇒ 下一局开始时要给玩家一次重选拍子的机会。
    //   标记在这里立、由 startMatch 翻开（phase 变 countdown）、发球时关掉。
    room.reselectPending = true;
    // 场上还剩的球全部冻住（不是只冻第一个，否则多球时还有球在飞）
    for (const b of room.balls) { b.vx = 0; b.vy = 0; }
    room.events.push(`o${scorer}`);   // 一局结束
    return;
  }

  // ★ 只有场上一个**真球**都不剩了才重新发球。
  //   还有球在飞就继续打 —— 这就是"所有球都没接住才重发"。
  // ★ 判据必须是"真球"而不是 balls.length：幻影球是假的，让它把回合吊住的话，
  //   这一回合会变成"真球已经出界算过分、却还在等一个不算分的假球飞完"的怪状态。
  //   顺带一提，resetBall 会把整个数组换掉，所以重发时幻影球自然一起消失。
  if (!room.balls.some((b) => !isPhantom(b))) resetBall(room, concededBy);   // 谁丢分，球发给谁
}

/**
 * 挑出"最快就要打到某条边"的那个球。多球时 AI 只可能处理最紧急的一个 ——
 * 同时照顾两个球是做不到的，硬要平均分配反而两个都接不到。
 * goingRight = 这条边在右边（球从左边飞过来）。
 */
function mostUrgentBall(room, goingRight, list) {
  const faceX = goingRight
    ? room.W - PADDLE_MARGIN - PADDLE_W - BALL_R
    : PADDLE_MARGIN + PADDLE_W + BALL_R;
  let best = null;
  let bestT = Infinity;
  // ★ 默认看 `room.balls`（真值），但允许传一份"它自己以为的球"。
  //   被隐形球骗到的 AI 走的就是后者（见 botPerceive）：
  //   它不再拿真值算落点，只能拿上次看见时的那份状态硬推。
  for (const b of (list || room.balls)) {
    const vx = b.vx * (room.ballMul || 1);
    if (goingRight ? vx <= 1 : vx >= -1) continue;   // 没朝这边飞
    const t = (faceX - b.x) / vx;
    if (t >= 0 && t < bestT) { bestT = t; best = b; }
  }
  return best;
}

/**
 * 预测球到达某条竖线时的 y 坐标，含上下墙反射。
 * 用三角波把无限延伸的直线折叠回场内 —— 比"一段一段循环模拟"更短，也不累积误差。
 */
function predictY(room, b, faceX) {
  const m = room.ballMul || 1;
  const vx = b.vx * m;
  const vy = b.vy * m;
  if (Math.abs(vx) < 1) return b.y;
  const t = (faceX - b.x) / vx;
  if (!(t > 0)) return b.y;

  const span = room.H - 2 * BALL_R;
  let k = (b.y + vy * t - BALL_R) / span;
  // ★ 折到 [0, 2)：一个周期是 **2 个 span**（一个 span 走到底，再一个 span 走回来）。
  //   写成 "取小数部分再对半折" 是周期 1 的三角波，球一旦碰到墙就会算到错的落点。
  k -= Math.floor(k / 2) * 2;
  const tri = k <= 1 ? k : 2 - k;
  return BALL_R + tri * span;
}

/**
 * 机器人【感知】。按反应间隔更新瞄准误差与目标落点 —— 这里才是"反应时间"。
 * ★ 它和下面的【操控】必须分开。原因见 botSteer 的注释。
 * 参数是**槽位**：coop 里 AI 占的是第 3 个槽位。
 */
function botPerceive(room, slot, now) {
  const p = room.players[slot];
  const cfg = p.cfg;
  const team = room.slots[slot].team;
  const mine = room.slots[slot].edge === 'right';

  // ★ 隐形球会把 AI 一起骗到 —— 不这么做的话，这道道具只在"两个真人"时成立，
  //   人机局里吃到它等于什么都没发生（AI 照样看得见真值，照样接得住）。
  //   做法和真人完全一样：**只按上次看见时的位置和速度去推**。
  //   p.seen 是"它脑子里的球"，不隐形时每 tick 刷新；隐形期间冻结在最后一次看见的状态。
  const blind = room.invisUntil[team] > now;
  // ★★ 幻影球必须排除在 AI 的"世界观"之外 —— 这是"幻影球对电脑无效"的根因。
  //   幻影球是**释放方看不见、对方看得见**的假球，它的全部作用是骗对手去接错地方；
  //   而它按设计不与拍子碰撞、出界也不计分。
  //   如果 AI 也把它算进 `mostUrgentBall`，就会发生两件都不对的事：
  //     ① AI 被引到假球上站定 —— 看起来"被骗到了"，但骗法完全不对：真球来了它
  //        人不在位置，这不是"人类被迷惑"，是"AI 在追一个空气球"；
  //     ② 更糟的是假球通常比真球先"打到"它（幻影球和真球是同一个位置分出来的），
  //        于是 AI 会**优先**去接假球，真球直接漏掉 —— 表现为 AI 突然像傻了一样。
  //   正确的建模是：**幻影球对 AI 生效的方式 = 让 AI 看见两个球、从而选错**，
  //   而不是"让 AI 去接一个不存在的碰撞体"。所以这里把幻影球**当作真球一样
  //   参与选择**（它看起来就是球），但选中之后的落点预判走它自己的轨迹 ——
  //   AI 于是真的会被带偏，且偏得和真人一样自然。
  const vision = room.balls.filter((b) => !isPhantom(b) || b.phantom !== team);
  if (!blind) {
    p.seen = [];
    for (const b of vision) {
      p.seen.push({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, phantom: b.phantom });
    }
  }
  // 隐形期间新分裂出来的球它根本不知道存在（p.seen 里没有这个 id），
  // 于是只会在"它记得的那几个球"里挑一个去接 —— 这正是看不见的表现。
  const seen = blind ? (p.seen || []) : vision;
  const b = mostUrgentBall(room, mine, seen);
  if (!b) { p.chasing = false; p.chaseId = 0; return; }
  const chasing = mine ? b.vx > 0 : b.vx < 0;

  // 球刚开始朝自己飞 —— 这一球重新掷一次瞄准误差，然后**保持到这一球结束**。
  // ★ 若每次思考都重掷，拍子会在目标附近来回抖，反而更容易把球蹭到，难度就白设了。
  // ★ 多球时用**球的 id** 判断"换球了没"：只看 chasing 这个布尔量的话，
  //   从 A 球切到 B 球（chasing 一直是 true）会沿用上一个球的瞄准误差。
  // ★ 幻影球带一个**额外的瞄准误差**：它是一颗"故意做成看起来完全一样的球"，
  //   但 AI 追它本来就没有意义（接到也不会弹、也不得分）。给它一点额外偏差，
  //   于是"被幻影球骗到"这件事在表现上是**概率性的**——AI 有时被带偏、
  //   有时识破继续守真球，和人面对假球的反应一致；而不是"必定被带走"或"完全无视"。
  const phantomErr = b.phantom === undefined ? 0 : PHANTOM_BOT_SWAY;
  if (chasing && p.chaseId !== b.id) {
    p.aimErr = (Math.random() * 2 - 1) * cfg.errPx
      + (Math.random() * 2 - 1) * phantomErr;
  }
  p.chaseId = chasing ? b.id : 0;
  p.chasing = chasing;

  if (now < p.thinkAt) return;               // 限频：这就是"反应时间"
  p.thinkAt = now + cfg.thinkMs;

  const faceX = mine
    ? room.W - PADDLE_MARGIN - PADDLE_W - BALL_R
    : PADDLE_MARGIN + PADDLE_W + BALL_R;

  if (chasing) {
    // ★ 追的是幻影球时，AI 预判的是**幻影球的落点**——它真的会跑过去站好。
    //   这正是幻影球该有的效果：AI 被骗到错的位置，而真球从旁边过去。
    p.targetY = predictY(room, b, faceX) + p.aimErr;
  } else {
    // 球在往对面飞：回自己那半场的中路待命，带点随机偏移，看起来不像机器
    const [yMin, yMax] = room.slots[slot].span;
    p.targetY = (yMin + yMax) / 2 + (Math.random() * 2 - 1) * (yMax - yMin) * 0.09;
  }
}

/**
 * 机器人【操控】。每个 tick 都朝着目标微调方向。
 *
 * ★ 为什么不能只在"思考"的那一下决定方向：
 *   困难档一个决策间隔里拍子会走 110ms × 540px/s ≈ 59px，而判定阈值只有
 *   拍子半长 48 + 球半径 9 = 57px。只在思考时决定方向，拍子就会以满速在目标
 *   两侧来回摆（实测 268→214→268→286），几乎永远不在正确位置上 —— 表现为
 *   "AI 一直在动、离球也不远，却一个球都接不住"。
 *   感知可以慢（反应时间），操控必须连续。这也是真人打球的样子。
 */
function botSteer(room, slot) {
  const p = room.players[slot];
  const half = paddleHalf(room, slot);
  const [yMin, yMax] = room.slots[slot].span;
  const mid = (yMin + yMax) / 2;
  const lo = yMin + half;
  const hi = yMax - half;
  // 拍子比活动区间还长时（理论上不该发生）就钉在中点，别让 clamp 反过来
  const target = hi < lo ? mid : clamp(p.targetY === undefined ? mid : p.targetY, lo, hi);
  const d = target - room.paddles[slot];
  // 死区要小：它会直接变成"停在离目标差一点"的系统性偏差。
  // 实测 9px 会让总偏差从 57 顶到 59.6，恰好越过判定阈值。
  // 操控是按子步长（540/240 = 2.25px）推进的，所以 4px 足够防止抖动。
  const dead = Math.max(3, PADDLE_SPEED * (p.speedMul || 1) * SUB_DT * 1.5);
  p.dir = Math.abs(d) < dead ? 0 : (d > 0 ? 1 : -1);
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

function stepRoom(room, now) {
  room.serverTime = now;

  // 机器人永远"在场"，所以人机模式不会因为缺人而暂停
  const bothPresent = room.players.every(isPresent);
  room.paused = !bothPresent;

  // 玩家主动暂停（任意一方按下即生效，见 togglePause）。
  // ★ `room.started` 这个前提不能省：先建房的那个人闲得按一下暂停，第二个人进来
  //   就会卡在"已暂停"、第一局永远开不了 —— 而那时候两边都还没打过球，
  //   "恢复"按钮在没开过局的房间里也不该有意义。
  const userFrozen = room.started && room.userPaused;
  const frozen = room.paused || userFrozen;

  // 缺人：冻结比赛。比分、球的位置都原样保留，人回来接着打。
  // 倒计时的截止时刻往后推，避免他重连回来时倒计时已经悄悄走完。
  if (frozen) {
    // ★ 冻结期间**每个 tick** 都把挂钟型截止时刻按"上一 tick 到现在过了多久"同步后移，
    //   等价于"比赛时间彻底静止"。为什么要持续做而不是解冻时补一次：
    //   服务端每个快照都会用这些时间戳**算**出下发的字段（冰冻还剩几秒 fz、
    //   球的不透明度 ia、双倍得分是否生效 db）。只在解冻那一刻补的话，暂停期间
    //   这些字段会一路走到"已过期" —— 玩家看到的是"暂停中对手忽然又能看见球了"
    //   "双倍得分显示成没了，一恢复又冒出来"。持续后移则全程都是暂停前那一刻的值。
    //   （这条是实测踩出来的：第一版就是"解冻时补一次"，test-rules 第 18 节直接报红。）
    // ★ 它同时也是自纠正的：把一个截止时刻后移"已经过去的那段时间"，定义上就等于
    //   "这段时间没走过"。所以哪怕别处再多移一次，也不会把它推到未来去。
    if (room.frozenAt) shiftDeadlines(room, now - room.frozenAt);
    room.frozenAt = now;
    if (room.phase === 'countdown') room.phaseEndsAt = now + COUNTDOWN_MS;
    room.tick += 1;
    return;
  }

  // 刚从冻结里出来。
  if (room.frozenAt) {
    // 补上"最后一次冻结 tick → 解冻 tick"之间那一小段，然后收工
    shiftDeadlines(room, now - room.frozenAt);
    room.frozenAt = 0;
    // ★ 倒计时重新数一整段。冻结期间它每 tick 都被重设成"当前 + 1.8s"，本来就已经
    //   是"完整一段"了，这里再设一次是为了让"谁负责它"只有一个答案：countdown 的
    //   截止时刻**只由这两处重设**，shiftDeadlines 里那句 `phase === 'over'` 的
    //   分支永远轮不到 countdown。恢复后给一整段倒计时，玩家有时间把手放回拍子上。
    if (room.phase === 'countdown') room.phaseEndsAt = now + COUNTDOWN_MS;
  }

  // 人齐了但还没开过第一局 —— 只有这时候才允许重置比分
  if (!room.started) {
    startMatch(room);
    room.started = true;
  }

  trackMods(room, now);   // 道具效果到期复位（漏了这句道具就会永久生效）

  if (room.phase === 'over') {
    if (now >= room.phaseEndsAt) startMatch(room);   // 一局打完自动开下一局
    room.tick += 1;
    return;
  }

  if (room.phase === 'countdown') {
    for (let i = 0; i < SUBSTEPS; i += 1) stepPaddles(room, SUB_DT);
    if (now >= room.phaseEndsAt) launchBall(room);
    room.tick += 1;
    return;
  }

  // playing：先按细分的固定步长推进，再判定
  for (let i = 0; i < SUBSTEPS; i += 1) {
    stepPaddles(room, SUB_DT);
    if (room.phase !== 'playing') break;   // 中间可能因得分切换了阶段
    stepBalls(room, SUB_DT);
  }
  stepPowerup(room, now);   // 生成 / 过期 / 被球碰到
  if (DEBUG_FX) debugShowcaseFx(room, now);
  // 取证用：把弧线一直续上，让探针有时间截图
  if (DEBUG_CURVE && room.curveUntil < now) {
    room.curveUntil = now + 60000;
    room.curveSpin = CURVE_SPIN;
  }
  room.tick += 1;
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
    // 蓝：正在被粘住的球（[球id, x, y, 槽位] 或 0）。客户端据此把球画在拍子上 ——
    //   ★ 必须**单独下发**，不能只靠 bs 里的坐标：粘住的球坐标由服务端每 tick
    //   跟着拍子算，客户端平滑一下就会"飘"在拍子旁边，看起来没粘住。
    //   下发这个标记让客户端把它**硬贴**在拍子上（绕过平滑）。
    //   ★★ 球 id 必须带上（2026-10-11 修）：场上可能有多颗球（分裂球/幻影球），
    //   客户端原先靠"同一时刻最多只有一颗球被粘住"这个前提，把硬贴坐标无条件
    //   套在**每一颗**球上 —— 结果一颗被粘住时，其余几颗全被画到它身上（看起来
    //   就是"其它球消失了"）。带上 id，客户端只对匹配的那颗硬贴。
    sk2: (() => {
      const s = room.balls.find((b) => b.stuck);
      return s ? [s.id, r1(s.x), r1(s.y), s.stuck.slot] : 0;
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
function seatPlayer(room, ws, side, token, skin) {
  room.players[side] = { ws, token, dir: 0, since: Date.now() };
  // 皮肤只在**入座那一刻**确定。掉线重连走的是 handleRejoin（不经过这里），
  // 所以重连回来还是原来那块拍子 —— 换了皮肤会让对手的认知错位。
  room.skins[side] = normSkin(skin);
  ws.player = { code: room.code, side, token };
  room.lastActivity = Date.now();
}

function findSeat(room) {
  // 优先真正的空位；若都被占但有人掉线，则顶替掉线的那个座位，保证随时能开始玩
  for (let i = 0; i < room.N; i += 1) if (!room.players[i]) return i;
  const now = Date.now();
  for (let i = 0; i < room.N; i += 1) {
    const p = room.players[i];
    // ★ 机器人的座位绝不能被真人顶替。它没有 ws，会被下面那句判成"掉线"，
    //   于是 90 秒后随便谁一加入就坐到了 AI 身上，人机对战忽然变成一个人空转。
    if (isBot(p)) continue;
    const dead = !p.ws || p.ws.readyState > 1;
    if (dead && now - p.since > SLOT_GRACE_MS) return i;
  }
  return -1;
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
  for (let i = 0; i < room.N; i += 1) {
    const p = room.players[i];
    if (p && !isBot(p) && p.token === token) {
      p.ws = ws;
      p.dir = 0;
      p.since = Date.now();
      ws.player = { code, side: i, token };
      room.lastActivity = Date.now();
      send(ws, { ...joinedPayload(room, code, i, token, false), t: 'rejoined' });
      console.log(`[room] ${code} rejoined slot ${i}`);
      return;
    }
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
  const p = room.players[ws.player.side];
  if (p && p.token === ws.player.token) {
    p.dir = 0;
    // 保留座位与 token，等待重连；ws 仍指向已关闭的连接，anyAlive 会正确判定
    room.lastActivity = Date.now();
  }
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

// 测试时只想拿这里的纯逻辑，不想再起一个监听去和已跑的服务抢端口
if (process.env.PONG_NO_LISTEN !== '1') {
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
