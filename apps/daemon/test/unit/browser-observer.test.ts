/**
 * 页面观察者脚本单测（M1 browser adapter 感知；设计附录 A）：
 * 1. 消息解析：bindingCalled payload JSON → ObserverMessage（形状守卫）；
 * 2. kind 映射：观察者事件 → 六 kind 封闭词汇表（focus→activated / blur→idle
 *    / nav→navigated / click→user_click / input→user_input）+ origin 恒 user；
 * 3. isTrusted 过滤：合成事件（isTrusted=false）零上报——agent JS 层合成点击
 *    不误判为用户操作；
 * 4. 隐私（D1）：input 只记形状不记内容（零 value）；密码字段零采集；
 * 5. FocusState 状态机：hasFocus 上报 → 前台 tab 轮换（切 tab = blur 旧 +
 *    focus 新）；
 * 6. 观察者脚本内限速：事件风暴（同类型突发）合并为一条；iframe 不递归采集。
 *
 * 脚本执行面：OBSERVER_SCRIPT 以 new Function 注入 fake window/document/
 * history/location/Date（Date 形参遮蔽全局——限速窗口确定性步进），真实
 * 事件派发语义（isTrusted/target 可控）。
 */
import { describe, expect, test } from "bun:test";
import {
  BrowserFocusState,
  OBSERVER_BINDING_NAME,
  OBSERVER_SCRIPT,
  mapObserverMessage,
  parseObserverMessage,
} from "../../src/adapters/driven/cdp/browser-observer";

// ── 消息解析 ───────────────────────────────────────────────────

describe("parseObserverMessage（bindingCalled payload 解析）", () => {
  test("合法 focus 消息 → { kind: 'focus', trusted: true, url }", () => {
    const msg = parseObserverMessage(JSON.stringify({ t: "focus", trusted: true, url: "https://example.com/a" }));
    expect(msg).toMatchObject({ kind: "focus", trusted: true, url: "https://example.com/a" });
    expect(msg?.tag).toBeUndefined();
    expect(msg?.inputType).toBeUndefined();
  });

  test("合法 input 消息携带形状字段（tag/inputType）", () => {
    const msg = parseObserverMessage(
      JSON.stringify({ t: "input", trusted: true, tag: "input", inputType: "text", url: "https://example.com/form" }),
    );
    expect(msg?.kind).toBe("input");
    expect(msg?.tag).toBe("input");
    expect(msg?.inputType).toBe("text");
  });

  test("垃圾输入（非 JSON / 非对象 / 未知 t / t 非字符串）→ undefined", () => {
    expect(parseObserverMessage("not-json")).toBeUndefined();
    expect(parseObserverMessage("42")).toBeUndefined();
    expect(parseObserverMessage(JSON.stringify({ t: "screenshot" }))).toBeUndefined();
    expect(parseObserverMessage(JSON.stringify({ t: 7 }))).toBeUndefined();
    expect(parseObserverMessage("")).toBeUndefined();
  });

  test("trusted 缺席按 false 处理（保守——不放行未知来源）", () => {
    const msg = parseObserverMessage(JSON.stringify({ t: "click", tag: "button" }));
    expect(msg?.trusted).toBe(false);
  });
});

// ── kind 映射（六 kind 封闭词汇表 + origin） ─────────────────────

describe("mapObserverMessage（→ 六 kind；origin 恒 user）", () => {
  test("focus → activated；blur → idle；nav → navigated", () => {
    expect(mapObserverMessage({ kind: "focus", trusted: true, url: "u" })?.kind).toBe("activated");
    expect(mapObserverMessage({ kind: "blur", trusted: true, url: "u" })?.kind).toBe("idle");
    expect(mapObserverMessage({ kind: "nav", trusted: true, url: "u" })?.kind).toBe("navigated");
  });

  test("origin 恒 user（观察者回传 = 用户活动面）", () => {
    for (const kind of ["focus", "blur", "nav", "click", "input"] as const) {
      expect(mapObserverMessage({ kind, trusted: true, url: "u" })?.origin).toBe("user");
    }
  });

  test("click trusted → user_click（detail 只带 tag/url 形状）", () => {
    const mapped = mapObserverMessage({ kind: "click", trusted: true, tag: "button", url: "https://x.test/" });
    expect(mapped?.kind).toBe("user_click");
    expect(mapped?.detail).toEqual({ tag: "button", url: "https://x.test/" });
  });

  test("isTrusted=false 合成 click/input → 拒收（agent JS 层合成不误判用户操作）", () => {
    expect(mapObserverMessage({ kind: "click", trusted: false, tag: "button" })).toBeUndefined();
    expect(mapObserverMessage({ kind: "input", trusted: false, tag: "input", inputType: "text" })).toBeUndefined();
  });

  test("input trusted → user_input（只记形状：tag/inputType，零 value）", () => {
    const mapped = mapObserverMessage({ kind: "input", trusted: true, tag: "input", inputType: "text", url: "u" });
    expect(mapped?.kind).toBe("user_input");
    expect(mapped?.detail).toEqual({ tag: "input", inputType: "text", url: "u" });
    expect(JSON.stringify(mapped)).not.toContain("value");
  });

  test("密码字段零采集（D1）：inputType=password → 拒收", () => {
    expect(mapObserverMessage({ kind: "input", trusted: true, tag: "input", inputType: "password" })).toBeUndefined();
  });
});

// ── FocusState 状态机 ──────────────────────────────────────────

describe("BrowserFocusState（hasFocus 上报 → 前台 tab 轮换）", () => {
  test("focus 上报即前台；同 tab 重复 focus 幂等", () => {
    const s = new BrowserFocusState();
    s.noteFocus("t1", true);
    s.noteFocus("t1", true);
    expect(s.focusedTarget()).toBe("t1");
  });

  test("切 tab 轮换：t2 focus → 前台 t2（t1 自然失焦由其 blur 收尾）", () => {
    const s = new BrowserFocusState();
    s.noteFocus("t1", true);
    s.noteFocus("t2", true);
    expect(s.focusedTarget()).toBe("t2");
    s.noteFocus("t1", false);
    expect(s.focusedTarget()).toBe("t2"); // 非前台 tab 的 blur 不动前台
    s.noteFocus("t2", false);
    expect(s.focusedTarget()).toBeUndefined();
  });

  test("destroyed 前台 tab → 前台清空（不留幽灵前台）", () => {
    const s = new BrowserFocusState();
    s.noteFocus("t1", true);
    s.noteTargetDestroyed("t1");
    expect(s.focusedTarget()).toBeUndefined();
  });

  test("非前台 tab 的 blur 不清前台", () => {
    const s = new BrowserFocusState();
    s.noteFocus("t2", true);
    s.noteFocus("t1", false);
    expect(s.focusedTarget()).toBe("t2");
  });
});

// ── 观察者脚本执行面（fake DOM 环境） ────────────────────────────

interface FakeEventTarget {
  addEventListener(type: string, fn: (e: any) => void): void;
  dispatch(type: string, evt: any): void;
  listenerCount(type: string): number;
}

function fakeEventTarget(): FakeEventTarget {
  const listeners = new Map<string, Array<(e: any) => void>>();
  return {
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatch(type, evt) {
      for (const fn of listeners.get(type) ?? []) fn(evt);
    },
    listenerCount(type) {
      return listeners.get(type)?.length ?? 0;
    },
  };
}

interface ScriptRig {
  window: FakeEventTarget & Record<string, any>;
  document: FakeEventTarget & Record<string, any>;
  history: { pushState: (...args: any[]) => void; replaceState: (...args: any[]) => void; nativeCalls: number };
  location: { href: string };
  clock: { now: () => number; advance: (ms: number) => void };
  bindingCalls: any[];
}

/** 以 fake 环境执行观察者脚本（Date 形参遮蔽全局——限速窗确定性）。 */
function runObserverScript(opts: { focused?: boolean; topFrame?: boolean } = {}): ScriptRig {
  const bindingCalls: any[] = [];
  const windowObj = fakeEventTarget() as FakeEventTarget & Record<string, any>;
  const documentObj = fakeEventTarget() as FakeEventTarget & Record<string, any>;
  windowObj[OBSERVER_BINDING_NAME] = (raw: string) => bindingCalls.push(JSON.parse(raw));
  windowObj.top = opts.topFrame === false ? {} : windowObj;
  documentObj.hasFocus = () => opts.focused === true;
  const historyObj = {
    nativeCalls: 0,
    pushState: function (this: any, ...args: any[]): void {
      historyObj.nativeCalls += 1;
    },
    replaceState: function (this: any, ...args: any[]): void {
      historyObj.nativeCalls += 1;
    },
  };
  const locationObj = { href: "https://example.com/page" };
  let t = 1_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const fn = new Function("window", "document", "history", "location", "Date", OBSERVER_SCRIPT);
  fn(windowObj, documentObj, historyObj, locationObj, clock);
  return { window: windowObj, document: documentObj, history: historyObj, location: locationObj, clock, bindingCalls };
}

describe("OBSERVER_SCRIPT（fake DOM 执行）", () => {
  test("首报：页面亮相互交代现态——document.hasFocus()=true 报 focus；false 静默", () => {
    const focused = runObserverScript({ focused: true });
    expect(focused.bindingCalls).toHaveLength(1);
    expect(focused.bindingCalls[0]).toMatchObject({ t: "focus", trusted: true, url: "https://example.com/page" });

    const blurred = runObserverScript({ focused: false });
    expect(blurred.bindingCalls).toHaveLength(0);
  });

  test("trusted click 上报；合成 click（isTrusted=false）零上报", () => {
    const rig = runObserverScript();
    rig.document.dispatch("click", { isTrusted: true, target: { tagName: "BUTTON" } });
    rig.document.dispatch("click", { isTrusted: false, target: { tagName: "A" } });
    expect(rig.bindingCalls).toHaveLength(1);
    expect(rig.bindingCalls[0]).toMatchObject({ t: "click", trusted: true, tag: "button" });
  });

  test("事件风暴限速：同类型突发合并为一条；窗口过后放行下一条", () => {
    const rig = runObserverScript();
    for (let i = 0; i < 5; i++) {
      rig.document.dispatch("click", { isTrusted: true, target: { tagName: "DIV" } });
    }
    expect(rig.bindingCalls.filter((m) => m.t === "click")).toHaveLength(1);
    rig.clock.advance(301);
    rig.document.dispatch("click", { isTrusted: true, target: { tagName: "DIV" } });
    expect(rig.bindingCalls.filter((m) => m.t === "click")).toHaveLength(2);
  });

  test("input：只记形状零内容；密码字段零采集", () => {
    const rig = runObserverScript();
    rig.document.dispatch("input", { isTrusted: true, target: { tagName: "INPUT", type: "text", value: "机密草稿" } });
    rig.clock.advance(301);
    rig.document.dispatch("input", { isTrusted: true, target: { tagName: "INPUT", type: "password", value: "p@ss" } });
    const inputs = rig.bindingCalls.filter((m) => m.t === "input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ t: "input", tag: "input", inputType: "text" });
    expect(JSON.stringify(inputs[0])).not.toContain("机密草稿");
    expect(JSON.stringify(rig.bindingCalls)).not.toContain("p@ss");
  });

  test("SPA 内导航自监听 history：pushState 触发 nav 上报（原生调用不破坏）", () => {
    const rig = runObserverScript();
    // 脚本已包装 history.pushState——直接调用包装后的（页面真实用法）
    rig.history.pushState({}, "", "/next");
    expect(rig.bindingCalls.filter((m) => m.t === "nav")).toHaveLength(1);
    expect(rig.bindingCalls.find((m) => m.t === "nav")?.url).toBe("https://example.com/page");
    expect(rig.history.nativeCalls).toBe(1); // 原生 pushState 仍被调用（不破坏页面）
  });

  test("popstate/hashchange 也报 nav", () => {
    const rig = runObserverScript();
    rig.window.dispatch("popstate", { isTrusted: true });
    rig.window.dispatch("hashchange", { isTrusted: true });
    expect(rig.bindingCalls.filter((m) => m.t === "nav").length).toBeGreaterThanOrEqual(1);
  });

  test("focus/blur（trusted）上报；untrusted 不报", () => {
    const rig = runObserverScript();
    rig.window.dispatch("focus", { isTrusted: true });
    rig.window.dispatch("blur", { isTrusted: true });
    rig.window.dispatch("focus", { isTrusted: false });
    const kinds = rig.bindingCalls.map((m) => m.t);
    expect(kinds.filter((t) => t === "focus")).toHaveLength(1);
    expect(kinds.filter((t) => t === "blur")).toHaveLength(1);
  });

  test("iframe 不递归采集（window.top !== window → 零监听零上报）", () => {
    const rig = runObserverScript({ focused: true, topFrame: false });
    expect(rig.bindingCalls).toHaveLength(0);
    rig.document.dispatch("click", { isTrusted: true, target: { tagName: "BUTTON" } });
    expect(rig.bindingCalls).toHaveLength(0);
  });
});
