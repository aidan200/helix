/**
 * 写集合 manifest 落盘（U1 git pre-commit 护栏的数据面）。
 *
 * 为什么存在：pre-commit hook 跑在 git 进程上下文里，无法访问 daemon
 * 内存（WriteFactRegistry 是 liveness 态单例）。跨进程通道选「读文件」
 * 而不是「问 daemon」——hook 里最不脆弱的通道（设计文档 U1 定稿）。
 *
 * 载荷形态：<daemon home>/write-facts/<sessionId>.json
 * { sessionId, updatedAt, paths: string[] }——原子写（tmp+rename），
 * 事实变更去抖 250ms，dropSession 时删除。
 *
 * 分层（AG-02②：application 零直接 node:fs——IO 全注入，对齐
 * WorkspaceService 的 WorkspaceFsPort 注入风格）：本服务在 application
 * 层持有去抖/生命周期语义；文件操作经注入的 fs 端口（组合根用
 * node:fs/promises 真体装配）。
 */

/** manifest 文件操作端口（注入面；真体 = node:fs/promises 子集）。 */
export interface ManifestFsPort {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, body: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

export interface WriteManifest {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly paths: readonly string[];
}

export interface WriteManifestStoreDeps {
  /** manifest 根目录（daemon 侧注入 paths.home/write-facts；hook 经 env 定位同路径）。 */
  readonly manifestRoot: () => string;
  /** 文件操作端口（AG-02②：application 零直接 node:fs）。 */
  readonly fs: ManifestFsPort;
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => number;
}

function join2(dir: string, name: string): string {
  return dir.replace(/\/+$/, "") + "/" + name;
}

/** manifest 落盘器：per-session 去抖写 + 生命周期清理。 */
export class WriteManifestStore {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, string[]>();
  private readonly root: () => string;
  private readonly fs: ManifestFsPort;
  private readonly now: () => number;

  constructor(deps: WriteManifestStoreDeps) {
    this.root = deps.manifestRoot;
    this.fs = deps.fs;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 事实变更通知（去抖 250ms 合并写）。paths 为该会话当前全量路径集。 */
  notify(sessionId: string, paths: readonly string[]): void {
    this.pending.set(sessionId, [...paths]);
    const t = this.timers.get(sessionId);
    if (t !== undefined) clearTimeout(t);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        void this.flush(sessionId);
      }, 250),
    );
  }

  /** 立即落盘（去抖合并的终点；测试/关停时可直接调）。异常吞咽——manifest
   * 是护栏数据面，落盘失败不得打断写事实主链（hook 侧有「manifest 缺失
   * → 放行 + 警示」兜底，失败安全方向 = 不拦）。 */
  async flush(sessionId: string): Promise<void> {
    const paths = this.pending.get(sessionId);
    if (paths === undefined) return;
    this.pending.delete(sessionId);
    const t = this.timers.get(sessionId);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(sessionId);
    }
    try {
      const dir = this.root();
      const file = join2(dir, `${sessionId}.json`);
      const body = JSON.stringify({ sessionId, updatedAt: this.now(), paths });
      await this.fs.mkdir(dir);
      await this.fs.writeFile(`${file}.tmp`, body);
      await this.fs.rename(`${file}.tmp`, file);
    } catch {
      // 吞咽（见上）
    }
  }

  /** 会话销毁：删 manifest + 取消在途去抖。 */
  async drop(sessionId: string): Promise<void> {
    const t = this.timers.get(sessionId);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(sessionId);
    }
    this.pending.delete(sessionId);
    try {
      await this.fs.remove(join2(this.root(), `${sessionId}.json`));
    } catch {
      // 不存在等 IO 异常吞咽（force 语义）
    }
  }

  /** 关停钩子：所有在途去抖立即落盘。 */
  async flushAll(): Promise<void> {
    for (const sid of [...this.pending.keys()]) await this.flush(sid);
  }

  /** 测试/观测用：在途未落盘会话集合。 */
  pendingSessions(): readonly string[] {
    return [...this.pending.keys()];
  }
}

/** hook 侧读取（也供测试直接消费）。 */
export async function readManifest(
  fs: Pick<ManifestFsPort, "readFile">,
  manifestRoot: string,
  sessionId: string,
): Promise<WriteManifest | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(join2(manifestRoot, `${sessionId}.json`));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WriteManifest>;
    if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.paths)) return undefined;
    return {
      sessionId: parsed.sessionId,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      paths: parsed.paths.filter((p): p is string => typeof p === "string"),
    };
  } catch {
    return undefined;
  }
}

/** manifest 路径约定（hook 脚本与 daemon 侧共用口径：daemon home 下 write-facts）。
 *  入参是 daemon home（~/.helix）本体——不拼 .helix 段（home 即它）。 */
export function manifestDir(helixHome: string): string {
  return join2(helixHome, "write-facts");
}
