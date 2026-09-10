/**
 * SandboxConfigPort —— 沙箱开关配置出站口。
 *
 * 消费面（沙箱开关批，2026-09-12）：
 * - 组合根 sessionEngineFactory（main 会话创建时读——沙箱槽装配期定格）；
 * - SubagentLauncher（spawn 时读 → HELIX_SANDBOX env 透传子进程）；
 * - ws-server handlers/config.ts（config.get/set_sandbox 命令族）。
 *
 * 实现面：sqlite-session/SandboxConfigStore（RuntimeConfigPort KV 底座上
 * sandbox_config 单键 JSON，SchedulingConfigStore 同构）。
 */

/** 沙箱开关（与 KV sandbox_config 单键 JSON 同构）。 */
export interface SandboxConfig {
  enabled: boolean;
}

export interface SandboxConfigPort {
  /** 当前生效开关（存储值 ?? 缺省关；db 已关闭 → 最近已知值）。 */
  current(): SandboxConfig;
  /** 写入开关（单写通道，落盘完成即返回）。 */
  set(config: SandboxConfig): Promise<void>;
}
