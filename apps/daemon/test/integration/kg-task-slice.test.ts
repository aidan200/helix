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
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { InMemorySessionRepository } from "../mocks/InMemorySessionRepository";
import { ATTACHMENT_PROTOCOL_LINE, ATTACHMENT_PROTOCOL_LINE_WORKER } from "../../src/domain/kg/attachment/render";

/**
 * I 层：任务层切片注入（T3.3，CL-1 F1.3，F-14 病根修复）。
 *
 * spawn 派发时任务文本 → extractIdentifiers + graph.search 同源匹配 →
 * digest+指针切片（≤800 token 同预算纪律）→ 拼入 task 文本；注入完成
 * markInjected 入 KgAttachmentService 会话注册表（与 T3.2 edit 附着跨通道
 * 共享）。空命中整段省略（AD-18 空段省略不占位）。
 *
 * 覆盖：①命中注入格式（CL-1.A10 前半）②跨通道去重互通 ③空命中无段
 * ④superseded 不进切片 ⑤预算硬顶贪心 ⑥SchedulerService.spawn 挂点接线。
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

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "kg-slice-it-"));
  const proj = path.join(root, "proj");
  mkdirSync(proj, { recursive: true });
  const database = new KgDatabase();
  const graph = new SqliteKnowledgeGraph({ database });
  const store = new SqliteKnowledgeStore({ database });
  const write = new KgWriteService({ store });
  const attachment = new KgAttachmentService({ graph, hasIndex: () => true });
  const query = new KgQueryService({ graph, projects: () => [proj], attachment });
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
  return r.nodeId;
}

const SLICE_HEADER = "## kg 约束切片";

describe("任务层切片注入（F1.3）", () => {
  test("① 任务文本命中实体 → task 文本含 kg 约束切片段（digest+指针+协议行，CL-1.A10 前半）", () => {
    const f = makeFixture();
    const id = seedNode(f, "handler 幂等规则", "handler 编辑必须保持幂等语义");
    const task = "实现 handler 接口的幂等重试逻辑并补测试";
    const out = f.query.injectTaskSlice("sess-A", task);
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

  test("② 跨通道去重互通：注入过登记进会话注册表（markInjected 同源）；登记过不再注入", () => {
    const f = makeFixture();
    const id = seedNode(f, "队列规则", "队列写入必须串行");
    const task = "改造队列写入路径";

    // 先注入 → 注册表可见（T3.2 attachAfterEdit 侧据此去重）
    f.query.injectTaskSlice("sess-B", task);
    expect(f.attachment.seenInSession("sess-B").has(id)).toBe(true);

    // 同会话二次派发同任务 → 已注入 id 不再重复注入（原文原样返回）
    const again = f.query.injectTaskSlice("sess-B", task);
    expect(again.indexOf(SLICE_HEADER)).toBe(-1);

    // 反向：动作层先行（T3.2 markInjected）→ 任务层注入排除该 id
    const id2 = seedNode(f, "队列读取规则", "队列读取走 WAL 快照");
    f.attachment.markInjected("sess-C", [id2]);
    const out = f.query.injectTaskSlice("sess-C", "改造队列写入与读取路径");
    expect(out).toContain(`kg get ${id}`); // 未登记 id 正常注入
    expect(out).not.toContain(`kg get ${id2}`); // 已登记 id 排除
  });

  test("③ 空命中 → 整段省略不占位（AD-18）：原文逐字节返回", () => {
    const f = makeFixture();
    seedNode(f, "无关规则", "与任务文本毫无交集的摘要");
    const task = "重构 build 脚本的输出目录布局";
    const out = f.query.injectTaskSlice("sess-D", task);
    expect(out).toBe(task);
    // 图空（新 fixture 未建任何节点）同样省略
    const f2 = makeFixture();
    expect(f2.query.injectTaskSlice("sess-D2", "任意任务文本")).toBe("任意任务文本");
  });

  test("④ superseded 节点不进切片（被推翻知识不作约束注入）", () => {
    const f = makeFixture();
    const id = seedNode(f, "旧口径规则", "已被推翻的旧口径摘要");
    const r = f.write.write(f.proj, { kind: "supersede", nodeId: id, iterationId: "iter-t33", reason: "口径更替" });
    expect(r.ok).toBe(true);
    const out = f.query.injectTaskSlice("sess-E", "按旧口径规则改造实现");
    expect(out.indexOf(SLICE_HEADER)).toBe(-1);
  });

  test("⑤ 预算硬顶（同预算纪律）：命中总量超 800 token → 贪心裁剪，切片总长不超硬顶", () => {
    const f = makeFixture();
    const names = ["alphaOne", "betaTwo", "gammaThree", "deltaFour", "epsilonFive", "zetaSix", "etaSeven", "thetaEight", "iotaNine"];
    for (const name of names) seedNode(f, `${name} 规则`, `${name} `.repeat(60).trim());
    const task = `批量改造 ${names.join(" 、")} 的实现`;
    const out = f.query.injectTaskSlice("sess-F", task);
    expect(out).toContain(SLICE_HEADER);
    const slice = out.slice(out.indexOf(SLICE_HEADER));
    const pointers = [...slice.matchAll(/kg get /g)].length;
    expect(pointers).toBeGreaterThan(0);
    expect(pointers).toBeLessThan(names.length); // 超限裁剪发生
    expect(slice.length).toBeLessThanOrEqual(800 * 4); // token 硬顶（估算=chars/4）
  });

  test("⑦ W-R6 协议行受众分叉：audience=worker → worker 版协议行；缺省 → main 版不变", () => {
    const f = makeFixture();
    seedNode(f, "限流规则", "网关限流必须按租户隔离");
    const task = "改造网关限流的租户隔离逻辑";
    // 缺省（主会话 ChatService 注入链）：main 版措辞
    const mainOut = f.query.injectTaskSlice("sess-M", task);
    expect(mainOut).toContain(ATTACHMENT_PROTOCOL_LINE);
    expect(mainOut).not.toContain(ATTACHMENT_PROTOCOL_LINE_WORKER);
    // worker（SubAgent spawn 注入链）：无 kg-update，改 closure findings 申报
    const workerOut = f.query.injectTaskSlice("sess-N", "改造网关限流的租户隔离与熔断逻辑", "worker");
    expect(workerOut).toContain(ATTACHMENT_PROTOCOL_LINE_WORKER);
    expect(workerOut).not.toContain(ATTACHMENT_PROTOCOL_LINE);
  });

  test("⑥ spawn 派发挂点（探查 A 六跳链挂点）：SchedulerService.taskInjector → task 文本携带切片", () => {
    const f = makeFixture();
    const id = seedNode(f, "支付幂等规则", "支付回调必须幂等去重");
    const events: DomainEvent[] = [];
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy(),
      runner: new NoopRunner(),
      events: { publish: (e) => void events.push(e), publishDelta: () => undefined },
      repository: new InMemorySessionRepository(),
      clock: { now: () => "2026-08-25T00:00:00.000Z", nowMs: () => Date.now() },
      stalledPollMs: 60_000,
      // 组合根同款接线：sessionId + task → KgQueryService.injectTaskSlice
      taskInjector: (sessionId, task) => f.query.injectTaskSlice(sessionId, task),
    });
    try {
      const out = scheduler.spawn("sess-G", "实现支付回调的幂等去重");
      expect(out.status).toBe("run");
      // 观测面留档的 task 已含切片（与子进程实际收到的 --task 同源）
      const status = scheduler.status().find((s) => s.agentId === (out.status === "run" ? out.agentId : ""));
      expect(status?.task).toContain(SLICE_HEADER);
      expect(status?.task).toContain(`kg get ${id}`);
      // 注入失败不阻断 spawn：注入器抛错 → 原文透传
      const scheduler2 = new SchedulerService({
        policy: new SchedulingPolicy(),
        runner: new NoopRunner(),
        events: { publish: () => undefined, publishDelta: () => undefined },
        repository: new InMemorySessionRepository(),
        clock: { now: () => "2026-08-25T00:00:00.000Z", nowMs: () => Date.now() },
        stalledPollMs: 60_000,
        taskInjector: () => {
          throw new Error("graph read fault");
        },
      });
      const out2 = scheduler2.spawn("sess-G", "普通任务文本");
      expect(out2.status).toBe("run");
      const status2 = scheduler2.status().find((s) => s.agentId === (out2.status === "run" ? out2.agentId : ""));
      expect(status2?.task).toBe("普通任务文本");
    } finally {
      scheduler.stop();
    }
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
