import type { TaskReportToolDeps } from "../../src/adapters/driven/tools/task-report/TaskReportTool";

/**
 * task_report 装配替身（D3）：MainSessionProfile 声明 task_report 后，凡解析
 * main 工具集的 executor 均需注入 taskReport 面（条件注册纪律——缺注入即
 * resolveTools fail-fast）。本替身零库零 IO：listTasks 恒空、getTaskDetail
 * 恒 task.not_found（错误含 code 面可辨认替身来源）、closure 恒空。
 */
export function taskReportStub(): TaskReportToolDeps {
  return {
    query: {
      listTasks: () => [],
      getTaskDetail: () => {
        throw new Error("task.not_found：task_report 装配替身：本测试无任务");
      },
    },
    closureRecords: () => [],
    reportDirFor: (sessionId) => `/tmp/helix-task-report-stub/reports/${sessionId}`,
  };
}
