import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { ATTACHMENT_PROTOCOL_LINE } from "../../src/domain/kg/attachment/render";
import type { KnowledgeWriteOp } from "../../src/domain/kg/types";
import type { WriteResult } from "../../src/domain/kg/types";

/**
 * I 层：kg / kg-update 工具（T3.3，CL-4 F4.1 + F3.1 即时通道，AD-14/AD-16）。
 *
 * 真 .kg tmp 库 + 种子数据（KgWriteService 真通道落账），工具经
 * CoreToolExecutor 注册表按 name 装配执行。
 *
 * 覆盖：①search LIKE+重名 digest 区分（CL-4.A1）②get 五要素全量（A2）
 * ③search→get 参数供给闭环 + 非法 id 结构化错误（A3）④只读保证——库文件
 * 字节不变 + 写面零调用（A4）⑤kg-update supersede/createNode 走
 * KgWriteService 唯一写路径（CL-3 即时落账之一）⑥注册表按 name 可验证。
 */

interface Fixture {
  readonly root: string; // workspace 根
  readonly proj: string; // projectRoot（.kg 持有者）
  readonly database: KgDatabase;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
  readonly query: KgQueryService;
  /** 写调用记录器（包 KgWriteService——只读断言/唯一写路径断言共用）。 */
  readonly writeCalls: KnowledgeWriteOp[];
  readonly recorder: { write(projectRoot: string, op: KnowledgeWriteOp): WriteResult };
  readonly kg: AgentHarnessTool<ExecutionToolContext, any, any>;
  readonly kgUpdate: AgentHarnessTool<ExecutionToolContext, any, any>;
  readonly env: NodeExecutionEnv;
  readonly dbFile: () => Buffer;
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
  const root = mkdtempSync(path.join(tmpdir(), "kg-tools-it-"));
  const proj = path.join(root, "proj");
  mkdirSync(proj, { recursive: true });
  const database = new KgDatabase();
  const graph = new SqliteKnowledgeGraph({ database });
  const store = new SqliteKnowledgeStore({ database });
  const write = new KgWriteService({ store });
  const writeCalls: KnowledgeWriteOp[] = [];
  const recorder = {
    write: (projectRoot: string, op: KnowledgeWriteOp): WriteResult => {
      writeCalls.push(op);
      return write.write(projectRoot, op);
    },
  };
  const query = new KgQueryService({ graph, projects: () => [proj] });
  const env = new NodeExecutionEnv({ cwd: root });
  const executor = new CoreToolExecutor({
    cwd: root,
    kg: { query, write: recorder, workspaceRoot: root, scanProjects: () => [proj] },
  });
  const [kg, kgUpdate] = executor.resolveTools(["kg", "kg-update"]) as unknown as AgentHarnessTool<
    ExecutionToolContext,
    any,
    any
  >[];
  const f: Fixture = {
    root,
    proj,
    database,
    graph,
    write,
    query,
    writeCalls,
    recorder,
    kg: kg!,
    kgUpdate: kgUpdate!,
    env,
    dbFile: () => readFileSync(path.join(proj, ".kg", "kg.db")),
  };
  fixtures.push(f);
  return f;
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

function seed(f: Fixture, op: KnowledgeWriteOp): WriteResult {
  return f.write.write(f.proj, op);
}

function mustId(r: WriteResult): string {
  if (!r.ok) throw new Error(`种子写失败：${r.error.code} ${r.error.message}`);
  return r.nodeId;
}

describe("kg / kg-update 工具（真 .kg tmp 库）", () => {
  test("① search(q) LIKE 匹配 + 重名两行 digest 区分（CL-4.A1）；结果含可供 get 的 id（A3 前半）", async () => {
    const f = makeFixture();
    const a = mustId(seed(f, { kind: "createNode", iterationId: "it-a", draft: { kind: "rule", name: "handler 幂等规则", digest: "handler 编辑必须保持幂等语义" } }));
    const b = mustId(seed(f, { kind: "createNode", iterationId: "it-a", draft: { kind: "rule", name: "handler 幂等规则", digest: "handler 失败可安全重试，无副作用" } }));
    expect(a).not.toBe(b); // 重名两节点自动发号互异

    const r = await run(f.kg, { op: "search", q: "handler" }, f.env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 两行共存（重名合法），digest 区分（AD-16）
    expect(r.text).toContain("handler 编辑必须保持幂等语义");
    expect(r.text).toContain("handler 失败可安全重试，无副作用");
    // name+kind 引用规范（无裸 id 主展示）：粗体 name + [rule] 徽章
    expect(r.text).toContain("**handler 幂等规则** [rule]");
    // 每行带 kg get 指针（id 只以指针形态出现）
    expect(r.text).toContain(`kg get ${a}`);
    expect(r.text).toContain(`kg get ${b}`);
    // LIKE 子串匹配：digest 片段也可命中
    const r2 = await run(f.kg, { op: "search", q: "安全重试" }, f.env);
    expect(r2.ok && r2.text).toContain(`kg get ${b}`);
    expect(r2.ok && r2.text).not.toContain(`kg get ${a}`);
    // 空命中文案
    const r3 = await run(f.kg, { op: "search", q: "不存在的关键词xyz" }, f.env);
    expect(r3.ok && r3.text).toContain("无命中");
  });

  test("② get(nodeId) 五要素全量聚合：节点/锚/关系/supersede 链/变更日志（CL-4.A2）", async () => {
    const f = makeFixture();
    const t1 = mustId(seed(f, { kind: "createNode", iterationId: "it-b", draft: { kind: "rule", name: "提交面规则", digest: "提交必须走唯一入口", body: "全部写操作经 WriteQueue 单点串行。" } }));
    const t2 = mustId(seed(f, { kind: "createNode", iterationId: "it-b", draft: { kind: "entity", name: "写队列", digest: "SQLite 单写队列实体" } }));
    seed(f, { kind: "declareAnchors", iterationId: "it-b", nodeId: t1, anchors: [{ scopeKind: "symbol", pattern: "src/store.ts#enqueue" }] });
    seed(f, { kind: "addEdge", iterationId: "it-b", srcId: t1, dstId: t2, verb: "governs" });

    const r = await run(f.kg, { op: "get", nodeId: t1 }, f.env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 描述：name/digest/body
    expect(r.text).toContain("提交面规则");
    expect(r.text).toContain("提交必须走唯一入口");
    expect(r.text).toContain("全部写操作经 WriteQueue 单点串行。");
    // 锚：声明
    expect(r.text).toContain("symbol");
    expect(r.text).toContain("src/store.ts#enqueue");
    // 关系：governs → t2
    expect(r.text).toContain("governs");
    expect(r.text).toContain(t2);
    // 变更日志：createNode + declareAnchors + addEdge 三行
    expect(r.text).toContain("createNode");
    expect(r.text).toContain("declareAnchors");
    expect(r.text).toContain("addEdge");

    // supersede 链：replacement 后新旧两侧链均可见（older/newer）
    const repl = mustId(seed(f, { kind: "supersede", iterationId: "it-c", nodeId: t1, reason: "提交面口径改写", replacementNodeDraft: { kind: "rule", name: "提交面规则 v2", digest: "提交必须走唯一入口（新口径）" } }));
    const oldSide = await run(f.kg, { op: "get", nodeId: t1 }, f.env);
    expect(oldSide.ok && oldSide.text).toContain("superseded");
    expect(oldSide.ok && oldSide.text).toContain(`取代者 ${repl}`);
    const newSide = await run(f.kg, { op: "get", nodeId: repl }, f.env);
    expect(newSide.ok && newSide.text).toContain(`被取代 ${t1}`);
    expect(newSide.ok && newSide.text).toContain("提交面口径改写"); // 理由入链可见（审计面）
  });

  test("③ 参数供给闭环 + 非法 id 结构化错误（CL-4.A3）：search 返回行 id 可直接用于 get；TR-n/E-n 外形态拒绝", async () => {
    const f = makeFixture();
    mustId(seed(f, { kind: "createNode", iterationId: "it-d", draft: { kind: "entity", name: "调度器", digest: "实例调度核心实体" } }));
    const s = await run(f.kg, { op: "search", q: "调度" }, f.env);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    // 从返回文本机械提取 id（agent 视角零构造/零猜测）
    const id = /kg get (E-\d+)/.exec(s.text)?.[1];
    expect(id).toBeDefined();
    const g = await run(f.kg, { op: "get", nodeId: id! }, f.env);
    expect(g.ok && g.text).toContain("调度器");

    // 非法 id 形态：未知前缀 / 非数字尾缀 → 结构化错误（不静默空结果）
    const bad1 = await run(f.kg, { op: "get", nodeId: "SPEC-2" }, f.env);
    expect(bad1.ok).toBe(false);
    if (!bad1.ok) expect(bad1.error).toContain("形态非法");
    const bad2 = await run(f.kg, { op: "get", nodeId: "TR-abc" }, f.env);
    expect(bad2.ok).toBe(false);
    // 合法形态但不存在 → 明确不存在（区别于形态错误）
    const miss = await run(f.kg, { op: "get", nodeId: "TR-999" }, f.env);
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toContain("不存在");
    // 缺参
    const noq = await run(f.kg, { op: "search" }, f.env);
    expect(noq.ok).toBe(false);
  });

  test("④ 只读保证（CL-4.A4）：search/get 全链路零写——库文件字节不变 + 写面零调用", async () => {
    const f = makeFixture();
    mustId(seed(f, { kind: "createNode", iterationId: "it-e", draft: { kind: "rule", name: "只读校验规则", digest: "kg 工具执行前后库不变" } }));
    const id = mustId(seed(f, { kind: "createNode", iterationId: "it-e", draft: { kind: "rule", name: "详情读取规则", digest: "get 全量聚合只读" } }));
    f.writeCalls.length = 0; // 种子写入不计
    const before = createHash("sha256").update(f.dbFile()).digest("hex");
    await run(f.kg, { op: "search", q: "只读" }, f.env);
    await run(f.kg, { op: "search", q: "" }, f.env).catch(() => {}); // 空关键词错误路径同样零写
    await run(f.kg, { op: "get", nodeId: id }, f.env);
    await run(f.kg, { op: "get", nodeId: "TR-999" }, f.env);
    const after = createHash("sha256").update(f.dbFile()).digest("hex");
    expect(after).toBe(before); // 库文件字节级不变（零写事务即零页面变更）
    expect(f.writeCalls.length).toBe(0); // 写面零调用（kg 工具无任何写路径）
  });

  test("⑤ kg-update：supersede 即时落库（无人审）+ createNode 自动发号——全部经 KgWriteService（唯一写路径）", async () => {
    const f = makeFixture();
    const t1 = mustId(seed(f, { kind: "createNode", iterationId: "it-f", draft: { kind: "rule", name: "旧规则", digest: "待推翻的旧口径" } }));

    // supersede：status 翻转 + change_log 留痕（含理由与迭代 id）
    const r = await run(f.kgUpdate, { op: "supersede", nodeId: t1, reason: "口径已被实现推翻", iterationId: "iter-t33" }, f.env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain(t1);
    const detail = f.graph.getNode(f.proj, t1)!;
    expect(detail.node.status).toBe("superseded");
    const supersedeLog = detail.changeLog.find((e) => e.op === "supersede");
    expect(supersedeLog).toBeDefined();
    expect(supersedeLog!.reason).toBe("口径已被实现推翻");
    expect(supersedeLog!.iterationId).toBe("iter-t33");
    // 写路径唯一：op 经注入的 KgWriteService 面（记录器捕获）
    expect(f.writeCalls.some((op) => op.kind === "supersede" && op.nodeId === t1)).toBe(true);

    // supersede + replacement：新节点自动发号 + 链上双侧可见
    const t2 = mustId(seed(f, { kind: "createNode", iterationId: "it-f", draft: { kind: "rule", name: "第二条", digest: "第二条规则摘要" } }));
    const r2 = await run(f.kgUpdate, {
      op: "supersede",
      nodeId: t2,
      reason: "改写为新口径",
      iterationId: "iter-t33",
      replacement: { kind: "rule", name: "第二条 v2", digest: "第二条规则的新口径摘要" },
    }, f.env);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const newId = [...r2.text.matchAll(/TR-\d+/g)].map((m) => m[0]).find((id) => id !== t2 && id !== t1);
    expect(newId).toBeDefined();
    const newDetail = f.graph.getNode(f.proj, newId!)!;
    expect(newDetail.node.name).toBe("第二条 v2");
    expect(f.graph.getNode(f.proj, t2)!.node.status).toBe("superseded");

    // createNode：自动发号（不指定 id）+ 锚声明组合落账
    const before = f.graph.search(f.proj, "").length;
    const r3 = await run(f.kgUpdate, {
      op: "createNode",
      kind: "entity",
      name: "新实体",
      digest: "由 agent 即时沉淀的新实体摘要",
      body: "正文可选。",
      domain: "tech",
      anchors: [{ scopeKind: "path", pattern: "src/new/**" }],
      iterationId: "iter-t33",
    }, f.env);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const createdId = /(E-\d+)/.exec(r3.text)?.[0];
    expect(createdId).toBeDefined();
    const created = f.graph.getNode(f.proj, createdId!)!;
    expect(created.node.name).toBe("新实体");
    expect(created.node.domain).toBe("tech");
    expect(created.anchorDeclarations.some((a) => a.pattern === "src/new/**")).toBe(true);
    expect(f.graph.search(f.proj, "").length).toBe(before + 1);

    // 校验错误走结构化错误（KgWriteService 校验器前置）：digest 超行
    const bad = await run(f.kgUpdate, { op: "createNode", kind: "rule", name: "坏草稿", digest: "一\n二\n三", iterationId: "iter-t33" }, f.env);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("digest");
    // 多项目场景 project 参数解析：fixture 只有一项目 → 省略 project 可用（上文 r3 已证）
  });

  test("⑥ 注册表装配：提供 kg deps 时 kg/kg-update 按 name 可解析；未提供时不注册", () => {
    const f = makeFixture();
    const executor = new CoreToolExecutor({
      cwd: f.root,
      kg: { query: f.query, write: f.recorder, workspaceRoot: f.root, scanProjects: () => [f.proj] },
    });
    const tools = executor.resolveTools(["kg", "kg-update"]);
    expect(tools.map((t) => t.name).sort()).toEqual(["kg", "kg-update"]);

    const bare = new CoreToolExecutor({ cwd: f.root });
    expect(() => bare.resolveTools(["kg"])).toThrow(/不在注册表/);
  });

  test("⑦ 协议行复用（AD-14 同源）：附着协议行常量不因本任务引入第二定义", () => {
    expect(ATTACHMENT_PROTOCOL_LINE).toContain("supersede");
  });
});
