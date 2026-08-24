import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODES, DEFAULT_MODE_ID } from "@helix/protocol";
import { profileKindOf, resolveModeId } from "../../src/application/services/modes";

/**
 * P1 T3 单元：daemon 模式注册表消费单点（application/services/modes.ts）。
 *
 * 分层裁决：domain 禁 import @helix/protocol（AG-02 白名单仅 @helix/common，
 * kg 架构规则确认）——注册表消费单点落 application 层（白名单三项内），
 * 勿另建平行注册表（T2 约定：唯一注册表 = @helix/protocol modes.ts）。
 *
 * - resolveModeId：缺省/空串/未知 mode → fallback DEFAULT_MODE_ID（协议面
 *   不校验注册表成员资格——AD-2 字符串透传，daemon 消费侧兜底）；
 * - profileKindOf：mode → 建会话链消费的槽位 profileKind（P1 恒
 *   "main-session"；P2 staged/orchestrated 扩条目自动跟随注册表）；
 * - 结构守护：建会话链 "main-session" 字面量参数化（engineFor 槽位 /
 *   buildView 主实例 profileKind 从 mode 解析取值）。
 */
describe("P1 T3 ① 注册表消费单点：resolveModeId / profileKindOf", () => {
  test("缺省/空串 → default；profileKind → main-session", () => {
    expect(resolveModeId(undefined)).toBe("default");
    expect(resolveModeId("")).toBe("default");
    expect(profileKindOf(undefined)).toBe("main-session");
    expect(profileKindOf("")).toBe("main-session");
  });

  test("注册表成员直取（与 @helix/protocol MODES 同源，非平行注册表）", () => {
    expect(resolveModeId("default")).toBe("default");
    expect(profileKindOf("default")).toBe(MODES[0].profileKind);
    expect(profileKindOf("default")).toBe("main-session");
  });

  test("未知 mode → fallback DEFAULT_MODE_ID（协议不校验，daemon 消费侧兜底）", () => {
    expect(resolveModeId("no-such-mode")).toBe(DEFAULT_MODE_ID);
    expect(profileKindOf("no-such-mode")).toBe("main-session");
  });
});

describe("P1 T3 ⑤ 结构守护：建会话链字面量参数化（default 下行为不变的编译面钉子）", () => {
  const srcRoot = path.join(import.meta.dir, "..", "..", "src");

  test("engineFor 槽位 kind 从 mode 解析（modelSlot/thinkingSlot 不再硬编码 main-session）", () => {
    const stack = readFileSync(
      path.join(srcRoot, "infrastructure", "assembly", "buildSessionStack.ts"),
      "utf8",
    );
    expect(stack).toContain("profileKindOf(mode)"); // 参数化取值点
    expect(stack).not.toContain('modelSlot("main-session")'); // 字面量退役
    expect(stack).not.toContain('thinkingSlot("main-session")');
  });

  test("buildView 主实例 profileKind 从 mode 解析（SessionRegistry 字面量退役）", () => {
    const registry = readFileSync(
      path.join(srcRoot, "application", "services", "SessionRegistry.ts"),
      "utf8",
    );
    expect(registry).not.toContain('profileKind: "main-session"');
    expect(registry).toContain("profileKindOf(");
  });
});
