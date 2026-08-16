/**
 * 全局常量声明（构建期 define 注入，vite.config.ts）。
 *
 * `__HELIX_FAKE_TRANSPORT__`（T4.4）：F 层 mock mode 标准入口的构建期开关，
 * 值来自 `VITE_HELIX_FAKE_TRANSPORT`（"1" = 默认剧本；或剧本模块 URL）。
 * 生产构建未定义 → define 空串 → 引用点常量折叠，fake 模块零代码路径
 * （动态 import 站点随之 treeshake，vite build 产物 grep 验证）。
 */
declare const __HELIX_FAKE_TRANSPORT__: string | undefined;
