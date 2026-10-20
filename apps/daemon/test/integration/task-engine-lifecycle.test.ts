/**
 * 任务引擎服务（TaskEngineService）生命周期面：pause / resume 暂停期重试耗尽
 * 上浮 / cancel / deleteTask 级联 / 启动恢复扫描 / 重试超限上浮 / 人工重试。
 * 纯位置迁移自 task-engine.test.ts（P1 体量门拆分批，测试逻辑/断言零改动）。
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withTaskEnv, launchRunningJob, childLedger } from "../helpers/task-fixtures";
import { TaskError } from "../../src/application/services/task/TaskError";

const ENGINE_SOURCE = fileURLToPath(new URL("../../src/application/services/task/TaskEngineService.ts", import.meta.url));

describe("pause 语义（CL-3-T7 引擎面，O-2 + ⑤ 链 A 编排层挂起接线）", () => {
  test("running → paused 落库 + parkAll 挂起编排；在跑批次 completeBatch 照常落 done；派发闸拒绝新批次；resume = resumeAll 先行 + startOrchestrator", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.pause(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("paused");
      // 链 A：落库后编排层挂起（parkAll 恰一次）
      expect(env.starter.parks).toEqual([jobId]);
      // 在跑批次自然收口：照常终态化（终态赢，机械判定不依赖编排状态）
      await env.engine.completeBatch(batchId);
      const batches = env.store.getBatches(jobId, 1);
      expect(batches).toHaveLength(1);
      expect(batches[0]!.status).toBe("done");
      // 派发闸：paused 下不产生新 batch 行（引擎面拒绝，T2.2 编排侧同语义）
      await expect(env.engine.insertBatch({ jobId, stageSeq: 2, scope: "新批次" })).rejects.toMatchObject({
        code: "task.invalid_state",
      });
      expect(env.store.getBatches(jobId, 2)).toHaveLength(0);
      // resume：paused→running + resumeAll（先复活实例/解冻 loop）先于 startOrchestrator（kick）
      const startsBefore = env.starter.startCount(jobId);
      env.starter.calls.length = 0;
      await env.engine.resume(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("running");
      expect(env.starter.startCount(jobId)).toBe(startsBefore + 1);
      expect(env.starter.calls).toEqual([`resume:${jobId}`, `start:${jobId}`]); // 序 = 先复活再 kick
      expect(env.starter.resumes).toEqual([jobId]);
    });
  });

  test("非 running 暂停 → task.invalid_state；不存在 job → task.not_found", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      await expect(env.engine.pause(jobId)).rejects.toMatchObject({ code: "task.invalid_state" });
      await expect(env.engine.pause("job-none")).rejects.toMatchObject({ code: "task.not_found" });
    });
  });
});

describe("resume 暂停期重试耗尽上浮（H1）", () => {
  test("暂停期 failBatch 耗尽重试预算 → resume 置 running 后上浮 stage/job failed + haltJob 清场，不续跑", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId, scope } = await launchRunningJob(env);
      // 预算内两次失败（running：排期重试 → 重派回 running）
      await env.engine.failBatch(batchId, "第一次失败");
      await env.engine.dispatchBatch(batchId, "inst-b");
      await env.engine.failBatch(batchId, "第二次失败");
      await env.engine.dispatchBatch(batchId, "inst-c");
      // 暂停期第三次失败：retryCount=3 超限，但 job=paused 不上浮（failBatch 仅 running 上浮）
      await env.engine.pause(jobId);
      await env.engine.failBatch(batchId, "暂停期失败");
      expect(env.store.getBatch(batchId)!.retryCount).toBe(3);
      expect(env.store.getJob(jobId)!.status).toBe("paused");
      env.starter.calls.length = 0;
      await env.engine.resume(jobId);
      // 上浮：stage failed → job failed（error 含 scope 与 retryCount）+ haltJob 清场
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("failed");
      const job = env.store.getJob(jobId)!;
      expect(job.status).toBe("failed");
      expect(job.error).toContain(scope);
      expect(job.error).toContain("3");
      expect(env.starter.halts).toEqual([jobId]);
      // 不续跑：resumeAll/startOrchestrator 均不调用
      expect(env.starter.calls).toEqual([`halt:${jobId}`]);
    });
  });

  test("同阶段仍有在跑批次（parked 待复活）→ resume 正常续跑不上浮", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      const { batchId: batchId2 } = await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 2" });
      await env.engine.dispatchBatch(batchId2, "inst-d");
      await env.engine.failBatch(batchId, "f1");
      await env.engine.dispatchBatch(batchId, "inst-b");
      await env.engine.failBatch(batchId, "f2");
      await env.engine.dispatchBatch(batchId, "inst-c");
      await env.engine.pause(jobId);
      await env.engine.failBatch(batchId, "f3");
      env.starter.calls.length = 0;
      await env.engine.resume(jobId);
      // 阶段仍有 running 批次（parked 待复活）→ 不上浮，正常续跑
      expect(env.store.getJob(jobId)!.status).toBe("running");
      expect(env.starter.calls).toEqual([`resume:${jobId}`, `start:${jobId}`]);
    });
  });

  test("F3：耗尽批次 resume 时因兄弟在跑被跳过 → 兄弟收口 done 时 completeBatch 延迟上浮清场（不再永久卡死）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId, scope } = await launchRunningJob(env);
      const { batchId: batchId2 } = await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 2" });
      await env.engine.dispatchBatch(batchId2, "inst-d");
      // 批次 1 三次失败耗尽预算（第三次在暂停期 → failBatch 不上浮）
      await env.engine.failBatch(batchId, "f1");
      await env.engine.dispatchBatch(batchId, "inst-b");
      await env.engine.failBatch(batchId, "f2");
      await env.engine.dispatchBatch(batchId, "inst-c");
      await env.engine.pause(jobId);
      await env.engine.failBatch(batchId, "f3");
      // resume：兄弟批次 2 仍 running（parked 待复活）→ othersTerminal 守卫跳过，正常续跑
      await env.engine.resume(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("running");
      env.starter.calls.length = 0;
      // 兄弟批次收口 done → 同阶段其余批次全终态 → 耗尽批次延迟上浮（修复前：无任何机械收口路径，job 永久卡 running）
      await env.engine.completeBatch(batchId2);
      expect(env.store.getBatch(batchId2)!.status).toBe("done"); // 迟到成功保留：done 照落不反转
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("failed");
      const job = env.store.getJob(jobId)!;
      expect(job.status).toBe("failed");
      expect(job.error).toContain(scope);
      expect(job.error).toContain("延迟上浮");
      expect(env.starter.halts).toEqual([jobId]);
      expect(env.starter.calls).toEqual([`halt:${jobId}`]);
    });
  });

  test("F3：兄弟批次暂停期已收口 done（paused 下不判）→ resume 时 othersTerminal 成立直接上浮", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId, scope } = await launchRunningJob(env);
      const { batchId: batchId2 } = await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 2" });
      await env.engine.dispatchBatch(batchId2, "inst-d");
      await env.engine.failBatch(batchId, "f1");
      await env.engine.dispatchBatch(batchId, "inst-b");
      await env.engine.failBatch(batchId, "f2");
      await env.engine.dispatchBatch(batchId, "inst-c");
      await env.engine.pause(jobId);
      // 暂停期：批次 1 耗尽 + 兄弟批次 2 自然收口 done（O-2 照常落库不推进——completeBatch 不触发上浮）
      await env.engine.failBatch(batchId, "f3");
      await env.engine.completeBatch(batchId2);
      expect(env.store.getJob(jobId)!.status).toBe("paused");
      env.starter.calls.length = 0;
      // resume：同阶段其余批次全终态（done）→ 既有补判面上浮清场
      await env.engine.resume(jobId);
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("failed");
      const job = env.store.getJob(jobId)!;
      expect(job.status).toBe("failed");
      expect(job.error).toContain(scope);
      expect(env.starter.calls).toEqual([`halt:${jobId}`]);
    });
  });
});

describe("cancel 语义（CL-3-T7）", () => {
  test("cancel：编排 stop 被调 + job cancelled + 在跑批次标 failed（retry_note=cancelled）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.cancel(jobId);
      expect(env.starter.stops).toContain(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("cancelled");
      const batch = env.store.getBatch(batchId)!;
      expect(batch.status).toBe("failed");
      expect(batch.retryNote).toContain("cancelled");
    });
  });

  test("pending job 可直接 cancel（编排未接管/零批次滞留场景，协议面 pending/running/paused→cancelled 契约）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      expect(env.store.getJob(jobId)!.status).toBe("pending");
      await env.engine.cancel(jobId);
      expect(env.starter.stops).toContain(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("cancelled");
    });
  });

  test("cancel 后迟到 failBatch 不触发重试（重试调度前查 job.status）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.cancel(jobId);
      const outcome = await env.engine.failBatch(batchId, "迟到 closure 失败");
      expect(outcome.retryScheduled).toBe(false);
      const batch = env.store.getBatch(batchId)!;
      expect(batch.status).toBe("failed");
      expect(batch.retryCount).toBe(0);
    });
  });

  test("终态 job cancel → task.invalid_state", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await env.engine.cancel(jobId);
      await expect(env.engine.cancel(jobId)).rejects.toBeInstanceOf(TaskError);
    });
  });

  test("cancel 收口 stage（M6 #2.5）：running/pending stage 一并标 failed——不再永久滞留", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await launchRunningJob(env); // stage1 running（批次 running）+ stage2/3 pending
      await env.engine.cancel(jobId);
      expect(env.store.getJob(jobId)!.status).toBe("cancelled");
      // 原行为：cancel 只收口 batch/job 不回填 stage——running/pending stage 永久滞留
      //（引擎推进门全部被批次终态拦截，阶段条与库内事实背离）；修复后全部非终态 stage failed
      const stages = env.store.getStages(jobId);
      expect(stages.map((s) => [s.seq, s.status])).toEqual([
        [1, "failed"],
        [2, "failed"],
        [3, "failed"],
      ]);
    });
  });

  test("cancel 收口 stage：done stage 保留（已完成工作不丢），仅非终态 stage 标 failed", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      // stage 1 全流程收口 done
      const s1 = await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" });
      await env.engine.advanceStage(jobId, 1);
      await env.engine.dispatchBatch(s1.batchId, "inst-1");
      await env.engine.completeBatch(s1.batchId);
      await env.engine.writeStageArtifact(jobId, 1, { summary: "L0 完成" });
      // stage 2 running（批次 in-flight），stage 3 pending
      const s2 = await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "批次 2" });
      await env.engine.advanceStage(jobId, 2);
      await env.engine.dispatchBatch(s2.batchId, "inst-2");

      await env.engine.cancel(jobId);
      const stages = env.store.getStages(jobId);
      expect(stages.find((s) => s.seq === 1)!.status).toBe("done"); // done 保留
      expect(stages.find((s) => s.seq === 1)!.artifact).toEqual({ summary: "L0 完成" });
      expect(stages.find((s) => s.seq === 2)!.status).toBe("failed");
      expect(stages.find((s) => s.seq === 3)!.status).toBe("failed");
      expect(env.store.getBatch(s2.batchId)!.status).toBe("failed");
    });
  });

  test("cancel 的 pending 批次直标 failed 走 domain 显性出边（pending→failed 已入迁移集，M6 #2.5）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await launchRunningJob(env); // stage1 running
      // stage1 追加一个 pending 批次（未派发）——cancel 时 pending→failed 显性迁移
      const extra = await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "未派发批次" });
      expect(env.store.getBatch(extra.batchId)!.status).toBe("pending");
      await env.engine.cancel(jobId);
      const batch = env.store.getBatch(extra.batchId)!;
      expect(batch.status).toBe("failed");
      expect(batch.retryNote).toContain("cancelled");
    });
  });
});

describe("deleteTask（CL-3-T12 引擎面，F3.6）", () => {
  test("running 删除拒绝（task.invalid_state）；cancelled 后删除 → 四表清零 + 他任务不动 + kg 面零调用", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      // 造实例 plan（work_item，子进程直连写面）
      const child = childLedger(env.dbPath);
      await child.insertItems("inst-a", [
        { seq: 1, content: "扫描 demo 项目符号面" },
        { seq: 2, content: "落 L0 核心节点" },
      ]);
      expect(env.workLedger.getItems("inst-a")).toHaveLength(2);
      // 他任务锚点（不受本次删除影响）
      const other = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["other"],
        params: { projectRoot: "/o" },
        createdBy: "chat",
      });
      // running 删除拒绝
      await expect(env.engine.deleteTask(jobId)).rejects.toMatchObject({ code: "task.invalid_state" });
      // 终态后删除
      await env.engine.cancel(jobId);
      const { deletedCounts } = await env.engine.deleteTask(jobId);
      expect(deletedCounts).toEqual({
        jobs: 1,
        stages: 3,
        batches: 1,
        events: 0,
        lifecycleRows: 0,
        closures: 0,
        steerRows: 0,
        toolCallRows: 0,
        pendingSyncs: 0,
      });
      expect(env.reportDirRemoved).toEqual([jobId]); // 报告目录级联调用
      expect(env.store.getJob(jobId)).toBeUndefined();
      expect(env.store.getStages(jobId)).toHaveLength(0);
      expect(env.store.getBatches(jobId, 1)).toHaveLength(0);
      expect(env.workLedger.getItems("inst-a")).toHaveLength(0); // work_item 一并清（四表清零）
      expect(env.store.getJob(other.jobId)).toBeDefined(); // 他任务不动
      expect(env.store.getStages(other.jobId)).toHaveLength(3);
    });
  });

  test("任务会话六表级联清零（trace 事件/收口档案/生命周期投影随任务同灭）+ 他会话不动", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await launchRunningJob(env);
      const other = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["other"],
        params: { projectRoot: "/o" },
        createdBy: "chat",
      });
      // 造任务会话痕迹：domain_events ×2 + agent_lifecycle ×1 + closure_records ×1
      const sid = `task:${jobId}`;
      await env.queue.appendEvent(
        { type: "tool.call.started", sessionId: sid, instanceId: "inst-a", payload: { toolCallId: "t1", toolName: "read", args: {} }, occurredAt: new Date().toISOString() },
        "subagent",
      );
      await env.queue.appendEvent(
        { type: "message.completed", sessionId: sid, instanceId: "inst-a", payload: { entryId: "inst-a#1", role: "assistant", content: "x" }, occurredAt: new Date().toISOString() },
        "subagent",
      );
      await env.queue.saveAgentLifecycle(sid, "inst-a", "running");
      await env.queue.saveClosureRecord(sid, "inst-a", "done", { status: "done", summary: "收口", findings: [] });
      // 他会话痕迹（不受本次删除影响）
      const otherSid = `task:${other.jobId}`;
      await env.queue.appendEvent(
        { type: "agent.spawned", sessionId: otherSid, instanceId: "inst-b", payload: { agentId: "inst-b", task: "t", profileKind: "subagent-worker" }, occurredAt: new Date().toISOString() },
        "subagent",
      );
      const countOf = (table: string, sessionId: string): number =>
        (env.queue.database.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE session_id = ?`).get(sessionId) as { c: number }).c;
      expect(countOf("domain_events", sid)).toBe(2);
      expect(countOf("agent_lifecycle", sid)).toBe(1);
      expect(countOf("closure_records", sid)).toBe(1);

      await env.engine.cancel(jobId);
      const { deletedCounts } = await env.engine.deleteTask(jobId);
      expect(deletedCounts.events).toBe(2);
      expect(deletedCounts.lifecycleRows).toBe(1);
      expect(deletedCounts.closures).toBe(1);
      expect(countOf("domain_events", sid)).toBe(0);
      expect(countOf("agent_lifecycle", sid)).toBe(0);
      expect(countOf("closure_records", sid)).toBe(0);
      expect(countOf("domain_events", otherSid)).toBe(1); // 他会话不动
    });
  });

  test("kg 写面零依赖机械审计：TaskEngineService import 面无 kg（deleteTask 不触 kg）", async () => {
    const source = await readFile(ENGINE_SOURCE, "utf8");
    const imports = source
      .split("\n")
      .filter((line) => line.trim().startsWith("import"))
      .join("\n");
    expect(/kg|knowledge/i.test(imports)).toBe(false);
    expect(/KnowledgeGraph|KgWrite|KgQuery/.test(source)).toBe(false);
  });
});

describe("启动恢复扫描（CL-2-T4 引擎面，F2.3）", () => {
  test("running job（一 done stage + 一 running batch）→ 批次 failed 收口且 retryCount+1、done stage 不重跑、starter 重开", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      // stage 1 全流程收口 done
      const s1 = await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" });
      await env.engine.advanceStage(jobId, 1);
      await env.engine.dispatchBatch(s1.batchId, "inst-1");
      await env.engine.completeBatch(s1.batchId);
      await env.engine.writeStageArtifact(jobId, 1, { summary: "L0 完成：核心规则 1 条" });
      // stage 2 in-flight 批次（模拟 daemon 崩溃现场）
      const s2 = await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "批次 2" });
      await env.engine.advanceStage(jobId, 2);
      await env.engine.dispatchBatch(s2.batchId, "inst-2");
      // 恢复
      const startsBefore = env.starter.starts.length;
      const { resumedJobIds } = await env.engine.recoverOnStartup();
      expect(resumedJobIds).toEqual([jobId]);
      expect(env.starter.starts.length).toBe(startsBefore + 1);
      const b2 = env.store.getBatch(s2.batchId)!;
      expect(b2.status).toBe("failed");
      expect(b2.retryCount).toBe(1);
      const stages = env.store.getStages(jobId);
      expect(stages.find((s) => s.seq === 1)!.status).toBe("done"); // done stage 不重跑
      expect(stages.find((s) => s.seq === 1)!.artifact).toEqual({ summary: "L0 完成：核心规则 1 条" });
      expect(env.store.getJob(jobId)!.status).toBe("running"); // 重试预算内 job 保持 running
    });
  });

  test("二次调用幂等：零新增 start、resumedJobIds 空（种子集合收口）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await launchRunningJob(env);
      const first = await env.engine.recoverOnStartup();
      expect(first.resumedJobIds).toEqual([jobId]);
      const startsAfterFirst = env.starter.starts.length;
      const second = await env.engine.recoverOnStartup();
      expect(second.resumedJobIds).toEqual([]);
      expect(env.starter.starts.length).toBe(startsAfterFirst);
    });
  });

  test("pending job 一并接管（待编排）；paused 不自动续", async () => {
    await withTaskEnv(async (env) => {
      const pending = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d" },
        createdBy: "page",
      });
      const { jobId: pausedJob } = await launchRunningJob(env, {
        projects: ["p2"],
        params: { projectRoot: "/p2" },
      });
      await env.engine.pause(pausedJob);
      const { resumedJobIds } = await env.engine.recoverOnStartup();
      expect(resumedJobIds).toContain(pending.jobId);
      expect(resumedJobIds).not.toContain(pausedJob);
    });
  });
});

describe("重试超限上浮（CL-2-T5 上浮面，O-3）", () => {
  test("failBatch 第三次后 batch/stage/job 全 failed（error 含批次 scope 与 retryCount）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId, scope } = await launchRunningJob(env);
      // 第 1 次失败：retryScheduled + failed 落库
      const r1 = await env.engine.failBatch(batchId, "closure 失败（一）");
      expect(r1.retryScheduled).toBe(true);
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "failed", retryCount: 1 });
      // 自动重派：failed→running（AF-1.3）+ 新实例落章
      await env.engine.dispatchBatch(batchId, "inst-b");
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "running", instanceId: "inst-b" });
      // 第 2 次失败
      const r2 = await env.engine.failBatch(batchId, "closure 失败（二）");
      expect(r2.retryScheduled).toBe(true);
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "failed", retryCount: 2 });
      await env.engine.dispatchBatch(batchId, "inst-c");
      // 第 3 次失败：超限上浮
      const r3 = await env.engine.failBatch(batchId, "closure 失败（三）");
      expect(r3.retryScheduled).toBe(false);
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "failed", retryCount: 3 });
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("failed");
      const job = env.store.getJob(jobId)!;
      expect(job.status).toBe("failed");
      expect(job.error).toContain(scope);
      expect(job.error).toContain("3");
      // B2 fail-stop：超限上浮同步触发编排停摆（停驱动 + 摘队排队实例）
      expect(env.starter.halts).toContain(jobId);
    });
  });
});

describe("人工重试（task.retry，failed 复活——方案 A 预算归零留痕）", () => {
  test("超限上浮后 retry：stop 先行 + 批次 retryCount 归零留痕 + stage 重开 running + job running 清 error + startOrchestrator 重开", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      // 打满三次失败 → 超限上浮 batch/stage/job failed
      for (const note of ["一", "二", "三"]) {
        await env.engine.failBatch(batchId, `closure 失败（${note}）`);
        if (note !== "三") await env.engine.dispatchBatch(batchId, `inst-${note}`);
      }
      expect(env.store.getJob(jobId)!.status).toBe("failed");
      const callsBefore = env.starter.calls.length;
      await env.engine.retry(jobId);
      // 调用序：stop 先于 start（杀残留 → 重开编排）
      expect(env.starter.calls.slice(callsBefore)).toEqual([`stop:${jobId}`, `start:${jobId}`]);
      // 批次：retryCount 归零 + 留痕（此前失败次数入 note）
      const batch = env.store.getBatch(batchId)!;
      expect(batch.status).toBe("failed");
      expect(batch.retryCount).toBe(0);
      expect(batch.retryNote).toContain("人工重试");
      expect(batch.retryNote).toContain("此前失败 3 次");
      // stage 重开 running；job 复活 running + error 清空
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("running");
      const job = env.store.getJob(jobId)!;
      expect(job.status).toBe("running");
      expect(job.error).toBeNull();
      // 复活后重派通道恢复：failed 批次可 dispatchBatch（failed→running）
      await env.engine.dispatchBatch(batchId, "inst-retry");
      expect(env.store.getBatch(batchId)).toMatchObject({ status: "running", instanceId: "inst-retry" });
    });
  });

  test("残留 running 批次收口 failed 并一并归零；已 done stage 不动", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      // stage1 批次一 done + 产物落库收口 stage1；stage2 两个批次：一个打满上浮、一个残留 running
      await env.engine.completeBatch(batchId);
      await env.engine.writeStageArtifact(jobId, 1, { summary: "阶段一产物" });
      const { batchId: b2 } = await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "批次 2" });
      await env.engine.dispatchBatch(b2, "inst-b2");
      const { batchId: b3 } = await env.engine.insertBatch({ jobId, stageSeq: 2, scope: "批次 3" });
      await env.engine.dispatchBatch(b3, "inst-b3");
      for (const note of ["一", "二", "三"]) {
        await env.engine.failBatch(b2, `失败（${note}）`);
        if (note !== "三") await env.engine.dispatchBatch(b2, `inst-b2-${note}`);
      }
      expect(env.store.getJob(jobId)!.status).toBe("failed");
      expect(env.store.getBatch(b3)!.status).toBe("running"); // 残留 in-flight
      await env.engine.retry(jobId);
      // 残留批次：先 failBatch 收口（retryCount+1）再归零留痕
      const b3After = env.store.getBatch(b3)!;
      expect(b3After.status).toBe("failed");
      expect(b3After.retryCount).toBe(0);
      expect(b3After.retryNote).toContain("人工重试");
      // 已 done stage1 不动；failed stage2 重开 running
      const stages = env.store.getStages(jobId);
      expect(stages.find((s) => s.seq === 1)!.status).toBe("done");
      expect(stages.find((s) => s.seq === 2)!.status).toBe("running");
      expect(env.store.getJob(jobId)!.status).toBe("running");
    });
  });

  test("非 failed 状态 retry → task.invalid_state（running/paused/done/cancelled/pending 全拒）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId, batchId } = await launchRunningJob(env);
      await expect(env.engine.retry(jobId)).rejects.toMatchObject({ code: "task.invalid_state" }); // running
      await env.engine.pause(jobId);
      await expect(env.engine.retry(jobId)).rejects.toMatchObject({ code: "task.invalid_state" }); // paused
      await env.engine.cancel(jobId);
      await expect(env.engine.retry(jobId)).rejects.toMatchObject({ code: "task.invalid_state" }); // cancelled
      const done = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/d2" },
        createdBy: "page",
      });
      await expect(env.engine.retry(done.jobId)).rejects.toMatchObject({ code: "task.invalid_state" }); // pending
      await expect(env.engine.retry("task-nonexistent")).rejects.toMatchObject({ code: "task.not_found" });
      // batchId 占位防未用告警
      expect(batchId).toBeTruthy();
    });
  });
});
