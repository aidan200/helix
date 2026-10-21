import { existsSync } from "node:fs";
import type {
  AuthContext,
  Credential,
  CredentialInfo,
  CredentialStore,
  Models,
} from "@earendil-works/pi-ai";
import type { AuthCredentialType, AuthNotifyPayload, AuthPromptPayload } from "@helix/protocol";
import type {
  AuthFlowInteraction,
  AuthFlowPort,
} from "../../../application/ports/outbound/AuthFlowPort";

/**
 * pi-ai auth 接入适配（pi-ai OAuth 订阅登录批 M1）。
 *
 * 【存在理由】pi-ai 内建凭据解析（Models.getAuth：apiKey/oauth 双形态 +
 * oauth 锁内自动 refresh）只有在 builtinModels({ credentials, authContext })
 * 注入后才以 helix auth.json 为唯一数据源——不注入则回落 pi-ai 缺省存储与
 * 环境变量，破 AG-08（env 免疫）与 AD-2（auth.json 单写点）。
 *
 * 【契约面】pi-ai CreateModelsOptions = { credentials: CredentialStore,
 * modelsStore, authContext: AuthContext }；CredentialStore = { read, list,
 * modify, delete }（全异步，AuthOperationOptions { signal } 透传面本地
 * 文件操作忽略）；AuthContext = { env, fileExists }。契约由
 * test/unit/pi-auth.test.ts 断言（与 auth-store.test.ts 的 Credential
 * 类型级等价断言同构做法）。
 *
 * 【refresh 落点】pi-ai oauth 自动 refresh 经 store.modify 落新 token
 * （rotate 后锁内持久化防竞丢）——本适配器 modify 直通 AuthStore.modify
 * （文件锁 + 原子写 + 进程内串行），语义天然对齐。
 */

/** 适配器输入面（AuthStore 结构满足；窄接口注入，不 import infrastructure）。 */
export interface AuthCredentialSource {
  /** 单 provider 原始凭据（缺失 undefined）。 */
  credentialOf(providerId: string): Credential | undefined;
  /** 串行读改写（锁内执行；fn 返回 undefined = 保持不变）。 */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined> | Credential | undefined,
  ): Promise<Credential | undefined>;
  /** 移除凭据（幂等）。 */
  deleteKey(providerId: string): Promise<void>;
  /** 全表凭据类型清单。 */
  listCredentials(): { providerId: string; type: "api_key" | "oauth" }[];
}

/**
 * AuthStore → pi-ai CredentialStore 适配（语义直通，无缓存——每次重读
 * 文件 = 换 key/登录后即时生效）。TR-175：多参接口实现全参显式书写，
 * options 尾参不静默吞——AuthOperationOptions.signal 本地文件操作不
 * 线程化（同步快速 IO，无长挂起点），显式接收并在契约测试钉死。
 */
export function createCredentialStore(source: AuthCredentialSource): CredentialStore {
  return {
    read: async (providerId: string, _options?: { signal?: AbortSignal }): Promise<Credential | undefined> =>
      source.credentialOf(providerId),
    list: async (_options?: { signal?: AbortSignal }): Promise<readonly CredentialInfo[]> =>
      source.listCredentials(),
    modify: (
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
      _options?: { signal?: AbortSignal },
    ): Promise<Credential | undefined> => source.modify(providerId, fn),
    delete: (providerId: string, _options?: { signal?: AbortSignal }): Promise<void> =>
      source.deleteKey(providerId),
  };
}

/**
 * 显式-only AuthContext（AG-08 env 免疫的关键堵口）：
 * - env 恒 undefined——pi-ai 缺省会经 env() 回落 OPENAI_API_KEY 类环境
 *   变量，helix 纪律「显式传值与环境变量彻底无缘」，故恒答无；
 * - fileExists 真实现（登录流探测既有凭据文件等用途，非密钥注入面）。
 */
export function createAuthContext(): AuthContext {
  return {
    env: async () => undefined,
    fileExists: async (filePath: string) => existsSync(filePath),
  };
}

/** builtinModels 注入包（credentials + authContext 成对出口——装配面一次拿齐）。 */
export function createAuthInjection(source: AuthCredentialSource): {
  credentials: CredentialStore;
  authContext: AuthContext;
} {
  return { credentials: createCredentialStore(source), authContext: createAuthContext() };
}

/**
 * 登录流出站实现（AuthFlowPort——Models.login/logout 防腐墙，订阅登录批）。
 *
 * 【登录】Models.login(providerId, type, interaction, LoginOptions)——
 * LoginOptions 携 agentName（恒 "helix"，经 OpenAI originator 等参数上报）
 * 与 getDeviceId（install 级稳定 id，组合根注入）。成功后**幂等落盘**：
 * pi-ai 自带 store 落盘与否未契约化，防御性经 source.modify 写回同值
 * （无变更不落盘/同值重写无害，AuthStore.modify 语义）。
 * 【登出】Models.logout（可能含远端 revoke）+ source.deleteKey 幂等兜底
 * （确保 auth.json 清行——UI 凭据态立即归零）。
 * 【交互】prompt/notify 结构同形直通（协议 DTO ≡ pi-ai AuthPrompt/AuthEvent）；
 * signal 透传（TR-175 全参显式书写）。
 */
export function createAuthFlow(options: {
  readonly models: Models;
  readonly source: AuthCredentialSource;
  readonly getDeviceId: () => string;
  readonly agentName?: string;
}): AuthFlowPort {
  return {
    async login(
      providerId: string,
      type: AuthCredentialType,
      interaction: AuthFlowInteraction,
    ): Promise<{ credentialType: AuthCredentialType }> {
      const credential = await options.models.login(
        providerId,
        type,
        {
          signal: interaction.signal,
          prompt: (prompt) => interaction.prompt(prompt as AuthPromptPayload),
          notify: (event) => interaction.notify(event as AuthNotifyPayload),
        },
        { agentName: options.agentName ?? "helix", getDeviceId: options.getDeviceId },
      );
      await options.source.modify(providerId, async () => credential);
      return { credentialType: credential.type };
    },
    async logout(providerId: string): Promise<void> {
      await options.models.logout(providerId);
      await options.source.deleteKey(providerId);
    },
  };
}
