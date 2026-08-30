/**
 * task 批（iter-20260829-ys7q T1.5：P-2 任务页数据面九命令族）：三面契约登记守护。
 *
 * 覆盖：命令目录（九命令 = contracts/task-api.md §2 全集——零干预断言：清单
 * 即全集，多一个都不行，AD-2）+ 事件目录（task.changed 唯一新事件，O-7 逐
 * 迁移轻负载）+ EVENT_CHANNELS 通道归属（task.changed 挂既有 notification
 * 通道——不新增 Channel 值，契约 §0）+ payload/DTO 类型面编译期可达。
 * SoT 文档面（PROTOCOL.md §15.11/§16.1 计数与登记锚）由
 * sot-consistency.test.ts ①~⑤ 断言兜底。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES } from "../../src/index";
import type {
  CommandEnvelope,
  EventEnvelope,
  ErrorCode,
  TaskArtifactsDto,
  TaskArtifactsResultEvent,
  TaskBatchDto,
  TaskCancelResultEvent,
  TaskChangedEvent,
  TaskDetailDto,
  TaskDetailResultEvent,
  TaskListResultEvent,
  TaskStageDto,
  TaskStatus,
  TaskSubscribeResultEvent,
  TaskSummaryDto,
  TaskUnsubscribeResultEvent,
  TaskDeleteResultEvent,
  TaskPauseResultEvent,
  TaskResumeResultEvent,
  WorkItemDto,
} from "../../src/index";

/** task 族命令全集（契约 §2；清单即全集——多一个都不行，AD-2 零内容干预）。 */
const TASK_COMMANDS = [
  "task.list",
  "task.detail",
  "task.artifacts",
  "task.subscribe",
  "task.unsubscribe",
  "task.pause",
  "task.resume",
  "task.cancel",
  "task.delete",
] as const;

describe("task 批（T1.5）：命令/事件/通道登记", () => {
  test("命令目录：九命令登记且排序在 workspace 族之后", () => {
    for (const t of TASK_COMMANDS) expect(COMMAND_TYPES).toContain(t);
    expect(COMMAND_TYPES.slice(-TASK_COMMANDS.length)).toEqual([...TASK_COMMANDS]);
    expect(COMMAND_TYPES.length).toBe(54); // kg.health 批（W2-E）+1 ∧ kg 评审批（W2-F）+1 后当前值
  });

  test("零干预断言（AD-2）：task.* 命令清单恰为九命令，无 steer/内容编辑/批次重试语义命令", () => {
    const family = COMMAND_TYPES.filter((t) => t.startsWith("task."));
    // 清单即全集（上条已证排序尾段 = TASK_COMMANDS；此处机械 grep 断言）
    expect(family).toEqual([...TASK_COMMANDS]);
    // 否定面：零干预词表不得出现在 task 族命令名中（steer/重试/编辑/创建旁路）
    const forbidden = family.filter((t) => /steer|retry|edit|update|modify|create|write|prompt/i.test(t));
    expect(forbidden).toEqual([]);
  });

  test("事件目录：task.changed 唯一新事件登记（+1；结果帧不入目录）", () => {
    expect(EVENT_TYPES).toContain("task.changed");
    expect(EVENT_TYPES[EVENT_TYPES.length - 1]).toBe("task.changed");
    expect(EVENT_TYPES.length).toBe(67); // kg.health 批（W2-E）+1 ∧ kg 评审批（W2-F）+1 后当前值
    // 九命令结果帧为点对点回执（契约 §0 计数 57→58：仅 task.changed 入目录）
    for (const t of TASK_COMMANDS) {
      expect(EVENT_TYPES).not.toContain(`${t}.result`);
    }
  });

  test("通道归属：task.changed 挂既有 notification 通道（不新增 Channel 值，契约 §0）", () => {
    expect(EVENT_CHANNELS["task.changed"]).toBe("notification");
    expect(Object.keys(EVENT_CHANNELS).length).toBe(67);
  });

  test("错误码词表（契约 §4）：四任务码登记 ErrorCode", () => {
    const codes: ErrorCode[] = [
      "task.type_unknown",
      "task.validation_failed",
      "task.not_found",
      "task.invalid_state",
    ];
    expect(codes.length).toBe(4);
  });

  test("信封判别：task 命令/事件帧可窄化（编译期）+ 判别字段运行时校验", () => {
    const list: CommandEnvelope = { v: "0.11", type: "task.list", payload: { status: "running" } };
    expect(list.type).toBe("task.list");
    if (list.type === "task.list") expect(list.payload.status).toBe("running");

    const pause: CommandEnvelope = { v: "0.11", type: "task.pause", payload: { jobId: "j-1" } };
    if (pause.type === "task.pause") expect(pause.payload.jobId).toBe("j-1");

    const changed: EventEnvelope = {
      v: "0.11",
      sessionId: "__system__",
      channel: "notification",
      type: "task.changed",
      payload: { jobId: "j-1", changed: "job", status: "paused" },
    };
    expect(changed.type).toBe("task.changed");
    if (changed.type === "task.changed") {
      expect(changed.payload.changed).toBe("job");
      expect(changed.payload.status).toBe("paused");
    }

    // 点对点结果帧窄化（编译期守护；不入 EVENT_TYPES 目录——契约 §0 计数纪律）
    const listResult: TaskListResultEvent = {
      v: "0.11",
      sessionId: "__system__",
      channel: "notification",
      type: "task.list.result",
      payload: { tasks: [] },
    };
    expect(listResult.type).toBe("task.list.result");
    const pauseResult: TaskPauseResultEvent = {
      v: "0.11",
      sessionId: "__system__",
      channel: "notification",
      type: "task.pause.result",
      payload: { ok: true, status: "paused" },
    };
    expect(pauseResult.payload.status).toBe("paused");
  });

  test("DTO 类型面（契约 §1 逐字段）：TaskSummary/Detail/Batch/Stage/WorkItem/Artifacts/NodeRef 编译期可达", () => {
    const summary: TaskSummaryDto = {
      jobId: "j-1",
      type: "kg-bootstrap",
      title: "helix 知识图谱创建（demo）",
      status: "running",
      projects: ["demo"],
      createdBy: "page",
      createdAt: "2026-08-29T10:00:00.000Z",
      updatedAt: "2026-08-29T10:01:00.000Z",
      progress: { stageName: "L0 核心层", batchesDone: 1, batchesTotal: 3, percent: 33 },
      error: null,
    };
    const item: WorkItemDto = { seq: 1, content: "盘点 src 依赖", status: "done", note: null };
    const batch: TaskBatchDto = {
      batchId: "b-1",
      stageSeq: 1,
      seq: 1,
      scope: "批次 1：demo L0 探索",
      status: "running",
      retryCount: 0,
      retryNote: null,
      instanceId: "agent-x",
      plan: [item],
    };
    const stage: TaskStageDto = {
      seq: 1,
      name: "L0 核心层",
      status: "running",
      artifact: { summary: "核心层建成摘要" },
    };
    const detail: TaskDetailDto = {
      ...summary,
      stages: [stage],
      batches: [batch],
      params: { projectRoot: "/tmp/demo" },
    };
    const artifacts: TaskArtifactsDto = {
      stages: [{ seq: 1, name: "L0 核心层", status: "done", artifact: { summary: "核心层建成摘要" } }],
    };
    // 六态状态枚举（wire 值 = 后端状态机原值，契约 §0）
    const statuses: TaskStatus[] = ["pending", "running", "paused", "done", "failed", "cancelled"];
    expect(statuses.length).toBe(6);
    expect(detail.jobId).toBe("j-1");
    expect(artifacts.stages[0]!.artifact!.summary).toContain("核心层");

    // 其余结果帧类型面可达（编译期）
    const _rest: [
      TaskDetailResultEvent,
      TaskArtifactsResultEvent,
      TaskSubscribeResultEvent,
      TaskUnsubscribeResultEvent,
      TaskResumeResultEvent,
      TaskCancelResultEvent,
      TaskDeleteResultEvent,
      TaskChangedEvent,
    ] = null as never; // 仅类型引用，无运行时值
    expect(_rest).toBeNull();
  });
});
