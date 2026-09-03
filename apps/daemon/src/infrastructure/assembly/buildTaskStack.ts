import type { Logger } from "../logging";
import { readFile } from "node:fs/promises";
import type { WriteQueue } from "../../adapters/driven/sqlite-session/WriteQueue";
import type { SkillSourcePort } from "../../application/ports/outbound/SkillSourcePort";
import { TaskStore } from "../../adapters/driven/sqlite-session/TaskStore";
import { parentWorkLedger } from "../../adapters/driven/sqlite-session/WorkLedger";
import { TaskSkillRegistry } from "../../adapters/driven/task-skill-registry/TaskSkillRegistry";
import { TaskEngineService } from "../../application/services/task/TaskEngineService";
import { TaskQueryService } from "../../application/services/task/TaskQueryService";
import { WorkLedgerService } from "../../application/services/task/WorkLedgerService";
import type { TaskEnginePort } from "../../application/ports/inbound/TaskEnginePort";
import type {
  TaskSkillRegistryPort,
  TaskTypeInfo,
} from "../../application/ports/outbound/TaskSkillRegistryPort";
import type { TaskOrchestratorStarterPort } from "../../application/ports/outbound/TaskOrchestratorStarterPort";
import type { TaskStorePort } from "../../application/ports/outbound/TaskStorePort";
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
 *   为 no-op 占位：任务可创建/生命周期可控，但不被驱动——start 调用日志警示）。
 *
 * 任务类型注册表（T2.3 真体已接）：skillSource 注入时装配 TaskSkillRegistry
 *（builtin 层扫描 → frontmatter task 块解析入表，AD-9②）；缺省 = 空注册表
 * 占位（测试隔离形态：createTask 一律 task.type_unknown）。装载在装配内
 * await 完成——函数因此 async（builtin 层随仓不可变，无重扫面）。
 *
 * 装配序契约：位于 buildPersistence 之后（共享 WriteQueue）、registry.initialize
 * 之后由组合根触发 recoverOnStartup（§4.4 daemon 启动钩子）。
 */
export interface TaskStack {
  /** 任务引擎（createTask/生命周期/编排回口/恢复扫描；TP-2.3a④ 命名避让：字段名不带裸 engine）。 */
  readonly taskEngine: TaskEnginePort;
  /** P-2 读面投影（listTasks/getTaskDetail/getTaskArtifacts）。 */
  readonly query: TaskQueryService;
  /**
   * 编排服务任务域依赖面（T2.2）：组合根在 sessionStack 之后构造
   * TaskOrchestratorService 时消费（store/engine/ledger/skills + skill
   * 全文取数）。生命周期 = 与任务栈同库同源（同一 WriteQueue）。
   */
  readonly orchestratorCore: {
    readonly store: TaskStorePort;
    readonly taskEngine: TaskEnginePort;
    readonly ledger: WorkLedgerService;
    readonly skills: TaskSkillRegistryPort;
    readonly skillTextOf: (type: string) => Promise<string | undefined>;
  };
}

export interface BuildTaskStackDeps {
  /** 共享单写队列（O-1：helix.db 任务四表表域；AG-06 唯一写通道）。 */
  readonly writeQueue: WriteQueue;
  readonly clock: ClockPort;
  readonly logger: Logger;
  /** 编排运行时覆盖（T2.2 真体装配接缝；缺省 = no-op 占位）。 */
  readonly starterOverride?: TaskOrchestratorStarterPort;
  /** builtin 层扫描面（T2.3 真体：TaskSkillRegistry 装载源；缺省 = 空注册表占位——测试隔离形态）。 */
  readonly skillSource?: SkillSourcePort;
  /**
   * task.changed 出站钩子（AF-T1.5.2，T2.2）：透传 TaskEngineService——
   * 组合根接 EventStream.broadcastTaskChanged 同一广播单点（生命周期三
   * 命令面归 handler，不双发）。缺省不推送（隔离测试形态）。
   */
  readonly onTaskChanged?: (frame: { jobId: string; changed: "job" | "stage" | "batch"; status?: string }) => void;
  /**
   * 批次实例调度态读面（⑤ 链 A：组合根接 scheduler.status——晚绑闭包，
   * 调度器在 sessionStack 之后建；未注入 → DTO instanceState 省略）。
   */
  readonly instanceStateOf?: (agentId: string) => string | undefined;
  /**
   * 任务报告目录清理（F3.6 级联扩展）：组合根注入 fs 实现（~<home>/reports/
   *  task:<jobId>/ 整目录 rm）；缺省跳过（隔离测试形态零 fs）。
   */
  readonly removeTaskReportDir?: (jobId: string) => Promise<void> | void;
}

export async function buildTaskStack(deps: BuildTaskStackDeps): Promise<TaskStack> {
  const store = new TaskStore(deps.writeQueue);
  const workLedger = parentWorkLedger(deps.writeQueue);
  const starter: TaskOrchestratorStarterPort =
    deps.starterOverride ?? placeholderStarter(deps.logger);
  let skills: TaskSkillRegistryPort = EMPTY_SKILL_REGISTRY;
  if (deps.skillSource !== undefined) {
    const registry = new TaskSkillRegistry({ skills: deps.skillSource, warn: (m) => deps.logger.warn(m) });
    await registry.load();
    skills = registry;
  }
  const engine = new TaskEngineService({
    store,
    skills,
    starter,
    workLedger,
    clock: deps.clock,
    ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}),
    ...(deps.removeTaskReportDir !== undefined ? { removeTaskReportDir: deps.removeTaskReportDir } : {}),
    warn: (m) => deps.logger.warn(m),
  });
  const query = new TaskQueryService({
    store,
    workLedger,
    skills,
    clock: deps.clock,
    ...(deps.instanceStateOf !== undefined ? { instanceStateOf: deps.instanceStateOf } : {}),
  });
  // T2.2 编排服务任务域依赖面：台账读面（父进程不持写面，O-1 表分域）+
  // skill 全文取数（扫描 → 文件读取；组合根 fs 职责，服务层零 IO）
  const ledger = new WorkLedgerService({ reader: workLedger });
  const skillTextOf = async (type: string): Promise<string | undefined> => {
    if (deps.skillSource === undefined) return undefined;
    const hit = (await deps.skillSource.scan()).skills.find((s) => s.name === type);
    if (hit === undefined) return undefined;
    try {
      return await readFile(hit.filePath, "utf8");
    } catch {
      return undefined;
    }
  };
  return { taskEngine: engine, query, orchestratorCore: { store, taskEngine: engine, ledger, skills, skillTextOf } };
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
    async parkAll(_jobId: string): Promise<void> {
      // no-op：占位期无 loop 可冻结、无实例登记面（pause 仍落库停派，O-2 既有语义）
    },
    async resumeAll(_jobId: string): Promise<void> {
      // no-op：占位期无 loop 可解冻、无 parked 实例可复活
    },
  };
}

/** 空注册表占位（skillSource 未注入形态：createTask 一律 task.type_unknown——防线语义自洽）。 */
const EMPTY_SKILL_REGISTRY: TaskSkillRegistryPort = {
  getTaskType(_type: string): TaskManifest | null {
    return null;
  },
  listTaskTypes(): readonly TaskTypeInfo[] {
    return [];
  },
};
