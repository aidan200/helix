import { afterEach, describe, expect, test } from "bun:test";
import { createWebFetchTool } from "../../src/adapters/driven/tools/web/WebFetchTool";

/**
 * M25 单元：WebFetchTool Jina 备选分支约束——
 * ① format=html 禁走 Jina（Jina 返回正文转换文本非原始 HTML）：直连失败直接抛错；
 * ② markdown 走 Jina 备选时回执注明「Jina 备选」。
 * globalThis.fetch 桩驱动（零真实网络）。
 */

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function stubFetch(fn: (url: string) => Promise<Response>): void {
  globalThis.fetch = fn as unknown as typeof fetch;
}

describe("M25：web_fetch Jina 备选分支约束", () => {
  test("format=html 直连失败 → 直接抛错不走 Jina（无二次请求）", async () => {
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(url);
      throw new Error("网络不可达");
    });
    const tool = createWebFetchTool();
    await expect(tool.execute("t1", { url: "https://x.example/", format: "html" } as never, undefined, undefined, undefined as never)).rejects.toThrow(
      /网络不可达/,
    );
    expect(calls).toEqual(["https://x.example/"]); // 无 r.jina.ai 二次请求
  });

  test("format=html 直连成功 → 返回原始 HTML（回归）", async () => {
    stubFetch(async () => new Response("<html><body><h1>Hi</h1></body></html>", { status: 200 }));
    const tool = createWebFetchTool();
    const result = await tool.execute("t2", { url: "https://x.example/", format: "html" } as never, undefined, undefined, undefined as never);
    expect((result.content as { type: string; text: string }[])[0]!.text).toContain("<html>");
  });

  test("markdown 直连失败 → Jina 备选成功，回执注明「Jina 备选」", async () => {
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(url);
      if (url.startsWith("https://r.jina.ai/")) return new Response("JINA 正文文本", { status: 200 });
      throw new Error("直连超时");
    });
    const tool = createWebFetchTool();
    const result = await tool.execute("t3", { url: "https://x.example/" } as never, undefined, undefined, undefined as never);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(calls).toEqual(["https://x.example/", "https://r.jina.ai/x.example/"]);
    expect(text).toContain("Jina 备选");
    expect(text).toContain("JINA 正文文本");
  });

  test("markdown 直连成功 → 走转换核且无 Jina 标注（回归）", async () => {
    stubFetch(async () => new Response("<html><body><h1>Title</h1><p>para</p></body></html>", { status: 200 }));
    const tool = createWebFetchTool();
    const result = await tool.execute("t4", { url: "https://x.example/" } as never, undefined, undefined, undefined as never);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("# Title");
    expect(text).not.toContain("Jina 备选");
  });

  test("markdown 双通道均失败 → 抛错含两侧原因（回归）", async () => {
    stubFetch(async (url) => {
      if (url.startsWith("https://r.jina.ai/")) throw new Error("Jina 限流");
      throw new Error("直连超时");
    });
    const tool = createWebFetchTool();
    await expect(tool.execute("t5", { url: "https://x.example/" } as never, undefined, undefined, undefined as never)).rejects.toThrow(/直连超时.*Jina 限流/s);
  });
});
