/**
 * STT adapter fetch 层注入形态单测（语音输入批 V1；TDD 红绿证据链）。
 *
 * 断言面（任务要求「fetch 层断言热词参数与前置消息」）：
 * 1. DashScope 双通道：parameters.vocabulary = {词: weight}（即时热词）+
 *    input.messages 前置 user {type:"input_text"} 消息（上下文增强 ≤400 字符）
 *    + 末位 input_audio 消息 + Bearer key + qwen-audio-3.0-asr-flash；
 * 2. DashScope 响应双轨解析（output.text 优先 / choices[0].message.content
 *    兜底）+ 业务错误码（200 + code）+ HTTP 错误 + 空 key fail-fast；
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

describe("DashScopeSttAdapter：双通道注入形态（fetch 层断言）", () => {
  test("即时热词 parameters.vocabulary + 前置 input_text 消息 + input_audio 末位", async () => {
    const { calls, fetchFn } = captureFetch(() => ({ output: { text: "把 useEffect 修一下" } }));
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "sk-dash", fetchFn });
    const out = await adapter.transcribe({
      audio: AUDIO,
      language: "zh",
      context: ctxOf([["useEffect", 3], ["Tauri", 3]]),
    });
    expect(out.text).toBe("把 useEffect 修一下");
    expect(out.language).toBe("zh");

    expect(calls.length).toBe(1);
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      model: string;
      input: { messages: { role: string; content: { type: string; text?: string; input_audio?: { data: string } }[] }[] };
      parameters: { format: string; vocabulary: Record<string, number>; language?: string };
    };
    // ① 模型位
    expect(body.model).toBe(DASHSCOPE_ASR_MODEL);
    expect(body.model).toBe("qwen-audio-3.0-asr-flash");
    // ② 前置文本消息（上下文增强通道——紧凑词表串）
    const first = body.input.messages[0]!;
    expect(first.role).toBe("user");
    expect(first.content[0]!.type).toBe("input_text");
    expect(first.content[0]!.text).toBe("useEffect, Tauri");
    // ③ 末位音频消息（base64 data URL 原样）
    const last = body.input.messages[body.input.messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content[0]!.type).toBe("input_audio");
    expect(last.content[0]!.input_audio!.data).toBe(AUDIO);
    // ④ 即时热词通道（词 → weight 键值对）
    expect(body.parameters.vocabulary).toEqual({ useEffect: 3, Tauri: 3 });
    expect(body.parameters.format).toBe("webm");
    expect(body.parameters.language).toBe("zh");
    // ⑤ 鉴权头
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-dash");
    expect(calls[0]!.url).toContain("dashscope.aliyuncs.com");
  });

  test("空词表上下文：无前置消息、无 vocabulary 键（裸转写）", async () => {
    const { calls, fetchFn } = captureFetch(() => ({ output: { text: "你好" } }));
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } });
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      input: { messages: unknown[] };
      parameters: Record<string, unknown>;
    };
    expect(body.input.messages.length).toBe(1); // 仅音频消息
    expect("vocabulary" in body.parameters).toBe(false);
  });

  test("响应双轨：output.text 缺席时走 choices[0].message.content[0].text", async () => {
    const { fetchFn } = captureFetch(() => ({
      output: { choices: [{ message: { content: [{ text: "choices 轨文本" }] } }] },
    }));
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "k", fetchFn });
    const out = await adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } });
    expect(out.text).toBe("choices 轨文本");
  });

  test("200 + 业务错误码形态 → 中文错误；HTTP 错误 → 含状态码", async () => {
    const errFetch = (async () =>
      new Response(JSON.stringify({ code: "InvalidApiKey", message: "Invalid API-key" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const adapter = new DashScopeSttAdapter({ getApiKey: () => "k", fetchFn: errFetch });
    await expect(adapter.transcribe({ audio: AUDIO, context: { terms: [], hint: "" } })).rejects.toThrow(
      "DashScope 转写失败（InvalidApiKey）",
    );
    const httpFetch = (async () =>
      new Response(JSON.stringify({ code: "Throttling", message: "限流" }), { status: 429 })) as unknown as typeof fetch;
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
