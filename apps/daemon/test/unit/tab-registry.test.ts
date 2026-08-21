import { describe, expect, test } from "bun:test";
import { TabRegistry } from "../../src/adapters/driven/cdp/TabRegistry";

/**
 * T2 TabRegistry unit（fake clock）：managedTabs owner 维度记录 + touch +
 * idle sweep 到期判定 + owner 回收清单。纯簿记——closeTarget 的 CDP 发送
 * 归 CdpConnectionManager（sweep 回调接缝），本测试不碰 WS。
 */

/** 可推进假时钟。 */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("TabRegistry 簿记", () => {
  test("add/get/list：ownerId/url/title/lastAccessed 全字段", () => {
    const clock = fakeClock();
    const reg = new TabRegistry({ now: clock.now });
    reg.add("tab-1", "agent-1", "https://a.example");
    reg.add("tab-2", "agent-2", "https://b.example");

    expect(reg.get("tab-1")).toEqual({
      ownerId: "agent-1",
      url: "https://a.example",
      title: "",
      lastAccessed: 1_000_000,
    });
    expect(reg.list().map((t) => t.tabId)).toEqual(["tab-1", "tab-2"]);
    expect(reg.list()[0]).toEqual({
      tabId: "tab-1",
      ownerId: "agent-1",
      url: "https://a.example",
      title: "",
      lastAccessed: 1_000_000,
    });
  });

  test("touch 刷新 lastAccessed；update 改 url/title（attach 事件回写）", () => {
    const clock = fakeClock();
    const reg = new TabRegistry({ now: clock.now });
    reg.add("tab-1", "agent-1");
    clock.advance(5_000);
    reg.touch("tab-1");
    expect(reg.get("tab-1")!.lastAccessed).toBe(1_005_000);

    reg.update("tab-1", { url: "https://a.example/2", title: "标题" });
    expect(reg.get("tab-1")).toMatchObject({ url: "https://a.example/2", title: "标题" });
    // 未管理 tab 的 touch/update 是 no-op（不崩）
    reg.touch("ghost");
    reg.update("ghost", { url: "x" });
    expect(reg.get("ghost")).toBeUndefined();
  });

  test("idsByOwner：owner 维度批量清单（reclaimOwner 输入）", () => {
    const reg = new TabRegistry({ now: fakeClock().now });
    reg.add("t1", "agent-1");
    reg.add("t2", "agent-1");
    reg.add("t3", "agent-2");
    expect(reg.idsByOwner("agent-1")).toEqual(["t1", "t2"]);
    expect(reg.idsByOwner("nobody")).toEqual([]);
  });

  test("remove/clear：remove 返回是否命中；clear 返回全部移除 id", () => {
    const reg = new TabRegistry({ now: fakeClock().now });
    reg.add("t1", "a");
    reg.add("t2", "b");
    expect(reg.remove("t1")).toBe(true);
    expect(reg.remove("t1")).toBe(false);
    expect(reg.clear().sort()).toEqual(["t2"]);
    expect(reg.list()).toEqual([]);
  });
});

describe("TabRegistry idle sweep（fake clock）", () => {
  test("idleTabIds：闲置超阈值的 tab 入选，活跃/未超期不选", () => {
    const clock = fakeClock();
    const reg = new TabRegistry({ now: clock.now, idleTimeoutMs: 15 * 60_000 });
    reg.add("old", "agent-1");
    clock.advance(10 * 60_000); // t+10min：add fresh
    reg.add("fresh", "agent-1");
    clock.advance(10 * 60_000); // t+20min：old 闲置 20min > 15min；fresh 10min < 15min

    expect(reg.idleTabIds()).toEqual(["old"]);
  });

  test("sweep：到期 tab id 交给 onIdle 回调（恰好一次，无到期不触发）", () => {
    const clock = fakeClock();
    const reg = new TabRegistry({ now: clock.now, idleTimeoutMs: 1_000 });
    const swept: string[][] = [];
    reg.startSweep((ids) => swept.push(ids));
    reg.add("t1", "agent-1");

    reg.sweep(); // 未到期
    expect(swept).toEqual([]);

    clock.advance(2_000);
    reg.sweep(); // 到期
    expect(swept).toEqual([["t1"]]);

    // 回调负责 remove 后不再重复报
    reg.remove("t1");
    reg.sweep();
    expect(swept).toEqual([["t1"]]);
    reg.stopSweep();
  });
});
