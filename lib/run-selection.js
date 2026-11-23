// 纯计算层：一次选型（runSelection）。**没有任何 node: 依赖**，浏览器里也能直接跑。
//
// 为什么单独一个文件（2026-10-27，A 方案）：静态版把整个引擎搬进浏览器算，
// 页面 import 的就是这里；Node 侧的 `selection-service.mjs` 只负责"读文件 + 组装 data"，
// 然后调用同一个 runSelection —— 所以网页算的和命令行算的仍然是同一套逻辑。
//
// 输入是客户参数表（选型分类.xlsx 的 1.1/1.2/1.3）那种字段，输出是：
//   工况（惯量/扭矩/盘面转速/最大允许速比）→ 推荐（本体 / 本体+行星 / 减速机 / 电机）
//   → 候选表 + 被排除的原因 + 速比可调空间

import { dutyFromCustomer, loadInertia_kgm2, stationInertia_kgm2 } from "./mtn-duty.js";
import { standaloneSelectionRecords, standaloneSeriesIn, isStandaloneGearboxSeries } from "./standalone-gearbox.js";
import { MOTOR_SPEED_CLASSES, buildMotorPool, selectMtn, selectMtnOptions } from "./mtn-select.js";
import { motorsOfBrand } from "./motor-filter.js";
import {
  GEARBOX_SERIES as GEARBOX_SERIES_LIST,
  resolveOutputForm,
  outputCode,
  outputFormApplies
} from "./output-types.js";

/** 换向器系列（产品库 family = gearbox），选型时按"本体 / 本体+行星"处理。 */
export const GEARBOX_SERIES = new Set(GEARBOX_SERIES_LIST);

/**
 * 换向器记录 → 选型引擎认识的形状。
 *
 * 换向器目录给的是**额定输入转速**（XZT 3000、XZTF 280 的 1500 等），没有"盘面最高转速"，
 * 所以把输出侧上限折算成 `额定输入转速 ÷ 本体比号`（行星那一段的上限由行星表另外管）。
 */
export function gearboxToSelectionRecord(record) {
  const ratedInput = Number.isFinite(record.ratedInputSpeed_rpm) ? record.ratedInputSpeed_rpm : null;
  const ratio = Number.isFinite(record.ratio) && record.ratio > 0 ? record.ratio : null;
  return {
    model: record.model,
    series: record.series,
    frameSize: record.frameSize,
    ratio: record.ratio,
    ratedOutputTorque_Nm: record.ratedOutputTorque_Nm,
    peakOutputTorque_Nm: record.peakOutputTorque_Nm,
    maxOutputSpeed_rpm: ratedInput && ratio ? ratedInput / ratio : undefined,
    status: record.status,
    source: record.source,
    family: "gearbox"
  };
}

function num(value, fallback, name) {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) throw new Error(name + " 是必填项");
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(name + " 必须是数字");
  return parsed;
}

function round(value, digits = 3) {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

const SHAPES = new Set(["box", "disc", "cylinder-perpendicular", "cylinder-parallel"]);
const MOUNTINGS = new Set(["horizontal", "hanging", "side"]);

/**
 * 一次选型。
 *
 * input（全部是客户参数表里的量）：
 *   productSeries   **必填**：MTN / ZTT / XZT / XZTF（MTT 数据没齐，会出现"数据尚未补齐"）。
 *                   只在这一个系列的型号里选；"全部系列"（平台 + 换向器混排）已于 2026-10-26 取消。
 *   mode            "intermittent"（间歇：θ/t）| "continuous"（连续：转速 + 已知负载转矩）
 *   mounting        "horizontal" | "hanging" | "side"
 *   load            { shape, mass_kg, sideA_mm, sideB_mm, diameter_mm, outerDiameter_mm, innerDiameter_mm, length_mm }
 *   eccentricity_mm 偏心距
 *   stations        多工位（1.1 表 B19–C26）：{ count, massEach_kg, sideC_mm, sideD_mm, offset_mm }。
 *                   工件盘（load）之外，盘上再均布 count 个工件，每个 massEach_kg、截面 c×d、
 *                   中心到旋转轴 offset_mm。不传 = 单件工况（工件本体就是盘）。
 *   theta_deg / cycleTime_s / accelTime_s   间歇工况
 *   decelTime_s                             间歇工况的减速时间；不给就跟随 accelTime_s（t3 = t1）
 *   outputSpeed_rpm / loadTorque_Nm         连续工况
 *   ratio           工程师自己输入的速比
 *   safetyFactor    安全系数 KA（间歇默认 1.5；连续也乘在负载转矩上）
 *   inertiaRatio    惯量比，默认 10（常用 5/10/20）。电机所需惯量 = 折算惯量 ÷ 它
 *   withBrake       带抱闸（惯量用抱闸惯量；没有抱闸数据的型号不参与）
 *   highInertia     高惯量档（1500 r/min 及以下）；不勾就是 3000 r/min 标准档
 *   bodyEfficiency  本体效率，默认 0.85
 *   gearboxEfficiency 减速机效率，默认 0.9（只在"本体+行星"时乘）
 *   outputType      换向器输出型式：形态 id（clamp-double）或目录代号（FC / C），空 = 默认 FC。
 *                   只影响订货代号与法兰尺寸，**不参与任何扭矩/惯量计算**；平台（MTN/ZTT/MTT）
 *                   没有输出型式，传了也不报错、结果里 applies = false。
 *   brands          电机品牌过滤，例如 ["Inovance","Omron"]；空 = 全部
 *   includeDrafts   是否让 DRAFT 参与（当前库里全是 DRAFT，不勾就没得选）
 */
export function runSelection(input, data, options = {}) {
  if (!data) throw new Error("selection data is not loaded");
  const mode = input?.mode === "continuous" ? "continuous" : "intermittent";
  if (data.motorProblems?.length) throw new Error("电机表有问题：" + data.motorProblems[0]);

  // 产品系列**必填**（所有者 2026-10-26 晚：「全部系列选项不要了吧，容易增加不少问题，
  // 而且实际选肯定是能确定型号的」）。所以这里不再有"平台 + 换向器混一张表"的分支：
  // 说清是哪一个系列，就只在那一个系列的型号里选。写错 / 不写都直接报中文错。
  const productSeries = typeof input.productSeries === "string" ? input.productSeries.trim() : "";
  // 单独减速机（AB / ABR / AFP / AFPR / AD / ADR）：所有者 2026-11-23 加进旋转工况选型。
  // 它们的记录不在 data.selectionRecords 里，而是从减速机性能表按「型号-速比」现展开。
  const standaloneCatalogSeries = standaloneSeriesIn(data.gearboxCatalog);
  const knownSeries = [...new Set([
    ...(data.selectionRecords ?? data.records)
      .filter(record => record.source?.kind !== "PLACEHOLDER")
      .map(record => record.series)
      .filter(Boolean),
    ...standaloneCatalogSeries
  ])];
  const isStandaloneGearbox = isStandaloneGearboxSeries(productSeries);
  if (!productSeries) {
    // 报错里只列**页面上真能选**的系列（MTT 参数没齐，不在这里面），免得指个选项却没有。
    throw new Error("请选择产品系列：" + knownSeries.join(" / ") +
      "（平台、单独减速机与换向器分开选，不再混在一张候选表里）。");
  }
  if (productSeries === "all") {
    throw new Error("「全部系列」已取消（所有者 2026-10-26）：平台、单独减速机与换向器分开选，请指定 " +
      knownSeries.join(" / ") + " 之一。");
  }
  if (!knownSeries.includes(productSeries)) {
    throw new Error("未找到产品系列「" + productSeries + "」。可选系列：" + knownSeries.join(" / ") + "。");
  }
  const isGearboxProduct = GEARBOX_SERIES.has(productSeries) || isStandaloneGearbox;
  // 输出型式（换向器订货代号）。**不参与计算**：只决定结果里写 FC / C 这种代号。
  // 空 = 默认 FC；写错（"FCX"）当场报中文错，不悄悄当成默认值——否则客户以为选的是别的型式。
  const outputForm = resolveOutputForm(input.outputType);
  const outputDefaulted = input.outputType === undefined || input.outputType === null || input.outputType === "";

  const safetyFactor = num(input.safetyFactor, 1.5, "安全系数");
  const ratio = num(input.ratio, undefined, "速比 i");
  if (ratio <= 0) throw new Error("速比 i 必须是正数");
  const inertiaRatio = num(input.inertiaRatio, num(input.maxInertiaRatio, 10, "惯量比"), "惯量比");
  // 换向器本体效率按目录 94%（XZT / XZTF 性能表「满载效率 ≤94%」）；平台仍默认 0.85。
  // 单独减速机的效率由用户填（所有者 2026-11-23），页面发 gearboxEfficiency，不按型号自动取。
  const defaultBodyEfficiency = isGearboxProduct ? 0.94 : 0.85;
  const bodyEfficiency = num(input.bodyEfficiency, defaultBodyEfficiency, "本体效率");
  const gearboxEfficiency = num(input.gearboxEfficiency, 0.9, "减速机效率");
  if (inertiaRatio <= 0) throw new Error("惯量比必须是正数");
  if (bodyEfficiency <= 0 || bodyEfficiency > 1) throw new Error("本体效率要在 0–1 之间（例如 0.85）");
  if (gearboxEfficiency <= 0 || gearboxEfficiency > 1) throw new Error("减速机效率要在 0–1 之间（例如 0.9）");
  // 单独减速机没有"本体 × 行星"两级：它自己的效率就是用户填的「减速机效率」。
  const efficiency = isStandaloneGearbox ? gearboxEfficiency : bodyEfficiency * gearboxEfficiency;
  const withBrake = input.withBrake === true;
  // 所有者 2026-11-23：不再分"3000 标准档 / 1500 高惯量档"——电机按**自己的额定转速**核算，
  // 页面只给一个"电机额定转速上限"：3000 的电机按 3000、1500 的按 1500、2000 的按 2000，
  // 各自用 ratedSpeed 过转速校核（见 selectMtr / selectMtn 里的 targetSpeed 检查）。
  // 旧的 highInertia / motorSpeedClass 仍兼容（API 老调用方），页面不再发。
  const motorSpeedClass = input.motorSpeedClass ??
    (input.highInertia === true ? "highInertia" : "all");
  if (!MOTOR_SPEED_CLASSES[motorSpeedClass]) throw new Error("电机档位只能是 standard / highInertia / all");
  const motorRatedSpeed_input = num(input.motorRatedSpeed_rpm, 3000, "电机额定转速上限");
  if (motorRatedSpeed_input <= 0) throw new Error("电机额定转速上限必须是正数");
  const motorRatedSpeed_rpm = motorSpeedClass === "highInertia"
    ? Math.min(motorRatedSpeed_input, MOTOR_SPEED_CLASSES.highInertia.maxRpm)
    : motorRatedSpeed_input;
  const mounting = input.mounting ?? "horizontal";
  if (!MOUNTINGS.has(mounting)) throw new Error("安装方向只能是 horizontal / hanging / side");

  const shape = input.load?.shape ?? "box";
  if (!SHAPES.has(shape)) throw new Error("负载形状无效：" + shape);
  const mass = num(input.load?.mass_kg, undefined, "负载质量");
  if (mass <= 0) throw new Error("负载质量必须是正数");

  const load = {
    shape,
    mass_kg: mass,
    sideA_mm: num(input.load?.sideA_mm, 0),
    sideB_mm: num(input.load?.sideB_mm, 0),
    diameter_mm: num(input.load?.diameter_mm, 0),
    outerDiameter_mm: num(input.load?.outerDiameter_mm, 0),
    innerDiameter_mm: num(input.load?.innerDiameter_mm, 0),
    length_mm: num(input.load?.length_mm, 0)
  };
  const eccentricity_mm = num(input.eccentricity_mm, 0);
  // 多工位（《选型分类》1.1 表 B19–C26）：工件盘上均布 n 个工件，每个 m2、截面 c×d、
  // 中心到旋转轴 L2。校验在 mtn-duty 里做（同一套规则给页面、命令行、报告用）。
  // 这里先算一次，是因为**连续工况**不经过 dutyFromCustomer，也要把工位惯量算进总惯量。
  const stations = stationInertia_kgm2(input.stations);

  let duty = null;
  let demandTorque;
  let outputSpeed;
  let loadInertia;
  let maxRatio;

  if (mode === "intermittent") {
    duty = dutyFromCustomer({
      load,
      mounting,
      eccentricity_mm,
      theta_deg: num(input.theta_deg, undefined, "一次转多少度"),
      cycleTime_s: num(input.cycleTime_s, undefined, "转动一次用时"),
      accelTime_s: num(input.accelTime_s, 0.5),
      // 减速时间：页面默认跟着加速时间；用户单独填了才发上来，没发（null）就由工况层按 t3 = t1 处理。
      decelTime_s: num(input.decelTime_s, null, "减速时间"),
      bodyRatio: 1,
      selectedRatio: ratio,
      motorRatedSpeed_rpm,
      safetyFactor,
      efficiency,
      stations: input.stations
    });
    demandTorque = duty.torqueTotal_Nm;        // 已含安全系数
    outputSpeed = duty.outputSpeed_rpm;
    loadInertia = duty.inertiaTotal_kgm2;
    maxRatio = duty.maxRatio;
  } else {
    // 连续工况：公司表只给转速、没有扭矩口径，所以这里要求填"已知负载转矩"，
    // 需求 = 负载转矩 × KA。不自作聪明去猜加速曲线。
    const loadTorque = num(input.loadTorque_Nm, undefined, "连续工况的负载转矩");
    outputSpeed = num(input.outputSpeed_rpm, undefined, "连续工况的输出转速");
    if (loadTorque <= 0) throw new Error("负载转矩必须是正数");
    if (outputSpeed <= 0) throw new Error("输出转速必须是正数");
    demandTorque = loadTorque * safetyFactor;
    loadInertia = loadInertia_kgm2(load) + mass * (eccentricity_mm / 1000) ** 2 + stations.total_kgm2;
    maxRatio = motorRatedSpeed_rpm / outputSpeed;
  }

  const statuses = input.includeDrafts === false ? ["ACTIVE"] : ["ACTIVE", "DRAFT"];
  const brands = Array.isArray(input.brands) ? input.brands.filter(Boolean) : [];
  // 按"品牌系列"筛（汇川-R / 汇川-Z / 欧姆龙-1S）。页面默认只勾汇川-R；
  // 传了 seriesLabels 就按系列筛，否则退回按品牌筛（老调用方兼容）。
  const seriesLabels = Array.isArray(input.seriesLabels) ? input.seriesLabels.filter(Boolean) : [];
  // 电机池：≤ 用户填的"额定转速上限"，再交给 selectMtn 按各自的 ratedSpeed 校核。
  const motors = (seriesLabels.length
    ? data.motors.filter(motor => seriesLabels.includes(motor.seriesLabel))
    : motorsOfBrand(data.motors, brands))
    .filter(motor => !Number.isFinite(motor.ratedSpeed_rpm) || motor.ratedSpeed_rpm <= motorRatedSpeed_rpm);

  // 记录来源：平台（MTN / ZTT / MTT / HL / BX）在 data.records；换向器（XZT / XZTF）在
  // data.gearboxRecords；单独减速机（AB / ABR / AFP / AFPR / AD / ADR）从性能表现展开成
  // 「型号-速比」——它不在产品库的记录里，但性能表本来就是它的额定转矩来源。
  // 只取**这一个系列**的记录——"全部系列"混排已于 2026-10-26 晚取消（见上面的必填校验）。
  const gearboxSelectionRecords = (data.gearboxRecords ?? []).map(gearboxToSelectionRecord);
  const records = isStandaloneGearbox
    ? standaloneSelectionRecords(data.gearboxCatalog, { series: productSeries })
    : GEARBOX_SERIES.has(productSeries)
      ? gearboxSelectionRecords.filter(record => record.series === productSeries)
      : data.records.filter(record => record.series === productSeries);

  const request = {
    outputTorque_Nm: demandTorque,
    safetyFactor: 1,                 // 工况里已经乘过 KA
    ratio,
    outputSpeed_rpm: outputSpeed,
    loadInertia_kgm2: loadInertia,
    motors,
    motorRatedSpeed_rpm,
    inertiaRatio,
    bodyEfficiency,
    gearboxEfficiency,
    withBrake,
    motorSpeedClass
  };
  const engineOptions = {
    includeStatuses: statuses,
    fitment: data.fitment,
    gearboxCatalog: data.gearboxCatalog
  };

  const result = selectMtn(request, records, engineOptions);
  const space = selectMtnOptions({ ...request, maxRatio }, records, {
    ...engineOptions,
    stableFactor: num(input.stableFactor, 0.7)
  });

  // 候选表按"余量从小到大"（够用就好），本体优先的规则在 selectMtn 里已经用过
  const candidates = result.candidates.slice().sort((a, b) =>
    (a.kind === "BODY" ? 0 : 1) - (b.kind === "BODY" ? 0 : 1) || a.margin - b.margin);

  // 输出型式落在哪一类产品上：选到型号就用它的系列；没选到时就是这次问的那个系列。
  // 平台（MTN / ZTT / MTT）没有输出型式 —— applies = false，报告与页面据此不印这一行。
  const outputSeries = result.choice?.series ?? productSeries;
  const outputApplies = Boolean(outputSeries && outputFormApplies(outputSeries));

  return {
    ok: true,
    mode,
    productSeries,
    // 产品形态（页面/报告换措辞用）：platform（平台/整机）| standaloneGearbox（单独减速机）| commutator（换向器）
    productType: isStandaloneGearbox ? "standaloneGearbox"
      : GEARBOX_SERIES.has(productSeries) ? "commutator" : "platform",
    productSeriesOptions: knownSeries,
    // 换向器输出型式（订货代号）：形式 + 这一台产品对应的代号（平台为 null）
    output: {
      form: outputForm.id,
      label: outputForm.zh,
      structure: outputForm.structure,
      side: outputForm.side,
      series: outputSeries,
      applies: outputApplies,
      code: outputApplies ? outputCode(outputForm, outputSeries) : null,
      defaulted: outputDefaulted
    },
    duty: duty && {
      omega_rad_s: round(duty.omega_rad_s, 4),
      beta_rad_s2: round(duty.beta_rad_s2, 4),
      outputSpeed_rpm: round(duty.outputSpeed_rpm, 2),
      maxRatio: round(duty.maxRatio, 2),
      inertiaLoad_kgm2: round(duty.inertiaLoad_kgm2, 6),
      inertiaEccentric_kgm2: round(duty.inertiaEccentric_kgm2, 6),
      inertiaStations_kgm2: round(duty.inertiaStations_kgm2, 6),
      inertiaStationBody_kgm2: round(duty.inertiaStationBody_kgm2, 6),
      inertiaStationEccentric_kgm2: round(duty.inertiaStationEccentric_kgm2, 6),
      inertiaTotal_kgm2: round(duty.inertiaTotal_kgm2, 6),
      accelTorque_Nm: round(duty.accelTorque_Nm, 3),
      offsetTorque_Nm: round(duty.offsetTorque_Nm, 3),
      torqueTotal_Nm: round(duty.torqueTotal_Nm, 3)
    },
    // 多工位口径回传（页面说明 / 报告输入用它）：count = 0 表示单件工况。
    stations: {
      count: stations.count,
      massEach_kg: stations.massEach_kg,
      massTotal_kg: stations.massTotal_kg,
      inertiaBody_kgm2: round(stations.body_kgm2, 6),
      inertiaEccentric_kgm2: round(stations.eccentric_kgm2, 6),
      inertiaTotal_kgm2: round(stations.total_kgm2, 6)
    },
    demand: {
      torque_Nm: round(demandTorque, 3),
      outputSpeed_rpm: round(outputSpeed, 2),
      loadInertia_kgm2: round(loadInertia, 6),
      maxRatio: round(maxRatio, 2),
      ratio,
      ratioOverLimit: ratio > maxRatio + 1e-9,
      safetyFactor,
      bodyEfficiency,
      gearboxEfficiency,
      efficiency: round(efficiency, 4),
      inertiaRatio,
      // 无论最后有没有选到型号，这两个数都算得出来（只跟总速比 / 效率 / 惯量比有关）：
      // 所有者 2026-10-26：选不出电机时也要把"电机必须扭矩/惯量"显示出来。
      // 惯量这里不含本体盘面惯量（还没选型号，不知道是哪台），选定型号后以 choice 里那份为准。
      motorTorqueNeeded_Nm: round(demandTorque / (ratio * efficiency), 3),
      motorInertiaNeeded_kgm2: round((loadInertia / (ratio * ratio)) / inertiaRatio, 12),
      motorInertiaIncludesTable: false
    },
    decision: result.decision,
    choice: result.choice,
    // 所有者 2026-11-23：校核没过（电机扭矩/转速/惯量）也给出选型，partial = 这次结果要当"参考"看。
    partial: result.partial === true,
    failedChecks: result.failedChecks ?? [],
    // 没有结果时：说清卡在哪一步（速比凑不出 / 转矩不够 / 校核没过 / 数据被挡）
    failure: result.failure ?? null,
    candidates,
    rejected: result.rejected,
    notes: result.notes,
    space: {
      stableFactor: space.stableFactor,
      maxRatio: round(space.maxRatio, 2),
      rows: space.rows.filter(row => row.usable),
      stable: space.stable,
      smallestMotor: space.smallestMotor
    },
    meta: {
      dataRecords: data.records.length,
      motors: motors.length,
      motorPool: buildMotorPool(motors, { withBrake, motorSpeedClass }).length,
      motorSpeedClass,
      withBrake,
      statuses,
      brands: brands.length ? brands : ["全部"],
      seriesLabels: seriesLabels.length ? seriesLabels : ["全部"],
      gearboxModels: (data.gearboxCatalog?.models ?? []).map(model => model.model)
    }
  };
}

