import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import { KgViewerService, type KgViewerServiceDeps } from "../../src/application/services/kg/KgViewerService";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION } from "@helix/protocol";
import {
  createRigScope,
  expectOk,
  ITER,
  knowledgeCounts,
  seedAlpha,
  seedBeta,
  seedGamma,
  stubAdapterDeps,
  TestClient,
  until,
} from "./helpers/kg-handlers-rig";

/**
 * kg 六命令族 I 层（T5.3，CL-5.A1~A5/A8~A10 daemon 侧；契约
 * contracts/kg-viewer-api.md 逐字段）：真 service 栈 × tmp 真库 × loopback
 * WS 路由（装配见 ./helpers/kg-handlers-rig.ts；引擎边界 = CodegraphEngineFake）。
 *
 * 覆盖：kg.projects 宽松口径扫描+排除清单+absent 不建库（A8）；
 * kg.list 三路过滤叠加+total/matched+跨项目不串（A1/A10）；
 * kg.node.detail 六段聚合（A2）；kg.change.report 四类条目（A3）；
 * kg.node.confirm 唯一写走 F2.3 API+change_log 追加+非 draft KG_E_STATE（A4）；
 * kg.index.status 四态透传+rebuild 零知识层写+absent 冷启动（A5/A9）；
 * project 两形态等价/无法解析 KG_E_PARAM（A10）；unimplemented 门控；
 * 容器接线（kgWorkspaceRoot 注入 + 真组合根 roundtrip）。
 *
 * 顺序敏感：projects/list/detail/report 先于 confirm/rebuild 变异现场。
 * （TR-AD-25 ④ 拆分：kg.health / rebuild orphanNote / candidates 面在
 * kg-handlers-health.test.ts。）
 */

const { openRig, disposeAll, rigs } = createRigScope();
afterAll(disposeAll);

describe("kg 六命令族 I 层（真 service 栈 + tmp 库 + ws 路由）", () => {
  test("kg.projects：宽松口径一层扫描 + 排除清单 + 四态行 + absent 不建库（A8）", async () => {
    const rig = await openRig();
    await seedAlpha(rig);
    seedBeta(rig);
    seedGamma(rig);
    // delta 保持 absent（无种子）

    const res = await rig.client.kg("kg.projects", {});
    expect(res.ok).toBe(true);
    const projects = res.result.projects as Record<string, unknown>[];
    // 排除清单生效：docs/.helix/.worktrees/node_modules/.hidden/文件项不入列；
    // 宽松口径：alpha/beta/gamma/delta 全入列（无工程标记要求）
    expect(projects.map((p) => p.name)).toEqual(["alpha", "beta", "delta", "gamma"]);
    const alpha = projects.find((p) => p.name === "alpha")!;
    expect(alpha.path).toBe(rig.alpha);
    expect(alpha.status).toBe("synced");
    expect(typeof alpha.symbolCount).toBe("number");
    expect(typeof alpha.nodeCount).toBe("number");
    expect(typeof alpha.syncedAt).toBe("string");
    expect(projects.find((p) => p.name === "gamma")!.status).toBe("degraded");
    expect(typeof projects.find((p) => p.name === "gamma")!.degradedNote).toBe("string");
    for (const absent of ["beta", "delta"]) {
      const row = projects.find((p) => p.name === absent)!;
      expect(row.status).toBe("absent");
      expect(row.symbolCount).toBeUndefined();
      expect(row.nodeCount).toBeUndefined();
    }
    // 只读（A8）：absent 项目不建库（读面绝不触发 KgDatabase 连接副作用；
    // beta 写路径已建库属正常——只对零触达的 delta 断言）
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(false);
  }, 15000);

  test("kg.list：三路过滤叠加 + total/matched + 跨项目不串（A1/A10 数据面）", async () => {
    const rig = rigs[0]!;
    const all = await rig.client.kg("kg.list", { project: "alpha" });
    expect(all.ok).toBe(true);
    // total=过滤前全集（6 节点：TR-1..4 + E-1/E-2）
    expect(all.result.total).toBe(6);
    expect(all.result.matched).toBe(6);
    const nodes = all.result.nodes as Record<string, unknown>[];
    const tr1 = nodes.find((n) => n.name === "分层依赖单向")!;
    // NodeListRow 逐字段（契约 §1）：id/name/kind/domain/status/digest
    expect(tr1.kind).toBe("rule");
    expect(tr1.status).toBe("confirmed");
    expect(tr1.domain).toBeNull();
    expect(tr1.digest).toBe("import 只准外层指向内层（修订版）");
    expect(typeof tr1.id).toBe("string");

    // 单路：q 命中 name/digest 子串（仅 TR-1 名含「依赖」）
    const q = await rig.client.kg("kg.list", { project: "alpha", q: "依赖" });
    expect(q.result.total).toBe(6);
    expect(q.result.matched).toBe(1);
    const qNames = (q.result.nodes as Record<string, unknown>[]).map((n) => n.name);
    expect(qNames).toEqual(["分层依赖单向"]);

    // 单路：kind=entity（E-1/E-2）
    const byKind = await rig.client.kg("kg.list", { project: "alpha", kind: "entity" });
    expect(byKind.result.matched).toBe(2);
    expect((byKind.result.nodes as Record<string, unknown>[]).every((n) => n.kind === "entity")).toBe(true);

    // 单路：status=draft（TR-2 + supersede 替换稿 TR-4——替换稿缺省 draft）
    const byStatus = await rig.client.kg("kg.list", { project: "alpha", status: "draft" });
    expect(byStatus.result.matched).toBe(2);
    expect((byStatus.result.nodes as Record<string, unknown>[]).map((n) => n.name)).toEqual(["写路径白名单", "新写路径规则"]);

    // 三路叠加：q=白名单 × kind=rule × status=draft → TR-2 唯一
    const combined = await rig.client.kg("kg.list", { project: "alpha", q: "白名单", kind: "rule", status: "draft" });
    expect(combined.result.total).toBe(6);
    expect(combined.result.matched).toBe(1);
    expect((combined.result.nodes as Record<string, unknown>[])[0]!.name).toBe("写路径白名单");

    // project 作用域（A10）：beta 只见自身节点，alpha 节点不串入
    //（beta 写路径已建库——baseline 未落 → 四态仍 absent；隔离断言取正向行集）
    const beta = await rig.client.kg("kg.list", { project: "beta" });
    expect(beta.ok).toBe(true);
    expect(beta.result.matched).toBe(1);
    expect((beta.result.nodes as Record<string, unknown>[]).map((n) => n.name)).toEqual(["beta 专属实体"]);
    // absent 项目读命令短路：delta 无库 → KG_E_NOT_FOUND（读面绝不新建库文件）
    const absentRead = await rig.client.kg("kg.list", { project: "delta" });
    expect(absentRead.ok).toBe(false);
    expect(absentRead.error!.code).toBe("KG_E_NOT_FOUND");
  }, 15000);

  test("kg.node.detail：聚合（body 原文单段/anchors dead-stale-ok/relations/supersede 链/log 最新在上）（A2）", async () => {
    const rig = rigs[0]!;
    const res = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-1" });
    expect(res.ok).toBe(true);
    const d = res.result;
    // 头部段
    expect(d.name).toBe("分层依赖单向");
    expect(d.kind).toBe("rule");
    expect(d.status).toBe("confirmed");
    // body 单段：原文直返不拆分（拆分逻辑已删除）
    expect(d.body).toBe("依赖必须单向。\n- 外层可指向内层\n- 内层禁止反向依赖");
    expect("desc" in d).toBe(false);
    expect("rules" in d).toBe(false);
    // 锚点段：TR-1 唯一符号锚（声明物化，span 起点 11）
    const anchors = d.anchors as Record<string, unknown>[];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.symbol).toBe("layerRule");
    expect(anchors[0]!.path).toBe("src/arch.ts");
    expect(anchors[0]!.line).toBe(11);
    expect(anchors[0]!.state).toBe("ok");
    // 关系段：TR-1 governs TR-2（对方节点引用可跳转）
    const relations = d.relations as { verb: string; peer: Record<string, unknown> }[];
    expect(relations).toHaveLength(1);
    expect(relations[0]!.verb).toBe("governs");
    expect(relations[0]!.peer.name).toBe("写路径白名单");
    expect(relations[0]!.peer.id).toBe("TR-2");
    expect(typeof relations[0]!.peer.digestFirstLine).toBe("string");

    // 锚态谱：TR-2 detail → dead；E-1 detail → stale（活跃度启发命中）
    const dead = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-2" });
    expect(((dead.result.anchors as Record<string, unknown>[])[0] as { state: string }).state).toBe("dead");
    const stale = await rig.client.kg("kg.node.detail", { project: "alpha", id: "E-1" });
    expect(((stale.result.anchors as Record<string, unknown>[])[0] as { state: string }).state).toBe("stale");

    // supersede 链：被取代者 TR-3 → current=新规则 TR-4，history=[TR-3]
    const old = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-3" });
    const chain = old.result.supersede as { history: Record<string, unknown>[]; current: Record<string, unknown> };
    expect(chain.current.name).toBe("新写路径规则");
    expect(chain.history.map((n) => n.name)).toEqual(["旧写路径规则"]);

    // 变更日志段：TR-3 两条（createNode → supersede），最新在上
    const log = old.result.log as { date: string; iterationId: string; eventText: string }[];
    expect(log).toHaveLength(2);
    expect(log[0]!.eventText).toBe("推翻：写路径口径已演进");
    expect(log[1]!.eventText).toBe("创建节点（新知识入库）");
    expect(log[0]!.iterationId).toBe(ITER);
    expect(log[0]!.date >= log[1]!.date).toBe(true);
    // AD-16：eventText 无 TR-/E- 裸 id
    for (const entry of log) expect(entry.eventText).not.toMatch(/TR-\d+|E-\d+/);

    // 不存在 id → KG_E_NOT_FOUND
    const missing = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-999" });
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("KG_E_NOT_FOUND");
  }, 15000);

  test("kg.change.report：四类条目结构（A3 数据面）", async () => {
    const rig = rigs[0]!;
    const res = await rig.client.kg("kg.change.report", { project: "alpha" });
    expect(res.ok).toBe(true);
    expect(res.result.iterationId as string).toBe(ITER); // 缺省 = 当前迭代（库内最近变更所属）
    const entries = res.result.entries as Record<string, unknown>[];
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds.has("dead_anchor")).toBe(true); // TR-2 write-path.ts 消亡
    expect(kinds.has("rule_conflict")).toBe(true); // E-1 ↔ E-2 双向 governs
    expect(kinds.has("suspect_stale")).toBe(true); // E-1 滞后 10 天 × 近期变更
    expect(kinds.has("knowledge_change")).toBe(true); // 五 op 全谱
    for (const e of entries) {
      expect(["warn", "info", "ok"]).toContain(e.sev as string);
      expect(typeof e.label).toBe("string");
      expect(typeof e.body).toBe("string");
      expect("options" in e).toBe(false); // 报告=通知面非审核面：无行动项字段
      const refs = e.refs as { nodes: Record<string, unknown>[]; symbols: Record<string, unknown>[] };
      for (const n of refs.nodes) {
        expect(typeof n.name).toBe("string");
        expect(typeof n.digestFirstLine).toBe("string");
      }
      for (const s of refs.symbols) expect(typeof s.path).toBe("string");
      expect(String(e.body)).not.toMatch(/TR-\d+|E-\d+/); // AD-16 无裸 id
    }
    // 显式 iterationId 形态
    const explicit = await rig.client.kg("kg.change.report", { project: "alpha", iterationId: ITER });
    expect(explicit.result.iterationId).toBe(ITER);
  }, 15000);

  test("kg.node.detail 变更日志行主锚切 task_id（P0 ④）：task 章在场下发；无迭代归属行 iterationId 下发 null", async () => {
    const rig = rigs[0]!;
    // 无迭代归属（NULL）+ 带 task 章的写入（去 v1 化后的常态形态）——置于
    // report 默认迭代断言之后（顺序敏感现场，不扰动其 latestIteration 取值）
    expectOk(
      rig.write.write(rig.alpha, {
        kind: "createNode",
        iterationId: null,
        taskId: "task-anchor-primary",
        draft: { kind: "rule", name: "无迭代归属规则", digest: "无锚摘要", scene: "测试场景", status: "confirmed" },
      }),
    );
    const res = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-5" });
    expect(res.ok).toBe(true);
    const log = res.result.log as { date: string; iterationId: string | null; taskId?: string | null; eventText: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]!.iterationId).toBe(null); // 空不展示（前端条件渲染）；非空照旧（历史行兼容）
    expect(log[0]!.taskId).toBe("task-anchor-primary"); // 主锚切 task_id
    // 历史行（有迭代无任务）照旧：iterationId 字符串 + taskId 空缺省
    const old = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-1" });
    const oldLog = old.result.log as { iterationId: string | null; taskId?: string | null }[];
    expect(oldLog[0]!.iterationId).toBe(ITER);
    expect(oldLog[0]!.taskId == null).toBe(true);
  }, 15000);

  test("kg.node.confirm：唯一写命令走 F2.3 API + change_log 追加 + 非 draft KG_E_STATE（A4）", async () => {
    const rig = rigs[0]!;
    const before = knowledgeCounts(rig, rig.alpha);
    const logBefore = rig.database
      .knowledgeConnection(rig.alpha)
      .prepare("SELECT reason FROM change_log WHERE node_id = ? ORDER BY seq")
      .all("TR-2") as { reason: string | null }[];

    const res = await rig.client.kg("kg.node.confirm", { project: "alpha", id: "TR-2" });
    expect(res.ok).toBe(true);
    expect(res.result.applied).toBe(true);
    expect((res.result.node as Record<string, unknown>).status).toBe("confirmed");

    // 唯一写路径（A4）：nodes +1 零（改状态不改行数）、edges 零变化、
    // change_log 恰 +1（审计行——F2.3 API 面的库内痕迹）
    const after = knowledgeCounts(rig, rig.alpha);
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.log).toBe(before.log + 1);
    const logAfter = rig.database
      .knowledgeConnection(rig.alpha)
      .prepare("SELECT reason FROM change_log WHERE node_id = ? ORDER BY seq")
      .all("TR-2") as { reason: string | null }[];
    expect(logAfter).toHaveLength(logBefore.length + 1);
    expect(logAfter[logAfter.length - 1]!.reason).toContain("草稿转正（页面人工确认）");

    // detail log 可见同一审计行（eventText 叙述）
    const detail = await rig.client.kg("kg.node.detail", { project: "alpha", id: "TR-2" });
    const top = (detail.result.log as { eventText: string }[])[0]!;
    expect(top.eventText).toBe("更新节点内容：草稿转正（页面人工确认）");

    // 非 draft → KG_E_STATE（confirmed 复转）
    const again = await rig.client.kg("kg.node.confirm", { project: "alpha", id: "TR-2" });
    expect(again.ok).toBe(false);
    expect(again.error!.code).toBe("KG_E_STATE");
    // superseded → 同 KG_E_STATE
    const superseded = await rig.client.kg("kg.node.confirm", { project: "alpha", id: "TR-3" });
    expect(superseded.ok).toBe(false);
    expect(superseded.error!.code).toBe("KG_E_STATE");
    // 不存在 → KG_E_NOT_FOUND
    const missing = await rig.client.kg("kg.node.confirm", { project: "alpha", id: "TR-999" });
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("KG_E_NOT_FOUND");
  }, 15000);

  test("kg.index.status：四态透传 + rebuild building + 知识层零写 + absent 冷启动（A5/A9）", async () => {
    const rig = rigs[0]!;

    // 四态之 synced/degraded（absent 见 delta；building 见下）
    const synced = await rig.client.kg("kg.index.status", { project: "alpha" });
    expect(synced.ok).toBe(true);
    expect(synced.result.state).toBe("synced");
    expect(typeof synced.result.symbolCount).toBe("number");
    expect(typeof synced.result.syncedAt).toBe("string");
    const degraded = await rig.client.kg("kg.index.status", { project: "gamma" });
    expect(degraded.result.state).toBe("degraded");
    expect(typeof degraded.result.degradedNote).toBe("string");

    // absent：delta 无库 → absent 且不建库（读面短路）
    const absent = await rig.client.kg("kg.index.status", { project: "delta" });
    expect(absent.result.state).toBe("absent");
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(false);

    // rebuild=true：触发即 building（引擎 delayMs=150×2 制造窗口；O-6 同通道
    // 并发轮询观察——rebuild 请求自身在完成后才回 synced 帧）
    const before = knowledgeCounts(rig, rig.alpha);
    const at = rig.client.frames.length;
    rig.client.fireAndForget("kg.index.status", { project: "alpha", rebuild: true });
    let sawBuilding = false;
    const t0 = Date.now();
    while (!sawBuilding && Date.now() - t0 < 3000) {
      rig.client.send({ v: PROTOCOL_VERSION, type: "kg.index.status", payload: { project: "alpha" } });
      await new Promise((r) => setTimeout(r, 30));
      sawBuilding = rig.client.frames
        .slice(at)
        .some((f) => f.type === "kg.index.status.result" && (f.payload as { state?: string }).state === "building");
    }
    expect(sawBuilding).toBe(true);
    await until(
      () =>
        rig.client.frames
          .slice(at)
          .some((f) => f.type === "kg.index.status.result" && (f.payload as { state?: string }).state === "synced"),
      5000,
      "rebuild 完成后状态回落 synced",
    );
    // 知识层零写（A5：纯 codegraph 动作——nodes/edges/change_log 全零变化）
    const after = knowledgeCounts(rig, rig.alpha);
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.log).toBe(before.log);

    // absent 冷启动（A9/B1）：delta 零触达无库 rebuild → 同一入口首次构建。
    // 构建期间无 rebuild 轮询必须回 building（修复前轮询只会回 absent）——
    // fireAndForget + 并发轮询同 alpha 段写法。（注：不断言观察时库不存在——
    // sync 管道起点 getSyncBaseline 开连接即建库，building 可观察时 kg.db 已
    // 落盘；A8 不建库面由 rebuild 前 absent 断言守护）
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(false);
    const coldAt = rig.client.frames.length;
    rig.client.fireAndForget("kg.index.status", { project: "delta", rebuild: true });
    let sawColdBuilding = false;
    const coldT0 = Date.now();
    while (!sawColdBuilding && Date.now() - coldT0 < 3000) {
      rig.client.send({ v: PROTOCOL_VERSION, type: "kg.index.status", payload: { project: "delta" } });
      await new Promise((r) => setTimeout(r, 30));
      sawColdBuilding = rig.client.frames
        .slice(coldAt)
        .some((f) => f.type === "kg.index.status.result" && (f.payload as { state?: string }).state === "building");
    }
    expect(sawColdBuilding).toBe(true);
    // 冷启动完成：rebuild 回执 synced + 库出现（不依赖 CLI 预建——引擎面即全部前置）
    await until(
      () =>
        rig.client.frames
          .slice(coldAt)
          .some((f) => f.type === "kg.index.status.result" && (f.payload as { state?: string }).state === "synced"),
      5000,
      "delta 冷启动 rebuild 完成后回执 synced",
    );
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(true);
  }, 20000);

  test("kg.index.status：building 判定先于 absent 短路（冷启动库未创建窗口）+ 纯内存不触读库", async () => {
    // 服务层直测：真栈 sync 起点 getSyncBaseline 开连接即建库（与 running
    // 同步窗口），集成面造不出「building 且 hasIndex=false」——该竞态域用
    // stub 钉死。修复前此路径回 absent（hasIndex 短路先于 building 判定）
    let getStatusCalls = 0;
    let building = true;
    const syncStub = {
      isBuilding: () => building,
      getStatus: () => {
        getStatusCalls += 1;
        throw new Error("building/absent 短路不得触 getStatus（触库连接即建库，A8）");
      },
      triggerManual: () => Promise.reject(new Error("非 rebuild 面不得触发 sync")),
    };
    const viewer = new KgViewerService({
      project: {
        resolve: () => "/proj",
        hasIndex: () => false, // 库文件尚未创建（冷启动首建窗口）
      } as unknown as KgProjectService,
      sync: syncStub,
    } as unknown as KgViewerServiceDeps);

    // 构建进行中 + 无库 → building（先于 absent 短路），且不触 getStatus
    const during = await viewer.indexStatus("proj", false);
    expect(during).toEqual({ ok: true, value: { state: "building" } });
    expect(getStatusCalls).toBe(0);

    // 无构建进行 + 无库 → absent 且不触 getStatus（A8 读面不建库不回归）
    building = false;
    const idle = await viewer.indexStatus("proj", false);
    expect(idle).toEqual({ ok: true, value: { state: "absent" } });
    expect(getStatusCalls).toBe(0);
  });

  test("project 参数两形态等价 + 无法解析 KG_E_PARAM + 错误回执结构化（A10）", async () => {
    const rig = rigs[0]!;
    // 名称形态 ≡ 绝对路径形态
    const byName = await rig.client.kg("kg.list", { project: "alpha", kind: "entity" });
    const byPath = await rig.client.kg("kg.list", { project: rig.alpha, kind: "entity" });
    expect(byPath.ok).toBe(true);
    expect(byPath.result.matched).toBe(byName.result.matched);

    // 无法解析（不在项目列表）→ KG_E_PARAM + 字段路径（结构化回执）
    const bad = await rig.client.kg("kg.list", { project: "no-such-project" });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("KG_E_PARAM");
    expect(bad.error!.message).toContain("payload.project");
    expect(bad.error!.message).toContain("no-such-project");

    // project 缺失 → KG_E_PARAM（形状校验在 handler 入口）
    const missing = await rig.client.kg("kg.list", { kind: "rule" });
    expect(missing.error!.code).toBe("KG_E_PARAM");

    // 过滤值越界 → KG_E_PARAM（service 枚举校验 + path）
    const badKind = await rig.client.kg("kg.list", { project: "alpha", kind: "dragon" });
    expect(badKind.error!.code).toBe("KG_E_PARAM");
    expect(badKind.error!.message).toContain("payload.kind");

    // rebuild 非法类型 → KG_E_PARAM
    const badRebuild = await rig.client.kg("kg.index.status", { project: "alpha", rebuild: "yes" });
    expect(badRebuild.error!.code).toBe("KG_E_PARAM");
  }, 15000);

  test("unimplemented 门控：kg 栈未装配六命令回 command.unimplemented（不崩溃）", async () => {
    const events = new EventStream();
    const adapter = new WsServerAdapter({ ...stubAdapterDeps(events) }); // 无 kg 面
    const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kg-it-token", protocolVersion: PROTOCOL_VERSION } });
      await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
      for (const type of [
        "kg.projects",
        "kg.list",
        "kg.node.detail",
        "kg.change.report",
        "kg.node.confirm",
        "kg.index.status",
      ]) {
        const res = await client.kg(type, { project: "x", id: "TR-1" });
        expect(res.ok).toBe(false);
        expect(res.error!.code).toBe("command.unimplemented");
        expect(res.error!.message).toContain(type); // 回执文案含命令名（commandError 通则）
      }
    } finally {
      adapter.stop();
      await client.close();
    }
  }, 15000);

  test("容器接线：kgWorkspaceRoot 注入 + 真组合根 kg.projects roundtrip", async () => {
    // 独立 workspace：若 kgWorkspaceRoot 接线失效（回落 process.cwd()），
    // kg.projects 会列出 daemon 测试 cwd 的真实目录而非 [kappa]——注入面断言。
    const workspace = mkdtempSync(path.join(tmpdir(), "helix-kg-container-"));
    mkdirSync(path.join(workspace, "kappa"), { recursive: true });
    mkdirSync(path.join(workspace, "docs"), { recursive: true });
    const home = mkdtempSync(path.join(tmpdir(), "helix-kg-container-home-"));
    const daemon = await createTestDaemon({
      home,
      engine: new FakeAgentEngine({ initialModel: "anthropic/claude-sonnet-4-5", replies: [] }),
      skipConfig: true,
      skipLock: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      kgWorkspaceRoot: workspace,
    });
    const client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
    try {
      await client.open();
      const token = readFileSync(path.join(home, "dev-token"), "utf8");
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
      await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
      const res = await client.kg("kg.projects", {});
      expect(res.ok).toBe(true);
      expect((res.result.projects as Record<string, unknown>[]).map((p) => p.name)).toEqual(["kappa"]);
      expect((res.result.projects as Record<string, unknown>[])[0]!.status).toBe("absent");
    } finally {
      await client.close();
      await daemon.shutdown();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

// ── kg.health（W2-E 轨一结构体检看板；设计 D5 + R15；五项读面只读聚合） ──
