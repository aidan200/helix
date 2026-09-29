import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import { PROTOCOL_VERSION } from "@helix/protocol";
import {
  createRigScope,
  expectOk,
  ITER,
  seedAlpha,
  seedBeta,
  stubAdapterDeps,
  TestClient,
  until,
} from "./helpers/kg-handlers-rig";

/**
 * kg 体检/候选面 I 层（kg-handlers.test.ts 同 rig；TR-AD-25 ④ 拆分面）：
 * kg.health 五面聚合与空态/门控（W2-D 体检看板数据源）；
 * kg.index.status rebuild 随行 orphanNote（R14）；
 * kg.candidates.list 行字段/过滤/分页与防御径。
 */

const { openRig, disposeAll, rigs } = createRigScope();
afterAll(disposeAll);

describe("kg.health I 层（真 service 栈 + tmp 库 + ws 路由）", () => {
  test("有问题径：conflicts/orphans/orphanCount/index/candidates 五面聚合 + summary 人读无裸 id", async () => {
    const rig = await openRig();
    await seedAlpha(rig);
    // candidates 台账种子：3 提案 → 1 deferred + 1 applied（计数来自 candidates 表）
    expectOk(
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选甲", body: "正文甲" }),
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选乙", body: "正文乙" }),
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选丙", body: "正文丙" }),
    );
    expectOk(
      rig.write.write(rig.alpha, { kind: "decideCandidate", iterationId: ITER, candidateId: "CAND-2", decision: "deferred" }),
      rig.write.write(rig.alpha, { kind: "decideCandidate", iterationId: ITER, candidateId: "CAND-3", decision: "applied", formalId: "TR-88", appliedNodeId: "TR-1" }),
    );

    const res = await rig.client.kg("kg.health", { project: "alpha" });
    expect(res.ok).toBe(true);
    // ① conflicts：E-1 ↔ E-2 双向 governs（种子唯一冲突对）
    const conflicts = res.result.conflicts as { kind: string; summary: string }[];
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("mutual_governs");
    expect(conflicts[0]!.summary).toContain("会话实体");
    expect(conflicts[0]!.summary).toContain("写路径守护乙");
    // ② orphans：TR-2 死锚（write-path.ts 消亡）+ E-2 有边无锚无声明
    // （unanchored_node——冲突对乙实体恰好是孤立无锚形态）；TR-3 superseded
    // 留史节点不再列（orphan_node 口径 superseded 对称豁免——CAND-3，与
    // dead_anchor 同规）；orphanCount = 清单长度
    const orphans = res.result.orphans as { kind: string; summary: string }[];
    expect(orphans).toHaveLength(2);
    expect(orphans[0]!.kind).toBe("dead_anchor");
    expect(orphans[0]!.summary).toContain("写路径白名单");
    expect(orphans[1]!.kind).toBe("unanchored_node");
    expect(orphans[1]!.summary).toContain("写路径守护乙");
    expect(res.result.orphanCount).toBe(2);
    // AD-16：summary 人读叙述无裸 id
    for (const c of conflicts) expect(c.summary).not.toMatch(/TR-\d+|E-\d+/);
    for (const o of orphans) expect(o.summary).not.toMatch(/TR-\d+|E-\d+/);
    // ③ index：kg.index.status 数据复用（alpha 已同步）
    const index = res.result.index as Record<string, unknown>;
    expect(index.state).toBe("synced");
    expect(typeof index.symbolCount).toBe("number");
    // ④ candidates：四态计数来自 candidates 表（pending 1 / deferred 1 / applied 1）
    expect(res.result.candidates).toEqual({ pending: 1, deferred: 1, applied: 1, discarded: 0 });
  }, 15000);

  // ── P3：拆栏三字段帧级断言（TR-159：deadAnchors/unanchoredNodes/drafts 漏拷即红） ──

  test("P3：拆栏三字段帧级断言（deadAnchors/unanchoredNodes/drafts 显式透传）+ 兼旧字段不变", async () => {
    const rig = await openRig();
    await seedAlpha(rig);

    const res = await rig.client.kg("kg.health", { project: "alpha" });
    expect(res.ok).toBe(true);
    // ① deadAnchors：TR-2 死锚拆栏投影（write-path.ts 消亡）
    const dead = res.result.deadAnchors as { kind: string; summary: string }[];
    expect(dead).toHaveLength(1);
    expect(dead[0]!.kind).toBe("dead_anchor");
    expect(dead[0]!.summary).toContain("写路径白名单");
    // ② unanchoredNodes：orphan_node + unanchored_node 合并（alpha 种子 = E-2 有边无锚无声明）
    const unanchored = res.result.unanchoredNodes as { kind: string; summary: string }[];
    expect(unanchored).toHaveLength(1);
    expect(unanchored[0]!.kind).toBe("unanchored_node");
    expect(unanchored[0]!.summary).toContain("写路径守护乙");
    // ③ drafts：TR-2（draft + 全死锚 → anchor-debt）+ TR-4（supersede replacement 草稿无锚 → anchor-debt）
    const drafts = res.result.drafts as { kind: string; summary: string; ageDays: number | null }[];
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.kind === "anchor-debt")).toBe(true);
    expect(drafts[0]!.summary).toContain("写路径白名单"); // TR-2（id 序在前）
    expect(drafts[0]!.summary).toContain("挂锚");
    expect(drafts[1]!.summary).toContain("新写路径规则"); // TR-4
    expect(drafts.every((d) => typeof d.ageDays === "number")).toBe(true); // 落账时间可解析 → 天数
    // ④ 兼旧：orphans/orphanCount 原口径不变（拆栏为增量可选字段，旧消费端零影响）
    expect(res.result.orphans).toHaveLength(2);
    expect(res.result.orphanCount).toBe(2);
    // ⑤ 健康空态（epsilon：confirmed 节点 + 锚声明）→ drafts 空集（非 draft 不列）
    const epsilon = path.join(rig.workspace, "epsilon");
    mkdirSync(epsilon, { recursive: true });
    expectOk(
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "甲规则", digest: "d1", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "乙实体", digest: "d2", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "declareAnchors", iterationId: ITER, nodeId: "TR-1", anchors: [{ scopeKind: "global" }] }),
      rig.write.write(epsilon, { kind: "declareAnchors", iterationId: ITER, nodeId: "E-1", anchors: [{ scopeKind: "global" }] }),
    );
    const healthy = await rig.client.kg("kg.health", { project: "epsilon" });
    expect(healthy.ok).toBe(true);
    expect(healthy.result.drafts).toEqual([]);
    expect(healthy.result.deadAnchors).toEqual([]);
    expect(healthy.result.unanchoredNodes).toEqual([]);
  }, 15000);

  test("无问题径：结构健康空态 + absent 短路空态不建库 + project 无法解析 KG_E_PARAM", async () => {
    const rig = await openRig();
    // epsilon：两节点 + 一条边 + 双方锚声明（有边有锚非孤儿非无锚、无冲突、
    // 无候选——健康空态载体；锚声明缺位会被 unanchored_node 口径检出）
    const epsilon = path.join(rig.workspace, "epsilon");
    mkdirSync(epsilon, { recursive: true });
    expectOk(
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "甲规则", digest: "d1", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "乙实体", digest: "d2", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "addEdge", iterationId: ITER, srcId: "TR-1", verb: "governs", dstId: "E-1" }),
      rig.write.write(epsilon, { kind: "declareAnchors", iterationId: ITER, nodeId: "TR-1", anchors: [{ scopeKind: "global" }] }),
      rig.write.write(epsilon, { kind: "declareAnchors", iterationId: ITER, nodeId: "E-1", anchors: [{ scopeKind: "global" }] }),
    );
    const healthy = await rig.client.kg("kg.health", { project: "epsilon" });
    expect(healthy.ok).toBe(true);
    expect(healthy.result.conflicts).toEqual([]);
    expect(healthy.result.orphans).toEqual([]);
    expect(healthy.result.orphanCount).toBe(0);
    expect(healthy.result.candidates).toEqual({ pending: 0, deferred: 0, applied: 0, discarded: 0 });
    expect(typeof (healthy.result.index as Record<string, unknown>).state).toBe("string");

    // absent 短路：delta 零触达 → 空态（非报错）+ index.state=absent + 不建库
    const absent = await rig.client.kg("kg.health", { project: "delta" });
    expect(absent.ok).toBe(true);
    expect(absent.result.conflicts).toEqual([]);
    expect(absent.result.orphans).toEqual([]);
    expect(absent.result.orphanCount).toBe(0);
    expect((absent.result.index as Record<string, unknown>).state).toBe("absent");
    expect(absent.result.candidates).toEqual({ pending: 0, deferred: 0, applied: 0, discarded: 0 });
    expect(existsSync(path.join(rig.delta, ".helix-kg", "kg.db"))).toBe(false);

    // project 无法解析 → KG_E_PARAM（service 单点解析错误模型同族）
    const bad = await rig.client.kg("kg.health", { project: "no-such-project" });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("KG_E_PARAM");
    // project 缺失 → KG_E_PARAM（handler 形状校验）
    const missing = await rig.client.kg("kg.health", {});
    expect(missing.error!.code).toBe("KG_E_PARAM");
  }, 15000);

  test("unimplemented 门控：kg 栈未装配 kg.health 回 command.unimplemented（不崩溃）", async () => {
    const events = new EventStream();
    const adapter = new WsServerAdapter({ ...stubAdapterDeps(events) }); // 无 kg 面
    const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kg-it-token", protocolVersion: PROTOCOL_VERSION } });
      await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
      const res = await client.kg("kg.health", { project: "x" });
      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("command.unimplemented");
    } finally {
      adapter.stop();
      await client.close();
    }
  }, 15000);
});

// ── W2-D R14：手动 sync 后 orphan>0 随行体检提示行（只提示不处置） ──

describe("kg.index.status rebuild 随行 orphanNote（W2-D R14）", () => {
  test("orphan>0 项目 rebuild 回执附体检行；非 rebuild 读面不带；健康项目 rebuild 不带", async () => {
    const rig = await openRig();
    await seedAlpha(rig);

    // alpha：TR-2 死锚（write-path.ts 消亡）——rebuild 回执带 orphanNote
    const res = await rig.client.kg("kg.index.status", { project: "alpha", rebuild: true }, 15000);
    expect(res.ok).toBe(true);
    expect(res.result.state).toBe("synced");
    expect(typeof res.result.orphanNote).toBe("string");
    expect(res.result.orphanNote as string).toContain("体检提示");
    // rebuild 后机械口径 3 处：TR-2 死锚 + E-1 锚随全量重建转 dead + E-2 有边
    // 无锚无声明（unanchored_node）（TR-3 superseded 留史节点不再列——
    // orphan_node 口径对称豁免 CAND-3）
    expect(res.result.orphanNote as string).toContain("3 处");

    // 非 rebuild 读面不带 orphanNote（R14 只挂手动 sync 面）
    const plain = await rig.client.kg("kg.index.status", { project: "alpha" });
    expect(plain.result.state).toBe("synced");
    expect(plain.result.orphanNote).toBeUndefined();

    // 健康项目（epsilon：两节点 + 一条边 + 双方锚声明——有边有锚非孤儿非无锚）→ rebuild 不带 orphanNote
    const epsilon = path.join(rig.workspace, "epsilon");
    mkdirSync(epsilon, { recursive: true });
    expectOk(
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "rule", name: "甲规则", digest: "d1", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "createNode", iterationId: ITER, draft: { kind: "entity", name: "乙实体", digest: "d2", scene: "测试场景", status: "confirmed" } }),
      rig.write.write(epsilon, { kind: "addEdge", iterationId: ITER, srcId: "TR-1", verb: "governs", dstId: "E-1" }),
      rig.write.write(epsilon, { kind: "declareAnchors", iterationId: ITER, nodeId: "TR-1", anchors: [{ scopeKind: "global" }] }),
      rig.write.write(epsilon, { kind: "declareAnchors", iterationId: ITER, nodeId: "E-1", anchors: [{ scopeKind: "global" }] }),
    );
    const healthy = await rig.client.kg("kg.index.status", { project: "epsilon", rebuild: true }, 15000);
    expect(healthy.result.state).toBe("synced");
    expect(healthy.result.orphanNote).toBeUndefined();
  }, 20000);
});

// ── kg.candidates.list（台账读面三件套之三：WS 命令——P-1 台账面板数据面） ──

describe("kg.candidates.list I 层（真 service 栈 + tmp 库 + ws 路由）", () => {
  test("正常径：行字段齐全（body 全文 + targetNode + deferAge）+ 最新在前 + status 过滤 + limit/offset", async () => {
    const rig = await openRig();
    await seedAlpha(rig);
    expectOk(
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选甲", body: "正文甲", targetNode: "TR-1" }),
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选乙", body: "正文乙" }),
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "候选丙", body: "正文丙" }),
    );
    expectOk(
      rig.write.write(rig.alpha, { kind: "decideCandidate", iterationId: ITER, candidateId: "CAND-2", decision: "deferred" }),
      rig.write.write(rig.alpha, { kind: "decideCandidate", iterationId: ITER, candidateId: "CAND-3", decision: "applied", reason: "采纳" }),
    );

    const res = await rig.client.kg("kg.candidates.list", { project: "alpha" });
    expect(res.ok).toBe(true);
    expect(res.result.total).toBe(3);
    const rows = res.result.rows as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual(["CAND-3", "CAND-2", "CAND-1"]); // 最新在前
    const first = rows.find((r) => r.id === "CAND-1")!;
    expect(first.title).toBe("候选甲");
    expect(first.body).toBe("正文甲"); // body 全文（详情展开数据源）
    expect(first.targetNode).toBe("TR-1");
    expect(first.status).toBe("pending");
    expect(first.kind).toBe("sediment");
    expect(first.deferAge).toBe(0);
    expect(typeof first.createdAt).toBe("string");
    const second = rows.find((r) => r.id === "CAND-2")!;
    expect(second.status).toBe("deferred");
    expect(second.deferAge).toBe(1);

    // status 过滤
    const pending = await rig.client.kg("kg.candidates.list", { project: "alpha", status: "pending" });
    expect((pending.result.rows as Record<string, unknown>[]).map((r) => r.id)).toEqual(["CAND-1"]);
    expect(pending.result.total).toBe(1);

    // 分页
    const page = await rig.client.kg("kg.candidates.list", { project: "alpha", limit: 2, offset: 2 });
    expect((page.result.rows as Record<string, unknown>[]).map((r) => r.id)).toEqual(["CAND-1"]);
    expect(page.result.total).toBe(3); // total 恒为过滤后全集（分页不改变）

    // 跨项目不串：beta 无候选 → 空集
    seedBeta(rig);
    const beta = await rig.client.kg("kg.candidates.list", { project: "beta" });
    expect(beta.ok).toBe(true);
    expect(beta.result.rows).toEqual([]);
    expect(beta.result.total).toBe(0);
  }, 15000);

  test("防御径：absent KG_E_NOT_FOUND + status 越界 KG_E_PARAM + project 缺失 + unimplemented 门控", async () => {
    // 独立 rig：主 rig 的 delta 已被 index.status 冷启动测试建库（顺序敏感现场）
    const rig = await openRig();
    // absent（delta 无库）：读面绝不新建库文件（kg.list 同先例）
    const absent = await rig.client.kg("kg.candidates.list", { project: "delta" });
    expect(absent.ok).toBe(false);
    expect(absent.error!.code).toBe("KG_E_NOT_FOUND");

    const badStatus = await rig.client.kg("kg.candidates.list", { project: "alpha", status: "bogus" });
    expect(badStatus.ok).toBe(false);
    expect(badStatus.error!.code).toBe("KG_E_PARAM");
    expect(badStatus.error!.message).toContain("payload.status");

    const noProject = await rig.client.kg("kg.candidates.list", {});
    expect(noProject.ok).toBe(false);
    expect(noProject.error!.code).toBe("KG_E_PARAM");

    // unimplemented：kg 栈未装配 → command.unimplemented（不崩溃）
    const events = new EventStream();
    const adapter = new WsServerAdapter({ ...stubAdapterDeps(events) });
    const client = new TestClient(`ws://127.0.0.1:${adapter.port}`);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: "kg-it-token", protocolVersion: PROTOCOL_VERSION } });
      await until(() => client.frames.some((f) => f.type === "connection.welcome"), 3000, "握手 welcome");
      const res = await client.kg("kg.candidates.list", { project: "x" });
      expect(res.ok).toBe(false);
      expect(res.error!.code).toBe("command.unimplemented");
    } finally {
      adapter.stop();
      await client.close();
    }
  }, 15000);

  // ── P2：triageHint 帧级透传钉死（TR-159）+ kg.auto.audit 全链路 ──

  test("P2：triageHint 帧级断言（显式透传漏拷即红）+ kg.auto.audit auto: 前缀聚合 + limit 校验", async () => {
    const rig = await openRig();
    await seedAlpha(rig);
    // 造 auto 审计行：候选 → discarded（auto: 前缀 reason——kg-triage 自动裁决同源口径）
    expectOk(
      rig.write.write(rig.alpha, { kind: "proposeCandidate", iterationId: ITER, candidateKind: "sediment", title: "审计候选", body: "正文" }),
    );
    expectOk(
      rig.write.write(rig.alpha, { kind: "decideCandidate", iterationId: ITER, candidateId: "CAND-1", decision: "discarded", reason: "auto: 重复沉淀（机械查重命中同名节点）" }),
    );

    // ① triageHint 帧级断言（P3 五计数）：alpha 种子（1 dead_anchor + 1 无锚
    //  节点 E-2）+ 无 pending/deferred 候选 + 0 draft ready/stale（TR-2/TR-4 均
    //  anchor-debt 不计）→ pendingTotal=2、阈值下不提示（可选字段透传漏拷 → undefined → 此处红）
    const health = await rig.client.kg("kg.health", { project: "alpha" });
    expect(health.ok).toBe(true);
    expect(health.result.triageHint).toEqual({ pendingTotal: 2, suggested: false });

    // ② kg.auto.audit：stats 全量聚合 + 最新在前 + auto: 前缀行限定
    const audit = await rig.client.kg("kg.auto.audit", { project: "alpha", limit: 10 });
    expect(audit.ok).toBe(true);
    const auditDto = audit.result as { stats: { total: number; byOp: { op: string; count: number }[] }; entries: { reason: string }[] };
    expect(auditDto.stats.total).toBe(1);
    expect(auditDto.stats.byOp).toEqual([{ op: "decideCandidate", count: 1 }]);
    expect(auditDto.entries).toHaveLength(1);
    expect(auditDto.entries[0]!.reason.startsWith("auto: ")).toBe(true);
    expect(auditDto.entries[0]!.reason).toContain("重复沉淀");

    // ③ limit 非法（负数）→ KG_E_PARAM；缺省回 50（0 视为合法缺省语义）
    const bad = await rig.client.kg("kg.auto.audit", { project: "alpha", limit: -1 });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("KG_E_PARAM");

    // ④ project 无法解析 → KG_E_PARAM
    const noProject = await rig.client.kg("kg.auto.audit", { project: "no-such" });
    expect(noProject.ok).toBe(false);
    expect(noProject.error!.code).toBe("KG_E_PARAM");
  }, 15000);
});
