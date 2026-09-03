import { afterAll, describe, expect, test } from "bun:test";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { StubBrowserPort } from "../mocks/StubBrowserPort";
import { buildTaskEngineEnv, childLedger, launchRunningJob, type TaskEngineEnv } from "../helpers/task-fixtures";
import { COMMAND_TYPES, PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * task 九命令族 + task.changed I 层（T1.5，CL-3 协议面；契约
 * contracts/task-api.md 逐字段）：真任务栈（TaskEngineService/
 * TaskQueryService × tmp 真库 helix.db 任务四表）× loopback WS 路由
 * （WsServerAdapter.routeCommand → handlers/task.ts）。编排边界 =
 * FakeOrchestratorStarter / FakeTaskSkillRegistry（task-fixtures，T2.2/T2.3
 * 前占位形态——TR-TEST-4 真 SQLite @ tmp）。
 *
 * 覆盖（testing/test-design CL-3 协议面映射）：
 * - 九命令路由与响应帧格式（CL-3-T1/T3/T5/T6 协议面：list 排序与过滤/
 *   detail 阶段条+批次+plan/artifacts 产物）；
 * - 入参形状校验（缺 jobId / status 枚举越界 → command.invalid_payload）；
 * - 服务未装配 → command.unimplemented（kg.ts 先例断言）；
 * - 引擎错误透传（task.invalid_state / task.not_found 原样到达，handler
 *   零状态判断）；
 * - 订阅面：连接 A subscribe{jobId} → 仅 A 收 task.changed；unsubscribe
 *   后不再收；无 jobId 通配全任务（CL-3-T4 协议面）；
 * - 零干预断言：task.* 命令清单 grep 无 steer/内容编辑/批次重试命令
 *   （CL-2-T12/AD-2 协议面）；
 * - task.delete 仅终态可删 + 清理面（F3.6 协议面）。
 */

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

/** 收集帧的 loopback WS 测试客户端（kg-handlers.test.ts 同构）。 */
class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** 发 task 命令并等 task.*.result 结果帧或 connection.error 回执。 */
  async task(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; result: Record<string, unknown>; error: { code: string; message: string } | null }> {
    const at = this.frames.length;
    this.send({ v: PROTOCOL_VERSION, type, payload });
    await until(
      () => this.frames.slice(at).some((f) => f.type === `${type}.result` || f.type === "connection.error"),
      timeoutMs,
      `等待 ${type}.result / connection.error`,
    );
    const err = this.frames.slice(at).find((f) => f.type === "connection.error");
    if (err !== undefined) {
      return { ok: false, result: {}, error: err.payload as { code: string; message: string } };
    }
    const res = this.frames.slice(at).find((f) => f.type === `${type}.result`)!;
    return { ok: true, result: res.payload, error: null };
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── rig：真任务栈 + WsServerAdapter + （可选）多客户端 ──────────

interface Rig {
  readonly env: TaskEngineEnv;
  readonly adapter: WsServerAdapter;
  readonly events: EventStream;
  readonly token: string;
  dispose(): Promise<void>;
}

/** adapter 依赖面 stub（kg-handlers.test.ts 同构：task 面外全部 no-op）。 */
function stubAdapterDeps(events: EventStream) {
  return {
    chat: {
      sendMessage: async () => ({ mode: "turn" as const, turnId: "t", entryId: "e" }),
      steer: async () => ({ entryId: "e" }),
      abort: () => {},
    },
    directory: {
      listSessions: async () => [],
      sessionExists: async () => false,
      resolveTarget: async () => "s",
      getSessionView: async () => ({
        session: {
          sessionId: "s",
          createdAt: "2026-08-29T00:00:00.000Z",
          entries: [],
          turns: [],
          pendingSteer: [],
        },
        toolCalls: [],
      }),
      startDraftSession: async () => {
        throw new Error("task 测试不装配草稿链");
      },
      deleteSession: async () => {},
      currentSessionId: () => "s",
    },
    system: {
      getStatus: () => ({
        running: true,
        locked: false,
        home: "/tmp/task-it",
        sessionId: "s",
        agentState: "idle",
        model: "stub/model",
      }),
      shutdown: async () => {},
    },
    orchestration: {
      spawn: () => ({ status: "rejected" as const, error: "task 测试不装配调度" }),
      send: () => ({ delivered: false, detail: "stub" }),
      status: () => [],
      kill: () => ({ killed: false, error: "stub" }),
      inspect: () => null,
      park: () => ({ parked: false as const, error: "测试桩不挂起" }),
      resume: () => ({ resumed: false as const, error: "测试桩不恢复" }),
    },
    model: {
      setModel: async () => {
        throw new Error("stub");
      },
      setThinking: async () => {
        throw new Error("stub");
      },
      getModel: async () => {
        throw new Error("stub");
      },
      catalog: async () => {
        throw new Error("stub");
      },
      catalogRefresh: async () => {
        throw new Error("stub");
      },
      setThinkingDefault: async () => ({ previous: null }), setDefault: async () => {
        throw new Error("stub");
      },
      getDefault: () => ({ model: "stub/model", thinkingDefault: null }),
      authList: async () => [],
      authSetKey: async () => {
        throw new Error("stub");
      },
      authDeleteKey: async () => {},
      authVerify: async () => ({ status: "fail" as const, reason: "stub" }),
    },
    resource: {
      list: async () => {
        throw new Error("stub");
      },
      setEnabled: async () => {
        throw new Error("stub");
      },
      setModelSlot: async () => {
        throw new Error("stub");
      },
      clearModelSlot: async () => {
        throw new Error("stub");
      },
      setThinkingSlot: async () => {
        throw new Error("stub");
      },
      modelSlot: () => undefined, thinkingSlot: () => undefined, clearThinkingSlot: async () => {
        throw new Error("stub");
      },
    },
    hasModel: () => false,
      kgWriterPinnedTools: ["kg-update"],
      reviewerRemovedTools: ["write", "edit"], // D5 第五 kind 派生面（WsServerAdapter 必填注入）
      basePrompts: {},
    browser: new StubBrowserPort(),
    events,
    token: "task-it-token",
    port: 0,
  };
}

/** 每 test 独立 rig：真任务栈接 ws adapter（withTaskEnv 同构自管清理）。 */
async function makeRig(withTask = true): Promise<Rig> {
  const env = buildTaskEngineEnv();
  const events = new EventStream();
  const adapter = new WsServerAdapter({
    ...stubAdapterDeps(events),
    ...(withTask ? { taskQuery: env.query, taskEngine: env.engine } : {}),
  });
  return {
    env,
    adapter,
    events,
    token: "task-it-token",
    dispose: async () => {
      adapter.stop();
      await env.dispose();
    },
  };
}

const rigs: Rig[] = [];

async function openClient(rig: Rig): Promise<TestClient> {
  const client = new TestClient(`ws://127.0.0.1:${rig.adapter.port}`);
  await client.open();
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: rig.token, protocolVersion: PROTOCOL_VERSION } });
  await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
  return client;
}

async function rigWithClient(withTask = true): Promise<{ rig: Rig; client: TestClient }> {
  const rig = await makeRig(withTask);
  rigs.push(rig);
  const client = await openClient(rig);
  return { rig, client };
}

afterAll(async () => {
  for (const r of rigs) await r.dispose();
  rigs.length = 0;
});

// ── 1. 九命令路由：响应帧格式逐字段（契约 §2） ────────────────

describe("task 族 I 层：九命令路由（T1.5，contracts/task-api.md §2）", () => {
  test("task.list：全局平铺 + 过滤器服务端生效（运行中置顶，CL-3-T1）", async () => {
    const { rig, client } = await rigWithClient();
    try {
      const running = await launchRunningJob(rig.env, { projects: ["demo"] });
      const { jobId: pendingId } = await rig.env.engine.createTask({
        type: "zero-project-scan",
        projects: [],
        params: {},
        createdBy: "chat",
      });
      const res = await client.task("task.list", {});
      expect(res.ok).toBe(true);
      const tasks = res.result["tasks"] as Record<string, unknown>[];
      expect(tasks.length).toBe(2);
      // 服务端排序：运行中置顶
      expect(tasks[0]!.jobId).toBe(running.jobId);
      expect(tasks[0]!.status).toBe("running");
      // 列表行字段（契约 §1 TaskSummaryDto）
      expect(tasks[0]!.type).toBe("kg-bootstrap");
      expect(typeof tasks[0]!.title).toBe("string");
      expect(tasks[0]!.projects).toEqual(["demo"]);
      expect(tasks[0]!.createdBy).toBe("page");
      expect(tasks[0]!.progress).not.toBeNull();
      expect(tasks[1]!.jobId).toBe(pendingId);
      expect(tasks[1]!.status).toBe("pending");
      expect(tasks[1]!.progress).toBeNull();

      // 状态过滤器
      const doneOnly = await client.task("task.list", { status: "done" });
      expect((doneOnly.result["tasks"] as unknown[]).length).toBe(0);
      // 项目过滤器（AD-8）
      const hit = await client.task("task.list", { project: "demo" });
      expect((hit.result["tasks"] as Record<string, unknown>[]).length).toBe(1);
      const miss = await client.task("task.list", { project: "other" });
      expect((miss.result["tasks"] as unknown[]).length).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("task.detail：阶段条 + 批次（带 stageSeq 分组键）+ 实例 plan + 台账摘要 ledger（CL-3-T3/T5 + P1-⑥）", async () => {
    const { rig, client } = await rigWithClient();
    try {
      const { jobId } = await launchRunningJob(rig.env, { projects: ["demo"] });
      // 实例台账（inst-a）：#1 in_progress + #2 pending → ledger 计数上 wire
      const child = childLedger(rig.env.dbPath);
      await child.insertItems("inst-a", [
        { seq: 1, content: "扫描 demo 项目符号面" },
        { seq: 2, content: "落 L0 核心节点" },
      ]);
      await child.updateItem("inst-a", 1, "in_progress");
      const res = await client.task("task.detail", { jobId });
      expect(res.ok).toBe(true);
      const task = res.result["task"] as Record<string, any>;
      expect(task.jobId).toBe(jobId);
      expect(task.stages.length).toBe(3);
      expect(task.stages[0].name).toBe("L0 核心层");
      expect(task.stages[0].status).toBe("running");
      expect(task.batches.length).toBe(1);
      const batch = task.batches[0];
      expect(batch.status).toBe("running");
      expect(batch.retryCount).toBe(0);
      expect(batch.instanceId).toBe("inst-a");
      expect(batch.stageSeq).toBe(1);
      expect(typeof batch.scope).toBe("string");
      // 台账摘要 wire 形状（P1-⑥）：服务端计数 + plan 全行
      expect(batch.ledger).toEqual({ total: 2, done: 0, inProgress: 1 });
      expect(batch.plan).toEqual([
        { seq: 1, content: "扫描 demo 项目符号面", status: "in_progress", note: null },
        { seq: 2, content: "落 L0 核心节点", status: "pending", note: null },
      ]);
      // 叙述句已拆除（裁决 ③）：结果帧无 currentNarrative 键
      expect(task).not.toHaveProperty("currentNarrative");
      expect(task.params).toEqual({ projectRoot: "/tmp/demo" });
    } finally {
      await client.close();
    }
  });

  test("task.artifacts：阶段产物只读投影（CL-3-T6；AD-4② 人类可读；D2 body additive 透传）", async () => {
    const { rig, client } = await rigWithClient();
    try {
      const { jobId } = await launchRunningJob(rig.env, { projects: ["demo"] });
      const res = await client.task("task.artifacts", { jobId });
      expect(res.ok).toBe(true);
      const artifacts = res.result["artifacts"] as Record<string, any>;
      expect(artifacts.stages.length).toBe(3);
      expect(artifacts.stages[0].artifact).toBeNull(); // 未完成阶段无产物
      // D2：引擎聚合含 body 的产物 → wire DTO 原样带出；无 body 阶段不携带键
      const body = "## 发现\n\n- [高] a.ts:1 竞态";
      await rig.env.engine.writeStageArtifact(jobId, 1, { summary: "L0 摘要：审 2 模块", body });
      await rig.env.engine.advanceStage(jobId, 2);
      const { batchId: b2 } = await rig.env.engine.insertBatch({ jobId, stageSeq: 2, scope: "批次 1：L1" });
      await rig.env.engine.dispatchBatch(b2, "inst-b");
      await rig.env.engine.writeStageArtifact(jobId, 2, { summary: "L1 仅摘要" });
      const res2 = await client.task("task.artifacts", { jobId });
      const artifacts2 = res2.result["artifacts"] as Record<string, any>;
      expect(artifacts2.stages[0].artifact).toEqual({ summary: "L0 摘要：审 2 模块", body });
      expect(artifacts2.stages[1].artifact).toEqual({ summary: "L1 仅摘要" });
      expect(artifacts2.stages[1].artifact).not.toHaveProperty("body");
      // 详情帧同形状（阶段条 DTO）
      const detailRes = await client.task("task.detail", { jobId });
      const task = detailRes.result["task"] as Record<string, any>;
      expect(task.stages[0].artifact).toEqual({ summary: "L0 摘要：审 2 模块", body });
      expect(task.stages[1].artifact).not.toHaveProperty("body");
    } finally {
      await client.close();
    }
  });

  test("task.subscribe / task.unsubscribe：回执 { ok: true }（订阅过滤见下组）", async () => {
    const { rig, client } = await rigWithClient();
    try {
      const sub = await client.task("task.subscribe", { jobId: "j-any" });
      expect(sub.ok).toBe(true);
      expect(sub.result["ok"]).toBe(true);
      const unsub = await client.task("task.unsubscribe", { jobId: "j-any" });
      expect(unsub.result["ok"]).toBe(true);
      // 通配形态（无 jobId）
      const subAll = await client.task("task.subscribe", {});
      expect(subAll.result["ok"]).toBe(true);
      const unsubAll = await client.task("task.unsubscribe", {});
      expect(unsubAll.result["ok"]).toBe(true);
    } finally {
      await client.close();
    }
  });
});

// ── 2. 入参形状校验（收口 handler 入口；枚举越界 → command.invalid_payload） ──

describe("task 族 I 层：入参校验", () => {
  test("缺 jobId → command.invalid_payload（detail/artifacts/pause/resume/cancel/delete）", async () => {
    const { client } = await rigWithClient();
    try {
      for (const type of ["task.detail", "task.artifacts", "task.pause", "task.resume", "task.cancel", "task.retry", "task.delete"]) {
        const res = await client.task(type, {});
        expect(res.ok).toBe(false);
        expect(res.error!.code).toBe("command.invalid_payload");
        expect(res.error!.message).toContain("jobId");
      }
    } finally {
      await client.close();
    }
  });

  test("task.list status 枚举越界 → command.invalid_payload；project 非 string 同", async () => {
    const { client } = await rigWithClient();
    try {
      const bad = await client.task("task.list", { status: "bogus" });
      expect(bad.error!.code).toBe("command.invalid_payload");
      const badProject = await client.task("task.list", { project: 42 });
      expect(badProject.error!.code).toBe("command.invalid_payload");
      const badJobId = await client.task("task.subscribe", { jobId: 7 });
      expect(badJobId.error!.code).toBe("command.invalid_payload");
    } finally {
      await client.close();
    }
  });
});

// ── 3. 服务未装配 → command.unimplemented（kg.ts 先例） ─────────

describe("task 族 I 层：unimplemented 门控", () => {
  test("任务栈未装配 → 十命令全部 command.unimplemented 回执不崩溃", async () => {
    const { client } = await rigWithClient(false);
    try {
      for (const type of ["task.list", "task.detail", "task.artifacts", "task.subscribe", "task.unsubscribe", "task.pause", "task.resume", "task.cancel", "task.retry", "task.delete"]) {
        const res = await client.task(type, type === "task.list" ? {} : { jobId: "j-1" });
        expect(res.ok).toBe(false);
        expect(res.error!.code).toBe("command.unimplemented");
      }
    } finally {
      await client.close();
    }
  });
});

// ── 4. 引擎错误透传（handler 零状态判断；契约 §4 词表原样到达） ──

describe("task 族 I 层：引擎错误透传", () => {
  test("task.pause 于 pending 任务 → task.invalid_state 原样到达", async () => {
    const { rig, client } = await rigWithClient();
    try {
      const { jobId } = await rig.env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      const res = await client.task("task.pause", { jobId });
      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("task.invalid_state");
      expect(res.error!.message).toContain(jobId);
    } finally {
      await client.close();
    }
  });

  test("task.detail 于不存在 jobId → task.not_found；task.delete 于运行中任务 → task.invalid_state", async () => {
    const { rig, client } = await rigWithClient();
    try {
      const missing = await client.task("task.detail", { jobId: "no-such-job" });
      expect(missing.error!.code).toBe("task.not_found");

      const { jobId } = await launchRunningJob(rig.env);
      const del = await client.task("task.delete", { jobId });
      expect(del.error!.code).toBe("task.invalid_state"); // 仅终态可删（判断收口引擎）
    } finally {
      await client.close();
    }
  });
});

// ── 5. 订阅面：task.changed 连接级过滤（CL-3-T4 协议面；O-7 逐迁移） ──

describe("task.changed 推送：连接级订阅表过滤（O-7）", () => {
  test("订阅连接收到且仅收到其订阅 jobId 的 task.changed 帧；unsubscribe 后不再收", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const a = await openClient(rig);
    const b = await openClient(rig);
    try {
      const { jobId } = await launchRunningJob(rig.env);
      const other = await launchRunningJob(rig.env, { projects: ["beta"], params: { projectRoot: "/tmp/beta" } });

      // A 订阅 jobId；B 未订阅
      const sub = await a.task("task.subscribe", { jobId });
      expect(sub.result["ok"]).toBe(true);

      // B 触发暂停（running → paused）：A 收 task.changed，B 只收结果帧
      const pause = await b.task("task.pause", { jobId });
      expect(pause.ok).toBe(true);
      expect(pause.result["status"]).toBe("paused");
      await until(() => a.frames.some((f) => f.type === "task.changed"), 3000, "A 收到 task.changed");
      const changed = a.frames.find((f) => f.type === "task.changed")!;
      expect(changed.payload).toEqual({ jobId, changed: "job", status: "paused" });
      expect(changed.sessionId).toBe("__system__");
      // B 未订阅：零 task.changed 帧
      expect(b.frames.filter((f) => f.type === "task.changed").length).toBe(0);

      // 退订后 A 不再收（B 触发 resume：paused → running）
      const unsub = await a.task("task.unsubscribe", { jobId });
      expect(unsub.result["ok"]).toBe(true);
      const resume = await b.task("task.resume", { jobId });
      expect(resume.result["status"]).toBe("running");
      await new Promise((r) => setTimeout(r, 150)); // 广播竞态窗口
      expect(a.frames.filter((f) => f.type === "task.changed").length).toBe(1); // 仍只有暂停那帧

      // 订阅未命中 jobId 的任务：A 不收 job1 的变更；改订 other 后收 other 的 cancel
      const subOther = await a.task("task.subscribe", { jobId: other.jobId });
      expect(subOther.result["ok"]).toBe(true);
      const cancel = await b.task("task.cancel", { jobId: other.jobId });
      expect(cancel.result["status"]).toBe("cancelled");
      await until(
        () => a.frames.filter((f) => f.type === "task.changed").length >= 2,
        3000,
        "A 收到 other 的 task.changed",
      );
      // A 只再收 other 的 cancel 帧（jobId 命中）；job1 的 resume 未订阅不收
      const aChanged = a.frames.filter((f) => f.type === "task.changed");
      expect(aChanged.length).toBe(2);
      expect(aChanged[1]!.payload).toEqual({ jobId: other.jobId, changed: "job", status: "cancelled" });
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("无 jobId 通配：订阅连接收到任意任务变更（全任务通配档）", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const a = await openClient(rig);
    const b = await openClient(rig);
    try {
      const { jobId } = await launchRunningJob(rig.env);
      await a.task("task.subscribe", {});
      const pause = await b.task("task.pause", { jobId });
      expect(pause.ok).toBe(true);
      await until(() => a.frames.some((f) => f.type === "task.changed"), 3000, "通配订阅收到 task.changed");
      const changed = a.frames.find((f) => f.type === "task.changed")!;
      expect(changed.payload).toEqual({ jobId, changed: "job", status: "paused" });
      // 通配清除后不再收
      await a.task("task.unsubscribe", {});
      await b.task("task.resume", { jobId });
      await new Promise((r) => setTimeout(r, 150));
      expect(a.frames.filter((f) => f.type === "task.changed").length).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

// ── 6. 生命周期 + 删除（F3.5/F3.6 协议面） ────────────────────

describe("task 生命周期与删除（F3.5/F3.6）", () => {
  test("pause → resume → cancel 链路回执携带后置状态；delete 终态可删且 detail 不再可查", async () => {
    const { rig, client } = await rigWithClient();
    try {
      const { jobId } = await launchRunningJob(rig.env);
      const pause = await client.task("task.pause", { jobId });
      expect(pause.result).toEqual({ ok: true, status: "paused" });
      const resume = await client.task("task.resume", { jobId });
      expect(resume.result).toEqual({ ok: true, status: "running" });
      const cancel = await client.task("task.cancel", { jobId });
      expect(cancel.result).toEqual({ ok: true, status: "cancelled" });
      const del = await client.task("task.delete", { jobId });
      expect(del.result).toEqual({ ok: true });
      const gone = await client.task("task.detail", { jobId });
      expect(gone.error!.code).toBe("task.not_found");
    } finally {
      await client.close();
    }
  });

  test("task.retry：failed 任务复活回执 running + task.changed 广播；非 failed → task.invalid_state 透传", async () => {
    const { rig, client } = await rigWithClient();
    try {
      const { jobId, batchId } = await launchRunningJob(rig.env);
      // 非 failed 拒绝（running 态）
      const early = await client.task("task.retry", { jobId });
      expect(early.ok).toBe(false);
      expect(early.error!.code).toBe("task.invalid_state");
      // 打满三次失败 → 超限上浮 job failed
      for (const note of ["一", "二", "三"]) {
        await rig.env.engine.failBatch(batchId, `closure 失败（${note}）`);
        if (note !== "三") await rig.env.engine.dispatchBatch(batchId, `inst-${note}`);
      }
      expect(rig.env.store.getJob(jobId)!.status).toBe("failed");
      const retry = await client.task("task.retry", { jobId });
      expect(retry.result).toEqual({ ok: true, status: "running" });
      // 复活后行状态：批次预算归零留痕 + stage 重开 + error 清空
      expect(rig.env.store.getBatch(batchId)).toMatchObject({ status: "failed", retryCount: 0 });
      expect(rig.env.store.getBatch(batchId)!.retryNote).toContain("人工重试");
      expect(rig.env.store.getJob(jobId)!).toMatchObject({ status: "running", error: null });
    } finally {
      await client.close();
    }
  });
});

// ── 7. 零干预断言（AD-2）：协议面不存在 steer/内容编辑/批次重试命令 ──

describe("零干预断言（AD-2，CL-2-T12 协议面）", () => {
  test("task.* 命令清单恰为十命令全集，grep 无 steer/edit 语义命令（task.retry 白名单例外——job 级人工复活）", () => {
    const family = COMMAND_TYPES.filter((t) => t.startsWith("task."));
    expect(family).toEqual([
      "task.list",
      "task.detail",
      "task.artifacts",
      "task.subscribe",
      "task.unsubscribe",
      "task.pause",
      "task.resume",
      "task.cancel",
      "task.retry",
      "task.delete",
    ]);
    // task.retry 为白名单例外：job 级生命周期人工复活，非批次重试/内容干预（AD-2 保持）
    const forbidden = family.filter((t) => t !== "task.retry" && /steer|retry|edit|update|modify|create|write|prompt/i.test(t));
    expect(forbidden).toEqual([]);
    expect(COMMAND_TYPES.length).toBe(61); // task.retry 批 +1 后当前值
  });
});
