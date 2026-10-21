import type { AuthCredentialType, AuthNotifyPayload, AuthPromptPayload } from "@helix/protocol";

/**
 * 登录流出站端口（pi-ai 订阅登录批；实现体 = adapters/driven/llm/pi-auth.ts
 * createAuthFlow——Models.login/logout 防腐墙）。
 *
 * 【分层】application 只见协议 DTO 镜像（AuthPromptPayload/AuthNotifyPayload
 * 与 pi-ai AuthPrompt/AuthEvent 同形）；pi-ai 类型不越墙（AD-4②）。
 * 【交互】prompt 回填挂起 Promise（auth.respond 供值；select 型回 option id）；
 * notify 即时推送（auth_url 拉浏览器 / device_code 设备码 / progress）。
 * 【取消】signal 由调用方持有（auth.cancel / 调用方清理触发）——登录流
 * （浏览器 PKCE/设备码轮询）应协同中止。
 */

/** 登录交互面（传输闭包由 driving 层供给；AskService.answer 往返同构）。 */
export interface AuthFlowInteraction {
  /** 中止信号（auth.cancel 触发——登录流协同取消）。 */
  readonly signal: AbortSignal;
  /** prompt 回填（挂起至供值/中止；select 型回 option id）。 */
  prompt(prompt: AuthPromptPayload): Promise<string>;
  /** notify 即时推送（info/auth_url/device_code/progress）。 */
  notify(event: AuthNotifyPayload): void;
}

export interface AuthFlowPort {
  /**
   * 发起登录（pi-ai Models.login：type=oauth 走订阅登录流——浏览器 PKCE/
   * 设备码；type=api_key 走 key 录入交互）。成功后凭据已落 auth.json
   *（实现体负责持久化，含 pi-ai 自带落盘语义的幂等兜底）。
   */
  login(
    providerId: string,
    type: AuthCredentialType,
    interaction: AuthFlowInteraction,
  ): Promise<{ credentialType: AuthCredentialType }>;
  /** 登出（pi-ai Models.logout + auth.json 清行幂等兜底）。 */
  logout(providerId: string): Promise<void>;
}
