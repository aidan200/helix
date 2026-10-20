import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";

/**
 * WriteQueue 零值路线（低危批）：关闭窗/单 job 写失败时，有字段返回面的 job
 * （taskJobCascade → TaskDeleteCounts）必须拿到**形状完整的零值对象**——旧实现
 * 一律返回 undefined，TaskEngineService.deleteTask 解构读字段即 TypeError。
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "helix-wq-zero-"));
  dirs.push(dir);
  return join(dir, "helix.db");
}

describe("WriteQueue 零值路线（taskJobCascade）", () => {
  test("① 关闭窗迟到写 → TaskDeleteCounts 全零对象（非 undefined，解构不炸）", async () => {
    const wq = new WriteQueue(tmpDb());
    await wq.close();
    const counts = await wq.deleteTaskJobCascade("job-1", "session-1");
    expect(counts).toEqual({
      jobs: 0,
      stages: 0,
      batches: 0,
      events: 0,
      lifecycleRows: 0,
      closures: 0,
      steerRows: 0,
      toolCallRows: 0,
      pendingSyncs: 0,
    });
    const { jobs, stages, batches } = counts; // 旧实现此处 TypeError
    expect([jobs, stages, batches]).toEqual([0, 0, 0]);
  });

  test("② 正常路径仍返回真实计数（零值路线不越位改写成功路径）", async () => {
    const wq = new WriteQueue(tmpDb());
    await wq.saveTaskJob({
      id: "job-2",
      type: "kg-bootstrap",
      params: {},
      projects: [],
      status: "done",
      createdBy: "page",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      error: null,
    });
    const counts = await wq.deleteTaskJobCascade("job-2", "session-2");
    expect(counts.jobs).toBe(1);
    await wq.close();
  });
});
