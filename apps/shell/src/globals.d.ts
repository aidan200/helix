/**
 * 全局常量声明（构建期 define 注入，vite.config.ts）。
 *
 * `__HELIX_FAKE_TRANSPORT__`（T4.4）：F 层 mock mode 标准入口的构建期开关，
 * 值来自 `VITE_HELIX_FAKE_TRANSPORT`（"1" = 默认剧本；或剧本模块 URL）。
 * 生产构建未定义 → define 空串 → 引用点常量折叠，fake 模块零代码路径
 * （动态 import 站点随之 treeshake，vite build 产物 grep 验证）。
 */
declare const __HELIX_FAKE_TRANSPORT__: string | undefined;

/**
 * W6a 壳注入的原生目录选择能力挂载点（脚本式全局声明，与上方 declare
 * const 同形态）：src-tauri initialization_script 在页面脚本前挂
 * `window.helixPickDirectory`（tauri-plugin-dialog 目录选择，F3 裁决的壳
 * 唯一原生 UX 能力）。纯浏览器 dev 无此挂载点 → undefined，消费面经
 * shared/api/native-capability.ts seam 受控访问（探测/调用，前端零
 * Tauri 内部形态词，AG-17）。
 */
declare var helixPickDirectory:
  | ((initial?: string) => Promise<string | null>)
  | undefined;
