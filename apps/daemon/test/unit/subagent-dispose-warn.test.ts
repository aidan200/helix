import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";

/**
 * T1.3 单元（TP-1.3a #4）：SubagentLauncher.ts:224 dispose kill 吞错
 * 可观测（源 R-2.3——`entry.transport.kill().catch(() => undefined)` 吞掉
 * 子进程 kill 拒绝，shutdown 收尾失败零日志）。
 *
 * 现实面：ChildProcessTransport.kill 全路径 try/catch 内吞、实践不 reject
 * ——:224 是对 transport 契约（InstanceRunner.kill 可拒绝）的防御吞错。
 * 测试经 children 私面注入 kill 失败的 transport 桩（transport = 子进程
 * I/O 外部边界，边界桩合规；被测单元 dispose() 不 mock），断言 warn 含
 * [subagent] 定位 + 实例 id + 错误信息，且 dispose 不抛（收尾不崩）。
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

describe("TP-1.3a #4 SubagentLauncher.dispose kill 失败 → logger.warn", () => {
  test("transport.kill reject → warn 含 [subagent] + 实例 id + 错误信息；dispose 不抛", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t13-launcher-"));
    try {
      const warns: string[] = [];
      const launcher = new SubagentLauncher({
        profile: SubAgentProfile,
        model: fakeModel,
        apiKeys: {},
        toolCwd: home,
        logger: { warn: (m) => warns.push(m) },
      });

      // 边界桩：kill 拒绝的 transport（children 私面注入——真实子进程
      // kill 路径全内吞不 reject，无法自然触发该防御分支）
      const children = (
        launcher as unknown as {
          children: Map<string, { transport: { kill(): Promise<unknown> } }>;
        }
      ).children;
      children.set("agent-9", {
        transport: { kill: () => Promise.reject(new Error("kill 信号失败（注入）")) },
      });

      await launcher.dispose(); // 不抛 = 收尾不崩语义保持

      const msg = warns.find((m) => m.includes("[subagent]"));
      expect(msg).toBeDefined();
      expect(msg!.includes("agent-9")).toBe(true);
      expect(msg!.includes("kill 信号失败（注入）")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
