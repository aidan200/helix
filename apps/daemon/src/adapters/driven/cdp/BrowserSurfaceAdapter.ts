/**
 * BrowserSurfaceAdapter —— browser 表面 adapter（M1 感知批 + M2 act 执行面；
 * 设计 §1/§4 附录 A；E-251 第二个 adapter——browser 事件 daemon 内直接产出，
 * 与 shell ws 上行殊途同归进 SurfaceRegistry 归一口）。
 *
 * 职责：
 * - 感知上行（M1）：CDP 事件 → SurfaceEvent 归一（经 Registry.observeDirect
 *   ——D2 词汇表守卫单点不破）：观察者回传（bindingCalled）恒 origin=user
 *   （isTrusted 过滤在观察者/映射层；**回声窗口例外**见下）；CDP 协议层事件
 *   恒 origin=system（协议层不可归因用户/程序——安全侧归 system）；
 * - 动作下行（M2）：SurfaceLocalExecutor 实现面——act(verb) 派发到既有
 *   CDP 栈（BrowserPort：clickAtInTab 真实鼠标/navigateTab/scrollTab/
 *   evalInTab）执行真实浏览器操作；回执 ok/detail 回流（D7-1）；
 * - 回声窗口（CAND-592 方案）：act 执行期间开窗口（按 targetId），窗口内
 *   观察者事件标 origin=steward（不误判 user）；TTL 超时兜底关窗（挂死
 *   不永锁）；关闭后 user 事件照常归一。窗口不碰感知不变式：开关 off
 *   仍零注入零上报（onCdpEvent 首行闸），密码/输入值零采集面零改动；
 * - surfaceId 两段寻址 `browser:<targetId>`（tab 即表面）；
 * - FocusState 前台 tab（document.hasFocus() 上报真源——附录 A）；
 * - 只读面（M2 四泛型工具）：listSurfaces/snapshot/read——显式读取页面
 *   渲染文本（innerText，**不采 input 值/密码**——D1 隐私不变式不放松）。
 *
 * kind 映射面（词汇表外不新造——D2）：
 * - 观察者回传：focus→activated / blur→idle / nav→navigated / click→user_click
 *   / input→user_input；
 * - Page.frameNavigated（主框架）→navigated（携 errorText 时→error）；
 * - Target.targetCreated/targetDestroyed 等 tab 生命周期无六 kind 对应，
 *   仅 targetDestroyed 做 FocusState 清账（词汇表扩面留 M3）。
 */
import {
  SURFACE_VERB_CAPABILITIES,
  type SurfaceEvent,
} from "@helix/protocol";
import type {
  SurfaceActContext,
  SurfaceExecutionResult,
  SurfaceLocalExecutor,
  SurfaceRegistry,
} from "../../../application/surface/SurfaceRegistry";
import type {
  ClickAtResult,
  ScrollDirection,
  ScrollResult,
  TabInfo,
} from "../../../application/ports/outbound/BrowserPort";
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
  /**
   * CDP 操作面（M2 act 执行目标——BrowserPort 结构性窄面；缺省缺席 =
   * act/只读面降级「未接入」回执，感知面不受影响）。
   */
  readonly browser?: SurfaceBrowserOps;
  /** 回声窗口 TTL（缺省 3000ms——超时兜底关窗，挂死不永锁；测试注入小值）。 */
  readonly echoWindowMs?: number;
  /** act 执行超时（缺省 30s——CDP 栈挂起时回超时回执）。 */
  readonly actTimeoutMs?: number;
  readonly now?: () => number;
  readonly logger?: { warn(message: string): void };
}

/** CDP 操作面窄接口（BrowserPort 结构性子集——act 派发与只读面所需最小集）。 */
export interface SurfaceBrowserOps {
  navigateTab(tabId: string, url: string): Promise<void>;
  clickAtInTab(tabId: string, selector: string): Promise<ClickAtResult>;
  scrollTab(tabId: string, y?: number, direction?: ScrollDirection): Promise<ScrollResult>;
  evalInTab(tabId: string, expression: string): Promise<unknown>;
  listTabs(): Promise<readonly TabInfo[]>;
}

/** 表面清单行（surface_list 动态发现面）。 */
export interface SurfaceBrowserListing {
  readonly surfaceId: string;
  readonly kind: "browser";
  readonly label: string;
  readonly capabilities: readonly string[];
}

/** 只读面结果（snapshot/read 共用回执形状）。 */
export interface SurfaceReadResult {
  readonly ok: boolean;
  readonly text: string;
}

const DEFAULT_ECHO_WINDOW_MS = 3_000;
const DEFAULT_ACT_TIMEOUT_MS = 30_000;
const READ_TEXT_MAX_CHARS = 4_000;
const SNAPSHOT_TEXT_MAX_CHARS = 1_200;

type EchoWindow = { readonly timer: ReturnType<typeof setTimeout> };

export class BrowserSurfaceAdapter implements BrowserAwarenessSink, SurfaceLocalExecutor {
  /** 命名空间（surfaceId 第一段——Registry act 路由判据）。 */
  readonly namespace = "browser" as const;
  private readonly focusState = new BrowserFocusState();
  /** 回声窗口（CAND-592）：targetId → 在窗标记（TTL 兜底关窗）。 */
  private readonly echoWindows = new Map<string, EchoWindow>();

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
    // 回声窗口（CAND-592）：act 执行期间真实鼠标/输入事件观察者不可分
    // （isTrusted=true）——窗口内标 origin=steward，不误判为用户操作。
    const origin = this.echoWindows.has(targetId) ? "steward" : mapped.origin;
    this.emit(targetId, { kind: mapped.kind, origin, ...(mapped.detail !== undefined ? { detail: mapped.detail } : {}) });
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
    // 回声窗口（CAND-594）：act 期间 agent 自己的 Page.navigate 触发的导航（含
    // 失败 error 帧）归 steward——与观察者路径同口径（onBindingCalled 覆写）；
    // 窗口外用户地址栏/链接导航仍归 system（协议层不可归因用户/程序，安全侧
    // 保守——用户导航感知由观察者 user_click + SPA history 承载）。
    const origin = this.echoWindows.has(targetId) ? "steward" : "system";
    if (errorText !== "") {
      this.emit(targetId, { kind: "error", origin, detail: { url, errorText } });
      return;
    }
    this.emit(targetId, { kind: "navigated", origin, detail: { url } });
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

  // ── M2：动作执行面（SurfaceLocalExecutor——act 派发到 CDP 栈）────

  /** 动词能力面（D4 封闭注册：browser 五动词）。 */
  capabilities(): readonly string[] {
    return SURFACE_VERB_CAPABILITIES.browser;
  }

  /**
   * act 执行（经 Registry.act 路由到达）：回声窗口开→verb 派发到既有 CDP
   * 栈→窗口关；actTimeoutMs 超时兜底回执（D7-1 失败可定位不半途）。
   */
  async act(
    verb: string,
    args: Record<string, unknown>,
    ctx: SurfaceActContext,
  ): Promise<SurfaceExecutionResult> {
    const browser = this.deps.browser;
    if (browser === undefined) return { ok: false, detail: "browser 操作面未接入（组合根缺 BrowserPort）" };
    const targetId = targetIdOfSurfaceId(ctx.surfaceId ?? (typeof args.targetId === "string" ? `browser:${args.targetId}` : undefined));
    if (targetId === undefined) {
      return { ok: false, detail: "缺少目标表面（surfaceId=browser:<targetId>）——act 需定向到具体 tab" };
    }
    this.beginEcho(targetId);
    try {
      return await this.withTimeout(
        this.dispatchAct(verb, args, targetId, browser),
        this.deps.actTimeoutMs ?? DEFAULT_ACT_TIMEOUT_MS,
        verb,
      );
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    } finally {
      this.endEcho(targetId); // 执行收口关窗（TTL 兜底见 beginEcho）
    }
  }

  /** verb→CDP 栈派发（参数校验前置——缺参不触达 CDP）。 */
  private async dispatchAct(
    verb: string,
    args: Record<string, unknown>,
    targetId: string,
    browser: SurfaceBrowserOps,
  ): Promise<SurfaceExecutionResult> {
    switch (verb) {
      case "navigate": {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (url === "") return { ok: false, detail: "navigate 缺参：url 必填" };
        await browser.navigateTab(targetId, url);
        return { ok: true, detail: `已导航至 ${url}` };
      }
      case "click": {
        const selector = nonEmptyString(args.selector);
        if (selector === undefined) return { ok: false, detail: "click 缺参：selector 必填" };
        const result: ClickAtResult = await browser.clickAtInTab(targetId, selector);
        return result.clicked
          ? { ok: true, detail: `已点击 ${result.tag ?? "元素"}（${selector}）` }
          : { ok: false, detail: `点击未命中元素：${selector}` };
      }
      case "type": {
        const selector = nonEmptyString(args.selector);
        const text = typeof args.text === "string" ? args.text : undefined;
        if (selector === undefined) return { ok: false, detail: "type 缺参：selector 必填" };
        if (text === undefined) return { ok: false, detail: "type 缺参：text 必填" };
        const val = (await browser.evalInTab(targetId, typeScript(selector, text))) as
          | { typed?: boolean; error?: string }
          | undefined;
        return val?.typed === true
          ? { ok: true, detail: `已输入 ${text.length} 字符（${selector}）` }
          : { ok: false, detail: `输入失败（${selector}）：${val?.error ?? "未知原因"}` };
      }
      case "scroll": {
        const y = typeof args.y === "number" && Number.isFinite(args.y) ? args.y : undefined;
        const directionRaw = args.direction;
        const direction: ScrollDirection | undefined =
          directionRaw === "down" || directionRaw === "up" || directionRaw === "top" || directionRaw === "bottom"
            ? directionRaw
            : undefined;
        const result: ScrollResult = await browser.scrollTab(targetId, y, direction);
        return { ok: true, detail: result.value };
      }
      case "focus": {
        const selector = nonEmptyString(args.selector);
        if (selector === undefined) return { ok: false, detail: "focus 缺参：selector 必填" };
        const val = (await browser.evalInTab(targetId, focusScript(selector))) as
          | { focused?: boolean; error?: string }
          | undefined;
        return val?.focused === true
          ? { ok: true, detail: `已聚焦 ${selector}` }
          : { ok: false, detail: `聚焦失败（${selector}）：${val?.error ?? "未知原因"}` };
      }
      default:
        return { ok: false, detail: `动词 ${verb} 未注册（Registry 注册校验面外的执行路径——不派发）` };
    }
  }

  // ── M2：只读面（surface_list / snapshot / read——显式读取非被动采集）──

  /** 表面清单（动态发现：tab 即表面 + 能力声明）。 */
  async listSurfaces(): Promise<readonly SurfaceBrowserListing[]> {
    const browser = this.deps.browser;
    if (browser === undefined) return [];
    const tabs = await browser.listTabs();
    return tabs.map((t: TabInfo) => ({
      surfaceId: `browser:${t.tabId}`,
      kind: "browser" as const,
      label: `${t.title} — ${t.url}`,
      capabilities: SURFACE_VERB_CAPABILITIES.browser,
    }));
  }

  /** 快照（url/title/可见文本摘录——D1：只读渲染文本，不采 input 值/密码）。 */
  async snapshot(surfaceId: string): Promise<SurfaceReadResult> {
    return this.readEval(surfaceId, snapshotScript(SNAPSHOT_TEXT_MAX_CHARS), true);
  }

  /** 内容读取（可选 selector 限定 + 长度上限；同 D1 隐私边界）。 */
  async read(
    surfaceId: string,
    opts: { selector?: string; maxChars?: number } = {},
  ): Promise<SurfaceReadResult> {
    const maxChars =
      typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars) && opts.maxChars > 0
        ? Math.min(Math.floor(opts.maxChars), READ_TEXT_MAX_CHARS)
        : READ_TEXT_MAX_CHARS;
    return this.readEval(surfaceId, readScript(opts.selector, maxChars), false);
  }

  /** 只读脚本执行（缺操作面/缺 tab → 降级回执）。 */
  private async readEval(surfaceId: string, expr: string, asSnapshot: boolean): Promise<SurfaceReadResult> {
    const browser = this.deps.browser;
    if (browser === undefined) return { ok: false, text: "browser 操作面未接入（组合根缺 BrowserPort）" };
    const targetId = targetIdOfSurfaceId(surfaceId);
    if (targetId === undefined) return { ok: false, text: `surfaceId 形状非法：${surfaceId}（应为 browser:<targetId>）` };
    try {
      const val = await browser.evalInTab(targetId, expr);
      if (asSnapshot) {
        const parsed = typeof val === "string" ? (JSON.parse(val) as { url?: string; title?: string; text?: string }) : (val as { url?: string; title?: string; text?: string } | undefined);
        if (parsed === undefined || parsed === null) return { ok: false, text: `表面 ${surfaceId} 无快照产出` };
        return {
          ok: true,
          text: `【${parsed.title ?? "（无标题）"}】${parsed.url ?? ""}\n${parsed.text ?? ""}`,
        };
      }
      return { ok: true, text: typeof val === "string" ? val : JSON.stringify(val ?? "") };
    } catch (err) {
      return { ok: false, text: `表面 ${surfaceId} 读取失败：${(err as Error).message}` };
    }
  }

  // ── M2：回声窗口（CAND-592）─────────────────────────────

  /** 开回声窗口（TTL 超时兜底关窗——挂死不永锁）。 */
  private beginEcho(targetId: string): void {
    this.endEcho(targetId);
    const ttl = this.deps.echoWindowMs ?? DEFAULT_ECHO_WINDOW_MS;
    const timer = setTimeout(() => {
      this.echoWindows.delete(targetId);
    }, ttl);
    timer.unref?.();
    this.echoWindows.set(targetId, { timer });
  }

  /** 关回声窗口（幂等——act 收口调用）。 */
  private endEcho(targetId: string): void {
    const win = this.echoWindows.get(targetId);
    if (win === undefined) return;
    clearTimeout(win.timer);
    this.echoWindows.delete(targetId);
  }

  /** 执行超时兜底（CDP 栈挂起 → 超时回执，detail 带超时字样）。 */
  private async withTimeout<T>(run: Promise<T>, ms: number, verb: string): Promise<T> {
    if (ms <= 0) return run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`act 执行超时（${verb}，${ms}ms）——CDP 栈未回执`)), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// ── 页面内脚本（M2 act/只读面；合成事件 isTrusted=false——观察者过滤层不误判） ──

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** surfaceId → targetId（`browser:<targetId>` 两段寻址；非法返 undefined）。 */
function targetIdOfSurfaceId(surfaceId: string | undefined): string | undefined {
  if (surfaceId === undefined) return undefined;
  const sep = surfaceId.indexOf(":");
  if (sep <= 0 || sep === surfaceId.length - 1) return undefined;
  if (surfaceId.slice(0, sep) !== "browser") return undefined;
  return surfaceId.slice(sep + 1);
}

/** type 脚本：聚焦 + 原生 setter 赋值 + input/change 合成事件（React 受控面可用）。 */
function typeScript(selector: string, text: string): string {
  return `(() => {
  const sel = ${JSON.stringify(selector)};
  const value = ${JSON.stringify(text)};
  const el = document.querySelector(sel);
  if (!el) return { error: '未找到元素: ' + sel };
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: true, tag: el.tagName };
})()`;
}

/** focus 脚本。 */
function focusScript(selector: string): string {
  return `(() => {
  const sel = ${JSON.stringify(selector)};
  const el = document.querySelector(sel);
  if (!el) return { error: '未找到元素: ' + sel };
  el.focus();
  return { focused: true, tag: el.tagName };
})()`;
}

/** 快照脚本（innerText = 渲染文本——不采 input 值/密码，D1）。 */
function snapshotScript(maxChars: number): string {
  return `JSON.stringify({ url: location.href, title: document.title, text: (document.body && document.body.innerText || '').slice(0, ${maxChars}) })`;
}

/** 内容读取脚本（同 D1 隐私边界）。 */
function readScript(selector: string | undefined, maxChars: number): string {
  const root =
    selector !== undefined
      ? `document.querySelector(${JSON.stringify(selector)})`
      : "document.body";
  return `(() => {
  const root = ${root};
  if (!root) return '';
  return (root.innerText || root.textContent || '').slice(0, ${maxChars});
})()`;
}
