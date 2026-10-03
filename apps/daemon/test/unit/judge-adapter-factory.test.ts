/**
 * JudgeAdapterFactory 分派单测（注册表 variant 分派——jev / pi-ai 双实现）。
 *
 * 断言面：
 * 1. variant="pi-ai" → PiAiJudgeAdapter（services 注入后 noul 走 fake Models
 *    classify 通道）；
 * 2. variant 缺席 = "jev" 存量兼容（回归——不改既有 jev 行为）；
 * 3. 未知 variant → 抛错含已支持清单；
 * 4. 惰性分派：resolve 返回值切换 variant，同一 makeJudgeAdapter 产物下一
 *    次调用自动跟随（与「换端点/换变体零重启」语义对齐）。
 */
import { describe, expect, test } from "bun:test";
import type { ClassifierContext, ClassifierResult, Models } from "@earendil-works/pi-ai";
import { makeJudgeAdapter, type JudgeAdapterServices, type JudgeRecord } from "../../src/adapters/driven/embedding/JudgeAdapterFactory";

/** 最小 fake services（pi-ai variant 依赖面：目录 + key）。 */
function fakeServices() {
  const classifyCalls: { context: ClassifierContext; options?: unknown }[] = [];
  const models = {
    getModel: (provider: string, id: string) =>
      provider === "typesafe" && id === "jev-latest" ? ({ provider, id, type: "classifier" } as never) : undefined,
    getModels: (provider?: string) => (provider === "typesafe" ? [{ id: "jev-latest" }] : []) as never,
    classify: async (_model: unknown, context: ClassifierContext, options?: unknown) => {
      classifyCalls.push({ context, options });
      const result: ClassifierResult = {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-latest",
        answers: { q: { type: "bool", probability: 0.66 } },
        stopReason: "stop",
        timestamp: 0,
      };
      return result;
    },
  };
  const services: JudgeAdapterServices = {
    getModels: () => models as unknown as Models,
    getApiKey: () => "auth-key",
  };
  return { services, classifyCalls };
}

describe("JudgeAdapterFactory：variant 分派", () => {
  test('variant="pi-ai" → classify 通道（state 包装 + bool 问题 + probability 回传）', async () => {
    const { services, classifyCalls } = fakeServices();
    const record: JudgeRecord = { baseUrl: "pi-ai", model: "typesafe/jev-latest", variant: "pi-ai" };
    const judge = makeJudgeAdapter(() => record, services);
    const prob = await judge.noul("片段", "问题成立？");
    expect(prob).toBeCloseTo(0.66);
    expect(classifyCalls).toHaveLength(1);
    expect((classifyCalls[0]!.options as { apiKey?: string }).apiKey).toBe("auth-key");
    expect(judge.endpointLabel()).toBe("pi-ai/typesafe/jev-latest");
  });

  test("variant 缺席 = jev 存量兼容（jev 通道行为不变）", async () => {
    const { services } = fakeServices();
    // jev 适配器走 baseUrl/systemone——不触 services；未配置 baseUrl 时 noul 抛
    // 未配置错（证明分派进了 JevJudgeAdapter 而非 pi-ai）
    const judge = makeJudgeAdapter(() => null, services);
    expect(judge.noul("s", "q")).rejects.toThrow("未配置");
    expect(judge.endpointLabel()).toBe("jev 未配置");
  });

  test("未知 variant → 同步抛错含已支持清单（pick 在 noul 调用内同步分派）", () => {
    const { services } = fakeServices();
    const judge = makeJudgeAdapter(
      () => ({ baseUrl: "x", model: "m", variant: "nope" }),
      services,
    );
    expect(() => judge.noul("s", "q")).toThrow("pi-ai");
  });

  test("惰性分派：variant 切换零重建跟随（jev → pi-ai）", async () => {
    const { services, classifyCalls } = fakeServices();
    let record: JudgeRecord | null = null;
    const judge = makeJudgeAdapter(() => record, services);
    // 未配置（jev 缺省）→ 抛
    expect(judge.noul("s", "q")).rejects.toThrow("未配置");
    // 切 pi-ai variant → 下一次调用自动跟随
    record = { baseUrl: "pi-ai", model: "typesafe/jev-latest", variant: "pi-ai" };
    const prob = await judge.noul("s", "q");
    expect(prob).toBeCloseTo(0.66);
    expect(classifyCalls).toHaveLength(1);
  });
});
