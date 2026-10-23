import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerCustomProviders } from "../../src/adapters/driven/llm/custom-providers";
import { installProxyFetch } from "../../src/adapters/driven/network/proxy-fetch";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { RuntimeConfigStore } from "../../src/adapters/driven/sqlite-session/RuntimeConfigStore";
import { ProxyConfigStore } from "../../src/adapters/driven/sqlite-session/ProxyConfigStore";

// 受控 HTTP 代理桩：目标 .invalid 不可直连；唯一成功路径是命中代理。
function proxy(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}
function sse(api: "openai-completions" | "anthropic-messages"): string {
  if (api === "openai-completions") return [
    { choices: [{ index: 0, delta: { role: "assistant", content: "proxy-ok" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ].map(c => `data: ${JSON.stringify({ id: "p1", object: "chat.completion.chunk", created: 1, model: "m1", ...c })}\n\n`).join("") + "data: [DONE]\n\n";
  const events = [
    { type: "message_start", message: { id: "p1", role: "assistant", model: "m1", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "proxy-ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

describe("network proxy: real runtime, zero external network", () => {
  for (const api of ["openai-completions", "anthropic-messages"] as const) {
    test(`installed pi-ai ${api} streams through configured proxy`, async () => {
      const requests: string[] = [];
      const stub = proxy(req => {
        requests.push(req.url);
        return new Response(sse(api), { headers: { "content-type": "text/event-stream" } });
      });
      // 先构造当前真正安装的 pi-ai 目录，再安装 wrapper，证明不是靠导入时机偶然通过。
      const models = builtinModels();
      registerCustomProviders(models, [{ id: "proxy-test", name: "Proxy", api,
        baseUrl: "http://helix-proxy-test.invalid/v1", models: [{ id: "m1", contextWindow: 32000 }] }]);
      const undo = installProxyFetch(() => ({ enabled: true, url: stub.url }));
      try {
        const stream = models.streamSimple(models.getModel("proxy-test", "m1")!, {
          messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: 0 }],
        }, { apiKey: "fake-key", maxTokens: 10, maxRetries: 0, signal: AbortSignal.timeout(3000) });
        const result = await stream.result();
        expect(result.stopReason).toBe("stop");
        expect(result.content).toContainEqual({ type: "text", text: "proxy-ok" });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain("helix-proxy-test.invalid");
      } finally { undo(); stub.close(); }
    }, 5000);
  }

  test("a real child follows parent KV changes on its next request (not an env snapshot)", async () => {
    const tmpRoot = path.resolve(import.meta.dir, "../../../../../.helix/tmp");
    mkdirSync(tmpRoot, { recursive: true });
    const dir = mkdtempSync(path.join(tmpRoot, "proxy-child-"));
    const dbPath = path.join(dir, "helix.db");
    const queue = new WriteQueue(dbPath);
    const store = new ProxyConfigStore(new RuntimeConfigStore(queue));
    const seen: string[] = [];
    const b = proxy(() => { seen.push("B"); return new Response("B"); });
    const a = proxy(async () => {
      seen.push("A");
      await store.set({ enabled: true, url: b.url });
      return new Response("A");
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await store.set({ enabled: true, url: a.url });
      child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixtures/proxy-child.ts"), dbPath],
        { stdout: "pipe", stderr: "pipe", timeout: 5000 });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(), child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual(["A", "B"]);
      expect(seen).toEqual(["A", "B"]);
    } finally {
      child?.kill(); a.close(); b.close(); await queue.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 7000);
});
