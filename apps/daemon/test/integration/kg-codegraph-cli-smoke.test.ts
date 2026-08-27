import { afterAll, describe, expect, test } from "bun:test";
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodegraphEngineAdapter } from "../../src/adapters/driven/codegraph-engine/CodegraphEngineAdapter";

/**
 * T2.1 真 codegraph CLI 集成冒烟（test-design §五-2，环境依赖测试）：
 * 真 codegraph 二进制 init 全量首建 tmp 项目 → exportSymbols 投影非空。
 * 二进制缺失 → **显式 skip 并注明**（禁止静默通过）；三级候选：
 * env HELIX_CODEGRAPH_PATH → PATH → 本 workspace codegraph 源码仓构建产物。
 */

const disposers: Array<() => void> = [];

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function locateRealCli(): string | null {
  const candidates = [
    process.env.HELIX_CODEGRAPH_PATH,
    ...(process.env.PATH ?? "").split(":").map((dir) => (dir === "" ? undefined : path.join(dir, "codegraph"))),
    // workspace 源码仓构建产物（dev 机 smoke 候选；worktree → .worktrees → workspace 根）
    path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..", "codegraph", "dist", "bin", "codegraph.js"),
  ].filter((p): p is string => p !== undefined && p !== "");
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

const CLI = locateRealCli();

describe("真 CLI 冒烟：被动构建 + 只读投影（环境依赖，§五-2）", () => {
  if (CLI === null) {
    test.skip("codegraph 二进制不可用——环境依赖冒烟显式跳过（R-1：CI/无二进制环境被动模式验证不完整，test-design §五-2）", () => {});
    return;
  }

  test("init 全量首建 → exportSymbols 非空（symbols/contains/files 三面齐）；二调走 sync 增量", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "helix-cg-smoke-"));
    disposers.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(
      path.join(root, "app.ts"),
      [
        "export class Greeter {",
        "  private name: string;",
        "  constructor(name: string) { this.name = name; }",
        "  greet(): string { return `hello ${this.name}`; }",
        "}",
        "export function makeGreeter(n: string): Greeter { return new Greeter(n); }",
        "",
      ].join("\n"),
    );
    const adapter = new CodegraphEngineAdapter({ binaryPath: CLI });

    // 冷启动：status 未初始化 → init 全量首建
    const first = await adapter.ensureIndex(root);
    expect(first.initialized).toBe(true);
    expect(first.mode).toBe("init");

    // 只读投影：三面非空且 contains 上含 类→方法 边
    const set = await adapter.exportSymbols(root);
    expect(set.symbols.length).toBeGreaterThan(0);
    expect(set.files.some((f) => f.path === "app.ts")).toBe(true);
    expect(set.files.every((f) => f.contentHash !== "")).toBe(true);
    const method = set.symbols.find((s) => s.kind === "method" && s.name === "greet");
    expect(method).toBeDefined();
    const cls = set.symbols.find((s) => s.kind === "class" && s.name === "Greeter");
    expect(cls).toBeDefined();
    expect(set.containsEdges.some((e) => e.containerId === cls!.id && e.symbolId === method!.id)).toBe(true);

    // 二调：已初始化且新鲜 → sync 增量
    const second = await adapter.ensureIndex(root);
    expect(second.mode).toBe("sync");
  }, 180_000);
});

afterAll(() => {
  for (const dispose of disposers) dispose();
});