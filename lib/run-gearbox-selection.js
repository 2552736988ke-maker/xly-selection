// 减速机选型的纯计算入口：工况层（齿轮副 / 链带）→ 四个交接值 → 选型层。
//
// 和 run-selection.mjs 一样，这个文件**没有任何 node: 依赖**，托管版和静态版共用。
// 页面只负责收参数和显示结果；所有公式、校核、排序都在这里和它 import 的两个模块里。

import { GEARBOX_DUTY_TYPES, gearboxDuty } from "./gearbox-duty.js";
import { selectableSeries, selectGearbox } from "./gearbox-select.js";

function round(value, digits = 3) {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

/**
 * 一次减速机选型。
 *
 * input：
 *   dutyType        "gear-pair" | "chain-belt"（默认 gear-pair）
 *   duty            工况参数（见 gearbox-duty.mjs 的 GEARBOX_DUTY_TYPES[dutyType].inputs）
 *   ratio           减速机速比 i2
 *   motorRatedSpeed_rpm / inertiaRatio / safetyFactor / gearboxEfficiency
 *   series          要选的系列数组（例如 ["AB"]），空 = 全部
 *   withBrake / motorSpeedClass  电机筛选
 * data：{ gearboxCatalog, motors, motorProblems }
 */
export function runGearboxSelection(input = {}, data = {}) {
  if (!data?.gearboxCatalog) throw new Error("减速机性能表没有加载");
  if (data.motorProblems?.length) throw new Error("电机表有问题：" + data.motorProblems[0]);

  const type = gearboxDuty(input.dutyType ?? "gear-pair");
  // 电机档位要影响"最大总速比"：勾了高惯量（≤1500）就不能再按 3000 算上限，
  // 否则页面会允许一个电机根本转不到的速比（平台选型页也是同一口径）。
  const motorSpeedClass = input.motorSpeedClass === "highInertia" ? "highInertia" : "standard";
  const requestedMotorSpeed = input.motorRatedSpeed_rpm ?? 3000;
  const motorRatedSpeed_rpm = motorSpeedClass === "highInertia"
    ? Math.min(requestedMotorSpeed, 1500)
    : requestedMotorSpeed;
  const dutyInput = {
    ...(input.duty ?? {}),
    ratio: input.ratio,
    motorRatedSpeed_rpm,
    safetyFactor: input.safetyFactor,
    gearboxEfficiency: input.gearboxEfficiency,
    gearEfficiency: input.gearEfficiency,
    conveyorEfficiency: input.conveyorEfficiency
  };
  const duty = type.compute(dutyInput);

  // 电机品牌/系列过滤：每个电机记录带 seriesLabel（汇川-R / 汇川-Z / 欧姆龙-1S）。
  // 不传就是全部——页面默认只勾汇川-R，命令行默认也是全部。
  const seriesLabels = Array.isArray(input.seriesLabels) ? input.seriesLabels.filter(Boolean) : [];
  const motors = seriesLabels.length
    ? (data.motors ?? []).filter(motor => seriesLabels.includes(motor.seriesLabel))
    : (data.motors ?? []);

  const selection = selectGearbox({
    outputTorque_Nm: duty.outputTorque_Nm,
    outputSpeed_rpm: duty.outputSpeed_rpm,
    loadInertia_kgm2: duty.outputInertia_kgm2,
    ratio: input.ratio,
    internalRatio: duty.internalRatio,
    maxTotalRatio: duty.maxTotalRatio,
    motorRatedSpeed_rpm,
    inertiaRatio: input.inertiaRatio ?? 10,
    series: input.series
  }, data.gearboxCatalog, motors, {
    withBrake: input.withBrake === true,
    motorSpeedClass,
    // 输出方向：直角 = 行星后面加 XZTF 换向器（所有者 2026-10-29）。
    rightAngle: input.rightAngle === true,
    // 换向器本体比号：不传 = 自动（够用就好），1 / 2 = 只用这个比号。
    rightAngleBodyRatio: input.rightAngleBodyRatio ?? null,
    xztf: {
      records: data.gearboxRecords ?? [],
      fitment: data.fitment?.XZTF ?? null
    }
  });

  return {
    ok: selection.ok,
    dutyType: type.id,
    dutyLabel: duty.labelZh,
    duty: {
      outputTorque_Nm: round(duty.outputTorque_Nm, 3),
      outputInertia_kgm2: round(duty.outputInertia_kgm2, 8),
      outputSpeed_rpm: round(duty.outputSpeed_rpm, 2),
      maxTotalRatio: round(duty.maxTotalRatio, 2),
      maxGearboxRatio: round(duty.maxGearboxRatio, 2),
      internalRatio: round(duty.internalRatio, 4),
      internalLabel: duty.internalLabel,
      motorCount: duty.motorCount,
      steps: duty.steps,
      assumptions: duty.assumptions
    },
    selection,
    availableSeries: selectableSeries(data.gearboxCatalog),
    dutyTypes: Object.values(GEARBOX_DUTY_TYPES).map(item => ({ id: item.id, labelZh: item.labelZh })),
    meta: {
      models: data.gearboxCatalog.models.length,
      motors: (data.motors ?? []).length
    }
  };
}

