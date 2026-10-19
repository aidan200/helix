/**
 * DashScope STT adapter（driven；语音输入批 V1 主选 provider）。
 *
 * 模型 qwen-audio-3.0-asr-flash（Phase 0 查证主选：即时热词 ≤2000 词内联
 * + 上下文增强 ≤400 字符/轮双通道叠加、免费热词；计费 0.00022 元/秒）。
 *
 * 音频传递形态（fix/stt-oss-upload 实测修正——data URL 直传已被证伪）：
 * - data URL 直传 input_audio.data 实测挂死：服务端把 `data:` 当下载 URL 拉取，
 *   两种端点均超时（主会话冒烟结论）；
 * - 正确链路 = OSS 三步上传 + oss:// 引用（dashscope Python SDK 1.27.6
 *   oss_utils.upload 同构，全链路 SDK + 裸 HTTP 复刻双验证）：
 *   ① GET /api/v1/uploads?action=getPolicy&model=<asr> → {data:{policy,
 *      signature, upload_dir, upload_host, oss_access_key_id,
 *      x_oss_object_acl, x_oss_forbid_overwrite}}；
 *   ② multipart POST upload_host，字段序（file 必须最后）：
 *      OSSAccessKeyId（带 d）/Signature/policy/key=<upload_dir>/<filename>/
 *      x-oss-object-acl/x-oss-forbid-overwrite/success_action_status=200/
 *      x-oss-content-type/<file>——policy conditions 强制要求 acl 与
 *      forbid-overwrite 字段（缺省 403）；success_action_status=200 把
 *      OSS 默认 204 改成 200 便于判错；
 *   ③ 生成请求引用 "oss://" + upload_dir + "/" + filename（SDK 铁证形态，
 *      不是 https 域名），且 content 元素形态必须是 {audio:"oss://…"}
 *      并携带 X-DashScope-OssResourceResolve: enable 头——实测矩阵
 *      （docs/temp/stt-oss-fix/matrix-run.log）：
 *      · {audio:oss://} 无 resolve 头 → FILE_DOWNLOAD_FAILED exit code 1
 *        （服务端把 oss:// 当普通 URL 下载，private 对象拉不到——主会话
 *        「未解之坑」的根因）；
 *      · {input_audio:{url:oss://}} 带/不带头 → DecodePost resample 500
 *        （该形态仅配公网 https URL）。
 *
 * 上下文注入：system 前置消息 content:[{text}]（≤400 字符——VocabularyBuilder
 * 350 预算即为此设计）；即时热词 parameters.vocabulary = {词: weight}
 * （weight [1,5]，免费、纯请求期内联——契合「不落地不常驻」）。
 *
 * key：组合根 getter（auth.json provider id "dashscope"，对齐
 * model-provider.ts explicitGetApiKey 先例——换 key 后自动跟随）；缺 key
 * fail-fast 抛中文错误（指向设置页 auth.set_key 录入路径）。
 */
import type { SttPort, SttRequest, SttResult } from "../../../application/ports/outbound/SttPort";
import { DEFAULT_VOICE_MODEL_CONFIG } from "../../../application/voice/voiceModelConfig";

/** DashScope 多模态生成端点（通用域名）。 */
const DASHSCOPE_MULTIMODAL_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

/** DashScope 上传 policy 端点（GET action=getPolicy）。 */
const DASHSCOPE_UPLOADS_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/uploads";

/** 单次 HTTP 超时（F2 #24）：三处 fetch（getPolicy/OSS 上传/生成）都必须可中断——
 *  上游挂起时 transcribe 不能永久悬挂（语音输入要回错误而不是无声等待）。
 *  取值参考同仓 embedding/judge 适配器的 15s 纪律，音频上传/转写体量更大取 30s。 */
const STT_HTTP_TIMEOUT_MS = 30_000;

/** V1 主选 ASR 模型（qwen-audio-3.0-asr-flash：即时热词 + 上下文双通道）。
 *  别名 = voiceModelConfig 默认值单源字段（模型配置接入 P0；getModel 可覆盖）。 */
export const DASHSCOPE_ASR_MODEL = DEFAULT_VOICE_MODEL_CONFIG.sttModel;

/** auth.json provider id（设置页 key 录入的 provider 位）。 */
export const DASHSCOPE_PROVIDER_ID = "dashscope";

/** data URL mime → DashScope parameters.format（容器格式声明；兼作上传文件扩展名）。 */
function formatOfMime(mime: string): string {
  if (mime.startsWith("audio/webm")) return "webm";
  if (mime.startsWith("audio/mp4") || mime.startsWith("audio/m4a")) return "mp4";
  if (mime.startsWith("audio/wav")) return "wav";
  if (mime.startsWith("audio/mp3")) return "mp3";
  return "webm"; // 兜底（MediaRecorder 首选 webm/opus——spike 实测支持面）
}

/** base64 data URL → {bytes, mime}（与 siliconflow decodeDataUrl 同构的本地副本——adapter 间不互相 import）。 */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const head = /^data:([^;,]+)/.exec(dataUrl);
  const payload = /;base64,([\s\S]+)$/.exec(dataUrl);
  if (head === null || payload === null) {
    throw new Error("音频载荷应为 base64 data URL（data:audio/…;base64,…）");
  }
  const mime = head[1] ?? "application/octet-stream";
  const bytes = Uint8Array.from(atob(payload[1] ?? ""), (c) => c.charCodeAt(0));
  return { bytes, mime };
}

/** getPolicy 响应 data 体（OSS PostObject 上传凭证；expire_in_seconds 实测 300s）。 */
interface UploadPolicy {
  policy: string;
  signature: string;
  upload_dir: string;
  upload_host: string;
  oss_access_key_id: string;
  x_oss_object_acl?: string;
  x_oss_forbid_overwrite?: string;
}

/** DashScope 错误体（HTTP 非 2xx 时 body 携带；request_id 供排查）。 */
interface DashScopeErrorBody {
  code?: string;
  message?: string;
  request_id?: string;
}

/** DashScope 成功体（text 直挂 output 或多模态 choices 形态——demo extract_text 双轨）。 */
interface DashScopeOkBody {
  output?: {
    text?: string;
    sentence?: { text?: string };
    choices?: { message?: { content?: { text?: string }[] } }[];
  };
  code?: string;
  message?: string;
}

export interface DashScopeSttDeps {
  /** 当前 provider key getter（组合根注入 authStore.apiKeyOf；每次调用重读）。 */
  readonly getApiKey: () => string | undefined;
  /** 模型 id getter（可选——模型配置接入 P0；每次调用读现值，改配置即热；
   *  空/undefined 回落 DASHSCOPE_ASR_MODEL 默认）。 */
  readonly getModel?: () => string | undefined;
  /** fetch 注入（测试 fetch 层断言用；缺省 globalThis.fetch）。 */
  readonly fetchFn?: typeof fetch;
}

export class DashScopeSttAdapter implements SttPort {
  readonly providerId = DASHSCOPE_PROVIDER_ID;
  private readonly getApiKey: () => string | undefined;
  private readonly getModel: (() => string | undefined) | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(deps: DashScopeSttDeps) {
    this.getApiKey = deps.getApiKey;
    this.getModel = deps.getModel;
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
  }

  /** 生效模型 id（配置值优先；空/未配回落默认常量）。 */
  private effectiveModel(): string {
    return this.getModel?.()?.trim() || DASHSCOPE_ASR_MODEL;
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    const apiKey = this.getApiKey();
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        `auth.json 中没有 provider "${DASHSCOPE_PROVIDER_ID}" 的 API key（请经设置页语音输入区 auth.set_key 录入；显式传入，不走环境变量）`,
      );
    }

    const { bytes, mime } = decodeDataUrl(request.audio);
    const ossUrl = await this.uploadToOss(apiKey, bytes, mime);

    // 双通道注入（设计 §5.6）：system 前置消息（上下文增强）+ 即时热词
    const messages: unknown[] = [];
    if (request.context.hint !== "") {
      messages.push({
        role: "system",
        content: [{ text: request.context.hint }],
      });
    }
    messages.push({
      role: "user",
      content: [{ audio: ossUrl }],
    });
    const vocabulary: Record<string, number> = {};
    for (const t of request.context.terms) vocabulary[t.term] = t.weight;
    const body: Record<string, unknown> = {
      model: this.effectiveModel(),
      input: { messages },
      parameters: {
        format: formatOfMime(mime),
        timestamp_granularities: [],
        ...(Object.keys(vocabulary).length > 0 ? { vocabulary } : {}),
        ...(request.language !== undefined ? { language: request.language } : {}),
      },
    };

    const res = await this.fetchFn(DASHSCOPE_MULTIMODAL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "disable",
        // oss:// 引用必须携带：无此头服务端把 oss:// 当普通 URL 下载（private 拉不到→FILE_DOWNLOAD_FAILED）
        "X-DashScope-OssResourceResolve": "enable",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STT_HTTP_TIMEOUT_MS),
    });
    const parsed = (await res.json().catch(() => ({}))) as DashScopeOkBody & DashScopeErrorBody;
    if (!res.ok) {
      throw new Error(
        `DashScope 转写失败（HTTP ${res.status}${parsed.code !== undefined ? ` ${parsed.code}` : ""}）：${parsed.message ?? "响应不可解析"}`,
      );
    }
    if (parsed.code !== undefined) {
      // 200 + 业务错误码形态（DashScope 部分错误走 200 体）
      throw new Error(`DashScope 转写失败（${parsed.code}）：${parsed.message ?? "未知错误"}`);
    }
    // 双轨文本提取（demo extract_text 同构：output.text 优先，sentence/多模态 choices 兜底）
    const text =
      parsed.output?.text ??
      parsed.output?.sentence?.text ??
      parsed.output?.choices?.[0]?.message?.content?.[0]?.text ??
      "";
    if (text === "") {
      throw new Error("DashScope 转写返回空文本（音频过短或无法识别）");
    }
    return { text, ...(request.language !== undefined ? { language: request.language } : {}) };
  }

  /**
   * OSS 三步上传（SDK oss_utils.upload 同构）：
   * ① GET getPolicy（Bearer 鉴权）→ ② multipart POST upload_host（file 字段必须最后）
   * → 返回 "oss://" + upload_dir + "/" + filename 引用。
   */
  private async uploadToOss(apiKey: string, bytes: Uint8Array, mime: string): Promise<string> {
    const policyRes = await this.fetchFn(
      `${DASHSCOPE_UPLOADS_ENDPOINT}?action=getPolicy&model=${encodeURIComponent(this.effectiveModel())}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(STT_HTTP_TIMEOUT_MS),
      },
    );
    const policyParsed = (await policyRes.json().catch(() => ({}))) as {
      data?: UploadPolicy;
    } & DashScopeErrorBody;
    if (!policyRes.ok || policyParsed.data === undefined) {
      throw new Error(
        `DashScope 上传凭证获取失败（HTTP ${policyRes.status}${policyParsed.code !== undefined ? ` ${policyParsed.code}` : ""}）：${policyParsed.message ?? "响应不可解析"}`,
      );
    }
    const p = policyParsed.data;

    // 文件名：stt-<时间戳>-<随机>.<扩展>（x-oss-forbid-overwrite=true 要求 key 唯一）
    const ext = formatOfMime(mime);
    const filename = `stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const key = `${p.upload_dir}/${filename}`;

    // 字段序对齐 SDK（file 必须最后）；policy conditions 强制 acl/forbid-overwrite 字段
    const form = new FormData();
    form.append("OSSAccessKeyId", p.oss_access_key_id);
    form.append("Signature", p.signature);
    form.append("policy", p.policy);
    form.append("key", key);
    form.append("x-oss-object-acl", p.x_oss_object_acl ?? "private");
    form.append("x-oss-forbid-overwrite", p.x_oss_forbid_overwrite ?? "true");
    form.append("success_action_status", "200");
    form.append("x-oss-content-type", mime);
    form.append("file", new Blob([bytes], { type: mime }), filename);

    const upRes = await this.fetchFn(p.upload_host, {
      method: "POST",
      headers: { Accept: "application/json", Date: new Date().toUTCString() },
      body: form,
      signal: AbortSignal.timeout(STT_HTTP_TIMEOUT_MS),
    });
    if (!upRes.ok) {
      const detail = await upRes.text().catch(() => "");
      throw new Error(
        `DashScope 音频上传失败（HTTP ${upRes.status}）：${detail.slice(0, 200) || "响应不可解析"}`,
      );
    }
    return `oss://${key}`;
  }
}
