/**
 * SurfaceRegistry 单测（M0 表面协议地基批；设计稿 §1/D3/D7/D8）：
 * - 注册/注销：幂等重注册覆盖 descriptor；注销后 act 零目标；
 * - act 路由：verb→adapter（capabilities 判据）——有能力的表面收到
 *   surface.action 帧，无能力的零打扰；seq 单调（D7-1 原子性）；
 * - 未注册 verb 拒绝：无任何表面声明该动词能力 → delivered 0 + reason；
 * - 执行回执：receipt 按 seq 销账 pending → completed；未知 seq 静默 false；
 * - observe 归一：surfaceId 盖章（`shell:<connId>:<page>`）+ kind/origin
 *   词汇表校验拒收 + 未注册连接拒收；
 * - 兼容期双发：verb=navigate 镜像旧 steward.navigate 出口（M1 删除点），
 *   其他 verb 零镜像。
 */
import { describe, expect, test } from "bun:test";
import {
  surfaceIdOf,
  type SurfaceActionPayload,
  type SurfaceDescriptor,
  type SurfaceEvent,
} from "@helix/protocol";
import { SurfaceRegistry } from "../../src/application/surface/SurfaceRegistry";

interface Rig {
  registry: SurfaceRegistry;
  sent: { key: unknown; action: SurfaceActionPayload }[];
  legacyNavigates: { sessionId: string }[];
  observed: SurfaceEvent[];
}

function makeRig(): Rig {
  const sent: Rig["sent"] = [];
  const legacyNavigates: Rig["legacyNavigates"] = [];
  const observed: SurfaceEvent[] = [];
  const registry = new SurfaceRegistry({
    sendAction: (key, action) => sent.push({ key, action }),
    emitLegacyNavigate: (args) => legacyNavigates.push(args),
    now: () => 1_700_000_000_000,
  });
  registry.addObserver((e) => observed.push(e));
  return { registry, sent, legacyNavigates, observed };
}

const SHELL_DESC: SurfaceDescriptor = { kind: "shell", capabilities: ["navigate"] };
const BROWSER_DESC: SurfaceDescriptor = { kind: "browser", capabilities: ["navigate", "click"] };

describe("SurfaceRegistry：注册/注销", () => {
  test("register 幂等：同 key 重注册覆盖 descriptor（能力面收窄可见）", () => {
    const rig = makeRig();
    const s = rig.registry.register("conn-a", SHELL_DESC);
    expect(s.namespace).toBe("shell");
    expect(s.connId).toBe("c1");
    // 重注册：capabilities 收窄为只读面
    const s2 = rig.registry.register("conn-a", { kind: "shell", capabilities: [] });
    expect(s2.connId).toBe("c1"); // 同连接身份保持
    const out = rig.registry.act("navigate", { sessionId: "s1" }, { risk: "write" });
    expect(out.delivered).toBe(0); // 能力已收窄——无目标
    // 新连接注册拿新 connId
    const s3 = rig.registry.register("conn-b", SHELL_DESC);
    expect(s3.connId).toBe("c2");
  });

  test("unregister 后 act 零目标；未注册 key 的 observe 拒收", () => {
    const rig = makeRig();
    rig.registry.register("conn-a", SHELL_DESC);
    rig.registry.unregister("conn-a");
    expect(rig.registry.act("navigate", { sessionId: "s1" }, { risk: "write" }).delivered).toBe(0);
    expect(rig.registry.observe("conn-a", { kind: "navigated", origin: "user", page: "chat" })).toBeNull();
    expect(rig.registry.unregister("conn-a")).toBeUndefined(); // 幂等
  });
});

describe("SurfaceRegistry：act 路由（verb→adapter）", () => {
  test("有能力表面收到 surface.action；无能力表面零打扰；seq 单调", () => {
    const rig = makeRig();
    rig.registry.register("conn-shell", SHELL_DESC);
    rig.registry.register("conn-browser", BROWSER_DESC);
    const out = rig.registry.act("navigate", { sessionId: "s1" }, { risk: "write" });
    expect(out.delivered).toBe(2);
    expect(out.targets.length).toBe(2);
    expect(out.seq).toBe(1);
    expect(rig.sent.map((x) => x.action.verb)).toEqual(["navigate", "navigate"]);
    for (const x of rig.sent) {
      expect(x.action.seq).toBe(1);
      expect(x.action.risk).toBe("write");
      expect(x.action.origin).toBe("steward"); // D7-2 回声过滤预备字段
      expect(x.action.surfaceIds?.[0] ?? "").toMatch(/^(shell|browser):c\d+$/);
    }
    // seq 单调（第二次动作 seq=2）
    expect(rig.registry.act("navigate", { sessionId: "s2" }, { risk: "write" }).seq).toBe(2);
  });

  test("能力判据按 verb 精确匹配：click 只有 browser 声明 → 单目标", () => {
    const rig = makeRig();
    rig.registry.register("conn-shell", SHELL_DESC);
    rig.registry.register("conn-browser", BROWSER_DESC);
    const out = rig.registry.act("click", { selector: "#submit" }, { risk: "write" });
    expect(out.delivered).toBe(1);
    expect(rig.sent.length).toBe(1);
    expect(rig.sent[0]!.action.surfaceIds?.[0]?.startsWith("browser:")).toBe(true);
  });

  test("未注册 verb 拒绝：delivered 0 + reason（M0 无动词注册校验面——M2）", () => {
    const rig = makeRig();
    rig.registry.register("conn-shell", SHELL_DESC);
    const out = rig.registry.act("scroll_into_view", {}, { risk: "read" });
    expect(out.delivered).toBe(0);
    expect(out.targets).toEqual([]);
    expect(out.reason ?? "").toContain("scroll_into_view");
  });

  test("动作经风险档透传（D3 risk 挂动作）", () => {
    const rig = makeRig();
    rig.registry.register("conn-a", BROWSER_DESC);
    rig.registry.act("click", {}, { risk: "destructive" });
    expect(rig.sent[0]!.action.risk).toBe("destructive");
  });
});

describe("SurfaceRegistry：执行回执（D7-1 原子性）", () => {
  test("receipt 按 seq 销账 pending → completed；未知 seq false", () => {
    const rig = makeRig();
    rig.registry.register("conn-a", SHELL_DESC);
    const out = rig.registry.act("navigate", { sessionId: "s1" }, { risk: "write" });
    expect(rig.registry.pendingActions().length).toBe(1);
    expect(rig.registry.pendingActions()[0]!.seq).toBe(out.seq);
    expect(rig.registry.receipt("conn-a", out.seq, true, "已呈现")).toBe(true);
    expect(rig.registry.pendingActions().length).toBe(0);
    const done = rig.registry.completedActions();
    expect(done.length).toBe(1);
    expect(done[0]!.ok).toBe(true);
    expect(done[0]!.detail).toBe("已呈现");
    // 重复回执（同 seq 二次）→ false（已销账）
    expect(rig.registry.receipt("conn-a", out.seq, true)).toBe(false);
    // 未知 seq → false（迟到回执无害）
    expect(rig.registry.receipt("conn-a", 999, false)).toBe(false);
  });

  test("回执按 seq 对账（跨表面不串）", () => {
    const rig = makeRig();
    rig.registry.register("conn-a", BROWSER_DESC);
    rig.registry.register("conn-b", BROWSER_DESC);
    const o1 = rig.registry.act("click", {}, { risk: "write" }); // seq 1（双目标）
    const o2 = rig.registry.act("click", {}, { risk: "write" }); // seq 2
    expect(o2.seq).toBe(o1.seq + 1);
    expect(rig.registry.receipt("conn-a", o1.seq, true)).toBe(true);
    expect(rig.registry.pendingActions().length).toBe(1); // seq2 仍 pending
  });
});

describe("SurfaceRegistry：observe 归一入口", () => {
  test("盖章 surfaceId（shell:<connId>:<page>）+ at + 投递观察者", () => {
    const rig = makeRig();
    const s = rig.registry.register("conn-a", SHELL_DESC);
    const ev = rig.registry.observe("conn-a", {
      kind: "navigated",
      origin: "user",
      page: "tasks",
      detail: { from: "chat" },
    });
    expect(ev).not.toBeNull();
    expect(ev!.surfaceId).toBe(surfaceIdOf("shell", s.connId, "tasks"));
    expect(ev!.kind).toBe("navigated");
    expect(ev!.at).toBe(1_700_000_000_000);
    expect(ev!.detail).toEqual({ from: "chat" });
    expect(rig.observed.length).toBe(1);
    expect(rig.observed[0]!.surfaceId).toBe(ev!.surfaceId);
  });

  test("词汇表外 kind/origin 拒收（D2 封闭）", () => {
    const rig = makeRig();
    rig.registry.register("conn-a", SHELL_DESC);
    // 词汇表外字面量绕过编译期窄化（运行时守护面——恶意/旧客户端帧）
    const badKind = { kind: "scrolled", origin: "user", page: "chat" } as unknown as Parameters<
      SurfaceRegistry["observe"]
    >[1];
    const badOrigin = { kind: "navigated", origin: "bot", page: "chat" } as unknown as Parameters<
      SurfaceRegistry["observe"]
    >[1];
    expect(rig.registry.observe("conn-a", badKind)).toBeNull();
    expect(rig.registry.observe("conn-a", badOrigin)).toBeNull();
    expect(rig.registry.observe("conn-a", { kind: "navigated", origin: "user", page: "" })).toBeNull();
    expect(rig.observed.length).toBe(0);
  });
});

describe("SurfaceRegistry：兼容期双发（D8 ③——M1 删除点）", () => {
  test("verb=navigate 镜像旧 steward.navigate；其他 verb 零镜像", () => {
    const rig = makeRig();
    rig.registry.register("conn-a", BROWSER_DESC);
    rig.registry.act("navigate", { sessionId: "s1" }, { risk: "write" });
    expect(rig.legacyNavigates).toEqual([{ sessionId: "s1" }]);
    rig.registry.act("click", {}, { risk: "write" });
    expect(rig.legacyNavigates.length).toBe(1); // click 不镜像
  });

  test("零目标 navigate 仍镜像（旧帧广播面与路由面正交——兼容期行为保持）", () => {
    const rig = makeRig();
    rig.registry.act("navigate", { sessionId: "s1" }, { risk: "write" });
    expect(rig.sent.length).toBe(0);
    expect(rig.legacyNavigates).toEqual([{ sessionId: "s1" }]);
  });
});
