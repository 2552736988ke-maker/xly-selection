// 减速机选型的**工况层**：把"齿轮副"与"链带"两种工况算成四个交接值。
//
// 公式来源：公司《选型分类.xlsx》的「2大小齿轮」「3齿轮链带」两张表，逐格照搬，
// 用表里缓存的计算值做回归（见 tests/unit/gearbox-duty.test.mjs）。
//
// 与旋转平台工况（mtn-duty.mjs）最大的区别：这两张表里**电机和负载之间多了一段机械减速**
// （齿轮副 i1 = z1/z2，或链轮/带轮 i1 = 被动轮/主动轮）。所以交接给选型层的必须是
// **减速机输出轴**口径，也就是表里的 J' = J/i1²、T' = T/i1，而不是负载侧（盘面/皮带）的值。
// 选型层不认识 i1，也不需要认识——它只按输出轴的扭矩/惯量/转速去挑减速机。
//
// 四个交接值（全部是"一台电机"口径；链带表有两台电机时，J 与 T 都已 ÷ 驱动电机数）：
//   ① outputTorque_Nm   减速机输出轴需要的扭矩（已含安全系数 k 与机械效率 η1）
//   ② outputInertia_kgm2 折算到减速机输出轴的负载惯量
//   ③ outputSpeed_rpm   减速机输出轴转速 n1
//   ④ maxTotalRatio     最大**总**减速比 i_max = 电机额定转速 / n1（含 i1，不只是减速机速比）
//
// 两个口径必须同时记住（recon §3）：表里的 i_max 是总减速比，选型层只认减速机速比 i2；
// 所以 run-gearbox-selection 校验的是 i1 × i2 ≤ i_max，而不是 i2 ≤ i_max。

const PI = 3.14;  // 公司表口径（不是 Math.PI）
const G = 9.8;    // 公司表口径

function positive(name, value) {
  if (value === undefined || value === null || value === "") throw new Error(name + " 是必填项");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(name + " 必须是数字（现在是「" + value + "」）");
  if (parsed <= 0) throw new Error(name + " 必须是正数（现在是 " + parsed + "）");
  return parsed;
}

function nonNegative(name, value) {
  if (value === undefined || value === null || value === "") throw new Error(name + " 是必填项");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(name + " 必须是数字（现在是「" + value + "」）");
  if (parsed < 0) throw new Error(name + " 不能是负数（现在是 " + parsed + "）");
  return parsed;
}

function round(value, digits = 4) {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

/**
 * 齿轮副工况（「2大小齿轮」）：转盘经大齿轮/小齿轮带动。
 *
 * input：
 *   turntableMass_kg / turntableDiameter_mm / turntableSideA_mm / turntableSideB_mm
 *   stations { count, massEach_kg, sideC_mm, sideD_mm }   多工位负载（m2 加总，J3/J4）
 *   mounting "horizontal" | "hanging" | "side"           决定用哪一个偏心 L1，以及要不要算 T2
 *   eccentricity_mm                                       L1（按安装方向取；表里三个格子）
 *   loadOffset_mm                                         L2（工位负载偏心）
 *   bigGear { mass_kg, outerDiameter_mm, innerDiameter_mm }
 *   smallGear { mass_kg, outerDiameter_mm, innerDiameter_mm }
 *   bigGearTeeth / smallGearTeeth                         z1 / z2
 *   theta_deg / cycleTime_s / accelTime_s                 θ、t、t1（t3 默认 = t1）
 *   decelTime_s                                           t3；不给就跟 t1 一样（所有者 2026-10-28：单列输入框）
 *   gearboxInertia_kgm2                                   表里手填的"减速机惯量"，默认 0
 *   safetyFactor k（1.5）/ gearEfficiency η1（0.85）/ gearboxEfficiency η2（0.9）
 *   motorRatedSpeed_rpm / ratio                           n2、i2
 */
export function gearPairDuty(input = {}) {
  const mounting = input.mounting ?? "horizontal";
  if (!["horizontal", "hanging", "side"].includes(mounting)) {
    throw new Error("安装方向无效：" + mounting + "（可选：平装 horizontal / 吊装 hanging / 侧装 side）");
  }
  const mass = positive("转盘质量", input.turntableMass_kg);
  const diameter = positive("转盘直径", input.turntableDiameter_mm) / 1000;
  const sideA = nonNegative("转盘截面 a", input.turntableSideA_mm ?? 0) / 1000;
  const sideB = nonNegative("转盘截面 b", input.turntableSideB_mm ?? 0) / 1000;
  const shape = input.turntableShape ?? (sideA > 0 && sideB > 0 ? "box" : "disc");
  if (!["disc", "box"].includes(shape)) throw new Error("转盘形状只能是 disc / box");

  const stations = input.stations ?? { count: 0, massEach_kg: 0, sideC_mm: 0, sideD_mm: 0 };
  const stationCount = nonNegative("工位数量", stations.count ?? 0);
  const stationMass = (stations.massEach_kg ?? 0) * stationCount;
  const sideC = (stations.sideC_mm ?? 0) / 1000;
  const sideD = (stations.sideD_mm ?? 0) / 1000;
  const loadOffset = nonNegative("负载偏心 L2", input.loadOffset_mm ?? 0) / 1000;

  const big = input.bigGear ?? {};
  const small = input.smallGear ?? {};
  const bigMass = nonNegative("大齿轮质量", big.mass_kg ?? 0);
  const bigOuter = (big.outerDiameter_mm ?? 0) / 1000;
  const bigInner = (big.innerDiameter_mm ?? 0) / 1000;
  const smallMass = nonNegative("小齿轮质量", small.mass_kg ?? 0);
  const smallOuter = (small.outerDiameter_mm ?? 0) / 1000;
  const smallInner = (small.innerDiameter_mm ?? 0) / 1000;

  const z1 = positive("大齿轮齿数", input.bigGearTeeth ?? 120);
  const z2 = positive("小齿轮齿数", input.smallGearTeeth ?? 40);
  const internalRatio = z1 / z2;

  const theta = positive("一次旋转角度 θ", input.theta_deg) * PI / 180;
  const cycle = positive("旋转一次用时 t", input.cycleTime_s);
  const accel = positive("加速时间 t1", input.accelTime_s ?? 0.5);
  // 表里 t3 = t1；所有者 2026-10-28 要求减速时间能单独填，不填才跟加速时间一样。
  const decelProvided = input.decelTime_s !== undefined && input.decelTime_s !== null && input.decelTime_s !== "";
  const decel = decelProvided ? positive("减速时间 t3", input.decelTime_s) : accel;
  const uniform = cycle - accel - decel;                  // 表：t2 = t - t1 - t3
  if (uniform < 0) {
    // 没填减速时间就是公司表那句原话；单独填了就把两个数都报出来。
    throw new Error(decelProvided
      ? "加速时间 + 减速时间不能超过旋转一次用时（现在 t1 = " + accel + " s、t3 = " + decel + " s，t = " + cycle + " s）"
      : "旋转一次用时至少要是加速时间的 2 倍（现在 t1 = " + accel + " s，t = " + cycle + " s）");
  }

  const motorSpeed = positive("电机额定转速", input.motorRatedSpeed_rpm ?? 3000);
  const requestedRatio = positive("选型减速比 i2", input.ratio);
  const k = positive("安全系数 k", input.safetyFactor ?? 1.5);
  const eta1 = positive("齿轮组效率 η1", input.gearEfficiency ?? 0.85);
  const eta2 = positive("减速机效率 η2", input.gearboxEfficiency ?? 0.9);
  if (eta1 > 1 || eta2 > 1) throw new Error("效率要在 0–1 之间");

  const omega = 2 * theta / (uniform + cycle);             // 表：ω = 2θ/(t2+t)
  const beta = omega / accel;                             // 表：β = ω/t1
  const speed = omega * 60 / (2 * PI);                    // 表：n1 = ω·60/2π
  if (speed <= 0) throw new Error("算出的输出转速为 0，请检查旋转角度/用时");

  const eccentric = nonNegative("偏心距 L1", input.eccentricity_mm ?? 0) / 1000;
  const inertiaTurntable = shape === "box"
    ? mass * (sideA ** 2 + sideB ** 2) / 12                 // 表：J1 = m1(a²+b²)/12（方体）
    : mass * diameter ** 2 / 8;                            // 表：J1 = m1D²/8（圆柱）
  const inertiaEccentric = mass * eccentric ** 2;          // 表：J2 = m1L1²
  const inertiaStations = stationMass * (sideC ** 2 + sideD ** 2) / 12;  // 表：J3
  const inertiaStationOffset = stationMass * loadOffset ** 2;            // 表：J4
  const inertiaBigGear = bigMass * (bigOuter ** 2 + bigInner ** 2) / 8;  // 表：J5
  const inertiaSmallGear = smallMass * (smallOuter ** 2 + smallInner ** 2) / 8;  // 表：J6
  const inertiaGearbox = nonNegative("减速机惯量", input.gearboxInertia_kgm2 ?? 0);
  const inertiaTotal = inertiaTurntable + inertiaEccentric + inertiaStations +
    inertiaStationOffset + inertiaBigGear + inertiaSmallGear + inertiaGearbox;

  const accelTorque = inertiaTotal * beta;                 // 表：T1 = J·β
  const offsetTorque = mounting === "side" ? mass * G * eccentric : 0;  // 表：T2 = m1·g·L1（只有侧装）
  const torqueTotal = (accelTorque + offsetTorque) * k / eta1;          // 表：T = (T1+T2)·k/η1

  const inertiaReflected = inertiaTotal / internalRatio ** 2;  // 表：J' = J/i1²
  const torqueReflected = torqueTotal / internalRatio;         // 表：T' = T/i1
  const motorTorque = torqueReflected / requestedRatio / eta2; // 表：T'' = T'/i2/η2
  // 表：J'' = J'·10⁴/i2²/10（单位 10⁻⁴ kg·m²）。÷10 就是惯量比，和 mtn-duty 同一口径。
  const motorInertia_1e4 = inertiaReflected * 1e4 / requestedRatio ** 2 / 10;

  return {
    dutyType: "gear-pair",
    labelZh: "大小齿轮（齿轮副）",
    outputTorque_Nm: torqueReflected,
    outputInertia_kgm2: inertiaReflected,
    outputSpeed_rpm: speed,
    maxTotalRatio: motorSpeed / speed,
    // 工况允许的**减速机**速比上限：总速比上限 ÷ 机械减速 i1。
    // 页面让客户填的是 i2（减速机本身），所以这个数才是他能直接对照的上限。
    maxGearboxRatio: motorSpeed / speed / internalRatio,
    internalRatio,
    internalLabel: "齿轮副 " + z1 + "/" + z2 + " = " + round(internalRatio, 4),
    motorCount: 1,
    loadTorque_Nm: torqueTotal,
    loadInertia_kgm2: inertiaTotal,
    motorTorque_Nm: motorTorque,
    motorInertia_1e4,
    steps: [
      { label: "加速时间 t1", formula: "t1", value: round(accel), unit: "s" },
      { label: "减速时间 t3", formula: decelProvided ? "t3" : "t3 = t1", value: round(decel), unit: "s" },
      { label: "匀速时间 t2", formula: "t2 = t − t1 − t3", value: round(uniform), unit: "s" },
      { label: "角速度 ω", formula: "ω = 2θ/(t2+t)", value: round(omega), unit: "rad/s" },
      { label: "角加速度 β", formula: "β = ω/t1", value: round(beta), unit: "rad/s²" },
      { label: "输出转速 n1", formula: "n1 = ω·60/2π", value: round(speed, 2), unit: "r/min" },
      { label: "最大总减速比 i_max", formula: "i_max = n2/n1", value: round(motorSpeed / speed, 2), unit: "比" },
      { label: "转盘惯量 J1", formula: shape === "box" ? "m1(a²+b²)/12" : "m1D²/8", value: round(inertiaTurntable, 6), unit: "kg·m²" },
      { label: "偏心惯量 J2", formula: "m1L1²", value: round(inertiaEccentric, 6), unit: "kg·m²" },
      { label: "工位惯量 J3", formula: "m2(c²+d²)/12", value: round(inertiaStations, 6), unit: "kg·m²" },
      { label: "工位偏心 J4", formula: "m2L2²", value: round(inertiaStationOffset, 6), unit: "kg·m²" },
      { label: "大齿轮惯量 J5", formula: "m3(D1²+D2²)/8", value: round(inertiaBigGear, 6), unit: "kg·m²" },
      { label: "小齿轮惯量 J6", formula: "m4(D3²+D4²)/8", value: round(inertiaSmallGear, 6), unit: "kg·m²" },
      { label: "减速机惯量 J减速机", formula: "按所选减速机资料填", value: round(inertiaGearbox, 6), unit: "kg·m²" },
      { label: "总惯量 J", formula: "J = J1+…+J6+J减速机", value: round(inertiaTotal, 6), unit: "kg·m²" },
      { label: "加速力矩 T1", formula: "T1 = J·β", value: round(accelTorque, 3), unit: "N·m" },
      { label: "偏心力矩 T2", formula: "T2 = m1·g·L1（侧装）", value: round(offsetTorque, 3), unit: "N·m" },
      { label: "总力矩 T", formula: "T = (T1+T2)·k/η1", value: round(torqueTotal, 3), unit: "N·m" },
      { label: "折算到减速机 J′", formula: "J′ = J/i1²", value: round(inertiaReflected, 6), unit: "kg·m²" },
      { label: "折算到减速机 T′", formula: "T′ = T/i1", value: round(torqueReflected, 3), unit: "N·m" }
    ],
    assumptions: { PI, G, k, eta1, eta2, mounting, shape, internalRatio, requestedRatio, motorSpeed }
  };
}

/** 链带的三种子工况：水平移动 / 垂直提升 / 斜坡。 */
export const CHAIN_BELT_CASES = Object.freeze(["horizontal", "vertical", "ramp"]);

/**
 * 链带工况（「3齿轮链带」）：链传动 / 带传动，三种子工况用同一个入口，靠 `case` 切。
 *
 * 表里三种子工况就是三个 g / μ 的组合（原表用 IF(C2=…) 取）：
 *   水平：g = 9.8、μ = 0.2，T1 = μ(m1−m2)g·(D/2)
 *   提升：g = 9.8、μ = 0，  T1 = (m1−m2)g·(D/2)
 *   斜坡：g = 9.8、μ = 0.2，T1 = (m1−m2)g(sinA + μcosA)·(D/2)
 * 配重 m2 在三种里都是扣掉的（m1−m2）。驱动电机数 N 只影响"单台"分摊，不改变总力矩。
 */
export function chainBeltDuty(input = {}) {
  const caseId = input.case ?? input.dutyCase ?? "horizontal";
  if (!CHAIN_BELT_CASES.includes(caseId)) {
    throw new Error("链带子工况无效：" + caseId + "（可选：水平 horizontal / 提升 vertical / 斜坡 ramp）");
  }
  const m1 = positive("负载质量 m1", input.loadMass_kg);
  const m2 = nonNegative("配重 m2", input.counterweight_kg ?? 0);
  const netMass = m1 - m2;
  if (netMass <= 0) throw new Error("配重不能大于等于负载（现在 m1 = " + m1 + " kg，m2 = " + m2 + " kg）");
  const diameter = positive("节圆直径 D", input.pitchDiameter_mm) / 1000;
  const speedLine = positive("移动速度 v", input.lineSpeed_mm_s) / 1000;   // m/s
  const accel = positive("加减速时间 t1", input.accelTime_s ?? 0.5);
  const alpha = speedLine / accel;                                        // 表：α = v/t1
  const radius = diameter / 2;
  const motorSpeed = positive("电机额定转速 n2", input.motorRatedSpeed_rpm ?? 3000);
  const requestedRatio = positive("选型减速比 i2", input.ratio);
  const k = positive("安全系数 k", input.safetyFactor ?? 1.5);
  const eta1 = positive("输送效率 η1", input.conveyorEfficiency ?? 0.9);
  const eta2 = positive("减速机效率 η2", input.gearboxEfficiency ?? 0.9);
  if (eta1 > 1 || eta2 > 1) throw new Error("效率要在 0–1 之间");
  if (input.slopeAngle_deg !== undefined) nonNegative("坡度角 A", input.slopeAngle_deg);

  // 本体减速比 i1 = 被动轮/主动轮（表里两列直径相除）
  const drivenDiameter = positive("被动轮直径 D1", input.drivenPulley_mm ?? 1);
  const drivingDiameter = positive("主动轮直径 D2", input.drivingPulley_mm ?? 1);
  const internalRatio = drivenDiameter / drivingDiameter;

  const beltSpeed = speedLine * 60 / (PI * diameter);   // 表：n1 = v·60/(πD)
  const slope = (input.slopeAngle_deg ?? 0) * PI / 180;
  const sinA = Math.sin(slope);
  const cosA = Math.cos(slope);
  const mu = caseId === "vertical" ? 0 : (input.frictionCoefficient ?? 0.2);

  let holdingForce;
  if (caseId === "vertical") {
    holdingForce = netMass * G;                                  // 提升：克服重力
  } else if (caseId === "horizontal") {
    holdingForce = mu * netMass * G;                             // 水平：克服摩擦
  } else {
    holdingForce = netMass * G * (sinA + mu * cosA);             // 斜坡：重力分量 + 摩擦
  }
  const loadTorque = holdingForce * radius;                      // 表：T1
  const accelTorque = netMass * alpha * radius;                  // 表：T2
  const totalTorque = (loadTorque + accelTorque) * k / eta1;      // 表：T3 = (T1+T2)k/η1

  const loadInertia = m1 * diameter ** 2 / 4;                    // 表：J1 = m·D²/4
  const reflectedInertia = loadInertia / internalRatio ** 2;     // 表：J2 = J1/i1²
  const reflectedTorque = totalTorque / internalRatio;           // 表：T4 = T3/i1

  const motorCount = Math.max(1, Math.round(positive("驱动电机数", input.motorCount ?? 1)));
  const perMotorTorque = reflectedTorque / motorCount;           // 表：单侧 = 全部 ÷ 电机数
  const perMotorInertia = reflectedInertia / motorCount;
  const motorTorque = perMotorTorque / requestedRatio / eta2;    // 表：T5 = T4/i2/η2
  const motorInertia_1e4 = perMotorInertia * 1e4 / requestedRatio ** 2 / 10;

  const caseLabel = { horizontal: "水平移动", vertical: "垂直提升", ramp: "斜坡" }[caseId];
  const caseFormula = {
    horizontal: "T1 = μ(m1−m2)g·(D/2)",
    vertical: "T1 = (m1−m2)g·(D/2)",
    ramp: "T1 = (m1−m2)g(sinA+μcosA)·(D/2)"
  }[caseId];

  return {
    dutyType: "chain-belt",
    labelZh: "齿轮链带（" + caseLabel + "）",
    case: caseId,
    outputTorque_Nm: perMotorTorque,
    outputInertia_kgm2: perMotorInertia,
    outputSpeed_rpm: beltSpeed,
    maxTotalRatio: motorSpeed / beltSpeed,
    maxGearboxRatio: motorSpeed / beltSpeed / internalRatio,
    internalRatio,
    internalLabel: "链轮/带轮 " + drivenDiameter + "/" + drivingDiameter + " = " + round(internalRatio, 4),
    motorCount,
    loadTorque_Nm: totalTorque,
    loadInertia_kgm2: loadInertia,
    motorTorque_Nm: motorTorque,
    motorInertia_1e4,
    steps: [
      { label: "加速度 α", formula: "α = v/t1", value: round(alpha), unit: "m/s²" },
      { label: "输出转速 n1", formula: "n1 = v·60/(πD)", value: round(beltSpeed, 3), unit: "r/min" },
      { label: "最大总减速比 i_max", formula: "i_max = n2/n1", value: round(motorSpeed / beltSpeed, 3), unit: "比" },
      { label: "负载惯量 J1", formula: "J1 = m1·D²/4", value: round(loadInertia, 6), unit: "kg·m²" },
      { label: "工况阻力矩 T1", formula: caseFormula, value: round(loadTorque, 4), unit: "N·m" },
      { label: "加速力矩 T2", formula: "T2 = (m1−m2)α·(D/2)", value: round(accelTorque, 4), unit: "N·m" },
      { label: "总力矩 T3", formula: "T3 = (T1+T2)·k/η1", value: round(totalTorque, 4), unit: "N·m" },
      { label: "折算到减速机 J2", formula: "J2 = J1/i1²", value: round(reflectedInertia, 6), unit: "kg·m²" },
      { label: "折算到减速机 T4", formula: "T4 = T3/i1", value: round(reflectedTorque, 4), unit: "N·m" },
      { label: "单台输出扭矩", formula: "T4 ÷ 驱动电机数", value: round(perMotorTorque, 4), unit: "N·m" },
      { label: "单台输出惯量", formula: "J2 ÷ 驱动电机数", value: round(perMotorInertia, 6), unit: "kg·m²" }
    ],
    assumptions: { PI, G, k, eta1, eta2, mu, case: caseId, slopeAngle_deg: input.slopeAngle_deg ?? 0, motorCount, internalRatio, requestedRatio, motorSpeed }
  };
}

/** 工况注册表：界面据此渲染输入行，引擎据此取 compute。 */
export const GEARBOX_DUTY_TYPES = Object.freeze({
  "gear-pair": Object.freeze({
    id: "gear-pair",
    labelZh: "大小齿轮（齿轮副）",
    compute: gearPairDuty,
    inputs: Object.freeze([
      { name: "turntableMass_kg", labelZh: "转盘质量 m1", unit: "kg", group: "load" },
      { name: "turntableDiameter_mm", labelZh: "转盘直径 D", unit: "mm", group: "load" },
      { name: "turntableSideA_mm", labelZh: "转盘截面 a", unit: "mm", group: "load" },
      { name: "turntableSideB_mm", labelZh: "转盘截面 b", unit: "mm", group: "load" },
      { name: "eccentricity_mm", labelZh: "转盘偏心 L1", unit: "mm", group: "load" },
      { name: "loadOffset_mm", labelZh: "负载偏心 L2", unit: "mm", group: "load" },
      { name: "stations.count", labelZh: "工位数量", unit: "个", group: "load" },
      { name: "stations.massEach_kg", labelZh: "单工位负载质量", unit: "kg", group: "load" },
      { name: "stations.sideC_mm", labelZh: "工位负载长 c", unit: "mm", group: "load" },
      { name: "stations.sideD_mm", labelZh: "工位负载宽 d", unit: "mm", group: "load" },
      { name: "bigGear.mass_kg", labelZh: "大齿轮质量 m3", unit: "kg", group: "gear" },
      { name: "bigGear.outerDiameter_mm", labelZh: "大齿轮外径 D1", unit: "mm", group: "gear" },
      { name: "bigGear.innerDiameter_mm", labelZh: "大齿轮内径 D2", unit: "mm", group: "gear" },
      { name: "smallGear.mass_kg", labelZh: "小齿轮质量 m4", unit: "kg", group: "gear" },
      { name: "smallGear.outerDiameter_mm", labelZh: "小齿轮外径 D3", unit: "mm", group: "gear" },
      { name: "smallGear.innerDiameter_mm", labelZh: "小齿轮内径 D4", unit: "mm", group: "gear" },
      { name: "bigGearTeeth", labelZh: "大齿轮齿数 z1", unit: "齿", group: "gear" },
      { name: "smallGearTeeth", labelZh: "小齿轮齿数 z2", unit: "齿", group: "gear" },
      { name: "theta_deg", labelZh: "一次旋转角度 θ", unit: "°", group: "duty" },
      { name: "cycleTime_s", labelZh: "旋转一次用时 t", unit: "s", group: "duty" },
      { name: "accelTime_s", labelZh: "加速时间 t1", unit: "s", group: "duty" },
      { name: "decelTime_s", labelZh: "减速时间 t3（默认跟 t1 一样）", unit: "s", group: "duty" }
    ])
  }),
  "chain-belt": Object.freeze({
    id: "chain-belt",
    labelZh: "齿轮链带（水平 / 提升 / 斜坡）",
    compute: chainBeltDuty,
    inputs: Object.freeze([
      { name: "case", labelZh: "子工况", unit: "", group: "duty" },
      { name: "loadMass_kg", labelZh: "负载 m1", unit: "kg", group: "load" },
      { name: "counterweight_kg", labelZh: "配重 m2", unit: "kg", group: "load" },
      { name: "pitchDiameter_mm", labelZh: "节圆直径 D", unit: "mm", group: "load" },
      { name: "lineSpeed_mm_s", labelZh: "移动速度 v", unit: "mm/s", group: "duty" },
      { name: "accelTime_s", labelZh: "加减速时间 t1", unit: "s", group: "duty" },
      { name: "slopeAngle_deg", labelZh: "坡度角 A（斜坡用）", unit: "°", group: "duty" },
      { name: "frictionCoefficient", labelZh: "摩擦系数 μ", unit: "", group: "duty" },
      { name: "drivenPulley_mm", labelZh: "被动轮直径 D1", unit: "mm", group: "gear" },
      { name: "drivingPulley_mm", labelZh: "主动轮直径 D2", unit: "mm", group: "gear" },
      { name: "motorCount", labelZh: "驱动电机数", unit: "台", group: "duty" }
    ])
  })
});

/** 按 id 取工况；未知工况给中文报错（和"未找到产品系列"同一套口径）。 */
export function gearboxDuty(id) {
  const type = GEARBOX_DUTY_TYPES[id];
  if (!type) {
    throw new Error("未知的工况类型「" + id + "」。可选：" + Object.keys(GEARBOX_DUTY_TYPES).join(" / "));
  }
  return type;
}
