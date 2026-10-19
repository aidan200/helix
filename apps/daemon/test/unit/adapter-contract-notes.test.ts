/**
 * 评审 F2 #12 / #30 —— 适配器头注与实现口径对齐（口径漂移类，影响排障与安全假设）。
 *
 * 两条都是「注释承诺超出实现」型缺陷，无法用行为断言表达，改用源码定式断言钉住
 * 校正后的口径（仓库先例：mcp-registry-exit-guard.test.ts 的结构断言）。
 *
 * #12 SqliteKnowledgeStore：头注曾称「两通道不同表集、互不竞争（AD-15）」，
 *     但 applySync 在同一 sync 事务里还维护 anchor_decl 与 change_log。
 * #30 browser-observer：头注曾承诺「isTrusted 过滤保证真实用户交互」，
 *     实际 binding 是页面级函数，任意页面脚本可伪造 trusted:true。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dir, "..", "..", "src", "adapters", "driven");
const DRIVING_SRC = path.join(import.meta.dir, "..", "..", "src", "adapters", "driving");

describe("适配器头注口径对齐（评审 F2 #12/#30）", () => {
  test("#12 SqliteKnowledgeStore：头注承认 sync 通道维护 anchor_decl/change_log（表集非完全互斥）", () => {
    const src = readFileSync(path.join(SRC, "sqlite-kg", "SqliteKnowledgeStore.ts"), "utf8");
    expect(src).toContain("两通道表集**不是完全互斥**");
    expect(src).toContain("anchor_decl（L0 行级重定位）");
    expect(src).toContain("change_log（anchorRelocate/prune 审计）");
    // 旧的「两通道不同表集」独断口径不得回潮
    expect(src).not.toContain("互不竞争\n * （AD-15：两通道不同表集、各自连接+事务）");
  });

  test("#30 browser-observer：头注明确 isTrusted 不是安全边界（可伪造 trusted 字段）", () => {
    const src = readFileSync(path.join(SRC, "cdp", "browser-observer.ts"), "utf8");
    expect(src).toContain("不是安全边界");
    expect(src).toContain("伪造");
    expect(src).toContain("无签名/无一次性凭证");
    // 旧的过度承诺措辞不得回潮
    expect(src).not.toContain("isTrusted 过滤保证真实\n *   用户交互");
  });

  // 评审 F2 #22：12 处「for connections + 订阅位过滤 + try/catch 单连接隔离」同构块
  // 重复——新增帧族漏抄 try/catch 即破 TR-38「单连接异常不扩散」。统一收口到
  // fanout 单点后，本断言防止新帧族绕开单点重写裸循环。
  test("#22 EventStream：连接级投递只经 fanout 单点（无裸广播循环）", () => {
    const src = readFileSync(path.join(DRIVING_SRC, "ws-server", "EventStream.ts"), "utf8");
    const loopPattern = /for \(const \[sender, conn\] of this\.connections\)/g;
    const loops = src.match(loopPattern) ?? [];
    expect(loops.length).toBe(1); // 唯一允许处 = fanout 内部
    expect(src).toContain("private fanout(");
    // fanout 必须在循环体内保留 try/catch 隔离（TR-38 不变式）
    const fanoutBody = src.slice(src.indexOf("private fanout("), src.indexOf("private fanout(") + 900);
    expect(fanoutBody).toContain("} catch {");
  });
});
