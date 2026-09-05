/**
 * WS 端口配置出站端口（outbound）。实现体 = 组合根内联装配（2026-09-05
 * config.json 瘦身：port 从 config.json 迁 runtime_config KV `daemon_port`
 * 键 + argv --port 覆盖；无独立 store 类——单个数字键经 RuntimeConfigPort
 * 直读直写，argv/实际监听端口由组合根持有）。
 *
 * 解析链（重启时读取）：argv --port（本次运行显式覆盖，不回写）>
 * KV daemon_port（设置页 config.set_port 写入）> 缺省 7333。
 * 运行期语义：port 是 WS 监听前定格的启动参数——set 后下次启动生效；
 * get 的 effectivePort 恒为本次运行实际值（UI 据此展示「重启生效」）。
 */
export interface PortConfigPort {
  /** 本次运行实际监听端口（argv 覆盖时 = argv 值）。 */
  effectivePort(): number;
  /** argv --port 是否覆盖了本次运行（true 时改存储不影响本次）。 */
  overriddenByArgv(): boolean;
  /** 存储端口（KV daemon_port；未设置 → null = 用缺省 7333）。 */
  storedPort(): number | null;
  /** 写入存储端口（单写通道，落盘完成即返回；下次启动生效）。 */
  setPort(port: number): Promise<void>;
}
