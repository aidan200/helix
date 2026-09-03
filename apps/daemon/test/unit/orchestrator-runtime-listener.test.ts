import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { TaskEnginePort } from "../../src/application/ports/inbound/TaskEnginePort";
import { createOrchestratorSessionFactory } from "../../src/infrastructure/assembly/orchestrator-runtime";
import type { WorkLedgerService } from "../../src/application/services/task/WorkLedgerService";

/**
 * 卡装配修复单测（task-8659b320）：编排会话 drive 的 listener 接线——
 * engine_error（模型调用失败/provider 原文）原先被 no-op listener 吞没，
 * 六分钟静默无从判别死活；现在经工厂 logger.warn 落 daemon.log。
 *
 * 最小装配：createOrchestratorSessionFactory + llmOverride 全覆盖 LLM 面
 * （error 剧本 streamFn），其余 deps 空实现（error 轮零工具调用）。
 */

const fakeModel = { id: "model", provider: "fake" } as unknown as Model<any>;
const fakeModels = {} as unknown as Models;
/** orchestration stub（error 轮零工具调用——仅满足工厂参数类型）。 */
const orchestrationStub = { spawn: () => ({ status: "rejected" as const, error: "stub" }) } as never;

/** error 剧本：assistant 消息 stopReason=error（PiAgentEngineAdapter 终验热修 → engine_error 事件）。 */
function errorStreamFn(message: string): StreamFn {
  const stopError = "error" as unknown as AssistantMessage["stopReason"];
  return () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: message }],
      stopReason: stopError,
      errorMessage: message, // pi 归一化的 provider 原文（errorMessageOf 提取源）
    } as unknown as AssistantMessage;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: assistant });
      stream.push({ type: "done", reason: "stop", message: assistant });
    })();
    return stream;
  };
}

function makeFactory(logger: { warn: (m: string) => void }) {
  // orchestration stub（error 轮零工具调用——仅满足工厂参数类型）
  return createOrchestratorSessionFactory({
    assembly: () => ({ tools: [], systemPrompt: "" }),
    model: () => fakeModel,
    apiKeys: () => ({ fake: "key" }),
    toolCwd: () => "/tmp",
    taskEngine: {} as unknown as TaskEnginePort,
    ledger: {} as unknown as WorkLedgerService,
    models: fakeModels,
    llmOverride: { model: () => fakeModel, streamFn: errorStreamFn("provider 502 upstream unavailable") },
    logger: { info: () => {}, warn: logger.warn, error: () => {} },
  });
}

describe("orchestrator-runtime drive listener：engine_error 经 logger 落日志（卡装配可观测性）", () => {
  test("模型 stopReason=error → drive 正常 resolve（不崩会话）+ logger.warn 收到 provider 原文", async () => {
    const warns: string[] = [];
    const factory = makeFactory({ warn: (m) => warns.push(m) });
    const session = factory("job-obs-1", orchestrationStub);
    await session.drive("kickoff");
    expect(warns.some((w) => w.includes("engine_error") && w.includes("job-obs-1") && w.includes("provider 502 upstream unavailable"))).toBe(true);
  });

  test("无 logger 注入（缺省）→ engine_error 静默但不抛（向后兼容不破）", async () => {
    const factory = createOrchestratorSessionFactory({
      assembly: () => ({ tools: [], systemPrompt: "" }),
      model: () => fakeModel,
      apiKeys: () => ({ fake: "key" }),
      toolCwd: () => "/tmp",
      taskEngine: {} as unknown as TaskEnginePort,
      ledger: {} as unknown as WorkLedgerService,
      models: fakeModels,
      llmOverride: { model: () => fakeModel, streamFn: errorStreamFn("x") },
    });
    const session = factory("job-obs-2", orchestrationStub);
    await expect(session.drive("kickoff")).resolves.toBeUndefined();
  });
});

describe("orchestrator-runtime 事件镜像（eventSink）：引擎事件翻译落盘供 trace 查询", () => {
  const fakeClock = { now: () => new Date().toISOString(), nowMs: () => Date.now() };

  test("注入 eventSink → engine_error 翻译为 engine.error 领域事件（sessionId=task:<jobId>，instanceId=orchestrator，原文入载荷）", async () => {
    const events: { type: string; sessionId: string; instanceId?: string; payload: unknown }[] = [];
    const factory = createOrchestratorSessionFactory({
      assembly: () => ({ tools: [], systemPrompt: "" }),
      model: () => fakeModel,
      apiKeys: () => ({ fake: "key" }),
      toolCwd: () => "/tmp",
      taskEngine: {} as unknown as TaskEnginePort,
      ledger: {} as unknown as WorkLedgerService,
      models: fakeModels,
      llmOverride: { model: () => fakeModel, streamFn: errorStreamFn("provider 502 upstream unavailable") },
      eventSink: { publish: (e) => events.push(e as never), clock: fakeClock },
    });
    const session = factory("job-sink-1", orchestrationStub);
    await session.drive("kickoff");
    const engineError = events.find((e) => e.type === "engine.error");
    expect(engineError).toBeDefined();
    expect(engineError!.sessionId).toBe("task:job-sink-1");
    expect(engineError!.instanceId).toBe("orchestrator");
    expect((engineError!.payload as { message: string }).message).toContain("provider 502 upstream unavailable");
  });

  test("未注入 eventSink（缺省）→ 零事件发布（现状兼容，纯 logger 形态）", async () => {
    // 缺省形态已由上一 describe 两用例覆盖（drive 正常 resolve 不崩）；
    // 本用例锁定「无 sink 不产事件」的边界：工厂无 eventSink 参 → 无回调面可观测，
    // 等价断言 = drive resolve 且不抛（翻译器未装配零副作用）。
    const factory = createOrchestratorSessionFactory({
      assembly: () => ({ tools: [], systemPrompt: "" }),
      model: () => fakeModel,
      apiKeys: () => ({ fake: "key" }),
      toolCwd: () => "/tmp",
      taskEngine: {} as unknown as TaskEnginePort,
      ledger: {} as unknown as WorkLedgerService,
      models: fakeModels,
      llmOverride: { model: () => fakeModel, streamFn: errorStreamFn("x") },
    });
    const session = factory("job-sink-2", orchestrationStub);
    await expect(session.drive("kickoff")).resolves.toBeUndefined();
  });
});
