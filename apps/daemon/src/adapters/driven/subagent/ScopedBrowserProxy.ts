import type { BrowserPort, ScrollDirection, ScreenshotFormat } from "../../../application/ports/outbound/BrowserPort";
import { foldPathSegments } from "../../../domain/sandbox/SandboxPolicy";

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
 *   收窄——stop/reclaimOwner 会越 owner 边界，归属校验兜不住），到达即白名单外拒绝；
 * - screenshotTab 落盘路径必须落在调用方给定的可写根内（F2 #6：子进程可指定任意
 *   绝对路径 → 把任意既有文件覆盖成图片字节，绕过 readonly 档「写工具摘除」且不进
 *   写入事实记账）。缺席可写根 = fail-closed 拒绝落盘。
 */

/** 调用侧上下文（可写根由 launcher 按 workspace 注入）。 */
export interface ScopedBrowserCallOptions {
  /** 子进程可写的落盘根（workspace 根）；截图路径越界即拒绝。 */
  readonly allowedWriteRoot?: string;
}

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
  options?: ScopedBrowserCallOptions,
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
  // H9：可选参 null 占位 → undefined 还原（wire 定长占位协议；port 缺省值归实现侧）
  if (method === "scrollTab") {
    return browser.scrollTab(
      tabId,
      (args[1] ?? undefined) as number | undefined,
      (args[2] ?? undefined) as ScrollDirection | undefined,
    );
  }
  if (method === "screenshotTab") {
    const file = (args[1] ?? undefined) as string | undefined;
    return browser.screenshotTab(
      tabId,
      resolveScreenshotPath(file, options?.allowedWriteRoot),
      (args[2] ?? undefined) as ScreenshotFormat | undefined,
    );
  }
  // 余下 7 个 tabId 方法：显式分发（M22 类型安全——动态索引 + 双重非空
  // 断言退役，白名单内逐方法接线；位置参数按 BrowserPort 签名取位）
  switch (method) {
    case "navigateTab":
      return browser.navigateTab(tabId, args[1] as string);
    case "backTab":
      return browser.backTab(tabId);
    case "evalInTab":
      return browser.evalInTab(tabId, args[1] as string);
    case "clickInTab":
      return browser.clickInTab(tabId, args[1] as string);
    case "clickAtInTab":
      return browser.clickAtInTab(tabId, args[1] as string);
    case "setFilesInTab":
      return browser.setFilesInTab(tabId, args[1] as string, args[2] as readonly string[]);
    case "closeTab":
      return browser.closeTab(tabId);
    default:
      // 白名单 12 方法在此已穷尽（openTab/listTabs/getStatus/scrollTab/
      // screenshotTab 归上方显式分支）——防御性不可达
      throw new Error(`未知 browser 转发方法 "${method}"（白名单内但无分发分支——接线缺失）`);
  }
}

/**
 * 截图落盘路径归属校验（F2 #6）：归一（段折叠）后必须落在 allowedWriteRoot 内。
 * 相对路径按可写根解析；根缺席 fail-closed（子进程不得自选落点）。
 */
function resolveScreenshotPath(file: string | undefined, allowedWriteRoot: string | undefined): string | undefined {
  if (file === undefined) return undefined; // 缺参交给 port 报错（不在此造第二套错误文案）
  if (allowedWriteRoot === undefined || allowedWriteRoot.trim() === "") {
    throw new Error(
      `browser screenshot 落盘被拒绝（子进程未获可写根注入）：file="${file}"——子进程不得自选落盘位置`,
    );
  }
  const root = foldPathSegments(allowedWriteRoot);
  const abs = foldPathSegments(file.startsWith("/") ? file : `${root}/${file}`);
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw new Error(
      `browser screenshot 落盘越界：file="${file}" 不在可写根 ${root} 内——` +
        "子进程截图只能落 workspace 内路径（防止借截图通道覆盖任意文件）",
    );
  }
  return abs;
}
