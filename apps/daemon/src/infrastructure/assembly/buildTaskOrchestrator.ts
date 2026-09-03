/**
 * 装配函数：任务编排服务真体（T2.2 晚绑闭合切片，组合根豁免面
 * AG-02④——M29 自 container.ts 切出）。
 *
 * TaskOrchestratorService 消费调度器（批次 spawn 占预算/收口读面/kill/
 * park/resume）+ 任务域依赖面（buildTaskStack orchestratorCore 同源）+
 * 编排会话工厂（orchestrator-runtime）。装配序：sessionStack 之后构造
 *（scheduler/orchestratorAssembly/resolveSubagentModelId 就绪），真体经
 * 晚绑 starter 代理回填任务栈（container 保序）。
 */

import path from "node:path";
import type { ClockPort } from "../../application/ports/outbound/ClockPort";
import { TaskOrchestratorService, taskSessionIdOf } from "../../application/services/task/TaskOrchestratorService";
import type { SchedulerService } from "../../application/services/scheduler/SchedulerService";
import type { ResourceService } from "../../application/services/ResourceService";
import type { WorkspaceService } from "../../application/services/workspace/WorkspaceService";
import type { EventStream } from "../../adapters/driving/ws-server/EventStream";
import { resolveConfigModel } from "../../adapters/driven/pi-engine/model-provider";
import { scanWorkspaceProjects } from "../../adapters/driven/workspace-scan";
import { PLAN_HARD_CONSTRAINT_SEGMENT } from "../../adapters/driven/pi-engine/runtime/templates/catalog";
import { createOrchestratorSessionFactory } from "./orchestrator-runtime";
import type { TaskStack } from "./buildTaskStack";
import type { PersistenceStack } from "./buildPersistence";
import type { ModelStack } from "./buildModelStack";
import type { SessionStack } from "./buildSessionStack";
import type { HelixPaths } from "../paths";
import type { Logger } from "../logging";

/** W2-D R13 job 终态同步提示文案（机器只记录只提醒，sync 本体永远人确认）。 */
const KG_SYNC_HINT_TEXT = "本次任务有代码/文档变更，是否触发 kg sync？到 /project 页手动触发；sync 后如有孤儿/腐烂锚会附一行体检提示。";

export interface BuildTaskOrchestratorDeps {
  /** 任务域依赖面（buildTaskStack orchestratorCore：store/engine/ledger/skills + skill 全文取数）。 */
  readonly orchestratorCore: TaskStack["orchestratorCore"];
  /** 调度器（批次 spawn 占预算/收口读面/kill/park/resume 消费面）。 */
  readonly scheduler: SchedulerService;
  /** SubAgent 模型两级链解析单点（rawSpawn 透传，T12 起不取会话当前模型）。 */
  readonly resolveSubagentModelId: SessionStack["resolveSubagentModelId"];
  /** 编排主 agent 组装快照现值读面（启动/toggle 后重算缓存）。 */
  readonly orchestratorAssembly: SessionStack["orchestratorAssembly"];
  /** 编排槽位读面（R7 系统槽位批：orchestrator 槽位优先，未配走全局）。 */
  readonly resourceService: ResourceService;
  /** 持久化族（默认模型/thinking 读面 + 写队列事件镜像 + pending_sync 读面）。 */
  readonly persistence: PersistenceStack;
  /** 模型域（目录 + auth.json key 源）。 */
  readonly modelStack: ModelStack;
  /** workspace 持有者（kg 只读面 W1 重绑接缝：经持有者读现值）。 */
  readonly workspace: WorkspaceService;
  /** grep 启动定格产物（AF-1，rg 单后端：rg 路径 / unavailable 原因清单）。 */
  readonly grep: {
    readonly rgPath: string | undefined;
    readonly unavailableReasons: readonly string[] | undefined;
  };
  readonly clock: ClockPort;
  readonly logger: Logger;
  readonly paths: HelixPaths;
  /** 会话工具沙箱 cwd 求值单点现值读面（W1F-F1）。 */
  readonly toolCwdNow: () => string;
  /** 事件流（task.changed 广播 + syncHint 随行通路）。 */
  readonly eventStream: EventStream;
  /** 编排会话 LLM 覆盖（T4.1 E 层测试接缝；缺省生产形态）。 */
  readonly llmOverride?: Parameters<typeof createOrchestratorSessionFactory>[0]["llmOverride"];
}

export function buildTaskOrchestrator(deps: BuildTaskOrchestratorDeps): TaskOrchestratorService {
  const { orchestratorCore, scheduler, persistence, modelStack, workspace, clock, logger, paths, eventStream } = deps;
  return new TaskOrchestratorService({
    ...orchestratorCore,
    rawSpawn: (sessionId, task, profileKind) =>
      scheduler.spawn(sessionId, task, profileKind, deps.resolveSubagentModelId(profileKind)),
    instanceOutcome: (agentId) => {
      const hit = scheduler.status(agentId)[0];
      return hit === undefined ? undefined : { state: hit.state, ...(hit.summary !== undefined ? { summary: hit.summary } : {}) };
    },
    killInstance: (agentId) => {
      void scheduler.kill(agentId);
    },
    // 链 A（⑤）：批次实例挂起/复活原语接调度器（parkAll/resumeAll 消费）
    parkInstance: (agentId, reason) => scheduler.park(agentId, reason),
    resumeInstance: (agentId) => scheduler.resume(agentId),
    createSession: createOrchestratorSessionFactory({
      assembly: deps.orchestratorAssembly,
      model: () => resolveConfigModel(persistence.defaultModel.current(), modelStack.catalog.modelsView()),
      // R7 系统槽位批：orchestrator 槽位优先（未配走全局）；thinking 两级链
      modelSlot: () => deps.resourceService.modelSlot("orchestrator"),
      resolveModelById: (modelId) => resolveConfigModel(modelId, modelStack.catalog.modelsView()),
      thinkingChain: () => [deps.resourceService.thinkingSlot("orchestrator"), persistence.defaultThinking.stored() ?? undefined],
      apiKeys: () => modelStack.authStore.apiKeysSnapshot(),
      llmOverride: deps.llmOverride,
      // 编排会话事件镜像落盘（任务域观测面）：翻译后领域事件直写
      // domain_events（kind="orchestrator"；不经 fanout 零广播副作用）——
      // trace 面板按 task:<jobId> 会话可查编排过程
      eventSink: {
        publish: (event) => {
          // M34：void appendEvent 补 .catch 挂 logger.warn（对齐 buildPersistence
          // onError 先例）——编排事件镜像落盘失败不再静默 unhandled
          void persistence.writeQueue.appendEvent(event, "orchestrator").catch((err) => {
            logger.warn(`编排事件镜像落盘失败（${event.type}）：${(err as Error).message}`);
          });
        },
        clock,
      },
      models: modelStack.catalog.modelsView(),
      toolCwd: deps.toolCwdNow,
      // kg 只读面（W1：经 workspace 持有者读现值；未绑定 → 剔除 kg 工具）
      kgRead: () => {
        const stack = workspace.stack();
        const root = workspace.boundRoot();
        return stack !== null && root !== null
          ? { query: stack.queryService, workspaceRoot: root, scanProjects: () => scanWorkspaceProjects(root) }
          : undefined;
      },
      grep: {
        rgPath: deps.grep.rgPath,
        unavailableReasons: deps.grep.unavailableReasons,
      },
      taskEngine: orchestratorCore.taskEngine,
      ledger: orchestratorCore.ledger,
      logger,
    }),
    planHardConstraint: PLAN_HARD_CONSTRAINT_SEGMENT,
    // D6：任务报告目录（kickoff 起跑信息携带——与 SubagentLauncher reportDirFor /
    // ClosureRecorder reportsDirFor 同源同式 <home>/reports/<sessionId>）
    reportsDirFor: (sessionId) => path.join(paths.home, "reports", sessionId),
    // W2-D R13 job 完成提示点（编排层，不进引擎守 AD-10）：job 终态 reap 时
    // 扫描该 job 相关 session 的 pending_sync（notified=0）→ 置已提示 + 经
    // 既有 task.changed 广播通路随行 syncHint（机器只记录只提醒，sync 人确认）
    onJobTerminal: (jobId, status) => {
      const rows = persistence.repository.queryUnnotifiedPendingSync(taskSessionIdOf(jobId), jobId);
      if (rows.length === 0) return;
      void persistence.repository.markPendingSyncNotified(rows.map((r) => r.sessionId));
      eventStream.broadcastTaskChanged({ jobId, changed: "job", status, syncHint: KG_SYNC_HINT_TEXT });
    },
    logger,
  });
}
