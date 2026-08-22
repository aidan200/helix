import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Daemon } from "../../src/infrastructure/container";
import { createTestDaemon } from "../helpers/createTestDaemon";
import type { SessionRegistry, SessionRuntime } from "../../src/application/services/SessionRegistry";
import type { SessionRunState } from "../../src/application/ports/inbound/SessionDirectoryPort";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";

/**
 * T2.1 TP-2.1c 生命周期整体销毁测试（H2.1：SessionRecord 收敛六台账）。
 *
 * 六台账（runtimes / lastActivityMs / lastBroadcastRunState / deleting /
 * unpromotedDrafts / createdAnnounced）收敛为 `Map<string, SessionRecord>`
 * 单台账后，生命周期随 record 整体销毁——清理点 N→1 的回归锚点：
 *
 * ① delete 路径：deleteSession 后 record 整体销毁（sessions.delete 恰一次
 *    ——六类状态无残留），deleting 标记随之消解（再删 → not_found 而非
 *    delete_in_progress）；
 * ② unload 路径：空闲卸载后 record 整体销毁——**原 unloadIdle 只清 3 台账
 *    （lastBroadcastRunState / createdAnnounced 残留，ex1 §一清理矩阵），
 *    整体销毁裁决消解该残留**；重载后 record 重建（unpromotedDraft=false：
 *    已落库会话非草稿），promoteDraft/补广播链路结构性不触发——
 *    createdAnnounced「卸载重载不重播」语义保持（instantiated 不双发）；
 * ③ promoteDraft 路径：record 不销毁（零 delete），纯字段翻转
 *    （unpromotedDraft→false、createdAnnounced→true），重复直调幂等。
 *
 * 现状（收敛前）sessions 单台账不存在 → recordOf 抛错先红。
 */

/** 单台账记录形状（TP-2.1c 白盒断言面；收敛后 = SessionRecord 六字段）。 */
interface SessionRecordShape {
  readonly runtime: SessionRuntime;
  lastActivityMs: number;
  lastBroadcastRunState: SessionRunState | undefined;
  deleting: boolean;
  unpromotedDraft: boolean;
  createdAnnounced: boolean;
}

/** 白盒读单台账 record（六台账未收敛时抛错——RED 阶段显式失败）。 */
function recordOf(registry: SessionRegistry, sessionId: string): SessionRecordShape | undefined {
  const sessions = (registry as unknown as { sessions?: Map<string, SessionRecordShape> }).sessions;
  if (sessions === undefined) {
    throw new Error("sessions 单台账不存在（六台账未收敛——T2.1 实现缺失）");
  }
  return sessions.get(sessionId);
}

interface Rig {
  home: string;
  daemon: Daemon;
  engines: Map<string, FakeAgentEngine>;
  engineOf(sessionId: string): FakeAgentEngine;
  dispose: () => Promise<void>;
}

interface RigOptions {
  replies?: { text: string }[];
  idleUnloadMs?: number;
  idlePollMs?: number;
}

async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t21-record-"));
  const engines = new Map<string, FakeAgentEngine>();
  const daemon = await createTestDaemon({
    home,
    engine: (sessionId) => {
      const engine = new FakeAgentEngine({ replies: options.replies ? [...options.replies] : undefined });
      engines.set(sessionId, engine);
      return engine;
    },
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    sessionIdleUnloadMs: options.idleUnloadMs,
    sessionIdlePollMs: options.idlePollMs,
  });
  return {
    home,
    daemon,
    engines,
    engineOf(sessionId: string): FakeAgentEngine {
      const engine = engines.get(sessionId);
      if (engine === undefined) throw new Error(`会话 ${sessionId} 的引擎未创建（懒加载未触发？）`);
      return engine;
    },
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 直读同 home 的 SQLite（instantiated 落盘计数——转正恰好一次的行为锚点）。 */
function openRepo(home: string): SqliteSessionRepository {
  return new SqliteSessionRepository(new WriteQueue(path.join(home, "helix.db")));
}

function countInstantiated(rig: Rig, sessionId: string): number {
  return openRepo(rig.home)
    .queryEvents({ sessionId })
    .filter((e) => e.type === "agent.instantiated").length;
}

async function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("T2.1 TP-2.1c 生命周期整体销毁（六类状态无残留）", () => {
  test("① delete 路径：record 整体销毁（六状态无残留）+ deleting 标记解除", async () => {
    const rig = await makeRig({ replies: [{ text: "删除路径回复" }] });
    try {
      const dir = rig.daemon.directory;
      // 草稿初始态锚点：createFresh 登记 record（unpromotedDraft=true、
      // createdAnnounced=false、deleting=false——六字段形状）
      const draftId = dir.currentSessionId();
      const draftRecord = recordOf(rig.daemon.registry, draftId);
      expect(draftRecord).toBeDefined();
      expect(Object.keys(draftRecord!).sort()).toEqual([
        "createdAnnounced",
        "deleting",
        "lastActivityMs",
        "lastBroadcastRunState",
        "runtime",
        "unpromotedDraft",
      ]);
      expect(draftRecord!.unpromotedDraft).toBe(true);
      expect(draftRecord!.createdAnnounced).toBe(false);
      expect(draftRecord!.deleting).toBe(false);
      expect(draftRecord!.lastActivityMs).toBeGreaterThan(0);

      // 落库会话（首条消息 → 转正 + 落库）
      const a = await dir.startDraftSession("删除路径会话");
      await until(() => rig.engineOf(a.sessionId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");
      expect(recordOf(rig.daemon.registry, a.sessionId)).toBeDefined();

      await dir.deleteSession(a.sessionId);

      // record 整体销毁：runtime/lastActivityMs/lastBroadcastRunState/
      // deleting/unpromotedDraft/createdAnnounced 六类状态全无残留
      expect(recordOf(rig.daemon.registry, a.sessionId)).toBeUndefined();

      // deleting 无残留的行为证明：再删 → not_found（而非 delete_in_progress）
      await expect(dir.deleteSession(a.sessionId)).rejects.toMatchObject({ name: "SessionNotFoundError" });
    } finally {
      await rig.dispose();
    }
  }, 15000);

  test("② unload 路径：record 整体销毁（原 lastBroadcastRunState/createdAnnounced 残留面消解）+ 重载后 created 不重播", async () => {
    const rig = await makeRig({ replies: [{ text: "卸载路径回复" }], idleUnloadMs: 80, idlePollMs: 10 });
    try {
      const dir = rig.daemon.directory;
      const a = await dir.startDraftSession("卸载路径会话");
      await until(() => rig.engineOf(a.sessionId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");

      // 转正已完成：record 字段翻转锚点（unpromotedDraft=false、createdAnnounced=true）
      const hot = recordOf(rig.daemon.registry, a.sessionId);
      expect(hot).toBeDefined();
      expect(hot!.unpromotedDraft).toBe(false);
      expect(hot!.createdAnnounced).toBe(true);
      expect(hot!.lastBroadcastRunState).toBeDefined();

      // 空闲卸载（G-5 注入短窗口）
      await until(() => rig.daemon.registry.peek(a.sessionId) === undefined, 3000, "空闲卸载");

      // record 整体销毁——收敛前 unloadIdle 只清 3 台账，lastBroadcastRunState
      // 与 createdAnnounced 残留（ex1 §一清理矩阵）；整体销毁后六状态无残留
      expect(recordOf(rig.daemon.registry, a.sessionId)).toBeUndefined();

      // createdAnnounced 语义保持（「卸载重载不重播」）：重载后 record 重建
      //（unpromotedDraft=false——已落库会话非草稿），promoteDraft 结构性守卫
      // no-op：instantiated 不双发、补广播分支不进（createdAnnounced 保持 false）
      const instantiatedBefore = countInstantiated(rig, a.sessionId);
      expect(instantiatedBefore).toBe(1);
      await rig.daemon.registry.get(a.sessionId); // 懒加载恢复
      const revived = recordOf(rig.daemon.registry, a.sessionId);
      expect(revived).toBeDefined();
      expect(revived!.unpromotedDraft).toBe(false); // 重载非草稿
      rig.daemon.registry.promoteDraft(a.sessionId); // 直调（守卫面）：no-op
      expect(countInstantiated(rig, a.sessionId)).toBe(instantiatedBefore); // instantiated 不双发
      expect(recordOf(rig.daemon.registry, a.sessionId)!.createdAnnounced).toBe(false); // 未进补广播分支
    } finally {
      await rig.dispose();
    }
  }, 15000);

  test("③ promoteDraft 路径：record 不销毁，纯字段翻转；重复直调幂等（instantiated 恰好一次）", async () => {
    const rig = await makeRig({ replies: [{ text: "转正路径回复" }] });
    try {
      const dir = rig.daemon.directory;
      const a = await dir.startDraftSession("转正路径会话");
      await until(() => rig.engineOf(a.sessionId).events.some((e) => e.type === "agent_end"), 5000, "首轮完成");

      // 字段翻转：unpromotedDraft→false（不再是草稿）、createdAnnounced→true
      //（draft 链显式广播已登记——转正补广播去重）；lastBroadcastRunState 基线在
      const record = recordOf(rig.daemon.registry, a.sessionId);
      expect(record).toBeDefined();
      expect(record!.unpromotedDraft).toBe(false);
      expect(record!.createdAnnounced).toBe(true);
      expect(record!.lastBroadcastRunState).toBeDefined();

      // record 不销毁（promoteDraft 零 delete——清理点 N→1 的机械判据）
      expect(rig.daemon.registry.peek(a.sessionId)).toBeDefined();

      // 重复直调幂等：守卫（unpromotedDraft=false）no-op——instantiated 恰好一次
      const instantiatedBefore = countInstantiated(rig, a.sessionId);
      expect(instantiatedBefore).toBe(1);
      rig.daemon.registry.promoteDraft(a.sessionId);
      expect(countInstantiated(rig, a.sessionId)).toBe(1);
      expect(recordOf(rig.daemon.registry, a.sessionId)!.createdAnnounced).toBe(true); // 状态不回退
    } finally {
      await rig.dispose();
    }
  }, 15000);
});
