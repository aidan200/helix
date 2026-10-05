/**
 * 表面协议地基批（M0，设计稿 docs/temp/steward-browser-awareness-design.md
 * §1/D2/D3/D8）：Surface 三原语 + 词汇表封闭性 + 指令帧唯一性契约。
 *
 * - 三原语：SurfaceEvent（表面→daemon 统一事件）/ SurfaceAction（管家→表面
 *   动作）/ SurfaceDescriptor（表面自述）——类型守卫可运行时判别；
 * - kind/origin/risk 词汇表封闭（D2/D3）：跨表面通用，新表面不新增词汇；
 * - 指令帧唯一性（D8 通道治理）：管家→页面的指令帧注册面恒一种
 *   （surface.action）；steward.navigate 旧帧标 deprecated（兼容期双发，
 *   M1 前检查点删除）。
 */
import { describe, expect, test } from "bun:test";
import {
  COMMAND_TYPES,
  DEPRECATED_EVENT_TYPES,
  EVENT_CHANNELS,
  EVENT_TYPES,
  SURFACE_EVENT_KINDS,
  SURFACE_EVENT_ORIGINS,
  SURFACE_INSTRUCTION_FRAME_TYPES,
  SURFACE_NAMESPACE_KINDS,
  SURFACE_RISK_LEVELS,
  SURFACE_VERB_CAPABILITIES,
  SURFACE_VERB_RISKS,
  SURFACE_VERBS,
  isSurfaceDescriptor,
  isSurfaceEventKind,
  isSurfaceEventOrigin,
  isSurfaceNamespaceKind,
  isSurfaceRisk,
  isSurfaceVerb,
  isSurfaceVerbAllowed,
  surfaceIdOf,
  surfaceVerbRisk,
} from "../../src/index";
import type {
  SurfaceActionEvent,
  SurfaceActionPayload,
  SurfaceDescriptor,
  SurfaceEvent,
  SurfaceEventCommand,
  SurfaceEventKind,
  SurfaceEventOrigin,
  SurfaceEventUplinkPayload,
  SurfaceRegisteredEvent,
  SurfaceRegisterCommand,
  SurfaceRisk,
  SurfaceUnregisterCommand,
  SurfaceActionResultCommand,
  SurfaceVerb,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand, familyOf, summarizeEvent } from "./samples/helpers";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败）──

// SurfaceEvent 原语：kind/origin/surfaceId 必填；at/detail 可选
type _EvKind = Expect<Equal<SurfaceEvent["kind"], SurfaceEventKind>>;
type _EvOrigin = Expect<Equal<SurfaceEvent["origin"], SurfaceEventOrigin>>;
type _EvSurfaceId = Expect<Equal<SurfaceEvent["surfaceId"], string>>;

// 上行载荷（surface.event 命令）：page 必填（surfaceId 由 daemon 盖章）
type _UplinkPage = Expect<Equal<SurfaceEventUplinkPayload["page"], string>>;

// SurfaceAction 原语：verb/args/risk/seq 必填
type _ActVerb = Expect<Equal<SurfaceActionPayload["verb"], string>>;
type _ActRisk = Expect<Equal<SurfaceActionPayload["risk"], SurfaceRisk>>;
type _ActSeq = Expect<Equal<SurfaceActionPayload["seq"], number>>;

// SurfaceDescriptor 原语：capabilities 动词清单必填
type _DescCaps = Expect<Equal<SurfaceDescriptor["capabilities"], readonly string[]>>;

// 指令帧：channel "surface" 族恰两帧（action 指令 + registered 回执）
type _SurfaceFamily = Expect<
  Equal<TypeOfChannel<"surface">, "surface.action" | "surface.registered">
>;

// ── 词汇表封闭性（D2/D3：跨表面通用，封闭不可扩）──

describe("surface 词汇表封闭（D2 kind/origin + D3 risk）", () => {
  test("kind 词汇表恰六值（activated/navigated/user_click/user_input/idle/error）", () => {
    expect([...SURFACE_EVENT_KINDS]).toEqual([
      "activated",
      "navigated",
      "user_click",
      "user_input",
      "idle",
      "error",
    ]);
    expect(new Set(SURFACE_EVENT_KINDS).size).toBe(SURFACE_EVENT_KINDS.length); // 无重复
  });

  test("origin 词汇表恰三值（user/steward/system——回声过滤 D7-2 基础）", () => {
    expect([...SURFACE_EVENT_ORIGINS]).toEqual(["user", "steward", "system"]);
  });

  test("risk 词汇表恰三档（read/write/destructive——D3 risk 挂动作不挂宿主）", () => {
    expect([...SURFACE_RISK_LEVELS]).toEqual(["read", "write", "destructive"]);
  });

  test("surfaceId 命名空间词汇表（shell/browser/cli——§1 Registry 寻址）", () => {
    expect([...SURFACE_NAMESPACE_KINDS]).toEqual(["shell", "browser", "cli"]);
    expect(surfaceIdOf("shell", "c1", "chat")).toBe("shell:c1:chat");
    expect(surfaceIdOf("browser", "t9", "page")).toBe("browser:t9:page");
  });
});

// ── 类型守卫（三原语运行时判别面）──

describe("surface 类型守卫", () => {
  test("isSurfaceEventKind / isSurfaceEventOrigin / isSurfaceRisk / isSurfaceNamespaceKind", () => {
    expect(isSurfaceEventKind("navigated")).toBe(true);
    expect(isSurfaceEventKind("Navigated")).toBe(false);
    expect(isSurfaceEventKind("clicked")).toBe(false); // 词汇表外
    expect(isSurfaceEventKind(undefined)).toBe(false);
    expect(isSurfaceEventOrigin("steward")).toBe(true);
    expect(isSurfaceEventOrigin("agent")).toBe(false);
    expect(isSurfaceEventOrigin(1)).toBe(false);
    expect(isSurfaceRisk("write")).toBe(true);
    expect(isSurfaceRisk("dangerous")).toBe(false);
    expect(isSurfaceNamespaceKind("shell")).toBe(true);
    expect(isSurfaceNamespaceKind("web")).toBe(false);
  });

  test("isSurfaceDescriptor：kind ∈ 命名空间 + capabilities 非空动词清单", () => {
    expect(isSurfaceDescriptor({ kind: "shell", capabilities: ["navigate"] })).toBe(true);
    expect(
      isSurfaceDescriptor({ kind: "shell", capabilities: ["navigate"], policy: { events: ["activated"] } }),
    ).toBe(true);
    expect(isSurfaceDescriptor({ kind: "web", capabilities: ["navigate"] })).toBe(false); // 命名空间外
    expect(isSurfaceDescriptor({ kind: "shell", capabilities: [] })).toBe(false); // 空能力清单
    expect(isSurfaceDescriptor({ kind: "shell" })).toBe(false); // 缺 capabilities
    expect(isSurfaceDescriptor(null)).toBe(false);
    expect(isSurfaceDescriptor("shell")).toBe(false);
  });
});

// ── 指令帧唯一性（D8：新指令帧注册面只认 surface.action）──

describe("指令帧唯一性（D8 通道治理）", () => {
  test("SURFACE_INSTRUCTION_FRAME_TYPES 恰一种：surface.action", () => {
    expect([...SURFACE_INSTRUCTION_FRAME_TYPES]).toEqual(["surface.action"]);
  });

  test("指令帧注册面全部成员已在 EVENT_TYPES/EVENT_CHANNELS 登记", () => {
    for (const t of SURFACE_INSTRUCTION_FRAME_TYPES) {
      expect((EVENT_TYPES as readonly string[]).includes(t), `未登记：${t}`).toBe(true);
      expect(EVENT_CHANNELS[t]).toBe("surface");
    }
  });

  test("navigate 旧帧标 deprecated：DEPRECATED_EVENT_TYPES 恰含 steward.navigate 且与指令帧注册面不相交", () => {
    expect([...DEPRECATED_EVENT_TYPES]).toEqual(["steward.navigate"]);
    for (const t of DEPRECATED_EVENT_TYPES) {
      expect((SURFACE_INSTRUCTION_FRAME_TYPES as readonly string[]).includes(t)).toBe(false);
      expect((EVENT_TYPES as readonly string[]).includes(t)).toBe(true); // 兼容期仍在册（M1 前删除）
    }
  });
});

// ── 动词封闭词汇表（M2 动词注册校验面，D4）────────────────────

describe("surface 动词封闭词汇表（D4 注册校验面——防私造动词/跨表面同义不同名）", () => {
  test("动词词汇表恰五值（click/type/navigate/scroll/focus）且无重复", () => {
    expect([...SURFACE_VERBS]).toEqual(["click", "type", "navigate", "scroll", "focus"]);
    expect(new Set(SURFACE_VERBS).size).toBe(SURFACE_VERBS.length);
  });

  test("命名空间→动词注册面：browser 五动词 / shell 恰 navigate / cli 空（M3）", () => {
    expect([...SURFACE_VERB_CAPABILITIES.browser]).toEqual(["click", "type", "navigate", "scroll", "focus"]);
    expect([...SURFACE_VERB_CAPABILITIES.shell]).toEqual(["navigate"]);
    expect([...SURFACE_VERB_CAPABILITIES.cli]).toEqual([]);
    // 注册面成员必须在封闭词汇表内（注册校验面自身的自洽）
    for (const verbs of Object.values(SURFACE_VERB_CAPABILITIES)) {
      for (const verb of verbs) {
        expect((SURFACE_VERBS as readonly string[]).includes(verb), `注册面含词汇表外动词：${verb}`).toBe(true);
      }
    }
  });

  test("动词→risk 注册档（D3 risk 挂动作：scroll/focus=read，click/type/navigate=write）", () => {
    expect(surfaceVerbRisk("scroll")).toBe("read");
    expect(surfaceVerbRisk("focus")).toBe("read");
    expect(surfaceVerbRisk("click")).toBe("write");
    expect(surfaceVerbRisk("type")).toBe("write");
    expect(surfaceVerbRisk("navigate")).toBe("write");
    expect(Object.keys(SURFACE_VERB_RISKS).sort()).toEqual([...SURFACE_VERBS].sort());
  });

  test("isSurfaceVerb / isSurfaceVerbAllowed 运行时守卫", () => {
    expect(isSurfaceVerb("click")).toBe(true);
    expect(isSurfaceVerb("frobnicate")).toBe(false); // 私造动词（突变验证词汇面）
    expect(isSurfaceVerb(1)).toBe(false);
    expect(isSurfaceVerbAllowed("browser", "type")).toBe(true);
    expect(isSurfaceVerbAllowed("shell", "type")).toBe(false); // 跨表面越权注册拒绝
    expect(isSurfaceVerbAllowed("shell", "navigate")).toBe(true);
    expect(isSurfaceVerbAllowed("cli", "navigate")).toBe(false); // cli 未接（M3）
    // 词汇表外动词任何命名空间都不可注册
    expect(isSurfaceVerbAllowed("browser", "frobnicate")).toBe(false);
    // 编译期窄化：词汇表成员是 SurfaceVerb（类型级契约）
    const verb: SurfaceVerb = "click";
    expect(isSurfaceVerb(verb)).toBe(true);
  });
});

// ── 目录登记（命令四条 + 事件两帧）──

describe("surface 命令/事件目录登记", () => {
  test("surface.* 四命令已入 COMMAND_TYPES（全局命令——信封省略 sessionId，E-84）", () => {
    for (const t of ["surface.register", "surface.unregister", "surface.event", "surface.action.result"]) {
      expect((COMMAND_TYPES as readonly string[]).includes(t), `未登记：${t}`).toBe(true);
    }
  });

  test("surface.* 两事件已入 EVENT_TYPES/EVENT_CHANNELS", () => {
    expect((EVENT_TYPES as readonly string[]).includes("surface.action")).toBe(true);
    expect((EVENT_TYPES as readonly string[]).includes("surface.registered")).toBe(true);
    expect(EVENT_CHANNELS["surface.action"]).toBe("surface");
    expect(EVENT_CHANNELS["surface.registered"]).toBe("surface");
  });

  test("窄化函数可消化 surface 帧/命令（穷尽性守护——payload 独有字段访问）", () => {
    const action: SurfaceActionEvent = {
      v: "0.14",
      sessionId: "__system__",
      channel: "surface",
      type: "surface.action",
      payload: { verb: "navigate", args: { sessionId: "s1" }, risk: "write", seq: 1, origin: "steward" },
    };
    expect(summarizeEvent(action)).toContain("navigate");
    expect(familyOf(action)).toBe("surface/surface.action");
    const registered: SurfaceRegisteredEvent = {
      v: "0.14",
      sessionId: "__system__",
      channel: "surface",
      type: "surface.registered",
      payload: { namespace: "shell", connId: "c1" },
    };
    expect(summarizeEvent(registered)).toContain("c1");

    const reg: SurfaceRegisterCommand = {
      v: "0.14",
      type: "surface.register",
      payload: { descriptor: { kind: "shell", capabilities: ["navigate"] } },
    };
    expect(dispatchCommand(reg)).toContain("shell");
    const unreg: SurfaceUnregisterCommand = { v: "0.14", type: "surface.unregister", payload: {} };
    expect(dispatchCommand(unreg)).toContain("surface-unregister");
    const ev: SurfaceEventCommand = {
      v: "0.14",
      type: "surface.event",
      payload: { kind: "navigated", origin: "user", page: "chat" },
    };
    expect(dispatchCommand(ev)).toContain("navigated");
    const receipt: SurfaceActionResultCommand = {
      v: "0.14",
      type: "surface.action.result",
      payload: { seq: 1, ok: true },
    };
    expect(dispatchCommand(receipt)).toContain("seq=1");
  });
});
