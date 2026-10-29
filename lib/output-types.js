// 换向器（XZT / XZTF）的输出型式：订货代号，不含任何计算。
//
// 口径来源：docs/selection-drafts/XZT-data-inventory.md §9（所有者 2026-10-26 口述）。
// 结构只有三种，两套命名指的是同一个东西（同本体、不同命名，目录里就这么印）：
//
//   结构          中文               XZTF 代号      XZT 代号      左 / 右
//   轴输出        实心轴输出          FL             L             FL1 / FR1  ·  L1 / R1
//   胀紧套孔输出  一根轴中间孔+胀紧套  FC             C             FCL / FCR  ·  CL / CR
//   孔输出        一根轴中间贯穿孔    FH             H             —（没有左右型）
//
// 所以"输出型式"在内部只记**结构 + 左右**（id），代号按选中的系列现算：
// 选 XZTF 就写 FC，选 XZT 就写 C。这样页面上一个下拉就够，切系列也不会选错代号。
// 两套命名一一对应这件事，所有者 2026-10-26 晚确认过（§9 那句"等所有者确认一句"已了）。
//
// 目录里还有 F4M / FLM / FRM（XZT：4M / LM / RM），**不做**（所有者 2026-10-26 晚：
// 「4M/LM 那些不要做」）。

/** 平台（中空旋转平台）没有输出型式：输出就是转台盘面。 */
export const PLATFORM_SERIES = Object.freeze(["MTN", "ZTT", "MTT"]);

/** 换向器：只有这两个系列吃输出型式。 */
export const GEARBOX_SERIES = Object.freeze(["XZT", "XZTF"]);

/**
 * 七种形态。`id` 是内部键（页面下拉的 value、接口的入参都接受它），
 * `codes` 是两套目录代号，`zh` 是给人看的名字。
 */
export const OUTPUT_FORMS = Object.freeze([
  Object.freeze({
    id: "clamp-double", structure: "clamp", side: "double",
    zh: "胀紧套孔输出（双）", detail: "一根轴中间孔输出，两侧胀紧套锁紧",
    codes: Object.freeze({ XZT: "C", XZTF: "FC" })
  }),
  Object.freeze({
    id: "clamp-left", structure: "clamp", side: "left",
    zh: "胀紧套孔输出（左）", detail: "胀紧套孔输出，单侧（左）",
    codes: Object.freeze({ XZT: "CL", XZTF: "FCL" })
  }),
  Object.freeze({
    id: "clamp-right", structure: "clamp", side: "right",
    zh: "胀紧套孔输出（右）", detail: "胀紧套孔输出，单侧（右）",
    codes: Object.freeze({ XZT: "CR", XZTF: "FCR" })
  }),
  Object.freeze({
    id: "shaft-double", structure: "shaft", side: "double",
    zh: "轴输出（双）", detail: "实心轴输出，两侧出轴",
    codes: Object.freeze({ XZT: "L", XZTF: "FL" })
  }),
  Object.freeze({
    id: "shaft-left", structure: "shaft", side: "left",
    zh: "轴输出（左）", detail: "实心轴输出，单侧（左）",
    codes: Object.freeze({ XZT: "L1", XZTF: "FL1" })
  }),
  Object.freeze({
    id: "shaft-right", structure: "shaft", side: "right",
    zh: "轴输出（右）", detail: "实心轴输出，单侧（右）",
    codes: Object.freeze({ XZT: "R1", XZTF: "FR1" })
  }),
  Object.freeze({
    id: "hole", structure: "hole", side: "single",
    zh: "孔输出（单孔）", detail: "一根轴中间一个贯穿孔，没有左右型",
    codes: Object.freeze({ XZT: "H", XZTF: "FH" })
  })
]);

/**
 * 默认输出型式：**FC（胀紧套孔输出，双）**。
 * 所有者 2026-10-26 确认过「默认 FC 可以」——这是定稿口径，不是临时值。
 */
export const DEFAULT_OUTPUT_FORM = "clamp-double";

const BY_ID = new Map(OUTPUT_FORMS.map(form => [form.id, form]));
const BY_CODE = new Map();
for (const form of OUTPUT_FORMS) {
  for (const [series, code] of Object.entries(form.codes)) BY_CODE.set(code.toUpperCase(), form);
}

const CODE_HINT = "XZT 用 L / C / H，XZTF 用 FL / FC / FH（左右型 L1 / R1、CL / CR，或 FL1 / FR1、FCL / FCR）";

/** 页面下拉用的选项（顺序就是页面上看到的顺序，第一个是默认）。 */
export function outputFormOptions() {
  return OUTPUT_FORMS.map(form => ({ value: form.id, label: form.zh, codes: form.codes }));
}

export function outputFormById(id) {
  return BY_ID.get(String(id ?? "").trim()) ?? null;
}

/** 按目录代号反查（"FC"、"c"、"FL1" 都认），两套命名都收。 */
export function outputFormByCode(code) {
  return BY_CODE.get(String(code ?? "").trim().toUpperCase()) ?? null;
}

/**
 * 把接口/页面传来的值解析成形态。接受：形态 id（"clamp-double"）、目录代号（"FC" / "C"）、空（= 默认）。
 * 不认识就抛中文错误——页面会把它显示成 400，不甩英文字段名。
 */
export function resolveOutputForm(value) {
  if (value === undefined || value === null || value === "") return BY_ID.get(DEFAULT_OUTPUT_FORM);
  const raw = String(value).trim();
  const form = outputFormById(raw) ?? outputFormByCode(raw);
  if (form) return form;
  throw new Error("输出型式「" + raw + "」不认识。" + CODE_HINT + "。");
}

/** 这一台产品要不要写输出型式：只有换向器要（平台输出就是转台盘面）。 */
export function outputFormApplies(series) {
  return GEARBOX_SERIES.includes(series);
}

/** 按系列给订货代号；平台或未知系列返回 null（调用方据此决定印不印这一行）。 */
export function outputCode(form, series) {
  if (!form || !series || !outputFormApplies(series)) return null;
  return form.codes?.[series] ?? null;
}

/** 报告/页面上一行写完：`胀紧套孔输出（双）FC`；平台返回 null。 */
export function outputText(form, series) {
  const code = outputCode(form, series);
  if (!code) return null;
  return form.zh + " " + code;
}
