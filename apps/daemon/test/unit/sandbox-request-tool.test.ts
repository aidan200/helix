import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
import { createSandboxRequestTool, type SandboxRequestToolDeps } from "../../src/adapters/driven/tools/sandbox-request/SandboxRequestTool";

function depsOf(overrides: Partial<SandboxRequestToolDeps> = {}): SandboxRequestToolDeps {
  return {
    ask: { request: async () => "approved" as const },
    sessionId: "s1",
    instanceId: "i1",
    unsandboxedExec: async () => ({ stdout: "ok\n", stderr: "", exitCode: 0 }),
    ...overrides,
  };
}

async function run(deps: SandboxRequestToolDeps, params = { command: "echo hi", reason: "r" }) {
  const tool = createSandboxRequestTool(deps);
  const result = await tool.execute("tc1", params, undefined as never, undefined as never, undefined as never, BACKGROUND_CONTEXT);
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("createSandboxRequestTool", () => {
  test("批准 → 裸跑执行，stdout 作工具结果返回（bash 同形态）", async () => {
    const text = await run(depsOf());
    expect(text).toBe("ok\n");
  });

  test("批准 → stderr 与 exit code 拼入结果", async () => {
    const text = await run(
      depsOf({ unsandboxedExec: async () => ({ stdout: "", stderr: "warn", exitCode: 3 }) }),
    );
    expect(text).toContain("[stderr]\nwarn");
    expect(text).toContain("[exit 3]");
  });

  test("批准 → 空输出回 (no output)", async () => {
    const text = await run(
      depsOf({ unsandboxedExec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
    );
    expect(text).toBe("(no output)");
  });

  test("拒绝 → 引导文案（不执行命令）", async () => {
    let executed = false;
    const text = await run(
      depsOf({
        ask: { request: async () => "denied" as const },
        unsandboxedExec: async () => {
          executed = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      }),
    );
    expect(executed).toBe(false);
    expect(text).toContain("用户拒绝");
    expect(text).toContain("改道沙箱内方案");
  });

  test("超时 → 超时引导文案（不执行命令）", async () => {
    let executed = false;
    const text = await run(
      depsOf({
        ask: { request: async () => "timeout" as const },
        unsandboxedExec: async () => {
          executed = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      }),
    );
    expect(executed).toBe(false);
    expect(text).toContain("超时自动拒绝");
  });

  test("申请发起失败 → 错误文案（不抛）", async () => {
    const text = await run(
      depsOf({
        ask: {
          request: async () => {
            throw new Error("已有挂起申请");
          },
        },
      }),
    );
    expect(text).toContain("越权申请未发起：已有挂起申请");
  });

  test("裸跑通道抛错 → 执行失败文案（不抛）", async () => {
    const text = await run(
      depsOf({
        unsandboxedExec: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    );
    expect(text).toBe("越权执行失败：spawn ENOENT");
  });

  test("申请携带会话/实例归属与命令理由（防伪造面）", async () => {
    let seen: { sessionId?: string; instanceId?: string; command?: string; reason?: string } = {};
    await run(
      depsOf({
        ask: {
          request: async (input) => {
            seen = input;
            return "denied" as const;
          },
        },
      }),
      { command: "brew install x", reason: "需要全局安装" },
    );
    expect(seen).toEqual({
      sessionId: "s1",
      instanceId: "i1",
      command: "brew install x",
      reason: "需要全局安装",
    });
  });
});
