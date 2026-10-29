// 减速机选型页的前端逻辑：收参数 → 跑一次 → 渲染。
//
// 和 /selection.js 一样，页面里**没有公式**：工况与选型都在 shared/src/selection 下，
// 托管版走 POST /api/gearbox-selection，静态版由 lib/engine.js 挂在 window.__gearboxEngine 上。
// 两种跑法用的是同一个 runGearboxSelection。

const form = document.getElementById("form");
const output = document.getElementById("output");
const stepsBox = document.getElementById("steps");
const placeholder = document.getElementById("placeholder");
const statusEl = document.getElementById("status");
const seriesSelect = document.getElementById("series");
const ratioSelect = document.getElementById("ratio");
const ratioHint = document.getElementById("ratioHint");
// 输出方向（所有者 2026-10-29）：直出 / 直角（行星后面加 XZTF 换向器）。
const outputDirection = document.getElementById("outputDirection");
const outputHint = document.getElementById("outputDirectionHint");
const rightAngleOn = () => outputDirection?.value === "rightAngle";

function syncOutputHint() {
  if (!outputHint) return;
  outputHint.textContent = rightAngleOn()
    ? "直角：行星按换向器框号自动配套（AFP060/090/115、AB142/180/220），总速比 = 本体比号(1/2) × 行星比号；产品系列此时只影响比号列表"
    : "直出：行星减速机的输出轴直接接负载，不换向";
}
outputDirection?.addEventListener("change", () => {
  syncOutputHint();
  syncRightAngleRows();
  if (options) fillRatios();     // 直角会把 2:1 凑出的总速比补进下拉
});

const bodyRatioSelect = document.getElementById("rightAngleBodyRatio");

/** 「换向器本体」这一行只在直角时出现（所有者 2026-10-29：二比要能显式选）。 */
function syncRightAngleRows() {
  for (const row of form.querySelectorAll("[data-right-angle]")) row.hidden = !rightAngleOn();
}

/** 换向器本体比号：null = 自动，1 / 2 = 只用这个比号。 */
function selectedBodyRatio() {
  if (!rightAngleOn()) return null;
  const value = Number(bodyRatioSelect?.value);
  return value === 1 || value === 2 ? value : null;
}
// 报告按钮：以前靠 id="reportActions" 变成的 window 全局变量才拿到（HTML 一改名整页就白屏），
// 现在显式取一次，和别的元素一样。
const reportActions = document.getElementById("reportActions");
const printReport = document.getElementById("printReport");
const reportHint = document.getElementById("reportHint");
const LOCAL = typeof window !== "undefined" ? (window.__gearboxEngine ?? null) : null;
let options = null;
let lastResult = null;
let lastInput = null;

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
    // 所有者 2026-10-28：默认带公司 logo + 水印；勾掉才不带（服务端只认布尔 false）。
    watermark: watermarkEnabled(),
    remarks: String(remarksInput?.value ?? ""),
    images: attachments.map(item => item.dataUrl)
  };
}

// 报告带不带公司水印：勾选框在 #reportActions 里（和报告按钮同一排），默认勾上。
// 勾掉后：下载的 PDF 没有 logo/水印，静态版打印的纸上也没有那张浅色水印图。
const watermarkInput = document.getElementById("withWatermark");
const watermarkEnabled = () => watermarkInput?.checked !== false;
watermarkInput?.addEventListener("change", () => refreshPrintExtras());

/** 把网络/接口错误翻成一句能看懂的中文（具体原因照原文，不吞掉）。 */
function describeError(error) {
  const message = String(error?.message ?? error);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return "连不上选型服务（3005 没开或网络断了）：" + message;
  }
  return message;
}

function number(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return String(Number(Number(value).toFixed(digits)));
}

/**
 * 候选表的读法（所有者 2026-10-28：两页都摊开、大规格也显示，但要把这张表说清楚）。
 * 平台选型页用的是同一句话（selection.js 里同名常量），改一处就要两处一起改。
 */
const CANDIDATE_NOTE = "候选按余量从小到大：高亮那行是推荐；其余同样通过校核（余量更大，或规格更大），可按库存与安装空间自选。";

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = text => String(text ?? "").replace(/[&<>"]/g, ch => ESCAPE[ch]);

function dutyType() {
  return form.querySelector('input[name="dutyType"]:checked').value;
}

/** 显示/隐藏两组工况输入行，以及斜坡的坡度角。 */
function syncRows() {
  const type = dutyType();
  for (const section of form.querySelectorAll("[data-duty]")) {
    section.hidden = section.dataset.duty !== type;
  }
  const chainCase = form.elements.case?.value ?? "horizontal";
  for (const row of form.querySelectorAll("[data-case]")) {
    row.hidden = row.dataset.case !== chainCase;
  }
  const shape = form.elements.turntableShape?.value ?? "disc";
  for (const row of form.querySelectorAll("[data-shape]")) {
    row.hidden = row.dataset.shape !== shape;
  }
  updateRatios();
}

function updateRatios() {
  if (form.elements.bigGearTeeth && form.elements.smallGearTeeth) {
    const z1 = number(form.elements.bigGearTeeth.value) || 0;
    const z2 = number(form.elements.smallGearTeeth.value) || 0;
    document.getElementById("gearPairRatio").textContent = z2 > 0 ? "i1 = " + fmt(z1 / z2, 3) : "i1 = —";
  }
  const d1 = number(form.elements.drivenPulley_mm?.value) || 0;
  const d2 = number(form.elements.drivingPulley_mm?.value) || 0;
  const chain = document.getElementById("chainRatio");
  if (chain) chain.textContent = d2 > 0 ? "i1 = " + fmt(d1 / d2, 3) : "i1 = —";
}

/** 选系列 → 只列这个系列有的比号。直角输出时再补上"2:1 本体 × 行星比"能凑出的总速比。 */
function fillRatios() {
  const series = options?.series?.find(item => item.id === seriesSelect.value);
  const base = series?.ratios ?? [];
  const ratios = rightAngleOn()
    ? [...new Set([...base, ...base.map(ratio => ratio * 2)])].sort((a, b) => a - b)
    : [...base];
  const previous = ratioSelect.value;
  ratioSelect.innerHTML = ratios.map(ratio =>
    '<option value="' + ratio + '">' + ratio + " : 1</option>").join("");
  if (ratios.includes(Number(previous))) ratioSelect.value = previous;
  const levels = series?.levels ?? {};
  ratioHint.textContent = "单级 " + (levels.single ?? []).join("/") +
    " · 双级 " + (levels.double ?? []).join("/") +
    ((levels.triple ?? []).length ? " · 三级 " + levels.triple.join("/") : "") +
    (rightAngleOn() ? "（直角：总速比 = 本体比号 1/2 × 行星比号）" : "");
}

function collect() {
  const duty = {};
  if (dutyType() === "gear-pair") {
    duty.turntableMass_kg = number(form.elements.turntableMass_kg.value);
    duty.turntableDiameter_mm = number(form.elements.turntableDiameter_mm.value);
    duty.turntableShape = form.elements.turntableShape.value;
    duty.turntableSideA_mm = number(form.elements.turntableSideA_mm.value) ?? 0;
    duty.turntableSideB_mm = number(form.elements.turntableSideB_mm.value) ?? 0;
    duty.eccentricity_mm = number(form.elements.eccentricity_mm.value) ?? 0;
    duty.mounting = form.querySelector('input[name="mounting"]:checked').value;
    duty.stations = {
      count: number(form.elements["stations.count"].value) ?? 0,
      massEach_kg: number(form.elements["stations.massEach_kg"].value) ?? 0,
      sideC_mm: number(form.elements["stations.sideC_mm"].value) ?? 0,
      sideD_mm: number(form.elements["stations.sideD_mm"].value) ?? 0
    };
    duty.loadOffset_mm = number(form.elements.loadOffset_mm.value) ?? 0;
    duty.bigGear = {
      mass_kg: number(form.elements["bigGear.mass_kg"].value) ?? 0,
      outerDiameter_mm: number(form.elements["bigGear.outerDiameter_mm"].value) ?? 0,
      innerDiameter_mm: number(form.elements["bigGear.innerDiameter_mm"].value) ?? 0
    };
    duty.smallGear = {
      mass_kg: number(form.elements["smallGear.mass_kg"].value) ?? 0,
      outerDiameter_mm: number(form.elements["smallGear.outerDiameter_mm"].value) ?? 0,
      innerDiameter_mm: number(form.elements["smallGear.innerDiameter_mm"].value) ?? 0
    };
    duty.gearboxInertia_kgm2 = number(form.elements.gearboxInertia_kgm2.value) ?? 0;
    duty.bigGearTeeth = number(form.elements.bigGearTeeth.value);
    duty.smallGearTeeth = number(form.elements.smallGearTeeth.value);
    duty.theta_deg = number(form.elements.theta_deg.value);
    duty.cycleTime_s = number(form.elements.cycleTime_s.value);
    duty.accelTime_s = number(form.elements.accelTime_s.value);
    // 减速时间：留空 = 跟随加速时间（引擎按表里 t3 = t1 处理），填了才按填的算。
    duty.decelTime_s = number(form.elements.decelTime_s.value);
  } else {
    duty.case = form.elements.case.value;
    duty.loadMass_kg = number(form.elements.loadMass_kg.value);
    duty.counterweight_kg = number(form.elements.counterweight_kg.value) ?? 0;
    duty.pitchDiameter_mm = number(form.elements.pitchDiameter_mm.value);
    duty.lineSpeed_mm_s = number(form.elements.lineSpeed_mm_s.value);
    // 链带的 t1 单独一个名字（chainAccelTime_s）：两组工况里都叫 accelTime_s 的话，
    // form.elements.accelTime_s 会变成一个列表，读 .value 永远拿到空串——输入框等于白填。
    duty.accelTime_s = number(form.elements.chainAccelTime_s.value);
    duty.slopeAngle_deg = number(form.elements.slopeAngle_deg.value) ?? 0;
    duty.frictionCoefficient = number(form.elements.frictionCoefficient.value) ?? 0.2;
    duty.drivenPulley_mm = number(form.elements.drivenPulley_mm.value) ?? 1;
    duty.drivingPulley_mm = number(form.elements.drivingPulley_mm.value) ?? 1;
    duty.motorCount = number(form.elements.motorCount.value) ?? 1;
  }
  return {
    dutyType: dutyType(),
    duty,
    series: [seriesSelect.value],
    ratio: number(ratioSelect.value),
    // 输出方向：true = 行星后面加 XZTF 换向器（总速比 = 本体比号 × 行星比号）
    rightAngle: rightAngleOn(),
    // 换向器本体比号：null = 自动，1 / 2 = 只用这个比号
    rightAngleBodyRatio: selectedBodyRatio(),
    motorRatedSpeed_rpm: number(form.elements.motorRatedSpeed_rpm.value) ?? 3000,
    inertiaRatio: number(form.elements.inertiaRatio.value) ?? 10,
    safetyFactor: number(form.elements.safetyFactor.value) ?? 1.5,
    gearEfficiency: number(form.elements.gearEfficiency.value) ?? 0.85,
    conveyorEfficiency: number(form.elements.conveyorEfficiency.value) ?? 0.9,
    gearboxEfficiency: number(form.elements.gearboxEfficiency.value) ?? 0.9,
    seriesLabels: [...form.querySelectorAll('input[name="seriesLabel"]:checked')].map(input => input.value),
    withBrake: form.elements.withBrake.checked,
    motorSpeedClass: form.elements.highInertia.checked ? "highInertia" : "standard"
  };
}

function renderDuty(result) {
  const duty = result.duty;
  const motorCount = duty.motorCount > 1
    ? metric("驱动电机数", duty.motorCount, "台（惯量/扭矩已分摊）")
    : "";
  return '<h3>工况交接值（减速机输出轴口径）</h3>' +
    '<div class="summary">' +
    metric("输出扭矩", fmt(duty.outputTorque_Nm, 2), "N·m") +
    metric("输出惯量", fmt(duty.outputInertia_kgm2, 6), "kg·m²") +
    metric("匀速输出转速", fmt(duty.outputSpeed_rpm, 2), "r/min") +
    metric("最大总速比", fmt(duty.maxTotalRatio, 1), "比（含机械减速）") +
    metric("允许最大减速机速比", fmt(duty.maxGearboxRatio, 1), "比 i2（已除 i1）") +
    metric("机械减速 i1", fmt(duty.internalRatio, 3), duty.internalLabel) +
    motorCount +
    "</div>";
}

function metric(key, value, unit) {
  return '<div class="metric"><div class="k">' + esc(key) + '</div><div class="v">' +
    esc(value) + '</div><div class="u">' + esc(unit) + "</div></div>";
}

function renderVerdict(result) {
  const selection = result.selection;
  if (!selection.ok) {
    const stage = {
      ratio: "比号", torque: "扭矩", speed: "输入转速", totalRatio: "总速比", motor: "电机",
      rightAngle: "换向器扭矩", rightAngleSpeed: "换向器转速"
    }[selection.failure?.stage] ?? "";
    return '<div class="verdict none"><div class="title">选不出（卡在' + esc(stage) + '）</div>' +
      '<div class="line">' + esc(selection.failure?.message ?? "没有满足条件的型号") + "</div>" +
      '<div class="sub">可以换一个比号、换系列，或核对工况参数。</div></div>';
  }
  const choice = selection.choice;
  const motor = choice.motor;
  // 直角输出时推荐的是"换向器 + 行星"，行星的那段比号要单独写出来（i2 是两者的乘积）。
  const title = choice.rightAngle
    ? esc(choice.rightAngle.model) + " ＋ " + esc(choice.model) + "（行星 " + esc(choice.planetaryRatio) + ":1）"
    : esc(choice.model) + " ＋ " + esc(choice.ratio) + ":1";
  const rightAngleText = choice.rightAngle
    ? "换向器 " + esc(choice.rightAngle.model) + "（本体 " + esc(choice.rightAngle.bodyRatio) + ":1）· 额定输出 " +
      fmt(choice.rightAngle.ratedTorque_Nm, 1) + " N·m（余量 " + fmt(choice.rightAngle.margin, 2) + "×）· 输入 " +
      fmt(choice.rightAngle.inputSpeed_rpm, 0) + " r/min · "
    : "";
  return '<div class="verdict"><div class="title">推荐：' + title +
    (motor ? " ＋ " + esc(motor.model) : "") + "</div>" +
    '<div class="line">' + rightAngleText + "行星额定输出扭矩 " + fmt(choice.ratedTorque_Nm, 1) + " N·m（余量 " +
    fmt(choice.margin, 2) + "×）· 总减速比 " + fmt(choice.totalRatio, 2) +
    (motor ? " · 电机 " + fmt(motor.power_W / 1000, 2) + " kW / " + fmt(motor.ratedTorque_Nm, 2) + " N·m" : "") +
    "</div>" +
    '<div class="sub">减速机输出 ' + fmt(result.duty.outputTorque_Nm, 2) + " N·m / " +
    fmt(result.duty.outputSpeed_rpm, 1) + " r/min；电机侧需要 " + fmt(choice.motorTorqueNeeded_Nm, 2) + " N·m @ " +
    fmt(choice.motorSpeed_rpm, 0) + " r/min" +
    (choice.motor?.inertiaRatio !== null && choice.motor?.inertiaRatio !== undefined
      ? "，惯量比 " + fmt(choice.motor.inertiaRatio, 2) : "") +
    // XZTF 目前是草稿数据（产品库 status = DRAFT），纸上/页面上都说一声。
    (choice.rightAngle?.status === "DRAFT" ? "。换向器数据为草稿（DRAFT），定稿前以技术确认件为准" : "") +
    "</div></div>";
}

function renderSteps(result) {
  const rows = result.duty.steps.map(step =>
    "<tr><td class='model'>" + esc(step.label) + "</td><td class='model'>" + esc(step.formula) +
    "</td><td>" + fmt(step.value, 6) + "</td><td>" + esc(step.unit) + "</td></tr>").join("");
  let html = "<h3>计算过程</h3><table class='grid'><tr><th class='model'>项目</th><th class='model'>公式</th><th>数值</th><th>单位</th></tr>" +
    rows + "</table>";
  // 候选表已经搬到结果区（两页都摊开）；这里只留"为什么没选它们"。
  const selection = result.selection;
  if (selection.rejected.length) {
    html += "<h3>被排除的 " + selection.rejected.length + " 条</h3><details><summary>展开看原因</summary><ul>" +
      selection.rejected.map(row => "<li>" + esc(row.model) + "（" + esc(row.ratio) + ":1）：" + esc(row.reason) + "</li>").join("") +
      "</ul></details>";
  }
  return html;
}

/** 候选表：全部通过校核的框号（含余量很大、规格更大的），第一个是推荐。 */
function renderCandidates(result) {
  const selection = result.selection;
  if (!selection.candidates.length) return "";
  const choice = selection.choice;
  // 直角输出时一行是"换向器 + 行星"，列也跟着换（i2 是本体比号 × 行星比号）。
  const rightAngle = Boolean(selection.candidates[0]?.rightAngle);
  const rows = selection.candidates.map(row => {
    const chosen = Boolean(choice) &&
      row.model === choice.model &&
      row.ratio === choice.ratio &&
      (row.rightAngle?.model ?? null) === (choice.rightAngle?.model ?? null);
    const cells = rightAngle
      ? "<td class='model'>" + esc(row.rightAngle?.model ?? "—") +
        (row.rightAngle ? "（" + esc(row.rightAngle.bodyRatio) + ":1）" : "") + "</td>" +
        "<td class='model'>" + esc(row.model) + "（" + esc(row.planetaryRatio) + ":1）</td>" +
        "<td>" + esc(row.ratio) + ":1</td>" +
        "<td>" + fmt(row.margin, 2) + "×</td>" +
        "<td class='model'>" + esc(row.motor?.model ?? "—") + "</td>"
      : "<td class='model'>" + esc(row.model) + "</td>" +
        "<td>" + esc(row.ratio) + ":1</td>" +
        "<td>" + fmt(row.ratedTorque_Nm, 1) + "</td>" +
        "<td>" + fmt(row.margin, 2) + "×</td>" +
        "<td class='model'>" + esc(row.motor?.model ?? "—") + "</td>";
    return "<tr" + (chosen ? " class='chosen'" : "") + ">" + cells + "</tr>";
  }).join("");
  const head = rightAngle
    ? "<th class='model'>换向器</th><th class='model'>行星（比号）</th><th>总比 i2</th><th>行星余量</th><th class='model'>电机</th>"
    : "<th class='model'>型号</th><th>比号</th><th>额定扭矩 N·m</th><th>余量</th><th class='model'>电机</th>";
  return "<h3>候选（" + selection.candidates.length + "）</h3>" +
    "<p class='note' id='candidateNote'>" + esc(CANDIDATE_NOTE) + "</p>" +
    "<table class='grid'><tr>" + head + "</tr>" + rows + "</table>";
}

/**
 * 打印头（只在打印时出现，屏幕上看不见）：标题、日期、这一单的工况参数。
 *
 * 同事最后是用浏览器"打印 → 另存为 PDF"把报告发给客户的，而打印时表单是藏起来的
 * （@media print 把 form 全部 display:none）——不补这一段，纸上就只有结论、没有客户输入，
 * 客户没法核对"这份报告是按哪组参数算的"。
 */
function renderPrintHead(input, result) {
  if (!input) return "";
  const show = value => (value === null || value === undefined || value === "" ? "—" : String(value));
  // 注意层级：工况参数在 input.duty 里（collect() 就是这么发的），别在 input 顶层找。
  const dutyInput = input.duty ?? {};
  const duty = result.duty;
  const chainCase = { horizontal: "水平移动", vertical: "垂直提升", ramp: "斜坡" }[duty.case] ?? duty.case;
  const dutyLabel = duty.dutyType === "chain-belt" ? "齿轮链带（" + chainCase + "）" : "大小齿轮（齿轮副）";
  const params = duty.dutyType === "chain-belt"
    ? [
        "负载 " + show(dutyInput.loadMass_kg) + " kg", "配重 " + show(dutyInput.counterweight_kg ?? 0) + " kg",
        "D = " + show(dutyInput.pitchDiameter_mm) + " mm", "v = " + show(dutyInput.lineSpeed_mm_s) + " mm/s",
        "t1 = " + show(dutyInput.accelTime_s) + " s", "驱动电机 " + show(dutyInput.motorCount) + " 台"
      ]
    : [
        "转盘 " + show(dutyInput.turntableMass_kg) + " kg / φ" + show(dutyInput.turntableDiameter_mm) + " mm",
        "大齿轮 " + show(dutyInput.bigGear?.mass_kg) + " kg", "θ = " + show(dutyInput.theta_deg) + "°",
        "t = " + show(dutyInput.cycleTime_s) + " s", "t1 = " + show(dutyInput.accelTime_s) + " s",
        "t3 = " + show(dutyInput.decelTime_s ?? dutyInput.accelTime_s) + " s",
        "z1/z2 = " + show(dutyInput.bigGearTeeth) + "/" + show(dutyInput.smallGearTeeth)
      ];
  // 工况一行、选型一行：一行太长会在中文字中间折行（纸上很难看）。
  const selectionParams = [
    "系列 " + show(input.series?.[0]), "比号 " + show(input.ratio) + ":1",
    "输出方向 " + (input.rightAngle
      ? "直角（XZTF 换向器" + (input.rightAngleBodyRatio ? " " + input.rightAngleBodyRatio + ":1" : "") + "）"
      : "直出"),
    "安全系数 k = " + show(input.safetyFactor),
    "η1 = " + show(duty.dutyType === "chain-belt" ? input.conveyorEfficiency : input.gearEfficiency),
    "η2 = " + show(input.gearboxEfficiency)
  ];
  return "<div class='print-only'>" +
    "<h1>新立盈 · 减速机选型报告</h1>" +
    "<div class='print-meta'>" + esc(dutyLabel) + "　·　生成日期 " + new Date().toLocaleDateString("zh-CN") + "</div>" +
    "<div class='print-params'>" + esc(params.join("　·　")) + "<br>" + esc(selectionParams.join("　·　")) + "</div>" +
    // 附图 / 备注 / 水印必须在 .print-only **里面**：挂到外面会在屏幕上冒出一张大水印
    // （2026-10-29 所有者截图报的就是这个）。
    renderPrintExtras() +
    "</div>";
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
    html += "<div class='print-heading'>工况图</div><div class='print-images'>" +
      attachments.map(item => "<img src='" + item.dataUrl + "' alt='工况图'>").join("") + "</div>";
  }
  const remarks = String(remarksInput?.value ?? "").trim();
  if (remarks) {
    html += "<div class='print-remarks'><b>备注</b><div>" + esc(remarks) + "</div></div>";
  }
  return html;
}

function renderPrintExtras() {
  return "<div id='printExtras'>" + printExtrasHtml() + "</div>";
}

/** 附件/备注是在算完之后才改的：只刷新打印区，不重跑选型。 */
function refreshPrintExtras() {
  const box = document.getElementById("printExtras");
  if (box) box.innerHTML = printExtrasHtml();
}

function render(result) {
  placeholder.hidden = true;
  output.hidden = false;
  stepsBox.hidden = false;
  // 打印头（含附图/备注/水印）已经整块包在 .print-only 里，屏幕上不显示。
  output.innerHTML = renderPrintHead(lastInput, result) +
    renderDuty(result) + renderVerdict(result) + renderCandidates(result);
  stepsBox.innerHTML = renderSteps(result);
  stepsBox.hidden = !document.getElementById("debug").checked && result.selection.ok;
  if (!result.selection.ok) stepsBox.hidden = false;
}

async function loadOptions() {
  if (options) return options;
  if (LOCAL) {
    const data = await LOCAL.ready;
    options = LOCAL.options(data);
  } else {
    const response = await fetch("/api/gearbox-options");
    if (!response.ok) throw new Error("读取产品系列失败（HTTP " + response.status + "）");
    options = await response.json();
  }
  seriesSelect.innerHTML = options.series.map(series =>
    '<option value="' + esc(series.id) + '">' + esc(series.id) + " 系列</option>").join("");
  if (options.series.some(series => series.id === "AB")) seriesSelect.value = "AB";
  fillRatios();
  return options;
}

async function run(input) {
  if (LOCAL) {
    const data = await LOCAL.ready;
    return LOCAL.run(input, data);
  }
  const response = await fetch("/api/gearbox-selection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json();
  // 注意：结果里的 ok=false 是"没选出型号"（正常业务结果，页面上要展示原因），
  // 只有接口错误（400 + error）才是异常。
  if (payload.error || !payload.duty) throw new Error(payload.error ?? "选型失败");
  return payload;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  statusEl.textContent = "计算中…";
  statusEl.classList.remove("bad");
  try {
    await loadOptions();
    const input = collect();
    lastInput = input;
    const result = await run(input);
    lastResult = result;
    render(result);
    // 静态版没有服务端 PDF（和旋转平台页一致）：按钮只在托管版出现
    syncReportActions(result);
    statusEl.textContent = result.selection.ok ? "完成" : "没选出";
  } catch (error) {
    statusEl.textContent = describeError(error);
    statusEl.classList.add("bad");
  }
});

document.getElementById("example").addEventListener("click", async () => {
  await loadOptions();
  // 示例比号要落在当前系列真有的比号里（AD 没有 30:1），取最接近的那个
  const pickRatio = preferred => {
    const values = [...ratioSelect.options].map(option => Number(option.value));
    const chosen = values.reduce((best, value) =>
      Math.abs(value - preferred) < Math.abs(best - preferred) ? value : best, values[0]);
    ratioSelect.value = String(chosen);
  };
  if (dutyType() === "gear-pair") {
    form.elements.turntableMass_kg.value = 500;
    form.elements.turntableDiameter_mm.value = 1000;
    form.elements.turntableShape.value = "disc";
    form.elements["bigGear.mass_kg"].value = 100;
    form.elements["bigGear.outerDiameter_mm"].value = 800;
    form.elements["bigGear.innerDiameter_mm"].value = 300;
    form.elements.gearboxInertia_kgm2.value = 0;
    form.elements.theta_deg.value = 180;
    form.elements.cycleTime_s.value = 3;
    form.elements.accelTime_s.value = 0.5;
    form.elements.decelTime_s.value = 0.5;
    decelTouched = false;
    syncDecelHint();
    pickRatio(30);
  } else {
    form.elements.case.value = "horizontal";
    form.elements.loadMass_kg.value = 250;
    form.elements.pitchDiameter_mm.value = 50.93;
    form.elements.lineSpeed_mm_s.value = 600;
    form.elements.chainAccelTime_s.value = 0.5;
    pickRatio(8);
  }
  syncRows();
  form.requestSubmit();
});

form.addEventListener("change", event => {
  if (["dutyType", "case", "turntableShape"].includes(event.target.name)) syncRows();
  if (event.target === seriesSelect) fillRatios();
  if (["bigGearTeeth", "smallGearTeeth", "drivenPulley_mm", "drivingPulley_mm"].includes(event.target.name)) updateRatios();
});
form.addEventListener("input", event => {
  if (["bigGearTeeth", "smallGearTeeth", "drivenPulley_mm", "drivingPulley_mm"].includes(event.target.name)) updateRatios();
});
document.getElementById("debug").addEventListener("change", () => {
  if (lastResult) stepsBox.hidden = !document.getElementById("debug").checked && lastResult.selection.ok;
});

// —— 减速时间：默认跟随加速时间，手动改了就单独用（所有者 2026-10-28）——
//
// 没动过减速框 → 改加速时间时减速时间跟着变；动过 → 两者分开算；
// 清空减速框 → 回到跟随（不会把一个空值发给引擎）。
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

// 报告：托管版向服务端要 PDF（服务端用同一套引擎重算再排版）；静态版没有这段。
printReport?.addEventListener("click", () => window.print());

/**
 * 报告按钮的显示规则（2026-10-28 修）：
 *   · 还没算出结果 → 整块不显示；
 *   · 托管版（有服务端）→ 两个下载按钮；
 *   · 静态版（lib/engine.js 在浏览器里算）→ 只给"打印 / 另存为 PDF"。
 *
 * 以前这里只用 `reportActions.hidden = ...` 控制，但 .report-actions 自带 display:flex，
 * 会盖掉浏览器默认的 [hidden]（作者样式优先），结果静态版一直显示两个点了必然 404 的按钮。
 * 现在 CSS 里有 [hidden]{display:none!important} 兜底，内容也按托管/静态分开。
 */
function syncReportActions(result) {
  if (!reportActions) return;
  const hasChoice = Boolean(result?.selection?.ok);
  const local = Boolean(LOCAL);
  reportActions.hidden = !hasChoice;
  for (const button of reportActions.querySelectorAll("button[data-variant]")) button.hidden = local;
  if (printReport) printReport.hidden = !local;
  if (reportHint) {
    reportHint.textContent = local
      ? "静态版：计算在你的浏览器里完成；要 PDF 就用打印对话框里的「另存为 PDF」。"
      : "";
  }
}

reportActions?.addEventListener("click", async event => {
  const button = event.target.closest("button[data-variant]");
  if (!button || !lastInput) return;
  button.disabled = true;
  statusEl.textContent = "正在生成报告…";
  try {
    const response = await fetch("/api/v1/reports/gearbox/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: lastInput, metadata: reportMetadata(button.dataset.variant) })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? "报告生成失败（HTTP " + response.status + "）");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = button.dataset.variant === "internal" ? "Gearbox_Internal.pdf" : "Gearbox.pdf";
    link.click();
    URL.revokeObjectURL(url);
    statusEl.textContent = "报告已生成";
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("bad");
  } finally {
    button.disabled = false;
  }
});

loadOptions().then(() => {
  syncRows();
  syncOutputHint();
  syncRightAngleRows();
}).catch(error => {
  statusEl.textContent = error.message;
  statusEl.classList.add("bad");
});
