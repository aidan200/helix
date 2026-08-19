/**
 * ChildMain —— SubAgent 子进程入口（O-7 候选 A 形态，T2.2）。
 *
 * 装配即同构（TR-AD-4 零 kind 分支）：复用 PiAgentEngineAdapter（内含
 * AgentRuntime + SubAgentProfile 声明装配），不另起驱动层。流程：
 *
 *   argv/env 解析（--task / HELIX_MODEL_JSON 透传 / HELIX_API_KEYS_JSON /
 *   HELIX_TOOL_CWD / HELIX_FAKE_ENGINE_SCRIPT 剧本注入 K3）
 *     → PiAgentEngineAdapter + SubAgentProfile 装配
 *     → started 行（含 pid + model 回显）
 *     → stdin send 行 → engine.steer()（AD-7⑤：Agent.steer() 内建队列）
 *     → 单次驱动 engine.start(task)（single-shot，不进 persistent 循环）
 *     → 最后一条 assistant 文本解析 closure 块（五字段）→ closure 行 → exit(0)
 *     → SIGTERM（O-6 优雅路径）→ abort → failed(terminated) closure → exit(0)
 *     → 任何异常 → crash 行 → exit(1)（父侧崩溃检测判 failed）
 *
 * 本模块只在 `bun run ChildMain.ts` 直跑时执行 main（import.meta.main 守卫，
 * 测试可导入 parseClosureBlock 单测）。
 */
import type { Model } from "@earendil-works/pi-ai";
import { PiAgentEngineAdapter } from "../../pi-engine/PiAgentEngineAdapter";
import { SubAgentProfile } from "../../pi-engine/runtime/profiles/SubAgentProfile";
import { CoreToolExecutor } from "../../tools/CoreToolExecutor";
import { encodeLine, parseSendLine } from "../transport/wire";
import type { ChildOutboundLine, SendLine } from "../transport/wire";
import { loadFakeEngineScript, makeScriptedStreamFn } from "./scriptedEngine";
import type { FakeEngineScript } from "./scriptedEngine";
import type { InstanceClosurePayload } from "../../../../domain/events/DomainEvent";

// ── argv/env 解析 ──────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function writeLine(line: ChildOutboundLine): void {
  process.stdout.write(encodeLine(line));
}

// ── closure 块解析（收口协议） ─────────────────────────────

/** closure 块解析结果（五字段，可选字段归一 null——全字段必发纪律）。 */
export interface ParsedClosure {
  readonly status: "done" | "failed";
  readonly summary: string;
  readonly reportPath: string | null;
  readonly findings: unknown[] | null;
  readonly taskId: string | null;
}

/**
 * 从 assistant 文本解析 `<<<CLOSURE {...} CLOSURE>>>` 块。
 * 无块 / 非法 JSON / status 非法 / summary 缺失 → undefined（调用方按
 * 「未按 closure 协议收口」failed 处理）。
 */
export function parseClosureBlock(text: string): ParsedClosure | undefined {
  const match = text.match(/<<<CLOSURE\s*([\s\S]*?)\s*CLOSURE>>>/);
  if (!match) return undefined;
  try {
    const raw = JSON.parse(match[1]!) as {
      status?: unknown;
      summary?: unknown;
      reportPath?: unknown;
      findings?: unknown;
      taskId?: unknown;
    };
    if ((raw.status !== "done" && raw.status !== "failed") || typeof raw.summary !== "string") {
      return undefined;
    }
    return {
      status: raw.status,
      summary: raw.summary,
      reportPath: typeof raw.reportPath === "string" ? raw.reportPath : null,
      findings: Array.isArray(raw.findings) ? raw.findings : null,
      taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    };
  } catch {
    return undefined;
  }
}

// ── closure 兜底摘要（F1.2：并入 engine 错误原因） ─────────

/**
 * 兜底 closure 摘要组装（T1.2）：有 engine_error 原因时并入
 * 「（engine: <原因>）」段（原因不截断，透传 provider 原文）；无原因时
 * 保持现状格式逐字节不变（非错误轮回归锚定）。80 截断仅施于
 * lastAssistantText。
 */
export function buildFallbackSummary(lastAssistantText: string, lastEngineError: string | undefined): string {
  const reason = lastEngineError !== undefined ? `（engine: ${lastEngineError}）` : "";
  return `未按 closure 协议收口${reason}：${lastAssistantText.slice(0, 80)}`;
}

// ── stdin send 行读取（AD-7⑤：send → Agent.steer()） ──────

function readStdin(instanceId: string, onSend: (line: SendLine) => void): void {
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of Bun.stdin.stream()) {
        buf += decoder.decode(chunk as Uint8Array);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          const send = parseSendLine(raw);
          if (send) onSend(send);
          else writeLine({ type: "log", instanceId, text: `忽略无法解析的 stdin 行：${raw.slice(0, 60)}` });
        }
      }
    } catch {
      /* stdin 关闭：正常退出路径 */
    }
  })();
}

// ── 主流程 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const task = argValue("--task") ?? "";
  const instanceId = process.env.HELIX_INSTANCE_ID ?? "agent-?";
  const modelJson = process.env.HELIX_MODEL_JSON;
  if (!modelJson) throw new Error("缺少 HELIX_MODEL_JSON（父进程未透传完整 Model 对象，F-14）");
  const model = JSON.parse(modelJson) as Model<any>;
  const apiKeys = JSON.parse(process.env.HELIX_API_KEYS_JSON ?? "{}") as Record<string, string>;
  const toolCwd = process.env.HELIX_TOOL_CWD ?? process.cwd();
  const scriptPath = process.env.HELIX_FAKE_ENGINE_SCRIPT;
  const script: FakeEngineScript | undefined = scriptPath !== undefined ? loadFakeEngineScript(scriptPath) : undefined;

  // 装配（TR-AD-4：与主引擎同一防腐墙同一 runtime，仅 profile 声明不同）
  const executor = new CoreToolExecutor({ cwd: toolCwd });
  const engine = new PiAgentEngineAdapter({
    profile: SubAgentProfile,
    model, // F-14：env JSON 解析的完整对象透传（与父侧深度相等）
    apiKeys,
    ...(script ? { streamFnOverride: makeScriptedStreamFn(script, model) } : {}),
    resolveTools: (names) => executor.resolveTools(names),
  });

  // O-6 优雅路径：SIGTERM → abort 当前 run → drive 收敛 → failed closure → exit(0)
  let terminated = false;
  process.on("SIGTERM", () => {
    terminated = true;
    engine.abort();
  });

  let lastAssistantText = "";
  let lastEngineError: string | undefined; // F1.2：多轮错误取末条 engine_error message（单变量覆盖）
  writeLine({ type: "started", instanceId, pid: process.pid, model });
  readStdin(instanceId, (send) => engine.steer(send.text));

  // single-shot：驱动一次 run（含 steer drain 轮），结束即收口
  await engine.start(task, (event) => {
    if (event.type === "message_end" && event.role === "assistant" && event.stopReason !== "error") {
      lastAssistantText = event.text;
    }
    if (event.type === "engine_error") {
      lastEngineError = event.message;
    }
    writeLine({ type: "event", instanceId, event });
  });

  const closure: InstanceClosurePayload = terminated
    ? {
        status: "failed",
        summary: "terminated by user（SIGTERM）",
        reportPath: null,
        findings: null,
        taskId: null,
      }
    : (parseClosureBlock(lastAssistantText) ?? {
        status: "failed",
        summary: buildFallbackSummary(lastAssistantText, lastEngineError),
        reportPath: null,
        findings: null,
        taskId: null,
      });
  writeLine({ type: "closure", instanceId, closure });
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stdout.write(
      encodeLine({
        type: "crash",
        instanceId: process.env.HELIX_INSTANCE_ID ?? "agent-?",
        error: err instanceof Error ? err.message : String(err),
      } satisfies ChildOutboundLine),
    );
    process.exit(1);
  });
}
