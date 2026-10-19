/**
 * TTS adapter fetch 层注入形态单测（语音播报批 V2；TDD 红绿证据链）。
 *
 * 断言面（端点事实经真实 key 冒烟钉死——docs/temp/tts-smoke/）：
 * 1. 两步链路：① POST multimodal-generation（Bearer + JSON body：
 *    model=qwen3-tts-flash / input.text / input.voice / input.language_type）
 *    → ② GET output.audio.url（OSS 签名公开可下）→ base64 data URL 产物
 *    （data:audio/wav;base64,…）；
 * 2. 错误双轨：HTTP 非 2xx（400 InvalidParameter / 401 InvalidApiKey——
 *    code+message 上抛中文错误）+ 200 体携带 code（DashScope 部分错误走
 *    200 体）+ 成功体无 url（形态漂移防御）+ 下载失败；
 * 3. 空 key fail-fast（中文引导指向设置页 auth.set_key 录入路径）；
 * 4. voice/language 可选位缺省形态（voice 不带 / language_type 缺省 zh）。
 * fetch 全程注入 mock（零真实网络——stt-adapters.test.ts 同构纪律）。
 */
import { describe, expect, test } from "bun:test";
import { DashScopeTtsAdapter, DASHSCOPE_TTS_MODEL, DASHSCOPE_TTS_DEFAULT_VOICE } from "../../src/adapters/driven/tts/dashscope";

const GEN_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const AUDIO_URL = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/prod/tts/fake.wav?Signature=abc";

interface Captured {
  url: string;
  init: RequestInit;
}

/** 两步 fake：生成端点回 JSON、音频 URL 回二进制 WAV 字节。 */
function ttsFetch(genBody: () => unknown, audioBytes = "RIFF-fake-wav", genStatus = 200): { calls: Captured[]; fetchFn: typeof fetch } {
  const calls: Captured[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const u = String(url);
    if (u.startsWith(GEN_URL)) {
      return new Response(JSON.stringify(genBody()), { status: genStatus, headers: { "Content-Type": "application/json" } });
    }
    if (u === AUDIO_URL) {
      return new Response(audioBytes, { status: 200 });
    }
    return new Response(JSON.stringify({ error: `unexpected url ${u}` }), { status: 500 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const okBody = () => ({
  output: { audio: { data: "", url: AUDIO_URL, expires_at: 1789885870 }, finish_reason: "stop" },
  usage: { characters: 18 },
  request_id: "req-fake",
});

describe("DashScopeTtsAdapter：两步 HTTP 合成（fetch 层断言）", () => {
  test("两步序列：POST 生成（model/text/voice/language_type）→ GET 音频 URL → data:audio/wav base64", async () => {
    const { calls, fetchFn } = ttsFetch(okBody);
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", fetchFn });
    const out = await adapter.synthesize({ text: "播报测试", voice: "Cherry", language: "zh" });

    expect(calls.length).toBe(2);
    // ① 生成请求形态
    const gen = calls[0]!;
    expect(gen.url).toBe(GEN_URL);
    expect(gen.init.method).toBe("POST");
    const headers = gen.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-dash");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(gen.init.body)) as {
      model: string; input: { text: string; voice?: string; language_type?: string };
    };
    expect(body.model).toBe(DASHSCOPE_TTS_MODEL);
    expect(body.model).toBe("qwen3-tts-flash");
    expect(body.input.text).toBe("播报测试");
    expect(body.input.voice).toBe("Cherry");
    expect(body.input.language_type).toBe("zh");
    // ② 音频下载（GET、无鉴权头——OSS 签名 URL 公开可下）
    const dl = calls[1]!;
    expect(dl.url).toBe(AUDIO_URL);
    expect(dl.init.method).toBe("GET");
    // 产物 = data URL
    expect(out.audio.startsWith("data:audio/wav;base64,")).toBe(true);
    // base64 解码还原 WAV 头
    const b64 = out.audio.slice("data:audio/wav;base64,".length);
    expect(atob(b64)).toBe("RIFF-fake-wav");
  });

  test("voice 缺省 = 默认音色 Cherry；language 缺省 = zh（body 仍带默认值）", async () => {
    const { calls, fetchFn } = ttsFetch(okBody);
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await adapter.synthesize({ text: "你好" });
    const body = JSON.parse(String(calls[0]!.init.body)) as { input: { voice?: string; language_type?: string } };
    expect(body.input.voice).toBe(DASHSCOPE_TTS_DEFAULT_VOICE);
    expect(body.input.language_type).toBe("zh");
  });

  test("空 key fail-fast：中文引导指向设置页录入路径", async () => {
    const { fetchFn } = ttsFetch(okBody);
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => undefined, fetchFn });
    await expect(adapter.synthesize({ text: "测试" })).rejects.toThrow(/dashscope.*API key|API key.*dashscope/s);
    await expect(adapter.synthesize({ text: "测试" })).rejects.toThrow(/auth\.set_key|设置页/);
  });

  test("错误双轨①：HTTP 400 InvalidParameter（code+message 上抛）", async () => {
    const { fetchFn } = ttsFetch(() => ({ code: "InvalidParameter", message: "Model not exist.", request_id: "r1" }), "", 400);
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await expect(adapter.synthesize({ text: "测试" })).rejects.toThrow(/400.*InvalidParameter.*Model not exist/s);
  });

  test("错误双轨②：HTTP 401 InvalidApiKey", async () => {
    const { fetchFn } = ttsFetch(() => ({ code: "InvalidApiKey", message: "Invalid API-key provided.", request_id: "r2" }), "", 401);
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await expect(adapter.synthesize({ text: "测试" })).rejects.toThrow(/401.*InvalidApiKey/s);
  });

  test("错误双轨③：200 体携带 code（DashScope 部分错误走 200 体）", async () => {
    const { fetchFn } = ttsFetch(() => ({ code: "InvalidParameter", message: "Invalid voice specified", request_id: "r3" }));
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await expect(adapter.synthesize({ text: "测试" })).rejects.toThrow(/Invalid voice specified/);
  });

  test("错误双轨④：成功体无 url（形态漂移防御）", async () => {
    const { fetchFn } = ttsFetch(() => ({ output: { audio: { data: "" } }, request_id: "r4" }));
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await expect(adapter.synthesize({ text: "测试" })).rejects.toThrow(/url/);
  });

  test("错误双轨⑤：下载失败（OSS GET 非 2xx）", async () => {
    const calls: Captured[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).startsWith(GEN_URL)) return new Response(JSON.stringify(okBody()), { status: 200 });
      return new Response("gone", { status: 404 });
    }) as typeof fetch;
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await expect(adapter.synthesize({ text: "测试" })).rejects.toThrow(/下载失败.*404/s);
  });

  // 评审 F2 #26：生成与音频下载两处 fetch 均无超时——任一环节挂起即播报链永久悬挂。
  test("两处 fetch 均带超时 signal（生成 + 下载）", async () => {
    const { calls, fetchFn } = ttsFetch(okBody);
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", fetchFn });
    await adapter.synthesize({ text: "测试" });
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.signal?.aborted).toBe(false);
    }
  });
});

// ── 模型配置接入 P0：getModel 覆盖（空/未配回落默认常量）────────────

describe("模型配置接入 P0：getModel 注入（一次性 TTS）", () => {
  test("getModel 生效于请求体 model；空串回落默认", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("multimodal-generation")) {
        return new Response(JSON.stringify({ output: { audio: { url: "https://fake-audio.example.com/a.wav" } } }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    const adapter = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", getModel: () => "custom-tts-v2", fetchFn });
    await adapter.synthesize({ text: "测试" });
    expect((JSON.parse(String(calls[0]!.init.body)) as { model: string }).model).toBe("custom-tts-v2");

    const adapter2 = new DashScopeTtsAdapter({ getApiKey: () => "sk-dash", getModel: () => "", fetchFn });
    await adapter2.synthesize({ text: "测试" });
    expect((JSON.parse(String(calls[2]!.init.body)) as { model: string }).model).toBe(DASHSCOPE_TTS_MODEL);
  });
});
