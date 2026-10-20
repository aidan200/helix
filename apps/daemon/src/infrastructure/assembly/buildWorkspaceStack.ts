import type { CodegraphResolution } from "../../adapters/driven/codegraph-engine/resolve-codegraph";
import type { TaskStorePort } from "../../application/ports/outbound/TaskStorePort";
import type { EmbeddingConfigService } from "../../application/embedding/EmbeddingConfigService";
import type { KgConfigStore } from "../../adapters/driven/sqlite-session/KgConfigStore";
import type { KgTriageAutoTrigger } from "../../application/services/kg/KgTriageAutoTrigger";
import type { Logger } from "../logging";
import { WorkspaceService } from "../../application/services/workspace/WorkspaceService";
import { createWorkspaceFs } from "../../adapters/driven/workspace-fs";
import { existingKgProjects } from "../../adapters/driven/workspace-scan";
import { hasActiveJob } from "../../application/services/kg/job-activity";
import { buildKnowledgeStack } from "./buildKnowledgeStack";
import { OpenAiCompatEmbeddingAdapter } from "../../adapters/driven/embedding/OpenAiCompatEmbeddingAdapter";
import {
  KG_SEMANTIC_MINSCORE_DEFAULT,
  KG_SEMANTIC_TOPK_DEFAULT,
  KG_SIMILARITY_DUP_DEFAULT,
  KG_SIMILARITY_WARN_DEFAULT,
} from "../../application/services/kg/kgConfig";
import type { PersistenceStack } from "./buildPersistence";

/**
 * 装配函数 ⑦ workspace 绑定面（P5 体量门拆分，自组合根 container.ts 原样
 * 迁出）：组合根的一部分（AG-02④ 豁免面 infrastructure/assembly/**）。
 * 成员：WorkspaceService（绑定状态机唯一事实源 + 绑定 kg 栈持有者）+
 * 启动恢复（restore / 测试预置 bindInitial）。
 *
 * 装配序契约（W1 绑定闭环）：位于 buildPersistence/migrateLegacyRuntimeConfig
 * /resolveWsPort 之后、buildModelStack 之前（unbound boot 零扫描零同步零
 * 开库——栈只在 restore 成功/open 成功/初始绑定后建）。
 *
 * 晚绑回填面（原 container 内四个 let 引用，同语义搬入本切片）：kg 栈
 * buildStack 闭包读四类晚绑现值——任务库（kg.projects bootstrapRunning）、
 * embedding 配置域（向量联动）、kg 配置域（查重阈值/语义召回）、kg-triage
 * 自动触发器（候选台账变化通知）。四者构造均在本切片之后，闭包只在运行期
 * 触发（构造窗口零调用），故以 assign 回填面替代容器级 let。
 */
export interface WorkspaceAssembly {
  readonly workspace: WorkspaceService;
  /** 晚绑回填面（构造期后由组合根写入；闭包运行期读现值）。 */
  readonly assign: {
    taskStore(store: TaskStorePort | undefined): void;
    embeddingConfig(service: EmbeddingConfigService | undefined): void;
    kgConfig(store: KgConfigStore | undefined): void;
    triageTrigger(trigger: KgTriageAutoTrigger | undefined): void;
  };
}

export interface BuildWorkspaceStackDeps {
  readonly persistence: PersistenceStack;
  readonly codegraphResolution: CodegraphResolution;
  readonly logger: Logger;
  /** 广播/活跃 agent 判定/会话卸载宿主闭包（eventStream/registry 在
   * buildSessionStack 后才存在——与 wsServer 同款回填模式，调用期读现值）。 */
  readonly hosts: {
    broadcast(root: string): void;
    hasActiveAgent(): boolean;
    unloadSessions(): void;
  };
  /** kg workspace 根初始绑定值（W1 语义演进：等价 restore 预置——测试注入面
   * 指向 tmp）。缺省/显式 null = 不预置 → 走 KV restore（生产等价）。 */
  readonly initialRoot?: string | null;
}

export async function buildWorkspaceStack(deps: BuildWorkspaceStackDeps): Promise<WorkspaceAssembly> {
  const { persistence, codegraphResolution, logger } = deps;
  // P0① kg.projects 行 bootstrapRunning 数据源：任务栈在 workspace 之后建——
  // 晚绑回填（buildStack 闭包读取现值；kg.projects 调用必在 boot 完成后）
  let taskStoreForProjectRows: TaskStorePort | undefined;
  // 批1 WP-B：embedding 配置域晚绑引用（其构造在下方——buildStack 惰性闭包
  //  经此读现值；向量面解析恒走 resolveDefault 单点，构造窗口零调用）
  let embeddingConfigRef: EmbeddingConfigService | undefined;
  // 批2 WP-C：知识库配置域晚绑引用（KgConfigStore 构造在下方——buildStack
  //  惰性闭包经此读查重阈值生效对，运行期即热）
  let kgConfigRef: KgConfigStore | undefined;
  // B批：kg-triage 静默点自动触发晚绑引用（构造在 kgResolvers 之后——buildStack
  //  惰性闭包经此发候选变化通知，构造窗口零调用；触发裁决三关在触发器侧）
  let kgTriageAutoTriggerRef: KgTriageAutoTrigger | undefined;
  const workspace = new WorkspaceService({
    kv: persistence.runtimeConfig, // KV 底座（AG-06 单写通道；不进 config.json，TR-AD-6）
    fs: createWorkspaceFs(), // driven 探测端口（realpath/可读目录/危险根判定输入）
    clock: { now: () => new Date().toISOString() },
    cwd: () => process.cwd(), // CLI 例外条款源（终端站位 = 显式选择）
    buildStack: (root) =>
      buildKnowledgeStack({
        codegraphResolution,
        workspaceRoot: root,
        logger,
        hasRunningBootstrapJob: (projectName) =>
          taskStoreForProjectRows !== undefined && hasActiveJob(taskStoreForProjectRows.listJobs(), "kg-bootstrap", projectName),
        hasRunningReviewJob: (projectName) =>
          taskStoreForProjectRows !== undefined && hasActiveJob(taskStoreForProjectRows.listJobs(), "kg-review", projectName),
        hasRunningCodeReviewJob: (projectName) =>
          taskStoreForProjectRows !== undefined && hasActiveJob(taskStoreForProjectRows.listJobs(), "code-review", projectName),
        hasRunningTriageJob: (projectName) =>
          taskStoreForProjectRows !== undefined && hasActiveJob(taskStoreForProjectRows.listJobs(), "kg-triage", projectName),
        // B批：候选台账变化通知 → 自动触发评估（晚绑 ref；防抖在触发器侧，
        //  发不发由水位/静默门/冷却三关裁决）
        onCandidateChange: (projectRoot) => kgTriageAutoTriggerRef?.notifyCandidateChange(projectRoot),
        // 批1 WP-B：kg 向量联动面（嵌入经全局默认 embedding 端点单点——
        //  端点缺失/失效 = 嵌入降级 warn 不阻塞写，可选件纪律）
        makeEmbedding: () =>
          new OpenAiCompatEmbeddingAdapter({ getConfig: () => embeddingConfigRef?.resolveDefault() ?? null }),
        resolveEmbeddingEndpoint: () => embeddingConfigRef?.resolveDefault() ?? null,
        // 批2 WP-C：查重阈值生效对（kg.similarityWarn/Dup 读面裁决单点——
        //  KgConfigStore.current；未建前回缺省对）
        resolveKgThresholds: () =>
          kgConfigRef?.current() ?? { warn: KG_SIMILARITY_WARN_DEFAULT, dup: KG_SIMILARITY_DUP_DEFAULT },
        // 检索语义化批：语义召回对生效值（kg.semanticTopK/MinScore 读面裁决
        //  单点——KgConfigStore.current；未建前回缺省对）
        resolveKgSemantic: () => {
          const current = kgConfigRef?.current();
          return current !== undefined
            ? { topK: current.semanticTopK, minScore: current.semanticMinScore }
            : { topK: KG_SEMANTIC_TOPK_DEFAULT, minScore: KG_SEMANTIC_MINSCORE_DEFAULT };
        },
      }),
    // B3 fs-watch 补齐挂接：已建 .helix-kg 索引的项目即挂 watcher（索引态
    // 补齐）；stop = 全停（重绑/dispose 清理面——栈 dispose 内含同调用，幂等）。
    startSync: (stack, root) => {
      for (const projectRoot of existingKgProjects(root)) stack.fsWatch.watchProject(projectRoot);
      return { stop: () => stack.fsWatch.dispose() };
    },
    broadcast: (root) => deps.hosts.broadcast(root),
    hasActiveAgent: () => deps.hosts.hasActiveAgent(),
    // W4 债清偿：重绑（替换已绑定栈）时卸载全部现有会话——旧会话 executor
    // 闭包持已 dispose 旧栈；卸载后回访懒加载按新栈重建（kgTools/editDeps
    // 工厂闭包在 buildRuntime 时读 workspace.stack() 现值）。
    unloadSessions: () => deps.hosts.unloadSessions(),
    logger,
  });
  if (deps.initialRoot != null) {
    // 测试注入面：初始绑定值（等价 restore 预置——不校验不持久化）
    workspace.bindInitial(deps.initialRoot);
  } else {
    // 生产/常规（缺省或显式 null）：不预置，走 KV 恢复（有效则绑定 =
    // rebind 效应；无效/无 KV 则未绑定——unbound boot，等 RPC open 或
    // CLI bindCwd）
    await workspace.restore();
  }
  return {
    workspace,
    assign: {
      taskStore: (store) => {
        taskStoreForProjectRows = store;
      },
      embeddingConfig: (service) => {
        embeddingConfigRef = service;
      },
      kgConfig: (store) => {
        kgConfigRef = store;
      },
      triageTrigger: (trigger) => {
        kgTriageAutoTriggerRef = trigger;
      },
    },
  };
}
