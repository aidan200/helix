/**
 * ProxyConfigPort —— 网络代理配置出站口（网络代理批，2026-10-24）。
 *
 * 消费面：
 * - 组合根（container 装配序：buildPersistence 后立刻安装 proxyFetch wrapper
 *   ——进程级 globalThis.fetch 单点包装，覆盖全部出站 HTTP：LLM/embedding/
 *   STT/TTS/web 工具；运行期即热——每次请求读现值）；
 * - ws-server handlers/config.ts（config.get/set_proxy 命令族）。
 *
 * 实现面：sqlite-session/ProxyConfigStore（RuntimeConfigPort KV 底座上
 * proxy_config 单键 JSON，SandboxConfigStore 同构）。
 *
 * 失败安全方向 = 直连（与沙箱「失败=不锁死」哲学对称——代理配置坏了
 * 不能断网）：未启用/URL 非法/读面异常一律不走代理。
 */

/** 网络代理配置（与 KV proxy_config 单键 JSON 同构）。 */
export interface ProxyConfig {
  /** 代理开关（缺省 false——未配置即直连）。 */
  enabled: boolean;
  /**
   * 代理地址（支持 http:// / https://，可内嵌认证
   * user:pass@host:port；enabled=false 时允许空串占位）。
   */
  url: string;
}

export interface ProxyConfigPort {
  /** 当前生效配置（存储值 ?? 缺省关；db 已关闭 → 最近已知值）。 */
  current(): ProxyConfig;
  /** 写入（单写通道，落盘完成即返回；下一次请求即热生效）。 */
  set(config: ProxyConfig): Promise<void>;
}
