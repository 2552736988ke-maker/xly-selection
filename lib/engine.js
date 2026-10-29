// 静态版引擎入口（构建时生成，不用手改）。
//
// 把 data.json 读进来一次，然后把两个入口交给页面：
//   window.__selectionEngine = { ready, run }       旋转平台选型（/index.html）
//   window.__gearboxEngine   = { ready, run, options } 减速机选型（/gearbox.html）
// 页面看到这些全局对象就知道"不用发请求，自己算"。
import { runSelection } from "./run-selection.js";
import { runGearboxSelection } from "./run-gearbox-selection.js";
import { selectableSeries, seriesRatios } from "./gearbox-select.js";
import { ratioLevelsOf } from "./gearbox-catalog.js";
import { GEARBOX_DUTY_TYPES } from "./gearbox-duty.js";

const dataUrl = new URL("../data.json", import.meta.url);
const ready = fetch(dataUrl).then(response => {
  if (!response.ok) throw new Error("产品数据加载失败（HTTP " + response.status + "）");
  return response.json();
});

function gearboxOptions(data) {
  return {
    ok: true,
    series: selectableSeries(data.gearboxCatalog).map(series => {
      const models = data.gearboxCatalog.models.filter(model => model.series === series);
      const levels = models.reduce((acc, model) => {
        const own = ratioLevelsOf(data.gearboxCatalog, model);
        for (const level of ["single", "double", "triple"]) {
          for (const ratio of own[level]) if (!acc[level].includes(ratio)) acc[level].push(ratio);
        }
        return acc;
      }, { single: [], double: [], triple: [] });
      for (const level of ["single", "double", "triple"]) levels[level].sort((a, b) => a - b);
      return { id: series, ratios: seriesRatios(data.gearboxCatalog, series, { verifiedOnly: true }), levels, frames: models.map(model => model.model) };
    }),
    dutyTypes: Object.values(GEARBOX_DUTY_TYPES).map(type => ({ id: type.id, labelZh: type.labelZh }))
  };
}

window.__selectionEngine = {
  ready,
  run: (input, data) => runSelection(input, data)
};

window.__gearboxEngine = {
  ready,
  run: (input, data) => runGearboxSelection(input, data),
  options: gearboxOptions
};
