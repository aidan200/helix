import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgAttachmentService } from "../../src/application/services/kg/KgAttachmentService";
import { buildKnowledgeStack, buildEditToolDeps } from "../../src/infrastructure/assembly/buildKnowledgeStack";
import { createEditTool } from "../../src/adapters/driven/tools/edit/EditTool";
import type { CodegraphResolution } from "../../src/adapters/driven/codegraph-engine/resolve-codegraph";
import type { AnchorDeclaration, SymbolBatch } from "../../src/domain/kg/types";

/**
 * I 层：D8 W-R2/W-R3 worktree 读穿透（tmp 目录造 .worktrees 结构 + 主仓
 * kg.db 存根，断言 worktree 内查询命中主仓数据）。
 *
 * - kg 读穿透（W-R3）：buildKnowledgeStack 以 worktree 路径为 workspaceRoot
 *   装配 → queryService.search/get 只读直读主仓 .helix-kg/kg.db；主仓无库
 *   → 空集（读面绝不新建库文件）。普通 workspaceRoot 行为不变（回归）。
 * - 附着穿透（W-R3 顺路）：worktree 内 edit（buildEditToolDeps 组合根同款
 *   接线）→ 📎 块命中主仓锚（projectRoot + filePath 双归一——锚表项目相对
 *   路径语义）。非 worktree 域外编辑行为不变（回归）。
 */

interface Fixture {
  readonly root: string; // workspace 根
  readonly proj: string; // 主仓 projectRoot（.helix-kg 持有者）
  readonly worktree: string; // <root>/.worktrees/{proj}-d8-x（W-R1 落点形态）
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly write: KgWriteService;
  readonly attachment: KgAttachmentService;
}

const fixtures: Fixture[] = [];

afterAll(() => {
  for (const f of fixtures) {
    f.database.closeAll();
    rmSync(f.root, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "worktree-it-"));
  const proj = path.join(root, "helix");
  const worktree = path.join(root, ".worktrees", "helix-d8-x");
  mkdirSync(path.join(proj, "src"), { recursive: true });
  mkdirSync(path.join(worktree, "src"), { recursive: true }); // worktree 同构检出（项目相对路径一致）
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const attachment = new KgAttachmentService({ graph, hasIndex: () => true });
  const f: Fixture = { root, proj, worktree, database, store, write, attachment };
  fixtures.push(f);
  return f;
}

const UNAVAILABLE: CodegraphResolution = { kind: "unavailable", reasons: ["测试形态：二进制不可达"] };

function mustId(r: ReturnType<KgWriteService["write"]>): string {
  if (!r.ok) throw new Error(`种子写失败：${r.error.code} ${r.error.message}`);
  return r.nodeId;
}

describe("W-R3 kg 读穿透：worktree workspaceRoot → 只读直读主仓 kg.db", () => {
  test("① worktree 基座装配：search/get 命中主仓节点（主仓 kg.db 真通道种子）", async () => {
    const f = makeFixture();
    const tr1 = mustId(f.write.write(f.proj, { kind: "createNode", iterationId: "it-d8", draft: { kind: "rule", name: "handler 幂等规则", digest: "handler 编辑必须保持幂等语义", scene: "worktree 读穿透测试" } }));
    // 以 worktree 路径为 workspaceRoot 装配整栈（组合根同款）
    const stack = buildKnowledgeStack({ codegraphResolution: UNAVAILABLE, workspaceRoot: f.worktree });
    try {
      const hits = stack.queryService.search("handler");
      expect(hits.length).toBe(1);
      expect(hits[0]!.project).toBe(f.proj); // project 伴随 = 主仓 projectRoot
      expect(hits[0]!.row.name).toBe("handler 幂等规则");
      const got = stack.queryService.get(tr1);
      expect(got?.project).toBe(f.proj);
      expect(got?.detail.node.id).toBe(tr1);
    } finally {
      stack.dispose();
    }
  });

  test("② worktree 内零建库：主仓无 kg.db → search 空集且不产生任何库文件", () => {
    const f = makeFixture(); // 本 fixture 未写主仓——无 kg.db
    const stack = buildKnowledgeStack({ codegraphResolution: UNAVAILABLE, workspaceRoot: f.worktree });
    try {
      expect(stack.queryService.search("handler")).toEqual([]);
      expect(stack.queryService.get("TR-1")).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  test("③ 回归：普通 workspaceRoot（非 worktree）行为不变——主仓照常入列", () => {
    const f = makeFixture();
    mustId(f.write.write(f.proj, { kind: "createNode", iterationId: "it-d8", draft: { kind: "rule", name: "普通工作区规则", digest: "非 worktree 场景零影响", scene: "回归测试" } }));
    const stack = buildKnowledgeStack({ codegraphResolution: UNAVAILABLE, workspaceRoot: f.root });
    try {
      const hits = stack.queryService.search("普通工作区");
      expect(hits.length).toBe(1);
      expect(hits[0]!.project).toBe(f.proj);
    } finally {
      stack.dispose();
    }
  });
});

describe("W-R3 附着穿透：worktree 内 edit → 命中主仓锚（projectRoot+filePath 双归一）", () => {
  /** 主仓 kg.db 落 src/feat.ts#handler 物化锚。 */
  function seedAnchor(f: Fixture): string {
    const nodeId = mustId(
      f.write.write(f.proj, {
        kind: "createNode",
        iterationId: "it-d8",
        draft: { kind: "rule", name: "handler 幂等规则", digest: "handler 编辑必须保持幂等语义", scene: "附着穿透测试" },
      }),
    );
    const decl = f.write.write(f.proj, { kind: "declareAnchors", iterationId: "it-d8", nodeId, anchors: [{ scopeKind: "symbol", pattern: "src/feat.ts#handler" } as AnchorDeclaration] });
    if (!decl.ok) throw new Error(`锚声明失败：${decl.error.message}`);
    return nodeId;
  }

  async function applySyncAnchor(f: Fixture, nodeId: string): Promise<void> {
    await f.store.applySync(f.proj, {
      files: [{ path: "src/feat.ts", mtime: 1, sha256: "h1" }],
      symbols: [{ name: "handler", kind: "function", spanStart: 2, spanEnd: 4, file: "src/feat.ts" }],
      containsEdges: [],
      materializedAnchors: [{ nodeId, anchorPath: "src/feat.ts", anchorSymbol: "handler", anchorKind: "symbol" }],
      baseline: "1",
      degraded: false,
    } satisfies SymbolBatch);
  }

  type RunResult = { ok: true; text: string } | { ok: false; error: string };

  async function run(
    tool: AgentHarnessTool<ExecutionToolContext, any, any>,
    args: unknown,
    env: NodeExecutionEnv,
  ): Promise<RunResult> {
    try {
      const result = await tool.execute("tc-1", args as never, undefined, undefined, { env });
      return { ok: true, text: (result.content as any[]).map((b) => (b.type === "text" ? b.text : `(${b.type})`)).join("\n") };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  test("④ worktree 内编辑 src/feat.ts → 📎 块命中主仓锚（digest+指针）", async () => {
    const f = makeFixture();
    const nodeId = seedAnchor(f);
    await applySyncAnchor(f, nodeId);
    // worktree 内同名文件（worktree 是主仓同构检出——项目相对路径一致）
    const featWt = path.join(f.worktree, "src", "feat.ts");
    writeFileSync(featWt, "// header\nexport function handler() {\n  const cache = handlerCache();\n  return cache;\n}\n// tail\n");
    const env = new NodeExecutionEnv({ cwd: f.root });
    const tool = createEditTool(buildEditToolDeps({ workspaceRoot: f.root, attachment: f.attachment, sessionId: "sess-wt" }));
    const r = await run(tool, { path: ".worktrees/helix-d8-x/src/feat.ts", edits: [{ oldText: "const cache = handlerCache();", newText: "const cache = handlerCache() ?? null;" }] }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.text.slice(r.text.indexOf("📎"));
    expect(block).toContain("handler 幂等规则"); // 主仓节点 name
    expect(block).toContain(`kg get ${nodeId}`); // 指针指向主仓节点
  });

  test("⑤ 回归：非 worktree 项目内编辑行为不变（同锚主仓直编路径）", async () => {
    const f = makeFixture();
    const nodeId = seedAnchor(f);
    await applySyncAnchor(f, nodeId);
    const feat = path.join(f.proj, "src", "feat.ts");
    writeFileSync(feat, "// header\nexport function handler() {\n  const cache = handlerCache();\n  return cache;\n}\n// tail\n");
    const env = new NodeExecutionEnv({ cwd: f.root });
    const tool = createEditTool(buildEditToolDeps({ workspaceRoot: f.root, attachment: f.attachment, sessionId: "sess-main" }));
    const r = await run(tool, { path: "helix/src/feat.ts", edits: [{ oldText: "const cache = handlerCache();", newText: "const cache = handlerCache() ?? null;" }] }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.text.slice(r.text.indexOf("📎"));
    expect(block).toContain(`kg get ${nodeId}`);
  });
});
