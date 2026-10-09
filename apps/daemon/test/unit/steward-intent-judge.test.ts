/**
 * M3-a 批：管家意图判别判定面单测（判官第五消费面——E-199 注册表预言）。
 *
 * 断言面：
 * - makeIntentJudgeFace：enabled/ready 两级读面（与管家分诊判官同开关同端点
 *   ——单判官配置域共享，E-263 UI 零新增）；
 * - noul 透传（组合根注入 makeJudgeAdapter 真体——本模块零直 new）；
 * - pickIntentByScores：阈值 ≥0.5 + 优先级 revise > cancel > confirm（修正
 *   最具体、确认最泛化——同分时高分优先，越界值防御钳制）；
 * - buildIntentReviseAskText：修正轮 LLM 输入携带原卡全文上下文（目标 +
 *   内容）与用户新输入。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import {
  STEWARD_INTENT_JUDGE_THRESHOLD,
  STEWARD_STOP_QUESTION,
  buildIntentReviseAskText,
  isStopIntent,
  makeIntentJudgeFace,
  pickIntentByScores,
} from "../../src/application/steward/StewardIntentJudge";

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

const ENDPOINT_RECORD = {
  id: "ep-1",
  kind: "classifier",
  name: "判官端点",
  model: "typesafe/jev-latest",
  baseUrl: "https://jev.example",
} as const;

function fakeEmbeddingConfig(valid = true) {
  return {
    resolveRecord: (endpointId: string) =>
      valid && endpointId === "ep-1" ? { ...ENDPOINT_RECORD } : null,
  };
}

describe("M3-a 意图判官面（makeIntentJudgeFace）", () => {
  test("开关关（缺省）→ enabled=false；开 + 端点有效 → ready=true", () => {
    const face = makeIntentJudgeFace({
      config: fakeConfig({}),
      embeddingConfig: fakeEmbeddingConfig(),
      judge: { noul: async () => 0.9 },
    });
    expect(face.enabled()).toBe(false); // 缺省关——判官是可选增强
    expect(face.ready()).toBe(false);

    const on = makeIntentJudgeFace({
      config: fakeConfig({ "steward.triage.judgeEnabled": "1", "steward.triage.judgeEndpointId": "ep-1" }),
      embeddingConfig: fakeEmbeddingConfig(),
      judge: { noul: async () => 0.9 },
    });
    expect(on.enabled()).toBe(true);
    expect(on.ready()).toBe(true);
  });

  test("开关开但端点未配/悬空/非 classifier → ready=false（回退判据）", () => {
    const unconfigured = makeIntentJudgeFace({
      config: fakeConfig({ "steward.triage.judgeEnabled": "1" }),
      embeddingConfig: fakeEmbeddingConfig(),
      judge: { noul: async () => 0.9 },
    });
    expect(unconfigured.ready()).toBe(false);

    const dangling = makeIntentJudgeFace({
      config: fakeConfig({ "steward.triage.judgeEnabled": "1", "steward.triage.judgeEndpointId": "ep-gone" }),
      embeddingConfig: fakeEmbeddingConfig(),
      judge: { noul: async () => 0.9 },
    });
    expect(dangling.ready()).toBe(false);
  });

  test("noul 透传注入判官面（state/question 原样到达——零直 new 零改写）", async () => {
    const calls: { state: string; question: string }[] = [];
    const face = makeIntentJudgeFace({
      config: fakeConfig({}),
      embeddingConfig: fakeEmbeddingConfig(),
      judge: {
        noul: async (state, question) => {
          calls.push({ state, question });
          return 0.7;
        },
      },
    });
    const p = await face.noul("上下文", "问题");
    expect(p).toBe(0.7);
    expect(calls).toEqual([{ state: "上下文", question: "问题" }]);
  });
});

describe("M3-a 意图分流纯函数（pickIntentByScores）", () => {
  test("阈值：confirm ≥0.5 命中；三问皆低 → undefined（无关新任务走 LLM）", () => {
    expect(pickIntentByScores(0.1, 0.2, 0.9)).toBe("confirm");
    expect(pickIntentByScores(0.1, 0.2, 0.5)).toBe("confirm"); // 恰好阈值（≥ 含边界）
    expect(pickIntentByScores(0.49, 0.2, 0.49)).toBeUndefined();
  });

  test("优先级 revise > cancel > confirm：同高取更具体意图（修正优先于确认）", () => {
    expect(pickIntentByScores(0.9, 0.8, 0.95)).toBe("revise");
    expect(pickIntentByScores(0.1, 0.9, 0.95)).toBe("cancel");
  });

  test("越界值防御钳制（<0 归 0、>1 归 1——坏端点不炸分流）", () => {
    expect(pickIntentByScores(-2, -1, 1.5)).toBe("confirm");
    expect(pickIntentByScores(NaN, NaN, NaN)).toBeUndefined();
  });

  test("阈值常量 = 0.5（E-250 同款校准概率阈值）", () => {
    expect(STEWARD_INTENT_JUDGE_THRESHOLD).toBe(0.5);
  });
});

describe("M3-a 修正轮 LLM 输入组装（buildIntentReviseAskText）", () => {
  test("携带原卡目标与全文 + 用户原话 + 修正指引（一次 LLM 带卡全文上下文）", () => {
    const text = buildIntentReviseAskText("会话「光球设计」", "继续调整光球动画", "不对，改成先做配色");
    expect(text).toContain("待确认提案");
    expect(text).toContain("会话「光球设计」");
    expect(text).toContain("继续调整光球动画");
    expect(text).toContain("不对，改成先做配色");
    expect(text).toContain("修正");
  });
});

// ── stop-intent 判定（barge-in 意图窗批：非词表停止表达的判官慢通道）────

describe("stop-intent 打分判定（isStopIntent）", () => {
  test("阈值 ≥0.5 → 停止意图（恰含边界）", () => {
    expect(isStopIntent(0.9)).toBe(true);
    expect(isStopIntent(0.5)).toBe(true);
    expect(isStopIntent(0.49)).toBe(false);
    expect(isStopIntent(0)).toBe(false);
  });
  test("越界值防御钳制（>1 归 1 仍停、负值归 0 不停）", () => {
    expect(isStopIntent(1.5)).toBe(true);
    expect(isStopIntent(-1)).toBe(false);
  });
  test("NaN → false（坏端点不误停——保守回退照排队）", () => {
    expect(isStopIntent(Number.NaN)).toBe(false);
  });
  test("问句常量在场（单源——测试直引防措辞漂移）", () => {
    expect(STEWARD_STOP_QUESTION).toContain("停止说话");
  });
});
