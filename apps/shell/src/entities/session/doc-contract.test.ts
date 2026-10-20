/**
 * 会话实体层注释口径守卫（TR-285：注释/文案漂移用源码定式断言钉住）。
 *
 * 背景（code-review 低危）：SessionContext 模块头注与两处同型注释、command-surface
 * 的 getLedger 注释长期写「全图订阅模型：其余全部 monitor / 重连重放全订阅图」
 * ——该语义已被 E-192 监控窗口模型取代（monitor 档 LRU 容量 + syncList 窗口
 * 对齐 + 重放按簿序 ≤ 容量+活跃）。旧注释会让后来者按「全图订阅」改逻辑，
 * 直接踩回慢客户端背压风暴（E-192「为什么存在」段的事故根因）。
 *
 * 钉法：新口径（监控窗口模型 + 语义单源指向 subscription-ledger）在场；
 * 「全图订阅」旧措辞禁回潮（分片拼接构造待禁串，避免断言目标自指恒真）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const sessionCtx = read("./SessionContext.tsx");
const commandSurface = read("./command-surface.ts");

describe("订阅模型注释口径（监控窗口模型取代全图订阅）", () => {
  it("新口径在场：SessionContext 明写监控窗口模型 + E-192 单源指向", () => {
    expect(sessionCtx).toContain("监控窗口订阅模型");
    expect(sessionCtx).toContain("E-192");
    expect(sessionCtx).toContain("subscription-ledger.ts 为单源");
  });

  it("新口径在场：command-surface getLedger 指向监控窗口模型", () => {
    expect(commandSurface).toContain("订阅生命周期唯一权威");
    expect(commandSurface).toContain("E-192");
  });

  it("旧措辞禁回潮（全图订阅/全部 monitor；分片拼接防自指）", () => {
    const banned = ["全图" + "订阅", "其余全部 " + "monitor"];
    for (const src of [sessionCtx, commandSurface]) {
      for (const b of banned) expect(src).not.toContain(b);
    }
  });
});
