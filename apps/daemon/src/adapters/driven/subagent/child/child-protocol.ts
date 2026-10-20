/**
 * 子进程协议面（P2 体量门 ④ 轻拆批：自 ChildMain.ts 机械迁出，零逻辑改动）。
 *
 * 三面同属「父子进程协议字面」：
 * ① stdout 行写出（wire 编码的单一写出点，writeLine）；
 * ② 收口协议解析（closure 字面块 / 围栏容错 / 判定链——engine 状态主信号，
 *    信封只是可选附注，见 TR-130「格式不判生死」）；
 * ③ stdin 父侧行读取与分派（send 注入 → steer；park/resume 协议标记 →
 *    挂起标志/唤醒；tool-res → RemoteBrowserPort）。
 *
 * 依赖方向单向：ChildMain（装配 + single-shot 驱动）→ 本模块。
 * 公共 API 面不变：ChildMain 原样 re-export 本模块导出符号，测试与消费方
 * 零感知。
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { encodeLine, parseParentLine } from "../transport/wire";
import type { ChildOutboundLine, ToolResponseLine } from "../transport/wire";
import { isParkInstruction, isResumeInstruction } from "../../../../application/services/scheduler/parkProtocol";
import type { InstanceClosurePayload } from "../../../../domain/events/DomainEvent";

// ── stdout 行写出 ──────────────────────────────────────────

export function writeLine(line: ChildOutboundLine): void {
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
 * 从 assistant 文本解析 `<<<CLOSURE {...} CLOSURE>>>` 块（字面协议）。
 * 无块 / 非法 JSON / status 非法 / summary 缺失 → undefined（判定链降级到
 * 围栏容错提取，再降级到 done 兑底——格式不判生死，task-8213de82）。
 *
 * 闭标记容错（task-778eb18a 三连败修复）：provider SSE 丢尾 delta 会
 * 精确截掉最后一个字符（6 样本 5 截，`CLOSURE>>>` → `CLOSURE>>`）——
 * 闭标记放宽为 ≥2 个 `>`，信封残缺但信件（JSON）完整即接受；开标记
 * 恰好 3 个 `<`（前置 `<` 不认：`<<<<CLOSURE` 不命中，低危批），
 * JSON 合法性仍是从严门梣（残缺标记 + 非法 JSON 照拒）。
 *
 * 多块取末（低危批）：末轮正文常把协议当示例引用（字面块 + 合法 JSON），
 * 首个匹配会把正文示例当真收口、顶掉文末真收口块（示例若写 failed 直接
 * 反转结论）。故扫全部匹配、从尾部取第一个合法块。
 */
const CLOSURE_BLOCK_RE = /(?<!<)<<<CLOSURE\s*([\s\S]*?)\s*CLOSURE>{2,}/g;

/** 单块 JSON → ParsedClosure（协议字段从严：status 二值 + summary 必填）。 */
function parseClosureJson(body: string): ParsedClosure | undefined {
  try {
    const raw = JSON.parse(body) as {
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

export function parseClosureBlock(text: string): ParsedClosure | undefined {
  const matches = [...text.matchAll(CLOSURE_BLOCK_RE)];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const parsed = parseClosureJson(matches[i]![1]!);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

// ── closure 兜底摘要（并入 engine 错误原因） ─────────

/**
 * 兜底 closure 摘要组装（engine 错误路径）：有 engine_error 原因时并入
 * 「（engine: <原因>）」段（原因不截断，透传 provider 原文）。80 截断仅
 * 施于 lastAssistantText。
 *
 * 前缀语义（task-8213de82 二轮事故修订）：走到这里的唯一形态是
 * lastEngineError 有值——run 以错误收场，与「closure 协议」无关；
 * 无 engine 错误的正常结束不再进本路径（buildClosureOutcome 按
 * engine 状态判 done，信封只是附注）。
 */
export function buildFallbackSummary(lastAssistantText: string, lastEngineError: string | undefined): string {
  const reason = lastEngineError !== undefined ? `（engine: ${lastEngineError}）` : "";
  return `engine 收口失败${reason}：${lastAssistantText.slice(0, 80)}`;
}

/**
 * 围栏容错提取（task-8213de82 二轮事故：9 实例 8 次信封失败，其中 6 次
 * 为代码围栏包裹——内容字段全对、外壳不合字面记号）。LLM 末轮输出用
 * markdown 围栏包裹结构化数据是训练分布先验，SOP 文本对抗无效——
 * 机械层吃容错，格式不再判生死。
 *
 * 认 ``\u0060\u0060\u0060closure / \u0060\u0060\u0060json / \u0060\u0060\u0060yaml 围栏：JSON 直取（嵌套 closure
 * 对象下钻一层），YAML 走逐行 `key: value` 简易提取（折叠标量不解析，
 * 字段缺省）；status 词表归一（success → done）。围栏内 status 缺省
 * done——走到提取层即外层已保证 run 正常且无 engine 错误。
 * 自由格式（无围栏）不硬凑 → undefined（交给 done 兜底）。
 */
export function extractFencedClosure(text: string): ParsedClosure | undefined {
  const fence = text.match(/```(?:closure|json|yaml)\s*\n([\s\S]*?)```/);
  if (!fence) return undefined;
  const body = fence[1]!;
  // JSON 路径（含嵌套 closure 对象下钻）
  try {
    let raw = JSON.parse(body) as Record<string, unknown>;
    if (raw.closure !== undefined && typeof raw.closure === "object" && raw.closure !== null) {
      raw = raw.closure as Record<string, unknown>;
    }
    const status = normalizeStatus(raw.status);
    if (status !== undefined || raw.summary !== undefined || raw.reportPath !== undefined) {
      return {
        status: status ?? "done",
        summary: typeof raw.summary === "string" ? raw.summary : "",
        reportPath: typeof raw.reportPath === "string" ? raw.reportPath : null,
        findings: Array.isArray(raw.findings) ? raw.findings : null,
        taskId: typeof raw.taskId === "string" ? raw.taskId : null,
      };
    }
  } catch {
    /* 非 JSON → YAML 简易路径 */
  }
  // YAML 简易路径：逐行 `key: value`（双重 CLOSURE 形态天然兼容——只认键）
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(status|summary|reportPath|taskId)\s*:\s*(.+)$/);
    if (m) fields.set(m[1]!, m[2]!.trim());
  }
  if (fields.size === 0) return undefined;
  const status = normalizeStatus(fields.get("status"));
  return {
    status: status ?? "done",
    summary: fields.get("summary") ?? "",
    reportPath: fields.get("reportPath") ?? null,
    findings: null,
    taskId: fields.get("taskId") ?? null,
  };
}

/** 围栏内 status 词表归一：done/failed 直取，success → done；其余 undefined。 */
function normalizeStatus(value: unknown): "done" | "failed" | undefined {
  if (value === "done" || value === "failed") return value;
  if (value === "success") return "done";
  return undefined;
}

// ── 收口判定链（engine 状态主信号 + 信封附注） ─────────────

/**
 * 收口判定（task-8213de82 二轮事故重构——「CLOSURE 只报告完成」的机械版）：
 *
 *   1. terminated（SIGTERM）→ failed
 *   2. 字面信封/围栏提取命中 → 采纳（含显式 failed 自报；engine_error
 *      为中间轮残留而末轮已成功收口的形态下，收口意图优先）
 *   3. lastEngineError 有值（run 以错误收场、无信封）→ failed
 *   4. 都不命中 → **done**（run 正常结束 = 完成信号；summary 取末轮
 *      文本截断）——此前这里判「未按 closure 协议收口」failed，9 实例
 *      8 次格式失败的直接来源
 *
 * reportPath 机械兜底：解析不到时探测 HELIX_REPORT_PATH 文件存在即用
 * （报告是 LLM 工具轮写的——文件在即事实，不依赖末轮申报）。
 * taskId 缺省回落 resolvedTaskId（批次归属机械注入，原逻辑保持）。
 */
export function buildClosureOutcome(input: {
  terminated: boolean;
  lastAssistantText: string;
  lastEngineError: string | undefined;
  resolvedTaskId: string | null;
  reportEnvPath: string | undefined;
}): InstanceClosurePayload {
  const { terminated, lastAssistantText, lastEngineError, resolvedTaskId, reportEnvPath } = input;
  if (terminated) {
    return { status: "failed", summary: "terminated by user（SIGTERM）", reportPath: null, findings: null, taskId: resolvedTaskId };
  }
  const parsed = parseClosureBlock(lastAssistantText) ?? extractFencedClosure(lastAssistantText);
  if (parsed !== undefined) {
    return {
      status: parsed.status,
      summary: parsed.summary !== "" ? parsed.summary : lastAssistantText.slice(0, 80),
      reportPath: parsed.reportPath ?? probeReportFile(reportEnvPath),
      findings: parsed.findings ?? null,
      taskId: parsed.taskId ?? resolvedTaskId,
    };
  }
  if (lastEngineError !== undefined) {
    return { status: "failed", summary: buildFallbackSummary(lastAssistantText, lastEngineError), reportPath: null, findings: null, taskId: resolvedTaskId };
  }
  return {
    status: "done",
    summary: lastAssistantText.slice(0, 80),
    reportPath: probeReportFile(reportEnvPath),
    findings: null,
    taskId: resolvedTaskId,
  };
}

/** reportPath 机械探测：env 落点文件存在才用（不悬空）。 */
function probeReportFile(reportEnvPath: string | undefined): string | null {
  if (reportEnvPath === undefined) return null;
  try {
    accessSync(reportEnvPath, fsConstants.F_OK);
    return reportEnvPath;
  } catch {
    return null;
  }
}

// ── stdin 父侧行读取（AD-7⑤ send → Agent.steer()；H-3 tool-res → RemoteBrowserPort；
//      park/resume 协议指令分派 → 挂起标志/唤醒） ──────

/** 协议指令分派结果（readStdin 消费面）。 */
export interface StdinDispatch {
  /** park 请求到达（置挂起标志 + steer 指令）。 */
  onPark: (text: string) => void;
  /** resume 到达（清挂起标志 + steer 指令 + 唤醒挂起等待）。 */
  onResume: (text: string) => void;
  /** 普通注入（含挂起期暂存——steer 队列内建缓冲，resume run 一并 drain）。 */
  onSteer: (text: string) => void;
}

export function readStdin(instanceId: string, dispatch: StdinDispatch, onToolRes: (line: ToolResponseLine) => void): void {
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of Bun.stdin.stream()) {
        // {stream:true}：多字节字符跨 chunk 边界不产 U+FFFD（否则坏行被
        // 静默丢弃——丢 tool-res 会让 RemoteBrowserPort 挂至超时）
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          const line = parseParentLine(raw);
          if (line) {
            if (line.type === "tool-res") onToolRes(line);
            else if (isParkInstruction(line.text)) dispatch.onPark(line.text);
            else if (isResumeInstruction(line.text)) dispatch.onResume(line.text);
            else dispatch.onSteer(line.text);
          } else writeLine({ type: "log", instanceId, text: `忽略无法解析的 stdin 行：${raw.slice(0, 60)}` });
        }
      }
    } catch {
      /* stdin 关闭：正常退出路径 */
    }
  })();
}
