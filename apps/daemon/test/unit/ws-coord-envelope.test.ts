import { describe, expect, test } from "bun:test";
import { SYSTEM_SESSION_ID } from "@helix/protocol";
import { domainEventToEnvelope } from "../../src/adapters/driving/ws-server/DtoMapper";
import type { CoordLeasePayload, DomainEvent } from "../../src/domain/events/DomainEvent";

/**
 * U5：五个 coord.* 领域事件 → coord.changed 协议帧（notification 通道，
 * daemon 级全局广播）。帧级断言（TR-159 纪律：可选字段必须显式断言透传）。
 */

function coordEvent(type: string, payload: CoordLeasePayload): DomainEvent {
  return {
    type,
    sessionId: "sess-a",
    instanceId: "sess-a-main",
    payload,
    occurredAt: new Date(5000).toISOString(),
  } as DomainEvent;
}

const lease: CoordLeasePayload = {
  leaseId: "lease-1",
  ownerSessionId: "sess-a",
  ownerAgentId: "sess-a-main",
  scopeKind: "project",
  scopeDesc: "/ws/helix",
  intent: "改调度器",
  source: "claimed",
  status: "active",
};

describe("U5 EnvelopeMapper：coord.* → coord.changed", () => {
  test("五领域事件统一映射 coord.changed；kind = 事件尾段；SYSTEM_SESSION_ID 全局帧", () => {
    for (const type of ["coord.claimed", "coord.released", "coord.settled", "coord.undeclared", "coord.conflict"]) {
      const frame = domainEventToEnvelope(coordEvent(type, lease));
      expect(frame).not.toBeNull();
      if (frame === null) continue;
      expect(frame.type).toBe("coord.changed");
      expect(frame.channel).toBe("notification");
      expect(frame.sessionId).toBe(SYSTEM_SESSION_ID); // daemon 级：不按会话订阅路由
      const p = frame.payload as { kind: string; leaseId: string; ownerAgentId: string; scopeDesc: string; intent: string; text: string; ts: number };
      expect(p.kind).toBe(type.slice("coord.".length));
      expect(p.leaseId).toBe("lease-1");
      expect(p.ownerAgentId).toBe("sess-a-main");
      expect(p.scopeDesc).toBe("/ws/helix");
      expect(p.intent).toBe("改调度器");
      expect(typeof p.text).toBe("string"); // daemon 人读文案单源
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.ts).toBe(5000);
    }
  });

  test("escalated 显式透传（TR-159：可选字段帧级断言钉死）", () => {
    const frame = domainEventToEnvelope(coordEvent("coord.conflict", { ...lease, escalated: true }));
    expect(frame).not.toBeNull();
    if (frame === null) return;
    expect((frame.payload as { escalated?: boolean }).escalated).toBe(true);
    // 缺省不携带键（additive 纪律）
    const plain = domainEventToEnvelope(coordEvent("coord.claimed", lease));
    if (plain === null) return;
    expect((plain.payload as { escalated?: boolean }).escalated).toBeUndefined();
  });

  test("text 文案按 kind 区分（conflict 含「冲突」字样）", () => {
    const conflict = domainEventToEnvelope(coordEvent("coord.conflict", { ...lease, conflictWith: ["lease-0"] }));
    if (conflict === null) return;
    expect((conflict.payload as { text: string }).text).toContain("冲突");
    const released = domainEventToEnvelope(coordEvent("coord.released", lease));
    if (released === null) return;
    expect((released.payload as { text: string }).text).toContain("释放");
  });
});
