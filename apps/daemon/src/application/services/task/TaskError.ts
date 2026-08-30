/**
 * 任务域结构化错误（contracts/task-api.md §4 词表；T1.5 协议面同词表映射）。
 *
 * 挂位说明：错误类属运行时值（AG-01：ports/** 只允许接口/类型），与
 * SessionNotFoundError（SessionRegistry.ts）/ModelNotFoundError（ModelService.ts）
 * 同构挂服务侧；TaskEngineService 与 TaskQueryService 共用，独立小文件收口。
 */

/** 任务域命令错误码。 */
export type TaskErrorCode =
  | "task.type_unknown"
  | "task.validation_failed"
  | "task.not_found"
  | "task.invalid_state";

/** 任务域结构化错误（driving 层按 code 回执错误帧，message 人类可读）。 */
export class TaskError extends Error {
  readonly code: TaskErrorCode;
  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}
