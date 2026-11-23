// 电机按品牌过滤（纯函数）。
//
// 单独一个文件是为了浏览器：静态版把引擎搬进页面里算（2026-10-27 A 方案），
// 而 motor-library.mjs 顶部 import 了 node:fs（它要读 data/motors/*.json），
// 浏览器 import 不了——所以把这条纯逻辑拆出来，两边共用。
// motor-library.mjs 仍然 re-export 它，老的 import 路径不受影响。

/** 按品牌过滤（大小写不敏感）；不给品牌就返回全部。 */
export function motorsOfBrand(motors, brands) {
  if (!brands?.length) return [...motors];
  const wanted = new Set(brands.map(brand => String(brand).toLowerCase()));
  return motors.filter(motor => wanted.has(String(motor.brand ?? "").toLowerCase()));
}
