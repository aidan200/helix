/**
 * spike 共享工具（一次性验证代码，不追求优雅）。
 *
 * 模型接入纪律（F(3).1 标准 4 / AD-11 / AD-13）：
 * - key 只从 `<home>/config.json` 的 apiKeys 字段读取（--home 可覆盖，默认 ~/.helix）；
 * - 显式传入 Agent 的 getApiKey 钩子（agent-loop 内部把它作为 options.apiKey 传给
 *   pi-ai 的 streamSimple）——不走 env 解析路径，脚本内零硬编码 key；
 * - provider 经 `pi-ai/providers/all` 子路径（F-7 红线：主入口 side-effect-free）；
 * - Node 执行环境经 `pi-agent-core/node` 子入口（F-7 红线）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, Models } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool, AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/** 解析命令行参数：--home <dir>（fixture home）、--dry-run（只验证到 provider 建连层）。 */
export function parseSpikeArgs(argv: string[]): { home: string; dryRun: boolean } {
  const args = argv.slice(2);
  let home = join(homedir(), ".helix");
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--home") home = args[i + 1] ?? home;
    if (args[i] === "--dry-run") dryRun = true;
  }
  return { home, dryRun };
}

/** `<home>/config.json`（与 daemon infrastructure/config.ts 同字段面：model / apiKeys / port）。 */
export interface SpikeHomeConfig {
  model: string;
  apiKeys: Record<string, string>;
}

export function loadHomeConfig(home: string): SpikeHomeConfig {
  const path = join(home, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `找不到 ${path}。请提供 fixture home：mkdir -p <dir> 并写入 ` +
        `{ "model": "zai-coding-cn/glm-5.3", "apiKeys": { "<provider>": "<key>" } }，` +
        `然后加 --home <dir> 运行。`,
    );
  }
  const parsed = JSON.parse(raw) as SpikeHomeConfig;
  if (!parsed.model || !parsed.apiKeys) throw new Error(`${path} 缺少 model 或 apiKeys 字段`);
  return parsed;
}

/** builtinModels()：全部静态 provider 目录（kimi-coding / zai-coding-cn / xiaomi / xai 均在内）。 */
export function buildModels(): Models {
  return builtinModels();
}

/** "provider/model-id" → Model。 */
export function resolveModel(models: Models, modelStr: string): Model<any> {
  const [provider, ...rest] = modelStr.split("/");
  const id = rest.join("/");
  const model = models.getModel(provider, id);
  if (!model) {
    const known = models.getModels(provider).map((m) => m.id).join(", ") || "(无静态模型)";
    throw new Error(`模型 ${modelStr} 不在静态目录中。provider=${provider} 已知模型：${known}`);
  }
  return model;
}

/** 显式 key 钩子：返回值在 agent-loop 内被放进 stream options 的 apiKey 字段。 */
export function explicitGetApiKey(apiKeys: Record<string, string>) {
  return (provider: string): string | undefined => {
    const key = apiKeys[provider];
    if (!key) throw new Error(`apiKeys 中没有 provider "${provider}" 的 key（config.json apiKeys 字段）`);
    return key;
  };
}

/**
 * 结构化时序日志：`[+相对ms | ISO 时刻] SCRIPT_EVENT 描述 {关键参数 JSON}`。
 * 每脚本输出可判读事件流，报告引用原始输出摘录作证据。
 */
export interface SequencedLogger {
  script: (type: string, params?: unknown) => void;
  agent: () => (event: AgentEvent) => void;
  t0: number;
}

export function makeLogger(prefix: string): SequencedLogger {
  const t0 = Date.now();
  const line = (chan: string, type: string, params?: unknown) => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const body = params === undefined ? "" : " " + JSON.stringify(params);
    console.log(`[+${String(now - t0).padStart(6)}ms | ${iso}] ${prefix}/${chan} ${type}${body}`);
  };
  return {
    t0,
    script: (type, params) => line("script", type, params),
    agent: () => (event) => {
      const short = (m: AgentMessage) =>
        m.role === "user"
          ? `user:"${textOf(m.content).slice(0, 60)}"`
          : `${m.role}(stop=${(m as any).stopReason ?? "?"}):"${textOf((m as any).content).slice(0, 60)}"`;
      switch (event.type) {
        case "message_start":
        case "message_end":
          line("agent", `${event.type} {${short(event.message)}}`);
          break;
        case "message_update":
          break; // 流式增量太密，不打（message_start/end 已够时序判读）
        case "turn_end":
          line("agent", `turn_end {assistant:${short(event.message)}, toolResults:${event.toolResults.length}}`);
          break;
        case "agent_end":
          line("agent", `agent_end {messages:${event.messages.length}}`);
          break;
        case "tool_execution_end":
          line("agent", `tool_execution_end {${event.toolName}#${event.toolCallId.slice(0, 8)} isError=${event.isError} result="${textOf(event.result?.content).slice(0, 60)}"}`);
          break;
        default:
          line("agent", event.type, paramsOf(event));
      }
    },
  };
}

function paramsOf(e: AgentEvent): unknown {
  switch (e.type) {
    case "tool_execution_start":
      return { tool: e.toolName, id: e.toolCallId.slice(0, 8), args: e.args };
    default:
      return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[toolCall:${c.name}]` : `[${c.type}]`))
      .join("|");
  return "";
}

/**
 * 组装最小 Agent（F-7 修正的「自行组装」路径，也是 T1.4 的参照）。
 * 内置工具是 AgentHarnessTool（execute 多一个 context 参数），Agent 需要 AgentTool——
 * 这里用闭包把 {env} 绑进去（约 5 行/工具，无现成绑定助手）。
 */
export function bindToolContext<T extends ExecutionToolContext>(tool: AgentHarnessTool<T, any, any>, context: T): AgentTool<any> {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate, context),
  } as AgentTool<any>;
}

export interface AssembleOptions {
  models: Models;
  model: Model<any>;
  apiKeys: Record<string, string>;
  systemPrompt: string;
  tools: AgentTool<any>[];
  log: SequencedLogger;
  hooks?: Partial<Pick<ConstructorParameters<typeof Agent>[0], "beforeToolCall" | "afterToolCall" | "shouldStopAfterTurn" | "prepareNextTurn">>;
  steeringMode?: "all" | "one-at-a-time";
}

/** Agent + 事件日志订阅 + 显式 key + 工具（纯组装，无 harness）。 */
export function assembleAgent(opts: AssembleOptions): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      tools: opts.tools,
    },
    streamFn: (model, context, options) => opts.models.streamSimple(model, context, options),
    getApiKey: explicitGetApiKey(opts.apiKeys),
    steeringMode: opts.steeringMode,
    ...opts.hooks,
  });
  agent.subscribe(opts.log.agent());
  return agent;
}

export { NodeExecutionEnv };

/** 干跑验证：建 Models + 解析模型 + key 就绪检查（不打真实补全请求；compaction 项除外必须真跑）。 */
export async function dryRunCheck(config: SpikeHomeConfig): Promise<{ provider: string; modelId: string; contextWindow: number; api: string }> {
  const models = buildModels();
  const model = resolveModel(models, config.model);
  const key = config.apiKeys[model.provider];
  if (!key) throw new Error(`apiKeys 缺少 ${model.provider}`);
  console.log(`[dry-run] provider=${model.provider} model=${model.id} api=${(model as any).api} contextWindow=${(model as any).contextWindow} key=***${key.slice(-4)}`);
  return { provider: model.provider, modelId: model.id, contextWindow: (model as any).contextWindow, api: (model as any).api };
}
