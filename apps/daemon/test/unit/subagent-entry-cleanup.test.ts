import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";

/**
 * M21 单元：SubagentLauncher children Map 延迟清理——exit+closure 双落定
 * 后延迟删除 entry（现状永不删除无界增长）。清理时机保守：
 * - 单落定（仅 closure 或仅 exit）不清理；
 * - 延迟窗口内 entry 仍可读（childPid/childExit 观测面 + launch 去重依赖
 *   children.has(id)，双落定即删会让同 id 立即可重 launch）。
 */

const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

interface EntryFace {
  transport: unknown;
  closed: boolean;
  exited: boolean;
}

interface PrivFace {
  children: Map<string, EntryFace>;
  reportClosure(id: string, outcome: unknown): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeLauncher(home: string): SubagentLauncher {
  return new SubagentLauncher({
    profile: SubAgentProfile,
    model: fakeModel,
    apiKeys: {},
    toolCwd: home,
    entryCleanupMs: 30, // 测试小值
  });
}

describe("M21：children entry exit+closure 双落定后延迟清理", () => {
  test("单落定不清理；双落定延迟窗口后删除（窗口内仍可读）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-m21-"));
    try {
      const launcher = makeLauncher(home);
      const priv = launcher as unknown as PrivFace;
      const entry: EntryFace = { transport: {}, closed: false, exited: false };
      priv.children.set("agent-1", entry);

      // 仅 closure 落定 → 不排期
      entry.closed = true;
      (launcher as unknown as { maybeScheduleEntryCleanup(id: string): void }).maybeScheduleEntryCleanup("agent-1");
      await sleep(60);
      expect(priv.children.has("agent-1")).toBe(true);

      // exit 也落定 → 排期：延迟窗口内仍在（观测面/launch 去重保守期）
      entry.exited = true;
      (launcher as unknown as { maybeScheduleEntryCleanup(id: string): void }).maybeScheduleEntryCleanup("agent-1");
      expect(priv.children.has("agent-1")).toBe(true);
      await sleep(60);
      expect(priv.children.has("agent-1")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reportClosure（closure 落定真实通路）+ 已 exit → 排期清理", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-m21-"));
    try {
      const launcher = makeLauncher(home);
      const priv = launcher as unknown as PrivFace;
      priv.children.set("agent-2", { transport: {}, closed: false, exited: true });
      priv.reportClosure("agent-2", {
        result: "done",
        closure: { status: "done", summary: "完成", reportPath: null, findings: null, taskId: null },
      });
      expect(priv.children.get("agent-2")!.closed).toBe(true);
      await sleep(60);
      expect(priv.children.has("agent-2")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("未 exit 的活跃实例（parked 驻留）不清理", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-m21-"));
    try {
      const launcher = makeLauncher(home);
      const priv = launcher as unknown as PrivFace;
      priv.children.set("agent-3", { transport: {}, closed: false, exited: false });
      (launcher as unknown as { maybeScheduleEntryCleanup(id: string): void }).maybeScheduleEntryCleanup("agent-3");
      await sleep(60);
      expect(priv.children.has("agent-3")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
