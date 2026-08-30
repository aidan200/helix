/**
 * T4.1 bootstrap e2e 共享基建（剧本一/二/三共用）：
 * - fixture workspace：<home>/ws/demo-proj（几份源文件——项目扫描/codegraph
 *   不可用时 degraded 基准的锚面）；
 * - 编排主 agent 剧本构造器（{last.field} 模板：insert_batch 回执的
 *   batchId/jobId 组入 spawn brief——brief 携带任务元数据交批次子进程落账）；
 * - 批次子进程剧本（toolCalls 多轮工具 + {batchId}/{taskId}/{layer} 从 brief
 *   提取——LLM 输出钉剧本，plan/kg-update 工具执行全真）；
 * - SQLite 直查（bun -e 子进程只读；CL-1-e2e-subagent-engine-error 先例形态）。
 *
 * 纪律（TR-TEST-3）：剧本只钉 LLM 输出——引擎状态机/恢复/重试/幂等/closure
 * 硬约束/KgWriteService 落库全部真代码真 SQLite，绝不进剧本。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DaemonScript } from "./daemon-script";
import type { OrchestratorScriptEntry } from "./daemon-script";
import type { FakeEngineScript } from "../../apps/daemon/src/adapters/driven/subagent/child/scriptedEngine";

const BUN = process.env.HELIX_E2E_BUN ?? "bun";
export const E2E_BUN = BUN;

/** fixture 项目名（workspace 一级目录）。 */
export const BOOTSTRAP_PROJECT = "demo-proj";

/** 建 fixture workspace（<home>/ws/demo-proj + 若干源文件），返回 ws 根。 */
export function makeBootstrapWorkspace(home: string): string {
  const ws = path.join(home, "ws");
  const proj = path.join(ws, BOOTSTRAP_PROJECT);
  mkdirSync(path.join(proj, "src"), { recursive: true });
  writeFileSync(
    path.join(proj, "src", "cart.ts"),
    [
      "/** 购物车领域（fixture：L1 会话/购物域、L2 实体面）。 */",
      "export interface CartItem { sku: string; qty: number; }",
      "export class Cart {",
      "  private items: CartItem[] = [];",
      "  add(item: CartItem): void { this.items.push(item); }",
      "  total(): number { return this.items.reduce((n, i) => n + i.qty, 0); }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(proj, "src", "session.ts"),
    [
      "/** 会话管理域（fixture）。 */",
      "export type SessionState = 'open' | 'closed';",
      "export class SessionRegistry {",
      "  private sessions = new Map<string, SessionState>();",
      "  open(id: string): void { this.sessions.set(id, 'open'); }",
      "  close(id: string): void { this.sessions.set(id, 'closed'); }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(proj, "README.md"),
    "# demo-proj\n\nbootstrap e2e fixture 项目（购物车 + 会话两域）。\n",
    "utf8",
  );
  return ws;
}

// ── 编排主 agent 剧本（Launcher 侧消费；{last.<field>} = 最近工具结果 JSON 字段） ──

/** 批次 brief 模板：固定段齐全（范围/锚定/产出要求含任务元数据标记行/验收）。 */
function batchBrief(stage: { seq: number; layer: string; scope: string }): string {
  return [
    "## 任务目标",
    `探索 ${BOOTSTRAP_PROJECT} 的 ${stage.scope}，产出知识节点。`,
    "",
    "## 范围段",
    `目标层=${stage.layer}；对象：${stage.scope}。`,
    "",
    "## 产出要求段（元数据标记行——落账必带）",
    `taskId={any.jobId}`,
    `origin_batchId={any.batchId}`,
    "status=confirmed；layer 见上；kg-update 落账（iterationId 用 bootstrap-e2e）。",
    "",
    "## 验收段",
    "写作规范五条；closure 前台账全 resolve。",
  ].join("\n");
}

interface StageSpec {
  readonly seq: number;
  readonly layer: string;
  readonly scope: string;
  readonly summary: string;
}

export const BOOTSTRAP_STAGES: readonly StageSpec[] = [
  { seq: 1, layer: "L0", scope: "架构与全局规范", summary: "L0 层建成：架构 2 节点（分层/写通道），锚定文件级。" },
  { seq: 2, layer: "L1", scope: "领域层（会话管理域）", summary: "L1 层建成：会话管理域 2 节点，锚定 L0 架构事实。" },
  { seq: 3, layer: "L2", scope: "实体层（购物车模块）", summary: "L2 层建成：购物车实体 2 节点（符号域锚），关联 L1 会话域。" },
];

/** 单阶段批次循环段：插行 → 推阶段 → 派发三步 → 等待（收口后聚合）。 */
function stageEntries(stage: StageSpec): OrchestratorScriptEntry[] {
  const brief = batchBrief(stage);
  return [
    { kind: "tool", toolName: "task_insert_batch", args: { stageSeq: stage.seq, scope: `L${stage.seq === 1 ? "0" : stage.seq === 2 ? "1" : "2"} ${stage.scope}` } },
    { kind: "tool", toolName: "task_advance_stage", args: { stageSeq: stage.seq } },
    { kind: "tool", toolName: "agent_spawn", args: { task: brief } },
    { kind: "tool", toolName: "task_dispatch_batch", args: { batchId: "{any.batchId}", instanceId: "{any.agentId}" } },
    { kind: "reply", text: `批次 #${stage.seq}.1 已派发，等待收口注入。` },
    // 收口注入后：聚合阶段产物 → （下一轮插下阶段）——由驱动轮继续
    { kind: "tool", toolName: "task_stage_artifact", args: { stageSeq: stage.seq, summary: stage.summary } },
  ];
}

/** 全链路 happy path 剧本：三阶段各一批，末尾申报完成。 */
export function happyPathOrchestratorScript(): OrchestratorScriptEntry[] {
  return [
    ...BOOTSTRAP_STAGES.slice(0, 2).flatMap((s) => stageEntries(s)),
    // 第 3 阶段：聚合后直接申报完成（收口注入驱动最后一轮）
    ...stageEntries(BOOTSTRAP_STAGES[2]!),
    { kind: "tool", toolName: "task_complete_job", args: {} },
  ];
}

// ── 批次子进程剧本（子进程 scriptedEngine 消费；模板从 brief 提取） ──

/**
 * 每层 2 节点（kind/name/digest/body 差异化）。
 *
 * ⚠️ 剧本模板求值陷阱（T4.1 收口教训）：child 剧本是单一文件服务全部
 * 批次实例，layer 差异只能经模板插值（templateToolArgs 只插值字符串叶子，
 * 不重建数组）——layerNodes("{layer}") 这种构造期求值会拿到空数组。
 * 故 nodes 采用字段级 {layer} 占位（name/digest/body 携带占位符，插值期
 * 展开）；kind 固定 rule+entity 各一（保 E- 号断言：entity 自动发 E- 前缀）。
 */
function layerNodes(): Record<string, unknown>[] {
  return [
    {
      kind: "rule",
      name: "{layer} 层架构事实",
      digest: "demo-proj {layer} 层的结构事实：fixture 两模块并列。评估 {layer} 相关改动时先看这条。",
      body: "demo-proj 的 {layer} 层结构事实（fixture：cart/session 两模块）。此节点由 bootstrap e2e 批次产出，正文为模板插值生成，用于验证任务→阶段→批次分组的元数据链路。",
    },
    {
      kind: "entity",
      name: "{layer} 层核心实体",
      digest: "demo-proj {layer} 层的核心实体：承载该层行为变更的入口。改 {layer} 相关行为时从这里入手。",
      body: "demo-proj {layer} 层核心实体（fixture）。与架构事实节点同批产出，锚定模块并列关系；kind=entity 保 E- 前缀自动发号，供事后修正（supersede）断言面。",
    },
  ];
}

/** 批次子进程剧本：plan_create → plan_update → kg-update 批量落账 → plan_update → closure。 */
export function batchChildEngineScript(): FakeEngineScript {
  return {
    chunkDelayMs: 2,
    toolCalls: [
      {
        name: "plan_create",
        args: { items: ["探索范围内模块结构与符号", "产出知识节点并落账"] },
      },
      // work_item 状态机链式（§3.2）：pending → in_progress → done/abandoned
      //（直达终会被工具层拒绝——链条更新是 SOP 纪律，剧本如实模拟）
      { name: "plan_update", args: { seq: 1, status: "in_progress" } },
      { name: "plan_update", args: { seq: 1, status: "done", note: "结构已探索（fixture 两模块）" } },
      {
        name: "kg-update",
        args: {
          op: "batchCreateNodes",
          iterationId: "bootstrap-e2e",
          status: "confirmed",
          layer: "{layer}",
          taskId: "{taskId}",
          originBatchId: "{batchId}",
          nodes: layerNodes(),
        },
      },
      { name: "plan_update", args: { seq: 2, status: "in_progress" } },
      { name: "plan_update", args: { seq: 2, status: "done", note: "节点已落库（kg-update 批量）" } },
    ],
    replies: [
      '批次探索完成，知识节点已落账。\n<<<CLOSURE\n{"status":"done","summary":"批次完成：知识节点已落库","reportPath":null,"findings":[],"taskId":null}\nCLOSURE>>>',
    ],
  };
}

// ── SQLite 直查（bun -e 只读；daemon 运行中 WAL 并发读安全） ──

export interface KgNodeRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly layer: string | null;
  readonly origin_batch_id: string | null;
  readonly status: string;
}

export interface KgChangeLogRow {
  readonly seq: number;
  readonly task_id: string | null;
  readonly op: string;
  readonly node_id: string;
  readonly reason: string | null;
}

export interface TaskTablesRow {
  readonly jobs: number;
  readonly stages: number;
  readonly batches: number;
  readonly work_items: number;
}

function runBun(script: string): unknown {
  const out = execFileSync(E2E_BUN, ["-e", script], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").at(-1)!) as unknown;
}

/** kg 库节点行（含 superseded 留史）。 */
export function kgNodes(wsRoot: string, project = BOOTSTRAP_PROJECT): KgNodeRow[] {
  const db = path.join(wsRoot, project, ".helix-kg", "kg.db");
  return runBun(`
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(db)}, { readonly: true });
console.log(JSON.stringify(db.query("SELECT id, kind, name, layer, origin_batch_id, status FROM nodes ORDER BY id").all()));
`) as KgNodeRow[];
}

/** kg 库 change_log 行。 */
export function kgChangeLog(wsRoot: string, project = BOOTSTRAP_PROJECT): KgChangeLogRow[] {
  const db = path.join(wsRoot, project, ".helix-kg", "kg.db");
  return runBun(`
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(db)}, { readonly: true });
console.log(JSON.stringify(db.query("SELECT seq, task_id, op, node_id, reason FROM change_log ORDER BY seq").all()));
`) as KgChangeLogRow[];
}

/** helix.db 任务四表行数（删除清理面断言）。 */
export function taskTableCounts(home: string): TaskTablesRow {
  const db = path.join(home, "helix.db");
  return runBun(`
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(db)}, { readonly: true });
const c = (t) => db.query("SELECT COUNT(*) AS n FROM " + t).get().n;
console.log(JSON.stringify({ jobs: c("job"), stages: c("stage"), batches: c("batch"), work_items: c("work_item") }));
`) as TaskTablesRow;
}

/** helix.db 任务行/批次行明细（恢复/重试断言）。 */
export function taskRows(home: string): {
  jobs: { id: string; type: string; status: string; error: string | null }[];
  stages: { job_id: string; seq: number; status: string; artifact: string | null }[];
  batches: { id: string; job_id: string; stage_seq: number; seq: number; status: string; retry_count: number; instance_id: string | null }[];
} {
  const db = path.join(home, "helix.db");
  return runBun(`
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(db)}, { readonly: true });
console.log(JSON.stringify({
  jobs: db.query("SELECT id, type, status, error FROM job ORDER BY id").all(),
  stages: db.query("SELECT job_id, seq, status, artifact FROM stage ORDER BY job_id, seq").all(),
  batches: db.query("SELECT id, job_id, stage_seq, seq, status, retry_count, instance_id FROM batch ORDER BY job_id, stage_seq, seq").all(),
}));
`) as ReturnType<typeof taskRows>;
}

/** chat 会话剧本（E 层主链路 daemon 必填；bootstrap 链路无 chat turn——一条空收口兜底）。 */
export function idleDaemonScript(): DaemonScript {
  return { entries: [{ kind: "reply", text: "（chat 无轮次——bootstrap 链路）" }] };
}
