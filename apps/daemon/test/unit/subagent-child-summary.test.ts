import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFallbackSummary } from "../../src/adapters/driven/subagent/child/ChildMain";
import { SchedulerService } from "../../src/application/services/SchedulerService";
import type { InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";

/**
 * T1.2 / F1.2：closure 兜底摘要并入 engine 错误原因（test-design §CL-1）。
 * 纯函数直测 buildFallbackSummary 双路径 + 截断语义（不依赖剧本引擎；
 * scriptedEngine error 形态属 T1.4 交付）。
 */
describe("buildFallbackSummary（closure 兜底摘要，F1.2）", () => {
  test("错误轮：有 engine 原因时含「（engine: <原因>）」且原因非空", () => {
    const summary = buildFallbackSummary("", "provider 429 quota exceeded");
    expect(summary).toBe("未按 closure 协议收口（engine: provider 429 quota exceeded）：");
  });

  test("错误轮：lastAssistantText 非空时文本段拼接在原因之后", () => {
    const summary = buildFallbackSummary("半截输出", "boom");
    expect(summary).toBe("未按 closure 协议收口（engine: boom）：半截输出");
  });

  test("非错误轮：无 engine 原因时与现状格式逐字节一致（回归锚定）", () => {
    expect(buildFallbackSummary("有些文本", undefined)).toBe("未按 closure 协议收口：有些文本");
    expect(buildFallbackSummary("", undefined)).toBe("未按 closure 协议收口：");
  });

  test("截断语义：lastAssistantText 超 80 字符截断，engine 原因不截断", () => {
    const longText = "字".repeat(120);
    const longReason = "r".repeat(200);
    const summary = buildFallbackSummary(longText, longReason);
    expect(summary).toBe(`未按 closure 协议收口（engine: ${longReason}）：${"字".repeat(80)}`);
  });
});

/** 最小 InstanceRunner 替身：只接住回调，不真驱动实例。 */
class StubRunner implements InstanceRunner {
  callbacks?: InstanceRunnerCallbacks;
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(): void {
    /* 收口由测试手动回调 */
  }
}

describe("F1.2 锚 2 抽样：兜底 summary 单源直通消费面（reports md / SteerQueue 注入 / agent.failed.error）", () => {
  test("closure.summary 携 engine 原因 → reports md 与 SteerQueue 注入文本含相同原因", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t12-summary-"));
    const writeQueue = new WriteQueue(path.join(home, "helix.db"));
    const repository = new SqliteSessionRepository(writeQueue);
    const events: DomainEvent[] = [];
    const publisher: EventPublisherPort = { publish: (e) => events.push(e), publishDelta: () => undefined };
    const injected: string[] = [];
    const runner = new StubRunner();
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy(),
      runner,
      events: publisher,
      repository,
      clock: { now: () => "2024-01-01T00:00:00.000Z", nowMs: () => Date.now() },
      reportsDirFor: () => path.join(home, "reports"),
      injectClosure: (_agentId, message) => injected.push(message),
      stalledPollMs: 100,
    });
    try {
      const outcome = scheduler.spawn("s-t12", "错误轮任务");
      expect(outcome.status).toBe("run");
      // 单源：ChildMain 兜底产出的 summary（与回调内 lastEngineError 捕获同构）
      const summary = buildFallbackSummary("", "provider 429 quota exceeded");
      runner.callbacks!.onInstanceClosure("agent-1", {
        result: "failed",
        closure: { status: "failed", summary, reportPath: null, findings: null, taskId: null },
      });

      // 消费面① reports md（O-5 双产物之报告文件）
      await writeQueue.flush();
      const reportMd = readFileSync(path.join(home, "reports", "agent-1.md"), "utf8");
      expect(reportMd).toContain("（engine: provider 429 quota exceeded）");

      // 消费面② SteerQueue 注入主线文本
      expect(injected).toHaveLength(1);
      expect(injected[0]).toContain("（engine: provider 429 quota exceeded）");

      // 消费面③ agent.failed 事件 error 字段（缺省取 closure.summary）
      const failed = events.find((e) => e.type === "agent.failed")!;
      expect((failed.payload as { error: string }).error).toContain("（engine: provider 429 quota exceeded）");
    } finally {
      scheduler.stop();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
