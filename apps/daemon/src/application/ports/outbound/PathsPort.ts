/**
 * 路径解析出口端口（outbound，architecture.md §3.4 / §7.3）。
 *
 * 路径解析是纯计算（无外部系统），实现直接放 infrastructure/paths.ts，
 * 但 service 仍只依赖本端口、不知实现（framework-free 可测）。
 * 本文件只有接口定义（AG-01）。
 */
export interface PathsPort {
  /** 主目录（默认 ~/.helix，可被 --home 覆盖）。 */
  readonly home: string;
  configPath(): string;
  devTokenPath(): string;
  logsDir(): string;
  dbPath(): string;
}
