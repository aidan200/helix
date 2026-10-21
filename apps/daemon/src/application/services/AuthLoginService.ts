import type { AuthCredentialType, AuthNotifyPayload, AuthPromptPayload } from "@helix/protocol";
import type { AuthFlowPort } from "../ports/outbound/AuthFlowPort";

/**
 * AuthLoginService —— 登录流程编排（pi-ai 订阅登录批）。
 *
 * 生命周期：login（单飞登记）→ 交互推送（auth.prompt/auth.notify，传输
 * 闭包由 driving 层供给）→ 三终态收口（成功携 credentialType / auth.cancel
 * 中止 / 流程失败）→ auth.changed 广播（onAuthChanged 出海）。
 *
 * 设计要点（AskService 同构）：
 * - **单飞不变式**：同 provider 同时最多一个登录流程——第二个 login 直接
 *   拒绝（引导先 cancel）；跨 provider 并发合法（不同浏览器 tab 各自登录）；
 * - **prompt 注册表**：requestId → 挂起回填 Promise（auth.respond 供值 /
 *   cancel/流程收口时 reject 兜底——防悬 promise）；prompt 归属 provider
 *   登记（cancel 精确拒本流程的挂起 prompt）；
 * - **中止协同**：cancel 只 abort 信号 + 拒挂起 prompt（pi 登录流响应
 *   signal 与 prompt rejection 协同退出）；幂等（无流程静默 false）。
 */
export interface AuthLoginDeps {
  /** 登录流出站（pi-ai Models.login/logout 防腐墙）。 */
  readonly flow: AuthFlowPort;
  /** auth.changed 广播出海（容器接 EventStream；channel=model，订阅无关）。 */
  readonly onAuthChanged?: (payload: { providerId: string; credentialType?: AuthCredentialType }) => void;
  /** requestId 生成（测试注入；缺省随机）。 */
  readonly newId?: () => string;
}

/** 交互传输面（driving 层供给：prompt/notify → 协议帧推送）。 */
export interface AuthFlowEmit {
  prompt(input: { requestId: string; prompt: AuthPromptPayload }): void;
  notify(event: AuthNotifyPayload): void;
}

interface PendingPrompt {
  readonly providerId: string;
  readonly resolve: (value: string) => void;
  readonly reject: (err: Error) => void;
}

export class AuthLoginService {
  /** provider → 进行中流程（单飞不变式 + cancel 寻址）。 */
  private readonly flows = new Map<string, AbortController>();
  /** requestId → 挂起 prompt 回填。 */
  private readonly prompts = new Map<string, PendingPrompt>();

  constructor(private readonly deps: AuthLoginDeps) {}

  /** 发起登录（成功后 auth.changed 广播；单飞冲突/流程失败抛中文错）。 */
  async login(
    providerId: string,
    type: AuthCredentialType,
    emit: AuthFlowEmit,
  ): Promise<{ credentialType: AuthCredentialType }> {
    if (this.flows.has(providerId)) {
      throw new Error(`provider "${providerId}" 已有登录流程进行中（先 auth.cancel 中止后再发起）`);
    }
    const controller = new AbortController();
    this.flows.set(providerId, controller);
    try {
      const result = await this.deps.flow.login(providerId, type, {
        signal: controller.signal,
        prompt: (prompt) => {
          const requestId = this.nextId();
          // 先注册后推送（重入安全：emit 内同步 respond 也能命中注册表）
          return new Promise<string>((resolve, reject) => {
            this.prompts.set(requestId, { providerId, resolve, reject });
            emit.prompt({ requestId, prompt });
          });
        },
        notify: (event) => emit.notify(event),
      });
      this.deps.onAuthChanged?.({ providerId, credentialType: result.credentialType });
      return result;
    } finally {
      this.flows.delete(providerId);
      this.rejectPromptsOf(providerId, new Error(`provider "${providerId}" 登录流程已收口（挂起的交互已作废）`));
    }
  }

  /** prompt 回填（auth.respond；未知 requestId → false，幂等容忍竞态）。 */
  respond(requestId: string, value: string): boolean {
    const pending = this.prompts.get(requestId);
    if (pending === undefined) return false;
    this.prompts.delete(requestId);
    pending.resolve(value);
    return true;
  }

  /** 中止进行中登录（auth.cancel；幂等——无流程返回 false）。 */
  cancel(providerId: string): boolean {
    const controller = this.flows.get(providerId);
    if (controller === undefined) return false;
    controller.abort();
    this.rejectPromptsOf(providerId, new Error(`provider "${providerId}" 登录已取消`));
    return true;
  }

  /** 登出（清 auth.json 凭据行 + auth.changed 广播；幂等）。 */
  async logout(providerId: string): Promise<void> {
    await this.deps.flow.logout(providerId);
    this.deps.onAuthChanged?.({ providerId });
  }

  private nextId(): string {
    return this.deps.newId?.() ?? `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 拒绝某 provider 的全部挂起 prompt（cancel/收口兜底——防悬 promise）。 */
  private rejectPromptsOf(providerId: string, err: Error): void {
    for (const [requestId, pending] of [...this.prompts]) {
      if (pending.providerId !== providerId) continue;
      this.prompts.delete(requestId);
      pending.reject(err);
    }
  }
}
