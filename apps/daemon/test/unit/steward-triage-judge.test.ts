/**
 * 分诊判官判定面单测（管家分诊判官接入批）。
 *
 * 断言面（brief 测试要求「配置」段）：
 * 1. 开关缺省 false：无 KV → enabled()/ready() 均 false、state() 全降级缺省；
 * 2. set/get 往返：judgeEnabled/judgeEndpointId 写 KV → state() 回显生效值
 *    （引用态 id/name/model/hasApiKey——凭据不出库）；
 * 3. 端点删除后读面视为未配：resolveRecord → null → ready() false +
 *    state().judgeEndpoint null（UI 显示「未选择」的数据源）；
 * 4. kind 校验：embedding 端点不串用（判官只吃 classifier）；
 * 5. noul 透传：state/question 原样到注入的判官面（E-199——本模块不直 new
 *    适配器，judge 由组合根经 makeJudgeAdapter 构造注入）。
 */
import { describe, expect, test } from "bun:test";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import {
  makeTriageJudgeFace,
  resolveTriageJudgeRecord,
  STEWARD_TRIAGE_JUDGE_ENABLED_KEY,
  STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY,
  type TriageJudgeFace,
} from "../../src/application/steward/StewardTriageJudge";
import { TRIAGE_JUDGE_WORTH_QUESTION } from "../../src/application/steward/StewardPerceptionService";

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

/** embedding 配置域查询面 fake：ep-cls（classifier）/ep-emb（embedding）两条。 */
function fakeLookup() {
  const records = new Map<string, { id: string; name: string; baseUrl: string; model: string; kind?: "embedding" | "classifier"; apiKey?: string }>();
  records.set("ep-cls", { id: "ep-cls", name: "Jev", baseUrl: "https://jev.example", model: "jev-latest", kind: "classifier", apiKey: "sk-x" });
  records.set("ep-emb", { id: "ep-emb", name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "bge-m3", kind: "embedding" });
  return {
    records,
    resolveRecord: (id: string) => records.get(id) ?? null,
  };
}

/** 判官 noul 面 fake（组合根注入位——真体 = makeJudgeAdapter 注册表分派）。 */
function fakeJudgeNoul() {
  const calls: { state: string; question: string }[] = [];
  return {
    calls,
    noul: async (state: string, question: string): Promise<number> => {
      calls.push({ state, question });
      return 0.9;
    },
  };
}

function makeFace(opts?: {
  config?: ReturnType<typeof fakeConfig>;
  lookup?: ReturnType<typeof fakeLookup>;
  judge?: ReturnType<typeof fakeJudgeNoul>;
}) {
  const config = opts?.config ?? fakeConfig();
  const lookup = opts?.lookup ?? fakeLookup();
  const judge = opts?.judge ?? fakeJudgeNoul();
  const face = makeTriageJudgeFace({ config, embeddingConfig: lookup, judge });
  return { face, config, lookup, judge };
}

describe("分诊判官配置读面（缺省 + 往返 + 端点悬空）", () => {
  test("缺省（无 KV）：enabled/ready false、state 全降级缺省", () => {
    const { face } = makeFace();
    expect(face.enabled()).toBe(false);
    expect(face.ready()).toBe(false);
    expect(face.state()).toEqual({ judgeEnabled: false, judgeEndpoint: null });
  });

  test("set/get 往返：judgeEndpointId 写 KV + state() 回显引用态（凭据不出库）", async () => {
    const { face, config } = makeFace();
    const outcome = await face.setConfig({ judgeEnabled: true, judgeEndpointId: "ep-cls" });
    expect(outcome).toEqual({ ok: true });
    expect(config.kv.get(STEWARD_TRIAGE_JUDGE_ENABLED_KEY)).toBe("1");
    expect(config.kv.get(STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY)).toBe("ep-cls");
    expect(face.enabled()).toBe(true);
    expect(face.ready()).toBe(true);
    expect(face.state()).toEqual({
      judgeEnabled: true,
      judgeEndpoint: { id: "ep-cls", name: "Jev", model: "jev-latest", hasApiKey: true },
    });
  });

  test("开关关（judgeEnabled=false）→ ready false（判定面不启用——回退现行 LLM 路径）", async () => {
    const { face } = makeFace({ config: fakeConfig({ [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-cls" }) });
    expect(face.enabled()).toBe(false);
    expect(face.ready()).toBe(false); // 端点有效但开关关 → 未就绪
  });

  test("端点删除后读面视为未配：resolveRecord → null → ready false + state.judgeEndpoint null", async () => {
    const { face, lookup } = makeFace({ config: fakeConfig({ [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1", [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-cls" }) });
    expect(face.ready()).toBe(true);
    lookup.records.delete("ep-cls"); // 模型页删除该端点
    expect(face.ready()).toBe(false);
    expect(face.state()).toEqual({ judgeEnabled: true, judgeEndpoint: null }); // 引用悬空 = 未配
  });

  test("kind 校验：embedding 端点不串用（判官只吃 classifier）", () => {
    const { face } = makeFace({ config: fakeConfig({ [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1", [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-emb" }) });
    expect(face.ready()).toBe(false);
    expect(face.state().judgeEndpoint).toBeNull();
  });

  test("resolveTriageJudgeRecord 纯函数：未配/悬空/非 classifier → null；有效 classifier → 记录直出", () => {
    const config = fakeConfig({ [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-cls" });
    const lookup = fakeLookup();
    expect(resolveTriageJudgeRecord(config, lookup)?.id).toBe("ep-cls");
    config.kv.set(STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY, "ep-gone");
    expect(resolveTriageJudgeRecord(config, lookup)).toBeNull();
    config.kv.set(STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY, "ep-emb");
    expect(resolveTriageJudgeRecord(config, lookup)).toBeNull();
    config.kv.set(STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY, "");
    expect(resolveTriageJudgeRecord(config, lookup)).toBeNull();
  });

  test("空串 judgeEndpointId = 清除引用（显式解绑 → 未配态）", async () => {
    const { face } = makeFace({ config: fakeConfig({ [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1", [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-cls" }) });
    await face.setConfig({ judgeEndpointId: "" });
    expect(face.ready()).toBe(false);
    expect(face.state()).toEqual({ judgeEnabled: true, judgeEndpoint: null });
  });
});

describe("noul 透传（判定面 = 注入的判官面——E-199 注册表唯一姿势）", () => {
  test("state/question 原样透传 + 返回值直出", async () => {
    const { face, judge } = makeFace({ config: fakeConfig({ [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1", [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-cls" }) });
    const p = await face.noul("现场：任务完成", TRIAGE_JUDGE_WORTH_QUESTION);
    expect(p).toBe(0.9);
    expect(judge.calls).toEqual([{ state: "现场：任务完成", question: TRIAGE_JUDGE_WORTH_QUESTION }]);
  });

  test("类型形态：face 满足感知服务判定依赖窄面", () => {
    const { face } = makeFace();
    const _check: TriageJudgeFace = face;
    expect(typeof _check.noul).toBe("function");
  });
});
