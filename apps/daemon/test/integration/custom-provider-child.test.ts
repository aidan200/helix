import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { CustomProviderDef } from "../../src/application/ports/outbound/CustomProviderPort";

/**
 * custom provider 子进程注册批（集成）：自定义 provider 模型槽位上的真
 * SubAgent 子进程端到端——本地 OpenAI 兼容 SSE 桩替代真实平台：
 *
 * - 缺口复现面：子进程引擎流式首调 Models.requireProvider(model)——修复前
 *   抛 `Unknown provider: cp-test`（engine_error → failed 收口）；修复后
 *   provider 已注册 → 请求真正发出（桩观测到 /v1/chat/completions）→
 *   closure done；
 * - apiKey 链证据（侦察必答②）：桩断言 Authorization 头携带 auth 显式
 *   key（auth.json → apiKeysSnapshot → HELIX_API_KEYS_JSON →
 *   explicitGetApiKey → provider resolve 透传）。
 *
 * 受控性：零外部网络（127.0.0.1 桩）、无真实 key、单 turn 直接收口。
 */

const closureBlock = (summary: string) =>
  `<<<CLOSURE\n${JSON.stringify({ status: "done", summary, reportPath: null, findings: [], taskId: null })}\nCLOSURE>>>`;

interface StubRequest {
  readonly path: string;
  readonly authorization: string | null;
}

/** OpenAI 兼容 SSE 桩（chat.completions 流式单轮）：记录请求头 + 回闭包文本。 */
function serveStub(replyText: string): {
  baseUrl: string;
  requests: StubRequest[];
  close: () => void;
} {
  const requests: StubRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ path: url.pathname, authorization: req.headers.get("authorization") });
      const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "m1",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage !== undefined ? { usage } : {}),
        })}\n\n`;
      const body =
        chunk({ role: "assistant", content: replyText }, null) +
        chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) +
        "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    close: () => server.stop(true),
  };
}

const tmpRoots: string[] = [];
const tmpDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function makeInstance(id: string): AgentInstance {
  return AgentInstance.create({
    instanceId: id,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "s-cp-child",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("custom provider 模型槽位真子进程（引擎流式不再抛 Unknown provider）", () => {
  test("spawn 子进程：自定义 provider 模型上引擎可跑 + apiKey 链透传 + closure done", async () => {
    const stub = serveStub(closureBlock("integration-ok"));
    try {
      const home = tmpDir("helix-cp-child-");
      const model = {
        id: "m1",
        name: "Model One",
        api: "openai-completions",
        provider: "cp-test",
        baseUrl: stub.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      } as unknown as Model<any>;
      const def: CustomProviderDef = {
        id: "cp-test",
        name: "CP Test",
        api: "openai-completions",
        baseUrl: stub.baseUrl,
        models: [{ id: "m1", contextWindow: 128_000 }],
      };
      const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
      const launcher = new SubagentLauncher({
        profile: SubAgentProfile,
        model,
        apiKeys: { "cp-test": "sk-secret-test" },
        toolCwd: home,
        customProviders: () => [def],
        onLine: () => {},
      });
      launcher.setCallbacks({
        onInstanceEvent: () => {},
        onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
      });

      launcher.launch(makeInstance("agent-cp-int-1"), "在自定义 provider 模型上跑一个最小任务");
      await new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          if (closures.length > 0) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - t0 > 25000) {
            clearInterval(timer);
            reject(new Error("等待 closure 超时"));
          }
        }, 20);
      });

      // 缺口修复判据：closure done（修复前 engine_error: Unknown provider → failed）
      expect(closures[0]!.outcome.result).toBe("done");
      expect(closures[0]!.outcome.closure.summary).toBe("integration-ok");
      // 请求真正发出（requireProvider 通过 → applyAuth → 真 HTTP）
      expect(stub.requests.length).toBeGreaterThanOrEqual(1);
      expect(stub.requests[0]!.path).toBe("/v1/chat/completions");
      // apiKey 链证据（侦察必答②）：显式 key 一路透传到请求头
      expect(stub.requests[0]!.authorization).toBe("Bearer sk-secret-test");
    } finally {
      stub.close();
    }
  }, 30000);

  test("无定义透传（env 空缺）：自定义 provider 模型槽位子进程如实报 Unknown provider（缺口对照——零注册语义不变）", async () => {
    const stub = serveStub(closureBlock("should-not-reach"));
    try {
      const home = tmpDir("helix-cp-child-none-");
      const model = {
        id: "m1",
        name: "Model One",
        api: "openai-completions",
        provider: "cp-test",
        baseUrl: stub.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      } as unknown as Model<any>;
      const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
      const launcher = new SubagentLauncher({
        profile: SubAgentProfile,
        model,
        apiKeys: { "cp-test": "sk-secret-test" },
        toolCwd: home,
        // 未注入 customProviders → 不传键（既有形态零变化）
        onLine: () => {},
      });
      launcher.setCallbacks({
        onInstanceEvent: () => {},
        onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
      });

      launcher.launch(makeInstance("agent-cp-int-2"), "对照组任务");
      await new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          if (closures.length > 0) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - t0 > 25000) {
            clearInterval(timer);
            reject(new Error("等待 closure 超时"));
          }
        }, 20);
      });

      // 零注册语义钉死：未透传定义时子进程不虚构注册——engine error 如实上报
      expect(closures[0]!.outcome.result).toBe("failed");
      expect(closures[0]!.outcome.closure.summary).toContain("Unknown provider");
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.close();
    }
  }, 30000);
});
