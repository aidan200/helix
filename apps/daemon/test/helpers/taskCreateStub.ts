import type { TaskCreateToolDeps } from "../../src/adapters/driven/tools/task-create/TaskCreateTool";

/**
 * task_create 装配替身（T2.4）：MainSessionProfile 声明 task_create 后，凡解析
 * main 工具集的 executor 均需注入 taskCreate 面（条件注册纪律——缺注入即
 * resolveTools fail-fast）。本替身零库零 IO：createTask 恒拒（错误含 code 面
 * 可辨认替身来源）、回执读面恒兑底投影。
 */
export function taskCreateStub(): TaskCreateToolDeps {
  return {
    engine: {
      async createTask() {
        throw new Error("task_create 装配替身：本测试不创建任务");
      },
    },
    query: { getTaskDetail: () => ({ title: "装配替身", stages: [] }) },
  };
}
