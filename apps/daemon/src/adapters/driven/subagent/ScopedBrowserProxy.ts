import type { BrowserPort } from "../../../application/ports/outbound/BrowserPort";

/**
 * ScopedBrowserProxy —— daemon 侧 tool-req 归属代理（H-3 方案 A，纯函数面）。
 *
 * SubAgent 子进程经 wire 转发的 browser 调用在此收口：白名单分发 + owner
 * 归属强制——launcher（driven adapter）只转发不决策（AG-12），归属校验全部
 * 落本纯函数（无 IO 自持，browser 单例由调用方注入）。
 *
 * 规则（H-3 裁决 2/4）：
 * - openTab：ownerId 强制改写为通道 instanceId（参数末位覆盖，子进程不可伪造）；
 * - 其余 tabId 方法：listTabs 查归属，ownerId ≠ instanceId（或不存在）→ 拒绝——
 *   堵「拿到别人 tabId 就能操作」缺口（主线 ownerId="main" 的 tabs 对 SubAgent
 *   不可见不可触）；
 * - listTabs：过滤 owner 维度子集；getStatus：透传（观测面无操作能力）；
 * - 管理面 4 方法（connect/onStatusChange/stop/reclaimOwner）不上 wire（有意
 *   收窄——stop/reclaimOwner 会越 owner 边界，归属校验兜不住），到达即白名单外拒绝。
 */

/** wire 白名单：browser 工具可达的 12 个操作方法（H-3 裁决 4）。 */
const WIRE_METHODS = new Set([
  "openTab",
  "navigateTab",
  "backTab",
  "evalInTab",
  "clickInTab",
  "clickAtInTab",
  "setFilesInTab",
  "scrollTab",
  "screenshotTab",
  "closeTab",
  "getStatus",
  "listTabs",
]);



/**
 * tool-req 分发：method 白名单校验 → 归属规则 → browser 单例调用。
 * args = 子进程 wire 帧的位置参数数组（RemoteBrowserPort 侧已按方法签名组装）。
 */
export async function scopedBrowserCall(
  browser: BrowserPort,
  instanceId: string,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  if (!WIRE_METHODS.has(method)) {
    throw new Error(`未知 browser 转发方法 "${method}"（白名单外——管理面 4 方法不上 wire，H-3 裁决 4）`);
  }
  if (method === "openTab") {
    // ownerId 强制改写（参数末位覆盖，子进程不可伪造）
    return browser.openTab(args[0] as string, instanceId);
  }
  if (method === "listTabs") {
    return (await browser.listTabs()).filter((t) => t.ownerId === instanceId);
  }
  if (method === "getStatus") {
    return browser.getStatus(); // 观测面透传（无操作能力）
  }
  // tabId 方法：归属校验（ownerId ≠ instanceId / 不存在 → 拒绝，不触达 port）
  const tabId = args[0] as string;
  const tab = (await browser.listTabs()).find((t) => t.tabId === tabId);
  if (tab === undefined || tab.ownerId !== instanceId) {
    throw new Error(`tab ${tabId} 不属于实例 ${instanceId}（或不存在）`);
  }
  return (browser as unknown as Record<string, (...a: readonly unknown[]) => Promise<unknown>>)[method]!(...args);
}
