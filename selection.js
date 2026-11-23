// 选型页的前端逻辑：读表单 → 算一次 → 渲染。
// 页面里没有公式：所有公式都在 shared/src/selection 下，页面只负责收集参数和显示结果。
//
// 两种跑法（2026-10-27，A 方案：静态版）：
//   · 托管版（3005）：POST /api/selection，引擎在 Node 里跑；
//   · 静态版（dist-static/）：由 lib/engine.js 设置 window.__selectionEngine，页面把**同一个**
//     runSelection 直接跑在浏览器里——不发任何请求，所以能丢到纯静态托管上。
//
// 页面上刻意只显示客户要看的东西（型号、总速比、减速机、电机功率）；
// 余量、惯量、被排除原因这些内部信息放在 ?debug=1 里。

const form = document.getElementById("form");
const output = document.getElementById("output");
const debugBox = document.getElementById("debug");
const placeholder = document.getElementById("placeholder");
const statusEl = document.getElementById("status");
const maxRatioHint = document.getElementById("maxRatioHint");
const DEBUG = new URLSearchParams(location.search).has("debug");
// 上一次提交的参数：报告接口按它重新算一遍再排版，页面不往报告里塞任何数字。
let lastPayload = null;

// —— 报告附件（2026-10-28）：工况图最多 4 张（浏览器里先压小）+ 一段文字备注 ——
// 只跟着"生成报告"发出去，不参与任何计算；静态版没有后端时随打印头一起印出来。
const MAX_ATTACHMENTS = 4;
const attachments = [];
const imageInput = document.getElementById("reportImages");
const attachmentPreview = document.getElementById("attachmentPreview");
const remarksInput = document.getElementById("reportRemarks");

function renderAttachments() {
  if (!attachmentPreview) return;
  attachmentPreview.innerHTML = attachments.map((item, index) =>
    "<figure><img src=\"" + item.dataUrl + "\" alt=\"图 " + (index + 1) + "\">" +
    "<button type=\"button\" data-remove=\"" + index + "\" title=\"移除\">×</button></figure>").join("");
  const hint = document.getElementById("attachmentHint");
  if (hint) hint.textContent = "已选 " + attachments.length + " / " + MAX_ATTACHMENTS + " 张（自动压缩），附在报告「工况图」页";
  refreshPrintExtras();
}

remarksInput?.addEventListener("input", refreshPrintExtras);

/** 浏览器里先缩到长边 ≤ 1400 px、JPEG 0.82：一张通常 200–400 KB，服务端不用收原图。 */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  bitmap.close?.();
  return { dataUrl };
}

imageInput?.addEventListener("change", async event => {
  const files = [...(event.target.files ?? [])];
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    if (!String(file.type).startsWith("image/")) continue;
    try { attachments.push(await shrinkImage(file)); } catch { /* 读不出来的图跳过 */ }
  }
  event.target.value = "";
  renderAttachments();
});

attachmentPreview?.addEventListener("click", event => {
  const button = event.target.closest("button[data-remove]");
  if (!button) return;
  attachments.splice(Number(button.dataset.remove), 1);
  renderAttachments();
});

/** 报告请求的 metadata：版本 + 备注 + 工况图（顺序就是页面上的顺序）+ 水印开关。 */
function reportMetadata(variant) {
  return {
    variant,
    // 所有者 2026-10-28：报告默认带公司 logo + 水印，勾掉才不带（服务端只认布尔 false）。
    watermark: watermarkEnabled(),
    remarks: String(remarksInput?.value ?? ""),
    images: attachments.map(item => item.dataUrl)
  };
}

// ——— 报告带不带公司水印（所有者 2026-10-28）———
// 默认带；一个普通勾选框，不设门槛。勾掉后：下载的 PDF 不带 logo/水印，
// 静态版打印出来的纸上也没有那张浅色水印图。
let reportWatermark = true;
const watermarkEnabled = () => reportWatermark;

function watermarkToggle() {
  const label = el("label", "watermark-toggle");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = "withWatermark";
  box.checked = reportWatermark;
  box.addEventListener("change", () => {
    reportWatermark = box.checked;
    refreshPrintExtras();     // 打印区的水印图跟着勾选框走
  });
  label.append(box, el("span", "", "报告带公司水印"));
  return label;
}

// ——— 产品类型（大类）→ 产品系列（小类）：所有者 2026-11-23 ———
// 单独减速机（AB / ABR / AFP / AFPR / AD / ADR）也要进旋转工况选型。六个系列不再和平台
// 堆在同一个下拉里：先选大类，再选系列，下拉最多 6 项。
const PRODUCT_GROUPS = Object.freeze({
  platform: Object.freeze({
    label: "旋转平台 / 整机",
    series: Object.freeze([
      ["MTN", "MTN 系列"], ["ZTT", "ZTT 系列"], ["HL", "HL 系列"], ["BX", "BX 系列（摆线针轮）"]
    ])
  }),
  standalone: Object.freeze({
    label: "单独减速机",
    series: Object.freeze([
      ["AB", "AB 系列"], ["ABR", "ABR 系列"], ["AFP", "AFP 系列"],
      ["AFPR", "AFPR 系列"], ["AD", "AD 系列"], ["ADR", "ADR 系列"]
    ])
  }),
  commutator: Object.freeze({
    label: "换向器",
    series: Object.freeze([["XZT", "XZT 系列"], ["XZTF", "XZTF 系列"]])
  })
});

const ALL_SERIES = new Set(Object.values(PRODUCT_GROUPS).flatMap(group => group.series.map(([id]) => id)));
const STANDALONE_SERIES = new Set(PRODUCT_GROUPS.standalone.series.map(([id]) => id));

function groupOfSeries(series) {
  for (const [key, group] of Object.entries(PRODUCT_GROUPS)) {
    if (group.series.some(([id]) => id === series)) return key;
  }
  return "platform";
}

const currentGroup = () => form.elements.productGroup?.value ?? "platform";
const isStandaloneGroup = () => currentGroup() === "standalone";

/** 换向器（XZT / XZTF）本体效率按目录「满载效率 ≤94%」预填；切回平台恢复 0.85。 */
const SERIES_BODY_EFFICIENCY = { XZT: "0.94", XZTF: "0.94" };

/** 按当前大类重建系列下拉；keep = 当前系列还在这一大类里就保留。 */
function syncProductGroup({ keep = false } = {}) {
  const select = form.elements.productSeries;
  const group = PRODUCT_GROUPS[currentGroup()] ?? PRODUCT_GROUPS.platform;
  const current = select.value;
  const next = keep && group.series.some(([id]) => id === current) ? current : group.series[0][0];
  select.textContent = "";
  for (const [id, label] of group.series) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    select.append(option);
  }
  select.value = next;
  const hint = document.getElementById("groupHint");
  if (hint) hint.textContent = group.series.map(([, label]) => label.replace(/（.*$/, "")).join(" / ");
  syncSeriesRows();
}

/** 大类相关的行：效率两框只在平台/换向器；单独减速机用目录效率并显示说明。 */
function syncSeriesRows() {
  const group = currentGroup();
  for (const row of form.querySelectorAll("[data-hide-group]")) {
    row.hidden = row.dataset.hideGroup.split(" ").includes(group);
  }
  for (const row of form.querySelectorAll("[data-only-group]")) {
    row.hidden = !row.dataset.onlyGroup.split(" ").includes(group);
  }
  syncOutputType();
}

form.elements.productGroup?.addEventListener("change", () => syncProductGroup());

form.elements.productSeries?.addEventListener("change", event => {
  const field = form.elements.bodyEfficiency;
  // 单独减速机不用平台效率：效率按目录（记录里带），两框已隐藏、也不往接口发。
  if (field && !isStandaloneGroup()) field.value = SERIES_BODY_EFFICIENCY[event.target.value] ?? "0.85";
  syncSeriesRows();
});

// 输出型式只在换向器上出现（所有者 2026-10-26：不是禁用，是**直接不显示**）：
// 平台（MTN / ZTT / MTT）的输出就是转台盘面，没有 FC / L 这种代号；「全部系列」也不显示，
// 只在 XZT / XZTF 时把这一行拿出来。
const OUTPUT_TYPE_SERIES = ["XZT", "XZTF"];
function syncOutputType() {
  const field = form.elements.outputType;
  if (!field) return;
  const series = form.elements.productSeries.value;
  const show = OUTPUT_TYPE_SERIES.includes(series);
  const row = field.closest("tr");
  if (row) row.hidden = !show;
  // 不显示时一并禁用：这条不会随表单发出去，服务端也不会以为用户选过型式
  field.disabled = !show;
}

const REPORT_ENDPOINT = "/api/v1/reports/selection/pdf";

// 静态版入口由 lib/engine.js 挂上来；托管版没有它，就走接口。null 表示"要发请求"。
const LOCAL_ENGINE = typeof window !== "undefined" ? (window.__selectionEngine ?? null) : null;

const EXAMPLE = {
  mounting: "horizontal",
  shape: "box",
  sideA_mm: 500,
  sideB_mm: 500,
  eccentricity_mm: 0,
  mass_kg: 15,
  mode: "intermittent",
  theta_deg: 180,
  cycleTime_s: 1,
  accelTime_s: 0.5,
  decelTime_s: 0.5,
  ratio: 30,
  // 多工位（《选型分类》1.1 表 B19–C26）：示例按单件给（0），要试多工位就自己填。
  "stations.count": 0,
  "stations.massEach_kg": 0,
  "stations.sideC_mm": 0,
  "stations.sideD_mm": 0,
  "stations.offset_mm": 0
};

function number(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return String(Number(value.toFixed(digits)));
}

const INERTIA_UNIT = "×10⁻⁴ kg·m²";
const INERTIA_SCALE = 1e-4;

const showValue = value => (value === null || value === undefined || value === "" ? "—" : String(value));

/**
 * 打印头（只在打印时出现，屏幕上看不见）：标题、日期、这一单的工况参数。
 *
 * 同事最后是用浏览器"打印 → 另存为 PDF"把报告发给客户的，而打印时表单是藏起来的
 * （@media print 把 form 全部 display:none）——不补这一段，纸上就只有结论、没有客户输入，
 * 客户没法核对"这份报告是按哪组参数算的"。
 */
function printHead(payload, data) {
  const box = el("div", "print-only");
  if (!payload) return box;
  box.append(el("h1", "", "新立盈 · 平台选型报告"));
  const modeText = data.mode === "continuous" ? "连续工况" : "间歇工况";
  box.append(el("div", "print-meta",
    modeText + "　·　" + showValue(payload.productSeries) + " 系列　·　生成日期 " + new Date().toLocaleDateString("zh-CN")));
  const params = ["负载 " + showValue(payload.load?.mass_kg) + " kg"];
  if ((payload.stations?.count ?? 0) > 0) {
    params.push("多工位 " + payload.stations.count + " × " + showValue(payload.stations.massEach_kg) + " kg（L2 = " +
      showValue(payload.stations.offset_mm) + " mm）");
  }
  if (data.mode === "continuous") {
    params.push("输出转速 " + showValue(payload.outputSpeed_rpm) + " r/min",
      "负载转矩 " + showValue(payload.loadTorque_Nm) + " N·m");
  } else {
    params.push("θ = " + showValue(payload.theta_deg) + "°", "t = " + showValue(payload.cycleTime_s) + " s",
      "t1 = " + showValue(payload.accelTime_s) + " s",
      "t3 = " + showValue(payload.decelTime_s ?? payload.accelTime_s) + " s");
  }
  // 工况一行、选型一行：一行太长会在中文字中间折行（纸上很难看）。
  const selectionParams = [
    "速比 " + showValue(payload.ratio) + ":1", "安全系数 KA = " + showValue(payload.safetyFactor),
    "惯量比 " + showValue(payload.inertiaRatio), "含草稿数据 " + (payload.includeDrafts === false ? "否" : "是")
  ];
  box.append(el("div", "print-params", params.join("　·　")));
  box.append(el("div", "print-params", selectionParams.join("　·　")));
  // 工况图 + 备注：附件是在算完之后才改的，所以单独放一个容器，改的时候只刷新这一块。
  const extras = el("div", "");
  extras.id = "printExtras";
  extras.innerHTML = printExtrasHtml();
  box.append(extras);
  return box;
}

/** 打印头里的附图与备注（静态版没有后端，打印出来也要有这几张图与这段话）。 */
function printExtrasHtml() {
  // 水印图（所有者 2026-10-28）：<img> + @media print 的 position:fixed，Chrome 打印时每页重复。
  // 用图不用 CSS 背景图——浏览器打印默认不印背景图。用的是**12% 透明的浅色版**：
  // 全彩 logo 印上去会把表格盖住（试过，2026-10-28）。
  let html = watermarkEnabled()
    ? "<img class='print-watermark' src='company-logo-watermark.png' alt='新立盈'>"
    : "";
  if (attachments.length) {
    html += "<div class=\"print-heading\">工况图</div><div class=\"print-images\">" +
      attachments.map(item => "<img src=\"" + item.dataUrl + "\" alt=\"工况图\">").join("") + "</div>";
  }
  const remarksText = String(remarksInput?.value ?? "").trim();
  if (remarksText) {
    html += "<div class=\"print-remarks\"><b>备注</b><div>" +
      remarksText.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]) +
      "</div></div>";
  }
  return html;
}

/** 附件/备注变了：只刷新打印区（结果不重算）。 */
function refreshPrintExtras() {
  const box = document.getElementById("printExtras");
  if (box) box.innerHTML = printExtrasHtml();
}

/**
 * 候选表的读法（所有者 2026-10-28：两页都摊开、大规格也显示，但要把这张表说清楚）。
 * 两个页面用同一句话，别一个说法一个样。
 */
const CANDIDATE_NOTE = "候选按余量从小到大：高亮那行是推荐；其余同样通过校核（余量更大，或规格更大），可按库存与安装空间自选。";

/**
 * 惯量统一按《选型分类.xlsx》电机表那一列的口径显示：**数值 × 10⁻⁴ kg·m²**。
 * 表里电机写 1.45 就是 1.45×10⁻⁴ kg·m²；这样"所需惯量 0.70"和"电机 1.45"能直接比大小。
 * 引擎内部仍用 SI 的 kg·m²，只在显示这一层换单位。
 */
function fmtInertia(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const scaled = value / INERTIA_SCALE;
  if (scaled === 0) return "0";
  const abs = Math.abs(scaled);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return String(Number(scaled.toFixed(digits)));
}

function syncRows() {
  const shape = form.elements.shape.value;
  for (const row of form.querySelectorAll("[data-shape]")) {
    row.hidden = !row.dataset.shape.split(" ").includes(shape);
  }
  const mode = form.elements.mode.value;
  for (const row of form.querySelectorAll("[data-mode]")) {
    row.hidden = row.dataset.mode !== mode;
  }
}

function payload() {
  const seriesLabels = [...form.querySelectorAll('input[name="series"]:checked')].map(input => input.value);
  return {
    // 产品系列（所有者 2026-10-26）：空 = 全部；选了 MTN 就只出 MTN 的结果
    productSeries: form.elements.productSeries.value,
    mode: form.elements.mode.value,
    mounting: form.elements.mounting.value,
    load: {
      shape: form.elements.shape.value,
      mass_kg: number(form.elements.mass_kg.value),
      sideA_mm: number(form.elements.sideA_mm.value) ?? 0,
      sideB_mm: number(form.elements.sideB_mm.value) ?? 0,
      diameter_mm: number(form.elements.diameter_mm.value) ?? 0,
      outerDiameter_mm: number(form.elements.outerDiameter_mm.value) ?? 0,
      innerDiameter_mm: number(form.elements.innerDiameter_mm.value) ?? 0,
      length_mm: number(form.elements.length_mm.value) ?? 0
    },
    eccentricity_mm: number(form.elements.eccentricity_mm.value) ?? 0,
    // 多工位：工件盘（load）之外，盘上再均布 n 个工件。n = 0 = 单件工况（老口径）。
    stations: {
      count: number(form.elements["stations.count"].value) ?? 0,
      massEach_kg: number(form.elements["stations.massEach_kg"].value) ?? 0,
      sideC_mm: number(form.elements["stations.sideC_mm"].value) ?? 0,
      sideD_mm: number(form.elements["stations.sideD_mm"].value) ?? 0,
      offset_mm: number(form.elements["stations.offset_mm"].value) ?? 0
    },
    theta_deg: number(form.elements.theta_deg.value),
    cycleTime_s: number(form.elements.cycleTime_s.value),
    accelTime_s: number(form.elements.accelTime_s.value) ?? 0.5,
    // 减速时间：留空 = 跟随加速时间（服务端按表里的 t3 = t1 处理），填了才按填的算。
    decelTime_s: number(form.elements.decelTime_s.value),
    outputSpeed_rpm: number(form.elements.outputSpeed_rpm.value),
    loadTorque_Nm: number(form.elements.loadTorque_Nm.value),
    ratio: number(form.elements.ratio.value),
    safetyFactor: number(form.elements.safetyFactor.value) ?? 1.5,
    inertiaRatio: number(form.elements.inertiaRatio.value) ?? 10,
    // 效率都由用户填（所有者 2026-11-23）：单独减速机用「减速机效率」这一格，不按型号自动取。
    bodyEfficiency: number(form.elements.bodyEfficiency.value) ?? 0.85,
    gearboxEfficiency: number(form.elements.gearboxEfficiency.value) ?? 0.9,
    motorRatedSpeed_rpm: number(form.elements.motorRatedSpeed_rpm.value) ?? 3000,
    withBrake: form.elements.withBrake.checked,
    // 电机按各自额定转速核算（所有者 2026-11-23）：不再有"高惯量"档位，页面只给转速上限。
    seriesLabels,
    includeDrafts: form.elements.includeDrafts.checked,
    // 输出型式（换向器订货代号）：不显示（平台 / 全部系列）时不发，服务端按默认 FC 处理、也不印出来
    outputType: form.elements.outputType?.disabled ? undefined : form.elements.outputType?.value
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cell(text, className) {
  return el("td", className, text);
}

function metric(label, value, unit) {
  const box = el("div", "metric");
  box.append(el("div", "k", label));
  const line = el("div", "v");
  line.append(document.createTextNode(value));
  if (unit) line.append(el("span", "u", " " + unit));
  box.append(line);
  return box;
}

function wayText(candidate) {
  // 单独减速机：型号本身就是成品（例如 AB060-10），没有"本体 + 行星"这一说。
  if (STANDALONE_SERIES.has(candidate.series)) return "单独减速机";
  if (candidate.kind === "BODY") return "本体";
  return "本体 " + candidate.bodyRatio + ":1 ＋ 行星 " + candidate.gearboxRatio + ":1";
}

/** 电机标签：品牌-系列-功率，例如「汇川-R-400W」。 */
function motorLabel(seriesLabel, power_W) {
  return seriesLabel ? seriesLabel + "-" + power_W + "W" : power_W + "W";
}

/** 推荐电机按所有者要求并列举出：够用的最小一台 + 同系列「往大一档」。 */
function motorPair(candidate) {
  const motor = candidate.motor;
  if (!motor) return "—";
  const first = motorLabel(motor.seriesLabel, motor.power_W);
  if (!motor.nextPower_W) return first;
  return first + " ／ " + motorLabel(motor.seriesLabel, motor.nextPower_W);
}

/** 表格里只写功率档，省地方。 */
function motorText(candidate) {
  const motor = candidate.motor;
  if (!motor) return "—";
  return motor.nextPower_W ? motor.power_W + "W / " + motor.nextPower_W + "W" : motor.power_W + "W";
}

function render(data) {
  output.textContent = "";
  debugBox.textContent = "";
  debugBox.hidden = true;
  placeholder.hidden = true;
  output.hidden = false;
  output.append(printHead(lastPayload, data));

  const summary = el("div", "summary");
  const picked = data.choice;
  // 电机侧的两个数：选到型号就用它的（含本体盘面惯量），没选到就用工况本身算出来的那份
  // （不含盘面惯量）—— 所有者 2026-10-26：没有结果时这两个数也要显示。
  const neededTorque = picked?.motorTorqueNeeded_Nm ?? data.demand?.motorTorqueNeeded_Nm;
  const neededInertia = picked?.motorInertiaNeeded_kgm2 ?? data.demand?.motorInertiaNeeded_kgm2;
  summary.append(
    metric("总惯量", fmt(data.demand.loadInertia_kgm2, 4), "kg·m²"),
    // 转矩用 3 位小数：与《选型分类》表的 T（11.775）和报告一致，避免页面 11.78、纸上 11.775。
    // 表里 H28/H24 本来就叫「总力矩 T」，所有者 2026-10-22 让页面也改这个名。
    metric("总力矩", fmt(data.demand.torque_Nm, 3), "N·m"),
    // 这个速比下电机必须给出的扭矩（表 H35/H31 的「电机扭矩 T''」）
    metric("电机必须扭矩", neededTorque === null || neededTorque === undefined ? "—" : fmt(neededTorque, 3), "N·m"),
    // 电机必须惯量 J''：表 J36 的口径（×10⁻⁴ kg·m²），没选到型号时也不留空
    metric("电机必须惯量", neededInertia === null || neededInertia === undefined ? "—" : fmtInertia(neededInertia), INERTIA_UNIT),
    metric(data.productType === "standaloneGearbox" ? "输出转速" : "盘面转速", fmt(data.demand.outputSpeed_rpm, 1), "r/min"),
    metric("最大允许速比", fmt(data.demand.maxRatio, 1) + ":1", "")
  );
  output.append(summary);

  // 多工位的账单独说一句（所有者 2026-11-05）：工件盘与工件是两笔惯量，
  // 总惯量里多了 J3（工件自身）+ J4（工件偏心），不能让工程师自己去猜。
  const stations = data.stations;
  if (stations && stations.count > 0) {
    output.append(el("p", "note",
      "多工位：" + stations.count + " 个 × " + fmt(stations.massEach_kg, 3) + " kg（合计 " +
      fmt(stations.massTotal_kg, 2) + " kg）；工位惯量 J3 " + fmt(stations.inertiaBody_kgm2, 6) +
      " ＋ 工位偏心 J4 " + fmt(stations.inertiaEccentric_kgm2, 6) + " ＝ " +
      fmt(stations.inertiaTotal_kgm2, 6) + " kg·m²，已计入总惯量；工件盘按 m1 另计。"));
  }

  // 只选了某一个系列时，明说一句"其它系列已经排除"，否则用户会以为别的系列也试过
  const scope = data.productSeries && data.productSeries !== "all" ? data.productSeries : null;
  if (scope) {
    output.append(el("p", "note", "本次选型范围：" + scope + " 系列。"));
  }

  if (data.demand.ratioOverLimit) {
    output.append(el("p", "note",
      "所选速比 " + data.demand.ratio + ":1 超过本工况的最大允许速比 " + fmt(data.demand.maxRatio, 1) + ":1。"));
  }

  const verdict = el("div", "verdict" + (data.decision === "NONE" || data.partial ? " none" : ""));
  const choice = data.choice;

  // 校核没过但选型照给（所有者 2026-11-23）：先亮红灯说清"差多少"，再照常给结果。
  // 不满足的可能是电机扭矩 / 电机转速（速比超一点）/ 惯量 / 盘面转速；速比凑不出时 choice 为空，走下面。
  if (choice && data.partial) {
    const warning = el("div", "verdict none");
    warning.append(el("div", "title", "校核未通过，以下选型仅供参考（报错保留）"));
    if (data.failure?.headline) warning.append(el("div", "line", data.failure.headline));
    if (data.failure?.detail) warning.append(el("div", "line", data.failure.detail));
    // 选中型号的差距：notes 里带具体数（所需惯量 vs 电机惯量、额定转矩/转速不足）
    const gaps = [];
    for (const candidate of data.candidates ?? []) {
      if (candidate.model !== choice.model || candidate.totalRatio !== choice.totalRatio) continue;
      for (const note of candidate.notes ?? []) gaps.push(note);
    }
    for (const line of gaps.slice(0, 4)) warning.append(el("div", "line", "· " + line));
    // 这个速比下电机至少要多少：不管最后有没有电机，都要印出来（否则"超了"看不出去改工况）。
    const need = [];
    if (choice.motorTorqueNeeded_Nm !== undefined && choice.motorTorqueNeeded_Nm !== null) {
      need.push("扭矩 " + fmt(choice.motorTorqueNeeded_Nm, 3) + " N·m");
    }
    if (choice.motorInertiaNeeded_kgm2 !== undefined && choice.motorInertiaNeeded_kgm2 !== null) {
      need.push("惯量 " + fmtInertia(choice.motorInertiaNeeded_kgm2) + " " + INERTIA_UNIT);
    }
    if (need.length) {
      warning.append(el("div", "line", "本速比下电机需要：" + need.join("　|　") +
        "（惯量比 " + data.demand.inertiaRatio + "，总效率 " + choice.efficiency + "）"));
    }
    output.append(warning);
  }

  if (data.decision === "NONE" || !choice) {
    // 先说"为什么"，而且要说对：速比凑不出来 / 转矩不够 / 校核没过 / 数据被挡 是四种不同的原因
    // （所有者 2026-10-26：拿 50 比去选 ZTT，本体 3 比凑不出 50，不能报成"转矩不够"）。
    const failure = data.failure;
    verdict.append(el("div", "title", failure ? failure.headline : "没有满足条件的型号"));
    if (failure?.detail) verdict.append(el("div", "line", failure.detail));

    // 具体到型号的原因（最多 3 条）。
    // 速比凑不出来时，每条型号的原因其实是同一件事（"这条是 X 比"），列三行只是噪音，说一条就够。
    const reasons = [];
    for (const candidate of data.candidates ?? []) {
      for (const note of candidate.notes ?? []) reasons.push(candidate.model + "：" + note);
    }
    if (!reasons.length && failure?.stage !== "RATIO") {
      for (const item of (data.rejected ?? []).slice(0, 3)) {
        if (/placeholder|status /.test(item.reason)) continue;
        if (item.stage !== "DATA") reasons.push(item.model + "：" + item.reason);
      }
    }
    for (const line of reasons.slice(0, 3)) verdict.append(el("div", "line", "· " + line));
  } else {
    const standalone = data.productType === "standaloneGearbox" ||
      STANDALONE_SERIES.has(choice.series);
    const headline = standalone
      ? choice.model + "（单独减速机）"
      : choice.kind === "BODY"
        ? choice.model + "（本体）"
        : choice.model + " ＋ 行星 " + choice.gearboxRatio + ":1";
    verdict.append(el("div", "title", "推荐：" + headline));
    // 产品类型：平台和换向器现在会在"全部系列"里一起比，纸上要写清楚选到的是哪一类。
    const TYPE_LABELS = {
      MTN: "中空旋转平台", ZTT: "中空旋转平台", MTT: "中空旋转平台",
      HL: "中空旋转平台", BX: "摆线针轮减速机",
      XZT: "换向器", XZTF: "换向器",
      AB: "行星减速机", ABR: "行星减速机", AFP: "行星减速机",
      AFPR: "行星减速机", AD: "行星减速机", ADR: "行星减速机"
    };
    if (choice.series) {
      verdict.append(el("div", "line",
        "类型：" + (TYPE_LABELS[choice.series] ?? choice.series) + "（" + choice.series + " 系列）"));
    }
    const parts = ["总速比 " + choice.totalRatio + ":1"];
    if (choice.gearbox) parts.push("减速机 " + choice.gearbox.model);
    if (standalone && choice.gearboxLevel) parts.push(choice.gearboxLevel === "single" ? "单级" : "双级");
    verdict.append(el("div", "line", parts.join("　|　")));
    // 关键规格（所有者 2026-10-29「抓选型最在意的数据」）：目录给了哪几项就印哪几项。
    const specs = choice.specs ?? {};
    const specParts = [];
    if (specs.ratedTorque_Nm) specParts.push("额定 " + fmt(specs.ratedTorque_Nm, 0) + " N·m");
    if (specs.tableDiameter_mm) specParts.push("转台 ≤" + fmt(specs.tableDiameter_mm, 0) + " mm");
    if (specs.allowableTiltingTorque_Nm) specParts.push("倾覆 " + fmt(specs.allowableTiltingTorque_Nm, 0) + " N·m");
    if (specs.repeatability_arcsec) specParts.push("重复定位 ±" + specs.repeatability_arcsec + "″");
    if (specs.peakOutputTorque_Nm) specParts.push("峰值 " + fmt(specs.peakOutputTorque_Nm, 0) + " N·m");
    if (specs.backlash_arcmin !== null && specs.backlash_arcmin !== undefined) {
      specParts.push("回差 " + specs.backlash_arcmin + "′");
    }
    if (standalone && choice.efficiency) specParts.push("效率 " + choice.efficiency);
    if (specs.weight_kg) specParts.push(fmt(specs.weight_kg, 1) + " kg");
    if (specParts.length) verdict.append(el("div", "line", "规格：" + specParts.join("　|　")));
    // 输出型式：只有换向器有（平台输出就是转台盘面）。代号按系列给，XZTF 是 FC、XZT 是 C。
    if (data.output?.applies && data.output.code) {
      verdict.append(el("div", "line",
        "输出型式：" + data.output.label + "　订货代号 " + data.output.code));
    }
    // 电机：够用的最小一台 + 同系列往大一档，两个都列出来（例：汇川-R-400W ／ 汇川-R-550W）
    verdict.append(el("div", "line", "电机：" + motorPair(choice)));
    // 这个速比下，电机轴"必须多大扭矩、多大惯量"——工程师拿去对电机样本的两个数
    const needs = [];
    if (choice.motorTorqueNeeded_Nm !== undefined && choice.motorTorqueNeeded_Nm !== null) {
      needs.push("扭矩 " + fmt(choice.motorTorqueNeeded_Nm, 3) + " N·m");
    }
    if (choice.motorInertiaNeeded_kgm2 !== undefined && choice.motorInertiaNeeded_kgm2 !== null) {
      needs.push("惯量 J'' " + fmtInertia(choice.motorInertiaNeeded_kgm2) + " " + INERTIA_UNIT);
    }
    if (needs.length) {
      verdict.append(el("div", "line", "电机必须：" + needs.join("　|　") +
        "（惯量比 " + data.demand.inertiaRatio + "，总效率 " + choice.efficiency + "）"));
    }
    if (choice.draft) verdict.append(el("div", "sub", "数据状态：草稿（DRAFT）"));
  }
  output.append(verdict);

  // 一条候选都没有时别留一张只有表头的空表（看着像"算坏了"）
  if ((data.candidates ?? []).length) {
    // 这张表列的是**全部通过校核的**型号，包括余量很大、规格更大的那些（不是只列推荐）。
    // 所有者 2026-10-28：两页都要摊开，但表头要先说清怎么读。
    output.append(el("h3", "", "候选（" + data.candidates.length + "）"));
    const candidateNote = el("p", "note", data.partial
      ? "候选按余量从小到大：高亮那行是这次能选到的型号；本次校核未通过，这些型号只说明容量/速比满足，需按上面的差距调整工况或更换电机。"
      : CANDIDATE_NOTE);
    candidateNote.id = "candidateNote";   // 页面上还有别的 .note（选型范围提示），给这张表一个自己的 id
    output.append(candidateNote);
    const table = el("table", "grid");
    const head = el("tr");
    for (const name of ["型号", "方式", "总速比", "电机", "减速机"]) head.append(el("th", "", name));
    table.append(head);
    for (const candidate of data.candidates) {
      const chosen = choice && candidate.model === choice.model && candidate.totalRatio === choice.totalRatio;
      const row = el("tr", chosen ? "chosen" : "");
      row.append(cell(candidate.model, "model"));
      row.append(cell(wayText(candidate), "model"));
      row.append(cell(String(candidate.totalRatio)));
      row.append(cell(motorText(candidate)));
      row.append(cell(candidate.gearbox ? candidate.gearbox.model : "—", "model"));
      table.append(row);
    }
    output.append(table);
  }

  output.append(reportActions(Boolean(choice), data.partial === true));

  maxRatioHint.textContent = "（最大 " + fmt(data.demand.maxRatio, 1) + "）";
  statusEl.textContent = "已计算";
  statusEl.className = "status";

  if (DEBUG) renderDebug(data, choice);
}

/**
 * 报告按钮。客户版人人可出；内部版（依据、余量、校核、被排除原因）只在 ?debug=1 出现，
 * 与页面上"客户只看结论"的口径保持一致。
 *
 * 静态版没有后端，出不了 PDF：改成"打印 / 另存为 PDF"（Ctrl+P 选打印机里的"另存为 PDF"）。
 */
function reportActions(hasChoice, partial = false) {
  const box = el("div", "report-actions");
  if (LOCAL_ENGINE) {
    if (hasChoice) {
      const print = el("button", "", "打印 / 另存为 PDF");
      print.type = "button";
      print.addEventListener("click", () => window.print());
      box.append(print);
    }
    box.append(watermarkToggle());
    box.append(el("span", "hint", "静态版：计算在你自己的浏览器里完成；要 PDF 就用打印对话框里的「另存为 PDF」。"));
    return box;
  }
  // 校核未通过：客户版报告不出（服务端 409），按钮也收起来，别让人点了才看到报错。
  if (hasChoice && !partial) {
    const customer = el("button", "", "下载客户版报告");
    customer.type = "button";
    customer.addEventListener("click", () => downloadReport("customer"));
    box.append(customer);
  }
  if (partial) {
    box.append(el("span", "hint", "校核未通过：客户版报告不出；内部版（?debug=1）可看差距。"));
  }
  if (DEBUG) {
    const internal = el("button", "", "下载内部版报告");
    internal.type = "button";
    internal.addEventListener("click", () => downloadReport("internal"));
    box.append(internal);
    box.append(el("span", "hint", "内部版含余量、校核与被排除原因，不外发。"));
  }
  box.append(watermarkToggle());
  return box;
}

async function downloadReport(variant) {
  if (!lastPayload) return;
  statusEl.textContent = "正在生成报告…";
  statusEl.className = "status";
  try {
    const response = await fetch(REPORT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: lastPayload, metadata: reportMetadata(variant) })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || ("HTTP " + response.status));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = variant === "internal" ? "选型报告-内部版.pdf" : "选型报告-客户版.pdf";
    document.body.append(link);
    link.click();
    link.remove();
    // 让浏览器先把下载接住，再释放对象 URL
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    statusEl.textContent = "报告已生成";
    statusEl.className = "status";
  } catch (error) {
    statusEl.textContent = "出不了报告：" + error.message;
    statusEl.className = "status bad";
  }
}

/** ?debug=1 才显示：余量、惯量、被排除原因、速比可调空间。内部看，不给客户看。 */
function renderDebug(data, choice) {
  debugBox.hidden = false;
  debugBox.append(el("h3", "", "内部信息（?debug=1）"));

  if (choice) {
    const lines = [];
    lines.push("本体容量 " + choice.capacity_Nm + " N·m ≥ 总力矩 " + fmt(choice.demand_Nm, 3) +
      " N·m（余量 " + choice.margin + "×）");
    if (choice.gearbox) {
      lines.push("减速机 " + choice.gearbox.model + " 额定 " + choice.gearbox.ratedTorque_Nm +
        " N·m ≥ 本体输入侧 " + fmt(choice.gearbox.requiredTorque_Nm, 2) +
        "（余量 " + choice.gearbox.margin + "×）");
    }
    if (choice.motor) {
      const binding = { torque: "转矩", speed: "转速", inertia: "惯量", motor: "电机", gearbox: "减速机" };
      lines.push("电机 " + choice.motor.model + " 额定 " + choice.motor.ratedTorque_Nm + " N·m / " +
        choice.motor.ratedSpeed_rpm + " r/min；电机必须扭矩 " + fmt(choice.motor.neededTorque_Nm, 3) + " N·m、" +
        fmt(choice.motor.neededSpeed_rpm, 1) + " r/min");
      lines.push("惯量比 " + data.demand.inertiaRatio + " → 电机转子惯量需 ≥ " +
        fmtInertia(choice.motor.inertiaRequired_kgm2) + " " + INERTIA_UNIT + "（实机 " +
        fmtInertia(choice.motor.rotorInertia_kgm2) + "）");
      lines.push("约束项：" + (binding[choice.motor.bindingConstraint] ?? choice.motor.bindingConstraint) +
        "；总效率 " + choice.efficiency);
    }
    const list = el("ul");
    for (const line of lines) list.append(el("li", "", line));
    debugBox.append(list);
  }

  const notes = [...(data.notes ?? []), ...data.candidates.flatMap(candidate =>
    (candidate.notes ?? []).map(note => candidate.model + "：" + note))];
  if (notes.length) {
    const details = el("details");
    details.append(el("summary", "", "说明（" + notes.length + "）"));
    const list = el("ul");
    for (const note of notes) list.append(el("li", "", note));
    details.append(list);
    debugBox.append(details);
  }

  if (data.space?.rows?.length) {
    const details = el("details");
    details.append(el("summary", "", "速比可调空间"));
    const space = el("table", "grid");
    const head = el("tr");
    for (const name of ["总速比", "平台", "行星", "减速机", "本体余量", "电机", "功率"]) head.append(el("th", "", name));
    space.append(head);
    for (const row of data.space.rows) {
      const tr = el("tr");
      tr.append(cell(String(row.totalRatio)));
      tr.append(cell(row.model, "model"));
      tr.append(cell(row.kind === "BODY" ? "本体" : row.gearboxRatio + ":1"));
      tr.append(cell(row.gearboxModel ?? "—", "model"));
      tr.append(cell(row.margin + "×"));
      tr.append(cell(row.motorModel ?? "—", "model"));
      tr.append(cell(row.motorPower_W === null ? "—" : row.motorPower_W + "W"));
      space.append(tr);
    }
    details.append(space);
    debugBox.append(details);
  }

  // 所有者 2026-10-22：右下角那份排除清单全部删掉，不再打印。
}

async function submit(event) {
  event.preventDefault();
  // 浏览器自带的校验（number 的 min/step）会静默挡住提交，这里明确说出来。
  // 报"哪个框错了"要看表格左列的中文标签，不能把 mass_kg、theta_deg 这种字段名甩给用户。
  if (!form.checkValidity()) {
    const label = element => element.closest("tr")?.querySelector("th")?.textContent.trim() || element.name;
    const bad = [...form.elements].filter(element => element.willValidate && !element.checkValidity())
      .map(label);
    statusEl.textContent = "参数不合法：" + (bad.join("、") || "请检查输入框");
    statusEl.className = "status bad";
    return;
  }
  statusEl.textContent = LOCAL_ENGINE ? "计算中…（本地）" : "计算中…";
  statusEl.className = "status";
  try {
    lastPayload = payload();
    const data = LOCAL_ENGINE
      ? LOCAL_ENGINE.run(lastPayload, await LOCAL_ENGINE.ready)
      : await requestSelection(lastPayload);
    if (!data?.ok) throw new Error(data?.error || "结果不合法");
    render(data);
  } catch (error) {
    statusEl.textContent = "算不出来：" + error.message;
    statusEl.className = "status bad";
  }
}

/** 托管版：把参数发给服务端（/api/selection），错误原样带回上一句中文。 */
async function requestSelection(input) {
  const response = await fetch("/api/selection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}

form.addEventListener("submit", submit);
// 单选组是 RadioNodeList，没有 addEventListener；统一在 form 上接 change。
form.addEventListener("change", event => {
  if (event.target.name === "shape" || event.target.name === "mode") syncRows();
});

document.getElementById("example").addEventListener("click", () => {
  for (const [name, value] of Object.entries(EXAMPLE)) {
    if (form.elements[name]) form.elements[name].value = value;
  }
  decelTouched = false;
  syncDecelHint();
  syncRows();
  statusEl.textContent = "已填入示例";
  statusEl.className = "status";
});

// —— 减速时间：默认跟随加速时间，手动改了就单独用（所有者 2026-10-28）——
//
// 交互约定：
//   · 没动过减速框 → 改加速时间时，减速时间跟着变（同一句话"默认一样"）；
//   · 动过 → 两者分开算，减速框下面写明"已单独设定"；
//   · 清空减速框（或全选删掉再离开）→ 回到跟随，不会留一个空值发给服务端。
const accelInput = form.elements.accelTime_s;
const decelInput = form.elements.decelTime_s;
let decelTouched = false;

function syncDecelHint() {
  const hint = document.getElementById("decelHint");
  if (!hint) return;
  hint.textContent = decelTouched ? "已单独设定（清空即跟回加速时间 t1）" : "默认跟加速时间 t1 一样";
}

accelInput.addEventListener("input", () => {
  if (!decelTouched) decelInput.value = accelInput.value;
  syncDecelHint();
});

decelInput.addEventListener("input", () => {
  decelTouched = decelInput.value.trim() !== "";
  syncDecelHint();
});

decelInput.addEventListener("blur", () => {
  if (decelInput.value.trim() !== "") return;
  decelTouched = false;
  decelInput.value = accelInput.value;
  syncDecelHint();
});

syncDecelHint();

syncRows();
// 刷新时浏览器可能记着上次的产品类型/系列：先按当前值把系列下拉重建一遍，
// 再同步与系列相关的行（输出型式、效率框），免得"记着 MTN、下拉却只有 AB"。
const rememberedSeries = form.elements.productSeries.value;
if (ALL_SERIES.has(rememberedSeries)) form.elements.productGroup.value = groupOfSeries(rememberedSeries);
syncProductGroup({ keep: true });


