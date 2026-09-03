/**
 * kg-mock 维护批四命令（M39：kg.health / kg.candidates.list / kg.review.create /
 * code.review.create）mock 镜像面测试——fake 实例对四命令自动回放确定性应答，
 * 与真实 daemon 恒应答同规（health/candidates 空态 DTO；review.create 回 ok）。
 */
import { describe, expect, it } from "vitest";
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
