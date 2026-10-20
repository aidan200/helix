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
export type ModelsTab = "chat" | "embedding" | "classifier" | "provider";

let pendingSection: { section: string; tab?: ModelsTab } | null = null;

/** 指路：请求设置页打开指定分区（可选携带模型分区 tab）。 */
export function requestSettingsSection(section: string, tab?: ModelsTab): void {
  pendingSection = { section, ...(tab !== undefined ? { tab } : {}) };
}

/**
 * 读 pending 信号**不清位**（渲染期只读面）：SettingsPage 在 useState 惰性初值
 * 里读它——StrictMode/并发渲染会多次跑渲染腿，渲染期 consume（读后即清）
 * 会让「第二次读」必得 null（状态初值落缺省，指路信号丢失）。清位交给挂载
 * effect 的 clearPendingSection（双跑幂等）。
 */
export function peekPendingSection(): { section: string; tab?: ModelsTab } | null {
  return pendingSection;
}

/** 清位（SettingsPage 挂载后调用一次；一次性信号语义的写面）。 */
export function clearPendingSection(): void {
  pendingSection = null;
}

/** 兼容面：读并清（非渲染期调用方用；渲染期一律 peek）。 */
export function consumePendingSection(): { section: string; tab?: ModelsTab } | null {
  const value = pendingSection;
  pendingSection = null;
  return value;
}
