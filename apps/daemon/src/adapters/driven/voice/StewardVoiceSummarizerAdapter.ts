/**
 * StewardVoiceSummarizerAdapter —— VoiceSummarizerPort 的实现（driven；
 * 语音播报批 ③层 LLM 摘要）。
 *
 * 「复用管家配置的模型」的落地点：组合根注入 StewardLlmPort 真体
 * （PiStewardLlmAdapter——模型槽位 = RuntimeConfig steward.model + flash
 * 级默认，key = auth.json 同键位）——播报域不另建模型槽位，换模型/换 key
 * 自动跟随管家配置面。可用性判别（isAvailable）= 管家开关（steward.enabled
 * ≠ "1" → 摘要面关，②层模板路径）∧ 模型槽位非空。
 *
 * 防腐面：{systemPrompt, userPrompt} → StewardLlmRequest（messages 恰一条
 * user、tools 空——摘要无工具面无会话史，单发无状态）；text 响应透传，
 * toolCall 响应（tools 空下不应发生）→ throw（fail-fast，回退决策归
 * BroadcastService）。StewardService 本体零改动（域间只借 LLM port 实例，
 * 不借服务）。
 */
import type { StewardLlmPort } from "../../../application/ports/outbound/StewardLlmPort";
import type {
  VoiceSummarizerPort,
  VoiceSummaryPrompt,
} from "../../../application/ports/outbound/VoiceSummarizerPort";

export interface StewardVoiceSummarizerDeps {
  /** 管家 LLM 面（组合根注入 PiStewardLlmAdapter 真体——模型槽位/key 同源）。 */
  readonly llm: StewardLlmPort;
  /** 管家开关读面（steward.enabled KV；false = 摘要面关，零 LLM 调用）。 */
  readonly enabled: () => boolean;
}

export class StewardVoiceSummarizerAdapter implements VoiceSummarizerPort {
  private readonly deps: StewardVoiceSummarizerDeps;

  constructor(deps: StewardVoiceSummarizerDeps) {
    this.deps = deps;
  }

  isAvailable(): boolean {
    return this.deps.enabled() && this.deps.llm.modelId.trim() !== "";
  }

  async complete(prompt: VoiceSummaryPrompt): Promise<string> {
    const response = await this.deps.llm.complete({
      systemPrompt: prompt.systemPrompt,
      messages: [{ role: "user", text: prompt.userPrompt }],
      tools: [],
    });
    if (response.kind === "toolCall") {
      throw new Error(`播报摘要面收到意外的工具调用（${response.name}——tools 为空不应发生）`);
    }
    if (response.kind === "aborted") {
      // 本面不传 signal，aborted 结构性不可达——防御分支（不静默）
      throw new Error("播报摘要面收到意外的 aborted 判别（不传 signal 不应发生）");
    }
    return response.text;
  }
}
