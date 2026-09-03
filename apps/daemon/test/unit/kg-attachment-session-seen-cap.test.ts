import { describe, expect, test } from "bun:test";
import { KgAttachmentService } from "../../src/application/services/kg/KgAttachmentService";

/**
 * M6 单元：KgAttachmentService.sessionSeen 容量上限淘汰（LRU 256 条）——
 * 会话级跨通道去重注册表不再无界增长。淘汰语义：最久未触会话条目被汰，
 * 其再次附着时 seen 重建（可能重复注入一次 📎 块，代价远小于无界增长）。
 */

function makeService(): KgAttachmentService {
  // seenOf/seenInSession 不触 graph（仅 attachAfterEdit 用）——本测试面空桩
  return new KgAttachmentService({ graph: {} as never });
}

function seenMap(svc: KgAttachmentService): Map<string, Set<string>> {
  return (svc as unknown as { sessionSeen: Map<string, Set<string>> }).sessionSeen;
}

describe("M6：sessionSeen LRU 容量上限", () => {
  test("超 256 会话 → 最久未触被淘汰，总量封顶 256", () => {
    const svc = makeService();
    for (let i = 0; i < 300; i++) svc.seenInSession(`s-${i}`);
    const map = seenMap(svc);
    expect(map.size).toBe(256);
    expect(map.has("s-299")).toBe(true); // 最新保留
    expect(map.has("s-0")).toBe(false); // 最久未触淘汰
    expect(map.has("s-43")).toBe(false);
    expect(map.has("s-44")).toBe(true); // 恰在窗口边界
  });

  test("触及刷新 LRU 序：被触会话在新会话涌入后仍保留", () => {
    const svc = makeService();
    for (let i = 0; i < 256; i++) svc.seenInSession(`s-${i}`);
    svc.seenInSession("s-0"); // 触及最老会话 → 刷新为最新
    svc.seenInSession("s-new"); // 涌入一个新会话 → 淘汰 s-1（现最久未触）
    const map = seenMap(svc);
    expect(map.size).toBe(256);
    expect(map.has("s-0")).toBe(true);
    expect(map.has("s-1")).toBe(false);
    expect(map.has("s-new")).toBe(true);
  });

  test("同会话去重集合跨淘汰语义外保持一致（回归：seen 内容随条目保留）", () => {
    const svc = makeService();
    (svc.seenInSession("s-x") as Set<string>).add("TR-1");
    expect([...svc.seenInSession("s-x")]).toEqual(["TR-1"]);
  });
});
