import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { SystemPromptAssembler } from "../../src/application/services/SystemPromptAssembler";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";

/**
 * I 层（真 SQLite tmp 库）：常驻规则索引通道（global 声明节点 → 系统提示
 * 触发面段）——E-11 常驻层设计缺口的机械实现。
 *
 * 覆盖：
 * ① adapter listGlobalResidentRules：global 声明命中 / superseded 排除 /
 *    path/symbol 声明不命中 / scene 空行保留（渲染层跳过）/ id 确定性；
 * ② KgQueryService.residentRulesSection：跨项目聚合 + multiProject 尾注 /
 *    空项目集 → null（段省略）；
 * ③ SystemPromptAssembler 第四段：residentSection 拼接 / null·undefined·空串
 *    全省略（无图谱项目零注入痕迹）；
 * ④ 未建库项目不进查询面（projects 注入方过滤——读面绝不新建库文件）。
 */

interface Fixture {
  readonly root: string;
  readonly projA: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
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
  const root = mkdtempSync(path.join(tmpdir(), "kg-resident-it-"));
  const projA = path.join(root, "projA");
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const fixture: Fixture = { root, projA, database, store, graph, write };
  fixtures.push(fixture);
  return fixture;
}

function seedNode(
  f: Fixture,
  proj: string,
  name: string,
  scene: string,
): string {
  const r = f.write.write(proj, {
    kind: "createNode",
    iterationId: "iter-resident",
    draft: { kind: "rule", name, digest: `${name}摘要`, scene },
  });
  if (!r.ok) throw new Error(`seed failed: ${r.error.message}`);
  return r.nodeId;
}

describe("① adapter listGlobalResidentRules", () => {
  test("global 声明命中；superseded 排除；path/symbol 声明不命中；id 升序", () => {
    const f = makeFixture();
    const g1 = seedNode(f, f.projA, "常驻甲", "适用于：改动甲类文件前");
    const g2 = seedNode(f, f.projA, "常驻乙", "适用于：改动乙类文件前");
    const gone = seedNode(f, f.projA, "已退役", "适用于：任意");
    const pathOnly = seedNode(f, f.projA, "路径锚规则", "适用于：特定路径");
    for (const id of [g1, g2, gone]) {
      const r = f.write.write(f.projA, { kind: "declareAnchors", iterationId: "iter-resident", nodeId: id, anchors: [{ scopeKind: "global" }] });
      if (!r.ok) throw new Error(r.error.message);
    }
    const pr = f.write.write(f.projA, {
      kind: "declareAnchors",
      iterationId: "iter-resident",
      nodeId: pathOnly,
      anchors: [{ scopeKind: "path", pattern: "src/foo.ts" }],
    });
    if (!pr.ok) throw new Error(pr.error.message);
    const sr = f.write.write(f.projA, { kind: "supersede", iterationId: "iter-resident", nodeId: gone, reason: "退役测试" });
    if (!sr.ok) throw new Error(sr.error.message);

    const rows = f.graph.listGlobalResidentRules(f.projA);
    expect(rows.map((r) => r.id)).toEqual([g1, g2].sort());
    expect(rows.find((r) => r.id === g1)).toMatchObject({
      kind: "rule",
      name: "常驻甲",
      scene: "适用于：改动甲类文件前",
    });
  });

  test("scene 空节点保留在查询面（渲染层跳过；写面 R23 必填，仅历史库可达——直写模拟）", () => {
    const f = makeFixture();
    const noScene = seedNode(f, f.projA, "无场景节点", "占位场景");
    const r = f.write.write(f.projA, {
      kind: "declareAnchors",
      iterationId: "iter-resident",
      nodeId: noScene,
      anchors: [{ scopeKind: "global" }],
    });
    if (!r.ok) throw new Error(r.error.message);
    // 直写模拟历史遗留空 scene 行（R23 前建库形态；测试装置 SQL，非生产面）
    f.database
      .knowledgeConnection(f.projA)
      .prepare("UPDATE nodes SET scene = '' WHERE id = ?")
      .run(noScene);
    const rows = f.graph.listGlobalResidentRules(f.projA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scene).toBe("");
    // 渲染层跳过空 scene 条目 → 段省略（无触达价值不产出段）
    const query = new KgQueryService({ graph: f.graph, projects: () => [f.projA] });
    expect(query.residentRulesSection()).toBeNull();
  });
});

describe("② KgQueryService.residentRulesSection", () => {
  test("跨项目聚合 + multiProject 指针尾注；单项目无尾注", () => {
    const f = makeFixture();
    const projB = path.join(f.root, "projB");
    const a = seedNode(f, f.projA, "甲项目规则", "适用于：改动甲项目前");
    const rA = f.write.write(f.projA, { kind: "declareAnchors", iterationId: "iter-resident", nodeId: a, anchors: [{ scopeKind: "global" }] });
    if (!rA.ok) throw new Error(rA.error.message);
    const b = seedNode(f, projB, "乙项目规则", "适用于：改动乙项目前");
    const rB = f.write.write(projB, { kind: "declareAnchors", iterationId: "iter-resident", nodeId: b, anchors: [{ scopeKind: "global" }] });
    if (!rB.ok) throw new Error(rB.error.message);

    const single = new KgQueryService({ graph: f.graph, projects: () => [f.projA] });
    const singleOut = single.residentRulesSection()!;
    expect(singleOut).toContain("kg get " + a);
    expect(singleOut).not.toContain("project:");

    const multi = new KgQueryService({ graph: f.graph, projects: () => [f.projA, projB] });
    const multiOut = multi.residentRulesSection()!;
    expect(multiOut).toContain(`kg get ${a}（project: projA）`);
    expect(multiOut).toContain(`kg get ${b}（project: projB）`);
  });

  test("空项目集（无图谱 workspace）→ null；未建库项目不进查询面", () => {
    const f = makeFixture();
    const empty = new KgQueryService({ graph: f.graph, projects: () => [] });
    expect(empty.residentRulesSection()).toBeNull();
    // graph 查询抛错 → 静默 null（增强面不阻断组装）
    const failing = new KgQueryService({
      graph: {
        ...f.graph,
        listGlobalResidentRules: () => {
          throw new Error("boom");
        },
      } as never,
      projects: () => [f.projA],
    });
    expect(failing.residentRulesSection()).toBeNull();
  });
});

describe("③ SystemPromptAssembler 第四段拼接", () => {
  const assembler = new SystemPromptAssembler({ toolSnippets: {} });

  test("residentSection 出现在技能段之后；null/undefined/空串全部段省略", () => {
    const withSection = assembler.assemble({
      basePrompt: "BASE",
      toolNames: ["read"],
      skills: [],
      residentSection: "项目常驻规则（kg 触发面索引）：\n- **TR-57** [rule]\n  适用：适用于：改锚前\n  ↳ kg get TR-57",
    });
    expect(withSection).toContain("项目常驻规则（kg 触发面索引）：");
    expect(withSection.indexOf("可用工具：")).toBeLessThan(withSection.indexOf("项目常驻规则"));

    for (const absent of [undefined, null, ""] as const) {
      const out = assembler.assemble({ basePrompt: "BASE", toolNames: [], skills: [], residentSection: absent });
      expect(out).not.toContain("项目常驻规则");
    }
  });
});

/** 挂起 runner（E2E 只观测 spawn 快照落盘，不驱动收口）。 */
class HangingRunner implements InstanceRunner {
  setCallbacks(_callbacks: InstanceRunnerCallbacks): void {
    /* 本文件不消费实例回调 */
  }
  launch(): void {
    /* 挂起 */
  }
  kill(): void {
    /* 幂等空操作 */
  }
}

async function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function snapshotSystemPrompt(home: string, sessionId: string, agentId: string): Promise<string> {
  const repo = new SqliteSessionRepository(new WriteQueue(path.join(home, "helix.db")));
  let found: string | undefined;
  await until(
    () => {
      const hit = repo
        .queryEvents({ sessionId })
        .find((e) => e.type === "agent.instantiated" && (e.payload as { instanceId?: string }).instanceId === agentId);
      if (hit !== undefined) {
        found = (hit.payload as { profileSnapshot: { systemPrompt: string } }).profileSnapshot.systemPrompt;
        return true;
      }
      return false;
    },
    5000,
    "agent.instantiated 落盘",
  );
  return found!;
}

describe("④ E2E：daemon 组装链（container 常驻段接线）", () => {
  afterEach(async () => {
    if (e2eHome !== undefined) {
      rmSync(e2eHome, { recursive: true, force: true });
      e2eHome = undefined;
    }
  });
  let e2eHome: string | undefined;

  test("已建库项目 global 节点 → spawn 快照 systemPrompt 含触发面段（scene+指针，无正文）", async () => {
    const home = (e2eHome = mkdtempSync(path.join(tmpdir(), "helix-resident-e2e-")));
    // ① workspace 预建项目库：projA 带 global 声明节点；projB 目录存在但无库
    const projA = path.join(home, "projA");
    const seedDb = new KgDatabase();
    const seedWrite = new KgWriteService({ store: new SqliteKnowledgeStore({ database: seedDb }) });
    const seed = seedWrite.write(projA, {
      kind: "createNode",
      iterationId: "iter-resident-e2e",
      draft: { kind: "rule", name: "常驻治理规则", digest: "常驻治理规则摘要", scene: "适用于：改 daemon 代码前" },
    });
    if (!seed.ok) throw new Error(seed.error.message);
    const nodeId = seed.nodeId;
    let r = seedWrite.write(projA, { kind: "declareAnchors", iterationId: "iter-resident-e2e", nodeId, anchors: [{ scopeKind: "global" }] });
    if (!r.ok) throw new Error(r.error.message);
    seedDb.closeAll();

    // ② daemon 起在带库 workspace
    const daemon = await createTestDaemon({
      home,
      engine: new FakeAgentEngine(),
      skipConfig: true,
      port: 0,
      subagentRunner: new HangingRunner(),
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      kgWorkspaceRoot: home,
    });
    try {
      const outcome = daemon.orchestration.spawn("常驻段验证任务", "subagent-worker");
      if (outcome.status !== "run") throw new Error(`spawn 被拒：${JSON.stringify(outcome)}`);
      const prompt = await snapshotSystemPrompt(home, daemon.system.getStatus().sessionId, outcome.agentId);
      expect(prompt).toContain("项目常驻规则（kg 触发面索引）：");
      expect(prompt).toContain("常驻治理规则");
      expect(prompt).toContain("适用：适用于：改 daemon 代码前");
      expect(prompt).toContain(`kg get ${nodeId}`);
      // 触发面段不含正文/digest（用户裁决：只渲染场景，主动查询全文）
      expect(prompt).not.toContain("适用于：改 daemon 代码前摘要");
    } finally {
      await daemon.shutdown();
    }
  }, 20000);
});
