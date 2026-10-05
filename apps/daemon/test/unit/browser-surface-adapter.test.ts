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
import { SurfaceRegistry } from "../../src/application/surface/SurfaceRegistry";
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
