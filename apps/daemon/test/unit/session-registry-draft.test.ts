import { afterEach, describe, expect, test } from "bun:test";
import { SessionRegistry, type SessionRuntime } from "../../src/application/services/SessionRegistry";
import type { SessionRepositoryPort } from "../../src/application/ports/outbound/SessionRepositoryPort";
import type { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type { ChatService } from "../../src/application/services/ChatService";
import type { SessionProjection } from "../../src/application/services/SessionProjection";
import type { SendOutcome } from "../../src/application/ports/inbound/ChatPort";
import type { SessionListChange } from "../../src/application/ports/inbound/SessionDirectoryPort";
import type { Session } from "../../src/domain/session/Session";
import { MODES } from "@helix/protocol";
import { profileKindOf } from "../../src/application/services/modes";

/**
 * T4 单元：daemon 内存草稿「不可见 + 转正」语义（SessionRegistry 面，
 * stub 依赖确定性覆盖——integration 见 draft-promotion.test.ts）。
 *
 * ① listSessions：零条目热草稿不进清单（bug1 泄漏面之一）；有内容的热
 *    未落库会话仍合并（回归）；
 * ② createFresh 不发布 agent.instantiated（泄漏面之二：trace 查询面幻影）；
 *    转正单点 promoteDraft 恰好一次 instantiated + created 补广播去重；
 * ③ startDraftSession 复用当前零条目热草稿（同 id 转正，不裂变新会话）；
 *    当前会话有内容时维持 createFresh；
 * ④ startDraftSession model：建会话/复用后、sendMessage 前 setModel；
 *    setModel 抛错 → warn 降级不阻断；
 * ⑤ probeCurrentDraft：零条目热草稿 → true；current 残骸（热缺失且库无行）
 *    → 丢弃并 createFresh 新草稿。
 */

/** stub ChatService 观测面（publishInstantiated/setModel/sendMessage 调用计数 + ops 时序）。 */
interface StubChat {
  readonly session: Session;
  publishedInstantiated: number;
  /** 引擎观测当前模型（T4b 同模型短路数据源；缺省 undefined = 引擎未暴露）。 */
  currentModelValue: string | undefined;
  readonly setModelCalls: string[];
  setModelError: string | undefined;
  readonly sentTexts: string[];
  /** 调用时序记录（T4b：instantiated/setModel 先后断言源）。 */
  readonly ops: string[];
}

interface Rig {
  readonly registry: SessionRegistry;
  readonly stubs: StubChat[];
  readonly changes: SessionListChange[];
  readonly warns: string[];
}

const NOW = "2026-08-20T00:00:00.000Z";

/** buildView 账目零值形状（UsageSummary 七字段）。 */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: 0,
};

function makeRig(): Rig {
  const stubs: StubChat[] = [];
  const changes: SessionListChange[] = [];
  const warns: string[] = [];
  const registry = new SessionRegistry({
    repository: {
      listSessionMetadata: async () => [],
      listSessionIds: async () => [],
      deleteSession: async () => {},
    } as unknown as SessionRepositoryPort,
    clock: { now: () => NOW, nowMs: () => Date.parse(NOW) },
    scheduler: {
      hasActiveInstances: () => false,
      cancelSession: () => {},
      restoreInstances: () => {},
      snapshotInstances: () => [],
    } as unknown as SchedulerService,
    restore: async () => undefined,
    buildRuntime: (material): SessionRuntime => {
      const stub: StubChat = {
        session: material.session,
        publishedInstantiated: 0,
        currentModelValue: undefined,
        setModelCalls: [],
        setModelError: undefined,
        sentTexts: [],
        ops: [],
      };
      stubs.push(stub);
      const chatService = {
        get sessionId() {
          return material.session.id;
        },
        get sessionView() {
          return material.session;
        },
        get agentState() {
          return "idle" as const;
        },
        get currentModel() {
          return stub.currentModelValue;
        },
        get toolCallData() {
          return [];
        },
        publishInstantiated: () => {
          stub.publishedInstantiated += 1;
          stub.ops.push("instantiated");
        },
        setModel: (model: string) => {
          if (stub.setModelError !== undefined) throw new Error(stub.setModelError);
          stub.setModelCalls.push(model);
          stub.ops.push(`setModel:${model}`);
        },
        sendMessage: async (text: string): Promise<SendOutcome> => {
          stub.sentTexts.push(text);
          material.session.appendUserEntry(text, NOW);
          return { mode: "turn", turnId: "t1", entryId: "e1" };
        },
        abort: () => {},
        stop: () => {},
        whenSettled: async () => {},
      } as unknown as ChatService;
      return { sessionId: material.session.id, chatService, projection: {
        // P1 T3：buildView 观测面桩（subAgent 工具记录/账目零值形状）
        subAgentToolCallData: () => [],
        instanceUsage: () => ZERO_USAGE,
        usageSummary: () => ({ total: ZERO_USAGE, compaction: ZERO_USAGE }),
      } as unknown as SessionProjection };
    },
    onListChanged: (change) => changes.push(change),
    idleUnloadMs: 3_600_000,
    idlePollMs: 3_600_000, // 测试内不触发空闲卸载
    logger: { info: () => {}, warn: (m) => warns.push(m) },
  });
  return { registry, stubs, changes, warns };
}

const rigs: SessionRegistry[] = [];
afterEach(() => {
  while (rigs.length > 0) rigs.pop()!.stop();
});

async function freshRig(): Promise<Rig> {
  const rig = makeRig();
  rigs.push(rig.registry);
  await rig.registry.initialize(); // 空库 → createFresh（零条目内存草稿）
  return rig;
}

describe("T4-U ① listSessions 不可见：零条目热草稿不进清单；有内容热未落库仍合并", () => {
  test("空库启动：内存草稿存在但清单为空；草稿追加条目后合并进清单（回归）", async () => {
    const rig = await freshRig();
    const draftId = rig.registry.currentSessionId();
    expect(rig.registry.peek(draftId)).toBeDefined(); // 热草稿客观存在（恒有会话不变）

    // 零条目 → 不可见（bug1 泄漏面封堵）
    expect(await rig.registry.listSessions()).toEqual([]);

    // 有内容的热未落库会话仍合并（回归：DB 无行，从运行时取）
    rig.stubs[0]!.session.appendUserEntry("有内容的首条消息", NOW);
    const list = await rig.registry.listSessions();
    expect(list.map((s) => s.sessionId)).toEqual([draftId]);
    expect(list[0]!.title).toBe("有内容的首条消息");
    expect(list[0]!.loaded).toBe(true);
  });
});

describe("T4-U ② createFresh 不发 instantiated；转正单点恰好一次 + created 去重", () => {
  test("initialize/createFresh 零 instantiated 零 created；promoteDraft 恰好一次；重复调用幂等", async () => {
    const rig = await freshRig();
    const draftId = rig.registry.currentSessionId();
    // createFresh 不再发布 instantiated（trace 查询面幻影封堵），也不广播 created
    expect(rig.stubs[0]!.publishedInstantiated).toBe(0);
    expect(rig.changes).toEqual([]);

    // 首个用户条目落聚合 → 转正：instantiated ×1 + created 补广播 ×1（title 可推导）
    rig.stubs[0]!.session.appendUserEntry("转正触发消息", NOW);
    rig.registry.promoteDraft(draftId);
    expect(rig.stubs[0]!.publishedInstantiated).toBe(1);
    const created = rig.changes.filter((c) => c.kind === "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.sessionId).toBe(draftId);
    expect(created[0]!.session!.title).toBe("转正触发消息");

    // 重复转正调用幂等（恰好一次硬约束）
    rig.registry.promoteDraft(draftId);
    expect(rig.stubs[0]!.publishedInstantiated).toBe(1);
    expect(rig.changes.filter((c) => c.kind === "created")).toHaveLength(1);
  });

  test("draft 链显式 created 后，转正补广播去重（不双发）；instantiated 仍恰好一次", async () => {
    const rig = await freshRig();
    const { sessionId } = await rig.registry.startDraftSession("draft 链首条消息");
    expect(rig.changes.filter((c) => c.kind === "created")).toHaveLength(1); // 显式即知广播

    rig.registry.promoteDraft(sessionId); // sendMessage 首个用户条目触发（单测直调）
    const stub = rig.stubs.find((s) => s.session.id === sessionId)!;
    expect(stub.publishedInstantiated).toBe(1);
    expect(rig.changes.filter((c) => c.kind === "created")).toHaveLength(1); // 不双广播
  });
});

describe("T4-U ③ startDraftSession 复用当前零条目热草稿（同 id 转正，不裂变）", () => {
  test("当前是零条目热草稿 → 复用同 id；created 恰好一次；转正后 current 停留且不新建下一个草稿", async () => {
    const rig = await freshRig();
    const draftId = rig.registry.currentSessionId();
    const runtimeCountBefore = rig.stubs.length;

    const { sessionId } = await rig.registry.startDraftSession("复用这条草稿");
    expect(sessionId).toBe(draftId); // 同 id 转正
    expect(rig.stubs.length).toBe(runtimeCountBefore); // 不 createFresh、转正后不新建下一个草稿
    expect(rig.registry.currentSessionId()).toBe(draftId); // current 停留（touch 语义不变）
    expect(rig.stubs[0]!.sentTexts).toEqual(["复用这条草稿"]);
    const created = rig.changes.filter((c) => c.kind === "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.sessionId).toBe(draftId);
  });

  test("当前会话已有内容 → 维持 createFresh（新 id）", async () => {
    const rig = await freshRig();
    const firstId = rig.registry.currentSessionId();
    rig.stubs[0]!.session.appendUserEntry("已有内容", NOW);

    const { sessionId } = await rig.registry.startDraftSession("新会话消息");
    expect(sessionId).not.toBe(firstId);
    expect(rig.stubs).toHaveLength(2);
  });
});

describe("T4-U ④ startDraftSession model：sendMessage 前 setModel；失败降级不阻断", () => {
  test("model 指定 → setModel 先于 sendMessage；缺省 → 不调 setModel", async () => {
    const rig = await freshRig();
    await rig.registry.startDraftSession("带模型的首条消息", "test/model-x");
    expect(rig.stubs[0]!.setModelCalls).toEqual(["test/model-x"]);
    expect(rig.stubs[0]!.sentTexts).toEqual(["带模型的首条消息"]);

    const rig2 = await freshRig();
    await rig2.registry.startDraftSession("缺省模型消息");
    expect(rig2.stubs[0]!.setModelCalls).toEqual([]); // 缺省 = 全局默认（不换模）
  });

  test("setModel 抛错 → logger.warn 降级，sendMessage 照常（不阻断）", async () => {
    const rig = await freshRig();
    rig.stubs[0]!.setModelError = "引擎未实现运行期换模接口";
    const { sessionId } = await rig.registry.startDraftSession("降级消息", "test/model-y");
    expect(sessionId).toBe(rig.registry.currentSessionId());
    expect(rig.stubs[0]!.sentTexts).toEqual(["降级消息"]); // 不阻断
    expect(rig.warns.some((w) => w.includes("test/model-y"))).toBe(true); // 可观测降级
  });
});

describe("T4b-U ① 同模型短路：model === 引擎观测值 → 零 setModel 零事件；不提前转正", () => {
  test("currentModel === model → setModel 零调用、instantiated 零发布（转正仍等首个用户条目回调）", async () => {
    const rig = await freshRig();
    rig.stubs[0]!.currentModelValue = "test/same-model"; // 引擎观测值与选定一致
    const { sessionId } = await rig.registry.startDraftSession("同模型首条消息", "test/same-model");
    expect(sessionId).toBe(rig.registry.currentSessionId()); // 复用零条目草稿不变
    expect(rig.stubs[0]!.setModelCalls).toEqual([]); // 短路：零调用（不产生 model.changed）
    expect(rig.stubs[0]!.ops).toEqual([]); // 零事件：不提前转正（ instantiated 等首条目回调）
    expect(rig.stubs[0]!.sentTexts).toEqual(["同模型首条消息"]); // 首条消息照常
    expect(rig.changes.filter((c) => c.kind === "created")).toHaveLength(1);
  });

  test("currentModel 缺省（引擎未暴露）→ 不短路，维持换模路径（回归）", async () => {
    const rig = await freshRig();
    await rig.registry.startDraftSession("引擎未暴露模型消息", "test/model-x");
    expect(rig.stubs[0]!.setModelCalls).toEqual(["test/model-x"]);
  });
});

describe("T4b-U ② 异模型先转正再换模：instantiated 先于 setModel；created 不双发", () => {
  test("currentModel ≠ model → ops 次序 instantiated → setModel；created 恰好一次；首条消息照常", async () => {
    const rig = await freshRig();
    rig.stubs[0]!.currentModelValue = "test/default-model";
    const { sessionId } = await rig.registry.startDraftSession("异模型首条消息", "test/picked-model");
    // 时序硬约束：先转正（instantiated 落盘）再换模（model.changed 落盘）
    expect(rig.stubs[0]!.ops).toEqual(["instantiated", "setModel:test/picked-model"]);
    expect(rig.stubs[0]!.setModelCalls).toEqual(["test/picked-model"]);
    expect(rig.stubs[0]!.sentTexts).toEqual(["异模型首条消息"]);
    // 显式 created 广播 + 提前转正的补广播去重：恰好一次（title = 首条消息截断）
    const created = rig.changes.filter((c) => c.kind === "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.sessionId).toBe(sessionId);
    expect(created[0]!.session!.title).toBe("异模型首条消息");
    // 提前转正后，sendMessage 首条目回调再触发 promoteDraft 幂等（仍恰好一次）
    rig.registry.promoteDraft(sessionId);
    expect(rig.stubs[0]!.publishedInstantiated).toBe(1);
    expect(rig.changes.filter((c) => c.kind === "created")).toHaveLength(1);
  });

  test("异模型但 setModel 抛错 → 已转正不回收，warn 降级不阻断（首条消息用全局默认）", async () => {
    const rig = await freshRig();
    rig.stubs[0]!.currentModelValue = "test/default-model";
    rig.stubs[0]!.setModelError = "引擎未实现运行期换模接口";
    await rig.registry.startDraftSession("降级消息", "test/model-y");
    expect(rig.stubs[0]!.publishedInstantiated).toBe(1); // 先转正已发生（次序保证不回收）
    expect(rig.stubs[0]!.sentTexts).toEqual(["降级消息"]); // 不阻断
    expect(rig.warns.some((w) => w.includes("test/model-y"))).toBe(true);
  });
});

describe("T4-U ⑤ probeCurrentDraft：握手草稿探测 + current 残骸清理", () => {
  test("零条目热草稿 → true；有内容 → false；热缺失且库无行（残骸）→ 丢弃并 createFresh", async () => {
    const rig = await freshRig();
    const draftId = rig.registry.currentSessionId();
    expect(await rig.registry.probeCurrentDraft()).toBe(true); // 零条目热草稿

    rig.stubs[0]!.session.appendUserEntry("有内容", NOW);
    expect(await rig.registry.probeCurrentDraft()).toBe(false);

    // 残骸复现：零条目 current 被空闲卸载（注册表移除、库无行——不可恢复）
    const rig2 = await freshRig();
    const wreckId = rig2.registry.currentSessionId();
    (
      rig2.registry as unknown as { sessions: Map<string, { runtime: SessionRuntime }> }
    ).sessions.delete(wreckId); // 模拟空闲卸载后的残骸（单测确定性直改；T2.1 单台账收敛结构跟随）
    expect(rig2.registry.peek(wreckId)).toBeUndefined();
    expect(await rig2.registry.probeCurrentDraft()).toBe(true); // 换新草稿仍是草稿
    expect(rig2.registry.currentSessionId()).not.toBe(wreckId); // 残骸被丢弃
    expect(rig2.registry.peek(rig2.registry.currentSessionId())).toBeDefined(); // 新草稿热登记
  });
});

// ── P1 T3：mode 透传/解析 + 热草稿复用 profileKind 一致性 ──────────

describe("P1 T3 ③ startDraftSession mode：建会话定格 + 热草稿复用 profileKind 一致性", () => {
  test("缺省/未知 mode → 建会话 Session.mode 定格 default（消费单点 fallback）；零条目热草稿复用同 id", async () => {
    const rig = await freshRig();
    const draftId = rig.registry.currentSessionId();
    expect(rig.stubs[0]!.session.mode).toBe("default"); // initialize 建的草稿也定格 default

    // 缺省 mode：复用当前零条目草稿（同 id——同 profileKind 一致性成立）
    const { sessionId } = await rig.registry.startDraftSession("缺省模式首条");
    expect(sessionId).toBe(draftId);
    expect(rig.stubs.find((s) => s.session.id === sessionId)!.session.mode).toBe("default");

    // 未知 mode：fallback default（注册表消费单点），profileKind 一致 → 仍复用同 id
    const rig2 = await freshRig();
    const draftId2 = rig2.registry.currentSessionId();
    const { sessionId: sid2 } = await rig2.registry.startDraftSession("未知模式首条", undefined, undefined, "no-such-mode");
    expect(sid2).toBe(draftId2);
    expect(rig2.stubs[0]!.session.mode).toBe("default"); // fallback 定格
  });

  test("目标 mode 与热草稿 mode 同 profileKind → 复用同 id（P1 单模式：default 显式传入同样复用）", async () => {
    const rig = await freshRig();
    const draftId = rig.registry.currentSessionId();
    const before = rig.stubs.length;
    const { sessionId } = await rig.registry.startDraftSession("default 目标", undefined, undefined, "default");
    expect(sessionId).toBe(draftId); // 同 profileKind → 复用（不裂变）
    expect(rig.stubs.length).toBe(before);
  });

  test("profileKind 不一致 → 丢弃热草稿走 createFresh（新 id + 新 mode 定格）；旧零条目草稿无成本留存", async () => {
    // P1 注册表单模式：运行时扩一条第二模式模拟 P2 多模式现场（测后还原，
    // 单测试内同步 mutate/restore——bun 文件级隔离下无跨文件可见性）
    const writable = MODES as unknown as { id: string; kind: "single"; profileKind: string }[];
    writable.push({ id: "second", kind: "single", profileKind: "other-kind" });
    try {
      // 扩表生效前置断言（运行时扩条目超出编译期 P1 字面量联合——as string 放宽）
      expect(profileKindOf("second") as string).toBe("other-kind");
      const rig = await freshRig(); // 草稿 mode=default（main-session）
      const draftId = rig.registry.currentSessionId();

      // 不一致 → 丢弃热草稿，按新 mode 构造
      const { sessionId } = await rig.registry.startDraftSession("异模式首条", undefined, undefined, "second");
      expect(sessionId).not.toBe(draftId);
      expect(rig.stubs.length).toBe(2); // createFresh 新运行时
      expect(rig.stubs.find((s) => s.session.id === sessionId)!.session.mode).toBe("second");
      // 旧零条目草稿留存（无成本：不进清单、自然消亡），current 已轮换到新会话
      expect(rig.registry.peek(draftId)).toBeDefined();
      expect(rig.registry.currentSessionId()).toBe(sessionId);

      // 二次同 mode（second）：current 已转正（首条消息已落聚合）→ 复用前提
      // = 零条目热草稿不因 profileKind 一致弱化（T4 转正不裂变语义保持）——
      // createFresh 新 id 且 mode 仍定格 second；零条目草稿复用面在 P1 单模式
      // 恒 default（懒建点无 mode），见本 describe 首两测
      const secondDraftId = rig.registry.currentSessionId();
      const again = await rig.registry.startDraftSession("同模式复用", undefined, undefined, "second");
      expect(again.sessionId).not.toBe(secondDraftId); // 有内容 → 不复用（新 id）
      expect(rig.stubs.find((s) => s.session.id === again.sessionId)!.session.mode).toBe("second");
    } finally {
      writable.pop(); // 还原注册表（常量单源不被污染）
    }
  });

  test("buildView 主实例 profileKind 从 session.mode 解析（default → main-session；扩表模式 → 该条目 profileKind）", async () => {
    const rig = await freshRig();
    const view = await rig.registry.getSessionView();
    expect(view.session.mode).toBe("default"); // 快照视图携带定格 mode
    expect(view.instances![0]!.profileKind).toBe("main-session"); // 字面量参数化取值

    const writable = MODES as unknown as { id: string; kind: "single"; profileKind: string }[];
    writable.push({ id: "second", kind: "single", profileKind: "other-kind" });
    try {
      const rig2 = await freshRig();
      const { sessionId } = await rig2.registry.startDraftSession("异模式首条", undefined, undefined, "second");
      const view2 = await rig2.registry.getSessionView(sessionId);
      expect(view2.instances![0]!.profileKind).toBe("other-kind"); // mode 解析值（非硬编码）
    } finally {
      writable.pop();
    }
  });
});
