/**
 * 全局常量唯一落位（@helix/common，AD-1 / iter-20260821-dg90 T3.3）。
 *
 * 业务无关性纪律（TR-AD-28）：本包成员准入判据 = 「换一个产品仍然成立」
 * 的通用件；领域词汇（Session/Agent/Instance 等领域语义）一律拒绝入内
 * （评审守护——结构断言查不出，评审拦）。新常量落位先过判据，再进本文件。
 */

/**
 * 主实例固定 id（O-4 裁决：会话创建即分配；持久化旧行回填常量与之同源，O-3）。
 *
 * AD-1 双源收编（T3.3）：原 apps/daemon/src/domain/agent/AgentInstance.ts 与
 * packages/protocol/src/envelope.ts 两处本地定义退役，唯一定义 = 本文件。
 * domain 经 AG-02① 白名单例外直引；protocol 为 re-export 通道（既有
 * @helix/protocol 消费面零 churn，本迭代不批量迁移既有消费点）；新代码直引
 * @helix/common。类型面取字面量型（D-4 裁决）：窄可赋宽（domain 消费点
 * string 面零破坏），宽不可赋窄（反向破坏 protocol 侧字面量联合既有类型面）。
 */
export const MAIN_INSTANCE_ID = "main" as const;
