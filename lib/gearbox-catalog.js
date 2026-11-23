// 行星减速机的性能表（data/gearboxes/planetary-catalog.json）。
//
// 数据来源：新立盈减速机综合版 2026（GAB 目录页 067、AFP 页 061、AB 页 055）。
// 目录里的性能表是**矢量曲线**，没有文字层，所以数字是逐格核对抄录的；
// 每个型号都记了 source.pdfPage，改数据前先去那一页对着看。
//
// 这张表回答一个问题：**某个型号在某个比号下，额定输出力矩是多少**。
// 选型里怎么用（见 mtn-select.mjs）：行星装在 MTN 本体的输入侧，它承受的是
// 本体输入轴的力矩 = 盘面需求力矩 ÷ 本体比号 —— 不是盘面力矩本身。

/** 比号的三个级数。PTK 这类有三级（L3）的系列才用 triple；其余系列只有前两个。 */
export const LEVELS = Object.freeze(["single", "double", "triple"]);

/**
 * 一个型号的比号分级。默认用全表的两级表；型号可以自带 `ratioLevels`。
 * 自带是必须的：不同系列的单级/双级比号并不相同（AB 是 3–10 / 12–100，PTK 是
 * 3,4,5,7,10 / 9…200），全表共用一张表会造出"表里没有的比号"。
 */
export function ratioLevelsOf(table, model) {
  const levels = model?.ratioLevels ?? table?.ratioLevels ?? {};
  return {
    single: levels.single ?? [],
    double: levels.double ?? [],
    triple: levels.triple ?? []
  };
}

/** 校验减速机性能表：比号必须在（型号或全表的）两级表里、力矩必须是正数、型号不许重复。 */
export function validateGearboxCatalog(table) {
  const problems = [];
  if (!table || typeof table !== "object") return ["gearbox catalog must be an object"];
  const models = table.models;
  if (!Array.isArray(models) || models.length === 0) {
    problems.push("models must be a non-empty array");
    return problems;
  }

  const levels = table.ratioLevels ?? {};
  const globalKnown = new Set([...(levels.single ?? []), ...(levels.double ?? [])]);
  if (globalKnown.size === 0) problems.push("ratioLevels must list single and double ratios");

  const seen = new Set();
  for (const [index, model] of models.entries()) {
    const where = "models[" + index + "]";
    if (!model || typeof model !== "object") { problems.push(where + " must be an object"); continue; }
    if (!model.model || typeof model.model !== "string") problems.push(where + ".model is required");
    else if (seen.has(model.model)) problems.push(where + ".model is duplicated: " + model.model);
    else seen.add(model.model);

    const known = model.ratioLevels
      ? new Set([...(model.ratioLevels.single ?? []), ...(model.ratioLevels.double ?? []),
        ...(model.ratioLevels.triple ?? [])])
      : globalKnown;
    if (model.ratioLevels && known.size === 0) problems.push(where + ".ratioLevels must not be empty");

    const torques = model.ratedOutputTorque_Nm;
    if (!torques || typeof torques !== "object") {
      problems.push(where + ".ratedOutputTorque_Nm is required");
    } else {
      const keys = Object.keys(torques);
      // 允许只覆盖部分比号（目录里有些框号在低比号写"-"）；但一个都没有就不算性能表。
      if (keys.length === 0) problems.push(where + ".ratedOutputTorque_Nm has no ratios");
      for (const [ratio, torque] of Object.entries(torques)) {
        if (!known.has(Number(ratio))) problems.push(where + " has ratio " + ratio + " which is not in ratioLevels");
        if (!Number.isFinite(torque) || torque <= 0) problems.push(where + " ratio " + ratio + " torque must be a positive number");
      }
    }

    for (const field of ["ratedInputSpeed_rpm", "maxInputSpeed_rpm"]) {
      if (!Number.isFinite(model[field]) || model[field] <= 0) problems.push(where + "." + field + " must be a positive number");
    }
    if (Number.isFinite(model.ratedInputSpeed_rpm) && Number.isFinite(model.maxInputSpeed_rpm) &&
        model.maxInputSpeed_rpm < model.ratedInputSpeed_rpm) {
      problems.push(where + ".maxInputSpeed_rpm is below the rated input speed");
    }
    for (const level of LEVELS) {
      const efficiency = model.efficiency?.[level];
      if (efficiency === undefined && level === "triple") continue;   // 只有 PTK 这类三级系列才有 triple
      if (!Number.isFinite(efficiency) || efficiency <= 0 || efficiency > 1) {
        problems.push(where + ".efficiency." + level + " must be a fraction between 0 and 1");
      }
      // 重量不是选型依据；目录里少数框号（如 AB280）重量行是空的，允许缺，给了就必须是正数。
      const weight = model.weight_kg?.[level];
      if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0)) {
        problems.push(where + ".weight_kg." + level + " must be a positive number when present");
      }
      const backlash = model.backlash_arcmin?.P2?.[level];
      if (backlash !== undefined && (!Number.isFinite(backlash) || backlash <= 0)) {
        problems.push(where + ".backlash_arcmin.P2." + level + " must be a positive number");
      }
    }
    if (!model.source || !Number.isFinite(model.source.pdfPage)) {
      problems.push(where + ".source.pdfPage is required (the catalogue page the numbers came from)");
    }
  }
  return problems;
}

/** 按型号取一条记录；没有就返回 null（不猜）。 */
export function findGearbox(table, model) {
  const key = String(model ?? "").trim();
  return (table?.models ?? []).find(entry => entry.model === key) ?? null;
}

/** 这个减速机在某个比号下的额定输出力矩（Nm）；该比号不存在返回 null。 */
export function ratedTorqueAtRatio(gearbox, ratio) {
  const value = gearbox?.ratedOutputTorque_Nm?.[String(ratio)];
  return Number.isFinite(value) ? value : null;
}

/** 同 ratedTorqueAtRatio，语义更直白的别名（新模块用这个）。 */
export function torqueAtRatio(gearbox, ratio) {
  return ratedTorqueAtRatio(gearbox, ratio);
}

/** 这个比号属于一级 / 二级 / 三级（按表里的 ratioLevels）；不在表里返回 null。 */
export function ratioLevel(table, ratio) {
  if ((table?.ratioLevels?.single ?? []).includes(ratio)) return "single";
  if ((table?.ratioLevels?.double ?? []).includes(ratio)) return "double";
  if ((table?.ratioLevels?.triple ?? []).includes(ratio)) return "triple";
  return null;
}

/** 这个比号在**某个型号**上属于哪一级（型号自带分级时优先用它）。 */
export function ratioLevelOfModel(table, model, ratio) {
  const levels = ratioLevelsOf(table, model);
  if (levels.single.includes(ratio)) return "single";
  if (levels.double.includes(ratio)) return "double";
  if (levels.triple.includes(ratio)) return "triple";
  return null;
}

/** 这个型号有没有三级比号（PTK 这类）。 */
export function hasTripleLevel(model) {
  return (model?.ratioLevels?.triple ?? []).length > 0;
}


/** 比号 → 该型号在这个比号下的效率（一级/二级不同）。 */
export function efficiencyAtRatio(table, gearbox, ratio) {
  const level = ratioLevel(table, ratio);
  const value = level ? gearbox?.efficiency?.[level] : null;
  return Number.isFinite(value) ? value : null;
}
