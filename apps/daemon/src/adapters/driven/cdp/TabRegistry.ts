/**
 * TabRegistry —— daemon 受管 tab 簿记（T2 CDP 地基；移植自
 * web-access/scripts/cdp-proxy.mjs 的 managedTabs + idle sweep 机制）。
 *
 * 【职责】纯簿记：managedTabs Map<tabId, {ownerId, url, title, lastAccessed}>
 * + 每次操作 touch + idle sweep 到期判定 + owner 维度批量清单。
 * CDP closeTarget 发送不归本模块——sweep 经 onIdle 回调把到期 tabId 清单
 * 交给 CdpConnectionManager 执行关闭（接缝面：本模块零 WS 依赖，unit
 * 测试 fake clock 直驱 sweep()）。
 *
 * 【时钟注入】now() 可注入（缺省 Date.now）——idle 判定单时间源；
 * sweep 间隔与闲置阈值构造可注入（测试用短间隔/假时钟）。
 */
import type { TabInfo } from "../../../application/ports/outbound/BrowserPort";

export interface TabRecord {
  readonly ownerId: string;
  readonly url: string;
  readonly title: string;
  readonly lastAccessed: number;
}

export interface TabRegistryDeps {
  /** 时钟（fake clock 注入口；缺省 Date.now）。 */
  readonly now?: () => number;
  /** sweep 扫描间隔 ms（缺省 60s，移植源 CLEANUP_INTERVAL）。 */
  readonly sweepIntervalMs?: number;
  /** 闲置阈值 ms（缺省 15min，移植源 TAB_IDLE_TIMEOUT）。 */
  readonly idleTimeoutMs?: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

export class TabRegistry {
  private readonly tabs = new Map<string, { ownerId: string; url: string; title: string; lastAccessed: number }>();
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private onIdle: ((tabIds: string[]) => void) | undefined;

  constructor(deps: TabRegistryDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** 注册受管 tab（openTab 成功点）。 */
  add(tabId: string, ownerId: string, url = "about:blank"): void {
    this.tabs.set(tabId, { ownerId, url, title: "", lastAccessed: this.now() });
  }

  /** 每次操作刷新活跃时刻（idle sweep 判定输入）；未管理 tab no-op。 */
  touch(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry) entry.lastAccessed = this.now();
  }

  /** url/title 回写（Target.attachedToTarget 事件 / navigate 后）；未管理 tab no-op。 */
  update(tabId: string, patch: { url?: string; title?: string }): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    if (patch.url !== undefined) entry.url = patch.url;
    if (patch.title !== undefined) entry.title = patch.title;
  }

  /** 出册（closeTarget/断线清理）；返回是否命中。 */
  remove(tabId: string): boolean {
    return this.tabs.delete(tabId);
  }

  /** 清空并返回全部移除 tabId（stop/断线清理用）。 */
  clear(): string[] {
    const ids = [...this.tabs.keys()];
    this.tabs.clear();
    return ids;
  }

  get(tabId: string): TabRecord | undefined {
    const entry = this.tabs.get(tabId);
    return entry === undefined ? undefined : { ...entry };
  }

  /** 受管 tab 清单（只读快照，注册序）。 */
  list(): TabInfo[] {
    return [...this.tabs.entries()].map(([tabId, e]) => ({
      tabId,
      ownerId: e.ownerId,
      url: e.url,
      title: e.title,
      lastAccessed: e.lastAccessed,
    }));
  }

  /** owner 维度批量清单（reclaimOwner 输入）。 */
  idsByOwner(ownerId: string): string[] {
    return [...this.tabs.entries()].filter(([, e]) => e.ownerId === ownerId).map(([id]) => id);
  }

  /** 闲置超期 tab（now - lastAccessed > idleTimeoutMs）。纯判定，副作用归 sweep。 */
  idleTabIds(): string[] {
    const now = this.now();
    return [...this.tabs.entries()].filter(([, e]) => now - e.lastAccessed > this.idleTimeoutMs).map(([id]) => id);
  }

  /**
   * 启动周期 sweep（manager connect 成功后挂）。回调 = 到期 tabId 清单
   * 的关闭执行面（manager 发 closeTarget + 出册）。重复调用先停旧定时器。
   */
  startSweep(onIdle: (tabIds: string[]) => void): void {
    this.stopSweep();
    this.onIdle = onIdle;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    // 不持有事件循环（daemon 退出不被本定时器吊住；bun/node 均支持 unref）
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  /** 停 sweep（stop()/断线清理；幂等）。 */
  stopSweep(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** 单轮 sweep（测试直驱面；周期定时器回调同一入口）。无到期不触发回调。 */
  sweep(): void {
    const ids = this.idleTabIds();
    if (ids.length > 0) this.onIdle?.(ids);
  }
}
