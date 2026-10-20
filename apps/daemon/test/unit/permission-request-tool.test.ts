import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "../../src/adapters/driven/tools/vendor/pi-harness";
import {
  createPermissionRequestGatedTool,
  createPermissionRequestTool,
  type PermissionRequestToolDeps,
} from "../../src/adapters/driven/tools/permission-request/PermissionRequestTool";

function depsOf(overrides: Partial<PermissionRequestToolDeps> = {}): PermissionRequestToolDeps {
  return {
    ask: { request: async () => "approved" as const },
    sessionId: "s1",
    instanceId: "i1",
    unsandboxedExec: async () => ({ output: "ok\n", exitCode: 0 }),
    ...overrides,
  };
}

async function run(deps: PermissionRequestToolDeps, params = { command: "echo hi", reason: "r" }) {
  const tool = createPermissionRequestTool(deps);
  const result = await tool.execute("tc1", params, undefined as never, undefined as never, undefined as never, BACKGROUND_CONTEXT);
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("createPermissionRequestTool", () => {
  test("批准 → 裸跑执行，stdout 作工具结果返回（bash 同形态）", async () => {
    const text = await run(depsOf());
    expect(text).toBe("ok\n");
  });

  test("批准 → 合并输出 + exit code 拼入结果（pi exec 不分流：契约只声明 output）", async () => {
    const text = await run(
      depsOf({ unsandboxedExec: async () => ({ output: "warn", exitCode: 3 }) }),
    );
    expect(text).toBe("warn\n[exit 3]"); // 旧实现的 [stderr] 分支永不可达，已随契约收敛删除
    expect(text).not.toContain("[stderr]");
  });

  test("批准 → 空输出回 (no output)", async () => {
    const text = await run(
      depsOf({ unsandboxedExec: async () => ({ output: "", exitCode: 0 }) }),
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
          return { output: "", exitCode: 0 };
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
          return { output: "", exitCode: 0 };
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
    expect(text).toContain("提权申请未发起：已有挂起申请");
  });

  test("裸跑通道抛错 → 执行失败文案（不抛）", async () => {
    const text = await run(
      depsOf({
        unsandboxedExec: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    );
    expect(text).toBe("提权执行失败：spawn ENOENT");
  });

  test("申请携带会话/实例归属与命令理由（防伪造面）", async () => {
    let seen: { sessionId?: string; instanceId?: string; command?: string; reason?: string; kind?: string } = {};
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
      kind: "permission_request", // kind 判别位随申请上行（原语消费者分发键）
    });
  });

  test("auto_approved（提权自动通过）→ 裸跑执行 + 结果注记留痕", async () => {
    const text = await run(
      depsOf({ ask: { request: async () => "auto_approved" as const } }),
      { command: "npm i -g x", reason: "r" },
    );
    expect(text).toContain("ok\n");
    expect(text).toContain("自动通过");
    expect(text).toContain("未经用户确认");
  });

  test("auto_approved → 裸跑抛错也携注记（失败不吞留痕）", async () => {
    const text = await run(
      depsOf({
        ask: { request: async () => "auto_approved" as const },
        unsandboxedExec: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    );
    expect(text).toContain("提权执行失败：spawn ENOENT");
    expect(text).toContain("自动通过");
  });
});

describe("createPermissionRequestGatedTool（闸制版——审批在闸前完成）", () => {
  async function runGated(autoApprove?: () => boolean) {
    const tool = createPermissionRequestGatedTool({
      unsandboxedExec: async () => ({ output: "ok\n", exitCode: 0 }),
      ...(autoApprove !== undefined ? { autoApprove } : {}),
    });
    const result = await tool.execute("tc1", { command: "echo hi", reason: "r" }, undefined as never, undefined as never, undefined as never, BACKGROUND_CONTEXT);
    return result.content.map((c) => ("text" in c ? c.text : "")).join("");
  }

  test("autoApprove 开 → 裸跑结果附自动通过注记（execute 不接触 ask）", async () => {
    const text = await runGated(() => true);
    expect(text).toContain("ok\n");
    expect(text).toContain("自动通过");
    expect(text).toContain("未经用户确认");
  });

  test("autoApprove 关/缺省 → 零注记（用户确认过的执行不留自动通过痕）", async () => {
    expect(await runGated(() => false)).toBe("ok\n");
    expect(await runGated()).toBe("ok\n");
  });
});
