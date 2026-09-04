import { Database } from "bun:sqlite";
import type { EngineContainsEdge, EngineFileRecord, EngineSymbol, SymbolSet } from "../../../domain/kg/types";

/**
 * codegraph.db 只读投影（T2.1/AF-2 裁决）：exportSymbols 的 db 直读面。
 *
 * 只读边界（AF-2 机械细则，AG-06 只读读点登记）：
 * - 连接固定只读打开；首选 plain path + `{ readonly: true, create: false }`
 *   旗标组合（不走 `file:` URI——bun:sqlite 1.3.14 的 URI 打开在 linux
 *   必败（"unable to open database file"，arm64/x64 同现），mac 正常，
 *   plain path 双平台实测含 WAL 干净退出态与 live-WAL 均可读）；
 *   回退 `file:<db>?mode=ro&immutable=1` URI（immutable 快照绕过
 *   wal-index，mac 可用——防极端态：库目录只读、-shm 无法创建时 plain
 *   ro 也 CANTOPEN）；
 * - 本文件零 DML/DDL/写类 PRAGMA——只 SELECT；绝不写/迁移他人库；
 * - schema 版本兼容门：`SELECT MAX(version) FROM schema_versions` 高于
 *   已测上限或缺表 → EngineUnavailable（degraded），绝不降级解读。
 *
 * 投影面（表→列→SymbolSet 映射，AF-2 机械细则）：
 * - symbols+span ← nodes（id/kind/name/qualified_name/file_path/
 *   language/signature/start_line/end_line/start_column/end_column）；
 * - contains ← edges WHERE kind='contains'（source=容器 id、target=成员
 *   符号 id）；calls/imports 等其余边类型不导（AD-8 导入范围刻意最小）；
 * - 文件面/基准 ← files（path/content_hash/modified_at/indexed_at）。
 */
/**
 * schema 版本门已测上限：真实 CLI 实测证据——helix 旧库 v8；当前
 * codegraph 1.5.0（workspace 源码构建）全量首建产出 v9，v9 迁移仅加
 * files.generated 列（对投影零影响）；真 CLI 冒烟（kg-codegraph-cli-smoke）
 * 即 v9 库上的投影验证。高于此值或缺表 → degraded。
 */
export const CODEGRAPH_SCHEMA_MAX_VERSION = 9;

/** codegraph 索引目录定位（kg.index.delete 删除目标，C1）。 */
export function codegraphDirPath(projectRoot: string): string {
  return `${projectRoot}/.codegraph`;
}

/** codegraph 库定位（导出供测试/冒烟；运行时经 CodegraphEngineAdapter 访问）。 */
export function codegraphDbPath(projectRoot: string): string {
  return `${codegraphDirPath(projectRoot)}/codegraph.db`;
}

/** 只读打开：plain path readonly 优先（bun:sqlite URI 打开 linux 必败，见头注；双平台 WAL 两态实测可读）；打开惰性，用探活查询逼出真实打开失败后回退 immutable URI 只读快照。 */
export function openCodegraphReadonly(dbPath: string): Database {
  try {
    const db = new Database(dbPath, { readonly: true, create: false });
    db.query("SELECT count(*) FROM sqlite_schema LIMIT 1").get(); // 探活：CANTOPEN 在首个查询才抛（惰性打开）
    return db;
  } catch {
    // 极端态回退（库目录只读/-shm 不可建）：immutable URI 同为只读旗标组合，
    // 绕过 wal-index 直读主库文件（AF-2「或等价 readonly 连接选项」句）。
    // 注意 bun:sqlite URI 打开在 linux 必败——本回退仅在 mac 有实际意义，
    // linux 下 plain 失败即整体 degraded（绝不写/迁移语义不变）。
    return new Database(`file:${dbPath}?mode=ro&immutable=1`, { readonly: true, create: false });
  }
}

/** schema 版本门：版本表缺失/读失败/高于已测上限 → null（调用方判 degraded）。 */
function schemaMaxVersion(db: Database): number | null {
  try {
    const row = db.query("SELECT MAX(version) AS v FROM schema_versions").get() as { v: number | null } | null;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

/**
 * 三面投影。任何 SELECT 失败（缺表等 schema 形态异常）→ 抛出原始错误由
 * 调用方统一映射 EngineUnavailable；连接总是关闭（快照式，用毕即弃）。
 */
export function projectCodegraphSymbols(dbPath: string): SymbolSet {
  const db = openCodegraphReadonly(dbPath);
  try {
    const version = schemaMaxVersion(db);
    if (version === null) {
      throw new Error("codegraph schema_versions 缺失或不可读");
    }
    if (version > CODEGRAPH_SCHEMA_MAX_VERSION) {
      throw new Error(`codegraph schema 版本 ${version} 高于已测上限 ${CODEGRAPH_SCHEMA_MAX_VERSION}`);
    }

    const symbols = (
      db
        .query(
          "SELECT id, kind, name, qualified_name, file_path, language, signature, start_line, end_line, start_column, end_column FROM nodes",
        )
        .all() as Record<string, unknown>[]
    ).map(toEngineSymbol);

    const containsEdges = (
      db.query("SELECT source, target FROM edges WHERE kind = 'contains'").all() as Record<string, unknown>[]
    ).map((row) => ({ containerId: String(row.source), symbolId: String(row.target) })) as EngineContainsEdge[];

    const files = (
      db.query("SELECT path, content_hash, modified_at, indexed_at FROM files").all() as Record<string, unknown>[]
    ).map(
      (row) =>
        ({
          path: String(row.path),
          contentHash: String(row.content_hash ?? ""),
          modifiedAt: Number(row.modified_at),
          indexedAt: Number(row.indexed_at),
        }) satisfies EngineFileRecord,
    );

    return { symbols, containsEdges, files };
  } finally {
    db.close();
  }
}

/** nodes 行 → EngineSymbol（NOT NULL 列防御性兜底 null：绝不因引擎形态漂移崩溃）。 */
function toEngineSymbol(row: Record<string, unknown>): EngineSymbol {
  return {
    id: String(row.id),
    kind: String(row.kind),
    name: String(row.name),
    qualifiedName: String(row.qualified_name ?? ""),
    filePath: String(row.file_path ?? ""),
    language: row.language === undefined || row.language === null ? null : String(row.language),
    signature: row.signature === undefined || row.signature === null ? null : String(row.signature),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    startColumn: Number(row.start_column),
    endColumn: Number(row.end_column),
  };
}
