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
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import { buildEditToolDeps } from "../../src/infrastructure/assembly/buildKnowledgeStack";
import { createEditTool } from "../../src/adapters/driven/tools/edit/EditTool";
import { ATTACHMENT_PROTOCOL_LINE } from "../../src/domain/kg/attachment/render";
import type { AnchorDeclaration, MaterializedAnchor, SymbolBatch } from "../../src/domain/kg/types";

/**
 * I 层：edit 附着接线（T3.2，CL-1 F1.1/F1.2，AD-4/AD-7 补充/AD-13/AD-15）。
 *
 * 真 .kg tmp 库 + 物化锚 fixture（createNode + applySync 真通道落锚表），
 * EditTool 成功返回路径 × buildEditToolDeps（组合根同款接线）×
 * KgAttachmentService（快照点查 + 四层递降 + 去重预算 + 渲染）。
 *
 * 覆盖：①符号域锚命中（CL-1.A1）②未命中沉默（A2）③快照滞后保守降级
 * ④预算超限特异性裁剪 ⑤管线故障静默（A11）⑥跨通道会话去重（A3）+
 * baseline 戳缓存失效。
 */

interface Workspace {
  readonly root: string; // workspace 根（env cwd / projectRootOf 解析根）
  readonly proj: string; // projectRoot（.kg 持有者）
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
  readonly attachment: KgAttachmentService;
  readonly env: NodeExecutionEnv;
  readonly notified: Array<{ projectRoot: string; path: string; hash: string }>;
  readonly toolFor: (sessionId: string) => AgentHarnessTool<ExecutionToolContext, any, any>;
}

const workspaces: Workspace[] = [];

afterAll(() => {
  for (const w of workspaces) {
    w.database.closeAll();
    rmSync(w.root, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

function makeWorkspace(): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), "kg-attach-it-"));
  const proj = path.join(root, "proj");
  mkdirSync(path.join(proj, "src"), { recursive: true });
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const attachment = new KgAttachmentService({ graph });
  const env = new NodeExecutionEnv({ cwd: root });
  const notified: Workspace["notified"] = [];
  const fakeSync = { notifyWrite: (projectRoot: string, p: string, hash: string) => notified.push({ projectRoot, path: p, hash }) };
  const toolFor = (sessionId: string) =>
    createEditTool(buildEditToolDeps({ workspaceRoot: root, syncService: fakeSync, attachment, sessionId }));
  const ws: Workspace = { root, proj, database, store, graph, write, attachment, env, notified, toolFor };
  workspaces.push(ws);
  return ws;
}

type RunResult = { ok: true; text: string } | { ok: false; error: string };

async function run(tool: AgentHarnessTool<ExecutionToolContext, any, any>, args: unknown, env: NodeExecutionEnv): Promise<RunResult> {
  try {
    const result = await tool.execute("tc-1", args as never, undefined, undefined, { env });
    return { ok: true, text: (result.content as any[]).map((b) => (b.type === "text" ? b.text : `(${b.type})`)).join("\n") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 建节点（返回自动发号 id）。 */
function makeNode(ws: Workspace, name: string, digest: string): string {
  const r = ws.write.write(ws.proj, { kind: "createNode", iterationId: "iter-t32", draft: { kind: "rule", name, digest } });
  if (!r.ok) throw new Error(`建节点失败：${r.error.code} ${r.error.message}`);
  return r.nodeId;
}

function declare(ws: Workspace, nodeId: string, anchors: readonly AnchorDeclaration[]): void {
  const r = ws.write.write(ws.proj, { kind: "declareAnchors", iterationId: "iter-t32", nodeId, anchors });
  if (!r.ok) throw new Error(`锚声明失败：${r.error.code} ${r.error.message}`);
}

async function syncBatch(ws: Workspace, batch: SymbolBatch): Promise<void> {
  await ws.store.applySync(ws.proj, batch);
}

/** 从结果文本提取 📎 块（无则 ''）。 */
function attachmentBlockOf(text: string): string {
  const i = text.indexOf("📎");
  return i === -1 ? "" : text.slice(i);
}

describe("edit 附着接线（真 .kg 锚表）", () => {
  test("① 符号域锚命中（CL-1.A1）：oldText 含符号名键 → 尾部 📎 块（digest+指针+协议行）；notifyWrite 只入队不触发 sync", async () => {
    const ws = makeWorkspace();
    const tr1 = makeNode(ws, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    declare(ws, tr1, [{ scopeKind: "symbol", pattern: "src/feat.ts#handler" }]);
    await syncBatch(ws, {
      files: [{ path: "src/feat.ts", mtime: 1, sha256: "h1" }],
      symbols: [{ name: "handler", kind: "function", spanStart: 2, spanEnd: 4, file: "src/feat.ts" }],
      containsEdges: [],
      materializedAnchors: [{ nodeId: tr1, anchorPath: "src/feat.ts", anchorSymbol: "handler", anchorKind: "symbol" }],
      baseline: "1",
      degraded: false,
    });
    const feat = path.join(ws.proj, "src", "feat.ts");
    writeFileSync(feat, "// header\nexport function handler() {\n  const cache = handlerCache();\n  return cache;\n}\n// tail\n");

    const r = await run(ws.toolFor("sess-1"), { path: "proj/src/feat.ts", edits: [{ oldText: "const cache = handlerCache();", newText: "const cache = handlerCache() ?? null;" }] }, ws.env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 尾部拼接：成功摘要在前、📎 块在后（CL-1.A1）
    expect(r.text.startsWith("Successfully replaced 1 block(s) in proj/src/feat.ts.")).toBe(true);
    const block = attachmentBlockOf(r.text);
    expect(block).not.toBe("");
    expect(r.text.indexOf("📎")).toBeGreaterThan(r.text.indexOf("Successfully replaced"));
    expect(block).toContain("handler 幂等规则"); // 粗体 name（digest+指针形态，AD-3）
    expect(block).toContain("handler 编辑必须保持幂等语义"); // digest
    expect(block).toContain(`kg get ${tr1}`); // 指针
    expect(block).toContain(ATTACHMENT_PROTOCOL_LINE); // 协议行（AD-14）
    // 写后通知：一次入队、projectRoot 归属正确；附着零 sync 触发（AD-15 无阻塞路径）
    expect(ws.notified.length).toBe(1);
    expect(ws.notified[0]!.projectRoot).toBe(ws.proj);
    expect(ws.notified[0]!.path).toBe(feat);
  });

  test("② 未命中（CL-1.A2）：无锚文件 / 域外编辑 → 无 📎、编辑行为不变", async () => {
    const ws = makeWorkspace();
    const tr1 = makeNode(ws, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    await syncBatch(ws, {
      files: [{ path: "src/feat.ts", mtime: 1, sha256: "h1" }],
      symbols: [{ name: "handler", kind: "function", spanStart: 2, spanEnd: 4, file: "src/feat.ts" }],
      containsEdges: [],
      materializedAnchors: [{ nodeId: tr1, anchorPath: "src/feat.ts", anchorSymbol: "handler", anchorKind: "symbol" }],
      baseline: "1",
      degraded: false,
    });
    // 无锚文件：全层落空 → 沉默
    writeFileSync(path.join(ws.proj, "src", "plain.ts"), "const alphaSetting = 1;\n");
    const plain = await run(ws.toolFor("sess-2"), { path: "proj/src/plain.ts", edits: [{ oldText: "const alphaSetting = 1;", newText: "const alphaSetting = 2;" }] }, ws.env);
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.text).toBe("Successfully replaced 1 block(s) in proj/src/plain.ts.");
    // 有锚文件但编辑点域外（行 1 注释、标识符不命中）：L1/L3 均落空 → 沉默
    writeFileSync(path.join(ws.proj, "src", "feat.ts"), "// header line\nexport function handler() {\n  return 1;\n}\n");
    const outside = await run(ws.toolFor("sess-2"), { path: "proj/src/feat.ts", edits: [{ oldText: "// header line", newText: "// header line v2" }] }, ws.env);
    expect(outside.ok).toBe(true);
    if (outside.ok) expect(outside.text).toBe("Successfully replaced 1 block(s) in proj/src/feat.ts.");
  });

  test("③ 快照滞后保守降级（AD-15）：陈旧 span 回扫失败 → 跳过符号锚不错附，文件级兜底照常到达", async () => {
    const ws = makeWorkspace();
    const trSym = makeNode(ws, "legacy 规则", "legacy 符号域规则摘要");
    const trPath = makeNode(ws, "stale 文件域规则", "stale 文件域规则摘要");
    // 符号 legacy 的 span {1,40} 是上次 sync 值——文件此后缩到 4 行（滞后合法）
    await syncBatch(ws, {
      files: [{ path: "src/stale.ts", mtime: 1, sha256: "h1" }],
      symbols: [{ name: "legacy", kind: "function", spanStart: 1, spanEnd: 40, file: "src/stale.ts" }],
      containsEdges: [],
      materializedAnchors: [
        { nodeId: trSym, anchorPath: "src/stale.ts", anchorSymbol: "legacy", anchorKind: "symbol" },
        { nodeId: trPath, anchorPath: "src/stale.ts", anchorSymbol: null, anchorKind: "path" },
      ],
      baseline: "1",
      degraded: false,
    });
    writeFileSync(path.join(ws.proj, "src", "stale.ts"), "const totalAmount = 0;\nconst secondValue = 2;\nconst thirdValue = 3;\nconst fourthValue = 4;\n");
    const r = await run(ws.toolFor("sess-3"), { path: "proj/src/stale.ts", edits: [{ oldText: "const totalAmount = 0;", newText: "const totalAmount = 1;" }] }, ws.env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = attachmentBlockOf(r.text);
    // 编辑行 1 数值上落入陈旧 span [1,40]，但 span 越出当前文件（4 行）→
    // 回扫 legacy 声明行不存在 → 符号锚整体跳过（宁可沉默不可错附）
    expect(block).not.toContain(`kg get ${trSym}`);
    // 文件级兜底（L4）不受符号层滞后影响，照常到达
    expect(block).toContain(`kg get ${trPath}`);
  });

  test("④ 预算超限（CL-1）：多候选超 800 token → 特异性序贪心裁剪，块长不超硬顶", async () => {
    const ws = makeWorkspace();
    // 9 个符号域锚同批命中（oldText 携带全部符号名键），digest 各 600 字 → 总量远超硬顶
    const symbols: Array<{ name: string; id: string }> = [];
    const anchors: MaterializedAnchor[] = [];
    const names = ["alphaOne", "betaTwo", "gammaThree", "deltaFour", "epsilonFive", "zetaSix", "etaSeven", "thetaEight", "iotaNine"];
    for (const name of names) {
      const id = makeNode(ws, `${name} 规则`, `${name} `.repeat(60).trim());
      symbols.push({ name, id });
      anchors.push({ nodeId: id, anchorPath: "src/big.ts", anchorSymbol: name, anchorKind: "symbol" });
    }
    await syncBatch(ws, {
      files: [{ path: "src/big.ts", mtime: 1, sha256: "h1" }],
      symbols: symbols.map((s) => ({ name: s.name, kind: "function", spanStart: 1, spanEnd: 2, file: "src/big.ts" })),
      containsEdges: [],
      materializedAnchors: anchors,
      baseline: "1",
      degraded: false,
    });
    const joined = names.join("();\nconst ") + "();";
    writeFileSync(path.join(ws.proj, "src", "big.ts"), `const ${joined}\n`);
    const r = await run(ws.toolFor("sess-4"), { path: "proj/src/big.ts", edits: [{ oldText: joined, newText: `${joined}// v2` }] }, ws.env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = attachmentBlockOf(r.text);
    expect(block).not.toBe("");
    const hitCount = [...block.matchAll(/kg get /g)].length;
    expect(hitCount).toBeGreaterThan(0);
    expect(hitCount).toBeLessThan(symbols.length); // 超限裁剪发生
    expect(block.length).toBeLessThanOrEqual(800 * 4); // token 硬顶（估算=chars/4）
    // 稳定基序下高特异性（先入快照序）者保留
    expect(block).toContain(`kg get ${symbols[0]!.id}`);
  });

  test("⑤ 管线故障静默（CL-1.A11）：快照读抛错 / 挂点 reject → edit 成功返回、无 📎、零错误暴露", async () => {
    // (a) 快照读故障：fake port 抛错 → 服务捕获返回 '' → 结果原样
    const root = mkdtempSync(path.join(tmpdir(), "kg-attach-quiet-"));
    try {
      const failing: KnowledgeGraphPort = {
        getAttachmentSnapshot: () => {
          throw new Error("snapshot read fault");
        },
        search: () => [],
        getNode: () => null,
        getIndexStatus: () => ({ baseline: "1", symbolCount: 3, degraded: false }),
        getSyncBaseline: () => ({ files: [], symbols: [], activeAnchors: [], anchorDeclarations: [] }),
        getVerifyView: () => ({ nodes: [], edges: [], anchors: [], anchorDeclarations: [], files: [] }),
        getChangeLog: () => [],
      };
      const attachment = new KgAttachmentService({ graph: failing });
      const env = new NodeExecutionEnv({ cwd: root });
      const tool = createEditTool(
        buildEditToolDeps({ workspaceRoot: root, syncService: { notifyWrite: () => {} }, attachment, sessionId: "sess-5a" }),
      );
      writeFileSync(path.join(root, "quiet.ts"), "const quietValue = 1;\n");
      const r = await run(tool, { path: "quiet.ts", edits: [{ oldText: "const quietValue = 1;", newText: "const quietValue = 2;" }] }, env);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.text).toBe("Successfully replaced 1 block(s) in quiet.ts.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // (b) 挂点自身 reject：EditTool 侧吞咽，结果不受影响
    const ws = makeWorkspace();
    writeFileSync(path.join(ws.proj, "src", "x.ts"), "const boomValue = 1;\n");
    const tool = createEditTool({
      projectRoot: ws.proj,
      onEditApplied: async () => {
        throw new Error("attach pipeline boom");
      },
    });
    const r2 = await run(tool, { path: "proj/src/x.ts", edits: [{ oldText: "const boomValue = 1;", newText: "const boomValue = 2;" }] }, ws.env);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.text).toBe("Successfully replaced 1 block(s) in proj/src/x.ts.");
  });

  test("⑥ 跨通道会话去重（CL-1.A3）：markInjected 过不再附；本通道附着过不重复；baseline 推进后缓存失效", async () => {
    const ws = makeWorkspace();
    const tr1 = makeNode(ws, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    await syncBatch(ws, {
      files: [{ path: "src/feat.ts", mtime: 1, sha256: "h1" }],
      symbols: [{ name: "handler", kind: "function", spanStart: 2, spanEnd: 4, file: "src/feat.ts" }],
      containsEdges: [],
      materializedAnchors: [{ nodeId: tr1, anchorPath: "src/feat.ts", anchorSymbol: "handler", anchorKind: "symbol" }],
      baseline: "1",
      degraded: false,
    });
    const feat = path.join(ws.proj, "src", "feat.ts");
    writeFileSync(feat, "// header\nexport function handler() {\n  const cache = handlerCache();\n  return cache;\n}\n// tail\n");

    // A. 新会话首次命中 → 附着（本通道自此计入注册表）
    const a = await run(ws.toolFor("sess-fresh"), { path: "proj/src/feat.ts", edits: [{ oldText: "const cache = handlerCache();", newText: "const cache = handlerCache() ?? null;" }] }, ws.env);
    expect(a.ok && attachmentBlockOf(a.text)).toContain(`kg get ${tr1}`);

    // B. 同会话再次命中（L3：编辑行落入 span）→ 不重复附
    const b = await run(ws.toolFor("sess-fresh"), { path: "proj/src/feat.ts", edits: [{ oldText: "  return cache;", newText: "  return cache ?? 0;" }] }, ws.env);
    expect(b.ok && b.text).toBe("Successfully replaced 1 block(s) in proj/src/feat.ts.");

    // C. 他会话先经任务层 markInjected（T3.3 同一注册表）→ 动作层不再附
    ws.attachment.markInjected("sess-dedup", [tr1]);
    const c = await run(ws.toolFor("sess-dedup"), { path: "proj/src/feat.ts", edits: [{ oldText: "const cache = handlerCache() ?? null;", newText: "const cache = handlerCache() ?? undefined;" }] }, ws.env);
    expect(c.ok && c.text).toBe("Successfully replaced 1 block(s) in proj/src/feat.ts.");

    // D. baseline 推进（sync 完成）→ 快照缓存失效，新锚可达
    const tr2 = makeNode(ws, "second 规则", "second 新增规则摘要");
    declare(ws, tr2, [{ scopeKind: "symbol", pattern: "src/feat.ts#second" }]);
    await syncBatch(ws, {
      files: [{ path: "src/feat.ts", mtime: 2, sha256: "h2" }],
      symbols: [{ name: "handler", kind: "function", spanStart: 2, spanEnd: 4, file: "src/feat.ts" }],
      containsEdges: [],
      materializedAnchors: [{ nodeId: tr2, anchorPath: "src/feat.ts", anchorSymbol: "second", anchorKind: "symbol" }],
      baseline: "2",
      degraded: false,
    });
    const d = await run(ws.toolFor("sess-fresh"), { path: "proj/src/feat.ts", edits: [{ oldText: "  return cache ?? 0;", newText: "  return cache ?? secondFallback;" }] }, ws.env);
    expect(d.ok && attachmentBlockOf(d.text)).toContain(`kg get ${tr2}`);
  });
});
