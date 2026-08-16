/**
 * O-7 spike ⑥：SubAgent 子进程原型（候选 A）——子进程入口 ChildMain 原型。
 *
 * 验证目标（最高风险四步的后三步在子进程侧）：
 *  1) 进程内装配**真实** AgentRuntime（TR-AD-4 同构：无 kind 分支，profile 声明式）；
 *  2) task 来自 argv、model 来自 env JSON 透传（F-14 对象透传）、剧本来自 env 路径（K3）；
 *  3) stdin JSON 行 {"type":"send"} → AgentRuntime.steer() → Agent.steer()（AD-7⑤ 新实现）；
 *  4) 引擎事件逐条 stdout 上行（挂 instanceId）、run 结束解析 closure 回传、exit(0)；
 *  5) SIGTERM → abort → closure failed(terminated) → exit(0)（O-6 优雅路径）。
 *
 * 一次性验证代码（不进 daemon src 四层）；协议形状即后续 transport 契约草案。
 */
import { readFileSync } from "node:fs";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "../apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime";
import type { AgentProfile } from "../apps/daemon/src/adapters/driven/pi-engine/runtime/AgentProfile";
import { SteerHooks } from "../apps/daemon/src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";
import { MinimalHooks } from "../apps/daemon/src/adapters/driven/pi-engine/runtime/hooks/MinimalHooks";

// ── argv/env 解析 ──────────────────────────────────────────
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const task = argValue("--task") ?? "（spike 缺省任务）";
const instanceId = process.env.HELIX_INSTANCE_ID ?? "agent-spike";
const model = JSON.parse(process.env.HELIX_MODEL_JSON ?? "{}") as Model<any>;
const scriptPath = process.env.HELIX_FAKE_ENGINE_SCRIPT;
const script: { replies: string[]; chunkDelayMs?: number } = scriptPath
  ? JSON.parse(readFileSync(scriptPath, "utf8"))
  : { replies: ["（spike 无剧本）"] };

// ── stdout JSON 行协议（子→父：event / closure；父→子 stdin：send） ──
function writeLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ── 剧本化 streamFn（FakeLLM 同构：无网络，按 4 字符分片流式） ──
function assistantMessage(text: string, stopReason: "stop" | "aborted" = "stop", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

const replies = [...script.replies];
const streamFn: StreamFn = (_m, _ctx, opts) => {
  const reply = replies.shift() ?? "（剧本耗尽）";
  const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
  const stream = createAssistantMessageEventStream();
  const final = assistantMessage(reply);
  void (async () => {
    stream.push({ type: "start", partial: final });
    for (let i = 0; i < reply.length; i += 4) {
      // 信号感知：模拟真实 provider 的 abort 行为（throwIfAborted → aborted 消息收尾）
      if (signal?.aborted) {
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage(reply.slice(0, i), "aborted", "The operation was aborted."),
        });
        return;
      }
      await new Promise((r) => setTimeout(r, script.chunkDelayMs ?? 6));
      stream.push({ type: "text_delta", contentIndex: 0, delta: reply.slice(i, i + 4), partial: final });
    }
    stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: final });
    stream.push({ type: "done", reason: "stop", message: final });
  })();
  return stream;
};

// ── SubAgentProfile 原型（single-shot + SteerHooks） ───────
const SubAgentSpikeProfile: AgentProfile = {
  kind: "subagent-worker",
  systemPrompt:
    "你是 helix 的 SubAgent worker。专注完成单个任务；运行中可能收到注入的补充指示（优先遵守）。" +
    "任务完成时必须在最后输出 closure 块：\n" +
    "<<<CLOSURE\n" +
    '{"status":"done|failed","summary":"一句话结论"}\n' +
    "CLOSURE>>>",
  tools: [],
  lifecycle: { mode: "single-shot" },
  hooks: [new SteerHooks(), new MinimalHooks()],
};

// ── 装配 + 事件上行 ────────────────────────────────────────
const runtime = new AgentRuntime(SubAgentSpikeProfile, {
  streamFn,
  model,
  getApiKey: () => "spike-fake-key",
});

let lastAssistantText = "";
runtime.subscribe((event: AgentEvent) => {
  // 薄上行：类型 + 消息文本（真实实现转发完整 AgentEngineEvent）
  if (event.type === "message_end" && (event as { message: { role: string } }).message.role === "assistant") {
    const msg = (event as unknown as { message: { content: Array<{ type: string; text?: string }> } }).message;
    lastAssistantText = msg.content.map((c) => c.text ?? "").join("");
  }
  if (event.type === "message_start" || event.type === "message_end" || event.type === "message_update") {
    const e = event as unknown as { message?: { role: string; content: unknown } };
    const text =
      typeof e.message?.content === "string"
        ? e.message.content
        : Array.isArray(e.message?.content)
          ? (e.message!.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
          : "";
    writeLine({ type: "event", instanceId, event: { type: event.type, role: e.message?.role, text: text.slice(0, 40) } });
  } else {
    writeLine({ type: "event", instanceId, event: { type: event.type } });
  }
});

// ── stdin 行读取：{"type":"send","text"} → Agent.steer() ──
let stdinBuf = "";
async function readStdin(): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    stdinBuf += decoder.decode(chunk as Uint8Array);
    let nl: number;
    while ((nl = stdinBuf.indexOf("\n")) >= 0) {
      const line = stdinBuf.slice(0, nl).trim();
      stdinBuf = stdinBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { type: string; text?: string };
        if (msg.type === "send" && typeof msg.text === "string") {
          runtime.steer(msg.text); // ★ AD-7⑤：send → Agent.steer()（内建队列）
          writeLine({ type: "steered", instanceId, text: msg.text });
        }
      } catch {
        writeLine({ type: "log", instanceId, text: `stdin 非法行：${line.slice(0, 60)}` });
      }
    }
  }
}

// ── SIGTERM（O-6 优雅路径）：abort → run 收尾 → failed closure → exit ──
let terminated = false;
process.on("SIGTERM", () => {
  terminated = true;
  runtime.abort();
});

// ── 驱动一次 → closure 解析回传 → exit(0) ──────────────────
function parseClosure(text: string): { status: string; summary: string } | undefined {
  const m = text.match(/<<<CLOSURE\s*([\s\S]*?)\s*CLOSURE>>>/);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(m[1]!) as { status?: unknown; summary?: unknown };
    if (typeof parsed.status === "string" && typeof parsed.summary === "string") return parsed as { status: string; summary: string };
  } catch {
    /* 解析失败按无 closure 处理 */
  }
  return undefined;
}

async function main(): Promise<void> {
  writeLine({ type: "started", instanceId, pid: process.pid, pgidHint: "detached" });
  void readStdin();
  await runtime.drive(task);
  const closure = terminated
    ? { status: "failed", summary: "terminated by user（SIGTERM）" }
    : (parseClosure(lastAssistantText) ?? { status: "failed", summary: `子进程未按 closure 协议收口：${lastAssistantText.slice(0, 60)}` });
  writeLine({ type: "closure", instanceId, closure });
  process.exit(0);
}

main().catch((err) => {
  writeLine({ type: "crash", instanceId, error: String(err) });
  process.exit(1);
});
