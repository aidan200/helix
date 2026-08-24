/**
 * 全局常量唯一落位（@helix/common，AD-1 / iter-20260821-dg90 T3.3）。
 *
 * 业务无关性纪律（TR-AD-28）：本包成员准入判据 = 「换一个产品仍然成立」
 * 的通用件；领域词汇（Session/Agent/Instance 等领域语义）一律拒绝入内
 * （评审守护——结构断言查不出，评审拦）。新常量落位先过判据，再进本文件。
 *
 * T10 实例 ID 统一（T10c 常量退役）：原 MAIN_INSTANCE_ID（"main"）已删除
 * ——现行契约下所有实例 instanceId = agent-<唯一串>，legacy "main" 判别
 * 由读侧 helper 承担（protocol projection/isMainInstance、shell
 * entities/session isMainChannel 各自单点，PROTOCOL.md §17.11）。
 */
