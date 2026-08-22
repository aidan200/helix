import { afterEach, describe, expect, test } from "bun:test";
import { SessionRegistry, type SessionRuntime } from "../../src/application/services/SessionRegistry";
import type { SessionRepositoryPort } from "../../src/application/ports/outbound/SessionRepositoryPort";
import type { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type { ChatService } from "../../src/application/services/ChatService";
import type { SessionProjection } from "../../src/application/services/SessionProjection";
import type { Session } from "../../src/domain/session/Session";

/**
 * T1.3 单元（TP-1.3b）：withTimeout 双通道可观测区分（源 R-2.3 吞错点
 * SessionRegistry.ts:576——`.catch(() => resolve())` 与超时 `resolve()`
 * 不可区分、错误路径零日志）。
 *
 * 经 deleteSession 集成面驱动（withTimeout 模块私有，唯一调用点即删除
 * 收口链 L284）：stub ChatService.whenSettled 可控——
 * ① 超时通道：pending 永不 settle + settleTimeoutMs 小值 → warn 含
 *    「删除收口 settle 超时」与 ms 数，且删除流程继续（resolve 不 reject，
 *    「活跃被删不崩优先」语义保持）；
 * ② 错误通道：whenSettled reject → warn 含「删除收口 settle 异常」与错误
 *    信息，删除流程同样继续（不崩语义保持）；
 * ③ 两通道文案可区分（超时消息不含异常错误文本；异常消息不含超时字样）。
 *
 * spy logger 是观察面非替身（TP-1.3c）；被测单元 SessionRegistry 不 mock。
 */

const NOW = "2026-08-21T00:00:00.000Z";
/** 超时通道注入的 settle 上限（ms；小值使测试窗口可控）。 */
const SETTLE_TIMEOUT_MS = 40;

interface Rig {
  readonly registry: SessionRegistry;
  readonly warns: string[];
  /** 测试内改写 whenSettled 行为（per-runtime 共享一个控制器）。 */
  setWhenSettled(behavior: () => Promise<void>): void;
}

function makeRig(settleTimeoutMs: number): Rig {
  const warns: string[] = [];
  let whenSettledBehavior: () => Promise<void> = async () => {};
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
      const chatService = {
        get sessionId() {
          return material.session.id;
        },
        get sessionView(): Session {
          return material.session;
        },
        abort: () => {},
        stop: () => {},
        whenSettled: () => whenSettledBehavior(),
      } as unknown as ChatService;
      return { sessionId: material.session.id, chatService, projection: {} as SessionProjection };
    },
    onListChanged: () => {},
    idleUnloadMs: 3_600_000,
    idlePollMs: 3_600_000, // 测试内不触发空闲卸载
    settleTimeoutMs,
    logger: { info: () => {}, warn: (m) => warns.push(m) },
  });
  return {
    registry,
    warns,
    setWhenSettled: (behavior) => {
      whenSettledBehavior = behavior;
    },
  };
}

const rigs: SessionRegistry[] = [];
afterEach(() => {
  for (const r of rigs) r.stop();
  rigs.length = 0;
});

describe("TP-1.3b withTimeout 双通道（deleteSession 收口等待面）", () => {
  test("①超时通道：whenSettled 永不 settle → warn 含「删除收口 settle 超时」+ ms 数，删除继续不抛", async () => {
    const rig = makeRig(SETTLE_TIMEOUT_MS);
    rigs.push(rig.registry);
    await rig.registry.initialize(); // 空库 → createFresh（当前会话热注册）
    const sessionId = rig.registry.currentSessionId();
    rig.setWhenSettled(() => new Promise<void>(() => {})); // pending 永不 settle

    await rig.registry.deleteSession(sessionId); // 不抛 = 「活跃被删不崩优先」保持

    const timeoutWarns = rig.warns.filter((m) => m.includes("删除收口 settle 超时"));
    expect(timeoutWarns.length).toBe(1);
    expect(timeoutWarns[0]!.includes(`${SETTLE_TIMEOUT_MS}ms`)).toBe(true);
    // 会话确实删成（流程继续，非提前中断）
    expect(await rig.registry.sessionExists(sessionId)).toBe(false);
  });

  test("②错误通道：whenSettled reject → warn 含「删除收口 settle 异常」+ 错误信息，删除继续不抛", async () => {
    const rig = makeRig(SETTLE_TIMEOUT_MS);
    rigs.push(rig.registry);
    await rig.registry.initialize();
    const sessionId = rig.registry.currentSessionId();
    rig.setWhenSettled(() => Promise.reject(new Error("run 收口炸了（注入）")));

    await rig.registry.deleteSession(sessionId); // 不抛 = 「不崩」语义保持

    const errorWarns = rig.warns.filter((m) => m.includes("删除收口 settle 异常"));
    expect(errorWarns.length).toBe(1);
    expect(errorWarns[0]!.includes("run 收口炸了（注入）")).toBe(true);
    expect(await rig.registry.sessionExists(sessionId)).toBe(false);
  });

  test("③两通道文案可区分：超时消息不含注入错误文本；异常消息不含「超时」字样", async () => {
    const rigTimeout = makeRig(SETTLE_TIMEOUT_MS);
    rigs.push(rigTimeout.registry);
    await rigTimeout.registry.initialize();
    const id1 = rigTimeout.registry.currentSessionId();
    rigTimeout.setWhenSettled(() => new Promise<void>(() => {}));
    await rigTimeout.registry.deleteSession(id1);

    const rigError = makeRig(SETTLE_TIMEOUT_MS);
    rigs.push(rigError.registry);
    await rigError.registry.initialize();
    const id2 = rigError.registry.currentSessionId();
    rigError.setWhenSettled(() => Promise.reject(new Error("区分度错误文本")));
    await rigError.registry.deleteSession(id2);

    const timeoutMsg = rigTimeout.warns.find((m) => m.includes("删除收口 settle 超时"));
    const errorMsg = rigError.warns.find((m) => m.includes("删除收口 settle 异常"));
    expect(timeoutMsg).toBeDefined();
    expect(errorMsg).toBeDefined();
    expect(timeoutMsg!.includes("区分度错误文本")).toBe(false); // 超时消息不混入错误文本
    expect(errorMsg!.includes("超时")).toBe(false); // 异常消息不含超时字样
    expect(timeoutMsg).not.toEqual(errorMsg);
  });
});
