/**
 * 设置页分区跳转信号（模块级单例，B2）。
 *
 * 场景：设置页分区是页面本地 useState（无 URL 子路由——route.ts 扁平路由
 * 不扩机制），但设置页外存在「指路到设置页某分区」的诉求（记忆页/管家
 * 记忆区空列表引导 → 模型分区向量 tab）。本模块 = 进程内一次性 pending
 * 信号：指路方 request → navigate(ROUTE_SETTINGS)；SettingsPage 挂载时
 * consume → 切分区 + 透传 tab 初始值。无持久化（刷新即失效——引导语义
 * 不值得 sessionStorage 面）。
 */

/** 模型分区 tab 面（B2-③：对话模型 | 向量模型；三方平台批 +provider）。 */
export type ModelsTab = "chat" | "embedding" | "provider";

let pendingSection: { section: string; tab?: ModelsTab } | null = null;

/** 指路：请求设置页打开指定分区（可选携带模型分区 tab）。 */
export function requestSettingsSection(section: string, tab?: ModelsTab): void {
  pendingSection = { section, ...(tab !== undefined ? { tab } : {}) };
}

/** SettingsPage 挂载时消费（一次性——读后即清）。 */
export function consumePendingSection(): { section: string; tab?: ModelsTab } | null {
  const value = pendingSection;
  pendingSection = null;
  return value;
}
