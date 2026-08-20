import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPaths } from "../../src/infrastructure/paths";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { ResourceStateStore } from "../../src/adapters/driven/sqlite-session/ResourceStateStore";

/**
 * M6 T1 资源数据域（resource_state 表，defaultModel 先例同构）：
 * - 全局表（非会话维）：写经 WriteQueue 单写通道（AG-06）全局链，读面共用
 *   writeQueue.database 连接；
 * - 幂等建表：CREATE IF NOT EXISTS 守护（新库直建、旧库重开补建）；
 * - upsert/list/get 按 (profile_kind, resource_type, name) 主键读写；
 *   缺省无记录 = 启用的语义在 service 层（store 只存差异行）；
 * - model 槽位单行不变式：setModelSlot 原子替换（旧行清、新行 enabled 恒 1）、
 *   clearModelSlot 删行 = 未设。
 */

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-resource-state-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("ResourceStateStore（resource_state 表，WriteQueue 单写通道）", () => {
  test("① upsert/get/list 读写正确：同 kind 多资源、跨 kind 隔离、同主键 upsert 更新、type 过滤", async () => {
    const home = tmpHome();
    const dbPath = createPaths(home).dbPath();
    const queue = new WriteQueue(dbPath);
    const store = new ResourceStateStore(queue);
    try {
      // 缺省无记录（启用语义由 service 层解释，store 只存差异行）
      expect(store.list("main-session")).toEqual([]);
      expect(store.get("main-session", "tool", "grep")).toBeUndefined();

      // 同 kind 多资源
      await store.upsert("main-session", "tool", "grep", false);
      await store.upsert("main-session", "tool", "bash", false);
      await store.upsert("main-session", "skill", "deploy-helper", false);
      expect(store.get("main-session", "tool", "grep")).toMatchObject({
        profileKind: "main-session",
        resourceType: "tool",
        name: "grep",
        enabled: false,
      });
      expect(store.list("main-session").map((r) => r.name).sort()).toEqual(["bash", "deploy-helper", "grep"]);

      // 跨 kind 隔离：subagent 的行不混入 main-session 读面
      await store.upsert("subagent-worker", "tool", "grep", true);
      expect(store.list("main-session").length).toBe(3);
      expect(store.list("subagent-worker").map((r) => r.name)).toEqual(["grep"]);
      expect(store.get("subagent-worker", "tool", "grep")?.enabled).toBe(true);

      // 同主键重复 upsert = 更新（不追加行）
      await store.upsert("main-session", "tool", "grep", true);
      expect(store.list("main-session").length).toBe(3);
      expect(store.get("main-session", "tool", "grep")?.enabled).toBe(true);

      // resource_type 过滤
      expect(store.list("main-session", "tool").map((r) => r.name).sort()).toEqual(["bash", "grep"]);
      expect(store.list("main-session", "skill").map((r) => r.name)).toEqual(["deploy-helper"]);
    } finally {
      await queue.close();
    }
  });

  test("② 幂等建表 + 落盘可跨实例观测（重开队列读同值）", async () => {
    const home = tmpHome();
    const dbPath = createPaths(home).dbPath();
    const q1 = new WriteQueue(dbPath);
    const s1 = new ResourceStateStore(q1);
    await s1.upsert("main-session", "tool", "read", false);
    await s1.setModelSlot("main-session", "anthropic/claude-sonnet-4-5");
    await q1.close();

    // 同一 db 重开（模拟 daemon 重启）：SCHEMA_SQL IF NOT EXISTS 幂等，值完整读回
    const q2 = new WriteQueue(dbPath);
    const s2 = new ResourceStateStore(q2);
    try {
      expect(s2.get("main-session", "tool", "read")?.enabled).toBe(false);
      expect(s2.modelSlot("main-session")).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      await q2.close();
    }
  });

  test("③ model 槽位：未设 → undefined；set 读回；覆盖替换（旧行清除、单行不变式）；clear → 未设；kind 隔离", async () => {
    const home = tmpHome();
    const dbPath = createPaths(home).dbPath();
    const queue = new WriteQueue(dbPath);
    const store = new ResourceStateStore(queue);
    try {
      expect(store.modelSlot("main-session")).toBeUndefined();

      await store.setModelSlot("main-session", "anthropic/claude-sonnet-4-5");
      expect(store.modelSlot("main-session")).toBe("anthropic/claude-sonnet-4-5");
      // model 型行 enabled 恒 1（设计裁决：model 槽位不承载启停语义）
      expect(store.list("main-session", "model")).toEqual([
        {
          profileKind: "main-session",
          resourceType: "model",
          name: "anthropic/claude-sonnet-4-5",
          enabled: true,
          updatedAt: expect.any(String) as unknown as string,
        },
      ]);

      // 覆盖：替换语义（不同 name 的旧行必须清除——主键含 name，遗留即双行）
      await store.setModelSlot("main-session", "openai/gpt-5.2");
      expect(store.modelSlot("main-session")).toBe("openai/gpt-5.2");
      expect(store.list("main-session", "model").length).toBe(1);

      // clear：删除行 = 未设
      await store.clearModelSlot("main-session");
      expect(store.modelSlot("main-session")).toBeUndefined();
      expect(store.list("main-session", "model")).toEqual([]);

      // kind 隔离
      await store.setModelSlot("subagent-worker", "moonshotai/kimi-k2");
      expect(store.modelSlot("main-session")).toBeUndefined();
      expect(store.modelSlot("subagent-worker")).toBe("moonshotai/kimi-k2");
    } finally {
      await queue.close();
    }
  });
});
