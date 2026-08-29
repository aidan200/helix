import type { Logger } from "../logging";
import type { WriteQueue } from "../../adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../adapters/driven/sqlite-session/TaskStore";
import { parentWorkLedger } from "../../adapters/driven/sqlite-session/WorkLedger";
import { TaskEngineService } from "../../application/services/task/TaskEngineService";
import { TaskQueryService, type NodeRefData } from "../../application/services/task/TaskQueryService";
import type { TaskEnginePort } from "../../application/ports/inbound/TaskEnginePort";
import type {
  TaskSkillRegistryPort,
  TaskTypeInfo,
} from "../../application/ports/outbound/TaskSkillRegistryPort";
import type { TaskOrchestratorStarterPort } from "../../application/ports/outbound/TaskOrchestratorStarterPort";
import type { ClockPort } from "../../application/ports/outbound/ClockPort";
import type { TaskManifest } from "../../domain/task/types";

/**
 * 装配函数 ④ 任务栈（architecture §4/§10）：组合根的一部分（AG-02④ 豁免面
 * infrastructure/assembly/**）。成员：TaskStore（job/stage/batch 单写通道读
 * 写面）+ 父进程 work_item 面（getItems 读 + F3.6 清理）+ TaskEngineService
 * + TaskQueryService（P-2 读面）。
 *
 * 占位件（同迭代后继任务替换，均为组合根内局部声明）：
 * - TaskOrchestratorStarterPort → T2.2 TaskOrchestratorService（真体注入前
 *   为 no-op 占位：任务可创建/生命周期可控，但不被驱动——start 调用日志警示）；
 * - TaskSkillRegistryPort → T2.3 builtin 层扫描注册表（真体注入前为空表：
 *   createTask 一律 task.type_unknown）。
 *
 * 装配序契约：位于 buildPersistence 之后（共享 WriteQueue）、registry.initialize
 * 之后由组合根触发 recoverOnStartup（§4.4 daemon 启动钩子）。
 */
export interface TaskStack {
  /** 任务引擎（createTask/生命周期/编排回口/恢复扫描；TP-2.3a④ 命名避让：字段名不带裸 engine）。 */
  readonly taskEngine: TaskEnginePort;
  /** P-2 读面投影（listTasks/getTaskDetail/getTaskArtifacts）。 */
  readonly query: TaskQueryService;
}

export interface BuildTaskStackDeps {
  /** 共享单写队列（O-1：helix.db 任务四表表域；AG-06 唯一写通道）。 */
  readonly writeQueue: WriteQueue;
  readonly clock: ClockPort;
  readonly logger: Logger;
  /** 编排运行时覆盖（T2.2 真体装配接缝；缺省 = no-op 占位）。 */
  readonly starterOverride?: TaskOrchestratorStarterPort;
  /** 任务类型注册表覆盖（T2.3 真体装配接缝；缺省 = 空注册表占位）。 */
  readonly skillsOverride?: TaskSkillRegistryPort;
  /** kg 节点投影注入（产物页人类可读，AD-4②；缺省 = 空投影）。 */
  readonly kgNodeProjector?: (nodeIds: readonly string[]) => readonly NodeRefData[];
}

export function buildTaskStack(deps: BuildTaskStackDeps): TaskStack {
  const store = new TaskStore(deps.writeQueue);
  const workLedger = parentWorkLedger(deps.writeQueue);
  const starter: TaskOrchestratorStarterPort =
    deps.starterOverride ?? placeholderStarter(deps.logger);
  const skills: TaskSkillRegistryPort = deps.skillsOverride ?? EMPTY_SKILL_REGISTRY;
  const engine = new TaskEngineService({ store, skills, starter, workLedger, clock: deps.clock });
  const query = new TaskQueryService({ store, workLedger, skills, clock: deps.clock, kgNodeProjector: deps.kgNodeProjector });
  return { taskEngine: engine, query };
}

/** no-op 编排占位（T2.2 前任务不被驱动；start 调用警示日志可观测）。 */
function placeholderStarter(logger: Logger): TaskOrchestratorStarterPort {
  return {
    async startOrchestrator(jobId: string): Promise<void> {
      logger.warn(`任务 ${jobId} 请求启动编排，但编排运行时未装配（T2.2 前占位）——任务将保持待驱动状态`);
    },
    async stopOrchestrator(_jobId: string): Promise<void> {
      // no-op：占位期无 loop 可停
    },
  };
}

/** 空注册表占位（T2.3 前：createTask 一律 task.type_unknown——防线语义自洽）。 */
const EMPTY_SKILL_REGISTRY: TaskSkillRegistryPort = {
  getTaskType(_type: string): TaskManifest | null {
    return null;
  },
  listTaskTypes(): readonly TaskTypeInfo[] {
    return [];
  },
};
