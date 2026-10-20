/**
 * SessionRegistry.deleteSession 两处失败路径单测（评审 low #57/#58）。
 *
 * - #57 当前会话删除时 rotateCurrent 抛错 → 删除广播（list_changed deleted）
 *   仍须发出（库已删、注册表已移除，吞广播会留前端幽灵条目）。
 * - #58 冷会话（未热加载）删除失败 → 占位 record（runtime=undefined）不得永驻
 *   sessions Map（unloadIdle/清单面都跳过无 runtime 行，占位即泄漏）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SessionRegistry, type SessionRuntime } from "../../src/application/services/SessionRegistry";
import { createTurnDiffState } from "../../src/application/services/TurnDiffService";
import type { SessionRepositoryPort } from "../../src/application/ports/outbound/SessionRepositoryPort";
import type { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type { ChatService } from "../../src/application/services/ChatService";
import type { SessionProjection } from "../../src/application/services/SessionProjection";
import { Session } from "../../src/domain/session/Session";

const NOW = "2026-08-21T00:00:00.000Z";

function makeRig(opts: { rows: string[]; deleteThrows?: boolean }) {
  const changes: { kind: string; sessionId?: string | undefined }[] = [];
  const warns: string[] = [];
  const state = { failListMetadata: false, rowsGone: false };
  const repository = {
    listSessionMetadata: async () => {
      if (state.failListMetadata) throw new Error("会话清单读面失败（模拟轮换失败）");
      return opts.rows.map((sessionId) => ({
        sessionId,
        createdAt: NOW,
        updatedAt: NOW,
        firstUserText: null,
        entryCount: null,
      }));
    },
    listSessionIds: async () => (state.rowsGone ? [] : opts.rows),
    deleteSession: async () => {
      if (opts.deleteThrows === true) throw new Error("库删除失败（模拟）");
    },
  } as unknown as SessionRepositoryPort;
  const registry = new SessionRegistry({
    repository,
    clock: { now: () => NOW, nowMs: () => Date.parse(NOW) },
    scheduler: {
      hasActiveInstances: () => false,
      cancelSession: () => {},
      restoreInstances: () => {},
      snapshotInstances: () => [],
    } as unknown as SchedulerService,
    // 冷加载 stub：单会话恢复出空聚合（initialize 即 current=s-only）
    restore: async (sessionId: string) => ({
      session: Session.create(sessionId),
      agentState: "idle" as const,
      toolCalls: [],
      instances: [],
      usage: undefined,
    }) as never,
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
        whenSettled: async () => {},
      } as unknown as ChatService;
      return { sessionId: material.session.id, chatService, projection: {} as SessionProjection, diff: createTurnDiffState() };
    },
    onListChanged: (change: { kind: string; sessionId?: string | undefined }) => {
      changes.push(change);
    },
    idleUnloadMs: 3_600_000,
    idlePollMs: 3_600_000,
    logger: { info: () => {}, warn: (m) => warns.push(m) },
  });
  return { registry, changes, warns, state };
}

const rigs: SessionRegistry[] = [];
afterEach(() => {
  for (const r of rigs) r.stop();
  rigs.length = 0;
});

describe("SessionRegistry.deleteSession 失败路径（评审 low #57/#58）", () => {
  test("冷会话删除失败（库抛错）→ 占位 record 在册清理（#58）", async () => {
    const rig = makeRig({ rows: ["s-cold"], deleteThrows: true });
    rigs.push(rig.registry);
    await expect(rig.registry.deleteSession("s-cold")).rejects.toThrow(/库删除失败/);
    expect(rig.changes).toHaveLength(0); // 失败路径零广播

    // 占位行已清的判据：库行消失后（他处已删/被回滚）再删该 id 必须走
    // 「会话不存在」——占位 record 泄漏时 `existing !== undefined` 会绕过
    // sessionExists 判存，把这次删除当成功（对无主占位做空删）。
    rig.state.rowsGone = true;
    await expect(rig.registry.deleteSession("s-cold")).rejects.toThrow(/不存在/);
  });

  test("当前会话删除时轮换失败 → 删除广播照发（#57）", async () => {
    const rig = makeRig({ rows: ["s-only"] });
    rigs.push(rig.registry);
    await rig.registry.initialize();
    expect(rig.registry.peekCurrentSessionId()).toBe("s-only"); // 单会话 initialize 即 current

    // 轮换失败注入：current 会话删除后 rotateCurrent 读清单抛错
    rig.state.failListMetadata = true;
    await rig.registry.deleteSession("s-only");

    // 库已删、注册表已移除——广播必须照发（否则前端清单留幽灵条目）
    expect(rig.changes.some((c) => c.kind === "deleted" && c.sessionId === "s-only")).toBe(true);
    expect(rig.warns.some((w) => w.includes("当前会话轮换失败"))).toBe(true);
  });
});
