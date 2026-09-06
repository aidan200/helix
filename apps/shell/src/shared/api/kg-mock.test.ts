/**
 * kg-mock 维护批四命令（M39：kg.health / kg.candidates.list / kg.review.create /
 * code.review.create）mock 镜像面测试——fake 实例对四命令自动回放确定性应答，
 * 与真实 daemon 恒应答同规（health/candidates 空态 DTO；review.create 回 ok）。
 * M11 批增面：replyIndex rebuild 门控对齐 daemon indexStatus（任意状态无条件
 * 触发，building 幂等忽略）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isKgCommand, KgMockStore } from "./kg-mock";

describe("isKgCommand 白名单（M39）", () => {
  it("维护批四命令入白名单", () => {
    expect(isKgCommand("kg.health")).toBe(true);
    expect(isKgCommand("kg.candidates.list")).toBe(true);
    expect(isKgCommand("kg.review.create")).toBe(true);
    expect(isKgCommand("code.review.create")).toBe(true);
  });

  it("未知命令不入白名单", () => {
    expect(isKgCommand("kg.unknown")).toBe(false);
  });
});

describe("KgMockStore 维护批应答（M39）", () => {
  it("kg.health：空态体检 DTO（conflicts/orphans 空 + index 状态复用 + candidates 四态计数）", () => {
    const store = new KgMockStore();
    const frame = store.reply("kg.health", { project: "helix" });
    expect(frame.type).toBe("kg.health.result");
    const dto = frame.payload as {
      conflicts: unknown[];
      orphans: unknown[];
      orphanCount: number;
      index: { state: string };
      candidates: { pending: number; deferred: number; applied: number; discarded: number };
    };
    expect(dto.conflicts).toEqual([]);
    expect(dto.orphans).toEqual([]);
    expect(dto.orphanCount).toBe(0);
    expect(dto.index.state).toBe("synced");
    expect(dto.candidates).toEqual({ pending: 0, deferred: 0, applied: 0, discarded: 0 });
  });

  it("kg.candidates.list：空态台账 DTO（total=0 / rows=[]）", () => {
    const store = new KgMockStore();
    const frame = store.reply("kg.candidates.list", { project: "helix" });
    expect(frame.type).toBe("kg.candidates.list.result");
    expect(frame.payload).toEqual({ total: 0, rows: [] });
  });

  it("kg.review.create：准入过（synced 项目）→ ok + jobId；absent 项目 → 准入错误帧", () => {
    const store = new KgMockStore();
    const ok = store.reply("kg.review.create", { project: "helix" });
    expect(ok.type).toBe("kg.review.create.result");
    expect(ok.payload).toMatchObject({ ok: true });
    expect(typeof (ok.payload as { jobId: unknown }).jobId).toBe("string");

    const denied = store.reply("kg.review.create", { project: "codegraph" }); // absent
    expect(denied.type).toBe("connection.error");
    expect((denied.payload as { code: string }).code).toBe("kg.review.not_eligible");
  });

  it("code.review.create：回 ok + jobId", () => {
    const store = new KgMockStore();
    const frame = store.reply("code.review.create", { project: "helix" });
    expect(frame.type).toBe("code.review.create.result");
    expect(frame.payload).toMatchObject({ ok: true });
    expect(typeof (frame.payload as { jobId: unknown }).jobId).toBe("string");
  });

  it("project 无法解析 → 参数错误帧（KG_E_PARAM）", () => {
    const store = new KgMockStore();
    for (const type of ["kg.health", "kg.candidates.list", "kg.review.create", "code.review.create"]) {
      const frame = store.reply(type, {});
      expect(frame.type).toBe("connection.error");
      expect((frame.payload as { code: string }).code).toBe("KG_E_PARAM");
    }
  });
});

// ── M11 批：replyIndex rebuild 门控对齐 daemon（任意状态无条件触发；building 幂等）──

describe("KgMockStore.replyIndex rebuild 门控（对齐 daemon KgViewerService.indexStatus）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("synced 态 rebuild:true 也触发重建（building → 3200ms 后 synced）", () => {
    // 独立 new KgMockStore()（非 singleton kgMockStore）：rebuild 推进行状态，
    // 避免污染 fake-transport/e2e 共享场景数据（helix「56 符号」）
    const store = new KgMockStore();
    const before = store.reply("kg.index.status", { project: "helix" });
    expect(before.payload).toMatchObject({ state: "synced" });

    const trigger = store.reply("kg.index.status", { project: "helix", rebuild: true });
    expect(trigger.payload).toMatchObject({ state: "building" });

    vi.advanceTimersByTime(3200);
    const done = store.reply("kg.index.status", { project: "helix" });
    expect(done.payload).toMatchObject({ state: "synced" });
  });

  it("building 中重复 rebuild 幂等忽略：时基不重置（剩 1200ms 即完成）", () => {
    const store = new KgMockStore();
    store.reply("kg.index.status", { project: "helix", rebuild: true });

    vi.advanceTimersByTime(2000);
    const re = store.reply("kg.index.status", { project: "helix", rebuild: true });
    expect(re.payload).toMatchObject({ state: "building" });

    // 若时基被重置，此处 1300ms 不足 3200ms 仍是 building；幂等语义下应已 synced
    vi.advanceTimersByTime(1300);
    const done = store.reply("kg.index.status", { project: "helix" });
    expect(done.payload).toMatchObject({ state: "synced" });
  });

  it("absent / degraded 态 rebuild:true 触发行为保持（去门控回归面）", () => {
    const store = new KgMockStore();
    const degraded = store.reply("kg.index.status", { project: "feifei", rebuild: true });
    expect(degraded.payload).toMatchObject({ state: "building" });
    const absent = store.reply("kg.index.status", { project: "serena", rebuild: true });
    expect(absent.payload).toMatchObject({ state: "building" });
  });
});
