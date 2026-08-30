import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CodegraphEngineAdapter,
  EngineUnavailableError,
  CODEGRAPH_QUERY_MAX_OUTPUT_CHARS,
} from "../../src/adapters/driven/codegraph-engine/CodegraphEngineAdapter";

/**
 * W1-B（R5/R6，I 层）：CodegraphEngineAdapter.runQuery 只读查询面——
 * 六 op → 一次性 CLI 子命令映射（被动模式同 ensureIndex：即起即退，
 * 零 serve/daemon/watch）；输出截断保护；degraded 统一 EngineUnavailable。
 *
 * fake CLI（node 脚本）记录**完整 argv** 到 calls.log，按标记文件驱动
 * 行为（fail-<sub> 非零退出 / big-<sub> 超 cap 输出），与
 * kg-codegraph-engine.test.ts 同模式。
 */

const disposers: Array<() => void> = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

/** fake CLI：逐行记录完整 argv（空格连接）；echo-<sub> 时回显固定 JSON；big 标记输出超 cap 文本。 */
function makeFakeCli(dir: string): string {
  const script = path.join(dir, "codegraph");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const dir = __dirname;',
      'const args = process.argv.slice(2);',
      'const sub = args[0] || "";',
      'const has = (m) => fs.existsSync(path.join(dir, m));',
      'fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\\n");',
      'if (has("fail-" + sub)) { console.error("boom-" + sub); process.exit(1); }',
      'if (has("big-" + sub)) { console.log("x".repeat(200000)); process.exit(0); }',
      'console.log(JSON.stringify({ echo: sub }));',
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return script;
}

function callsOf(dir: string): string[] {
  const log = path.join(dir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n");
}

describe("runQuery：六 op → CLI 子命令映射（只读面，零 init/index/sync）", () => {
  test("status → status -j <root>", async () => {
    const dir = tmpDir("codegraph-query-");
    const cli = makeFakeCli(dir);
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    const out = await adapter.runQuery("/proj", { op: "status" });
    expect(callsOf(dir)).toEqual(["status -j /proj"]);
    expect(out).toContain('"echo":"status"');
  });

  test("search → query <pattern> -j -p <root>（kind/limit 透传）", async () => {
    const dir = tmpDir("codegraph-query-");
    const cli = makeFakeCli(dir);
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    await adapter.runQuery("/proj", { op: "search", pattern: "Foo", kind: "class", limit: 5 });
    expect(callsOf(dir)).toEqual(["query Foo -j -p /proj -k class -l 5"]);
  });

  test("node → symbol 模式 / file 模式（-f + offset/limit/symbols-only）", async () => {
    const dir = tmpDir("codegraph-query-");
    const cli = makeFakeCli(dir);
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    await adapter.runQuery("/proj", { op: "node", symbol: "Bar" });
    await adapter.runQuery("/proj", { op: "node", file: "src/a.ts", offset: 10, limit: 50, symbolsOnly: true });
    expect(callsOf(dir)).toEqual([
      "node Bar -p /proj",
      "node -f src/a.ts -p /proj --offset 10 --limit 50 --symbols-only",
    ]);
  });

  test("callers/callees/impact → <op> <symbol> -j -p <root>（limit/depth 透传）", async () => {
    const dir = tmpDir("codegraph-query-");
    const cli = makeFakeCli(dir);
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    await adapter.runQuery("/proj", { op: "callers", symbol: "f", limit: 30 });
    await adapter.runQuery("/proj", { op: "callees", symbol: "f" });
    await adapter.runQuery("/proj", { op: "impact", symbol: "f", depth: 3 });
    expect(callsOf(dir)).toEqual([
      "callers f -j -p /proj -l 30",
      "callees f -j -p /proj",
      "impact f -j -p /proj -d 3",
    ]);
  });
});

describe("runQuery：截断与降级", () => {
  test("输出超 cap → 截断 + 截断标记", async () => {
    const dir = tmpDir("codegraph-query-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "big-status"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    const out = await adapter.runQuery("/proj", { op: "status" });
    expect(out.length).toBeLessThan(200000);
    expect(out.length).toBeGreaterThan(CODEGRAPH_QUERY_MAX_OUTPUT_CHARS);
    expect(out).toContain("输出已截断");
  });

  test("二进制不可达 → EngineUnavailable（degraded 第一入口）", async () => {
    const adapter = new CodegraphEngineAdapter({ binaryPath: null });
    await expect(adapter.runQuery("/proj", { op: "status" })).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  test("CLI 非零退出 → EngineUnavailable（含 stderr 片段）", async () => {
    const dir = tmpDir("codegraph-query-");
    const cli = makeFakeCli(dir);
    writeFileSync(path.join(dir, "fail-callers"), "1");
    const adapter = new CodegraphEngineAdapter({ binaryPath: cli });
    await expect(adapter.runQuery("/proj", { op: "callers", symbol: "f" })).rejects.toBeInstanceOf(
      EngineUnavailableError,
    );
  });
});
