/**
 * browser-observer —— 页面观察者脚本 + 回传解析 + kind 映射 + FocusState
 * （M1 browser adapter 感知批；设计稿 §4 附录 A / D1 / D2 / D7-2）。
 *
 * 分层（与 CDP 协议面解耦——本模块零 CDP 符号，纯可测）：
 * - OBSERVER_SCRIPT：经 Page.addScriptToEvaluateOnNewDocument 注入页面 +
 *   addBinding 回传（Runtime.bindingCalled，不受 CSP 约束）；导航后自动重
 *   注入；SPA 内导航自监听 history；iframe 不递归采集（window.top 拦截——
 *   跨域 iframe 远期，附录 A）；
 * - parseObserverMessage：bindingCalled payload JSON → 形状守卫后的消息；
 * - mapObserverMessage：观察者事件 → 六 kind 封闭词汇表（D2 词汇表外不新
 *   造）+ origin 恒 user（观察者回传 = 用户活动面）。可信度口径（F2 #30 校正，
 *   **不是安全边界**）：isTrusted 过滤只挡「意外的合成事件」（agent JS 层
 *   click()/dispatchEvent 造成的误归因）；binding 是页面级函数，任意页面脚本
 *   可直接调 window[OBSERVER_BINDING_NAME](JSON.stringify({t:"click",trusted:true}))
 *   伪造——trusted 只是可复制的 JSON 字段，无签名/无一次性凭证。故 origin=user
 *   与 focusedTarget 判定是「尽力而为的归因」：恶意页面理论上可伪造「用户正在
 *   活动/停在哪个页面」。威胁模型沿用沙箱裁决（只防诚实错误，不做对抗级打磨）；
 *   若后续要把感知面作安全判据（如写面审批），必须先补会话级不可伪造凭证。
 * - BrowserFocusState：前台 tab 状态机（document.hasFocus() 上报为可靠真源
 *   ——不依赖 targetInfoChanged 激活态，附录 A）。
 *
 * 隐私（D1 一等公民）：input 只记形状（tag/inputType）不记内容（零 value）；
 * 密码字段零采集（脚本与映射双层拦截）。事件风暴在脚本内限速（同类型最小
 * 间隔合并——附录 A「事件风暴在门控层聚合限速」的脚本侧第一道）。
 *
 * 反检测备注（brief 范围钳制）：观察者只读零操作；agent 工具 clickAtInTab
 * （Input.dispatchMouseEvent 真实鼠标事件）在页面内 isTrusted=true，理论上
 * 会被当作用户操作——按 brief 指示实测确认前不加回声逻辑（停下申报面，见
 * findings）。
 */

/** 页面绑定名（Runtime.addBinding 注册；页面内 window[name] 回传）。 */
export const OBSERVER_BINDING_NAME = "__helixSurfaceObserve";

/**
 * 页面观察者脚本（注入后每份新文档执行；首报现态交代亮相）。
 *
 * 事件面（全部只读零操作）：
 * - focus/blur（trusted）→ 前台判定（hasFocus 真源）；
 * - click/input（isTrusted 过滤——合成事件零上报；input 只记形状）；
 * - history pushState/replaceState/popstate/hashchange → SPA 内导航；
 *   文档级导航由 CDP Page.frameNavigated 覆盖（不在此重复）。
 *
 * 注：脚本以字符串形式经 CDP 注入页面上下文（非同模块可 import）——
 * 测试经 new Function + fake DOM 执行（browser-observer.test）。
 */
export const OBSERVER_SCRIPT = [
  "(() => {",
  "  try {",
  "    if (window.top !== window) return;", // iframe 不递归采集（跨域远期）
  '    var name = "' + OBSERVER_BINDING_NAME + '";',
  '    if (typeof window[name] !== "function") return;',
  "    if (window.__helixSurfaceInstalled) return;",
  "    window.__helixSurfaceInstalled = true;",
  "    var send = function (m) {",
  "      try { window[name](JSON.stringify(m)); } catch (e) {}",
  "    };",
  "    var last = {};",
  "    var MIN_INTERVAL = 300;", // 事件风暴限速窗（同类型最小间隔）
  "    var throttle = function (type, build) {",
  "      var now = Date.now();",
  "      if (last[type] !== undefined && now - last[type] < MIN_INTERVAL) return;",
  "      last[type] = now;",
  "      var msg = build();",
  "      if (msg) send(msg);",
  "    };",
  "    var reportFocus = function (focused) {",
  "      send({ t: focused ? \"focus\" : \"blur\", trusted: true, url: location.href });",
  "    };",
  '    window.addEventListener("focus", function (e) { if (e.isTrusted) reportFocus(true); }, true);',
  '    window.addEventListener("blur", function (e) { if (e.isTrusted) reportFocus(false); }, true);',
  "    if (document.hasFocus()) reportFocus(true);", // 首报现态（亮相交代；非前台静默）
  '    document.addEventListener("click", function (e) {',
  "      if (!e.isTrusted) return;",
  '      throttle("click", function () {',
  "        var el = e.target || {};",
  '        return { t: "click", trusted: true, tag: el.tagName ? String(el.tagName).toLowerCase() : "", url: location.href };',
  "      });",
  "    }, true);",
  "    var shape = function (e) {",
  "      var el = e.target;",
  "      if (!el) return null;",
  '      var type = el.type ? String(el.type).toLowerCase() : "";',
  '      if (type === \"password\") return null;', // D1 密码字段零采集
  '      return { t: "input", trusted: true, tag: el.tagName ? String(el.tagName).toLowerCase() : "", inputType: type, url: location.href };',
  "    };",
  '    document.addEventListener("input", function (e) {',
  "      if (!e.isTrusted) return;",
  '      throttle("input", function () { return shape(e); });',
  "    }, true);",
  '    var nav = function () { throttle("nav", function () { return { t: "nav", trusted: true, url: location.href }; }); };',
  "    var push = history.pushState, replace = history.replaceState;",
  "    history.pushState = function () { var r = push.apply(this, arguments); nav(); return r; };",
  "    history.replaceState = function () { var r = replace.apply(this, arguments); nav(); return r; };",
  '    window.addEventListener("popstate", nav);',
  '    window.addEventListener("hashchange", nav);',
  "  } catch (e) {}",
  "})();",
].join("\n");

// ── 回传消息解析（bindingCalled payload） ─────────────────────────

/** 观察者消息类别（页面脚本侧 t 字段）。 */
export type ObserverMessageKind = "focus" | "blur" | "nav" | "click" | "input";

/** 观察者消息（形状守卫后；只含形状零内容——D1）。 */
export interface ObserverMessage {
  /** 消息类别。 */
  readonly kind: ObserverMessageKind;
  /** 事件可信度（isTrusted——合成事件 false，映射层拒收）。 */
  readonly trusted: boolean;
  /** 页面地址（归属现场）。 */
  readonly url?: string;
  /** 目标元素标签（点击/输入形状；小写）。 */
  readonly tag?: string;
  /** 输入控件类型（形状；小写）。 */
  readonly inputType?: string;
}

const OBSERVER_MESSAGE_KINDS: readonly string[] = ["focus", "blur", "nav", "click", "input"];

/** bindingCalled payload 解析（形状守卫；垃圾输入返 undefined 静默）。 */
export function parseObserverMessage(raw: string): ObserverMessage | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as { t?: unknown; trusted?: unknown; url?: unknown; tag?: unknown; inputType?: unknown };
  if (typeof o.t !== "string" || !OBSERVER_MESSAGE_KINDS.includes(o.t)) return undefined;
  return {
    kind: o.t as ObserverMessageKind,
    // trusted 缺席按 false（保守——不放行未知来源）
    trusted: o.trusted === true,
    ...(typeof o.url === "string" ? { url: o.url } : {}),
    ...(typeof o.tag === "string" ? { tag: o.tag } : {}),
    ...(typeof o.inputType === "string" ? { inputType: o.inputType } : {}),
  };
}

// ── kind 映射（六 kind 封闭词汇表——D2） ─────────────────────────

/** 映射产物（入 SurfaceRegistry 前的形态；origin 恒 user）。 */
export interface MappedObserverEvent {
  readonly kind: "activated" | "idle" | "navigated" | "user_click" | "user_input";
  readonly origin: "user";
  readonly detail?: Record<string, unknown>;
}

/**
 * 观察者事件 → 六 kind 映射表（词汇表外不新造）：
 * focus→activated / blur→idle / nav→navigated / click→user_click /
 * input→user_input。isTrusted=false 的交互（合成事件）拒收；密码输入拒收。
 */
export function mapObserverMessage(msg: ObserverMessage): MappedObserverEvent | undefined {
  switch (msg.kind) {
    case "focus":
      return { kind: "activated", origin: "user", ...(msg.url !== undefined ? { detail: { url: msg.url } } : {}) };
    case "blur":
      return { kind: "idle", origin: "user", ...(msg.url !== undefined ? { detail: { url: msg.url } } : {}) };
    case "nav":
      return { kind: "navigated", origin: "user", ...(msg.url !== undefined ? { detail: { url: msg.url } } : {}) };
    case "click":
      if (!msg.trusted) return undefined; // 合成点击不误判用户操作
      return {
        kind: "user_click",
        origin: "user",
        detail: {
          ...(msg.tag !== undefined ? { tag: msg.tag } : {}),
          ...(msg.url !== undefined ? { url: msg.url } : {}),
        },
      };
    case "input":
      if (!msg.trusted) return undefined; // 合成输入不误判用户操作
      if (msg.inputType === "password") return undefined; // D1 密码字段零采集
      return {
        kind: "user_input",
        origin: "user",
        detail: {
          ...(msg.tag !== undefined ? { tag: msg.tag } : {}),
          ...(msg.inputType !== undefined ? { inputType: msg.inputType } : {}),
          ...(msg.url !== undefined ? { url: msg.url } : {}),
        },
      };
    default:
      return undefined;
  }
}

// ── FocusState（前台 tab 状态机） ───────────────────────────────

/**
 * BrowserFocusState —— 前台 tab 状态机（附录 A：document.hasFocus() 上报
 * 为可靠真源，不依赖 targetInfoChanged 激活态）。切 tab 轮换语义：focus 上
 * 报即抢前台（旧前台由其 blur 收尾，blur 不回退他人前台）；destroyed 清账。
 */
export class BrowserFocusState {
  private focused: string | undefined;

  /** hasFocus 上报（true = 抢前台 / false = 该 tab 失焦，仅在它持前台时清）。 */
  noteFocus(targetId: string, hasFocus: boolean): void {
    if (hasFocus) {
      this.focused = targetId;
      return;
    }
    if (this.focused === targetId) this.focused = undefined;
  }

  /** tab 消亡清账（不留幽灵前台）。 */
  noteTargetDestroyed(targetId: string): void {
    if (this.focused === targetId) this.focused = undefined;
  }

  /** 当前前台 tab（无 = undefined）。 */
  focusedTarget(): string | undefined {
    return this.focused;
  }
}
