/**
 * auth 管理 DTO（v0.2 新增，契约 C §1.3；G-6 定名 auth.* 命令族）。
 *
 * daemon 侧落点：~/.helix/auth.json（pi 生态 Credential 联合，0600 + 文件锁，
 * daemon 单写点，T2.3 落地）；协议侧只登记前端消费面。
 *
 * v0.14 §17.39（pi-ai 订阅登录批）：凭据类型双态（api_key / oauth 订阅登录）
 * + 登录交互 DTO（prompt/notify——pi-ai AuthPrompt/AuthEvent 结构同形镜像，
 * pi-ai 类型不越墙）。
 */

/** 凭据类型（pi 生态 Credential type tag：显式 key / OAuth 订阅登录）。 */
export type AuthCredentialType = "api_key" | "oauth";

/** auth.list 响应的 provider 条目（P-4 设置页 key 管理列表行数据） */
export interface AuthProviderInfo {
  providerId: string;
  /** 是否已录入 key */
  configured: boolean;
  /** 掩码形式（如 `····7f3a` 尾 4 位）；未录入时缺省 */
  keyMasked?: string;
  /** 最近一次 verify 成功时间（epoch ms）；缺省 = 从未验证 */
  verifiedAt?: number;
  /** 验证状态（auth.verify 不缓存，每次真实请求；前端三态自管理） */
  verifyStatus?: "ok" | "fail" | "unverified";
  /** 当前凭据类型（订阅登录批；缺省 = 未配置） */
  credentialType?: AuthCredentialType;
  /** OAuth 订阅登录可用面（存在 = 该 provider 支持订阅登录；登录按钮消费） */
  oauth?: {
    /** 登录按钮文案（provider 元数据 SoT 在 pi-ai，如「Sign in with ChatGPT」） */
    loginLabel: string;
    /** 订阅登录（免费/付费订阅额度型——UI 提示语分档） */
    isSubscription: boolean;
  };
}

/**
 * 登录交互 prompt 载荷（pi-ai AuthPrompt 同形镜像；auth.prompt 帧携带，
 * auth.respond 回填字符串——select 型回填 option id）。
 */
export type AuthPromptPayload =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string };

/**
 * 登录交互 notify 事件载荷（pi-ai AuthEvent 同形镜像；auth.notify 帧携带——
 * auth_url 拉浏览器 / device_code 设备码展示 / progress 过程提示）。
 */
export type AuthNotifyPayload =
  | { type: "info"; message: string; links?: { url: string; label: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };
