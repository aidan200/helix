import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

/**
 * 路径解析单点（AD-14，architecture.md §7.3）。
 *
 * 全仓唯一 `os.homedir()` 调用点（AG-07）：`~/.helix` home 展开的跨平台处理
 * 全部收束于本模块，其余任何模块不得直接展开用户主目录；所有路径消费者
 * 经本模块取路径，framework-free 可测。
 *
 * 支持 `--home <dir>` 启动参数覆盖：main.ts 解析 argv 后显式传入，
 * 测试/集成测指向 tmp 目录，不碰真实 home（§7.3）。
 */

/** `~/.helix` 主目录（唯一配置/数据/日志主目录，AD-13 §7.1）下全部派生路径的集合。 */
export interface HelixPaths {
  /** 主目录（默认 `~/.helix`，可被 `--home <dir>` 覆盖）。 */
  readonly home: string;
  /** 主配置文件：`<home>/config.json`。 */
  readonly configPath: () => string;
  /** provider API key 凭据文件：`<home>/auth.json`（AD-2 auth 分层，0600+文件锁）。 */
  readonly authPath: () => string;
  /** ModelCatalog 落盘兑底缓存：`<home>/models-store.json`（AD-2 目录 overlay 持久化）。 */
  readonly modelsStorePath: () => string;
  /** dev token 固定文件：`<home>/dev-token`（WS 握手用）。 */
  readonly devTokenPath: () => string;
  /** 运行日志目录：`<home>/logs/`。 */
  readonly logsDir: () => string;
  /** 系统 SQLite：`<home>/helix.db`（领域状态持久化，WAL）。 */
  readonly dbPath: () => string;
  /** user 层技能目录：`<home>/skills`（M6 双层技能根之一；project 层 = <工作区>/.helix/skills，启动时定格，与 toolCwd 同款判定，不入本单点）。 */
  readonly skillsHome: () => string;
  /** 单例幂等锁：`<home>/daemon.lock`（AG-17，同 --home 二启拒绝）。 */
  readonly lockPath: () => string;
  /** 确保主目录存在（递归创建；首启目录不存在时的目录补建单点）。 */
  readonly ensureHome: () => void;
}

/**
 * 解析 helix 主目录：优先显式覆盖（`--home <dir>`），否则 `~/.helix`。
 * 本函数是全仓唯一 `os.homedir()` 调用点。
 */
export function resolveHome(explicitHome?: string): string {
  return explicitHome ?? path.join(os.homedir(), ".helix");
}

/** 构建全部派生路径（AD-13 §7.1 目录布局）。 */
export function createPaths(explicitHome?: string): HelixPaths {
  const home = resolveHome(explicitHome);
  return {
    home,
    configPath: () => path.join(home, "config.json"),
    authPath: () => path.join(home, "auth.json"),
    modelsStorePath: () => path.join(home, "models-store.json"),
    devTokenPath: () => path.join(home, "dev-token"),
    logsDir: () => path.join(home, "logs"),
    dbPath: () => path.join(home, "helix.db"),
    skillsHome: () => path.join(home, "skills"),
    lockPath: () => path.join(home, "daemon.lock"),
    ensureHome: () => mkdirSync(home, { recursive: true }),
  };
}
