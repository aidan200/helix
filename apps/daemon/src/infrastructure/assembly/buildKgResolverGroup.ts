/**
 * 装配函数：kg 数据面解析器群（组合根切片，AG-02④ 豁免面
 * infrastructure/assembly/**——M29 自 container.ts 切出）。
 *
 * 四解析器（kg-bootstrap / kg 维护批 / kg 评审批 / code-review 批）同一
 * 接缝：workspace 现值 stack + 任务栈（daemon 级 engine/store/skills）
 * 组装，WeakMap 按 stack 记忆化——重绑原子换栈后自动跟随新 workspace
 *（W1 重绑接缝；viewerService 同接缝）。同构模板由 memoizedByStack
 * 单点化（M30）。
 */

import type { TaskEnginePort } from "../../application/ports/inbound/TaskEnginePort";
import type { TaskStorePort } from "../../application/ports/outbound/TaskStorePort";
import type { TaskSkillRegistryPort } from "../../application/ports/outbound/TaskSkillRegistryPort";
import type { WorkspaceStack } from "../../application/services/workspace/WorkspaceService";
import { KgBootstrapService } from "../../application/services/kg/KgBootstrapService";
import { KgMaintenanceService } from "../../application/services/kg/KgMaintenanceService";
import { KgReviewService } from "../../application/services/kg/KgReviewService";
import { CodeReviewService } from "../../application/services/kg/CodeReviewService";

/**
 * byStack 记忆化单点（M30）：「WeakMap byStack + stack() null 判 + new
 * Service」同构模板的泛型助手——按 stack 对象键 WeakMap 缓存（旧栈条目
 * 随 GC 回收，重绑后自然跟随新栈）；stack()=null（未绑定）→ undefined
 *（消费面空集/拒绝防御契约）。
 */
function memoizedByStack<T>(stackOf: () => WorkspaceStack | null, factory: (stack: WorkspaceStack) => T): () => T | undefined {
  const byStack = new WeakMap<object, T>();
  return () => {
    const stack = stackOf();
    if (stack === null) return undefined;
    let svc = byStack.get(stack);
    if (svc === undefined) {
      svc = factory(stack);
      byStack.set(stack, svc);
    }
    return svc;
  };
}

export interface KgResolverGroupDeps {
  /** workspace 现值栈读面（W1 重绑接缝：解析器每次调用读现值）。 */
  readonly stack: () => WorkspaceStack | null;
  /** 任务引擎（daemon 级任务栈）。 */
  readonly taskEngine: TaskEnginePort;
  /** 任务三表存取（daemon 级任务栈；purge 门禁/bootstrapRunning 数据源）。 */
  readonly taskStore: TaskStorePort;
  /** 任务类型注册表（daemon 级任务栈）。 */
  readonly skills: TaskSkillRegistryPort;
}

/** kg 族命令回口解析器群（WsServerAdapter 注入面；解析器形态 = workspace 现值跟随）。 */
export interface KgResolverGroup {
  readonly kgBootstrapResolver: () => KgBootstrapService | undefined;
  readonly kgMaintenanceResolver: () => KgMaintenanceService | undefined;
  readonly kgReviewResolver: () => KgReviewService | undefined;
  readonly codeReviewResolver: () => CodeReviewService | undefined;
}

export function buildKgResolverGroup(deps: KgResolverGroupDeps): KgResolverGroup {
  // kg-bootstrap 数据面解析器（T3.2，契约 kg-bootstrap-api）：workspace 现值
  // stack（kg 面）+ 任务栈（daemon 级：engine/store/skills）组装，WeakMap 按
  // stack 记忆化——重绑原子换栈后自动跟随新 workspace（viewerService 同接缝）。
  const kgBootstrapResolver = memoizedByStack(
    deps.stack,
    (stack) =>
      new KgBootstrapService({
        project: stack.projectService,
        graph: stack.graph,
        write: stack.writeService,
        sync: stack.syncService,
        taskEngine: deps.taskEngine,
        store: deps.taskStore,
        skills: deps.skills,
      }),
  );
  // kg 维护批数据面解析器（C1，契约 PROTOCOL-CHANGELOG.md §22）：workspace 现值 stack
  //（project/store/sync/fsWatch/codegraphEngine 面）+ 任务栈 store（purge
  // 门禁数据源）组装，WeakMap 按 stack 记忆化（kgBootstrap 同接缝）。
  const kgMaintenanceResolver = memoizedByStack(
    deps.stack,
    (stack) =>
      new KgMaintenanceService({
        project: stack.projectService,
        store: stack.store,
        sync: stack.syncService,
        fsWatch: stack.fsWatch,
        codegraph: stack.codegraphEngine,
        taskStore: deps.taskStore,
      }),
  );
  // kg 评审批数据面解析器（W2-F，契约 PROTOCOL-CHANGELOG.md §23）：workspace 现值
  // stack（project 面）+ 任务栈 engine 组装，WeakMap 按 stack 记忆化
  //（kgBootstrap/kgMaintenance 同接缝；只有发起面——无需 graph/write/sync）。
  const kgReviewResolver = memoizedByStack(
    deps.stack,
    (stack) =>
      new KgReviewService({
        project: stack.projectService,
        taskEngine: deps.taskEngine,
        store: deps.taskStore,
      }),
  );
  // code-review 批数据面解析器（code-review v1.5，kgReview 同接缝：workspace
  // 现值 stack + 任务栈 engine 组装，WeakMap 按 stack 记忆化；只有发起面）。
  const codeReviewResolver = memoizedByStack(
    deps.stack,
    (stack) =>
      new CodeReviewService({
        project: stack.projectService,
        taskEngine: deps.taskEngine,
        store: deps.taskStore,
      }),
  );
  return { kgBootstrapResolver, kgMaintenanceResolver, kgReviewResolver, codeReviewResolver };
}
