import { describe, expect, test } from "bun:test";
import type {
  AgentHarnessTool,
  AgentHarnessToolInvocation,
  ExecutionToolContext,
} from "../../src/adapters/driven/tools/vendor/pi-harness";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import type { LoopToolCallContext } from "../../src/domain/loop";

/**
 * 工具桥单测（helix-loop Phase 4 / C 缺口；设计 §7.3）：CoreToolExecutor
 * .resolveLoopTools——pi 六参 AgentHarnessTool → loop 域 LoopToolRegistration
 * （LoopToolHandler 两参形状）投影面。断言面：
 * 1. 签名适配：handler(args, ctx) 内六参装配同源（toolCallId/params/
 *    toolContext={env}/invocation/context——与现役 execute 同一装配链
 *    bindToolContext，非桥内另写一套）；
 * 2. args schema 前置校验：typebox 校验失败投影 isError result（pi 校验
 *    失败文案形态），且 pi execute 不被调用（前置拒）；
 * 3. onUpdate 转发：pi onUpdate partialResult 流 → ctx.onUpdate 文本投影，
 *    单枚内 FIFO（语义定稿 R1.10）；
 * 4. 错误投影：pi execute throw → isError result（不抛出——ToolRegistry
 *    dispatch 异常归一的前置面）；
 * 5. terminate 透传：pi result.terminate → LoopToolOutcome terminate 判别
 *    （防火墙语义面）；
 * 6. image 结果投影文案：content 内 image 块 → (image) 占位（textOfResult
 *    同源行为）；
 * 7. LLM 可见面投影：name/description/parameters 承自 pi 工具声明；
 *    未注册名 fail-fast（与 resolveTools 同解析链）。
 */

/** probe 工具的 JSON schema（自写工具同款手写形态——typebox 校验兼容）。 */
const echoParameters = {
  type: "object",
  properties: {
    text: { type: "string", description: "回显文本" },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

/** probe 记录的六参实参（装配面观测）。 */
interface Probe {
  calls: number;
  toolCallId?: string;
  params?: unknown;
  onUpdate?: unknown;
  toolContext?: unknown;
  invocation?: AgentHarnessToolInvocation;
  context?: unknown;
}

function executorWith(tools: readonly AgentHarnessTool<ExecutionToolContext, any, any>[]): CoreToolExecutor {
  // mcp 批注入是注册表最轻真体路径（构造注册零条件族依赖；假工具不触 env IO，
  // cwd 指向 /tmp 仅作 NodeExecutionEnv 构造参数）
  return new CoreToolExecutor({ cwd: "/tmp", mcp: { tools } });
}

/** 单工具投影非空守卫（noUncheckedIndexedAccess 下解构索引位可能 undefined）。 */
function singleProjection(executor: CoreToolExecutor, name: string) {
  const [registration] = executor.resolveLoopTools([name]);
  if (registration === undefined) throw new Error(`投影缺失：${name}`);
  return registration;
}

function loopCtx(overrides?: Partial<LoopToolCallContext>): LoopToolCallContext {
  return {
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "fake_echo",
    args: { text: "hi" },
    ...overrides,
  };
}

describe("工具桥 resolveLoopTools：签名适配与装配", () => {
  test("六参同源装配：handler(args, ctx) 经 bindToolContext 闭包装配（toolCallId/params/{env}/invocation/context），结果投影 result", async () => {
    const probe: Probe = { calls: 0 };
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "测试投影工具（回显 text）",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async (toolCallId, params, onUpdate, toolContext, invocation, context) => {
        probe.calls += 1;
        probe.toolCallId = toolCallId;
        probe.params = params;
        probe.onUpdate = onUpdate;
        probe.toolContext = toolContext;
        probe.invocation = invocation;
        probe.context = context;
        return { content: [{ type: "text", text: `回显:${(params as { text: string }).text}` }], details: undefined };
      },
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");

    const outcome = await registration.handler({ text: "hi" }, loopCtx());

    expect(probe.calls).toBe(1);
    expect(probe.toolCallId).toBe("call-1");
    expect(probe.params).toEqual({ text: "hi" });
    // toolContext = executor 共享 {env}（同源装配——非桥内另造）
    expect((probe.toolContext as { env?: unknown }).env).toBeDefined();
    // invocation 占位实现：invocationId = toolCallId（与 execute() 同源）
    expect(probe.invocation?.invocationId).toBe("call-1");
    expect(probe.context).toBeDefined();
    expect(outcome).toEqual({ kind: "result", text: "回显:hi", isError: undefined });
  });

  test("ctx.signal 透传（经闭包折进 chord Context——smoke：传入后正常收尾不炸）", async () => {
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "d",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");
    const controller = new AbortController();
    const outcome = await registration.handler({ text: "hi" }, loopCtx({ signal: controller.signal }));
    expect(outcome).toEqual({ kind: "result", text: "ok", isError: undefined });
  });
});

describe("工具桥 resolveLoopTools：args schema 前置校验", () => {
  test("缺 required 字段 → isError result（pi 校验失败文案形态），pi execute 不被调用", async () => {
    const probe: Probe = { calls: 0 };
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "d",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async () => {
        probe.calls += 1;
        return { content: [{ type: "text", text: "不该到这里" }], details: undefined };
      },
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");

    const outcome = await registration.handler({}, loopCtx({ args: {} }));

    expect(probe.calls).toBe(0);
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") {
      expect(outcome.isError).toBe(true);
      // pi 校验失败文案形态（pi-ai validateToolArguments 抛错文案直投——
      // 与 pi agent-loop prepareToolCall 的 immediate error 分支同构）
      expect(outcome.text).toContain('Validation failed for tool "fake_echo"');
      expect(outcome.text).toContain("text");
    }
  });
});

describe("工具桥 resolveLoopTools：onUpdate 转发（R1.10 单枚内 FIFO）", () => {
  test("pi onUpdate partialResult 流 → ctx.onUpdate 文本投影依序转发（跨 await 间隔保序）", async () => {
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "d",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async (_id, _params, onUpdate) => {
        onUpdate?.({ content: [{ type: "text", text: "第一段" }], details: undefined });
        await Promise.resolve(); // 模拟执行中途异步间隔（序不被微任务打乱）
        onUpdate?.({ content: [{ type: "text", text: "第二段" }], details: undefined });
        onUpdate?.({ content: [{ type: "text", text: "第三段" }], details: undefined });
        return { content: [{ type: "text", text: "完成" }], details: undefined };
      },
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");
    const received: string[] = [];
    const outcome = await registration.handler(
      { text: "hi" },
      loopCtx({ onUpdate: (partial) => received.push(partial) }),
    );

    expect(received).toEqual(["第一段", "第二段", "第三段"]);
    expect(outcome).toEqual({ kind: "result", text: "完成", isError: undefined });
  });

  test("ctx.onUpdate 缺席时 pi onUpdate 仍可安全调用（noop 语义，不炸）", async () => {
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "d",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async (_id, _params, onUpdate) => {
        onUpdate?.({ content: [{ type: "text", text: "进展" }], details: undefined });
        return { content: [{ type: "text", text: "完成" }], details: undefined };
      },
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");
    const outcome = await registration.handler({ text: "hi" }, loopCtx());
    expect(outcome).toEqual({ kind: "result", text: "完成", isError: undefined });
  });
});

describe("工具桥 resolveLoopTools：错误与 terminate 投影", () => {
  test("pi execute throw → isError result（error.message 直投，不抛出）", async () => {
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "d",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async () => {
        throw new Error("boom：命令失败");
      },
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");
    const outcome = await registration.handler({ text: "hi" }, loopCtx());
    expect(outcome).toEqual({ kind: "result", text: "boom：命令失败", isError: true });
  });

  test("pi result.terminate === true → LoopToolOutcome terminate 判别（防火墙语义面透传）", async () => {
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "d",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async () => ({
        content: [{ type: "text", text: "propose_send 已拒绝：run 终止" }],
        details: undefined,
        terminate: true,
      }),
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");
    const outcome = await registration.handler({ text: "hi" }, loopCtx());
    expect(outcome).toEqual({ kind: "terminate", reason: "propose_send 已拒绝：run 终止" });
  });
});

describe("工具桥 resolveLoopTools：结果 content 投影", () => {
  test("image 块 → (image) 占位文案（textOfResult 同源），text 块拼接保留", async () => {
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "d",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async () => ({
        content: [
          { type: "text", text: "截图如下" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        details: undefined,
      }),
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");
    const outcome = await registration.handler({ text: "hi" }, loopCtx());
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") {
      expect(outcome.text).toBe("截图如下\n(image)");
      expect(outcome.isError).not.toBe(true);
    }
  });
});

describe("工具桥 resolveLoopTools：LLM 可见面与解析链", () => {
  test("name/description/parameters 承自 pi 工具声明（LLM function calling 面对齐）", () => {
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "回显文本（测试用）",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
    };
    const registration = singleProjection(executorWith([tool]), "fake_echo");
    expect(registration.name).toBe("fake_echo");
    expect(registration.description).toBe("回显文本（测试用）");
    expect(registration.parameters).toBe(echoParameters);
  });

  test("未注册名 fail-fast（与 resolveTools 同解析链同文案形态）", () => {
    const executor = executorWith([]);
    expect(() => executor.resolveLoopTools(["nope"])).toThrow('工具 "nope" 不在注册表');
  });

  test("投影产物可直接注册 ToolRegistry（形状兼容 domain/loop 消费面）", async () => {
    const { ToolRegistry } = await import("../../src/domain/loop");
    const tool: AgentHarnessTool<ExecutionToolContext, any, any> = {
      name: "fake_echo",
      label: "回显",
      description: "d",
      parameters: echoParameters as unknown as AgentHarnessTool<ExecutionToolContext, any, any>["parameters"],
      execute: async (_id, params) => ({
        content: [{ type: "text", text: `回显:${(params as { text: string }).text}` }],
        details: undefined,
      }),
    };
    const registry = new ToolRegistry();
    for (const registration of executorWith([tool]).resolveLoopTools(["fake_echo"])) {
      registry.register(registration);
    }
    expect(registry.names()).toEqual(["fake_echo"]);
    const dispatched = await registry.dispatch("fake_echo", { text: "hi" }, loopCtx());
    expect(dispatched).toEqual({
      ok: true,
      outcome: { kind: "result", text: "回显:hi", isError: undefined },
    });
  });
});
