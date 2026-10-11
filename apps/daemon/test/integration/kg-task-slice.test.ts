import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgAttachmentService } from "../../src/application/services/kg/KgAttachmentService";
import { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import type { InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";
import type { NodeDigestRow } from "../../src/domain/kg/types";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import { ATTACHMENT_PROTOCOL_LINE, ATTACHMENT_PROTOCOL_LINE_WORKER } from "../../src/domain/kg/attachment/render";
import { seenKeyOf } from "../../src/domain/kg/attachment/budget";

/**
 * I 层：任务层切片注入（T3.3，CL-1 F1.3，F-14 病根修复；检索语义化批双轨）。
 *
 * spawn 派发时任务文本 → 关键词轨（extractIdentifiers + graph.search 同源
 * 匹配）∪ 向量轨（语义召回 top-K 且 ≥ 阈值，fake embedding 注入保确定性）
 * → digest+指针切片（≤800 token 同预算纪律）→ 拼入 task 文本；注入完成
 * markInjected 入 KgAttachmentService 会话注册表（与 T3.2 edit 附着跨通道
 * 共享）。空命中整段省略（AD-18 空段省略不占位）。
 *
 * 覆盖：①命中注入格式（CL-1.A10 前半）②跨通道去重互通 ③空命中无段
 * ④superseded 不进切片 ⑤预算硬顶贪心 ⑥SchedulerService.spawn 挂点接线
 * ⑦协议行受众分叉 ⑧F3 键空间归一 ⑨空足迹不注入 ⑩足迹收窄（U7 并轨）；
 * 双轨：⑪并集排序 ⑫同节点去重置关键词轨位 ⑬三路降级逐字节一致
 * ⑭排除作用于语义轨 ⑮预算对语义轨同效。
 */

interface Fixture {
  readonly root: string;
  readonly proj: string;
  readonly database: KgDatabase;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
  readonly attachment: KgAttachmentService;
  readonly query: KgQueryService;
}

const fixtures: Fixture[] = [];

afterAll(() => {
  for (const f of fixtures) {
    f.database.closeAll();
    rmSync(f.root, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

/** 语义召回替身（fake embedding 注入保确定性——命中序由 score 显式供给）。 */
type SemanticHitLike = { project: string; row: NodeDigestRow; score: number };
type SemanticFake = (queryText: string, projects: readonly string[]) => Promise<readonly SemanticHitLike[]>;

function makeFixture(semantic?: SemanticFake): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "kg-slice-it-"));
  const proj = path.join(root, "proj");
  mkdirSync(proj, { recursive: true });
  const database = new KgDatabase();
  const graph = new SqliteKnowledgeGraph({ database });
  const store = new SqliteKnowledgeStore({ database });
  const write = new KgWriteService({ store });
  const attachment = new KgAttachmentService({ graph, hasIndex: () => true });
  const query = new KgQueryService({
    graph,
    projects: () => [proj],
    attachment,
    ...(semantic !== undefined ? { semantic } : {}),
  });
  const f: Fixture = { root, proj, database, graph, write, attachment, query };
  fixtures.push(f);
  return f;
}

function seedNode(f: Fixture, name: string, digest: string): string {
  const r = f.write.write(f.proj, {
    kind: "createNode",
    iterationId: "iter-t33",
    draft: { kind: "rule", name, digest, scene: "测试场景" },
  });
  if (!r.ok) throw new Error(`种子建节点失败：${r.error.message}`);
  if (r.nodeId === undefined) throw new Error("ok 结果缺 nodeId（意外形态）");
  return r.nodeId;
}

/** 语义轨命中行替身（与种子内容同形——渲染面无需真向量）。 */
function fakeRow(id: string, name: string, digest: string, status: NodeDigestRow["status"] = "confirmed"): NodeDigestRow {
  return { id, kind: "rule", name, digest, scene: "测试场景", status, domain: null };
}

const SLICE_HEADER = "## kg 约束切片";

/** 切片段内指针出现序（双轨排序断言数据源）。 */
function pointerOrder(out: string): string[] {
  return [...out.matchAll(/kg get (TR-\d+)/g)].map((m) => m[1]!);
}

describe("任务层切片注入（F1.3）", () => {
  test("① 任务文本命中实体 → task 文本含 kg 约束切片段（digest+指针+协议行，CL-1.A10 前半）", async () => {
    const f = makeFixture();
    const id = seedNode(f, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    const task = "实现 handler 接口的幂等重试逻辑并补测试";
    const out = await f.query.injectTaskSlice("sess-A", task, "main", [f.proj]);
    // 原文保留 + 切片段追加
    expect(out.startsWith(task)).toBe(true);
    expect(out.length).toBeGreaterThan(task.length);
    expect(out).toContain(SLICE_HEADER);
    expect(out).toContain("handler 编辑必须保持幂等语义"); // digest
    expect(out).toContain("**handler 幂等规则** [rule]"); // name+kind 引用规范（AD-16）
    expect(out).toContain(`kg get ${id}`); // 指针
    expect(out).toContain(ATTACHMENT_PROTOCOL_LINE); // 协议行（AD-14）
    // 切片在文本尾部（约束区语义：追加段）
    expect(out.indexOf(SLICE_HEADER)).toBeGreaterThan(task.length);
  });

  test("② 跨通道去重互通：注入过登记进会话注册表（markInjected 同源）；登记过不再注入", async () => {
    const f = makeFixture();
    const id = seedNode(f, "队列规则", "队列写入必须串行");
    const task = "改造队列写入路径";

    // 先注入 → 注册表可见（T3.2 attachAfterEdit 侧据此去重；复合键口径，F3）
    await f.query.injectTaskSlice("sess-B", task, "main", [f.proj]);
    expect(f.attachment.seenInSession("sess-B").has(seenKeyOf(f.proj, id))).toBe(true);

    // 同会话二次派发同任务 → 已注入节点不再重复注入（原文原样返回）
    const again = await f.query.injectTaskSlice("sess-B", task, "main", [f.proj]);
    expect(again.indexOf(SLICE_HEADER)).toBe(-1);

    // 反向：动作层先行（T3.2 markInjected）→ 任务层注入排除该节点
    const id2 = seedNode(f, "队列读取规则", "队列读取走 WAL 快照");
    f.attachment.markInjected("sess-C", [{ project: f.proj, nodeId: id2 }]);
    const out = await f.query.injectTaskSlice("sess-C", "改造队列写入与读取路径", "main", [f.proj]);
    expect(out).toContain(`kg get ${id}`); // 未登记 id 正常注入
    expect(out).not.toContain(`kg get ${id2}`); // 已登记 id 排除
  });

  test("③ 空命中 → 整段省略不占位（AD-18）：原文逐字节返回", async () => {
    const f = makeFixture();
    seedNode(f, "无关规则", "与任务文本毫无交集的摘要");
    const task = "重构 build 脚本的输出目录布局";
    const out = await f.query.injectTaskSlice("sess-D", task, "main", [f.proj]);
    expect(out).toBe(task);
    // 图空（新 fixture 未建任何节点）同样省略
    const f2 = makeFixture();
    expect(await f2.query.injectTaskSlice("sess-D2", "任意任务文本", "main", [f2.proj])).toBe("任意任务文本");
  });

  test("④ superseded 节点不进切片（被推翻知识不作约束注入）", async () => {
    const f = makeFixture();
    const id = seedNode(f, "旧口径规则", "已被推翻的旧口径摘要");
    const r = f.write.write(f.proj, { kind: "supersede", nodeId: id, iterationId: "iter-t33", reason: "口径更替" });
    expect(r.ok).toBe(true);
    const out = await f.query.injectTaskSlice("sess-E", "按旧口径规则改造实现", "main", [f.proj]);
    expect(out.indexOf(SLICE_HEADER)).toBe(-1);
  });

  test("⑤ 预算硬顶（同预算纪律）：命中总量超 800 token → 贪心裁剪，切片总长不超硬顶", async () => {
    const f = makeFixture();
    const names = ["alphaOne", "betaTwo", "gammaThree", "deltaFour", "epsilonFive", "zetaSix", "etaSeven", "thetaEight", "iotaNine"];
    for (const name of names) seedNode(f, `${name} 规则`, `${name} `.repeat(60).trim());
    const task = `批量改造 ${names.join(" 、")} 的实现`;
    const out = await f.query.injectTaskSlice("sess-F", task, "main", [f.proj]);
    expect(out).toContain(SLICE_HEADER);
    const slice = out.slice(out.indexOf(SLICE_HEADER));
    const pointers = [...slice.matchAll(/kg get /g)].length;
    expect(pointers).toBeGreaterThan(0);
    expect(pointers).toBeLessThan(names.length); // 超限裁剪发生
    expect(slice.length).toBeLessThanOrEqual(800 * 4); // token 硬顶（估算=chars/4）
  });

  test("⑦ W-R6 协议行受众分叉：audience=worker → worker 版协议行；main → main 版不变", async () => {
    const f = makeFixture();
    seedNode(f, "限流规则", "网关限流必须按租户隔离");
    const task = "改造网关限流的租户隔离逻辑";
    // main（主会话 ChatService 注入链）：main 版措辞
    const mainOut = await f.query.injectTaskSlice("sess-M", task, "main", [f.proj]);
    expect(mainOut).toContain(ATTACHMENT_PROTOCOL_LINE);
    expect(mainOut).not.toContain(ATTACHMENT_PROTOCOL_LINE_WORKER);
    // worker（SubAgent spawn 注入链）：无 kg-update，改 findings 文件申报
    const workerOut = await f.query.injectTaskSlice("sess-N", "改造网关限流的租户隔离与熔断逻辑", "worker", [f.proj]);
    expect(workerOut).toContain(ATTACHMENT_PROTOCOL_LINE_WORKER);
    expect(workerOut).not.toContain(ATTACHMENT_PROTOCOL_LINE);
  });

  test("⑧ F3 键空间归一：多项目同 id 节点互不静默排除（项目 A 已注入 TR-n 不排项目 B 同 id 节点）", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-slice-mp-it-"));
    const projA = path.join(root, "projA");
    const projB = path.join(root, "projB");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    const database = new KgDatabase();
    const graph = new SqliteKnowledgeGraph({ database });
    const store = new SqliteKnowledgeStore({ database });
    const write = new KgWriteService({ store });
    const attachment = new KgAttachmentService({ graph, hasIndex: () => true });
    const query = new KgQueryService({ graph, projects: () => [projA, projB], attachment });
    fixtures.push({ root, proj: projA, database, graph, write, attachment, query });
    // 两项目各种入首个 rule 节点——各项目 id 空间独立发号，结构性同 id（TR-1）
    const seedIn = (proj: string): string => {
      const r = write.write(proj, {
        kind: "createNode",
        iterationId: "iter-t33",
        draft: { kind: "rule", name: "队列规则", digest: "队列写入必须串行", scene: "测试场景" },
      });
      if (!r.ok) throw new Error(`种子建节点失败：${r.error.message}`);
      if (r.nodeId === undefined) throw new Error("ok 结果缺 nodeId（意外形态）");
      return r.nodeId;
    };
    const idA = seedIn(projA);
    const idB = seedIn(projB);
    expect(idA).toBe(idB); // 结构性前提钉死：跨项目 id 碰撞必然（受害链起点）

    // 项目 A 节点已到达（复合键登记）→ 项目 B 同 id 节点必须照常注入（裸 id 键空间下会被静默误排）
    attachment.markInjected("sess-MP", [{ project: projA, nodeId: idA }]);
    const out = await query.injectTaskSlice("sess-MP", "改造队列写入路径", "main", [projA, projB]);
    expect(out).toContain(SLICE_HEADER);
    expect(out).toContain(`kg get ${idB}（project: projB）`); // 多项目指针尾注（renderEntry multiProject 形态）
    expect(out).not.toContain(`kg get ${idA}（project: projA）`);
    // 反向同型：项目 B 已到达不排项目 A（对称键空间）
    attachment.markInjected("sess-MP2", [{ project: projB, nodeId: idB }]);
    const out2 = await query.injectTaskSlice("sess-MP2", "改造队列写入路径", "main", [projA, projB]);
    expect(out2).toContain(`kg get ${idA}（project: projA）`);
  });

  test("⑨ U7 并轨：空足迹 → 原文透传不注入（感知不到项目时不注入，不猜项目）", async () => {
    const f = makeFixture();
    seedNode(f, "队列规则", "队列写入必须串行");
    const task = "改造队列写入路径";
    // 任务文本明明命中，但会话零足迹 → 不注入（「感知不到项目时的默认行为，
    // 不该比注入错误项目规则更差」——residentRulesSection 同口径）
    expect(await f.query.injectTaskSlice("sess-F0", task, "main", [])).toBe(task);
    // 足迹指向 workspace 外/未建图谱项目 → 过滤后项目集空，同样不注入
    expect(await f.query.injectTaskSlice("sess-F1", task, "main", [path.join(f.root, "nonexistent")])).toBe(task);
  });

  test("⑩ U7 并轨：足迹收窄——多项目 workspace 只注入足迹内项目的命中节点", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-slice-fp-it-"));
    const projA = path.join(root, "projA");
    const projB = path.join(root, "projB");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    const database = new KgDatabase();
    const graph = new SqliteKnowledgeGraph({ database });
    const store = new SqliteKnowledgeStore({ database });
    const write = new KgWriteService({ store });
    const attachment = new KgAttachmentService({ graph, hasIndex: () => true });
    const query = new KgQueryService({ graph, projects: () => [projA, projB], attachment });
    fixtures.push({ root, proj: projA, database, graph, write, attachment, query });
    const seedIn = (proj: string, name: string): string => {
      const r = write.write(proj, {
        kind: "createNode",
        iterationId: "iter-t33",
        draft: { kind: "rule", name, digest: `${name}摘要`, scene: "测试场景" },
      });
      if (!r.ok) throw new Error(`种子建节点失败：${r.error.message}`);
      if (r.nodeId === undefined) throw new Error("ok 结果缺 nodeId（意外形态）");
      return r.nodeId;
    };
    const idA = seedIn(projA, "会话规则");
    const idB = seedIn(projB, "会话规则");
    // 足迹只含 projA → 两项目同词命中，仅 projA 节点进切片
    //（两项目同 id 同名为结构性前提——以 project 尾注有无判别来源项目）
    const out = await query.injectTaskSlice("sess-FP", "改造会话恢复链路", "main", [projA]);
    expect(out).toContain(SLICE_HEADER);
    expect(out).toContain(`kg get ${idA}`);
    expect(out).not.toContain("projB"); // projB 节点/尾注均不出现
    // 对称：足迹只含 projB
    const outB = await query.injectTaskSlice("sess-FP2", "改造会话恢复链路", "main", [projB]);
    expect(outB).toContain(`kg get ${idB}`);
    expect(outB).not.toContain("projA");
  });

  test("⑥ spawn 派发挂点（探查 A 六跳链挂点）：SchedulerService.taskInjector → task 文本携带切片", async () => {
    const f = makeFixture();
    const id = seedNode(f, "支付幂等规则", "支付回调必须幂等去重");
    const events: DomainEvent[] = [];
    const scheduler = new SchedulerService({
      policy: () => new SchedulingPolicy(),
      runner: new NoopRunner(),
      events: { publish: (e) => void events.push(e), publishDelta: () => undefined },
      repository: new InMemorySessionRepository(),
      clock: { now: () => "2026-08-25T00:00:00.000Z", nowMs: () => Date.now() },
      stalledPollMs: 60_000,
      // 组合根同款接线：sessionId + task → KgQueryService.injectTaskSlice
      taskInjector: (sessionId, task) => f.query.injectTaskSlice(sessionId, task, "worker", [f.proj]),
    });
    try {
      const out = await scheduler.spawn("sess-G", "实现支付回调的幂等去重");
      expect(out.status).toBe("run");
      // 观测面留档的 task 已含切片（与子进程实际收到的 --task 同源）
      const status = scheduler.status().find((s) => s.agentId === (out.status === "run" ? out.agentId : ""));
      expect(status?.task).toContain(SLICE_HEADER);
      expect(status?.task).toContain(`kg get ${id}`);
      // 注入失败不阻断 spawn：注入器抛错 → 原文透传
      const scheduler2 = new SchedulerService({
        policy: () => new SchedulingPolicy(),
        runner: new NoopRunner(),
        events: { publish: () => undefined, publishDelta: () => undefined },
        repository: new InMemorySessionRepository(),
        clock: { now: () => "2026-08-25T00:00:00.000Z", nowMs: () => Date.now() },
        stalledPollMs: 60_000,
        taskInjector: () => {
          throw new Error("graph read fault");
        },
      });
      const out2 = await scheduler2.spawn("sess-G", "普通任务文本");
      expect(out2.status).toBe("run");
      const status2 = scheduler2.status().find((s) => s.agentId === (out2.status === "run" ? out2.agentId : ""));
      expect(status2?.task).toBe("普通任务文本");
    } finally {
      scheduler.stop();
    }
  });
});

describe("任务切片注入双轨并集（语义轨，检索语义化批）", () => {
  test("⑪ 并集排序：关键词轨原序在前，向量轨新命中按相似度降序追加在后", async () => {
    const f = makeFixture(async () => [
      // 故意乱序供给——服务契约已按 score 降序，替身模拟最终命中序
      { project: f.proj, row: fakeRow("TR-101", "重试语义规则", "重试必须按语义退避"), score: 0.9 },
      { project: f.proj, row: fakeRow("TR-102", "缓存语义规则", "缓存失效必须按语义判定"), score: 0.7 },
    ]);
    const k1 = seedNode(f, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    const k2 = seedNode(f, "handler 超时规则", "handler 超时必须断路");
    const task = "实现 handler 接口的幂等重试逻辑";
    // 双轨注入
    const dual = await f.query.injectTaskSlice("sess-S1", task, "main", [f.proj]);
    const dualOrder = pointerOrder(dual);
    // 关键词轨原序在前（k1、k2 按词条出现序）
    expect(dualOrder.indexOf(k1)).toBeGreaterThanOrEqual(0);
    expect(dualOrder.indexOf(k2)).toBeGreaterThanOrEqual(0);
    expect(dualOrder.indexOf(k1)).toBeLessThan(dualOrder.indexOf(k2));
    // 向量轨新命中按 score 降序追加在后
    expect(dualOrder.indexOf(k2)).toBeLessThan(dualOrder.indexOf("TR-101"));
    expect(dualOrder.indexOf("TR-101")).toBeLessThan(dualOrder.indexOf("TR-102"));
    // 双轨命中都渲染 digest+指针
    expect(dual).toContain("重试必须按语义退避");
    // 关键词命中序不变（与纯关键词轨同 fixture 对照——指针序前缀等价）
    const keywordOnlyOrder = [k1, k2];
    expect(dualOrder.slice(0, keywordOnlyOrder.length)).toEqual(keywordOnlyOrder);
  });

  test("⑫ 两轨同节点去重后置关键词轨位（关键词序不变）", async () => {
    const f = makeFixture(async () => []);
    const k1 = seedNode(f, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    seedNode(f, "无关规则", "毫无交集的摘要");
    // 语义轨命中 = k1（关键词轨已命中）+ 语义独占节点（score 更高）
    const semantic: SemanticFake = async () => [
      { project: f.proj, row: fakeRow("TR-99", "语义独占规则", "用词不一致但语义相关"), score: 0.95 },
      { project: f.proj, row: fakeRow(k1, "handler 幂等规则", "handler 编辑必须保持幂等语义"), score: 0.99 },
    ];
    const query = new KgQueryService({
      graph: f.graph,
      projects: () => [f.proj],
      attachment: f.attachment,
      semantic,
    });
    const out = await query.injectTaskSlice("sess-S2", "实现 handler 接口的幂等重试逻辑", "main", [f.proj]);
    const order = pointerOrder(out);
    // k1 只出现一次，且在关键词轨位（先于语义独占节点——即便其 score 更低）
    expect(order.filter((p) => p === k1)).toHaveLength(1);
    expect(order.indexOf(k1)).toBeLessThan(order.indexOf("TR-99"));
  });

  test("⑬ 三路降级逐字节一致：语义缺席/召回空集/召回抛错 → 与纯关键词轨输出全等", async () => {
    const task = "实现 handler 接口的幂等重试逻辑";
    // 基准：纯关键词轨（无 semantic dep）
    const base = makeFixture();
    const id = seedNode(base, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    const baseline = await base.query.injectTaskSlice("sess-D1", task, "main", [base.proj]);
    expect(baseline).toContain(`kg get ${id}`);
    // ① 语义召回空集（端点缺失/超时/嵌入失败的服务层结局）
    const empty = makeFixture(async () => []);
    seedNode(empty, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    expect(await empty.query.injectTaskSlice("sess-D1", task, "main", [empty.proj])).toBe(baseline);
    // ② 语义召回抛错 → 吞错降级
    const broken = makeFixture(async () => {
      throw new Error("embedding endpoint 500");
    });
    seedNode(broken, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    expect(await broken.query.injectTaskSlice("sess-D1", task, "main", [broken.proj])).toBe(baseline);
    // ③ 语义 dep 缺席（未装配）→ 原行为
    const absent = makeFixture();
    seedNode(absent, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    expect(await absent.query.injectTaskSlice("sess-D1", task, "main", [absent.proj])).toBe(baseline);
  });

  test("⑭ 会话已到达/superseded 排除对语义轨同效（既有排除统一作用于并集）", async () => {
    const f = makeFixture(async () => []);
    const semantic: SemanticFake = async () => [
      { project: f.proj, row: fakeRow("TR-201", "已到达语义规则", "已到达节点语义命中"), score: 0.9 },
      { project: f.proj, row: fakeRow("TR-202", "被推翻语义规则", "被推翻节点语义命中", "superseded"), score: 0.8 },
      { project: f.proj, row: fakeRow("TR-203", "正常语义规则", "正常节点语义命中"), score: 0.7 },
    ];
    const query = new KgQueryService({ graph: f.graph, projects: () => [f.proj], attachment: f.attachment, semantic });
    f.attachment.markInjected("sess-S4", [{ project: f.proj, nodeId: "TR-201" }]); // 已到达
    const out = await query.injectTaskSlice("sess-S4", "与三个语义节点都相关的任务", "main", [f.proj]);
    expect(out).not.toContain("kg get TR-201"); // 会话已到达排除
    expect(out).not.toContain("kg get TR-202"); // superseded 排除
    expect(out).toContain("kg get TR-203");
  });

  test("⑮ 预算 800 装入语义不变：语义轨超限让位不回填，切片总长不超硬顶", async () => {
    const f = makeFixture(async () => [
      { project: f.proj, row: fakeRow("TR-301", "语义超大规则", "语义命中摘要".repeat(200)), score: 0.9 },
    ]);
    const names = ["alphaOne", "betaTwo", "gammaThree", "deltaFour", "epsilonFive", "zetaSix", "etaSeven", "thetaEight", "iotaNine"];
    for (const name of names) seedNode(f, `${name} 规则`, `${name} `.repeat(60).trim());
    const task = `批量改造 ${names.join(" 、")} 的实现`;
    const out = await f.query.injectTaskSlice("sess-S5", task, "main", [f.proj]);
    const slice = out.slice(out.indexOf(SLICE_HEADER));
    expect(slice.length).toBeLessThanOrEqual(800 * 4); // 预算语义不变（语义轨同受硬顶）
    // 关键词轨优先装入——语义超大条目让位（不回填）
    expect(out).not.toContain("kg get TR-301");
  });
});

/** 最小 runner 替身（launch 空操作——本测试不驱动执行）。 */
class NoopRunner implements InstanceRunner {
  setCallbacks(_callbacks: InstanceRunnerCallbacks): void {
    /* 空操作 */
  }
  launch(_instance: { instanceId: string }, _task: string): void {
    /* 空操作 */
  }
}
