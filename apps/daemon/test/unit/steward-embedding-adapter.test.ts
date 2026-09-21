/**
 * OpenAiCompatEmbeddingAdapter 单测（管家记忆 B1 批；fetch 桩零网络）。
 *
 * 断言面：
 * 1. 成功路径：POST {baseUrl}/embeddings + {model, input} 契约 → Float32Array
 *    向量 + 实测 dim（尾斜杠客忍；apiKey 存在 → Bearer 头）；
 * 2. 未配置 → 抛错（服务层降级语义的上游）；
 * 3. 免 key 端点（apiKey 缺省/空串）→ 无 authorization 头（Ollama 形态）；
 * 4. HTTP 非 2xx → 抛错含状态码；网络异常 → 抛错含端点；
 * 5. 协议形态异常（缺 data/embedding 非数值数组/数量不符/维度不齐）→ 抛错。
 */
import { describe, expect, test } from "bun:test";
import {
  OpenAiCompatEmbeddingAdapter,
  type EmbeddingEndpointConfig,
} from "../../src/adapters/driven/embedding/OpenAiCompatEmbeddingAdapter";

const CFG: EmbeddingEndpointConfig = {
  baseUrl: "http://localhost:11434/v1/",
  apiKey: "test-key",
  model: "bge-m3",
};

function fetchStub(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: unknown, init?: unknown) => impl(String(url), init as RequestInit)) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenAiCompatEmbeddingAdapter", () => {
  test("① 成功：契约请求面 + Float32Array 向量 + 实测 dim + Bearer 头 + 尾斜杠客忍", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const adapter = new OpenAiCompatEmbeddingAdapter({
      getConfig: () => CFG,
      fetch: fetchStub(async (url, init) => {
        seen.url = url;
        seen.init = init;
        return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] });
      }),
    });
    const result = await adapter.embed(["甲", "乙"]);
    expect(seen.url).toBe("http://localhost:11434/v1/embeddings");
    const body = JSON.parse(String(seen.init!.body));
    expect(body).toEqual({ model: "bge-m3", input: ["甲", "乙"] });
    expect((seen.init!.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(result.dim).toBe(3);
    expect(result.vectors.length).toBe(2);
    expect(result.vectors[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(result.vectors[1]!).map((v) => Math.round(v * 10))).toEqual([4, 5, 6]);
  });

  test("② 未配置端点 → 抛错（含配置引导）", async () => {
    const adapter = new OpenAiCompatEmbeddingAdapter({ getConfig: () => null });
    await expect(adapter.embed(["x"])).rejects.toThrow("未配置");
  });

  test("③ 免 key 端点（apiKey 缺省/空串）→ 无 authorization 头", async () => {
    const seen: { init?: RequestInit } = {};
    const adapter = new OpenAiCompatEmbeddingAdapter({
      getConfig: () => ({ baseUrl: "http://localhost:11434/v1", model: "bge-m3" }),
      fetch: fetchStub(async (_url, init) => {
        seen.init = init;
        return jsonResponse({ data: [{ embedding: [1] }] });
      }),
    });
    await adapter.embed(["x"]);
    expect((seen.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("④ HTTP 非 2xx → 抛错含状态码；网络异常 → 抛错含端点", async () => {
    const httpErr = new OpenAiCompatEmbeddingAdapter({
      getConfig: () => CFG,
      fetch: fetchStub(async () => jsonResponse({ error: "model not found" }, 404)),
    });
    await expect(httpErr.embed(["x"])).rejects.toThrow("HTTP 404");
    const netErr = new OpenAiCompatEmbeddingAdapter({
      getConfig: () => CFG,
      fetch: fetchStub(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(netErr.embed(["x"])).rejects.toThrow("不可达");
  });

  test("⑤ 协议形态异常四面：缺 data / 非数值数组 / 数量不符 / 维度不齐", async () => {
    const mk = (body: unknown) =>
      new OpenAiCompatEmbeddingAdapter({ getConfig: () => CFG, fetch: fetchStub(async () => jsonResponse(body)) });
    await expect(mk({}).embed(["x"])).rejects.toThrow("协议异常");
    await expect(mk({ data: [{ embedding: ["a"] }] }).embed(["x"])).rejects.toThrow("协议异常");
    await expect(mk({ data: [{ embedding: [1] }] }).embed(["x", "y"])).rejects.toThrow("数量不符");
    await expect(
      mk({ data: [{ embedding: [1, 2] }, { embedding: [1] }] }).embed(["x", "y"]),
    ).rejects.toThrow("维度不齐");
  });

  test("endpointLabel：未配置/已配置两态", () => {
    expect(new OpenAiCompatEmbeddingAdapter({ getConfig: () => null }).endpointLabel()).toBe("未配置");
    expect(new OpenAiCompatEmbeddingAdapter({ getConfig: () => CFG }).endpointLabel()).toBe(
      "bge-m3 @ localhost:11434",
    );
  });
});
