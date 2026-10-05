/**
 * StewardDiagnosisAdapter —— StewardDiagnosisPort 的实现（driven；
 * 管家感知批 M0.5：分诊器一次调用双轨产物）。
 *
 * 任务总结子功能（管家子功能）专用 LLM 面的延续（E-232 ③层摘要槽位沿用）：
 * 组合根注入独立 PiStewardLlmAdapter 实例（模型槽位 = RuntimeConfig
 * steward.summary.model，**无默认模型**——未配置即槽位空；key = auth.json
 * 同键位，换模型换 key 自动跟随）。可用性判别（isAvailable）三条件收口：
 * 管家开关开（分诊是管家子功能，管家关 = 随关）∧ 任务总结开关开 ∧ 模型
 * 槽位非空——任一断点 → false → StewardPerceptionService 零 LLM 降级
 * （极简终态语音通知）。**激活判定不在此处**（D12-⑪：归感知服务单点）。
 *
 * 防腐面：{systemPrompt, userPrompt} → StewardLlmRequest（messages 恰一条
 * user、tools 空——分诊无工具面无会话史，单发无状态）；text 响应经
 * parseDiagnosis JSON 容错解析（TR-234 parseJointSummary 同族三重容错：
 * ```json 围栏剥壳 + 首尾大括号定位 + 字段缺席容忍），烂输出 throw（感知
 * 服务静默降级不播半产物）；toolCall 响应（tools 空下不应发生）→ throw。
 *
 * 取代 StewardVoiceSummarizerAdapter（③层独立摘要调用归一退役——
 * BroadcastService 不再自持 LLM 面）。
 */
import type { StewardLlmPort } from "../../../application/ports/outbound/StewardLlmPort";
import { firstToolCallBlock, stewardBlocksText } from "../../../application/steward/stewardBlocks";
import type {
  StewardDiagnosisPort,
  StewardDiagnosisPrompt,
  StewardDiagnosisResult,
  StewardDiagnosisSuggestion,
} from "../../../application/ports/outbound/StewardDiagnosisPort";

export interface StewardDiagnosisAdapterDeps {
  /** 管家 LLM 面（组合根注入 PiStewardLlmAdapter 真体——模型槽位/key 同源
   *  steward.summary.model 专用槽位）。 */
  readonly llm: StewardLlmPort;
  /** 管家开关 ∧ 任务总结开关读面（分诊 gate 前两条件——模型槽位第三条件
   *  经 llm.modelId 判空收口）。 */
  readonly enabled: () => boolean;
}

/**
 * 分诊产物 JSON 解析（三重容错——TR-234 parseJointSummary 同族）：
 * ① ```json 围栏剥壳；② 首尾大括号定位（前后噪声容忍）；③ 字段缺席/
 * 类型错位容忍（notify 缺省 true、urgency 非 high 判 normal、present/ingest
 * 非空 string 守卫、suggestions 数组项 label 守卫）。解析不出 JSON 对象 →
 * undefined（烂输出整体丢弃，调用方 throw 降级——零半产物）。
 */
export function parseDiagnosis(text: string): StewardDiagnosisResult | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  // ① ```json 围栏剥壳
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced !== null ? fenced[1]! : trimmed;
  // ② 首尾大括号定位（容忍前后噪声）
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  // ③ 字段守卫（缺席容忍 + 类型错位回缺省）
  const present = typeof obj.present === "string" ? obj.present.trim() : "";
  const ingest = typeof obj.ingest === "string" ? obj.ingest.trim() : "";
  if (present === "" && ingest === "") return undefined; // 双轨全空 = 无效产物
  const rawSuggestions = Array.isArray(obj.suggestions) ? obj.suggestions : [];
  const suggestions: StewardDiagnosisSuggestion[] = [];
  for (const s of rawSuggestions) {
    if (typeof s === "object" && s !== null && typeof (s as { label?: unknown }).label === "string") {
      const label = (s as { label: string }).label.trim();
      if (label !== "") suggestions.push({ label });
    }
    if (suggestions.length >= 3) break; // prompt 约束外的机械上限
  }
  return {
    notify: obj.notify !== false, // 缺省值得打扰（false 显式静默）
    urgency: obj.urgency === "high" ? "high" : "normal",
    present,
    ingest,
    suggestions,
  };
}

export class StewardDiagnosisAdapter implements StewardDiagnosisPort {
  private readonly deps: StewardDiagnosisAdapterDeps;

  constructor(deps: StewardDiagnosisAdapterDeps) {
    this.deps = deps;
  }

  isAvailable(): boolean {
    return this.deps.enabled() && this.deps.llm.modelId.trim() !== "";
  }

  async diagnose(prompt: StewardDiagnosisPrompt): Promise<StewardDiagnosisResult> {
    const response = await this.deps.llm.complete({
      systemPrompt: prompt.systemPrompt,
      messages: [{ role: "user", text: prompt.userPrompt }],
      tools: [],
    });
    if (response.kind === "aborted") {
      // 本面不传 signal，aborted 结构性不可达——防御分支（不静默）
      throw new Error("分诊面收到意外的 aborted 判别（不传 signal 不应发生）");
    }
    // tools 为空，块集不应含 toolCall 块——防御分支（不静默）
    const toolCallBlock = firstToolCallBlock(response.blocks);
    if (toolCallBlock !== undefined) {
      throw new Error(`分诊面收到意外的工具调用（${toolCallBlock.name}——tools 为空不应发生）`);
    }
    const parsed = parseDiagnosis(stewardBlocksText(response.blocks));
    if (parsed === undefined) {
      throw new Error("分诊产物 JSON 解析失败（烂输出整体丢弃——不播半产物）");
    }
    return parsed;
  }
}
