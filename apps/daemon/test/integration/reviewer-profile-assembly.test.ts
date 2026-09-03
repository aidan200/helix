import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Daemon } from "../../src/infrastructure/container";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";
import { SUBAGENT_KG_WRITER_PROMPT_SUFFIX } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import type { InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";

/** 挂起 runner（launch 空转——本文件只观测 spawn 快照落盘，不驱动收口）。 */
class HangingRunner implements InstanceRunner {
  setCallbacks(_callbacks: InstanceRunnerCallbacks): void {
    /* 本文件不消费实例回调 */
  }
  launch(): void {
    /* 挂起 */
  }
  kill(): void {
    /* 幂等空操作 */
  }
}

/**
 * D5 快照装配派发（生产组合根路径，TR-TEST-5）：buildSessionStack
 * subagentAssemblyFor 按实例 profileKind 派发——
 * - subagent-code-reviewer 生效集 = worker 生效集 − write/edit（代码写面
 *   机械关闭）+ 评审纪律后缀；computeKgWriterAssembly 同构 compute 函数；
 * - subagent-kg-writer / subagent-worker 派发不回归。
 * 观测面 = agent.instantiated 落盘事件的 profileSnapshot（与 launch 实际
 * 注入同源同时点——spawn 快照消费链的唯一可信读面）。
 */

/** 直读同 home 的 SQLite（domain_events 断言；WAL 并发读安全）。 */
function openRepo(home: string): SqliteSessionRepository {
  return new SqliteSessionRepository(new WriteQueue(path.join(home, "helix.db")));
}

async function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Rig {
  home: string;
  sessionId: string;
  daemon: Daemon;
  runner: HangingRunner;
  dispose: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-reviewer-asm-"));
  const engine = new FakeAgentEngine();
  const runner = new HangingRunner();
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    kgWorkspaceRoot: home, // 隔离真实 kg 项目（密闭性）
  });
  return {
    home,
    sessionId: daemon.system.getStatus().sessionId,
    daemon,
    runner,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** spawn 后读 agent.instantiated 落盘 profileSnapshot（tools/systemPrompt）。 */
async function snapshotOf(rig: Rig, agentId: string): Promise<{ tools: string[]; systemPrompt: string }> {
  await until(
    () =>
      openRepo(rig.home)
        .queryEvents({ sessionId: rig.sessionId })
        .some((e) => e.type === "agent.instantiated" && (e.payload as { instanceId?: string }).instanceId === agentId),
    5000,
    `agent.instantiated 落盘（${agentId}）`,
  );
  const hit = openRepo(rig.home)
    .queryEvents({ sessionId: rig.sessionId })
    .find((e) => e.type === "agent.instantiated" && (e.payload as { instanceId?: string }).instanceId === agentId)!;
  const snap = (hit.payload as { profileSnapshot: { tools: string[]; systemPrompt: string } }).profileSnapshot;
  return snap;
}

let current: Rig | undefined;
afterEach(async () => {
  if (current) {
    await current.dispose();
    current = undefined;
  }
});

describe("D5 快照装配派发：subagentAssemblyFor 按 profileKind 派发生效集", () => {
  test("subagent-code-reviewer 快照 = worker 生效集 − write/edit + 评审纪律后缀", async () => {
    const rig = (current = await makeRig());
    const outcome = rig.daemon.orchestration.spawn("评审 demo 项目", "subagent-code-reviewer");
    if (outcome.status !== "run") throw new Error(`spawn 被拒：${JSON.stringify(outcome)}`);
    const snap = await snapshotOf(rig, outcome.agentId);
    // 代码写面机械关闭：write/edit 恒不在生效集
    expect(snap.tools).not.toContain("write");
    expect(snap.tools).not.toContain("edit");
    // 保留面：bash（报告/findings 旁路 + linter）与只读查询面
    for (const name of ["bash", "read", "grep", "kg", "codegraph", "plan_create", "plan_update", "plan_read"]) {
      expect(snap.tools).toContain(name);
    }
    expect(snap.tools).not.toContain("kg-update");
    // 生效集恰为 worker 声明面 − write/edit（缺省全启用）
    expect(snap.tools).toEqual(SubAgentProfile.tools.filter((t) => t !== "write" && t !== "edit"));
    // 评审纪律后缀在快照 prompt（派生不复制）
    expect(snap.systemPrompt).toContain(SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX);
    expect(snap.systemPrompt).not.toContain(SUBAGENT_KG_WRITER_PROMPT_SUFFIX);
  });

  test("subagent-worker / subagent-kg-writer 派发不回归（worker 含 write/edit；kg-writer 含 kg-update）", async () => {
    const rig = (current = await makeRig());
    const worker = rig.daemon.orchestration.spawn("普通任务", "subagent-worker");
    const kgw = rig.daemon.orchestration.spawn("图谱产出任务", "subagent-kg-writer");
    if (worker.status !== "run" || kgw.status !== "run") throw new Error("spawn 被拒");
    const workerSnap = await snapshotOf(rig, worker.agentId);
    const kgwSnap = await snapshotOf(rig, kgw.agentId);
    expect(workerSnap.tools).toContain("write");
    expect(workerSnap.tools).toContain("edit");
    expect(kgwSnap.tools).toEqual([...SubAgentProfile.tools, "kg-update"]);
    expect(kgwSnap.systemPrompt).toContain(SUBAGENT_KG_WRITER_PROMPT_SUFFIX);
  });
});
