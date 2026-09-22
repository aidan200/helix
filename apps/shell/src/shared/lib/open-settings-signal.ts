/**
 * 「打开设置页某分区」进程内信号（Bug 修复批：P-3 零可用空态逃生口）。
 *
 * FSD 链路（AG-15 守护面约束下的合法通路）：
 * - 发起方（features/pages/widgets 任意层）→ requestOpenSettings（引 shared 合法）；
 * - 接线方 = app 层 App.tsx 订阅 → navigate(ROUTE_SETTINGS) + 分区信号
 *   requestSettingsSection（app → pages 引用合法）；
 * - SettingsPage 挂载时 consumePendingSection 切分区/tab（既有机制不动）。
 *
 * 不用 pending 单例而用 listener 广播：跳转时机任意（运行中任意时刻点击），
 * 订阅制零轮询；App 重挂载（路由壳重渲）自然重订阅。
 *
 * 参数形态与 requestSettingsSection 对齐（section + 可选 ModelsTab 字符串）
 * ——shared 层不引 pages 的类型（依赖方向：types 用宽 string，接线方收敛）。
 */

type OpenSettingsListener = (section: string, tab?: string) => void;

const listeners = new Set<OpenSettingsListener>();

/** 发起：请求打开设置页指定分区（可选携带模型分区 tab 名）。 */
export function requestOpenSettings(section: string, tab?: string): void {
  for (const listener of listeners) listener(section, tab);
}

/** 订阅（app 层接线方消费；返回退订函数）。 */
export function subscribeOpenSettings(listener: OpenSettingsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
