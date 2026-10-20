import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@helix/protocol";
import { handleKgCandidatesList, handleKgList } from "../../src/adapters/driving/ws-server/handlers/kg";
import type { KgCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * kg.list / kg.candidates.list 的 unbound 路径（低危批：载荷校验单点）。
 *
 * unbound（无工作区绑定）时列表型读面回空集不报错；但**载荷校验与主路径同源**
 * ——旧的逐行重复实现让两条路径各自维护一份校验，漂移即两侧行为不一。
 */

function kgCtx(payload: Record<string, unknown>, opts: { kg?: unknown; unbound?: boolean } = {}) {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type: "kg.list",
    payload,
    kg: opts.kg,
    workspaceUnbound: opts.unbound === true,
    commandError: (_type: string, code: string, message: string) => {
      errors.push({ code, message });
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as KgCommandContext;
  return { ctx, frames, errors };
}

describe("kg.list unbound 路径（校验单点）", () => {
  test("① unbound + 合法载荷 → 空集结果帧（不报错）", () => {
    const { ctx, frames, errors } = kgCtx({ project: "helix" }, { unbound: true });
    handleKgList(ctx);
    expect(errors).toEqual([]);
    expect((frames[0] as { type: string }).type).toBe("kg.list.result");
    expect((frames[0] as { payload: { nodes: unknown[] } }).payload.nodes).toEqual([]);
  });

  test("② unbound + 缺 project → 与主路径同一处校验报错（KG_E_PARAM）", () => {
    const { ctx, frames, errors } = kgCtx({}, { unbound: true });
    handleKgList(ctx);
    expect(frames).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("payload.project");
  });

  test("③ unbound + q 形状非法 → 校验拦下（空集分支不再绕过校验）", () => {
    const { ctx, frames, errors } = kgCtx({ project: "helix", q: 12 }, { unbound: true });
    handleKgList(ctx);
    expect(frames).toEqual([]);
    expect(errors[0]!.message).toContain("payload.q");
  });

  test("④ 未装配且非 unbound → command.unimplemented（优先序保持）", () => {
    const { ctx, frames, errors } = kgCtx({ project: "helix" });
    handleKgList(ctx);
    expect(frames).toEqual([]);
    expect(errors[0]?.code).toBe("command.unimplemented");
  });

  test("⑤ kg.candidates.list 同规：unbound + 合法 → 空表；非法 limit → KG_E_PARAM", () => {
    const ok = kgCtx({ project: "helix", status: "pending" }, { unbound: true });
    handleKgCandidatesList(ok.ctx);
    expect(ok.errors).toEqual([]);
    expect((ok.frames[0] as { payload: { rows: unknown[] } }).payload.rows).toEqual([]);
    const bad = kgCtx({ project: "helix", limit: -1 }, { unbound: true });
    handleKgCandidatesList(bad.ctx);
    expect(bad.frames).toEqual([]);
    expect(bad.errors[0]?.code).toBe("KG_E_PARAM");
  });
});
