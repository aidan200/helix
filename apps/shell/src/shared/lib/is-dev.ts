/**
 * dev 环境判定（原型演示控件门控；review.md「原型标注」）。
 *
 * 用途：原型 data-demo 演示控件（F5.5 索引面板三态 seg）转本门控——
 * dev（vite dev server / F 层 mock mode）可见可用，生产构建不渲染
 * （import.meta.env.DEV 编译期常量，prod 分支随打包摇除）。
 */
export function isDev(): boolean {
  return import.meta.env.DEV;
}
