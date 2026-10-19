/**
 * createTask 阶段计划残缺孤儿回归（评审 F1）。
 *
 * 缺陷形态：createTask ④ 先 insertJob（job 行 pending 已落库），再逐行 insertStage
 * 落阶段计划（TR-72「创建时一次定格」）。stage 插入中途抛错（磁盘/锁/约束）时原实现
 * 直接上抛——job 行留在 pending 且阶段计划残缺：既不是「完整定格」（TR-72），也不是
 * 终态（只能靠重启恢复扫描捞，sweep 语义按完整计划推演，残缺行会错判阶段完成度）。
 *
 * 现行语义：④ 的 stage 插入段与 ⑤ 的编排启动段共用同一回补——非终态 stage 标 failed、
 * job pending→cancelled（合法迁移），再上抛原错；残留行是「终态可见」而非滞留在飞面。
 */
import { describe, expect, test } from "bun:test";
import { withTaskEnv } from "../helpers/task-fixtures";

describe("createTask 回补（评审 F1）：stage 插入中途失败不留残缺孤儿任务", () => {
  test("第二条 stage 插入抛错 → job 收口 cancelled + 已落 stage 全失败 + 上抛原错", async () => {
    await withTaskEnv(async (env) => {
      const realInsertStage = env.store.insertStage.bind(env.store);
      let calls = 0;
      // 注入：第三条 stage 落盘时抛错（前两条已成功落行 = 残缺计划现场）
      (env.store as unknown as { insertStage: typeof realInsertStage }).insertStage = async (row) => {
        calls += 1;
        if (calls === 3) throw new Error("stage 行写失败（注入）");
        return realInsertStage(row);
      };

      const before = env.store.listJobs().length;
      await expect(
        env.engine.createTask({
          type: "kg-bootstrap",
          projects: ["demo"],
          params: { projectRoot: "/tmp/demo", scope: "core" },
          createdBy: "page",
        }),
      ).rejects.toThrow("stage 行写失败（注入）");

      // job 行不滞留 pending（在飞面零孤儿：重启恢复/sweep 不再扫到残计划）
      expect(env.store.listJobs()).toHaveLength(before + 1);
      const job = env.store.listJobs()[env.store.listJobs().length - 1]!;
      expect(job.status).toBe("cancelled");
      expect(job.error).toContain("stage 行写失败（注入）");
      // 已落 stage 全部终态化（无 pending 残留）
      const stages = env.store.getStages(job.id);
      expect(stages.length).toBeGreaterThan(0);
      expect(stages.every((s) => s.status === "failed")).toBe(true);
      // 编排未启动（回补路径不驱动 starter）
      expect(env.starter.starts).not.toContain(job.id);
    });
  });
});
