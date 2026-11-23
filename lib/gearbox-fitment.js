// 本体规格 → 可配的行星减速机型号（所有者 2026-10-21 口述）。
//
// 现在只有 MTN 一张对照表（data/gearboxes/fitment-mtn.json）：
//   MTN060 → GAB042；MTN85/130 → AFP060；MTN200 → AFP090；
//   MTN280 → AFP090 或 AFP115；MTN350/450/550 → AFP115；MTN700 → AB142。
//
// 减速机自身的参数（比号表、额定扭矩、法兰）**还没有数据**，所以这里只做"型号对照"，
// 不参与容量校核；等所有者给出减速机参数后再接进选型（见 docs/MTN_SELECTION_V0.md §十一）。

/** 简单自检：结构对不对、frameSize 有没有重复、gearboxes 是不是非空字符串数组。 */
export function validateFitment(table) {
  const problems = [];
  if (!table || typeof table !== "object") return ["fitment table must be an object"];
  if (!Array.isArray(table.fitment) || table.fitment.length === 0) {
    problems.push("fitment must be a non-empty array");
    return problems;
  }
  const seen = new Set();
  for (const [index, entry] of table.fitment.entries()) {
    const where = "fitment[" + index + "]";
    if (!entry || typeof entry !== "object") { problems.push(where + " must be an object"); continue; }
    if (!entry.frameSize || typeof entry.frameSize !== "string") problems.push(where + ".frameSize is required");
    else if (seen.has(entry.frameSize)) problems.push(where + ".frameSize is duplicated: " + entry.frameSize);
    else seen.add(entry.frameSize);
    if (!Array.isArray(entry.gearboxes) || entry.gearboxes.length === 0) {
      problems.push(where + ".gearboxes must be a non-empty array");
      continue;
    }
    for (const model of entry.gearboxes) {
      if (!model || typeof model !== "string") problems.push(where + ".gearboxes contains a non-string");
    }
  }
  return problems;
}

/** 这个规格框号能配哪些减速机型号（没有对照就返回空数组，不猜）。 */
export function gearboxesForFrameSize(table, frameSize) {
  const key = String(frameSize ?? "").trim();
  const entry = (table?.fitment ?? []).find(item => item.frameSize === key);
  return entry ? [...entry.gearboxes] : [];
}
