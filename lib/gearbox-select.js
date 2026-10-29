// 减速机选型引擎：给"减速机输出轴"的扭矩/惯量/转速 + 总速比，从行星性能表里挑
// 系列 → 框号 → 速比，再配一台电机。
//
// 与 mtn-select.mjs 的区别（这是 recon §6 建议"新开模块"的原因）：
//   · 那边被选的是**中空平台本体**，行星只是本体的配套件，容量按"本体输入侧"算；
//   · 这边被选的就是**行星减速机本身**：额定输出扭矩直接和工况输出扭矩比，不需要再除本体比号。
// 两套语义不能混在一张候选表里（2026-10-26"全部系列混排"出过问题）。
//
// 三条校核，每条都会说清是哪一条卡住的：
//   1. 额定输出扭矩 ≥ 工况输出扭矩（安全系数 k 已在工况层乘过，这里不再乘）；
//   2. 最大输入转速 ≥ 减速机输入转速（= 输出转速 × 速比）；
//   3. 总减速比 i1 × i2 ≤ 工况允许的最大总减速比（表里的 i_max = n2/n1 含 i1）。
// 电机再按扭矩 / 转速 / 惯量比三选一（复用 motor-select.mjs，口径和平台选型一致）。

import { selectMotor } from "./motor-select.js";
import { buildMotorPool, MOTOR_SPEED_CLASSES } from "./mtn-select.js";
import { ratioLevelsOf, torqueAtRatio } from "./gearbox-catalog.js";
import { rightAngleEfficiency, rightAngleOptions } from "./right-angle.js";

function round(value, digits = 3) {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

function levelOf(model, table, ratio) {
  const levels = ratioLevelsOf(table, model);
  if (levels.single.includes(ratio)) return "single";
  if (levels.double.includes(ratio)) return "double";
  if (levels.triple.includes(ratio)) return "triple";
  return null;
}

/**
 * 这条记录能不能参与选型。
 *
 * 所有者 2026-10-28：「同列不等同实物」——目录把两个系列印在同一列时，没被单独核对的那个
 * 系列标成 dataStatus = "SHARED_COLUMN"，数据保留可查，但不进选型（避免同事选到别人的值）。
 */
export function isVerifiedModel(model) {
  return model?.dataStatus !== "SHARED_COLUMN";
}

/** 某个系列在这张表里的全部可比号（按框号顺序合并，去重排序）。 */
export function seriesRatios(catalog, series, options = {}) {
  const verifiedOnly = options.verifiedOnly === true;
  const set = new Set();
  for (const model of catalog?.models ?? []) {
    if (model.series !== series) continue;
    if (verifiedOnly && !isVerifiedModel(model)) continue;
    for (const ratio of Object.keys(model.ratedOutputTorque_Nm ?? {})) set.add(Number(ratio));
  }
  return [...set].sort((a, b) => a - b);
}

/** 表里有哪些系列（按目录顺序，含未核对的）。 */
export function catalogSeries(catalog) {
  const out = [];
  for (const model of catalog?.models ?? []) {
    if (!out.includes(model.series)) out.push(model.series);
  }
  return out;
}

/** 能进选型的系列（至少有一个已核对型号）。 */
export function selectableSeries(catalog) {
  const out = [];
  for (const model of catalog?.models ?? []) {
    if (!isVerifiedModel(model)) continue;
    if (!out.includes(model.series)) out.push(model.series);
  }
  return out;
}

/** 框号排序用：把 "042" 这种字符串按数字排。 */
function frameOrder(model) {
  return Number.parseInt(model.frameSize, 10) || 0;
}

/**
 * 一次减速机选型。
 *
 * request（全部是**减速机输出轴**口径，SI）：
 *   outputTorque_Nm    工况折算到减速机输出轴的扭矩（单台电机口径）
 *   outputSpeed_rpm    减速机输出轴转速 n1
 *   loadInertia_kgm2   折算到减速机输出轴的负载惯量（单台电机口径）
 *   ratio              选型减速比 i2（减速机本身的总比，不含齿轮副/链轮）；
 *                      装了换向器时 i2 = 本体比号 × 行星比号
 *   internalRatio      工况层那段机械减速 i1（齿轮副 z1/z2 或 链轮 D1/D2），默认 1
 *   maxTotalRatio      工况允许的最大**总**减速比；给了才校验 i1×i2
 *   motorRatedSpeed_rpm 电机额定转速（默认 3000）
 *   inertiaRatio       惯量比，默认 10
 *   series             要选的系列（数组）；空 = 全部系列（页面仍要求先选一个）
 *
 * options：
 *   withBrake / motorSpeedClass  电机筛选，同 mtn-select
 *   includeSeries                追加允许的系列（默认从 catalog 推）
 *   rightAngle                   在行星减速机输出侧加 XZTF 换向器（换输出方向，所有者 2026-10-29）
 *   xztf                         { records, fitment }：换向器产品记录 + 配套行星表（直角模式必需）
 */
export function selectGearbox(request, catalog, motors = [], options = {}) {
  if (!catalog?.models?.length) throw new Error("减速机性能表是空的，先录数据再选型");
  const torque = request?.outputTorque_Nm;
  if (!Number.isFinite(torque) || torque <= 0) throw new Error("减速机输出扭矩必须是正数");
  const ratio = request?.ratio;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("选型减速比 i2 必须是正数");
  const outputSpeed = request?.outputSpeed_rpm ?? null;
  if (outputSpeed !== null && (!Number.isFinite(outputSpeed) || outputSpeed <= 0)) {
    throw new Error("减速机输出转速必须是正数");
  }
  const motorRatedSpeed = request?.motorRatedSpeed_rpm ?? 3000;
  const inertiaRatioLimit = request?.inertiaRatio ?? 10;
  const loadInertia = request?.loadInertia_kgm2 ?? null;
  const internalRatio = request?.internalRatio ?? 1;
  const maxTotalRatio = request?.maxTotalRatio ?? null;
  const withBrake = options.withBrake === true;
  const motorSpeedClass = options.motorSpeedClass ?? "standard";
  if (!MOTOR_SPEED_CLASSES[motorSpeedClass]) throw new Error("电机档位只能是 standard / highInertia / all");

  const available = selectableSeries(catalog);
  const wanted = (Array.isArray(request?.series) ? request.series : request?.series ? [request.series] : [])
    .filter(Boolean);
  const unknown = wanted.filter(series => !available.includes(series));
  if (unknown.length) {
    throw new Error("未找到产品系列「" + unknown.join(" / ") + "」。可选系列：" + available.join(" / ") + "。");
  }
  if (!wanted.length) {
    throw new Error("请选择产品系列：" + available.join(" / ") + "（减速机选型一次只在一个系列里选，不混排）");
  }
  const seriesList = wanted;

  // 减速机输入转速 = 输出转速 × 速比；没给输出转速就没法核输入转速。
  const inputSpeed = outputSpeed === null ? null : outputSpeed * ratio;
  const motorPool = buildMotorPool(motors, { withBrake, motorSpeedClass });

  // 直角输出（所有者 2026-10-29）：行星减速机后面加 XZTF 换向器，输出方向转 90°。
  // 换向器框号决定配套哪台行星（data/gearboxes/fitment-xztf.json 是硬约束），所以这时
  // "产品系列"不再用来过滤行星，只决定页面上的比号列表；行星型号以配套表为准。
  const rightAngle = options.rightAngle === true;
  const xztfData = options.xztf ?? null;
  // 本体比号可以指定（1 / 2），不指定就自动（够用就好）。所有者 2026-10-29：二比要能显式选。
  const bodyRatioFilter = [1, 2].includes(options.rightAngleBodyRatio) ? options.rightAngleBodyRatio : null;
  let rightAngleMeta = null;
  let combos;
  if (rightAngle) {
    if (!xztfData?.records?.length) {
      throw new Error("换向器（XZTF）数据没有加载，无法按「直角输出」选型");
    }
    rightAngleMeta = rightAngleOptions({
      records: xztfData.records,
      fitment: xztfData.fitment,
      catalog,
      outputRatio: ratio
    });
    combos = rightAngleMeta.options.map(option => ({
      planetary: option.planetary,
      planetaryRatio: option.planetaryRatio,
      level: option.level,
      bodyRatio: option.bodyRatio,
      xztf: option.xztf
    }));
    if (bodyRatioFilter) combos = combos.filter(combo => combo.bodyRatio === bodyRatioFilter);
  } else {
    combos = [];
    for (const model of catalog.models) {
      if (!seriesList.includes(model.series)) continue;
      if (!isVerifiedModel(model)) continue;   // 同列未核对的数据不参与选型
      combos.push({ planetary: model, planetaryRatio: ratio, level: null, bodyRatio: 1, xztf: null });
    }
  }

  const candidates = [];
  const rejected = [];
  let ratioOffered = false;
  let torqueOffered = false;
  let speedOffered = false;
  let totalRatioOffered = false;
  let rightAngleTorqueOffered = false;
  let rightAngleSpeedOffered = false;

  for (const combo of combos) {
    const model = combo.planetary;
    const planetaryRatio = combo.planetaryRatio;
    const level = combo.level ?? levelOf(model, catalog, planetaryRatio);
    const rated = torqueAtRatio(model, planetaryRatio);
    if (level === null || rated === null) continue;      // 这个框号不提供该比号
    ratioOffered = true;

    const xztf = combo.xztf;
    const bodyRatio = combo.bodyRatio;
    const frame = model.series + model.frameSize;
    // 行星在换向器输入侧：它承受的是输出需求 ÷ 本体比号（和平台选型同一个位置口径）。
    const requiredTorque = torque / bodyRatio;
    const margin = rated / requiredTorque;
    const totalRatio = internalRatio * ratio;
    // 换向器自己也有 94% 效率：电机需要的扭矩按 i2 × η行星 × η换向器 折算。
    const xztfEfficiency = xztf ? rightAngleEfficiency(xztf) : 1;
    const efficiency = (model.efficiency?.[level] ?? 0.9) * xztfEfficiency;
    const xztfInputSpeed = xztf && outputSpeed !== null ? outputSpeed * bodyRatio : null;
    const xztfMargin = xztf ? xztf.ratedOutputTorque_Nm / torque : null;
    const checks = {
      torque: margin >= 1,
      speed: inputSpeed === null || (Number.isFinite(model.maxInputSpeed_rpm) && inputSpeed <= model.maxInputSpeed_rpm),
      totalRatio: maxTotalRatio === null || totalRatio <= maxTotalRatio + 1e-9,
      rightAngle: !xztf || (xztfMargin >= 1 &&
        (xztfInputSpeed === null || xztfInputSpeed <= xztf.ratedInputSpeed_rpm + 1e-9)),
      motor: true
    };
    if (checks.torque) torqueOffered = true;
    if (checks.speed) speedOffered = true;
    if (checks.totalRatio) totalRatioOffered = true;
    if (!xztf || xztfMargin >= 1) rightAngleTorqueOffered = true;
    if (!xztf || xztfInputSpeed === null || xztfInputSpeed <= xztf.ratedInputSpeed_rpm + 1e-9) {
      rightAngleSpeedOffered = true;
    }

    const label = xztf ? xztf.model + " + " + model.model : model.model;

    if (xztf && xztfMargin < 1) {
      rejected.push({ model: label, frame, ratio, stage: "rightAngle",
        reason: "换向器 " + xztf.model + " 额定输出扭矩 " + xztf.ratedOutputTorque_Nm + " N·m 低于输出需求 " +
          round(torque, 1) + " N·m" });
      continue;
    }
    if (xztf && xztfInputSpeed !== null && xztfInputSpeed > xztf.ratedInputSpeed_rpm + 1e-9) {
      rejected.push({ model: label, frame, ratio, stage: "rightAngleSpeed",
        reason: "换向器输入转速 " + Math.round(xztfInputSpeed) + " r/min 超过额定 " + xztf.ratedInputSpeed_rpm +
          " r/min（输出 " + Math.round(outputSpeed) + " × 本体比号 " + bodyRatio + "）" });
      continue;
    }
    if (!checks.torque) {
      rejected.push({ model: label, frame, ratio, stage: "torque",
        reason: xztf
          ? "行星额定输出扭矩 " + rated + " N·m 低于换向器输入侧需要 " + round(requiredTorque, 1) +
            " N·m（输出 " + round(torque, 1) + " N·m ÷ 本体比号 " + bodyRatio + "）"
          : "额定输出扭矩 " + rated + " N·m 低于工况需要 " + round(torque, 1) + " N·m" });
      continue;
    }
    if (!checks.speed) {
      rejected.push({ model: label, frame, ratio, stage: "speed",
        reason: "最大输入转速 " + model.maxInputSpeed_rpm + " r/min 低于所需 " + Math.round(inputSpeed) + " r/min" });
      continue;
    }
    if (!checks.totalRatio) {
      rejected.push({ model: label, frame, ratio, stage: "totalRatio",
        reason: "总减速比 " + round(totalRatio, 2) + " 超过工况允许的 " + round(maxTotalRatio, 2) +
          "（机械减速 i1 = " + round(internalRatio, 3) + "，减速机速比最多 " + round(maxTotalRatio / internalRatio, 2) + "）" });
      continue;
    }

    const motorTorqueNeeded = torque / (ratio * efficiency);
    const reflectedInertia = loadInertia === null ? null : loadInertia / (ratio * ratio);
    let motor = null;
    let motorNote = null;
    let motorRejected = null;
    if (motorPool.length) {
      const picked = selectMotor(
        { torque_Nm: motorTorqueNeeded, speed_rpm: inputSpeed, reflectedInertia_kgm2: reflectedInertia },
        motorPool,
        { maxInertiaRatio: inertiaRatioLimit }
      );
      motor = picked.motor;
      if (!motor) {
        motorRejected = picked.rejected?.[0]?.reason ?? "没有合适的电机";
        checks.motor = false;
      }
    } else {
      motorNote = "电机表为空，未配电机";
    }
    if (!checks.motor) {
      rejected.push({ model: label, frame, ratio, stage: "motor",
        reason: "电机配不上（" + motorRejected + "）" });
      continue;
    }

    candidates.push({
      model: model.model,
      series: model.series,
      frameSize: model.frameSize,
      frame,
      // ratio 是减速机输出侧的总比 i2（装了换向器时 = 本体比号 × 行星比号）；
      // planetaryRatio 才是行星那一段的比号（没有换向器时两者相同）。
      ratio,
      planetaryRatio,
      level,
      bodyRatio,
      rightAngle: xztf ? {
        model: xztf.model,
        series: xztf.series,
        frameSize: xztf.frameSize,
        bodyRatio,
        ratedTorque_Nm: xztf.ratedOutputTorque_Nm,
        ratedInputSpeed_rpm: xztf.ratedInputSpeed_rpm,
        margin: round(xztfMargin, 3),
        efficiency: xztfEfficiency,
        inputSpeed_rpm: xztfInputSpeed === null ? null : round(xztfInputSpeed, 1),
        status: xztf.status ?? null
      } : null,
      ratedTorque_Nm: rated,
      requiredTorque_Nm: round(requiredTorque, 3),
      margin: round(margin, 3),
      efficiency: round(efficiency, 4),
      motorTorqueNeeded_Nm: round(motorTorqueNeeded, 3),
      motor: motor && { model: motor.model, power_W: motor.power_W, ratedTorque_Nm: motor.ratedTorque_Nm,
        ratedSpeed_rpm: motor.ratedSpeed_rpm, inertiaRatio: pickedInertiaRatio(motor, reflectedInertia, inertiaRatioLimit) },
      motorSpeed_rpm: inputSpeed === null ? null : round(inputSpeed, 1),
      totalRatio: round(totalRatio, 3),
      checks,
      notes: [motorNote, motorRejected].filter(Boolean)
    });
  }

  // 够用就好：余量小的先上，同样余量选框号小的。
  // 直角输出：先按换向器框号从小到大（小框号便宜），同框号先 1:1 再 2:1，再看行星余量。
  candidates.sort(rightAngle
    ? (a, b) => Number(a.rightAngle?.frameSize ?? 0) - Number(b.rightAngle?.frameSize ?? 0) ||
        (a.rightAngle?.bodyRatio ?? 0) - (b.rightAngle?.bodyRatio ?? 0) ||
        a.margin - b.margin || frameOrder(a) - frameOrder(b)
    : (a, b) => a.margin - b.margin || frameOrder(a) - frameOrder(b));
  const choice = candidates[0] ?? null;

  let failure = null;
  if (!choice) {
    if (rightAngle && !rightAngleMeta?.options?.length) {
      const offered = rightAngleMeta?.achievableRatios ?? [];
      failure = { stage: "ratio", message: "换向器下凑不出 " + ratio + ":1（总速比 = 本体比号 1/2 × 行星比号）。" +
        "换向器能做的总速比：" + offered.join(" / ") +
        "；可配行星：" + (rightAngleMeta?.planetaryModels ?? []).join(" / ") };
    } else if (rightAngle && bodyRatioFilter && !combos.length) {
      // 指定了本体比号，但这个比号配不出来（比如 35:1 想用 2:1 本体 → 行星要 17.5:1）
      const allowed = [...new Set((rightAngleMeta?.options ?? []).map(option => option.bodyRatio))].sort();
      failure = { stage: "ratio", message: "比号 " + ratio + ":1 配不出「只用 " + bodyRatioFilter +
        ":1 本体」的换向器组合（行星比号要 = " + ratio + " ÷ " + bodyRatioFilter + "）。" +
        "这个比号能用的本体比号：" + allowed.join(" / ") +
        "；2:1 本体只有 090 / 110 / 140 / 170 / 210 / 240 框号" };
    } else if (!ratioOffered) {
      const offered = [...new Set(seriesList.flatMap(series => seriesRatios(catalog, series, { verifiedOnly: true })))].sort((a, b) => a - b);
      failure = { stage: "ratio", message: "这些系列没有 " + ratio + ":1 这个比号。可选比号：" + offered.join(" / ") };
    } else if (!rightAngleTorqueOffered) {
      failure = { stage: "rightAngle", message: "输出需求 " + round(torque, 1) +
        " N·m 超过所有能配套的换向器额定输出扭矩（换向器框号越大扭矩越大）" };
    } else if (!rightAngleSpeedOffered) {
      failure = { stage: "rightAngleSpeed", message: "换向器输入转速（输出转速 × 本体比号）超过额定 3000 r/min，换更大的框号或降速" };
    } else if (!torqueOffered) {
      failure = { stage: "torque", message: rightAngle
        ? "在 " + ratio + ":1 下没有行星的额定扭矩够换向器输入侧的需求"
        : "在 " + ratio + ":1 下没有框号的额定扭矩够 " + round(torque, 1) + " N·m" };
    } else if (!speedOffered) {
      failure = { stage: "speed", message: "输入转速 " + Math.round(inputSpeed) + " r/min 超过所有框号的最大输入转速" };
    } else if (!totalRatioOffered) {
      failure = { stage: "totalRatio", message: "总减速比 " + round(internalRatio * ratio, 2) + " 超过工况允许的 " + round(maxTotalRatio, 2) +
        "（机械减速 i1 = " + round(internalRatio, 3) + "，减速机速比最多 " + round(maxTotalRatio / internalRatio, 2) + "）" };
    } else {
      failure = { stage: "motor", message: "减速机选得出，但电机表里没有满足扭矩/转速/惯量的电机" };
    }
  }

  return {
    ok: Boolean(choice),
    choice,
    candidates,
    rejected,
    failure,
    demand: {
      outputTorque_Nm: round(torque, 3),
      outputSpeed_rpm: round(outputSpeed, 2),
      loadInertia_kgm2: round(loadInertia, 8),
      ratio,
      internalRatio,
      totalRatio: round(internalRatio * ratio, 3),
      maxTotalRatio: round(maxTotalRatio, 2),
      motorSpeed_rpm: inputSpeed === null ? null : round(inputSpeed, 1),
      inertiaRatio: inertiaRatioLimit,
      rightAngle
    },
    // 直角输出时才有的信息：可配行星、能凑出的总速比（页面/报告用来解释"为什么选不出"）。
    rightAngle: {
      enabled: rightAngle,
      series: rightAngle ? "XZTF" : null,
      planetaryModels: rightAngle ? (rightAngleMeta?.planetaryModels ?? []) : [],
      achievableRatios: rightAngle ? (rightAngleMeta?.achievableRatios ?? []) : []
    },
    series: seriesList,
    availableSeries: available,
    meta: { models: catalog.models.length, motors: motorPool.length, motorSpeedClass, withBrake }
  };
}

function pickedInertiaRatio(motor, reflectedInertia, limit) {
  if (reflectedInertia === null || !motor) return null;
  const inertia = motor.effectiveInertia_kgm2 ?? motor.rotorInertia_kgm2;
  if (!inertia) return null;
  return round(reflectedInertia / inertia, 2);
}
