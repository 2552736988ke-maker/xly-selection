// MTN 中空旋转平台的选型雏形（owner 2026-10-21 的口述流程）。
//
// 业主给的判据，按顺序：
//   1. 客户工况算出来的关键量只有两个：**扭矩** 和 **惯量**（外加需要的 **速比**）；
//   2. 用这两者结合速比，先看能不能配上一台满足的**电机**；
//   3. 再看速比：比号太大 → **本体 + 行星减速机**；本体自身的比号够 → **直接选本体**；
//   4. 所以选型的核心硬条件 = **本体容许转矩 ≥ 折算后的需求转矩**（按比号取值）。
//
// 这一版是"雏形"，故意只做最普遍的工况：
//   - 做：转矩容量筛选、速比决策（本体 / 本体+行星）、**减速机容量校核**、
//     电机扭矩与惯量比校核、盘面转速上限；
//   - 不做：尺寸干涉、吊装负载、倾覆力矩、精度与寿命校核 —— 这些是"特殊工况"，
//     按业主要求后续再验证。
//
// 两条不变量（和产品库一致）：
//   - 默认只从 ACTIVE 记录里选。DRAFT 只有调用方显式要求（includeStatuses）才参与，
//     并且结果里会被标成 draft: true —— 半成品数据不会被当成真产品推荐。
//
// 减速机为什么这样算（2026-10-21 之后新增，别改成"拿盘面力矩比减速机"）：
//   行星装在 MTN 本体的**输入侧**（目录型号 MTN60K-15 = 本体 5 比 × 行星 3 比），
//   所以减速机输出轴承受的是 **本体输入轴力矩 = 盘面需求力矩 ÷ 本体比号**，
//   不是盘面力矩本身。盘面力矩由本体（本体容许转矩）负责。
//   因此"本体+二级行星时扭矩上限按本体还是按减速机"这条，物理上的答案是**两个都要满足**：
//   本体侧看盘面力矩，减速机侧看本体输入力矩（= 盘面力矩 ÷ 本体比号）。

import { selectMotor } from "./motor-select.js";
import { gearboxesForFrameSize } from "./gearbox-fitment.js";
import { findGearbox, ratioLevel, ratedTorqueAtRatio } from "./gearbox-catalog.js";

/** 换向器系列（产品库里 family = gearbox）；报错措辞和速度上限都要按这个分。 */
const GEARBOX_SERIES = new Set(["XZT", "XZTF"]);


/**
 * 本体的比号，按**接不接行星**分两种口径（所有者 2026-10-22 口述，别再按目录那一列猜）：
 *
 *   - 不接行星、只拿本体用：**所有型号都是 18 比**。
 *     原因是本体盘面有最高输出转速 200 r/min：3000 r/min 的电机配 18 比 → 167 r/min，才压得住。
 *   - 接行星：**MTN60 与 MTN85 的本体有 5 比和 10 比；其余型号本体只有 10 比**。
 *
 * 目录 p003 那一列「本体减速比 5/10/15/18」是型号清单，不是任选集合：
 * 15 比（以及 18 比除本体单用以外）不进选型。目录里的 K/T 只是命名，不参与选型。
 */
export const BODY_ONLY_RATIO = 18;

/**
 * 只能配行星、不给本体单用的框号（所有者 2026-10-22：MTN60 与 MTN85 只做 5 比和 10 比，
 * 这两个规格只配行星使用）。所以"本体单用一律 18 比"这条只对 130 以上成立。
 */
export const PLANETARY_ONLY_FRAMES = Object.freeze(["60", "85"]);

/** 这个框号能不能本体单用。 */
export function allowsBodyOnly(frameSize, series = "MTN") {
  const rules = seriesRules(series);
  if (!bodyOnlyRatiosOf(rules).length) return false;
  return !rules.planetaryOnlyFrames.includes(normalizeFrame(frameSize));
}

function bodyOnlyRatiosOf(rules) {
  if (Array.isArray(rules.bodyOnlyRatios)) return rules.bodyOnlyRatios;
  return rules.bodyOnlyRatio === null || rules.bodyOnlyRatio === undefined ? [] : [rules.bodyOnlyRatio];
}

/** 某个系列本体单用可用的比号（MTN 18；XZT/XZTF 1、2；ZTT/MTT 没有）。 */
export function bodyOnlyRatiosFor(series) {
  return [...bodyOnlyRatiosOf(seriesRules(series))];
}

/**
 * 按系列分的本体比号规则（所有者 2026-10-26 补的 ZTT）：
 *
 *   MTN：本体单用一律 18 比；接行星时 60/85 有 5、10，其余只有 10。
 *   ZTT：本体固定 **3 比**，**没有本体单用** —— ZTT 本身就是"本体 + 行星"的组合产品，
 *        L1 = 3 × 单级行星比（9…30），L2 = 3 × 双级行星比（36…300）。
 *        所以 18 比在 ZTT 上是 3 × 6（单级行星），不是"本体单用"。
 */
export const SERIES_BODY_RULES = Object.freeze({
  MTN: Object.freeze({
    recordRatioIsTotal: false,
    bodyOnlyRatio: 18,
    ratiosWithGearbox: Object.freeze({ "60": [5, 10], "85": [5, 10] }),
    fallbackRatioWithGearbox: 10,
    planetaryOnlyFrames: Object.freeze(["60", "85"])
  }),
  ZTT: Object.freeze({
    // ZTT 的型号比号就是总速比（ZTT130-9-N = 9:1），本体固定 3 比；
    // 所以它不能像 MTN 那样"拿本体比号去凑任意总速比"，必须按比号定型匹配。
    recordRatioIsTotal: true,
    bodyRatio: 3,
    bodyOnlyRatio: null,
    ratiosWithGearbox: Object.freeze({ "130": [3], "180": [3], "220": [3], "260": [3] }),
    fallbackRatioWithGearbox: 3,
    planetaryOnlyFrames: Object.freeze(["130", "180", "220", "260"])
  }),
  MTT: Object.freeze({
    // MTT（所有者 2026-10-26 口述）：本体自带 3:1 或 5:1，**没有本体单用** ——
    // 42 框号本体有 3、5 两种比号，60 框号目前只有 5；两者都必须再配行星减速机，
    // 总速比 = 本体比号 × 行星比号（42→GAB042、60→AFP060）。
    // 记录里的 ratio 是**本体比号**（MTT42-5-N 的 5 是本体 5:1），不是总速比。
    recordRatioIsTotal: false,
    bodyOnlyRatio: null,
    ratiosWithGearbox: Object.freeze({ "42": [3, 5], "60": [5] }),
    fallbackRatioWithGearbox: 3,
    planetaryOnlyFrames: Object.freeze(["42", "60"])
  }),
  XZT: Object.freeze({
    // 换向器 XZT（所有者 2026-10-26）：本体就是总成，型号上的比号就是总速比（1 或 2），
    // 不接行星；所以"请求速比必须等于型号速比"（和 ZTT 的定型思路一样，但没有本体+行星）。
    bodyOnlySku: true,
    recordRatioIsTotal: false,
    bodyOnlyRatio: null,
    bodyOnlyRatios: Object.freeze([1, 2]),
    ratiosWithGearbox: Object.freeze({}),
    fallbackRatioWithGearbox: 1,
    planetaryOnlyFrames: Object.freeze([])
  }),
  XZTF: Object.freeze({
    // 换向器 XZTF（所有者 2026-10-26）：本体 1:1 / 2:1，再接 AB/AFP 行星（按框号接），
    // 总速比 = 本体比号 × 行星比号；1:1 / 2:1 也可以本体单用（目录 1 级）。
    // 065/075/280 只有 1:1 本体（目录性能表里 2 比是「/」）。
    recordRatioIsTotal: false,
    bodyOnlyRatio: null,
    bodyOnlyRatios: Object.freeze([1, 2]),
    ratiosWithGearbox: Object.freeze({
      "65": [1], "75": [1],
      "90": [1, 2], "110": [1, 2], "140": [1, 2], "170": [1, 2],
      "210": [1, 2], "240": [1, 2], "280": [1]
    }),
    fallbackRatioWithGearbox: 1,
    planetaryOnlyFrames: Object.freeze([])
  })
});

/** 某个系列的比号规则；不认识的系列按 MTN 处理（老数据没有 series 字段时也走这里）。 */
export function seriesRules(series) {
  return SERIES_BODY_RULES[series] ?? SERIES_BODY_RULES.MTN;
}

function normalizeFrame(frameSize) {
  return String(frameSize ?? "").trim().replace(/^0+/, "");
}

/**
 * 这个型号有没有「能出选型结果」的三项硬数据：速比、额定输出转矩、最高输出转速。
 *
 * 三缺一，引擎就只能在 DATA 阶段把它挡住（见 selectMtn 的 missingData）；
 * 页面也不该把这种型号所在的系列列出来 —— 选了也只会得到「数据尚未补齐」。
 */
export function hasSelectionData(record) {
  if (!record || record.source?.kind === "PLACEHOLDER") return false;
  return Number.isFinite(record.ratio) &&
    Number.isFinite(record.ratedOutputTorque_Nm) &&
    Number.isFinite(record.maxOutputSpeed_rpm);
}

/**
 * 页面下拉可以展示的系列（所有者 2026-10-26：MTT 参数补齐前先不展示）。
 *
 * 规矩：至少有一条型号凑齐上面三项硬数据；占位行（HR）不算。
 * 加新系列时不用手改这个名单 —— 数据齐了它自动出现，页面护栏测试会要求下拉同步。
 */
export function selectableSeries(records) {
  const series = (records ?? [])
    .filter(hasSelectionData)
    .map(record => record.series)
    .filter(Boolean);
  return [...new Set(series)];
}

/** 接行星时，哪些框号的本体可以取 5 比（其余只能 10 比）。 */
export const BODY_RATIOS_WITH_GEARBOX = Object.freeze({ "60": [5, 10], "85": [5, 10] });

/**
 * 这个框号的本体，在当前配置下允许用哪些比号。
 *   withGearbox = false → MTN 只有 18（本体单用）；ZTT 没有本体单用，返回空数组
 *   withGearbox = true  → MTN60/85 有 5、10，其余 10；ZTT 一律 3
 */
export function bodyRatiosFor(frameSize, { withGearbox, series = "MTN" } = {}) {
  const rules = seriesRules(series);
  if (!withGearbox) return [...bodyOnlyRatiosOf(rules)];
  const ratios = rules.ratiosWithGearbox[normalizeFrame(frameSize)];
  return ratios ? [...ratios] : [rules.fallbackRatioWithGearbox];
}

/** 向后兼容：目录里出现过的本体比号（用于数据校验，不是可选集合）。 */
export const BODY_RATIOS = Object.freeze([5, 10, 15, 18]);

/**
 * 行星减速机的比号，按所有者 2026-10-21 给的两级：
 *   一级：3、4、5、6、7、8、10
 *   二级：12、15、20、25、30、35、40、50、60、70、80、100
 * 总速比 = 本体比号 × 行星比号；本体单用时行星比为 1。
 *
 * 目录里的 K/T 只是型号命名（K 行星、T 直角），与选型无关，别拿它反推比号。
 */
export const GEARBOX_LEVELS = Object.freeze({
  single: Object.freeze([3, 4, 5, 6, 7, 8, 10]),
  double: Object.freeze([12, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100])
});

/** 全部可选的行星比号（不含 1）。 */
export const GEARBOX_RATIOS = Object.freeze([...GEARBOX_LEVELS.single, ...GEARBOX_LEVELS.double]);

/** 这个行星比属于几级；不在表里返回 null。 */
export function gearboxLevelOf(ratio) {
  if (GEARBOX_LEVELS.single.includes(ratio)) return "single";
  if (GEARBOX_LEVELS.double.includes(ratio)) return "double";
  return null;
}
/** 需求转矩：工况转矩 × 安全系数（安全系数按《安全系数》表取，雏形里由调用方给）。 */
export function requiredTorque_Nm(outputTorque_Nm, safetyFactor = 1) {
  if (!Number.isFinite(outputTorque_Nm) || outputTorque_Nm <= 0) throw new Error("outputTorque_Nm must be a positive number");
  if (!Number.isFinite(safetyFactor) || safetyFactor <= 0) throw new Error("safetyFactor must be a positive number");
  return round(outputTorque_Nm * safetyFactor);
}

/** 电机档位（所有者 2026-10-22）：默认 3000 r/min 标准档；勾"高惯量"就用 1500 r/min 及以下。 */
export const MOTOR_SPEED_CLASSES = Object.freeze({
  standard: Object.freeze({ label: "3000 r/min 标准档", minRpm: 3000, maxRpm: Infinity }),
  highInertia: Object.freeze({ label: "1500 r/min 高惯量档", minRpm: 0, maxRpm: 1500 }),
  all: Object.freeze({ label: "全部转速", minRpm: 0, maxRpm: Infinity })
});

/**
 * 按"是否带抱闸 + 转速档"筛电机，并给每台挂上本次核算要用的惯量：
 *   带抱闸 → 用抱闸惯量（没有抱闸数据的型号直接剔除，不能拿转子惯量冒充）
 *   不带抱闸 → 用转子惯量
 * 扭矩一律只用额定转矩核算（所有者口径），不用最大转矩。
 */
export function buildMotorPool(motors, { withBrake = false, motorSpeedClass = "standard" } = {}) {
  if (!motors?.length) return [];
  const range = MOTOR_SPEED_CLASSES[motorSpeedClass] ?? MOTOR_SPEED_CLASSES.standard;
  return motors
    .filter(motor => Number.isFinite(motor.ratedSpeed_rpm) &&
      motor.ratedSpeed_rpm >= range.minRpm && motor.ratedSpeed_rpm <= range.maxRpm)
    .filter(motor => !withBrake || (Number.isFinite(motor.brakeInertia_kgm2) && motor.brakeInertia_kgm2 > 0))
    .map(motor => ({
      ...motor,
      effectiveInertia_kgm2: withBrake ? motor.brakeInertia_kgm2 : motor.rotorInertia_kgm2
    }));
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

/** 惯量按 ×10-4 kg·m² 显示（与电机表同口径；PDF 字体没有上标负号，用 ASCII 的 -4）。 */
function inertiaTimes10k(value) {
  const scaled = value * 1e4;
  const digits = Math.abs(scaled) >= 100 ? 1 : Math.abs(scaled) >= 10 ? 2 : 3;
  return String(Number(scaled.toFixed(digits)));
}

/**
 * 选型主函数。
 *
 * request（全部 SI）：
 *   outputTorque_Nm    工况折算到平台输出轴的转矩
 *   ratio              需要的总速比
 *   outputSpeed_rpm    需要的盘面输出转速
 *   safetyFactor       安全系数，默认 1
 *   loadInertia_kgm2   负载惯量（折算到平台输出轴）
 *   motor              可选：{ ratedTorque_Nm, rotorInertia_kgm2, maxSpeed_rpm }
 *   inertiaRatio       惯量比，默认 10（常用 5/10/20）。**它就是公式里那个数**：
 *                      电机所需惯量 = 折算到电机轴的负载惯量 ÷ 这个值，然后按电机转子惯量 ≥ 它来筛。
 *   bodyEfficiency     本体效率，默认 0.85
 *   gearboxEfficiency  行星减速机效率，默认 0.9（只在"本体+行星"时乘进去）
 *   efficiency         可选：直接给总效率，给了就盖过上面两个（老调用方兼容）
 *   withBrake          是否按"带抱闸"核算：是 → 惯量用抱闸惯量（brakeInertia_kgm2），
 *                      没有抱闸数据的型号直接不参与；扭矩仍然只按**额定转矩**算
 *   motorSpeedClass    "standard"（默认，3000 r/min 档）| "highInertia"（≤1500，高惯量）| "all"
 *
 * records：产品库里的 MTN 记录（每条带 ratio / ratedOutputTorque_Nm / maxOutputSpeed_rpm / modeling）
 * options.includeStatuses：默认 ["ACTIVE"]；雏形阶段可传 ["ACTIVE","DRAFT"]
 * options.fitment：本体规格 → 可配减速机型号的对照表（data/gearboxes/fitment-mtn.json）
 * options.gearboxCatalog：减速机性能表（data/gearboxes/planetary-catalog.json）；
 *                         给了它才会做减速机容量校核，没给就只报型号、注明"未校核"
 */
export function selectMtn(request, records, options = {}) {
  const {
    outputTorque_Nm,
    ratio,
    outputSpeed_rpm = null,
    safetyFactor = 1,
    loadInertia_kgm2 = null,
    motor = null,
    motors = null,
    inertiaRatio = 10,
    bodyEfficiency = 0.85,
    gearboxEfficiency = 0.9,
    efficiency = null,
    withBrake = false,
    motorSpeedClass = "standard"
  } = request ?? {};
  const includeStatuses = options.includeStatuses ?? ["ACTIVE"];
  const fitmentTable = options.fitment ?? null;
  /**
   * 取某个系列的配套表。两种形态都认：
   *   - 单张表（老调用方、测试里直接传 fitment-mtn.json 的内容）→ 对所有系列都用它；
   *   - 按系列分组的表 { MTN: {...}, ZTT: {...} } → 按 record.series 取。
   */
  const fitmentFor = series => {
    if (!fitmentTable) return null;
    if (Array.isArray(fitmentTable.fitment)) return fitmentTable;
    return fitmentTable[series] ?? null;
  };
  const gearboxCatalog = options.gearboxCatalog ?? null;
  const motorPool = buildMotorPool(motors, { withBrake, motorSpeedClass });

  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("ratio must be a positive number");
  if (!Number.isFinite(inertiaRatio) || inertiaRatio <= 0) throw new Error("inertiaRatio must be a positive number");
  const demandTorque = requiredTorque_Nm(outputTorque_Nm, safetyFactor);

  const candidates = [];
  const rejected = [];
  // 过了"速比"这一关的型号（后面报"转矩不够/行星不够"时只能说这批的上限）
  const reachedRatio = [];
  const notes = [];

  for (const record of records ?? []) {
    // 占位行（source.kind PLACEHOLDER）的数字是编的，任何状态下都不许参与选型；
    // 这与产品库"占位数据不能冒充真数据"是同一条底线。
    if (record.source?.kind === "PLACEHOLDER") {
      rejected.push({ model: record.model, stage: "DATA", reason: "占位记录：数据未经核实，不参与选型" });
      continue;
    }
    if (!includeStatuses.includes(record.status)) {
      rejected.push({ model: record.model, stage: "DATA", reason: "数据状态为 " + record.status + "，未参与选型" });
      continue;
    }

    // 本体比号：MTN 记录里的 ratio 就是本体比号；
    // ZTT 是按比号定型的 SKU（ZTT130-9-N 的 9 是总速比），本体固定 3 比，另记在 bodyRatio。
    const rules = seriesRules(record.series);
    const bodyRatio = rules.recordRatioIsTotal ? (record.bodyRatio ?? rules.bodyRatio) : record.ratio;
    const capacity = record.ratedOutputTorque_Nm;
    // 数据不全的型号先进 DATA 阶段，并把**缺哪几个字段**记下来：
    // MTT 系列先入库、参数后补（所有者 2026-10-26），页面要说"缺额定扭矩"而不是
    // "被数据状态挡住"（草稿其实已经参与了，说反了会让工程师以为勾错框）。
    const missingData = [];
    if (!Number.isFinite(bodyRatio)) missingData.push("速比");
    if (!Number.isFinite(capacity)) missingData.push("额定输出扭矩");
    if (!Number.isFinite(record.maxOutputSpeed_rpm)) missingData.push("最高输出转速");
    if (missingData.length) {
      rejected.push({ model: record.model, stage: "DATA", missingData,
        reason: "记录缺少" + missingData.join("、") + "（数据待补），未参与选型" });
      continue;
    }

    // 速比决策（比号规则见 SERIES_BODY_RULES）：
    //   MTN：需求速比 = 18 → 本体单用（也只有这一种可能，18 拆不出本体×行星）
    //        其余速比 → 本体比号必须在该框号允许的集合里（60/85 是 5、10，其余只有 10），
    //                   且"需求比 ÷ 本体比"正好是行星比号表里的一个。
    //   ZTT：按比号定型 —— 型号上的比号就是总速比，必须与需求一致；
    //        总速比 ÷ 本体 3 比 = 行星比号（9…300），没有本体单用。
    let kind = "BODY";
    let gearboxRatio = 1;
    let gearboxLevel = null;
    const bodyOnlyRatios = bodyOnlyRatiosFor(record.series);
    if (rules.bodyOnlySku) {
      // 换向器 XZT：型号就是成品，请求速比必须等于型号速比。
      if (record.ratio !== ratio) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: record.series + " 系列按型号定型：该型号为 " + record.ratio + ":1，与所选 " + ratio + ":1 不一致" });
        continue;
      }
      if (!bodyOnlyRatios.includes(record.ratio)) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: record.series + " 只做 " + bodyOnlyRatios.join(" / ") + ":1，该记录为 " + record.ratio + ":1" });
        continue;
      }
    } else if (rules.recordRatioIsTotal) {
      if (record.ratio !== ratio) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: record.series + " 系列按型号固定速比：该型号为 " + record.ratio + ":1，与所选 " + ratio + ":1 不一致" });
        continue;
      }
      const multiple = ratio / bodyRatio;
      const whole = Math.abs(multiple - Math.round(multiple)) < 1e-9;
      if (!whole || Math.round(multiple) < 1) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: "所选速比 " + ratio + ":1 无法由本体 " + bodyRatio + ":1 与现有行星减速机组合得到" });
        continue;
      }
      gearboxRatio = Math.round(multiple);
      if (gearboxRatio === 1) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: record.series + " 没有本体单用：" + ratio + " 比正好等于本体 " + bodyRatio + " 比，必须接行星" });
        continue;
      }
      gearboxLevel = gearboxLevelOf(gearboxRatio);
      if (!gearboxLevel) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: "行星减速机无 " + gearboxRatio + ":1 速比（可选范围：单级 3–10，双级 12–100）" });
        continue;
      }
      kind = "BODY_PLUS_GEARBOX";
    } else if (bodyOnlyRatios.includes(ratio)) {
      if (!allowsBodyOnly(record.frameSize, record.series)) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: record.series + record.frameSize + " 仅可与行星减速机配合使用，不支持单独使用本体" });
        continue;
      }
      if (bodyRatio !== ratio) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: "单独使用本体的型号速比须为 " + ratio + ":1，该记录为 " + bodyRatio + ":1" });
        continue;
      }
    } else {
      const allowedBodyRatios = bodyRatiosFor(record.frameSize, { withGearbox: true, series: record.series });
      if (!allowedBodyRatios.includes(bodyRatio)) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: "配合行星减速机时，该框号本体可选速比为 " + allowedBodyRatios.join(" / ") + ":1；" +
            (bodyOnlyRatios.length
              ? bodyOnlyRatios.join(" / ") + ":1 仅用于单独使用本体"
              : "该系列不支持单独使用本体") });
        continue;
      }
      const multiple = ratio / bodyRatio;
      const whole = Math.abs(multiple - Math.round(multiple)) < 1e-9;
      if (!whole || Math.round(multiple) < 1) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: "所选速比 " + ratio + ":1 无法由本体 " + bodyRatio + ":1 与现有行星减速机组合得到" });
        continue;
      }
      gearboxRatio = Math.round(multiple);
      if (gearboxRatio === 1) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: bodyOnlyRatios.length
            ? "单独使用本体时速比须为 " + bodyOnlyRatios.join(" / ") + ":1；" + bodyRatio +
              ":1 的本体须配合行星减速机才能达到 " + ratio + ":1"
            : record.series + " 系列不支持单独使用本体：所选速比等于本体比号 " + bodyRatio + ":1，须配合行星减速机" });
        continue;
      }
      gearboxLevel = gearboxLevelOf(gearboxRatio);
      if (!gearboxLevel) {
        rejected.push({ model: record.model,
          stage: "RATIO",
          reason: "行星减速机无 " + gearboxRatio + ":1 速比（可选范围：单级 3–10，双级 12–100）" });
        continue;
      }
      kind = "BODY_PLUS_GEARBOX";
    }
    const totalRatio = bodyRatio * gearboxRatio;
    const efficiencyTotal = efficiency ?? bodyEfficiency * (kind === "BODY_PLUS_GEARBOX" ? gearboxEfficiency : 1);

    // 核心硬条件：本体容许转矩 ≥ 需求（行星只放大扭矩，不放大本体容量）
    if (capacity < demandTorque) {
      // 记下"速比这一关过了"的型号：报"转矩不够"时只能说这批型号的上限，
      // 不能拿全库最大的 3500 N·m 去说事（那台根本凑不出这个比号）。
      reachedRatio.push({ model: record.model, series: record.series ?? "MTN", capacity, bodyRatio, gearboxRatio });
      rejected.push({ model: record.model,
        stage: "CAPACITY",
        reason: "容许转矩 " + capacity + " N·m 低于需求 " + demandTorque + " N·m" });
      continue;
    }

    const checks = { torque: true, speed: true, motor: true, inertia: true };
    const notesFor = [];
    // 电机一台都选不出来时，卡在哪一条（torque / speed / inertia）——报错要说对。
    let motorFailure = null;
    const speedWord = GEARBOX_SERIES.has(record.series) ? "输出转速" : "盘面转速";

    // 减速机容量校核（只在"本体 + 行星"且给了性能表时做）。
    // 减速机输出轴接的是本体输入轴，所以它承受的力矩 = 盘面需求 ÷ 本体比号；
    // 目录给的 ratedOutputTorque_Nm 正好是这个位置上的额定值。
    let gearboxPick = null;
    let gearboxRequired_Nm = null;
    let gearboxNote = null;
    if (kind === "BODY_PLUS_GEARBOX") {
      gearboxRequired_Nm = round(demandTorque / bodyRatio);
      const seriesFitment = fitmentFor(record.series);
      const fitted = seriesFitment ? gearboxesForFrameSize(seriesFitment, record.frameSize) : [];
      const known = [];
      for (const model of fitted) {
        const box = gearboxCatalog ? findGearbox(gearboxCatalog, model) : null;
        if (!box) { gearboxNote = "减速机 " + model + " 没有性能数据，容量未校核"; continue; }
        const rated = ratedTorqueAtRatio(box, gearboxRatio);
        if (rated === null) continue;                       // 这个型号没有这个比号
        known.push({
          model,
          known: true,
          ratedTorque_Nm: rated,
          requiredTorque_Nm: gearboxRequired_Nm,
          level: ratioLevel(gearboxCatalog, gearboxRatio),
          margin: round(rated / gearboxRequired_Nm, 2),
          maxInputSpeed_rpm: box.maxInputSpeed_rpm,
          backlash_arcmin: box.backlash_arcmin?.P2?.[ratioLevel(gearboxCatalog, gearboxRatio)] ?? null
        });
      }
      if (known.length) {
        const passing = known.filter(entry => entry.ratedTorque_Nm >= gearboxRequired_Nm)
          .sort((a, b) => a.margin - b.margin);
        if (!passing.length) {
          const best = known.slice().sort((a, b) => b.ratedTorque_Nm - a.ratedTorque_Nm)[0];
          reachedRatio.push({ model: record.model, series: record.series ?? "MTN", capacity, bodyRatio, gearboxRatio });
          rejected.push({ model: record.model,
            stage: "GEARBOX",
            reason: "行星减速机 " + best.model + " 额定转矩 " + best.ratedTorque_Nm + " N·m 低于本体输入侧需求 " +
              gearboxRequired_Nm + " N·m（" + demandTorque + " N·m ÷ 本体速比 " + bodyRatio + "）" });
          continue;
        }
        gearboxPick = passing[0];
        if (passing.length > 1) gearboxNote = "可配 " + known.map(entry => entry.model).join(" / ") +
          "，按余量最小选了 " + gearboxPick.model;
      }
      checks.gearbox = true;
    }

    if (outputSpeed_rpm !== null) {
      const platformLimit = record.maxOutputSpeed_rpm ?? Infinity;
      const motorLimit = motor?.maxSpeed_rpm ? motor.maxSpeed_rpm / totalRatio : Infinity;
      // 减速机自己也有最大输入转速（电机侧），比本体更靠前，所以一并取小
      const gearboxLimit = gearboxPick ? gearboxPick.maxInputSpeed_rpm / totalRatio : Infinity;
      const limit = Math.min(platformLimit, motorLimit, gearboxLimit);
      if (outputSpeed_rpm > limit) {
        checks.speed = false;
        notesFor.push(speedWord + " " + outputSpeed_rpm + " 超过上限 " + round(limit, 1) + " r/min");
      }
    }

    if (motor) {
      const motorTorqueNeeded = demandTorque / (totalRatio * efficiencyTotal);
      if (!(motor.ratedTorque_Nm >= motorTorqueNeeded)) {
        checks.motor = false;
        notesFor.push("电机额定转矩 " + motor.ratedTorque_Nm + " < 需要 " + round(motorTorqueNeeded) + " N·m");
      }
      const inertiaUsed = withBrake ? motor.brakeInertia_kgm2 : motor.rotorInertia_kgm2;
      if (loadInertia_kgm2 !== null && inertiaUsed) {
        // 折算到电机轴的负载惯量：J'' = J' / i² / 惯量比；再和电机惯量比大小。
        const reflected = (loadInertia_kgm2 + (record.tableInertia_kgm2 ?? 0)) / (totalRatio * totalRatio);
        const actualRatio = reflected / inertiaUsed;
        if (actualRatio > inertiaRatio + 1e-9) {
          checks.inertia = false;
          // 报的是**惯量**（J'' 与电机惯量），不是惯量比。
          notesFor.push("所需惯量 " + inertiaTimes10k(reflected / inertiaRatio) + " ×10-4 kg·m² 超过电机惯量 " +
            inertiaTimes10k(inertiaUsed) + " ×10-4 kg·m²（惯量比 " + inertiaRatio + "）");
        }
      }
    }

    // 有电机表时，直接把电机选出来（所有者流程里"先选电机"这一步）。
    let pickedMotor = null;
    let motorInertiaRequired = null;
    if (motorPool.length) {
      const motorTorqueNeeded = demandTorque / (totalRatio * efficiencyTotal);
      const motorSpeedNeeded = outputSpeed_rpm === null ? null : outputSpeed_rpm * totalRatio;
      // 这就是所有者说的那条公式：电机所需惯量 = 折算到电机轴的负载惯量 ÷ 惯量比。
      // 惯量比填多少，就按多少算（填 10 就是 ÷10，填 5 就是 ÷5，不再出现 2.8 这种小数）。
      const reflected = ((loadInertia_kgm2 ?? 0) + (record.tableInertia_kgm2 ?? 0)) / (totalRatio * totalRatio);
      motorInertiaRequired = loadInertia_kgm2 === null ? null : reflected / inertiaRatio;
      const pick = selectMotor(
        { torque_Nm: motorTorqueNeeded, speed_rpm: motorSpeedNeeded, reflectedInertia_kgm2: loadInertia_kgm2 === null ? null : reflected },
        motorPool,
        { maxInertiaRatio: inertiaRatio }
      );
      if (!pick.motor) {
        checks.motor = false;
        motorFailure = pick.failureConstraint ?? "torque";
        const reason = pick.rejected.length
          ? (pick.rejected.find(item => /所需惯量/.test(item.reason))?.reason ??
             pick.rejected.find(item => /额定转速/.test(item.reason))?.reason ??
             pick.rejected[pick.rejected.length - 1].reason)
          : "电机表里没有满足的型号";
        notesFor.push("电机表里没有满足的：" + reason);
      } else {
        pickedMotor = {
          model: pick.motor.model,
          brand: pick.motor.brand ?? null,
          seriesLabel: pick.motor.seriesLabel ?? null,
          power_W: pick.motor.power_W,
          ratedTorque_Nm: pick.motor.ratedTorque_Nm,
          ratedSpeed_rpm: pick.motor.ratedSpeed_rpm,
          rotorInertia_kgm2: pick.motor.rotorInertia_kgm2,
          brakeInertia_kgm2: pick.motor.brakeInertia_kgm2 ?? null,
          withBrake,
          motorSpeedClass,
          // 本次核算实际用的惯量（带抱闸 = 抱闸惯量；否则 = 转子惯量）
          effectiveInertia_kgm2: pick.motor.effectiveInertia_kgm2 ?? pick.motor.rotorInertia_kgm2,
          bindingConstraint: pick.bindingConstraint,
          neededTorque_Nm: round(motorTorqueNeeded),
          neededSpeed_rpm: motorSpeedNeeded === null ? null : round(motorSpeedNeeded, 1),
          inertiaRequired_kgm2: motorInertiaRequired === null ? null : round(motorInertiaRequired, 12)
        };
        // "往大一档"：**同品牌、同系列、同转速档**里，比这台功率大的最小一台
        // （例：汇川-R 400W → 550W）。不跨系列、不跨品牌去凑，否则客户买不到同一套驱动。
        const sameSeries = motorPool.filter(item => item.brand === pick.motor.brand &&
          item.seriesLabel === pick.motor.seriesLabel &&
          item.ratedSpeed_rpm === pick.motor.ratedSpeed_rpm);
        const bigger = sameSeries.filter(item => item.power_W > pick.motor.power_W)
          .sort((a, b) => a.power_W - b.power_W)[0] ?? null;
        pickedMotor.nextPower_W = bigger ? bigger.power_W : null;
        pickedMotor.nextModel = bigger ? bigger.model : null;
      }
    }

    candidates.push({
      model: record.model,
      size: record.frameSize,
      draft: record.status === "DRAFT",
      kind,
      bodyRatio,
      gearboxRatio,
      gearboxLevel,
      efficiency: round(efficiencyTotal, 4),
      // 这个规格框号可配的行星减速机型号（所有者 2026-10-21 给的对照表）；本体单用时为空
      gearboxes: kind === "BODY_PLUS_GEARBOX" && fitmentFor(record.series)
        ? gearboxesForFrameSize(fitmentFor(record.series), record.frameSize)
        : [],
      // 校核过的减速机：型号、比号、额定力矩、本体输入侧需求力矩、余量、背隙
      gearbox: gearboxPick,
      gearboxRequired_Nm,
      // 电机侧要多少：这两个数只跟"总速比 + 效率 + 惯量比"有关，与最后选哪台电机无关，
      // 所以没电机表时也算得出来（所有者 2026-10-22：要看到这个速比下的所需转矩与所需惯量）。
      motorTorqueNeeded_Nm: round(demandTorque / (totalRatio * efficiencyTotal), 3),
      // 表格的 J'' = J' ×10⁴ / i² / 惯量比 —— 这就是"电机所需惯量"（SI 里已换算回 kg·m²）
      motorInertiaNeeded_kgm2: motorInertiaRequired === null ? null : round(motorInertiaRequired, 12),
      // 折算的中间量，报告里要把账算给工程师看（表里 J22/J23「减速机惯量」那一格）：
      // 折算到电机轴 = (负载总惯量 + 本体盘面惯量) / 总速比²；再除惯量比才是 J''。
      tableInertia_kgm2: record.tableInertia_kgm2 ?? 0,
      reflectedInertia_kgm2: loadInertia_kgm2 === null
        ? null
        : (loadInertia_kgm2 + (record.tableInertia_kgm2 ?? 0)) / (totalRatio * totalRatio),
      totalRatio,
      capacity_Nm: capacity,
      demand_Nm: demandTorque,
      margin: round(capacity / demandTorque, 2),
      motor: pickedMotor,
      motorFailure,
      series: record.series,
      checks,
      notes: notesFor
    });
    if (gearboxNote) notesFor.push(gearboxNote);
  }

  // 选"够用且余量最小"的那个（雏形阶段的排序规则，业主确认后再谈权重）
  const usable = candidates.filter(candidate => Object.values(candidate.checks).every(Boolean));
  // 排序：先"不加行星"的（零件少、便宜），再按余量从小到大。
  // 否则"本体 10 比"会被"本体 5 比 + 2:1 行星"在余量相同时抢走——多一个零件却没好处。
  const parts = candidate => (candidate.kind === "BODY" ? 0 : 1);
  usable.sort((a, b) => parts(a) - parts(b) || a.margin - b.margin || a.capacity_Nm - b.capacity_Nm);

  let decision = "NONE";
  if (usable.length) decision = usable[0].kind;

  // ---- 没有结果时：说清到底卡在哪一步（所有者 2026-10-26）----
  // 之前所有"没结果"都归结成"没有型号的容许转矩 ≥ 需求"，方向会错：
  // 例如拿 50 比去选 ZTT，本体 3 比 × 行星比号根本凑不出 50，真正的原因是速比不可达。
  const counts = { data: 0, ratio: 0, capacity: 0, gearbox: 0, checks: candidates.length };
  for (const entry of rejected) {
    if (entry.stage === "DATA") counts.data += 1;
    else if (entry.stage === "RATIO") counts.ratio += 1;
    else if (entry.stage === "CAPACITY") counts.capacity += 1;
    else if (entry.stage === "GEARBOX") counts.gearbox += 1;
  }

  let failure = null;
  if (decision === "NONE") {
    const reachable = reachableTotalRatios(records);
    const nearest = nearestRatios(reachable, ratio, 3);
    const nearHint = nearest.length ? "，最接近的可行比号：" + nearest.join(" / ") : "";

    if (!candidates.length) {
      // 一条候选都没进来：看**最远走到哪一步**，而不是"哪个阶段挡掉的最多"。
      // 例：2000 kg 的负载，77 条卡在速比（每条型号只适配部分比号，这很正常）、
      // 15 条过了速比但转矩不够 —— 真正的原因是转矩不够，说成"速比凑不出来"又会误导。
      const dominant = counts.gearbox > 0 ? "GEARBOX"
        : counts.capacity > 0 ? "CAPACITY"
        : counts.ratio > 0 ? "RATIO"
        : "DATA";

      if (dominant === "DATA") {
        // 两种"DATA"要分开说：数据状态被挡（没勾草稿） vs 型号已入库但参数没补。
        const missingRows = rejected.filter(entry => entry.stage === "DATA" && Array.isArray(entry.missingData));
        if (missingRows.length && missingRows.length === counts.data) {
          const fields = [...new Set(missingRows.flatMap(entry => entry.missingData))];
          const models = missingRows.map(entry => entry.model);
          failure = {
            stage: "DATA",
            headline: "所选系列的数据尚未补齐：" + models.length + " 条型号缺少" + fields.join("、") +
              "，暂无法出选型结果",
            detail: "待补型号：" + models.slice(0, 6).join("、") + (models.length > 6 ? " 等" : "") +
              "。这些型号已入库为草稿（DRAFT），数据由技术部确认后录入；补齐前不参与推荐。",
            counts, nearestRatios: nearest
          };
        } else {
          failure = {
            stage: "DATA",
            headline: "无可用型号：当前产品库中的型号均为草稿或占位数据，未参与选型",
            detail: "如需按草稿数据核算，请勾选「含草稿数据」后重新计算；正式选型应在数据转为正式状态后进行。",
            counts, nearestRatios: nearest
          };
        }
      } else if (dominant === "RATIO") {
        // 速比为什么凑不出来，要按系列说：XZT 根本没有行星（只有 1/2），
        // 说"行星比只有 3–10 / 12–100"会把人带偏。
        const seriesSet = [...new Set((records ?? []).map(record => record.series).filter(Boolean))];
        let ratioDetail;
        if (seriesSet.length === 1 && seriesSet[0] === "XZT") {
          ratioDetail = "XZT 是换向器本体，只有 1:1 和 2:1 两种速比（不接行星），请改用上列速比。";
        } else if (seriesSet.length === 1 && seriesSet[0] === "XZTF") {
          ratioDetail = "XZTF 总速比 = 本体比号（1 / 2）× 行星比号（单级 3–10、双级 12–100），请改用上列速比。";
        } else {
          ratioDetail = "总速比 = 本体速比 × 行星速比；行星速比仅有单级 3–10、双级 12–100，建议改用上列速比。";
        }
        failure = {
          stage: "RATIO",
          headline: "所选速比 " + ratio + ":1 暂无型号可选" +
            (counts.ratio === 0 ? "" : "（" + counts.ratio + " 条型号均不满足速比条件）") + nearHint,
          detail: ratioDetail,
          counts, nearestRatios: nearest
        };
      } else if (dominant === "CAPACITY") {
        // 只能说"过了速比关的那批"的上限。拿全库最大去比会自相矛盾：
        // 例如 24 比只有 ZTT 凑得出（3 × 8），而 3500 N·m 那个 MTN700 根本到不了 24 比。
        const best = reachedRatio.slice().sort((a, b) => b.capacity - a.capacity)[0] ?? null;
        const reachSeries = [...new Set(reachedRatio.map(item => item.series))];
        const allSeries = [...new Set((records ?? [])
          .filter(record => record.source?.kind !== "PLACEHOLDER" && record.series)
          .map(record => record.series))];
        const otherSeries = allSeries.filter(series => !reachSeries.includes(series));
        const otherHints = otherSeries.map(series => {
          const maxCapacity = Math.max(0, ...(records ?? [])
            .filter(record => record.series === series && record.source?.kind !== "PLACEHOLDER" &&
              Number.isFinite(record.ratedOutputTorque_Nm))
            .map(record => record.ratedOutputTorque_Nm));
          return series + " 系列最大容许转矩 " + maxCapacity + " N·m，但无 " + ratio + ":1 速比型号";
        });
        const who = reachSeries.length
          ? "该速比仅 " + reachSeries.join(" / ") + " 系列可选"
          : "该速比无型号可选";
        failure = {
          stage: "CAPACITY",
          headline: "速比条件可满足，但容许转矩不足：" + who + "；其中最大为 " +
            (best ? best.model + " " + best.capacity + " N·m" : "—") + "，低于需求 " + demandTorque + " N·m",
          detail: otherHints.length
            ? otherHints.join("；") + "。建议改用具备该速比的系列，或降低工况需求（减小负载 / 降低安全系数）。"
            : "建议选用更大框号，或降低工况需求（减小负载 / 降低安全系数）。",
          counts, nearestRatios: nearest,
          reachSeries,
          capacityMax_Nm: best ? best.capacity : null,
          capacityMaxModel: best ? best.model : null
        };
      } else {
        failure = {
          stage: "GEARBOX",
          headline: "速比与本体容量均满足，但无可承受该转矩的行星减速机" +
            "（行星减速机按本体输入侧需求校核）",
          detail: "建议选用更大框号的行星减速机，或降低工况需求。",
          counts, nearestRatios: nearest
        };
      }
    } else {
      // 有候选，但某项校核没过：把"哪一项、几条"说清楚。
      // 电机选不出来时按"转矩 / 转速 / 惯量"分开报：XZT 1 比带 15 kg 负载，实际卡在
      // 所需惯量（625 ×10-4）远大于电机惯量，说成"额定转矩或额定转速不足"会让人白换电机功率。
      const failing = { speed: [], torque: [], motorSpeed: [], inertia: [] };
      const push = (list, model) => { if (!list.includes(model)) list.push(model); };
      for (const candidate of candidates) {
        if (!candidate.checks.speed) push(failing.speed, candidate.model);
        if (!candidate.checks.motor) {
          if (candidate.motorFailure === "inertia") push(failing.inertia, candidate.model);
          else if (candidate.motorFailure === "speed") push(failing.motorSpeed, candidate.model);
          else push(failing.torque, candidate.model);
        }
        if (!candidate.checks.inertia) push(failing.inertia, candidate.model);
      }
      const gearboxOnly = candidates.every(candidate => GEARBOX_SERIES.has(candidate.series));
      const labels = {
        speed: (gearboxOnly ? "输出转速" : "盘面转速") + "超过上限",
        torque: "电机额定转矩不足",
        motorSpeed: "电机额定转速不足",
        inertia: "所需惯量超过电机惯量"
      };
      const parts2 = Object.entries(failing)
        .filter(([, list]) => list.length)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([key, list]) => labels[key] + "（" + list.length + " 条：" + list.slice(0, 3).join("、") +
          (list.length > 3 ? " 等" : "") + "）");
      failure = {
        stage: "CHECKS",
        headline: "本体容量满足，但以下校核未通过：" + (parts2.join("；") || "未知"),
        detail: "",   // 具体原因在下面按型号列出，这里不再重复一遍
        counts, nearestRatios: nearest
      };
    }
    notes.push(failure.headline);
  }

  return {
    demand_Nm: demandTorque,
    decision,
    choice: usable[0] ?? null,
    candidates,
    rejected,
    failure,
    notes
  };
}

/** 这个库能凑出来的总速比（凑不出来时用来给"最接近的可行比号"）。 */
function reachableTotalRatios(records) {
  const set = new Set();
  for (const record of records ?? []) {
    if (record.source?.kind === "PLACEHOLDER") continue;
    const rules = seriesRules(record.series);
    if (rules.recordRatioIsTotal) {
      if (Number.isFinite(record.ratio)) set.add(record.ratio);
      continue;
    }
    if (rules.bodyOnlySku) {
      // 换向器 XZT：型号就是成品，能凑出的就是库里有的型号比号。
      if (Number.isFinite(record.ratio)) set.add(record.ratio);
      continue;
    }
    const bodyOnlyRatios = bodyOnlyRatiosFor(record.series);
    if (bodyOnlyRatios.length && allowsBodyOnly(record.frameSize, record.series)) {
      for (const bodyRatio of bodyOnlyRatios) {
        // 只有库里真的有这个本体比号的记录，才算可达（065/075/280 没有 2 比）。
        if (records.some(item => item.series === record.series &&
          normalizeFrame(item.frameSize) === normalizeFrame(record.frameSize) &&
          item.ratio === bodyRatio)) {
          set.add(bodyRatio);
        }
      }
    }
    for (const bodyRatio of bodyRatiosFor(record.frameSize, { withGearbox: true, series: record.series })) {
      // 本体单用只有 bodyOnlyRatio 那一档（MTN 的 18），上面已经加过；
      // 这里只枚举"配合行星"的组合（MTT/ZTT 没有本体单用，自然也不会多出本体比号）。
      for (const gearboxRatio of GEARBOX_RATIOS) set.add(bodyRatio * gearboxRatio);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function nearestRatios(list, ratio, count = 3) {
  return list.slice()
    .sort((a, b) => Math.abs(a - ratio) - Math.abs(b - ratio))
    .slice(0, count)
    .sort((a, b) => a - b);
}

/**
 * 速比枚举：把"可调空间"摊开给工程师看（所有者 2026-10-21 的口径）。
 *
 * 他的做法：先算工况最终的扭矩、以及**工况转速允许的最大速比**；但不会按最大速比一刀切——
 * 有余量就选小一点（例如最大 100 时取 70 或 50），因为速比小 → 电机扭矩要求变大；
 * 如果客户想降低电机功率，再把速比放大试试。除非允许的最大速比本身很小，那就没得选。
 *
 * 返回：
 *   maxRatio  工况允许的最大总速比（= 电机额定转速 / 工况输出转速）
 *   rows      每个可行组合：本体型号 × 行星比 → 总速比、本体余量、电机、电机功率、惯量比
 *   stable    稳妥推荐：不超过 maxRatio × stableFactor 的最大速比那一档
 *   smallestMotor 电机功率最小的那一档（= 速比最大的那一档，用来回答"能不能再降功率"）
 */
export function selectMtnOptions(request, records, options = {}) {
  const outputSpeed = request?.outputSpeed_rpm;
  const motorSpeed = request?.motorRatedSpeed_rpm ?? 3000;
  const maxRatio = request?.maxRatio ?? (outputSpeed ? motorSpeed / outputSpeed : null);
  if (!Number.isFinite(maxRatio) || maxRatio <= 0) {
    throw new Error("need maxRatio, or outputSpeed_rpm (plus motorRatedSpeed_rpm) to compute it");
  }
  const gearboxRatios = options.gearboxRatios ?? [1, ...GEARBOX_RATIOS];
  const stableFactor = options.stableFactor ?? 0.7;

  const rows = [];
  for (const record of records ?? []) {
    for (const gearboxRatio of gearboxRatios) {
      const totalRatio = record.ratio * gearboxRatio;
      if (totalRatio > maxRatio + 1e-9) continue;
      const single = selectMtn({ ...request, ratio: totalRatio }, [record], options);
      const candidate = single.choice ?? single.candidates[0];
      if (!candidate) continue;
      rows.push({
        model: candidate.model,
        kind: candidate.kind,
        bodyRatio: candidate.bodyRatio,
        gearboxRatio,
        // 校核过就报校核过的那个型号；没性能表时退回对照表里的可配型号
        gearboxModel: candidate.gearbox?.model ?? candidate.gearboxes?.[0] ?? null,
        gearboxMargin: candidate.gearbox?.margin ?? null,
        totalRatio,
        margin: candidate.margin,
        motorPower_W: candidate.motor?.power_W ?? null,
        motorModel: candidate.motor?.model ?? null,
        motorInertiaRequired_kgm2: candidate.motor?.inertiaRequired_kgm2 ?? null,
        usable: Object.values(candidate.checks).every(Boolean),
        notes: candidate.notes
      });
    }
  }

  // 同一个总速比只留最划算的一条（本体优先、余量小优先），否则"稳妥档"会被
  // 余量大得多的型号抢走（例如总速比 40 时 MTN450 和 MTN85+8:1 都可行）。
  const bestPerRatio = new Map();
  for (const row of rows) {
    const current = bestPerRatio.get(row.totalRatio);
    const better = !current ||
      (row.kind === "BODY" && current.kind !== "BODY") ||
      (row.kind === current.kind && row.margin < current.margin);
    if (better) bestPerRatio.set(row.totalRatio, row);
  }
  const deduped = [...bestPerRatio.values()].sort((a, b) => a.totalRatio - b.totalRatio);
  rows.length = 0;
  rows.push(...deduped);

  // 能不能用，由选型本身决定（转速/本体容量）；电机只是其中一项，没给电机表也要能枚举。
  const usable = rows.filter(row => row.usable);

  // 稳妥档：不超过 maxRatio×stableFactor 的最大速比；没有就用最小速比
  const under = usable.filter(row => row.totalRatio <= maxRatio * stableFactor + 1e-9);
  const stable = (under.length ? under[under.length - 1] : usable[0]) ?? null;

  // 最省电机档：电机功率最小（速比通常最大）；没给电机表时为空
  const withMotor = usable.filter(row => row.motorPower_W !== null);
  // 功率最小的那档；功率相同时取**速比更大**的那档（"想降功率就放大速比"，同一台电机下速比大的更稳）
  const smallestMotor = withMotor.reduce((best, row) =>
    best === null || row.motorPower_W <= best.motorPower_W ? row : best, null);

  return { maxRatio, stableFactor, rows, stable, smallestMotor };
}

