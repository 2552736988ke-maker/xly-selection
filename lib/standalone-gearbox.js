// 单独减速机（行星减速机单卖）：AB / ABR / AFP / AFPR / AD / ADR（所有者 2026-11-23）。
//
// 口径：旋转工况算出来的**最终转矩**直接和减速机的额定输出转矩比。减速机输出轴就是
// 最终输出，中间没有平台本体，所以需求转矩不除任何比号 —— 这一点和"本体 + 行星"不同
// （那种情况行星承受的是本体输入侧 = 盘面需求 ÷ 本体比号，见 mtn-select.mjs）。
//
// 一条记录 = 一个「型号-速比」（如 AB060-10）：目录的性能表按比号给额定转矩，
// 不拆开的话选型引擎没法拿同一个型号的不同比号分别比容量。
//
// 数据来自 data/gearboxes/planetary-catalog.json（逐格核对过的那张表）：
//   ratedOutputTorque_Nm[比号]   该比号下的额定输出转矩
//   ratedInputSpeed_rpm          额定输入转速 → 最高输出转速 = 额定输入 ÷ 比号
//   efficiency.single / double   单级 / 双级效率（各系列不同，0.9–0.97）
//   backlash_arcmin.P2.级别      背隙、weight_kg.级别 重量（目录给了才带）

import { ratioLevelOfModel } from "./gearbox-catalog.js";

/** 所有者点名的六个系列；其余行星系列（AE / ESP / GAB / PTK …）暂不进旋转工况选型。 */
export const STANDALONE_GEARBOX_SERIES = Object.freeze(["AB", "ABR", "AFP", "AFPR", "AD", "ADR"]);

export const STANDALONE_GEARBOX_SET = new Set(STANDALONE_GEARBOX_SERIES);

export function isStandaloneGearboxSeries(series) {
  return STANDALONE_GEARBOX_SET.has(series);
}

/** 性能表里有数据的六个系列（用于页面/接口的系列清单，不写死到页面里）。 */
export function standaloneSeriesIn(catalog) {
  const present = new Set((catalog?.models ?? []).map(model => model.series));
  return STANDALONE_GEARBOX_SERIES.filter(series => present.has(series));
}

/**
 * 把性能表展开成选型记录：每个型号 × 每个有额定转矩的比号一条。
 *
 * @param {object} catalog planetary-catalog.json 的内容
 * @param {{series?: string|null}} [options] 只取某一个系列（页面一次只选一个系列）
 */
export function standaloneSelectionRecords(catalog, { series = null } = {}) {
  const wanted = series ? [series] : STANDALONE_GEARBOX_SERIES;
  const records = [];
  for (const model of catalog?.models ?? []) {
    if (!wanted.includes(model.series)) continue;
    for (const [ratioText, torque] of Object.entries(model.ratedOutputTorque_Nm ?? {})) {
      const ratio = Number(ratioText);
      if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(torque) || torque <= 0) continue;
      const level = ratioLevelOfModel(catalog, model, ratio);
      const efficiency = level ? model.efficiency?.[level] : null;
      const inputSpeed = Number(model.ratedInputSpeed_rpm);
      records.push({
        // 型号带比号：页面上"AB060-10"就是 AB060 的 10:1，不会和同型号别的比号混在一起。
        model: model.model + "-" + ratio,
        series: model.series,
        frameSize: model.frameSize,
        ratio,
        ratedOutputTorque_Nm: torque,
        // 额定输入 ÷ 比号 = 输出轴允许转速（用额定输入转速，和 XZT 换向器的口径一致）
        maxOutputSpeed_rpm: Number.isFinite(inputSpeed) && inputSpeed > 0 ? inputSpeed / ratio : undefined,
        maxInputSpeed_rpm: model.maxInputSpeed_rpm,
        // 这个比号下的目录效率：单级 / 双级不一样，选型里按它算电机必须扭矩
        efficiency: Number.isFinite(efficiency) ? efficiency : null,
        gearboxLevel: level,
        gearboxModel: model.model,
        backlash_arcmin: model.backlash_arcmin?.P2?.[level] ?? null,
        weight_kg: model.weight_kg?.[level] ?? null,
        status: model.status ?? "DRAFT",
        source: model.source,
        family: "gearbox"
      });
    }
  }
  // 型号 → 比号排序：候选表稳定，页面/报告顺序不会因对象键序变化而跳。
  return records.sort((a, b) =>
    a.series.localeCompare(b.series) ||
    String(a.frameSize).localeCompare(String(b.frameSize)) ||
    a.ratio - b.ratio);
}
