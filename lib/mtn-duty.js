// 工况计算：把客户的参数换算成"两个关键量"——惯量与扭矩（owner 2026-10-21：选型只认这两个 + 速比）。
//
// 公式来源：公司《选型分类.xlsx》的 1.1圆盘方体 / 1.2圆柱体 / 1.3圆柱体 三张表，
// 逐格照搬，并用表里缓存的计算值做过回归（见 tests/unit/mtn-duty.test.mjs）。
//
// 两个必须照抄的约定（不是笔误，是公司表的既有口径）：
//   - 圆周率取 3.14（不是 Math.PI），安全系数默认 1.5，效率默认 0.85×0.9 = 0.765；
//   - 角速度 ω = 2θ/(t2+t)（t2 = t - t1 - t3，且 t3 = t1）。
//
// 与公司表不同的地方（有意为之，见 docs/MTN_SELECTION_V0.md）：
//   - 惯量一律用 SI 的 kg·m² 表达。公司表 J36/J32 标的是 10⁻⁴ kg·m²，数值 6.25 就是
//     6.25×10⁻⁴ kg·m² —— 换算没问题（2026-10-22 逐格核对过：×10⁴ 换单位、÷i²、÷惯量比）。
//   - 效率默认取 0.85×0.9 = 0.765（表 C33/C22 就是 `=0.85*0.9`）；本体单用时调用方传 0.85。

const PI = 3.14;            // 公司表口径
const G = 9.8;              // 公司表口径

/**
 * 表格 1.1 J36：`=J32*10^4/J13^2/10`，三个除乘各有含义（所有者 2026-10-22 明确）：
 *   ×10⁴    单位换算（换成 10⁻⁴ kg·m²）
 *   ÷ i²    速比的平方（J13 = 选型减速比）
 *   ÷ 10    **惯量比**（表里填 10；常用 5 / 10 / 20）
 * 所以 J36 就是"电机所需惯量"，不是笔误。惯量比变了，这个数跟着变。
 */
export const DEFAULT_INERTIA_RATIO = 10;

/** 负载形状：圆盘（用外径）、方体（用 a×b）、圆柱体（长垂直/平行旋转轴）。 */
export const LOAD_SHAPES = Object.freeze(["disc", "box", "cylinder-perpendicular", "cylinder-parallel"]);

/** 安装方式决定偏心距用哪一个，也决定要不要算偏心力矩 T2。 */
export const MOUNTINGS = Object.freeze(["horizontal", "hanging", "side"]);

function requirePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(name + "必须是正数");
}

/**
 * 负载自身转动惯量（kg·m²）。
 *   disc                  m D² / 8                    （1.1 表 J15）
 *   box                   m (a² + b²) / 12            （1.1 表 J16）
 *   cylinder-perpendicular m(D1²+D2²)/16 + m L²/12    （1.2 表 J14，长度垂直于旋转轴）
 *   cylinder-parallel     m(D1²+D2²)/8                （1.3 表 J14，长度平行于旋转轴）
 */
export function loadInertia_kgm2(load) {
  const mass = load.mass_kg;
  requirePositive("负载质量", mass);
  const mm = value => value / 1000;
  switch (load.shape) {
    case "disc":
      return mass * mm(load.diameter_mm) ** 2 / 8;
    case "box":
      return mass * (mm(load.sideA_mm) ** 2 + mm(load.sideB_mm) ** 2) / 12;
    case "cylinder-perpendicular":
      return mass * (mm(load.outerDiameter_mm) ** 2 + mm(load.innerDiameter_mm ?? 0) ** 2) / 16
        + mass * mm(load.length_mm) ** 2 / 12;
    case "cylinder-parallel":
      return mass * (mm(load.outerDiameter_mm) ** 2 + mm(load.innerDiameter_mm ?? 0) ** 2) / 8;
    default:
      throw new Error("负载形状无效：" + load.shape + "（可选：圆盘 disc / 方体 box / 圆柱体（长⊥轴）cylinder-perpendicular / 圆柱体（长∥轴）cylinder-parallel）");
  }
}

/**
 * 一间歇/连续转动工况 → 惯量、扭矩、速比需求。
 *
 * input（客户参数表来的量，SI）：
 *   load                { shape, mass_kg, diameter_mm?, sideA_mm?, sideB_mm?, outerDiameter_mm?, innerDiameter_mm?, length_mm? }
 *   mounting            "horizontal" | "hanging" | "side"
 *   eccentricity_mm     偏心距（按安装方式取；表里三种工况各有一个 L1）
 *   theta_deg           一次转多少度
 *   cycleTime_s         旋转一次用时
 *   accelTime_s         加速时间，默认 0.5（公司表 J3）
 *   decelTime_s         减速时间，不给就**跟加速时间一样**（公司表 t3 = t1）；
 *                       给了就按给的算（所有者 2026-10-28：减速时间单列一个输入框）
 *   stations            多工位可选 { count, massEach_kg, sideC_mm, sideD_mm, offset_mm }（仅 1.1 表有）
 *   gearboxInertia_kgm2 减速机/平台自身惯量，默认 0（公司表手填）
 *   bodyRatio           本体减速比 i1，默认 1
 *   selectedRatio       选型减速比 i
 *   motorRatedSpeed_rpm 电机额定转速，默认 3000
 *   safetyFactor        安全系数 k，默认 1.5
 *   efficiency          效率 η，默认 0.765
 */
export function dutyFromCustomer(input) {
  const {
    load,
    mounting = "horizontal",
    eccentricity_mm = 0,
    theta_deg,
    cycleTime_s,
    accelTime_s = 0.5,
    decelTime_s = null,
    stations = null,
    gearboxInertia_kgm2 = 0,
    bodyRatio = 1,
    selectedRatio,
    motorRatedSpeed_rpm = 3000,
    safetyFactor = 1.5,
    efficiency = 0.765,
    inertiaRatio = DEFAULT_INERTIA_RATIO
  } = input ?? {};

  if (!MOUNTINGS.includes(mounting)) {
    throw new Error("安装方向无效：" + mounting + "（可选：平装 horizontal / 吊装 hanging / 侧装 side）");
  }
  requirePositive("一次转多少度（θ）", theta_deg);
  requirePositive("转动一次用时（t）", cycleTime_s);
  requirePositive("加速时间", accelTime_s);
  requirePositive("所选速比", selectedRatio);
  requirePositive("本体比号", bodyRatio);
  requirePositive("惯量比", inertiaRatio);

  // 减速时间默认跟随加速时间（公司表 t3 = t1）；所有者 2026-10-28 要求能单独填。
  const decelProvided = decelTime_s !== null && decelTime_s !== undefined && decelTime_s !== "";
  if (decelProvided) requirePositive("减速时间", decelTime_s);
  const decelTime = decelProvided ? Number(decelTime_s) : accelTime_s;
  const uniformTime = cycleTime_s - accelTime_s - decelTime;
  if (uniformTime < 0) {
    // 没填减速时间就是表里那条 t3 = t1，保留原来那句话（页面与测试都引用它）；
    // 单独填了就把两个数都报出来，"是哪一个填大了"一眼能看见。
    throw new Error(decelProvided
      ? "加速时间 + 减速时间不能超过转动一次用时（现在加速 " + accelTime_s +
        " s、减速 " + decelTime + " s，转动一次只有 " + cycleTime_s + " s）"
      : "转动一次用时至少要是加速时间的 2 倍（现在加速时间 " + accelTime_s +
        " s，转动一次只有 " + cycleTime_s + " s）");
  }
  const theta = theta_deg * PI / 180;                  // 表：E10
  const omega = 2 * theta / (uniformTime + cycleTime_s); // 表：J7
  const beta = omega / accelTime_s;                     // 表：J8
  const outputSpeed = omega * 60 / (2 * PI);            // 表：J9（rpm）
  const maxRatio = motorRatedSpeed_rpm / outputSpeed;   // 表：J12

  const inertiaLoad = loadInertia_kgm2(load);
  const offset = eccentricity_mm / 1000;
  const inertiaEccentric = load.mass_kg * offset ** 2;  // 表：J2 = m1 L1²
  const inertiaStations = stations
    ? stations.count * (stations.massEach_kg * ((stations.sideC_mm / 1000) ** 2 + (stations.sideD_mm / 1000) ** 2) / 12
      + stations.massEach_kg * (stations.offset_mm / 1000) ** 2)
    : 0;
  const inertiaTotal = inertiaLoad + inertiaEccentric + inertiaStations + gearboxInertia_kgm2;

  const accelTorque = inertiaTotal * beta;              // 表：T1 = J β
  const offsetTorque = mounting === "side"              // 表：T2 = mgL，只有侧装用得到
    ? load.mass_kg * G * offset
    : 0;
  const torqueTotal = (accelTorque + offsetTorque) * safetyFactor;  // 表：T = (T1+T2) k

  const inertiaReflected = inertiaTotal / bodyRatio ** 2;           // 表：J' = J / i1²
  const torqueReflected = torqueTotal / bodyRatio;                  // 表：T' = T / i1
  const motorTorque = torqueReflected / selectedRatio / efficiency; // 表：T'' = T' / (i η)

  // 表：J'' = J' × 10⁴ / i² / 惯量比（1.1 J36、1.2/1.3 J32）。
  // 这就是"电机所需惯量"：单位换算 ×10⁴、速比平方 ÷i²、再 ÷ 惯量比。
  const motorInertia_10e4 = inertiaReflected * 1e4 / selectedRatio ** 2 / inertiaRatio;
  const motorInertia = motorInertia_10e4 * 1e-4;

  return {
    omega_rad_s: omega,
    beta_rad_s2: beta,
    outputSpeed_rpm: outputSpeed,
    maxRatio,
    inertiaLoad_kgm2: inertiaLoad,
    inertiaEccentric_kgm2: inertiaEccentric,
    inertiaStations_kgm2: inertiaStations,
    inertiaTotal_kgm2: inertiaTotal,
    accelTorque_Nm: accelTorque,
    offsetTorque_Nm: offsetTorque,
    torqueTotal_Nm: torqueTotal,
    inertiaReflected_kgm2: inertiaReflected,
    torqueReflected_Nm: torqueReflected,
    motorTorque_Nm: motorTorque,
    motorInertia_10e4: motorInertia_10e4,
    motorInertia_kgm2: motorInertia,
    assumptions: { PI, G, accelTime: accelTime_s, decelTime, uniformTime, safetyFactor, efficiency, bodyRatio, selectedRatio, inertiaRatio }
  };
}
