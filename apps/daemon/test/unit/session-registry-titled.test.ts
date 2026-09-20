import { afterEach, describe, expect, test } from "bun:test";
import { SessionRegistry, type SessionRuntime } from "../../src/application/services/SessionRegistry";
import { createTurnDiffState } from "../../src/application/services/TurnDiffService";
import type { PersistedDomainState, SessionRepositoryPort } from "../../src/application/ports/outbound/SessionRepositoryPort";
import type { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type { ChatService } from "../../src/application/services/ChatService";
import type { SessionProjection } from "../../src/application/services/SessionProjection";
import type { SendOutcome } from "../../src/application/ports/inbound/ChatPort";
import type { SessionListChange } from "../../src/application/ports/inbound/SessionDirectoryPort";
import type { Session } from "../../src/domain/session/Session";
import { Session as SessionCtor } from "../../src/domain/session/Session";
import type { SessionSnapshot } from "../../src/domain/session/SessionSnapshot";

/**
 * 修复批 ①（管家建会话死锁链）：createTitledSession 同轨不同入口——
 * 显式建标题会话走 createFresh 同一构造路径，但不发送任何消息、不点火
 * 引擎（对照事故：startDraftSession(title) 把 title 当首条用户消息发送，
 * 触发完整幽灵 agent run）。
 *
 * 零条目可见性规则精化：现行「零条目热草稿不可见」保护的是自动懒建
 * 草稿；显式建标题会话是一等可见会话——显式建立即 INSERT（title 进
 * meta 列，非首条消息派生），listSessions 包含；用户后续首条消息走既有
 * 转正/promote 链（title 保留不覆盖）。
 */

interface Rig {
  readonly registry: SessionRegistry;
  readonly stubs: { session: Session; sentTexts: string[]; publishedInstantiated: number }[];
  readonly changes: SessionListChange[];
  readonly repo: MemRepo;
}

const NOW = "2026-09-20T00:00:00.000Z";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: 0,
};

/** 内存仓（跨 Rig 可共享——重启恢复测试用同仓建第二 registry）。 */
class MemRepo {
  readonly rows = new Map<string, PersistedDomainState>();
  saveCalls = 0;

  async save(state: PersistedDomainState): Promise<void> {
    this.saveCalls += 1;
    this.rows.set(state.session.sessionId, structuredClone(state));
  }

  async restore(sessionId: string): Promise<PersistedDomainState | undefined> {
    const row = this.rows.get(sessionId);
    return row ? structuredClone(row) : undefined;
  }

  toPort(): SessionRepositoryPort {
    return {
      save: (state: PersistedDomainState) => this.save(state),
      restore: (sessionId: string) => this.restore(sessionId),
      listSessionIds: async () => [...this.rows.keys()],
      listSessionMetadata: async () =>
        [...this.rows.values()].map((state: PersistedDomainState) => {
          const first = state.session.entries.find(
            (e): e is (typeof e) & { role?: string } => "role" in e && e.role === "user",
          );
          return {
            sessionId: state.session.sessionId,
            createdAt: state.session.createdAt,
            updatedAt: state.session.entries.at(-1)?.createdAt ?? state.session.createdAt,
            firstUserText: first !== undefined ? ((first as { text: string }).text ?? null) : null,
            ...(state.session.title !== undefined ? { title: state.session.title } : {}),
          };
        }),
      deleteSession: async (sessionId: string) => {
        this.rows.delete(sessionId);
      },
    } as unknown as SessionRepositoryPort;
  }
}

function makeRig(repo: MemRepo): Rig {
  const stubs: Rig["stubs"] = [];
  const changes: SessionListChange[] = [];
  const registry = new SessionRegistry({
    repository: repo.toPort(),
    clock: { now: () => NOW, nowMs: () => Date.parse(NOW) },
    scheduler: {
      hasActiveInstances: () => false,
      cancelSession: () => {},
      restoreInstances: () => {},
      snapshotInstances: () => [],
    } as unknown as SchedulerService,
    restore: async (sessionId: string) => {
      // 重启恢复链（生产 = RestoreService.restore 读仓重建；stub 同构最小面）
      const state = await repo.restore(sessionId);
      if (state === undefined) return undefined;
      return {
        session: SessionCtor.restoreFrom(state.session),
        agentState: "idle" as const,
        toolCalls: [],
        instances: [],
        usage: { instances: {}, compaction: ZERO_USAGE, ctx: {} },
      };
    },
    buildRuntime: (material): SessionRuntime => {
      const stub = { session: material.session, sentTexts: [] as string[], publishedInstantiated: 0 };
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
          return undefined;
        },
        get persistedState(): PersistedDomainState {
          return { session: material.session.toSnapshot(), agentState: "idle", toolCalls: [] };
        },
        get toolCallData() {
          return [];
        },
        publishInstantiated: () => {
          stub.publishedInstantiated += 1;
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
      return {
        sessionId: material.session.id,
        chatService,
        projection: {
          subAgentToolCallData: () => [],
          instanceUsage: () => ZERO_USAGE,
          usageSummary: () => ({ total: ZERO_USAGE, compaction: ZERO_USAGE }),
        } as unknown as SessionProjection,
        diff: createTurnDiffState(),
      };
    },
    onListChanged: (change) => changes.push(change),
    idleUnloadMs: 3_600_000,
    idlePollMs: 3_600_000,
    logger: { info: () => {}, warn: () => {} },
  });
  return { registry, stubs, changes, repo };
}

const registries: SessionRegistry[] = [];
afterEach(() => {
  while (registries.length > 0) registries.pop()!.stop();
});

async function freshRig(repo = new MemRepo()): Promise<Rig> {
  const rig = makeRig(repo);
  registries.push(rig.registry);
  await rig.registry.initialize(); // 空库 → createFresh（零条目内存草稿）
  return rig;
}

describe("修复① createTitledSession：同轨不同入口（零消息零引擎）", () => {
  test("建后零条目可见于 list + title 正确 + created 广播恰一次 + 显式建立即 INSERT", async () => {
    const rig = await freshRig();
    const savesBefore = rig.repo.saveCalls;
    const { sessionId } = await rig.registry.createTitledSession("调研 pi-engine 事件链");

    // 显式建立即 INSERT（一等可见会话——区别于自动懒建草稿的「首条消息才落库」）
    expect(rig.repo.saveCalls).toBe(savesBefore + 1);
    expect(rig.repo.rows.has(sessionId)).toBe(true);

    // 零条目仍可见（可见性规则精化：显式建标题会话不受「零条目热草稿不可见」封堵）
    const list = await rig.registry.listSessions();
    const found = list.find((s) => s.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(found!.title).toBe("调研 pi-engine 事件链");
    expect(rig.registry.peek(sessionId)!.chatService.sessionView.isEmpty()).toBe(true); // 零条目

    // created 广播恰好一次（title = 显式值）
    const created = rig.changes.filter((c) => c.kind === "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.sessionId).toBe(sessionId);
    expect(created[0]!.session!.title).toBe("调研 pi-engine 事件链");
  });

  test("不发送任何消息、不点火引擎（对照事故根因）+ 不发布 instantiated", async () => {
    const rig = await freshRig();
    const { sessionId } = await rig.registry.createTitledSession("新话题");
    const stub = rig.stubs.find((s) => s.session.id === sessionId)!;
    expect(stub.sentTexts).toEqual([]); // 零 sendMessage（title 不再被当首条用户消息）
    expect(stub.publishedInstantiated).toBe(0); // 转正前零 instantiated（trace 面无幻影）
  });

  test("current 不被抢（后台建会话不轮换 current——M6 #2.4 用户交互面纪律）", async () => {
    const rig = await freshRig();
    const before = rig.registry.currentSessionId();
    await rig.registry.createTitledSession("后台建的会话");
    expect(rig.registry.currentSessionId()).toBe(before); // 用户所在会话不变
  });

  test("首条消息后走既有转正链：instantiated 恰一次 + title 不被 deriveTitle 覆盖", async () => {
    const rig = await freshRig();
    const { sessionId } = await rig.registry.createTitledSession("持久标题");
    const stub = rig.stubs.find((s) => s.session.id === sessionId)!;
    await stub.session.appendUserEntry("这是第一条消息的完整文本不该成为标题", NOW);
    rig.registry.promoteDraft(sessionId); // 首个用户条目落聚合回调（组合根接线，单测直调）

    expect(stub.publishedInstantiated).toBe(1); // 转正单点恰好一次
    const list = await rig.registry.listSessions();
    expect(list.find((s) => s.sessionId === sessionId)!.title).toBe("持久标题"); // title 保留
    // created 不双播（建会话已播）
    expect(rig.changes.filter((c) => c.kind === "created")).toHaveLength(1);
  });

  test("daemon 重启后恢复可见 + 懒加载视图携带 title + 复用不重播 created", async () => {
    const repo = new MemRepo();
    const rig1 = await freshRig(repo);
    // 先给既有会话留内容（updated_at 更晚），验证 titled 会话不依赖「是 latest」
    await rig1.registry.startDraftSession("既有会话首条");
    const titled = await rig1.registry.createTitledSession("重启后仍可见的标题");

    // 重启：同仓新建 registry（restore 走 repo 行重建）
    const rig2 = makeRig(repo);
    registries.push(rig2.registry);
    await rig2.registry.initialize();
    const list = await rig2.registry.listSessions();
    expect(list.find((s) => s.sessionId === titled.sessionId)?.title).toBe("重启后仍可见的标题");

    // 懒加载视图携带 title（快照往返）
    const view = await rig2.registry.getSessionView(titled.sessionId);
    expect((view.session as SessionSnapshot).title).toBe("重启后仍可见的标题");

    // 复用守卫：current 命中 titled 零条目热会话时 startDraftSession 不重播
    // created（title 保持显式值，不被首条消息派生覆盖）
    const changesBefore = rig2.changes.filter((c) => c.kind === "created").length;
    await rig2.registry.startDraftSession("复用 titled 会话的首条消息");
    expect(rig2.changes.filter((c) => c.kind === "created")).toHaveLength(changesBefore);
    const listAfter = await rig2.registry.listSessions();
    expect(listAfter.find((s) => s.sessionId === titled.sessionId)?.title).toBe("重启后仍可见的标题");
  });

  test("空/纯空白 title 抛错（不建会话零副作用）", async () => {
    const rig = await freshRig();
    await expect(rig.registry.createTitledSession("   ")).rejects.toThrow("标题不能为空");
    expect(rig.repo.rows.size).toBe(0); // 零落库
    expect(rig.changes).toEqual([]); // 零广播
  });
});
