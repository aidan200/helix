import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ChatService } from "../../src/application/services/ChatService";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";

/**
 * TP-CL5-3（I）：剧本 S2 —— 五工具会话内闭环。
 *
 * 链路：ChatService（编排/ToolCallRecord）→ PiAgentEngineAdapter（防腐）→
 * AgentRuntime（真 pi agentLoop）→ resolveTools 绑定的真工具（tmp 沙箱 cwd）
 * → 工具结果回注 loop 上下文 → FakeLLM 第二次调用**基于真实结果**续写。
 *
 * FakeLLM 是模型替身（M2 级 mock，test-design §5.1）：它的「发起」是脚本，
 * 但「执行」与「回注」都是真的——续写文本从 context 里的 toolResult 内容
 * 构建，含真实文件内容/退出码即证明闭环成立。
 */

// ── FakeLLM（模型替身：发起工具调用 / 基于真实结果续写） ──────────

type ScriptEntry =
  | { kind: "tool"; toolName: string; args: Record<string, unknown> }
  | { kind: "reply"; build: (toolResults: string[]) => string };

const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages" as Api,
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const fakeModels = {
  getModel: (provider: string, id: string) =>
    provider === "fake" && id === "model" ? fakeModel : undefined,
  getModels: (provider: string) => (provider === "fake" ? [fakeModel] : []),
  streamSimple: () => {
    throw new Error("不应走到真实流（streamFnOverride 未生效）");
  },
} as unknown as Models;

function baseAssistant(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fake",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function textMessage(text: string): AssistantMessage {
  return baseAssistant([{ type: "text", text }], "stop");
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return baseAssistant([{ type: "toolCall", id, name, arguments: args }], "toolUse");
}

/** 收集 context 中全部 toolResult 文本（结果回注的可观测面）。 */
function toolResultTexts(context: Context): string[] {
  return context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) =>
      m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    );
}

/** 剧本化 streamFn：tool 条目→发起调用；reply 条目→基于真实结果续写。 */
function makeToolScriptedLLM(entries: ScriptEntry[]): StreamFn {
  let seq = 0;
  return (_model, context, _options) => {
    const entry = entries.shift() ?? { kind: "reply" as const, build: () => "（剧本耗尽）" };
    const message =
      entry.kind === "tool"
        ? toolCallMessage(`call-${++seq}`, entry.toolName, entry.args)
        : textMessage(entry.build(toolResultTexts(context as Context)));
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

// ── 测试装配（ChatService + 真 pi 引擎 + 真工具，全落 tmp 沙箱） ────

interface LoopHarness {
  chat: ChatService;
  events: DomainEvent[];
  cwd: string;
}

/** 本次进程创建的沙箱目录（afterAll 统一回收——TR-TEST-6 零残留，T4.3 补）。 */
const sandboxes: string[] = [];

function makeHarness(scripts: ScriptEntry[]): LoopHarness {
  const cwd = mkdtempSync(join(tmpdir(), "helix-t15-loop-"));
  sandboxes.push(cwd);
  const executor = new CoreToolExecutor({
    cwd,
    orchestration: {
      // T2.3：MainSessionProfile 声明编排三工具——工具循环测试不驱动调度，
      // 注入 no-op 编排口保持 resolveTools 可装配
      spawn: () => ({ status: "rejected", error: "工具循环测试不驱动调度" }),
      send: () => ({ delivered: false, detail: "工具循环测试不驱动调度" }),
      status: () => [],
      kill: () => ({ killed: false, error: "工具循环测试不驱动调度" }),
    },
  });
  const engine = new PiAgentEngineAdapter({
    profile: MainSessionProfile,
    model: fakeModel,
    apiKeys: { fake: "explicit-key" },
    models: fakeModels,
    streamFnOverride: makeToolScriptedLLM(scripts),
    resolveTools: (names) => executor.resolveTools(names),
  });
  const events: DomainEvent[] = [];
  const publisher: EventPublisherPort = {
    publish: (e) => void events.push(e),
    publishDelta: () => undefined,
  };
  const chat = new ChatService({
    engine,
    events: publisher,
    clock: { now: () => "2026-08-15T00:00:00.000Z", nowMs: () => Date.parse("2026-08-15T00:00:00.000Z") },
  });
  return { chat, events, cwd };
}

/** 取某工具最近一次 tool.call.result 领域事件。 */
function lastToolResult(events: DomainEvent[], toolName: string) {
  const hits = events.filter(
    (e) => e.type === "tool.call.result" && (e.payload as { toolName: string }).toolName === toolName,
  );
  return hits.at(-1) as { payload: { isError: boolean; result: string } } | undefined;
}

function assistantTexts(chat: ChatService): string[] {
  return chat.sessionSnapshot.entries.flatMap((e) =>
      "role" in e && e.role === "assistant" ? [e.text] : [],
    );
}

// ── S2：五工具逐一闭环 + bash exit≠0 变体 ──────────────────────

describe("TP-CL5-3：剧本 S2 —— 五工具「调用→真实执行→回注→续写」闭环", () => {
  test("read：读取文件 → 内容回注 → 模型基于内容回答", async () => {
    const { chat, events, cwd } = makeHarness([
      { kind: "tool", toolName: "read", args: { path: "note.txt" } },
      { kind: "reply", build: (rs) => `文件内容是：${rs.at(-1) ?? "?"}` },
    ]);
    writeFileSync(join(cwd, "note.txt"), "HELIX-S2-READ-42 演示文件\n", "utf8");

    await chat.sendMessage("读取 note.txt 并告诉我内容");

    const tr = lastToolResult(events, "read");
    expect(tr?.payload.isError).toBe(false);
    expect(tr?.payload.result).toContain("HELIX-S2-READ-42"); // 真实执行结果
    expect(assistantTexts(chat).at(-1)).toContain("HELIX-S2-READ-42"); // 续写依赖真实结果
  });

  test("bash：命令执行 → stdout 回注 → 模型基于输出回答", async () => {
    const { chat, events } = makeHarness([
      { kind: "tool", toolName: "bash", args: { command: "echo HELIX-S2-BASH-55" } },
      { kind: "reply", build: (rs) => `命令输出：${rs.at(-1) ?? "?"}` },
    ]);

    await chat.sendMessage("运行 echo 命令并复述输出");

    const tr = lastToolResult(events, "bash");
    expect(tr?.payload.isError).toBe(false);
    expect(tr?.payload.result).toContain("HELIX-S2-BASH-55");
    expect(assistantTexts(chat).at(-1)).toContain("HELIX-S2-BASH-55");
  });

  test("write：调用 → 文件真实落盘 → 模型确认", async () => {
    const { chat, events, cwd } = makeHarness([
      { kind: "tool", toolName: "write", args: { path: "written.txt", content: "HELIX-S2-WRITE-66" } },
      { kind: "reply", build: (rs) => `写入完成：${rs.at(-1) ?? "?"}` },
    ]);

    await chat.sendMessage("把标记写入 written.txt");

    expect(readFileSync(join(cwd, "written.txt"), "utf8")).toBe("HELIX-S2-WRITE-66"); // 磁盘副作用
    const tr = lastToolResult(events, "write");
    expect(tr?.payload.isError).toBe(false);
    expect(assistantTexts(chat).at(-1)).toContain("written.txt");
  });

  test("edit：调用 → 磁盘替换生效 → 模型确认", async () => {
    const { chat, events, cwd } = makeHarness([
      {
        kind: "tool",
        toolName: "edit",
        args: { path: "target.txt", edits: [{ oldText: "TODO", newText: "DONE-HELIX-77" }] },
      },
      { kind: "reply", build: (rs) => `编辑完成：${rs.at(-1) ?? "?"}` },
    ]);
    writeFileSync(join(cwd, "target.txt"), "前缀\nTODO\n后缀\n", "utf8");

    await chat.sendMessage("把 target.txt 里的 TODO 改掉");

    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("前缀\nDONE-HELIX-77\n后缀\n");
    const tr = lastToolResult(events, "edit");
    expect(tr?.payload.isError).toBe(false);
    expect(assistantTexts(chat).at(-1)).toContain("编辑完成");
  });

  test("grep（自写工具）：目录搜索 → 命中行回注 → 模型基于命中回答", async () => {
    const { chat, events, cwd } = makeHarness([
      { kind: "tool", toolName: "grep", args: { pattern: "HELIX-S2-GREP-88", path: "." } },
      { kind: "reply", build: (rs) => `命中的行：${rs.at(-1) ?? "?"}` },
    ]);
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/marker.ts"), "export const m = 'HELIX-S2-GREP-88';\n", "utf8");
    writeFileSync(join(cwd, "src/other.md"), "无关文件\n", "utf8");

    await chat.sendMessage("搜索哪个文件包含标记");

    const tr = lastToolResult(events, "grep");
    expect(tr?.payload.isError).toBe(false);
    expect(tr?.payload.result).toContain("src/marker.ts:1");
    expect(assistantTexts(chat).at(-1)).toContain("src/marker.ts:1"); // 续写含真实命中行
  });

  test("bash 变体 exit≠0：error 工具结果回注 → ToolCallRecord 走 failed 事件路径 → 模型基于错误续写", async () => {
    const { chat, events } = makeHarness([
      { kind: "tool", toolName: "bash", args: { command: "exit 9" } },
      { kind: "reply", build: (rs) => `命令失败（${rs.at(-1) ?? "?"}），我换个思路` },
    ]);

    await chat.sendMessage("跑一个注定失败的命令");

    const tr = lastToolResult(events, "bash");
    expect(tr?.payload.isError).toBe(true); // error 记录（T1.7 error 卡数据源）
    expect(tr?.payload.result).toContain("exited with code 9");
    expect(assistantTexts(chat).at(-1)).toContain("exited with code 9"); // 模型看到错误并续写
  });

  test("同一会话连续两轮工具调用（常驻多轮）：read → bash 依次闭环", async () => {
    const { chat, events, cwd } = makeHarness([
      { kind: "tool", toolName: "read", args: { path: "a.txt" } },
      { kind: "reply", build: (rs) => `A=${rs.at(-1) ?? "?"}` },
      { kind: "tool", toolName: "bash", args: { command: "echo HELIX-S2-SECOND-99" } },
      { kind: "reply", build: (rs) => `B=${rs.at(-1) ?? "?"}` },
    ]);
    writeFileSync(join(cwd, "a.txt"), "HELIX-S2-FIRST-11", "utf8");

    await chat.sendMessage("读 a.txt");
    await chat.sendMessage("跑一条 echo");

    expect(assistantTexts(chat).some((t) => t.includes("HELIX-S2-FIRST-11"))).toBe(true);
    expect(assistantTexts(chat).some((t) => t.includes("HELIX-S2-SECOND-99"))).toBe(true);
    expect(lastToolResult(events, "read")?.payload.isError).toBe(false);
    expect(lastToolResult(events, "bash")?.payload.isError).toBe(false);
  });
});

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});
