import { describe, expect, test } from "bun:test";
import type {
  AuthCredentialType,
  AuthNotifyPayload,
  AuthPromptPayload,
  EventEnvelope,
} from "@helix/protocol";
import type { AuthFlowInteraction, AuthFlowPort } from "../../src/application/ports/outbound/AuthFlowPort";
import { AuthLoginService } from "../../src/application/services/AuthLoginService";
import { createAuthFlow, type AuthCredentialSource } from "../../src/adapters/driven/llm/pi-auth";
import {
  handleAuthCancel,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthRespond,
} from "../../src/adapters/driving/ws-server/handlers/auth";
import type { WsCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * 订阅登录批 M2 契约测试：
 * - AuthLoginService 状态机（单飞/prompt 注册表/中止/广播出海——AskService 同构）；
 * - createAuthFlow 透传（prompt/notify/signal + LoginOptions{agentName,getDeviceId}
 *   + 幂等落盘 + 登出清行——TR-175 全参显式书写面）；
 * - 假 OAuth 事件序列（device_code + manual_code 剧本走 handler 全链——
 *   auth.notify → auth.prompt → auth.respond → auth.login.result 帧序断言）。
 */

/** 假登录流（剧本驱动：可编排 notify/prompt/成功/失败）。 */
function fakeFlow(script: (interaction: AuthFlowInteraction) => Promise<{ credentialType: AuthCredentialType }>): {
  flow: AuthFlowPort;
  calls: { providerId: string; type: AuthCredentialType }[];
  logoutCalls: string[];
} {
  const calls: { providerId: string; type: AuthCredentialType }[] = [];
  const logoutCalls: string[] = [];
  const flow: AuthFlowPort = {
    login: async (providerId, type, interaction) => {
      calls.push({ providerId, type });
      return script(interaction);
    },
    logout: async (providerId) => {
      logoutCalls.push(providerId);
    },
  };
  return { flow, calls, logoutCalls };
}

describe("① AuthLoginService 状态机", () => {
  test("登录成功：交互透传 + prompt 回填 + auth.changed 广播", async () => {
    let seen: { prompt?: AuthPromptPayload; notified: AuthNotifyPayload[] } = { notified: [] };
    let seq = 0;
    const { flow, calls } = fakeFlow(async (interaction) => {
      interaction.notify({ type: "progress", message: "starting" });
      const value = await interaction.prompt({ type: "manual_code", message: "paste code" });
      expect(value).toBe("pasted-code");
      return { credentialType: "oauth" };
    });
    const changed: { providerId: string; credentialType?: AuthCredentialType }[] = [];
    const service = new AuthLoginService({
      flow,
      onAuthChanged: (p) => changed.push(p),
      newId: () => `req-${++seq}`,
    });
    const result = await service.login("openai-codex", "oauth", {
      prompt: (input) => {
        seen.prompt = input.prompt;
        // 模拟前端 auth.respond 往返
        expect(input.requestId).toBe("req-1");
        expect(service.respond(input.requestId, "pasted-code")).toBe(true);
      },
      notify: (e) => seen.notified.push(e),
    });
    expect(result).toEqual({ credentialType: "oauth" });
    expect(calls).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
    expect(seen.notified).toEqual([{ type: "progress", message: "starting" }]);
    expect(seen.prompt).toEqual({ type: "manual_code", message: "paste code" });
    expect(changed).toEqual([{ providerId: "openai-codex", credentialType: "oauth" }]);
  });

  test("单飞不变式：同 provider 二个 login 拒绝；跨 provider 并发合法", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { flow } = fakeFlow(async () => {
      await gate;
      return { credentialType: "oauth" };
    });
    const service = new AuthLoginService({ flow });
    const emit = { prompt: () => {}, notify: () => {} };
    const first = service.login("openai-codex", "oauth", emit);
    await expect(service.login("openai-codex", "oauth", emit)).rejects.toThrow(/已有登录流程进行中/);
    // 跨 provider 并发不拦
    const second = service.login("anthropic", "oauth", emit);
    release();
    await expect(first).resolves.toEqual({ credentialType: "oauth" });
    await expect(second).resolves.toEqual({ credentialType: "oauth" });
  });

  test("中止：cancel 置 signal + 拒挂起 prompt；无流程 cancel 幂等 false；不发 auth.changed", async () => {
    let seenSignal: AbortSignal | undefined;
    let promptErr: Error | undefined;
    const { flow } = fakeFlow(async (interaction) => {
      seenSignal = interaction.signal;
      try {
        await interaction.prompt({ type: "text", message: "input" });
      } catch (err) {
        promptErr = err as Error;
      }
      throw new Error("登录流随中止退出");
    });
    const changed: unknown[] = [];
    const service = new AuthLoginService({ flow, onAuthChanged: (p) => changed.push(p) });
    const emit = {
      prompt: () => {
        // prompt 已挂起 → 中止
        expect(service.cancel("openai-codex")).toBe(true);
      },
      notify: () => {},
    };
    await expect(service.login("openai-codex", "oauth", emit)).rejects.toThrow(/登录流随中止退出/);
    expect(seenSignal?.aborted).toBe(true);
    expect(promptErr?.message).toMatch(/登录已取消/);
    expect(changed).toEqual([]);
    expect(service.cancel("openai-codex")).toBe(false); // 幂等
  });

  test("respond 未知 requestId → false；logout 广播无凭据态", async () => {
    const { flow, logoutCalls } = fakeFlow(async () => ({ credentialType: "oauth" }));
    const changed: { providerId: string; credentialType?: AuthCredentialType }[] = [];
    const service = new AuthLoginService({ flow, onAuthChanged: (p) => changed.push(p) });
    expect(service.respond("nope", "v")).toBe(false);
    await service.logout("openai-codex");
    expect(logoutCalls).toEqual(["openai-codex"]);
    expect(changed).toEqual([{ providerId: "openai-codex" }]);
  });
});

describe("② createAuthFlow 透传（Models.login/logout 防腐墙）", () => {
  test("LoginOptions 携 agentName/getDeviceId；prompt/notify/signal 直通；凭据幂等落盘", async () => {
    const captured: {
      args?: unknown[];
      interaction?: AuthFlowInteraction;
      options?: { agentName: string; getDeviceId: () => string };
    } = {};
    const modified: string[] = [];
    const deleted: string[] = [];
    const fakeModels = {
      login: async (
        providerId: string,
        type: string,
        interaction: AuthFlowInteraction,
        options: { agentName: string; getDeviceId: () => string },
      ) => {
        captured.args = [providerId, type];
        captured.interaction = interaction;
        captured.options = options;
        interaction.notify({ type: "progress", message: "go" });
        const v = await interaction.prompt({ type: "secret", message: "key" });
        return { type: "api_key", key: v };
      },
      logout: async () => {},
    };
    const source: AuthCredentialSource = {
      credentialOf: () => undefined,
      modify: async (providerId, fn) => {
        modified.push(providerId);
        await fn(undefined);
        return undefined;
      },
      deleteKey: async (providerId: string) => {
        deleted.push(providerId);
      },
      listCredentials: () => [],
    };
    const flow = createAuthFlow({
      models: fakeModels as never,
      source,
      getDeviceId: () => "device-abc",
      agentName: "helix",
    });
    const notified: AuthNotifyPayload[] = [];
    const controller = new AbortController();
    const result = await flow.login("moonshot", "api_key", {
      signal: controller.signal,
      prompt: async (p) => {
        expect(p).toEqual({ type: "secret", message: "key" });
        return "sk-value";
      },
      notify: (e) => notified.push(e),
    });
    expect(captured.args).toEqual(["moonshot", "api_key"]);
    expect(captured.options?.agentName).toBe("helix");
    expect(captured.options?.getDeviceId()).toBe("device-abc");
    expect(captured.interaction?.signal).toBe(controller.signal);
    expect(notified).toEqual([{ type: "progress", message: "go" }]);
    expect(result).toEqual({ credentialType: "api_key" });
    expect(modified).toEqual(["moonshot"]); // 幂等落盘（防御 pi-ai 自带落盘语义）
    await flow.logout("moonshot");
    expect(deleted).toEqual(["moonshot"]);
  });
});

describe("③ 假 OAuth 事件序列（handler 全链：device_code + manual_code 剧本）", () => {
  /** 最小 WsCommandContext 替身（帧捕获 + 错误捕获）。 */
  function fakeCtx(payload: Record<string, unknown>, service: AuthLoginService): {
    ctx: WsCommandContext;
    frames: EventEnvelope[];
    errors: { type: string; code: string; message: string }[];
  } {
    const frames: EventEnvelope[] = [];
    const errors: { type: string; code: string; message: string }[] = [];
    const sender = { tag: "sender" } as never;
    const ctx = {
      ws: { data: { sender } },
      type: "auth.login",
      payload,
      envelope: {},
      authLogin: service,
      model: {} as never,
      system: {} as never,
      commandError: (type: string, code: string, message: string) => {
        errors.push({ type, code, message });
      },
      modelErrorCode: () => "command.internal_error",
      rawSender: () => sender,
      sendNow: (_s: never, frame: EventEnvelope) => {
        frames.push(frame);
      },
    } as unknown as WsCommandContext;
    return { ctx, frames, errors };
  }

  test("帧序：auth.notify(device_code) → auth.prompt(manual_code) → respond → auth.login.result", async () => {
    const { flow } = fakeFlow(async (interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://chatgpt.com/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      const code = await interaction.prompt({ type: "manual_code", message: "paste the code" });
      expect(code).toBe("the-auth-code");
      return { credentialType: "oauth" };
    });
    const service = new AuthLoginService({ flow });
    const loginRig = fakeCtx({ providerId: "openai-codex" }, service);
    handleAuthLogin(loginRig.ctx);
    // 等登录流程推进到挂起 prompt（帧已推两枚）——条件等待（不用固定 sleep）
    for (let i = 0; i < 50 && loginRig.frames.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(loginRig.frames.map((f) => f.type)).toEqual(["auth.notify", "auth.prompt"]);

    // auth.respond 回填（prompt 帧携 requestId）
    const promptFrame = loginRig.frames[1] as { payload: { requestId: string } };
    const respondRig = fakeCtx({ requestId: promptFrame.payload.requestId, value: "the-auth-code" }, service);
    handleAuthRespond(respondRig.ctx);
    expect(respondRig.errors).toEqual([]); // 成功零回执零错误

    // 登录收口 → auth.login.result
    for (let i = 0; i < 50 && loginRig.frames.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(loginRig.frames.map((f) => f.type)).toEqual(["auth.notify", "auth.prompt", "auth.login.result"]);
    expect(loginRig.frames[2]).toMatchObject({ payload: { providerId: "openai-codex", credentialType: "oauth" } });
    expect(loginRig.errors).toEqual([]);

    // 登出链：auth.logout.result
    const logoutRig = fakeCtx({ providerId: "openai-codex" }, service);
    handleAuthLogout(logoutRig.ctx);
    for (let i = 0; i < 50 && logoutRig.frames.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(logoutRig.frames.map((f) => f.type)).toEqual(["auth.logout.result"]);
    expect(logoutRig.errors).toEqual([]);
  });

  test("payload 校验与未装配防御：缺 providerId / 未装配 authLogin → 对应错误回执", () => {
    const { flow } = fakeFlow(async () => ({ credentialType: "oauth" }));
    const service = new AuthLoginService({ flow });
    const bad = fakeCtx({}, service);
    handleAuthLogin(bad.ctx);
    expect(bad.errors[0]?.code).toBe("command.invalid_payload");
    const badType = fakeCtx({ providerId: "p", type: "weird" }, service);
    handleAuthLogin(badType.ctx);
    expect(badType.errors[0]?.code).toBe("command.invalid_payload");
    const bare = fakeCtx({ providerId: "p" }, service);
    (bare.ctx as { authLogin?: unknown }).authLogin = undefined;
    handleAuthLogin(bare.ctx);
    expect(bare.errors[0]?.code).toBe("command.unimplemented");
    const cancelBad = fakeCtx({}, service);
    handleAuthCancel(cancelBad.ctx);
    expect(cancelBad.errors[0]?.code).toBe("command.invalid_payload");
  });
});
