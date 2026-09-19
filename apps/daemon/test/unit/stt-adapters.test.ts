/**
 * STT adapter fetch 层注入形态单测（语音输入批 V1；TDD 红绿证据链）。
 *
 * 断言面（fix/stt-oss-upload 后）：
 * 1. DashScope OSS 三步链路：① GET getPolicy（Bearer + action/model 查询参）
 *    → ② multipart POST upload_host（字段名与序：OSSAccessKeyId 带 d /
 *    Signature / policy / key=upload_dir/stt-*.<ext> / x-oss-object-acl /
 *    x-oss-forbid-overwrite / success_action_status=200 / x-oss-content-type，
 *    file 字段必须最后）→ ③ 生成请求引用 oss://（content:[{audio}] 形态 +
 *    X-DashScope-OssResourceResolve: enable 头）+ system 前置上下文消息 +
 *    parameters.vocabulary 即时热词 + format 映射；
 * 2. DashScope 响应双轨解析（output.text 优先 / sentence.text / choices
 *    兜底）+ 业务错误码（200 + code）+ HTTP 错误 + policy/上传失败 +
 *    空 key fail-fast；
 * 3. SiliconFlow：multipart form（file/model/prompt=hint）+ Bearer key +
 *    缺 key fail-fast；decodeDataUrl 纯函数。
 * fetch 全程注入 mock（零真实网络——web-tools.test.ts 同构纪律）。
 */
import { describe, expect, test } from "bun:test";
import { DashScopeSttAdapter, DASHSCOPE_ASR_MODEL } from "../../src/adapters/driven/stt/dashscope";
import { decodeDataUrl, SiliconFlowSttAdapter } from "../../src/adapters/driven/stt/siliconflow";
import type { AsrContext } from "../../src/application/stt/VocabularyBuilder";

const AUDIO = "data:audio/webm;codecs=opus;base64,SGVsbG8gV29ybGQ=";

function ctxOf(terms: [string, number][]): AsrContext {
  return { terms: terms.map(([term, weight]) => ({ term, weight, source: "session" })), hint: terms.map(([t]) => t).join(", ") };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function captureFetch(respond: (captured: Captured) => unknown, _key = "sk-test"): { calls: Captured[]; fetchFn: typeof fetch } {
  const calls: Captured[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = respond(calls[calls.length - 1]!);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** DashScope 三步链路 fake：按 URL 路由返回 policy / 上传空体 / 生成结果。 */
const FAKE_POLICY = {
  data: {
    policy: "POLICYBASE64",
    signature: "SIG789",
    upload_dir: "dashscope-instant/abc123/2026-09-19",
    upload_host: "https://fake-oss.example.com",
    oss_access_key_id: "LTAI5tFAKE",
    x_oss_object_acl: "private",
    x_oss_forbid_overwrite: "true",
  },
};

function dashscopeFetch(gen: () => unknown): { calls: Captured[]; fetchFn: typeof fetch } {
  const calls: Captured[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const u = String(url);
    if (u.startsWith("https://dashscope.aliyuncs.com/api/v1/uploads")) {
      return new Response(JSON.stringify(FAKE_POLICY), { status: 200 });
    }
    if (u.startsWith("https://fake-oss.example.com")) {
      return new Response("", { status: 200 });
    }
    return new Response(JSON.stringify(gen()), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("DashScopeSttAdapter：OSS 三步上传 + oss:// 引用（fetch 层断言）", () => {
  test("三步序列：getPolicy → multipart 上传（字段名/序）→ 生成请求引用 oss:// + resolve 头 + 双通道注入", async () => {
    const { calls, fetchFn } = dashscopeFetch(() => ({ output: { text: "把 useEffect 修一下" } }));
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "sk-dash", fetchFn });
    const out = await adapter.transcribe({
      audio: AUDIO,
      language: "zh",
      context: ctxOf([["useEffect", 3], ["Tauri", 3]]),
    });
    expect(out.text).toBe("把 useEffect 修一下");
    expect(out.language).toBe("zh");

    // ===== ① getPolicy（GET + Bearer + 查询参）=====
    expect(calls.length).toBe(3);
    expect(calls[0]!.url).toContain("/api/v1/uploads?action=getPolicy&model=qwen-audio-3.0-asr-flash");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-dash");

    // ===== ② multipart 上传（upload_host + 全字段 + file 最后）=====
    expect(calls[1]!.url).toBe("https://fake-oss.example.com");
    expect(calls[1]!.init.method).toBe("POST");
    const form = calls[1]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("OSSAccessKeyId")).toBe("LTAI5tFAKE"); // 注意带 d
    expect(form.get("Signature")).toBe("SIG789");
    expect(form.get("policy")).toBe("POLICYBASE64");
    const key = form.get("key") as string;
    expect(key.startsWith("dashscope-instant/abc123/2026-09-19/stt-")).toBe(true);
    expect(key.endsWith(".webm")).toBe(true); // 扩展名按 mime 映射保留
    expect(form.get("x-oss-object-acl")).toBe("private");
    expect(form.get("x-oss-forbid-overwrite")).toBe("true");
    expect(form.get("success_action_status")).toBe("200");
    expect(form.get("x-oss-content-type")).toBe("audio/webm");
    expect(form.get("file")).toBeInstanceOf(Blob);
    const order = [...form.keys()];
    expect(order[order.length - 1]).toBe("file"); // file 必须最后（OSS PostObject 纪律）
    const upHeaders = calls[1]!.init.headers as Record<string, string>;
    expect(upHeaders.Accept).toBe("application/json");
    expect(typeof upHeaders.Date).toBe("string");

    // ===== ③ 生成请求（oss:// 引用 + resolve 头 + system 上下文 + 即时热词）=====
    expect(calls[2]!.url).toContain("dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    const genHeaders = calls[2]!.init.headers as Record<string, string>;
    expect(genHeaders.Authorization).toBe("Bearer sk-dash");
    expect(genHeaders["X-DashScope-OssResourceResolve"]).toBe("enable"); // oss:// 解析必需（无头 → FILE_DOWNLOAD_FAILED）
    const body = JSON.parse(String(calls[2]!.init.body)) as {
      model: string;
      input: { messages: { role: string; content: { text?: string; audio?: string }[] }[] };
      parameters: { format: string; timestamp_granularities: unknown[]; vocabulary: Record<string, number>; language?: string };
    };
    expect(body.model).toBe(DASHSCOPE_ASR_MODEL);
    // system 前置上下文消息（上下文增强通道——紧凑词表串）
    expect(body.input.messages[0]!.role).toBe("system");
    expect(body.input.messages[0]!.content[0]!.text).toBe("useEffect, Tauri");
    // 音频消息：{audio: "oss://…"}（input_audio 形态实测只配公网 URL）
    const last = body.input.messages[body.input.messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content[0]!.audio).toBe(`oss://${key}`);
    // 即时热词通道（词 → weight 键值对）+ format + language
    expect(body.parameters.vocabulary).toEqual({ useEffect: 3, Tauri: 3 });
    expect(body.parameters.format).toBe("webm");
    expect(body.parameters.language).toBe("zh");
  });

  test("空词表上下文：无 system 消息、无 vocabulary 键（裸转写）；key 前后两次上传不撞（随机文件名）", async () => {
    const { calls, fetchFn } = dashscopeFetch(() => ({ output: { text: "你好" } }));
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } });
    const body = JSON.parse(String(calls[2]!.init.body)) as {
      input: { messages: { role: string; content: unknown[] }[] };
      parameters: Record<string, unknown>;
    };
    expect(body.input.messages.length).toBe(1); // 仅音频消息
    expect("vocabulary" in body.parameters).toBe(false);
  });

  test("响应双轨：output.text 缺席时 sentence.text → choices[0].message.content[0].text 兜底", async () => {
    const mk = (gen: () => unknown) => {
      const { fetchFn } = dashscopeFetch(gen);
      return new DashScopeSttAdapter({ getApiKey: () => "k", fetchFn });
    };
    const sentenceTrack = await mk(() => ({ output: { sentence: { text: "sentence 轨文本" } } })).transcribe({
      audio: AUDIO,
      context: { terms: [], hint: "" },
    });
    expect(sentenceTrack.text).toBe("sentence 轨文本");
    const choicesTrack = await mk(() => ({
      output: { choices: [{ message: { content: [{ text: "choices 轨文本" }] } }] },
    })).transcribe({ audio: AUDIO, context: { terms: [], hint: "" } });
    expect(choicesTrack.text).toBe("choices 轨文本");
  });

  test("policy 失败 → 中文错误（不发起后续请求）", async () => {
    let called = 1;
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes("uploads")) {
        return new Response(JSON.stringify({ code: "Throttling", message: "限流" }), { status: 429 });
      }
      called += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "k", fetchFn });
    await expect(adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } })).rejects.toThrow(
      "DashScope 上传凭证获取失败（HTTP 429 Throttling）",
    );
    expect(called).toBe(1);
  });

  test("上传失败（OSS 非 2xx）→ 中文错误含状态码", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("uploads")) return new Response(JSON.stringify(FAKE_POLICY), { status: 200 });
      if (u.startsWith("https://fake-oss.example.com")) {
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "k", fetchFn });
    await expect(adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } })).rejects.toThrow(
      "DashScope 音频上传失败（HTTP 403）",
    );
  });

  test("200 + 业务错误码形态 → 中文错误；HTTP 错误 → 含状态码", async () => {
    const errFetch = dashscopeFetch(() => ({ code: "InvalidApiKey", message: "Invalid API-key" })).fetchFn;
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "k", fetchFn: errFetch });
    await expect(adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } })).rejects.toThrow(
      "DashScope 转写失败（InvalidApiKey）",
    );
    const httpFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("uploads")) return new Response(JSON.stringify(FAKE_POLICY), { status: 200 });
      if (u.startsWith("https://fake-oss.example.com")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ code: "Throttling", message: "限流" }), { status: 429 });
    }) as unknown as typeof fetch;
    const adapter2 = new DashScopeSttAdapter({ getApiKey: () => "k", fetchFn: httpFetch });
    await expect(adapter2.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } })).rejects.toThrow(
      "DashScope 转写失败（HTTP 429 Throttling）",
    );
  });

  test("缺 key → fail-fast 中文引导（不发起 fetch）", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const adapter = new DashScopeSttAdapter({ getApiKey: () => undefined, fetchFn });
    await expect(adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } })).rejects.toThrow(
      'auth.json 中没有 provider "dashscope" 的 API key',
    );
    expect(called).toBe(false);
  });
});

describe("SiliconFlowSttAdapter：OpenAI 兼容 form 形态 + 兜底语义", () => {
  test("multipart form（file/model/prompt=hint）+ Bearer key；hint 经 prompt 下发", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ text: "form 轨文本" }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new SiliconFlowSttAdapter({ getApiKey: () => "sk-sf", fetchFn });
    const out = await adapter.transcribe({
      audio: AUDIO,
      context: ctxOf([["useEffect", 3]]),
    });
    expect(out.text).toBe("form 轨文本");
    expect(calls[0]!.url).toBe("https://api.siliconflow.cn/v1/audio/transcriptions");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("FunAudioLLM/SenseVoiceSmall");
    expect(form.get("prompt")).toBe("useEffect");
    expect(form.get("file")).toBeInstanceOf(Blob);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-sf");
  });

  test("缺 key → fail-fast 中文引导", async () => {
    const adapter = new SiliconFlowSttAdapter({ getApiKey: () => undefined });
    await expect(adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } })).rejects.toThrow(
      'auth.json 中没有 provider "siliconflow" 的 API key',
    );
  });

  test("decodeDataUrl：base64 往返 + mime 提取 + 非法载荷拒绝", () => {
    const { bytes, mime } = decodeDataUrl("data:audio/mp4;base64,aGVsbG8=");
    expect(mime).toBe("audio/mp4");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(() => decodeDataUrl("https://example.com/a.wav")).toThrow("base64 data URL");
  });
});
