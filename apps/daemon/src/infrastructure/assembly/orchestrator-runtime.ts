import type { AgentOrchestrationPort } from "../../application/ports/inbound/AgentOrchestrationPort";
import type { TaskEnginePort } from "../../application/ports/inbound/TaskEnginePort";
import type { OrchestratorSessionFace } from "../../application/services/task/TaskOrchestratorService";
import type { WorkLedgerService } from "../../application/services/task/WorkLedgerService";
import { PiAgentEngineAdapter, type PiEngineOptions } from "../../adapters/driven/pi-engine/PiAgentEngineAdapter";
import type { resolveConfigModel } from "../../adapters/driven/pi-engine/model-provider";
import { OrchestratorProfile } from "../../adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { CoreToolExecutor, type KgToolOptions } from "../../adapters/driven/tools/CoreToolExecutor";
import type { GrepToolDeps } from "../../adapters/driven/tools/grep/GrepTool";
import type { TaskOpsToolDeps } from "../../adapters/driven/tools/task-ops/TaskOpsTools";
import type { Logger } from "../logging";

/**
 * 编排主 agent 会话工厂（T2.2，composition root 豁免面 AG-02④）：
 * 每运行中任务一个编排会话——真 pi 引擎防腐墙（PiAgentEngineAdapter +
 * OrchestratorProfile；与 Main/Sub 同构，TR-AD-4）+ 每 job 独立
 * CoreToolExecutor（task 引擎回口工具族按 jobId 绑定，工具参数零 jobId）。
 *
 * 系统提示 = 组装快照（buildSessionStack orchestratorAssembly：base + 生效
 * 工具清单 + 技能段——与 MainAgent 消费 skill 同构，F-8）；kg 只读面经
 * workspace 持有者读现值（未绑定 → 剔除 kg 工具，与主会话 W1 模式同构）。
 */

/** 模型对象形态（AG-04：pi 类型不进 infrastructure——经 driven 解析函数返回型推导）。 */
type OrchestratorModel = ReturnType<typeof resolveConfigModel>;

export interface OrchestratorSessionFactoryDeps {
  /** 编排组装快照现值（buildSessionStack.orchestratorAssembly）。 */
  readonly assembly: () => { readonly tools: readonly string[]; readonly systemPrompt: string };
  /** 全局兜底模型完整对象（解析单点产物透传）。 */
  readonly model: () => OrchestratorModel;
  /** provider → apiKey（auth.json 现值快照 getter）。 */
  readonly apiKeys: () => Record<string, string>;
  /** 模型目录（compaction/换模解析；可选，PiEngineOptions 同源形态）。 */
  readonly models?: PiEngineOptions["models"];
  /** 工具沙箱 cwd（会话工具求值单点现值——toolCwdNow 同源）。 */
  readonly toolCwd: () => string;
  /** kg 只读面（W1：workspace 持有者读现值；未绑定 → undefined 剔除 kg 工具）。 */
  readonly kgRead?: () => Pick<KgToolOptions, "query" | "workspaceRoot" | "scanProjects"> | undefined;
  /** grep 后端定格产物（AF-1：组合根启动定格透传）。 */
  readonly grep?: GrepToolDeps;
  /** 任务引擎回口（taskOps 工具族绑定面；TP-2.3a④ 命名避让：非裸 engine）。 */
  readonly taskEngine: TaskEnginePort;
  /** 台账读面（编排者 plan_read 变体绑定）。 */
  readonly ledger: WorkLedgerService;
  readonly logger?: Logger;
  /**
   * 编排会话 LLM 覆盖（T4.1 E 层测试接缝：fake 剧本 streamFn + 可解析 model）。
   * 缺席 = 生产形态（resolveConfigModel + 真 streamFn）；携带时仅替换 LLM 面
   * （工具族/引擎状态机/回口全真）——与 chat 会话 streamFnOverride 同哲学。
   */
  readonly llmOverride?: {
    readonly model: () => OrchestratorModel;
    readonly streamFn: NonNullable<PiEngineOptions["streamFnOverride"]>;
    /**
     * provider → apiKey 测试覆盖（浅合并覆盖生产 authStore 快照；缺省 =
     * 生产快照）——E 层 fake 模型的 provider "fake" 无生产 key，不覆盖时
     * 引擎首 turn 即 auth fail（engine_error 经 drive 吞没，任务卡 pending）。
     */
    readonly apiKeys?: () => Record<string, string>;
  };
}

export function createOrchestratorSessionFactory(
  deps: OrchestratorSessionFactoryDeps,
): (jobId: string, orchestration: AgentOrchestrationPort) => OrchestratorSessionFace {
  return (jobId: string, orchestration: AgentOrchestrationPort): OrchestratorSessionFace => {
    const kgNow = deps.kgRead?.();
    const taskOps: TaskOpsToolDeps = {
      jobId,
      taskEngine: deps.taskEngine,
      ledger: deps.ledger,
    };
    const executor = new CoreToolExecutor({
      cwd: deps.toolCwd(),
      orchestration,
      ...(kgNow !== undefined ? { kg: { ...kgNow } } : {}), // write 不注入：只读形态（kg-update 不注册，AD-10）
      ...(deps.grep !== undefined ? { grep: deps.grep } : {}),
      taskOps,
    });
    const assembly = deps.assembly();
    const adapter = new PiAgentEngineAdapter({
      profile: {
        ...OrchestratorProfile,
        systemPrompt: assembly.systemPrompt,
        // W1：未绑定（kg 只读面缺席）时剔除 kg——声明与注册面一致（resolveTools 硬校验不破）
        tools: assembly.tools.filter((t) => kgNow !== undefined || t !== "kg"),
      },
      model: deps.llmOverride?.model() ?? deps.model(),
      // 测试接缝：llmOverride.apiKeys 浅合并覆盖生产 authStore 快照
      //（fake provider key；缺省 = 生产快照不变）
      apiKeys: () => ({ ...deps.apiKeys(), ...(deps.llmOverride?.apiKeys?.() ?? {}) }),
      ...(deps.models !== undefined ? { models: deps.models } : {}),
      ...(deps.llmOverride !== undefined ? { streamFnOverride: deps.llmOverride.streamFn } : {}),
      resolveTools: (names) => executor.resolveTools(names),
    });
    return {
      drive: (prompt) => adapter.start(prompt, () => undefined),
      inject: (text) => adapter.steer(text),
      abort: () => adapter.abort(),
    };
  };
}
