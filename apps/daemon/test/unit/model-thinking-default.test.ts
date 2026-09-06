import { describe, expect, test } from "bun:test";
import {
  InvalidThinkingLevelError,
  ModelService,
  type ModelServiceDeps,
} from "../../src/application/services/ModelService";
import type { SessionRegistry } from "../../src/application/services/SessionRegistry";

/**
 * M6 #2.5：ModelService.setThinkingDefault 错误码——thinking 档位形状校验错
 * （空串/非字符串）不冒用 model_not_found（模型名录错），换专用
 * InvalidThinkingLevelError（code=command.invalid_payload，同
 * ImageValidationError/SteerTargetNotRunningError 先例；driving 层按码回执
 * 不再误导客户端「模型不存在」）。
 */

function makeService(defaultThinking?: { stored(): string | null; set(level: string | null): Promise<void> }) {
  const deps: ModelServiceDeps = {
    registry: {} as unknown as SessionRegistry, // 本路径不触达
    catalog: { hasModel: () => false } as unknown as ModelServiceDeps["catalog"],
    auth: {} as unknown as ModelServiceDeps["auth"],
    defaultModel: { current: () => "fake/model", set: async () => {} } as unknown as ModelServiceDeps["defaultModel"],
    ...(defaultThinking !== undefined ? { defaultThinking } : {}),
    onModelChanged: () => {},
    onThinkingChanged: () => {},
  };
  return new ModelService(deps);
}

describe("ModelService.setThinkingDefault 错误码（M6 #2.5）", () => {
  test("空串/空白档位 → InvalidThinkingLevelError（code=command.invalid_payload，非 model_not_found），存储零写入", async () => {
    const writes: (string | null)[] = [];
    const svc = makeService({
      stored: () => null,
      set: async (level) => {
        writes.push(level);
      },
    });
    for (const bad of ["", "   "]) {
      const err = await svc.setThinkingDefault(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidThinkingLevelError);
      expect((err as InvalidThinkingLevelError).code).toBe("command.invalid_payload");
      expect((err as InvalidThinkingLevelError).code).not.toBe("model_not_found");
      expect((err as Error).name).toBe("InvalidThinkingLevelError");
    }
    expect(writes).toEqual([]); // 形状防线先行——不落库
  });

  test("非字符串档位（运行时越界值）→ 同码拒绝", async () => {
    const svc = makeService({ stored: () => null, set: async () => {} });
    const err = await svc
      .setThinkingDefault(42 as unknown as string)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidThinkingLevelError);
    expect((err as InvalidThinkingLevelError).code).toBe("command.invalid_payload");
  });

  test("合法档位与 null（清除回未配置态）照常写入并回 previous", async () => {
    let stored: string | null = "low";
    const svc = makeService({
      stored: () => stored,
      set: async (level) => {
        stored = level;
      },
    });
    const r1 = await svc.setThinkingDefault("high");
    expect(r1).toEqual({ previous: "low" });
    expect(stored).toBe("high");
    const r2 = await svc.setThinkingDefault(null);
    expect(r2).toEqual({ previous: "high" });
    expect(stored).toBeNull();
  });
});
