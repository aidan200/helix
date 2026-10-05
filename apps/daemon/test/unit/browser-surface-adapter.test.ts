/**
 * BrowserSurfaceAdapter 单测（M1 browser adapter 感知）：
 * - CDP 事件 → SurfaceEvent 归一：bindingCalled（观察者回传）/ frameNavigated
 *   （主框架文档级导航）→ Registry.observeDirect（surfaceId=`browser:<targetId>`
 *   两段寻址，设计 §1）；
 * - origin 判定：观察者回传恒 user（isTrusted 过滤在观察者/映射层）；CDP 协议
 *   层事件恒 system（协议层不可归因用户/程序——回声过滤安全侧）；
 * - frameNavigated 携 errorText → kind=error（真缺触发点判定下的 error 生产面）；
 * - 跨域 iframe 不递归（parentId 在场的子框架零事件）；
 * - targetDestroyed → FocusState 前台清账（零 SurfaceEvent——tab 生命周期
 *   与六 kind 无对应，观察面留 M3 SalienceGate）；
 * - 归属缺失（targetId 缺席）丢弃不串扰；
 * - 感知开关 off = 零上报（D1）。
 */
import { describe, expect, test } from "bun:test";
import type { SurfaceEvent } from "@helix/protocol";
import type { ClickAtResult } from "../../src/application/ports/outbound/BrowserPort";
import { SurfaceRegistry } from "../../src/application/surface/SurfaceRegistry";
import { SurfaceActionService } from "../../src/application/surface/SurfaceActionService";
import { BrowserSurfaceAdapter } from "../../src/adapters/driven/cdp/BrowserSurfaceAdapter";
import { OBSERVER_BINDING_NAME } from "../../src/adapters/driven/cdp/browser-observer";

interface Rig {
  adapter: BrowserSurfaceAdapter;
  events: SurfaceEvent[];
  perception: SurfaceEvent[];
  setEnabled: (on: boolean) => void;
}

function makeRig(opts: { enabled?: boolean } = {}): Rig {
  const events: SurfaceEvent[] = [];
  const perception: SurfaceEvent[] = [];
  let enabled = opts.enabled ?? true;
  const registry = new SurfaceRegistry({ sendAction: () => undefined, now: () => 1_700_000_000_000 });
  registry.addObserver((e) => events.push(e));
  // 组合根同款接线（container：Registry 观察者 → 感知 ring 第三源）
  registry.addObserver((e) => perception.push(e));
  const adapter = new BrowserSurfaceAdapter({
    registry,
    awarenessOn: () => enabled,
  });
  return { adapter, events, perception, setEnabled: (on) => (enabled = on) };
}

const focusMsg = (focused: boolean, url = "https://example.com/a"): string =>
  JSON.stringify({ t: focused ? "focus" : "blur", trusted: true, url });

describe("BrowserSurfaceAdapter：bindingCalled → SurfaceEvent", () => {
  test("focus 上报 → activated/user + surfaceId=browser:<targetId>；前台 tab 归 FocusState", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: focusMsg(true), executionContextId: 11 },
      { targetId: "t1" },
    );
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]).toMatchObject({
      kind: "activated",
      origin: "user",
      surfaceId: "browser:t1",
      at: 1_700_000_000_000,
      detail: { url: "https://example.com/a" },
    });
    expect(rig.adapter.focusedTarget()).toBe("t1");
  });

  test("blur → idle/user；前台随之清空", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(true) }, { targetId: "t1" });
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(false) }, { targetId: "t1" });
    expect(rig.events.map((e) => e.kind)).toEqual(["activated", "idle"]);
    expect(rig.adapter.focusedTarget()).toBeUndefined();
  });

  test("切 tab 轮换：t2 focus 抢前台，t1 blur 不清 t2", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(true) }, { targetId: "t1" });
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(true) }, { targetId: "t2" });
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(false) }, { targetId: "t1" });
    expect(rig.adapter.focusedTarget()).toBe("t2");
  });

  test("trusted click → user_click；合成 click（isTrusted=false）→ 零事件", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      {
        name: OBSERVER_BINDING_NAME,
        payload: JSON.stringify({ t: "click", trusted: true, tag: "button", url: "u" }),
      },
      { targetId: "t1" },
    );
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: false, tag: "a" }) },
      { targetId: "t1" },
    );
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]).toMatchObject({ kind: "user_click", origin: "user" });
  });

  test("input → user_input（形状 detail）；nav → navigated/user", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "input", trusted: true, tag: "input", inputType: "text" }) },
      { targetId: "t1" },
    );
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "nav", trusted: true, url: "https://example.com/next" }) },
      { targetId: "t1" },
    );
    expect(rig.events.map((e) => e.kind)).toEqual(["user_input", "navigated"]);
    expect(rig.events.every((e) => e.origin === "user")).toBe(true);
    expect(rig.events[1]?.detail).toEqual({ url: "https://example.com/next" });
  });

  test("其他 binding 名 / 垃圾 payload / 归属缺失（targetId 缺席）→ 零事件（防串扰）", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: "otherBinding", payload: focusMsg(true) }, { targetId: "t1" });
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: "garbage" }, { targetId: "t1" });
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(true) }, {});
    expect(rig.events).toHaveLength(0);
    expect(rig.adapter.focusedTarget()).toBeUndefined();
  });
});

describe("BrowserSurfaceAdapter：CDP 协议事件路由", () => {
  test("frameNavigated 主框架 → navigated/system（协议层不可归因用户/程序）", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent(
      "Page.frameNavigated",
      { frame: { url: "https://example.com/loaded", loaderId: "L1" } },
      { targetId: "t1" },
    );
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]).toMatchObject({
      kind: "navigated",
      origin: "system",
      surfaceId: "browser:t1",
      detail: { url: "https://example.com/loaded" },
    });
  });

  test("frameNavigated 携 errorText → error/system（导航失败上行）", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent(
      "Page.frameNavigated",
      { frame: { url: "https://bad.test/", errorText: "net::ERR_NAME_NOT_RESOLVED" } },
      { targetId: "t1" },
    );
    expect(rig.events[0]).toMatchObject({
      kind: "error",
      origin: "system",
      detail: { url: "https://bad.test/", errorText: "net::ERR_NAME_NOT_RESOLVED" },
    });
  });

  test("子框架（parentId 在场）零事件——跨域 iframe 不递归采集", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent(
      "Page.frameNavigated",
      { frame: { id: "f2", parentId: "f1", url: "https://iframe.test/" } },
      { targetId: "t1" },
    );
    expect(rig.events).toHaveLength(0);
  });

  test("targetDestroyed → 前台清账（零 SurfaceEvent——tab 生命周期无六 kind 对应）", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(true) }, { targetId: "t1" });
    rig.adapter.onCdpEvent("Target.targetDestroyed", { targetId: "t1" }, {});
    expect(rig.adapter.focusedTarget()).toBeUndefined();
    expect(rig.events.map((e) => e.kind)).toEqual(["activated"]); // 无新增
  });

  test("未知 method 静默（事件路由面收下但不产事件——词汇表外不新造）", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent("Target.targetCreated", { targetInfo: { targetId: "t9" } }, {});
    expect(rig.events).toHaveLength(0);
    expect(rig.perception).toHaveLength(0);
  });

  test("感知开关 off = 零上报（D1）：事件全数不上管道", () => {
    const rig = makeRig({ enabled: false });
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(true) }, { targetId: "t1" });
    rig.adapter.onCdpEvent("Page.frameNavigated", { frame: { url: "u" } }, { targetId: "t1" });
    expect(rig.events).toHaveLength(0);
    expect(rig.perception).toHaveLength(0);
    expect(rig.adapter.focusedTarget()).toBeUndefined();
    rig.setEnabled(true);
    rig.adapter.onCdpEvent("Runtime.bindingCalled", { name: OBSERVER_BINDING_NAME, payload: focusMsg(true) }, { targetId: "t1" });
    expect(rig.events).toHaveLength(1); // 开关打开即上报
  });

  test("事件经 Registry 归一后投递感知面（第三源接线在组合根——此处断言投递通路）", () => {
    const rig = makeRig();
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: true, tag: "button" }) },
      { targetId: "t7" },
    );
    expect(rig.perception).toHaveLength(1);
    expect(rig.perception[0]?.surfaceId).toBe("browser:t7");
  });
});

// ── M2：act 执行面（verb 派发到 CDP 栈）+ 回声窗口（CAND-592）────────

/** 可剧本化 browser 操作面（act 派发目标——mock CDP 栈）。 */
interface ActRig {
  adapter: BrowserSurfaceAdapter;
  events: SurfaceEvent[];
  calls: { method: string; args: unknown[] }[];
  /** evalInTab 返回值队列（按调用序消费）。 */
  evalResults: unknown[];
  /** 可控行为覆盖（如挂起 promise 驱动回声窗口）。 */
  override(method: string, fn: (...args: unknown[]) => Promise<unknown>): void;
  setEnabled(on: boolean): void;
}

function makeActRig(opts: { enabled?: boolean; echoWindowMs?: number; actTimeoutMs?: number } = {}): ActRig {
  const events: SurfaceEvent[] = [];
  const calls: { method: string; args: unknown[] }[] = [];
  const evalResults: unknown[] = [];
  let enabled = opts.enabled ?? true;
  const behaviors = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const track =
    <T>(method: string, fallback: (...args: unknown[]) => Promise<T>) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      const override = behaviors.get(method) as ((...args: unknown[]) => Promise<T>) | undefined;
      return override !== undefined ? override(...args) : fallback(...args);
    };
  const registry = new SurfaceRegistry({ sendAction: () => undefined, now: () => 1_700_000_000_000 });
  registry.addObserver((e) => events.push(e));
  const adapter = new BrowserSurfaceAdapter({
    registry,
    awarenessOn: () => enabled,
    browser: {
      navigateTab: track("navigateTab", async () => undefined),
      clickAtInTab: track("clickAtInTab", async () => ({ clicked: true, x: 12, y: 34, tag: "button", text: "提交" })),
      scrollTab: track("scrollTab", async () => ({ value: "scrolled down 500px" })),
      evalInTab: track("evalInTab", async () => evalResults.shift()),
      listTabs: track("listTabs", async () => []),
    },
    ...(opts.echoWindowMs !== undefined ? { echoWindowMs: opts.echoWindowMs } : {}),
    ...(opts.actTimeoutMs !== undefined ? { actTimeoutMs: opts.actTimeoutMs } : {}),
    now: () => 1_700_000_000_000,
  });
  return {
    adapter,
    events,
    calls,
    evalResults,
    override: (method, fn) => behaviors.set(method, fn),
    setEnabled: (on) => (enabled = on),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("BrowserSurfaceAdapter：act 动词派发（M2——经 CDP 栈执行真实操作）", () => {
  test("click/type/navigate/scroll/focus 五动词各走对应执行路径 + 回执 ok", async () => {
    const rig = makeActRig();
    const ctx = { seq: 7, risk: "write" as const, surfaceId: "browser:t1" };

    const click = await rig.adapter.act("click", { selector: "#submit" }, ctx);
    expect(click.ok).toBe(true);
    expect(rig.calls[0]).toMatchObject({ method: "clickAtInTab", args: ["t1", "#submit"] });

    rig.evalResults.push({ typed: true, tag: "INPUT" });
    const typed = await rig.adapter.act("type", { selector: "#name", text: "你好" }, ctx);
    expect(typed.ok).toBe(true);
    expect(rig.calls[1]!.method).toBe("evalInTab");
    expect(rig.calls[1]!.args[0]).toBe("t1");
    expect(String(rig.calls[1]!.args[1])).toContain("#name");
    expect(String(rig.calls[1]!.args[1])).toContain("你好");

    const nav = await rig.adapter.act("navigate", { url: "https://example.com/x" }, { ...ctx, risk: "write" });
    expect(nav.ok).toBe(true);
    expect(rig.calls[2]).toMatchObject({ method: "navigateTab", args: ["t1", "https://example.com/x"] });

    const scroll = await rig.adapter.act("scroll", { y: 500, direction: "down" }, { ...ctx, risk: "read" });
    expect(scroll.ok).toBe(true);
    expect(rig.calls[3]).toMatchObject({ method: "scrollTab", args: ["t1", 500, "down"] });

    rig.evalResults.push({ focused: true, tag: "BUTTON" });
    const focus = await rig.adapter.act("focus", { selector: "#submit" }, { ...ctx, risk: "read" });
    expect(focus.ok).toBe(true);
    expect(rig.calls[4]!.method).toBe("evalInTab");
  });

  test("失败回执：click 未命中 / type 缺参 / 未知动词 → ok=false 携原因", async () => {
    const rig = makeActRig();
    rig.override("clickAtInTab", async () => ({ clicked: false }));
    const miss = await rig.adapter.act("click", { selector: "#gone" }, { seq: 1, risk: "write", surfaceId: "browser:t1" });
    expect(miss.ok).toBe(false);
    expect(miss.detail ?? "").toContain("#gone");

    const badArgs = await rig.adapter.act("type", { selector: "#a" }, { seq: 2, risk: "write", surfaceId: "browser:t1" });
    expect(badArgs.ok).toBe(false);
    expect(badArgs.detail ?? "").toContain("text");

    const unknown = await rig.adapter.act("frobnicate", {}, { seq: 3, risk: "read", surfaceId: "browser:t1" });
    expect(unknown.ok).toBe(false);
    expect(unknown.detail ?? "").toContain("frobnicate");

    const noTarget = await rig.adapter.act("click", { selector: "#a" }, { seq: 4, risk: "write" });
    expect(noTarget.ok).toBe(false);
    expect(noTarget.detail ?? "").toContain("surfaceId");
    expect(rig.calls.filter((c) => c.method === "clickAtInTab")).toHaveLength(1); // 只有未命中那次真的派发
  });

  test("超时回执：CDP 栈挂起 → actTimeoutMs 到点回 ok=false（detail 带超时）", async () => {
    const rig = makeActRig({ actTimeoutMs: 10 });
    rig.override("clickAtInTab", () => new Promise(() => {}));
    const out = await rig.adapter.act("click", { selector: "#slow" }, { seq: 9, risk: "write", surfaceId: "browser:t1" });
    expect(out.ok).toBe(false);
    expect(out.detail ?? "").toContain("超时");
  });
});

describe("BrowserSurfaceAdapter：act 回声窗口（CAND-592——窗口内观察者事件标 steward）", () => {
  test("act 执行期间观察者事件标 origin=steward（不归 user）；收口后恢复 user", async () => {
    const rig = makeActRig();
    let release: () => void = () => {};
    rig.override("clickAtInTab", () => new Promise<void>((r) => (release = r)));
    const pending = rig.adapter.act("click", { selector: "#submit" }, { seq: 1, risk: "write", surfaceId: "browser:t1" });
    await sleep(5);
    // act 期间：真实鼠标点击回声（isTrusted=true 观察者不可分——CAND-592）
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: true, tag: "button" }) },
      { targetId: "t1" },
    );
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]!.origin).toBe("steward"); // 回声标 steward，不误判 user
    expect(rig.events[0]!.surfaceId).toBe("browser:t1");
    release();
    await pending;
    // 窗口关闭后：用户点击照常归 user
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: true, tag: "a" }) },
      { targetId: "t1" },
    );
    expect(rig.events[1]!.origin).toBe("user");
  });

  test("窗口超时兜底关闭：act 未收口也不永锁——TTL 后事件恢复 user 归一", async () => {
    const rig = makeActRig({ echoWindowMs: 10 });
    rig.override("clickAtInTab", () => new Promise(() => {}));
    void rig.adapter.act("click", { selector: "#hang" }, { seq: 1, risk: "write", surfaceId: "browser:t1" });
    await sleep(30); // 超过 TTL（兜底关窗）
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: true, tag: "button" }) },
      { targetId: "t1" },
    );
    expect(rig.events[0]!.origin).toBe("user");
  });

  test("回声窗口只罩目标表面：他 tab 事件不受影响照常 user", async () => {
    const rig = makeActRig();
    let release: () => void = () => {};
    rig.override("clickAtInTab", () => new Promise<void>((r) => (release = r)));
    const pending = rig.adapter.act("click", { selector: "#submit" }, { seq: 1, risk: "write", surfaceId: "browser:t1" });
    await sleep(5);
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: true, tag: "a" }) },
      { targetId: "t2" },
    );
    expect(rig.events[0]!.origin).toBe("user");
    release();
    await pending;
  });
});

describe("BrowserSurfaceAdapter：感知开关 off 与 act 正交（D1 零注入零上报不放松）", () => {
  test("off 时 act 照常执行（动作面不受感知闸限制），但观察者事件零上报", async () => {
    const rig = makeActRig({ enabled: false });
    const out = await rig.adapter.act("click", { selector: "#submit" }, { seq: 1, risk: "write", surfaceId: "browser:t1" });
    expect(out.ok).toBe(true);
    expect(rig.calls.some((c) => c.method === "clickAtInTab")).toBe(true); // 动作面执行
    // 零上报：观察者回传（含回声窗口期）不上管道
    rig.adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: true, tag: "button" }) },
      { targetId: "t1" },
    );
    expect(rig.events).toHaveLength(0);
  });

  test("off 时 list/snapshot/read 读面可用（显式读≠被动采集——D1 管的是观察者注入）", async () => {
    const rig = makeActRig({ enabled: false });
    rig.override("listTabs", async () => [
      { tabId: "t1", ownerId: "main", url: "https://example.com", title: "示例", lastAccessed: 0 },
    ]);
    rig.evalResults.push('{"url":"https://example.com","title":"示例","text":"页面正文"}');
    const listed = await rig.adapter.listSurfaces();
    expect(listed).toEqual([
      {
        surfaceId: "browser:t1",
        kind: "browser",
        label: "示例 — https://example.com",
        capabilities: ["click", "type", "navigate", "scroll", "focus"],
      },
    ]);
    const snap = await rig.adapter.snapshot("browser:t1");
    expect(snap.ok).toBe(true);
    expect(snap.text).toContain("示例");
    expect(snap.text).toContain("页面正文");
  });
});

// ── M2 全链：act → CDP 执行 → seq 回执 → 回声事件 origin=steward 归一 ──

describe("M2 全链：SurfaceActionService → Registry.act → adapter.act → 回执+回声归一", () => {
  test("「帮我点提交」链路：act 派发→执行→settled 回执带 seq→窗口内事件 steward 入 ring→收口后 user 照常", async () => {
    // 组合根同款接线：registry + adapter（本地执行面）+ 表面能力服务（管家执行体）
    const registry = new SurfaceRegistry({ sendAction: () => undefined, now: () => 1_700_000_000_000 });
    const ring: SurfaceEvent[] = [];
    registry.addObserver((e) => ring.push(e));
    let release: () => void = () => {};
    const adapter = new BrowserSurfaceAdapter({
      registry,
      awarenessOn: () => true,
      browser: {
        navigateTab: async () => undefined,
        // 执行挂起（回声窗口保持打开）——真实鼠标点击回声在窗口内到达
        clickAtInTab: () =>
          new Promise<ClickAtResult>((r) => (release = () => r({ clicked: true, x: 1, y: 2, tag: "button", text: "提交" }))),
        scrollTab: async () => ({ value: "" }),
        evalInTab: async () => undefined,
        listTabs: async () => [],
      },
      now: () => 1_700_000_000_000,
    });
    registry.registerLocal(adapter);
    const service = new SurfaceActionService({ registry, browser: adapter });

    const pending = service.act({ surfaceId: "browser:t1", verb: "click", args: { selector: "#submit" }, risk: "write" });
    await sleep(5);
    adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: true, tag: "button" }) },
      { targetId: "t1" },
    );
    expect(ring).toHaveLength(1);
    expect(ring[0]!.origin).toBe("steward"); // 回声不误判 user（CAND-592 落地）
    release();
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.seq).toBe(1);
    expect(result.detail).toContain("成功"); // 执行回执带序列号回流
    // D7-1 销账：pending → completed
    expect(registry.pendingActions()).toHaveLength(0);
    expect(registry.completedActions()[0]!.ok).toBe(true);
    // 收口后 user 照常归一
    adapter.onCdpEvent(
      "Runtime.bindingCalled",
      { name: OBSERVER_BINDING_NAME, payload: JSON.stringify({ t: "click", trusted: true, tag: "a" }) },
      { targetId: "t1" },
    );
    expect(ring[1]!.origin).toBe("user");
  });
});
