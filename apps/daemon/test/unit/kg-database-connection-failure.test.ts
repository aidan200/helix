import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";

/**
 * KgDatabase 连接获取失败路径（低危批）：
 *
 * `connectionOf` 里 new 出的连接在建库/schema 演进中途抛错时，既不入 channels
 * 缓存也无外部持有者——旧实现只 new 不 close，句柄泄漏。修复后该路径就地
 * close 再上抛；对调用方可观测的契约是「失败向上抛且不缓存坏连接」。
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function projectWithBrokenSchema(): string {
  const root = mkdtempSync(join(tmpdir(), "helix-kgdb-broken-"));
  dirs.push(root);
  mkdirSync(join(root, ".helix-kg"), { recursive: true });
  // nodes 建成视图：hasColumn 判缺列 → ALTER TABLE nodes ADD COLUMN 必抛
  // （视图不可加列），即「建库/演进中途失败」路径。
  const db = new Database(kgDbPath(root));
  db.exec("CREATE VIEW nodes AS SELECT 1 AS id");
  db.close();
  return root;
}

describe("KgDatabase.connectionOf 失败路径", () => {
  test("① schema 演进抛错 → 错误上抛（不吞、不返回半成品连接）", () => {
    const root = projectWithBrokenSchema();
    const kg = new KgDatabase();
    expect(() => kg.knowledgeConnection(root)).toThrow();
    // 失败路径无残留：closeAll 不应因半开连接/空缓存抛错
    expect(() => kg.closeAll()).not.toThrow();
  });

  test("② 失败不污染缓存：再次取连接仍走完整建库流程并同样失败（不是读回坏连接）", () => {
    const root = projectWithBrokenSchema();
    const kg = new KgDatabase();
    expect(() => kg.knowledgeConnection(root)).toThrow();
    expect(() => kg.knowledgeConnection(root)).toThrow();
  });
});
