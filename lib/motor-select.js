// 电机选择：给"电机侧需要的扭矩/转速/惯量比"，从电机表里挑最小的一台。
//
// 所有者 2026-10-21 的流程：扭矩 + 惯量 + 速比 → **先选出满足的电机**；再看速比选本体还是本体+行星。
// 电机数据来自公司《选型分类.xlsx》的「汇川-R」表（其余品牌是隐藏表，暂未导入）。
//
// 这里只做三件校核，并且会告诉你"是哪一条把你卡住了"（bindingConstraint）：
//   1. 额定转矩 ≥ 电机侧需要的转矩；
//   2. 额定转速 ≥ 电机侧需要的转速；
//   3. 折算惯量 / 电机转子惯量 ≤ 惯量比上限。
// 惯量比往往是最严的一条：平台本体的减速比只有 5/10/15/18，负载惯量折算到电机后仍然很大。

/** 电机表自检：字段齐全、正数、功率与扭矩/转速自洽（P ≈ T·n/9550）。 */
export function validateMotorTable(table) {
  const problems = [];
  if (!table || typeof table !== "object") return ["motor table must be an object"];
  const motors = table.motors;
  if (!Array.isArray(motors) || motors.length === 0) problems.push("motors must be a non-empty array");
  const seen = new Set();
  for (const [index, motor] of (motors ?? []).entries()) {
    const where = "motors[" + index + "]";
    if (!motor || typeof motor !== "object") { problems.push(where + " must be an object"); continue; }
    if (!motor.model || typeof motor.model !== "string") problems.push(where + ".model is required");
    else if (seen.has(motor.model)) problems.push(where + ".model is duplicated: " + motor.model);
    else seen.add(motor.model);
    for (const field of ["power_W", "ratedSpeed_rpm", "ratedTorque_Nm", "rotorInertia_kgm2"]) {
      const value = motor[field];
      if (!Number.isFinite(value) || value <= 0) problems.push(where + "." + field + " must be a positive number");
    }
    if (Number.isFinite(motor.power_W) && Number.isFinite(motor.ratedTorque_Nm) && Number.isFinite(motor.ratedSpeed_rpm)) {
      const computed = motor.ratedTorque_Nm * motor.ratedSpeed_rpm / 9550 * 1000;
      const deviation = Math.abs(computed - motor.power_W) / motor.power_W;
      if (deviation > 0.06) {
        problems.push(where + " power " + motor.power_W + " W disagrees with torque×speed (" + computed.toFixed(0) + " W)");
      }
    }
  }
  return problems;
}

/**
 * 惯量按 ×10-4 kg·m² 显示（与电机表同口径；PDF 字体没有上标负号，所以用 ASCII 的 -4）。
 */
function inertiaTimes10k(value) {
  const scaled = value * 1e4;
  const digits = Math.abs(scaled) >= 100 ? 1 : Math.abs(scaled) >= 10 ? 2 : 3;
  return String(Number(scaled.toFixed(digits)));
}

/**
 * 挑一台电机。
 *
 * need:
 *   torque_Nm          电机轴侧需要的扭矩（含效率与安全系数）
 *   speed_rpm          电机轴侧需要的转速
 *   reflectedInertia_kgm2  折算到电机轴的负载惯量（含平台自身惯量）
 * options:
 *   maxInertiaRatio    惯量比上限，默认 10
 */
export function selectMotor(need, motors, options = {}) {
  const { torque_Nm, speed_rpm = null, reflectedInertia_kgm2 = null } = need ?? {};
  const maxInertiaRatio = options.maxInertiaRatio ?? 10;
  if (!Number.isFinite(torque_Nm) || torque_Nm <= 0) throw new Error("need.torque_Nm must be a positive number");

  // 电机所需惯量 J'' = 折算惯量 ÷ 惯量比；报错时说的是**惯量**（不是惯量比）。
  const neededInertia = reflectedInertia_kgm2 === null ? null : reflectedInertia_kgm2 / maxInertiaRatio;

  const passing = [];
  const rejected = [];
  for (const motor of motors ?? []) {
    const checks = { torque: true, speed: true, inertia: true };
    if (!(motor.ratedTorque_Nm >= torque_Nm)) checks.torque = false;
    if (speed_rpm !== null && !(motor.ratedSpeed_rpm >= speed_rpm)) checks.speed = false;
    let inertiaRatio = null;
    // 带抱闸时用的是"抱闸惯量"（调用方通过 effectiveInertia_kgm2 传进来），不是转子惯量。
    const inertia = motor.effectiveInertia_kgm2 ?? motor.rotorInertia_kgm2;
    if (reflectedInertia_kgm2 !== null && inertia) {
      inertiaRatio = reflectedInertia_kgm2 / inertia;
      if (inertiaRatio > maxInertiaRatio) checks.inertia = false;
    }
    // 这几种原因会原样显示在页面上（所有者 2026-10-26：报错要给具体原因），所以写成中文。
    if (!checks.torque) { rejected.push({ model: motor.model, reason: "额定转矩 " + motor.ratedTorque_Nm + " N·m 低于所需 " + torque_Nm + " N·m" }); continue; }
    if (!checks.speed) { rejected.push({ model: motor.model, reason: "额定转速 " + motor.ratedSpeed_rpm + " r/min 低于所需 " + Math.round(speed_rpm) + " r/min" }); continue; }
    if (!checks.inertia) {
      // 说的是**惯量**：J'' = 折算惯量 ÷ 惯量比，再和电机惯量比大小；不是"惯量比超了"。
      rejected.push({ model: motor.model, reason: "所需惯量 " + inertiaTimes10k(neededInertia) +
        " ×10-4 kg·m² 超过电机惯量 " + inertiaTimes10k(inertia) + " ×10-4 kg·m²（惯量比 " + maxInertiaRatio + "）" });
      continue;
    }
    passing.push({ motor, inertiaRatio });
  }

  passing.sort((a, b) => a.motor.power_W - b.motor.power_W || a.motor.ratedTorque_Nm - b.motor.ratedTorque_Nm);
  const choice = passing[0] ?? null;

  // 是"扭矩/转速/惯量"里的哪一条把电机逼到这么大？
  let bindingConstraint = null;
  if (choice) {
    const byTorque = (motors ?? []).filter(motor => motor.ratedTorque_Nm >= torque_Nm)
      .sort((a, b) => a.power_W - b.power_W)[0];
    const byTorqueAndSpeed = (motors ?? []).filter(motor =>
      motor.ratedTorque_Nm >= torque_Nm && (speed_rpm === null || motor.ratedSpeed_rpm >= speed_rpm))
      .sort((a, b) => a.power_W - b.power_W)[0];
    if (byTorque?.model === choice.motor.model) bindingConstraint = "torque";
    else if (byTorqueAndSpeed?.model === choice.motor.model) bindingConstraint = "speed";
    else bindingConstraint = "inertia";
  }

  // 一台都选不出来时，到底是卡在哪一条（null = 选出来了）。
  // 判法：先看有多少台过转矩，再看其中有没有过转速的——都过转速还选不出来，就是惯量比。
  let failureConstraint = null;
  if (!choice) {
    const torqueOk = (motors ?? []).filter(motor => motor.ratedTorque_Nm >= torque_Nm);
    const speedOk = speed_rpm === null
      ? torqueOk
      : torqueOk.filter(motor => motor.ratedSpeed_rpm >= speed_rpm);
    failureConstraint = speedOk.length ? "inertia" : torqueOk.length ? "speed" : "torque";
  }

  return { motor: choice?.motor ?? null, inertiaRatio: choice?.inertiaRatio ?? null, bindingConstraint, failureConstraint, rejected };
}
