import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isProcessAlive } from "./lifecycle";
import type { AuthStorePort } from "../application/ports/outbound/AuthStorePort";

/**
 * auth.json 凭据存储（AD-2 auth 分层，architecture.md §6.1；契约 C §3）。
 *
 * 【格式】pi 生态 Credential 联合（Record<providerId, type-tagged Credential>，
 * pi-ai auth/types.d.ts 同构——格式借用成熟 schema；类型级等价由
 * test/unit/auth-store.test.ts 断言）。**路径 helix 自有**（~/.helix/auth.json
 * 经 paths.ts 单点派生，TR-AD-6；不与 pi 工具链共享文件，Q-7 裁决）。
 *
 * 【写入语义】0600 + 原子写（tmp + rename）+ 文件锁（跨进程 pid 锁，陈锁
 * 接管——与 daemon.lock 同构，lifecycle 先例）+ daemon 单写点（进程内
 * modify 全程串行——读改写无丢失更新）。OAuth 登录流本迭代不做
 * （Credential 类型面支持 oauth tag，key 录入为主）。
 */

/** 存储型 API key 凭据（pi-ai ApiKeyCredential 同构；env 携带 provider 级配置值）。 */
export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
}

/** OAuth 凭据（pi-ai OAuthCredential 同构；本迭代仅类型面支持）。 */
export interface OAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

/** 一 provider 一凭据（type-tagged 联合）。 */
export type Credential = ApiKeyCredential | OAuthCredential;

/** auth.json 文件形状。 */
export type AuthFile = Record<string, Credential>;

/** auth.json 权限位（凭据属敏感信息，AG-09 同口径）。 */
export const AUTH_FILE_MODE = 0o600;

/** 锁等待上限（外部进程持锁时阻塞等待；超时抛错不静默覆盖）。 */
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 25;

/** key 脱敏：尾 4 位（`····7f3a` 形态；≤4 位全遮）。 */
export function maskKey(key: string): string {
  return key.length <= 4 ? "····" : `····${key.slice(-4)}`;
}

/** 凭据形状校验（type-tagged 判别；非法形状抛中文错误）。 */
function assertCredential(value: unknown): Credential {
  if (typeof value !== "object" || value === null) {
    throw new Error(`auth.json 条目形状非法（应为 type-tagged Credential 对象）`);
  }
  const type = (value as { type?: unknown }).type;
  if (type === "api_key") {
    const cred = value as ApiKeyCredential;
    if (cred.key !== undefined && typeof cred.key !== "string") {
      throw new Error(`auth.json api_key 凭据的 key 字段应为 string`);
    }
    return cred;
  }
  if (type === "oauth") return value as OAuthCredential;
  throw new Error(`auth.json 凭据 type 非法：${String(type)}（应为 "api_key" | "oauth"）`);
}

/** 解析 auth.json 全表（文件缺失 → 空表；损坏 JSON 抛中文错误）。 */
function parseAuthFile(filePath: string): AuthFile {
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`auth.json 不是合法 JSON：${filePath}（${(err as Error).message}）`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`auth.json 格式错误：${filePath}，应为 { providerId: Credential } 对象`);
  }
  const out: AuthFile = {};
  for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[providerId] = assertCredential(value);
  }
  return out;
}

/**
 * 文件锁（跨进程互斥）：独占创建锁文件记录 pid；已存在时——
 * 持有进程存活 → 轮询等待（超时抛错）；持有进程已死/锁损坏 → 接管。
 * 与 daemon.lock（lifecycle.ts）同构的 pid 锁模式。
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const acquire = (): number | undefined => {
    try {
      // "wx"：不存在才创建（独占）；持有者即本进程（同进程并发由调用方队列串行）
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      closeSync(fd);
      return undefined;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      let heldBy: number | undefined;
      try {
        heldBy = Number.parseInt(JSON.parse(readFileSync(lockPath, "utf8")).pid, 10);
      } catch {
        heldBy = undefined; // 损坏锁文件视同无主，直接接管
      }
      if (heldBy === undefined || !Number.isFinite(heldBy) || !isProcessAlive(heldBy)) {
        rmSync(lockPath, { force: true });
        return acquire(); // 陈锁接管（重试一次创建）
      }
      return heldBy; // 存活的外部持有者
    }
  };

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const holder = acquire();
    if (holder === undefined) break;
    if (Date.now() > deadline) {
      throw new Error(`auth.json 文件锁被 pid=${holder} 的进程持有（等待超时 ${LOCK_TIMEOUT_MS}ms）：${lockPath}`);
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/**
 * AuthStore —— auth.json 唯一写点（daemon 单写）。实现 AuthStorePort
 * （application 消费面）。全部写操作经 modify（锁内读改写 + 原子落盘
 * 0600）；读操作直接解析文件。进程内并发写经 opQueue 串行（modify
 * 语义：serialized read-modify-write）。
 */
export class AuthStore implements AuthStorePort {
  /** 进程内单写队列（并发 modify 串行——无丢失更新）。 */
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    /** T1.3：可观测 logger（排队操作失败 warn；缺省静默）。 */
    private readonly logger?: { warn: (message: string) => void },
  ) {}

  /** 全表读取（文件缺失 → 空表）。 */
  async readAll(): Promise<AuthFile> {
    return this.enqueue(() => parseAuthFile(this.filePath));
  }

  /**
   * 串行读改写（CredentialStore.modify 同构：fn 见当前值，返回新凭据；
   * undefined = 保持不变）。锁内执行，进程内排队。
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined> | Credential | undefined,
  ): Promise<Credential | undefined> {
    return this.enqueue(() =>
      withFileLock(`${this.filePath}.lock`, async () => {
        const table = parseAuthFile(this.filePath);
        const next = await fn(table[providerId]);
        if (next !== undefined) {
          assertCredential(next);
          table[providerId] = next;
        }
        this.persist(table);
        return next === undefined ? table[providerId] : next;
      }),
    );
  }

  /** 写入 API key（auth.set_key；保留既有 env 位）。 */
  async setKey(providerId: string, apiKey: string): Promise<{ keyMasked: string }> {
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new Error(`apiKey 不能为空（provider ${providerId}；空值请用 auth.delete_key 移除）`);
    }
    await this.modify(providerId, (current) => {
      const env = current?.type === "api_key" ? current.env : undefined;
      return { type: "api_key", key: apiKey, ...(env !== undefined ? { env } : {}) } satisfies ApiKeyCredential;
    });
    return { keyMasked: maskKey(apiKey) };
  }

  /** 移除 provider 凭据（auth.delete_key；未知 provider 静默幂等）。 */
  async deleteKey(providerId: string): Promise<void> {
    await this.enqueue(() =>
      withFileLock(`${this.filePath}.lock`, async () => {
        const table = parseAuthFile(this.filePath);
        delete table[providerId];
        this.persist(table);
      }),
    );
  }

  /** 当前 provider 的 API key（engine getApiKey 数据源；OAuth/缺 key → undefined）。 */
  apiKeyOf(providerId: string): string | undefined {
    const table = parseAuthFile(this.filePath);
    const cred = table[providerId];
    return cred?.type === "api_key" && cred.key !== undefined && cred.key !== "" ? cred.key : undefined;
  }

  /** 单 provider 凭据状态（auth.list 条目数据源；OAuth 条目不视作可用 key）。 */
  statusOf(providerId: string): { configured: boolean; keyMasked?: string } {
    const key = this.apiKeyOf(providerId);
    return key === undefined ? { configured: false } : { configured: true, keyMasked: maskKey(key) };
  }

  /** 全部 API key 快照（SubAgent 子进程 env 注入源，AD-11/13 显式传值）。 */
  apiKeysSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [providerId, cred] of Object.entries(parseAuthFile(this.filePath))) {
      if (cred.type === "api_key" && cred.key !== undefined && cred.key !== "") out[providerId] = cred.key;
    }
    return out;
  }

  /** 原子落盘（tmp + rename + 0600 收严；覆盖宽权限旧文件同样收权）。 */
  private persist(table: AuthFile): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, "utf8");
    chmodSync(tmp, AUTH_FILE_MODE);
    renameSync(tmp, this.filePath);
  }

  /** 进程内操作串行（排队 + 失败不断链；op 可同步）。 */
  private enqueue<T>(op: () => T | Promise<T>): Promise<T> {
    const run = this.opQueue.then(op, op);
    // T1.3：链尾失败可观测（调用方仍见 run 拒绝；warn 使丢弃返回 promise 的
    // 场景不再无声——「失败不断链」语义不变）
    this.opQueue = run.catch((err) => {
      this.logger?.warn(`[auth-store] 排队操作失败（${this.filePath}）：${(err as Error).message}`);
    });
    return run;
  }
}
