/**
 * 遗忘机制批：memory_list 回执帧级断言（TR-159——协议 additive 字段过
 * 逐字段映射器必须显式透传 + 帧级断言钉死）+ pin/restore 两命令处理面。
 *
 * 断言面：
 * 1. 回执帧携带全部生命周期字段（updatedAt/lastRecalledAt/recallCount/
 *    faded/pinned——漏拷即红，可选字段 TS 不报错故必须帧级钉）；
 * 2. 排序 updatedAt 降序（覆盖更新/复活/置顶浮顶）；
 * 3. pin：pinned 非 boolean → invalid_payload；合法 → 委托 + 回新清单；
 * 4. restore：id 非 integer → invalid_payload；合法 → 委托 + 回新清单。
 */
import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@helix/protocol";
import {
  handleStewardMemoryList,
  handleStewardMemoryPin,
  handleStewardMemoryRestore,
} from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import type { StewardService } from "../../src/application/steward/StewardService";
import type { StewardMemoryEntry } from "../../src/application/ports/outbound/StewardMemoryPort";

function entry(partial: Partial<StewardMemoryEntry> & Pick<StewardMemoryEntry, "id">): StewardMemoryEntry {
  return {
    kind: "fact",
    text: `条目 ${partial.id}`,
    source: "steward-turn",
    createdAt: partial.id * 10,
    updatedAt: partial.id * 10,
    lastRecalledAt: partial.id * 10,
    recallCount: 0,
    fadedAt: 0,
    pinned: false,
    ...partial,
  };
}

function ctxOf(type: string, payload: Record<string, unknown>, entries: readonly StewardMemoryEntry[]): {
  ctx: StewardCommandContext;
  frames: EventEnvelope[];
  errors: string[];
  pins: { id: number; pinned: boolean }[];
  restores: number[];
} {
  const frames: EventEnvelope[] = [];
  const errors: string[] = [];
  const pins: { id: number; pinned: boolean }[] = [];
  const restores: number[] = [];
  const sender = { id: "conn-1" };
  const service = {
    listMemoryEntries: () => entries,
    pinMemoryEntry: (id: number, pinned: boolean): boolean => {
      pins.push({ id, pinned });
      return true;
    },
    restoreMemoryEntry: (id: number): boolean => {
      restores.push(id);
      return true;
    },
  } as unknown as StewardService;
  const ctx = {
    ws: { data: { sender } },
    type,
    payload,
    steward: {
      service,
      stream: { subscribeSteward: () => {}, unsubscribeSteward: () => {} },
    },
    commandError: (_type: string, _code: string, message: string) => {
      errors.push(message);
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as StewardCommandContext;
  return { ctx, frames, errors, pins, restores };
}

describe("memory_list 回执帧（遗忘机制批 additive 字段钉死）", () => {
  test("帧携带全部生命周期字段；排序 updatedAt 降序", () => {
    const entries = [
      entry({ id: 1, kind: "preference", text: "偏好A", lastRecalledAt: 555, recallCount: 3, fadedAt: 0, pinned: true }),
      entry({ id: 2, updatedAt: 900, fadedAt: 700 }), // 最近复活 → 浮顶
      entry({ id: 3, fadedAt: 300, lastRecalledAt: 0, recallCount: 0 }),
    ];
    const { ctx, frames } = ctxOf("steward.memory_list", {}, entries);
    handleStewardMemoryList(ctx);
    expect(frames).toHaveLength(1);
    const frame = frames[0] as unknown as { type: string; payload: { entries: Record<string, unknown>[] } };
    expect(frame.type).toBe("steward.memory_list.result");
    const rows = frame.payload.entries;
    expect(rows.map((r) => r.id)).toEqual([2, 3, 1]); // updatedAt 900/300/10 降序
    // 逐字段显式透传（TR-159——漏拷即红）
    const row1 = rows.find((r) => r.id === 1)!;
    expect(row1.updatedAt).toBe(10);
    expect(row1.lastRecalledAt).toBe(555);
    expect(row1.recallCount).toBe(3);
    expect(row1.faded).toBe(false);
    expect(row1.pinned).toBe(true);
    const row3 = rows.find((r) => r.id === 3)!;
    expect(row3.faded).toBe(true);
    expect(row3.lastRecalledAt).toBe(0);
  });
});

describe("handleStewardMemoryPin / handleStewardMemoryRestore（命令处理面）", () => {
  test("pin：合法 → 委托 + 回新清单；pinned 非 boolean → invalid_payload 零委托", () => {
    const ok = ctxOf("steward.memory_pin", { id: 7, pinned: true }, [entry({ id: 7 })]);
    handleStewardMemoryPin(ok.ctx);
    expect(ok.pins).toEqual([{ id: 7, pinned: true }]);
    expect(ok.frames).toHaveLength(1);
    expect((ok.frames[0] as { type: string }).type).toBe("steward.memory_list.result");
    // 校验失败两路
    const badPinned = ctxOf("steward.memory_pin", { id: 7, pinned: "yes" }, [entry({ id: 7 })]);
    handleStewardMemoryPin(badPinned.ctx);
    expect(badPinned.errors).toHaveLength(1);
    expect(badPinned.pins).toHaveLength(0);
    const badId = ctxOf("steward.memory_pin", { id: "x", pinned: true }, []);
    handleStewardMemoryPin(badId.ctx);
    expect(badId.errors).toHaveLength(1);
  });

  test("restore：合法 → 委托 + 回新清单；id 非 integer → invalid_payload", () => {
    const ok = ctxOf("steward.memory_restore", { id: 9 }, [entry({ id: 9 })]);
    handleStewardMemoryRestore(ok.ctx);
    expect(ok.restores).toEqual([9]);
    expect(ok.frames).toHaveLength(1);
    const bad = ctxOf("steward.memory_restore", { id: 1.5 }, []);
    handleStewardMemoryRestore(bad.ctx);
    expect(bad.errors).toHaveLength(1);
    expect(bad.restores).toHaveLength(0);
  });
});
