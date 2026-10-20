import {
  CodemodeSandbox,
  loadQuickJSWasm,
  type CodemodeTool as SandboxCodemodeTool,
} from "@earendil-works/pi-codemode";
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import type {
  AgentHarnessTool,
  AgentHarnessToolInvocation,
  AgentToolResult,
  Context,
  ExecutionToolContext,
} from "../../tools/vendor/pi-harness";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../tools/vendor/pi-harness";

/**
 * codemode 工具（pi-codemode 接入批）：模型写 JavaScript 在 QuickJS 沙箱里
 * 编排其他工具调用——链式调用、Promise.all 并行扇出、循环批处理、大结果
 * 过滤。核心收益（官方配方）：**嵌套调用的中间结果不进 LLM 上下文**，只有
 * 脚本的输出与返回值返回。
 *
 * 沙箱事实（pi-codemode 宿主保证）：每次 execute 新 worker + 新 VM（失控
 * 脚本 terminate 即杀不污染后续）、单 bridge 原始值过界、SharedArrayBuffer
 * 中断标志（Bun terminate 杀不死 wasm 自旋的修复）、限额内建（输出 16Mi 字符
 * /10 万条、store 256Ki 单值）。无 Node/文件系统/网络/定时器——唯一能力是
 * 调用注入的工具。
 *
 * 嵌套调用执行面：直接调 harness 工具六参 execute（同 executor 共享
 * context——env 沙箱/写钩子全数生效）；沙箱的中止信号透传为 chord Context。
 * v1 边界：不经 agent 管线（beforeToolCall 钩子面不嵌套）——由下方排除集
 * 兜住审批面；外层工具轮的 abort 信号未接线（timeout 兜底；signal 链路归
 * S3 透传批）。
 */

/** 沙箱不可编排面（排除集——审批/编排/重型副作用语义不进脚本）：
 * - codemode 自身（防嵌套递归）；
 * - permission_request：审批闸语义（beforeToolCall 用户卡片批准后才执行）——
 *   嵌套直执 = 绕过用户审批跑沙箱外命令，安全面硬排除；
 * - agent_* 编排六件：脚本化 spawn 风暴/挂起恢复语义复杂，不进沙箱；
 * - task_create：任务创建 = 对话即确认的重型副作用（起编排/派子进程/落台账），
 *   脚本循环里创造任务是逐调用引导的绕过面（低危批补入）；
 * - coord_claim / coord_release：占用协调是决策动作（谁在改哪块），脚本循环
 *   抢/放占用会让协调事实与真实工作脱节（coord_query 只读，保留可编排）。 */
const CODEMODE_SANDBOX_EXCLUSIONS: ReadonlySet<string> = new Set([
  "codemode",
  "permission_request",
  "agent_spawn",
  "agent_send",
  "agent_status",
  "agent_inspect",
  "agent_park",
  "agent_resume",
  "task_create",
  "coord_claim",
  "coord_release",
]);

/** codemode 工具名（profile 声明面 / 排除集自引用）。 */
export const CODEMODE_TOOL_NAME = "codemode";

/** AbortSignal → chord Context（BACKGROUND_CONTEXT 同 CoreToolExecutor 私有助手语义）。 */
function contextOfSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);
}

/** 嵌套调用的 invocation 占位（无备忘能力——同 CoreToolExecutor.noopInvocation 语义）。 */
function invocationOf(id: string): AgentHarnessToolInvocation {
  return {
    invocationId: id,
    operationId: id,
    turnId: id,
    getMemo: () => Promise.resolve(undefined),
    setMemo: () => Promise.resolve(),
  };
}

export interface CodemodeToolDeps {
  /** 沙箱工具面读面：executor 注册表现值快照（MCP appendTools 增量后即时可见）。 */
  readonly getTools: () => readonly AgentHarnessTool<ExecutionToolContext, any, any>[];
  /** 沙箱执行总超时（含工具耗时；缺省 120s）。 */
  readonly timeoutMs?: number;
}

/** 嵌套工具结果 → 脚本值：structuredContent（声明 outputSchema 的结构化源）优先，否则文本拼接。 */
function textOfContent(content: readonly { type: string; text?: unknown }[]): string {
  const text = content
    .map((block) => (typeof block.text === "string" ? block.text : JSON.stringify(block)))
    .join("\n");
  return text || "(no content)";
}

/**
 * worker 入口指定符：desktop 编译形态由 compile-daemon 编译期 --define 注入
 *（bun build --define:process.env.HELIX_CODEMODE_WORKER_URL='"…"' 常量替换）
 * ——daemon 源码零形态检测分支（AG-18/R4：形态差异归工程层编译管线，不进
 * src）；dev 形态缺省 undefined = pi-codemode 包自带 worker（磁盘上）。这
 * 是 pi-codemode README 契约的 Bun 编译可执行体方案（pi 官方 Bun binary
 * 同款机制，注入位不同）。编译形态下默认 worker 文件不在磁盘上，必须传
 * 编译 entrypoint 的相对串指定符（compile-daemon.ts 把 codemode-worker.ts
 * 作为额外 entrypoint 嵌入）。
 */
const CODEMODE_WORKER_URL: string | undefined = process.env.HELIX_CODEMODE_WORKER_URL;

/** worker 入口解析（可测纯函数）：注入值透传（编译形态 = 嵌入 entrypoint 相对
 * 串；源码形态 = 缺省 pi-codemode 自带 worker 文件）。 */
export function resolveCodemodeWorkerUrl(injected = CODEMODE_WORKER_URL): string | undefined {
  return injected;
}

/** codeme AgentTool 装配（CoreToolExecutor options.codemode 注入时注册）。 */
export function createCodemodeTool(deps: CodemodeToolDeps): AgentHarnessTool<ExecutionToolContext> {
  let nextNestedId = 1;
  return {
    name: CODEMODE_TOOL_NAME,
    label: "Codemode",
    description:
      "在 QuickJS 沙箱里写 JavaScript 编排其他工具调用：链式调用、并行扇出（Promise.all）、循环批处理、大结果过滤。" +
      "嵌套调用的中间结果不进入上下文，只有脚本的输出与返回值会返回。\n" +
      "何时用它：≥8 个相互独立的只读调用且只需过滤/汇总后的结论（不要全量）；或大结果集只要小结论" +
      "（如千行 grep 命中只要文件清单与计数）。何时不该用：≤7 个独立调用或需要逐个查看全量结果做判断" +
      "（直接发一轮并行调用）；后调依赖前调结果的顺序链（普通调用）；写类变更工具的编排。\n" +
      "沙箱内无 Node/文件系统/网络/定时器，唯一能力是调用工具。用法：代码是 async 函数体（顶层 await 与 return 可用）；" +
      '`await tools.<name>(args)` 调用工具（名字不是合法标识符时用 tools["<name>"]，如 MCP 命名空间名）；' +
      "`text(value)`/`console.log()` 输出、`return` 返回值（结构化值会 JSON 序列化）、`image(dataUrl)` 附图；" +
      "`ALL_TOOLS` 列出全部可用工具名。\n" +
      "可编排面 = 本会话已声明的工具（codemode 自身、编排族 agent_*、permission_request、task_create、coord_claim/coord_release 除外）。" +
      "声明了结构化输出（outputSchema）的工具返回对象，其余返回文本。",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript 源码（async 函数体——顶层 await 与 return 可用）",
        },
      },
      required: ["code"],
    } as never,
    async execute(_toolCallId, params, _onUpdate, context): Promise<AgentToolResult<unknown>> {
      const { code } = params as { code: string };
      // 沙箱工具面 = 注册表现值 − 排除集（MCP 增量工具即时可见；排除集见上）
      const surface = deps.getTools().filter((tool) => !CODEMODE_SANDBOX_EXCLUSIONS.has(tool.name));
      const sandboxTools: SandboxCodemodeTool[] = surface.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as never,
        // 脚本收到什么：声明了 outputSchema 的工具返回 structuredContent，否则文本
        outputSchema: ((tool as { outputSchema?: unknown }).outputSchema as never) ?? { type: "string" },
        execute: async (args: unknown, { signal }) => {
          const id = `codemode-${nextNestedId++}`;
          // 六参直执（同 executor 共享 context：env 沙箱/写钩子对嵌套调用同生效；
          // 沙箱中止信号透传 chord Context——脚本超时/终止时嵌套调用同步可中止）
          const result = await tool.execute(
            id,
            args as never,
            () => {},
            context,
            invocationOf(id),
            contextOfSignal(signal),
          );
          if (result.structuredContent !== undefined) return result.structuredContent;
          return textOfContent(result.content);
        },
      }));
      const sandbox = new CodemodeSandbox({
        tools: sandboxTools,
        timeoutMs: deps.timeoutMs ?? 120_000,
        wasm: loadQuickJSWasm(quickjsWasmPath),
        workerUrl: resolveCodemodeWorkerUrl(),
      });
      try {
        const result = await sandbox.execute(code);
        // 输出条目即 pi-ai content 形状（text/image），原样回填
        const content = [...result.output] as never as AgentToolResult<unknown>["content"];
        if (result.ok && result.value !== undefined) {
          const text =
            typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2);
          content.push({ type: "text", text });
        }
        if (!result.ok) {
          content.push({
            type: "text",
            text: `脚本失败：${result.error.stack ?? result.error.message}`,
          });
        }
        // calls：每次嵌套调用的 name/status/时长——渲染面观测，不进模型上下文
        return { content, details: { calls: result.calls }, isError: !result.ok };
      } finally {
        await sandbox.close();
      }
    },
  };
}
