/**
 * BrowserSurfaceAdapter —— browser 表面 adapter（M1 感知批；设计 §1/§4 附录
 * A；E-251 第二个 adapter——browser 事件 daemon 内直接产出，与 shell ws 上行
 * 殊途同归进 SurfaceRegistry 归一口）。
 *
 * 职责（纯感知上行——act/risk 是 M2）：
 * - CDP 事件 → SurfaceEvent 归一（经 Registry.observeDirect——D2 词汇表守卫
 *   单点不破）：观察者回传（bindingCalled）恒 origin=user（isTrusted 过滤在
 *   观察者/映射层）；CDP 协议层事件恒 origin=system（协议层不可归因用户/
 *   程序——用户地址栏导航与 agent Page.navigate 同路，安全侧归 system，
 *   回声过滤不误判；用户操作归因由观察者交互事件与 SPA history 导航承载）；
 * - surfaceId 两段寻址 `browser:<targetId>`（设计 §1：tab 即表面，无 page
 *   维度——连接型表面三段寻址不同款）；
 * - FocusState 前台 tab（document.hasFocus() 上报真源——附录 A）；
 * - 感知开关（surface.awareness KV，D1 默认 off）：off = 零上报（注入面的
 *   零注入在 CdpConnectionManager.ensureObserver 同开关把门）。
 *
 * kind 映射面（词汇表外不新造——D2）：
 * - 观察者回传：focus→activated / blur→idle / nav→navigated / click→user_click
 *   / input→user_input；
 * - Page.frameNavigated（主框架）→navigated（携 errorText 时→error——导航
 *   失败上行，error kind 的低噪音生产面）；子框架零事件（跨域 iframe 不递归
 *   采集，附录 A）；
 * - Target.targetCreated/targetDestroyed 等 tab 生命周期已路由到本面（事件
 *   不再丢弃）但无六 kind 对应（真缺 opened/closed 类词汇——按 brief 停下
 *   申报，不新造 kind；观察面留 M3 SalienceGate），仅 targetDestroyed 做
 *   FocusState 清账。
 */
import type { SurfaceEvent } from "@helix/protocol";
import type { SurfaceRegistry } from "../../../application/surface/SurfaceRegistry";
import type { BrowserAwarenessSink, CdpEventContext } from "./CdpConnectionManager";
import {
  BrowserFocusState,
  OBSERVER_BINDING_NAME,
  mapObserverMessage,
  parseObserverMessage,
} from "./browser-observer";

/**
 * 感知开关 KV 键（"1" = on；缺省 = off——D1 感知默认关）。与 shell 侧
 * localStorage 键 helix.surface.awareness 同语义不同平面（daemon 侧采集端
 * 闸）；设置面 UI 属后续批次（E-251「给感知开关接 UI 前」场景）。
 */
export const SURFACE_AWARENESS_KEY = "surface.awareness";

export interface BrowserSurfaceAdapterDeps {
  /** 归一口（SurfaceRegistry——observeDirect 直出；观察者订阅面在组合根）。 */
  readonly registry: Pick<SurfaceRegistry, "observeDirect">;
  /** 感知开关读面（KV surface.awareness；测试注入可切）。 */
  readonly awarenessOn: () => boolean;
  readonly logger?: { warn(message: string): void };
}

export class BrowserSurfaceAdapter implements BrowserAwarenessSink {
  private readonly focusState = new BrowserFocusState();

  constructor(private readonly deps: BrowserSurfaceAdapterDeps) {}

  /** 感知开关读面（异常环境降级 off——D1 保守侧）。 */
  isEnabled(): boolean {
    try {
      return this.deps.awarenessOn();
    } catch {
      return false;
    }
  }

  /** 当前前台 tab（FocusState 读面——「用户在哪个页面」的判定源）。 */
  focusedTarget(): string | undefined {
    return this.focusState.focusedTarget();
  }

  /** CDP 事件路由消费面（manager 侧已按 targetId 归属——防串扰）。 */
  onCdpEvent(method: string, params: Record<string, unknown>, ctx: CdpEventContext): void {
    if (!this.isEnabled()) return; // 零上报（D1）
    switch (method) {
      case "Runtime.bindingCalled":
        this.onBindingCalled(params, ctx);
        return;
      case "Page.frameNavigated":
        this.onFrameNavigated(params, ctx);
        return;
      case "Target.targetDestroyed":
      case "Target.detachedFromTarget": {
        // 消亡/脱附清前台账（零 SurfaceEvent——tab 生命周期无六 kind 对应）
        const targetId = typeof params.targetId === "string" ? params.targetId : ctx.targetId;
        if (targetId !== undefined) this.focusState.noteTargetDestroyed(targetId);
        return;
      }
      default:
        // 其余事件帧已路由到本面（不再丢弃）但无六 kind 对应（如 targetCreated
        // ——真缺 kind 停下申报）；观察面留 M3 SalienceGate
        return;
    }
  }

  // ── 内部：观察者回传（用户活动 + 前台判定） ──────────────────

  private onBindingCalled(params: Record<string, unknown>, ctx: CdpEventContext): void {
    if (params.name !== OBSERVER_BINDING_NAME) return;
    const targetId = ctx.targetId;
    if (targetId === undefined) return; // 归属缺失丢弃不串扰
    const msg = parseObserverMessage(typeof params.payload === "string" ? params.payload : "");
    if (msg === undefined) return;
    const mapped = mapObserverMessage(msg);
    if (mapped === undefined) return; // isTrusted 过滤/密码零采集（映射层拒收）
    // 前台判定（hasFocus 真源）：focus 抢前台 / blur 持有者清账
    if (msg.kind === "focus") this.focusState.noteFocus(targetId, true);
    else if (msg.kind === "blur") this.focusState.noteFocus(targetId, false);
    this.emit(targetId, mapped);
  }

  // ── 内部：CDP 协议事件 ────────────────────────────────────

  private onFrameNavigated(params: Record<string, unknown>, ctx: CdpEventContext): void {
    const frame = params.frame as { parentId?: unknown; url?: unknown; errorText?: unknown } | undefined;
    if (frame === undefined) return;
    if (typeof frame.parentId === "string") return; // 子框架零事件（跨域 iframe 不递归）
    const targetId = ctx.targetId;
    if (targetId === undefined) return;
    const url = typeof frame.url === "string" ? frame.url : "";
    const errorText = typeof frame.errorText === "string" ? frame.errorText : "";
    if (errorText !== "") {
      this.emit(targetId, { kind: "error", origin: "system", detail: { url, errorText } });
      return;
    }
    this.emit(targetId, { kind: "navigated", origin: "system", detail: { url } });
  }

  // ── 内部：归一投递 ──────────────────────────────────────

  /** surfaceId 两段盖章（`browser:<targetId>`）→ Registry 归一（at 盖章 + 观察者分发）。 */
  private emit(targetId: string, mapped: { kind: SurfaceEvent["kind"]; origin: SurfaceEvent["origin"]; detail?: Record<string, unknown> }): void {
    try {
      this.deps.registry.observeDirect({
        kind: mapped.kind,
        origin: mapped.origin,
        surfaceId: `browser:${targetId}`,
        ...(mapped.detail !== undefined ? { detail: mapped.detail } : {}),
      });
    } catch (err) {
      this.deps.logger?.warn(`browser 表面事件投递异常（${targetId}）：${(err as Error).message}`);
    }
  }
}
