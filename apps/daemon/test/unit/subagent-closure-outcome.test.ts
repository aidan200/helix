import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildClosureOutcome,
  buildFallbackSummary,
  extractFencedClosure,
} from "../../src/adapters/driven/subagent/child/ChildMain";

/**
 * 收口判定新语义（task-8213de82 二轮事故：9 实例 8 次信封格式失败）：
 * done/failed 主信号 = engine 运行状态（terminated / lastEngineError），
 * 信封降级为可选附注（字面 → 围栏容错提取 → 无则 done 兜底）。
 *
 * 本文件用该任务的 8 条真实失败样本做 golden——它们此前全部被
 * 「未按 closure 协议收口」判 failed 烧尽重试预算，新语义下围栏 6 条
 * 应恢复 done+附注、自由格式 2 条应 done 兜底。
 */

// ── 真实失败样本（task-8213de82 closure_records 原文摘录） ──

/** 样本①：```closure 围栏包 JSON（agent-c8fe 原文形态）。 */
const FENCED_CLOSURE_JSON = `台账 6/6 全 resolve。批次 2.1 幂等重跑收口：

\`\`\`closure
{
  "status": "done",
  "summary": "daemon domain 层批次评审完成，23 条 findings 前轮已回放"
}
\`\`\``;

/** 样本②：```yaml 围栏 + YAML 语法 + 双重 CLOSURE（agent-49ba 原文形态）。 */
const FENCED_YAML_DOUBLE = `CLOSURE:

\`\`\`yaml
CLOSURE:
  status: success
  summary: 批次 2.2 评审完成：apps/daemon domain 批次零阻断
\`\`\``;

/** 样本③：```json 围栏 + 嵌套 closure 对象（agent-cf1d 原文形态）。 */
const FENCED_JSON_NESTED = `\`\`\`json
{
  "closure": {
    "status": "success",
    "summary": "apps/daemon/src 批次评审完成"
  }
}
\`\`\``;

/** 样本④：```yaml 围栏 + reportPath 附注（agent-a8bc 原文形态）。 */
const FENCED_YAML_REPORT = `\`\`\`yaml
CLOSURE:
  status: success
  summary: 批次 2.2 评审完成：daemon domain 批次
  reportPath: /tmp/reports/agent-x.md
\`\`\``;

/** 样本⑤：自由格式——markdown 标题收口（agent-8021 原文形态）。 */
const FREEFORM_HEADING = `# kg-review L2 实体册评审批次完成（batch-61974c19）

**评审 8/8 零遗漏｜发现 3 条 candidate（修改）｜scene 缺失已补全。`;

/** 样本⑥：自由格式——散文收口（agent-ad51 原文形态）。 */
const FREEFORM_PROSE = `台账 3/3 全 resolve。批次 2.1 收口：

本批为第 3 次派发的幂等重跑：前两轮评审结论（23 条 findings）经三轮累计 20+ 条次证伪核验，结论稳定。`;

// ── extractFencedClosure（围栏容错提取） ──

describe("extractFencedClosure（围栏容错——task-8213de82 真实样本 golden）", () => {
  test("样本① ```closure 围栏 JSON：status/summary 直取", () => {
    const parsed = extractFencedClosure(FENCED_CLOSURE_JSON);
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe("done");
    expect(parsed!.summary).toContain("23 条 findings");
    expect(parsed!.reportPath).toBeNull();
  });

  test("样本② 双重 CLOSURE + ```yaml：status success 归一 done，YAML 行提取", () => {
    const parsed = extractFencedClosure(FENCED_YAML_DOUBLE);
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe("done"); // success → done 归一
    expect(parsed!.summary).toContain("批次 2.2 评审完成");
  });

  test("样本③ ```json 嵌套 closure 对象：下钻一层提取", () => {
    const parsed = extractFencedClosure(FENCED_JSON_NESTED);
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe("done");
    expect(parsed!.summary).toBe("apps/daemon/src 批次评审完成");
  });

  test("样本④ ```yaml 带 reportPath：指针附注一并提取", () => {
    const parsed = extractFencedClosure(FENCED_YAML_REPORT);
    expect(parsed).toBeDefined();
    expect(parsed!.reportPath).toBe("/tmp/reports/agent-x.md");
  });

  test("围栏内无 status 字段 → 缺省 done（走到提取即 run 正常）", () => {
    const parsed = extractFencedClosure('工作总结。\n\n```closure\n{"summary": "完成但没写状态"}\n```');
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe("done");
  });

  test("围栏内显式 failed → 尊重（LLM 自报失败不被容错吞掉）", () => {
    const parsed = extractFencedClosure('```closure\n{"status": "failed", "summary": "无法完成：依赖缺失"}\n```');
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe("failed");
  });

  test("自由格式（无围栏无结构）→ undefined（交给 done 兜底，不硬凑）", () => {
    expect(extractFencedClosure(FREEFORM_HEADING)).toBeUndefined();
    expect(extractFencedClosure(FREEFORM_PROSE)).toBeUndefined();
  });

  test("字面信封存在时不误入围栏路径（字面协议优先级在外层保证，此处只验不重复命中）", () => {
    // 字面信封会被 parseClosureBlock 先命中；extractFencedClosure 对纯字面
    // 形态（无围栏）返回 undefined——不与字面路径竞争。
    expect(extractFencedClosure('<<<CLOSURE\n{"status":"done","summary":"字面"}\nCLOSURE>>>')).toBeUndefined();
  });
});

// ── buildClosureOutcome（判定链：engine 状态主信号 + 信封附注） ──

describe("buildClosureOutcome（判定链新语义）", () => {
  const base = { resolvedTaskId: null as string | null, reportEnvPath: undefined as string | undefined };

  test("run 正常 + 无信封 → done（engine 状态主信号——此前这里判 failed 烧尽重试）", () => {
    const outcome = buildClosureOutcome({ ...base, terminated: false, lastAssistantText: FREEFORM_PROSE, lastEngineError: undefined });
    expect(outcome.status).toBe("done");
    expect(outcome.summary).toContain("台账 3/3 全 resolve"); // 末轮文本截断兜底
  });

  test("run 正常 + 围栏收口 → done + 附注提取", () => {
    const outcome = buildClosureOutcome({ ...base, terminated: false, lastAssistantText: FENCED_CLOSURE_JSON, lastEngineError: undefined });
    expect(outcome.status).toBe("done");
    expect(outcome.summary).toContain("23 条 findings");
  });

  test("run 正常 + 字面信封 → 信封语义优先（显式 failed 尊重）", () => {
    const outcome = buildClosureOutcome({
      ...base,
      terminated: false,
      lastAssistantText: '<<<CLOSURE\n{"status":"failed","summary":"自报无法完成"}\nCLOSURE>>>',
      lastEngineError: undefined,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toBe("自报无法完成");
  });

  test("engine 报错（429）→ failed（engine 收口失败——真实事故中 38 条 rate-limit 形态）", () => {
    const outcome = buildClosureOutcome({
      ...base,
      terminated: false,
      lastAssistantText: "半截输出",
      lastEngineError: '429: {"code":"1308","message":"已达到 5 小时的使用上限"}',
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("429");
  });

  test("SIGTERM → failed terminated（不变语义）", () => {
    const outcome = buildClosureOutcome({ ...base, terminated: true, lastAssistantText: "任意", lastEngineError: undefined });
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("terminated");
  });

  test("无信封 done + reportEnvPath 文件存在 → 机械补指针", () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-closure-probe-"));
    try {
      const reportPath = path.join(home, "agent-1.md");
      writeFileSync(reportPath, "## 报告\n完成。", "utf8");
      const outcome = buildClosureOutcome({
        resolvedTaskId: null,
        reportEnvPath: reportPath,
        terminated: false,
        lastAssistantText: FREEFORM_HEADING,
        lastEngineError: undefined,
      });
      expect(outcome.status).toBe("done");
      expect(outcome.reportPath).toBe(reportPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("无信封 done + reportEnvPath 文件不存在 → reportPath null（不悬空）", () => {
    const outcome = buildClosureOutcome({
      resolvedTaskId: null,
      reportEnvPath: "/tmp/不存在的报告路径/agent-1.md",
      terminated: false,
      lastAssistantText: "完成",
      lastEngineError: undefined,
    });
    expect(outcome.status).toBe("done");
    expect(outcome.reportPath).toBeNull();
  });

  test("taskId 缺省回落 resolvedTaskId（批次归属机械注入）", () => {
    const outcome = buildClosureOutcome({
      resolvedTaskId: "job-1",
      reportEnvPath: undefined,
      terminated: false,
      lastAssistantText: "完成",
      lastEngineError: undefined,
    });
    expect(outcome.taskId).toBe("job-1");
  });
});

// ── buildFallbackSummary（engine 错误路径——前缀语义更新） ──

describe("buildFallbackSummary（engine 错误收口失败摘要）", () => {
  test("engine 原因并入且非空", () => {
    const summary = buildFallbackSummary("", "provider 429 quota exceeded");
    expect(summary).toContain("engine: provider 429 quota exceeded");
    expect(summary).toContain("失败");
  });

  test("末轮文本拼接 + 80 截断，engine 原因不截断", () => {
    const longText = "字".repeat(120);
    const longReason = "r".repeat(200);
    const summary = buildFallbackSummary(longText, longReason);
    expect(summary).toContain(`engine: ${longReason}`);
    expect(summary.endsWith("字".repeat(80))).toBe(true);
  });
});
