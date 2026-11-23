// 换向器 XZTF（所有者 2026-10-29）：给减速机换输出方向的那一级。
//
// 谁在哪：
//   电机 → 行星减速机 → **XZTF 换向器（1:1 或 2:1）** → 负载
//   XZTF 在**输出端**，所以它换的是"减速机的输出方向"（输出轴转 90°），
//   行星仍在它的输入侧——和平台选型（MTN 接行星）是同一个位置口径：
//   行星承受的是 XZTF 输入轴的力矩 = 输出需求 ÷ 本体比号。
//
// 数据口径（所有者 2026-10-29：「数据和之前的 XZTF 一样」）：
//   · 本体比号 1 / 2；065 / 075 / 280 只有 1:1（目录性能表里 2 比是「/」）；
//   · 总速比 = 本体比号 × 行星比号（再乘齿轮副/链轮 i1 才是总传动比）；
//   · 可配的行星按 XZTF 框号查 data/gearboxes/fitment-xztf.json（AFP060/090/115、AB142/180/220）；
//   · 额定输出扭矩、额定输入转速取产品库里那条 XZTF 记录（XZTF090-2 这类）；
//   · 效率 94%（记录里的 efficiency_pct，缺省按 0.94）。
//
// 这个文件是纯函数，没有任何 node: 依赖：托管版和静态版共用同一份。

import { findGearbox, ratioLevelOfModel, torqueAtRatio } from "./gearbox-catalog.js";
import { gearboxesForFrameSize } from "./gearbox-fitment.js";

export const RIGHT_ANGLE_SERIES = "XZTF";

/** 本体比号只有这两种（所有者 2026-10-29）。 */
export const RIGHT_ANGLE_BODY_RATIOS = Object.freeze([1, 2]);

/** 接行星时各框号能用的本体比号；表里没写的框号一律按 1、2 两种。 */
export const BODY_RATIOS_BY_FRAME = Object.freeze({
  "65": Object.freeze([1]),
  "75": Object.freeze([1]),
  "90": Object.freeze([1, 2]),
  "110": Object.freeze([1, 2]),
  "140": Object.freeze([1, 2]),
  "170": Object.freeze([1, 2]),
  "210": Object.freeze([1, 2]),
  "240": Object.freeze([1, 2]),
  "280": Object.freeze([1])
});

/** 记录里没写效率时的缺省值（目录 94%）。 */
export const DEFAULT_RIGHT_ANGLE_EFFICIENCY = 0.94;

/** "065" → "65"：产品库的框号带前导零，配套表也带，比号表不带。 */
export function normalizeFrame(frameSize) {
  return String(frameSize ?? "").trim().replace(/^0+/, "");
}

/** 这个框号接行星时能用哪些本体比号。 */
export function bodyRatiosForFrame(frameSize) {
  const key = normalizeFrame(frameSize);
  return [...(BODY_RATIOS_BY_FRAME[key] ?? RIGHT_ANGLE_BODY_RATIOS)];
}

/** 一条 XZTF 记录能不能参与选型：比号 1/2、额定扭矩与额定输入转速都是正数。 */
export function isSelectableRightAngle(record) {
  return Boolean(record) &&
    record.series === RIGHT_ANGLE_SERIES &&
    RIGHT_ANGLE_BODY_RATIOS.includes(record.ratio) &&
    Number.isFinite(record.ratedOutputTorque_Nm) && record.ratedOutputTorque_Nm > 0 &&
    Number.isFinite(record.ratedInputSpeed_rpm) && record.ratedInputSpeed_rpm > 0;
}

/** 换向器效率（记录里写的是百分数 94）。 */
export function rightAngleEfficiency(record) {
  const value = record?.efficiency_pct;
  if (Number.isFinite(value) && value > 0 && value <= 100) return value / 100;
  return DEFAULT_RIGHT_ANGLE_EFFICIENCY;
}

/**
 * 按框号把 XZTF 记录收成一张表：[{ frameSize, frame, models: {1: 记录, 2: 记录} }]，框号从小到大。
 * 同一框号同一比号只留第一条（产品库里不会重复，重复也按先来的算）。
 */
export function rightAngleFrames(records = []) {
  const frames = [];
  for (const record of records) {
    if (!isSelectableRightAngle(record)) continue;
    const key = normalizeFrame(record.frameSize);
    if (!key) continue;
    let frame = frames.find(item => item.frame === key);
    if (!frame) {
      frame = { frame: key, frameSize: String(record.frameSize), models: {} };
      frames.push(frame);
    }
    if (!frame.models[record.ratio]) frame.models[record.ratio] = record;
  }
  return frames.sort((a, b) => Number(a.frame) - Number(b.frame));
}

/** 换向器能用的框号（给页面提示 / 测试用）。 */
export function rightAngleFrameSizes(records = []) {
  return rightAngleFrames(records).map(frame => frame.frameSize);
}

/** 换向器能配的全部行星型号（去重，按框号顺序）。 */
export function rightAnglePlanetaryModels(fitment) {
  const models = [];
  for (const entry of fitment?.fitment ?? []) {
    for (const model of entry.gearboxes ?? []) {
      if (!models.includes(model)) models.push(model);
    }
  }
  return models;
}

/**
 * 换向器 + 行星的组合：总减速比 i2 = 本体比号 × 行星比号。
 *
 * 只有"行星按框号配得上、行星比号在性能表里、本体比号这个框号允许"的组合才会被列出来；
 * 扭矩/转速不在这里判（那是选型层的事），这样报错时能说清是"比号凑不出"还是"扭矩不够"。
 *
 * 返回：
 *   options          组合数组，每项 { frame, bodyRatio, xztf, planetary, planetaryRatio, level }
 *   achievableRatios 换向器下能选的总减速比（排序去重，报错用）
 *   planetaryModels  换向器能配的行星型号
 */
export function rightAngleOptions({ records = [], fitment = null, catalog = null, outputRatio } = {}) {
  const wanted = Number(outputRatio);
  const options = [];
  const achievable = new Set();
  const planetaryModels = [];
  if (!catalog?.models?.length || !Number.isFinite(wanted) || wanted <= 0) {
    return { options, achievableRatios: [], planetaryModels };
  }

  for (const frame of rightAngleFrames(records)) {
    const bodyRatios = bodyRatiosForFrame(frame.frame).filter(ratio => frame.models[ratio]);
    const fitted = gearboxesForFrameSize(fitment, frame.frameSize);
    for (const model of fitted) {
      if (!planetaryModels.includes(model)) planetaryModels.push(model);
      const box = findGearbox(catalog, model);
      if (!box) continue;
      for (const ratio of Object.keys(box.ratedOutputTorque_Nm ?? {}).map(Number)) {
        for (const bodyRatio of bodyRatios) achievable.add(round(bodyRatio * ratio, 6));
      }
    }
    for (const bodyRatio of bodyRatios) {
      const planetaryRatio = round(wanted / bodyRatio, 6);
      if (!Number.isFinite(planetaryRatio) || planetaryRatio <= 0) continue;
      if (Math.abs(planetaryRatio * bodyRatio - wanted) > 1e-9) continue;   // 除不尽（如 35 ÷ 2）
      for (const model of fitted) {
        const box = findGearbox(catalog, model);
        if (!box) continue;
        const rated = torqueAtRatio(box, planetaryRatio);
        if (rated === null) continue;
        options.push({
          frame: frame.frame,
          frameSize: frame.frameSize,
          bodyRatio,
          xztf: frame.models[bodyRatio],
          planetary: box,
          planetaryRatio,
          level: ratioLevelOfModel(catalog, box, planetaryRatio)
        });
      }
    }
  }
  return {
    options,
    achievableRatios: [...achievable].sort((a, b) => a - b),
    planetaryModels
  };
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}
