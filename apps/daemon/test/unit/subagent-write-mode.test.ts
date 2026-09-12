import { describe, expect, test } from "bun:test";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import type { WorktreeProvisionerPort } from "../../src/application/ports/outbound/WorktreeProvisionerPort";

/**
 * U3 spawn writes 三档：launcher 侧行为断言（纯 deps 桩，不起子进程——
 * spawnSnapshot 双参透传 / isolated provision→toolCwd 钉树→登记回拨 /
 * provision 失败→failed 收口 / shared 零变化）。provisioner 真行为见
 * worktree-provisioner.test.ts；快照减法派生见 buildSessionStack 装配测试。
 */

const mkInstance = (writeMode?: "readonly" | "shared" | "isolated"): AgentInstance =>
  AgentInstance.create({
    instanceId: `agent-${Math.random().toString(36).slice(2)}`,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "sess-t",
    createdAt: new Date().toISOString(),
    ...(writeMode !== undefined ? { writeMode } : {}),
  });

interface Harness {
  launcher: SubagentLauncher;
  snapshotCalls: Array<{ profileKind: string; writeMode?: string }>;
  provisioned: Array<{ slug: string; baseCwd: string }>;
  worktreeRegistered: Array<{ instanceId: string; path: string }>;
  closures: Array<{ instanceId: string; outcome: InstanceClosureOutcome }>;
}

const mkHarness = (provisioner?: WorktreeProvisionerPort): Harness => {
  const h = {
    snapshotCalls: [] as Array<{ profileKind: string; writeMode?: string }>,
    provisioned: [] as Array<{ slug: string; baseCwd: string }>,
    worktreeRegistered: [] as Array<{ instanceId: string; path: string }>,
    closures: [] as Array<{ instanceId: string; outcome: InstanceClosureOutcome }>,
    launcher: undefined as unknown as SubagentLauncher,
  };
  const launcher = new SubagentLauncher({
    profile: SubAgentProfile,
    apiKeys: { fake: "k" },
    model: undefined as never,
    toolCwd: "/tmp/fake-workspace",
    spawnSnapshot: (profileKind: string, writeMode?: string) => {
      h.snapshotCalls.push({ profileKind, writeMode });
      return { tools: ["read", "bash"], systemPrompt: "SP" };
    },
    ...(provisioner !== undefined
      ? {
          worktreeProvisioner: provisioner,
          onWorktreeProvisioned: (id: string, info: { path: string }) => {
            h.worktreeRegistered.push({ instanceId: id, path: info.path });
          },
        }
      : {}),
  } as never);
  launcher.setCallbacks({
    onInstanceEvent: () => {},
    onInstanceClosure: (id, outcome) => h.closures.push({ instanceId: id, outcome }),
  });
  h.launcher = launcher;
  return h;
};

describe("U3 spawn writes 三档（launcher 侧）", () => {
  test("shared（缺省）：spawnSnapshot 收到 undefined writeMode——零行为变化", () => {
    const h = mkHarness();
    h.launcher.launch(mkInstance(), "t");
    // doLaunch 同步走到 spawnSnapshot 即证明链路零变化（真子进程收尾由
    // dispose 兼底；桩 model 下子进程秒退不影响断言窗口）
    expect(h.snapshotCalls.length).toBe(1);
    expect(h.snapshotCalls[0]!.writeMode).toBeUndefined();
    void (h.launcher as unknown as { dispose?: () => void }).dispose?.();
  });

  test("readonly：spawnSnapshot 双参透传（组装面减工具的输入）", () => {
    const h = mkHarness();
    h.launcher.launch(mkInstance("readonly"), "t");
    expect(h.snapshotCalls[0]!.writeMode).toBe("readonly");
  });

  test("isolated：provision → toolCwd 钉树 → 登记回拨", async () => {
    const wtPath = "/tmp/fake-workspace/.worktrees/agent-iso";
    const h = mkHarness({
      provision: async (slug, baseCwd) => {
        h.provisioned.push({ slug, baseCwd });
        return { path: wtPath, branch: `helix/${slug}` };
      },
      remove: async () => true,
    });
    const inst = mkInstance("isolated");
    h.launcher.launch(inst, "t");
    // async 前置：等微任务队列排空
    await new Promise((r) => setTimeout(r, 10));
    expect(h.provisioned.length).toBe(1);
    expect(h.provisioned[0]!.baseCwd).toBe("/tmp/fake-workspace");
    expect(h.worktreeRegistered).toEqual([{ instanceId: inst.instanceId, path: wtPath }]);
    // doLaunch 走完（spawnSnapshot 已被调——writeMode 透传链完整）
    expect(h.snapshotCalls[0]!.writeMode).toBe("isolated");
  });

  test("isolated：provision 失败 → failed 收口（AD-8 异步交付，错误可见）", async () => {
    const h = mkHarness({
      provision: async () => ({ error: "工作目录不是 git 仓" }),
      remove: async () => true,
    });
    const inst = mkInstance("isolated");
    h.launcher.launch(inst, "t");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.closures.length).toBe(1);
    expect(h.closures[0]!.outcome.result).toBe("failed");
    expect(h.closures[0]!.outcome.closure.summary).toContain("不是 git 仓");
    expect(h.worktreeRegistered.length).toBe(0);
  });

  test("isolated：provisioner 未装配 → failed 收口（诚实报因）", async () => {
    const h = mkHarness(); // 无 provisioner
    const inst = mkInstance("isolated");
    h.launcher.launch(inst, "t");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.closures.length).toBe(1);
    expect(h.closures[0]!.outcome.closure.summary).toContain("未装配");
  });
});
