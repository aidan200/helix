# helix 架构决策档案（AD-N）

> 本文件承载 helix 的架构决策档案（AD-N，上下文/选项/裁决与理由/结局四节）——终验将跨迭代有效的设计事实沉淀于此。
> 注：kg A-1 模型下决策不是图节点（kind 仅 rule/entity）；AD-N 溯源由 TR 的 `derivedFrom: [AD-N]` 属性承载，
> 本文档为决策语义档案（人读 + 迭代引用），经 docs/INDEX.md 注册。
> TR 规则在 docs/kg/architecture-rules.md / testing-rules.md；业务实体在 docs/kg/domain.md。

## AD-1 聚合/窗口三层模型与尾窗快照（M3 落地定稿）

**digest**：动快照尾窗、加分页、调聚合与实例窗口边界时读本文。

- **上下文**：多会话 + 多实例（SubAgent）下，快照全量推送不可行（会话无界增长）；恢复重放需保留 per-instance 完整性。
- **选项**：① 全量快照 + 前端增量；② 尾窗快照 + 游标分页补历史；③ 前端自拉历史（无快照）。
- **裁决与理由**：选 ②。定稿参数：快照尾窗 30 条（TAIL_WINDOW_SIZE=30，per-instance channel 分组完整保留不截断——硬约束）；session.loadHistory 游标分页（页 50、上限 200，前插去重 + hasMore 禁用态）；清单/历史结果走点对点结果帧（TR-AD-21）；恢复重放含 SubAgent 历史（RestoreService.replaySubAgentHistory 双源去重）。
- **结局**：已落地并验证（E 层 CL-1-e2e-multi-session 分页断言 + restart-restore-all；契约 B §1.3/§1.4/§2.3 回填）。

## AD-2 模型模块（auth/目录/默认/切换，M3 落地定稿）

**digest**：接 provider 凭据、动模型目录、做模型切换链路时读本文。

- **上下文**：模型数据原挤在 config.json（model 字符串 + apiKeys）；需支持目录浏览/凭据管理/默认模型/运行期切换（下一 turn 生效）。
- **选项**：① 沿用 pi SettingsManager/auth.json/models.json 体系；② 自实现模型模块（auth.json + SQLite 默认 + 自研目录）+ config 瘦身。
- **裁决与理由**：选 ②（G-2 裁决）。定稿形态：①~/.helix/auth.json（Record<providerId, Credential 联合>，0600 + pid 锁 + 原子写，详见 E-认证凭据）；②默认模型 SQLite default_model 表单写；③ModelCatalog 自实现（builtin 39 + pi.dev overlay ETag/4h/防降级/落盘兜底，零 pi-coding-agent，落位 driven，详见 E-模型目录）；④set_model 链：AgentState.model 直改（in-flight 不变、下一 turn 生效，引擎不支持即抛错不静默）；⑤config.json 瘦身（模型数据面迁出，旧格式幂等迁移）；⑥skipConfig 重定义：真引擎模式 = options.engine 缺省，skipConfig 只跳过 config 读面。
- **结局**：已落地并验证（daemon 362 单测 + E 层 CL-3-e2e-model-chain：FakeLLM 模型感知 + auth.json 0600 + builtin fallback）。

## AD-3 事件分发统一信封路由（M3 落地定稿）

**digest**：扩事件分发、动 WS 路由、加会话投影或前端 dispatcher 时读本文。

- **上下文**：v0.1 事件无会话归属（单会话假设）；多会话需要每帧可路由到目标会话的订阅集。
- **选项**：① 事件 payload 内嵌 sessionId（消费端逐帧判读）；② 统一信封 Envelope.sessionId 路由位 + channel 章印（EVENT_CHANNELS 单点）。
- **裁决与理由**：选 ②。daemon 侧落地五点：①SchedulerService 只产事件零聚合写（守护断言入集成测试）；②SessionProjection 会话投影消费者（SubAgent Entry 落聚合 instanceId 归属 + usageLedger 并入 + write-through 迁入，幂等去重集）；③WS 统一信封 sessionId 路由 + EVENT_CHANNELS 章印；④恢复重放含 SubAgent 历史；⑤RowMapper/DtoMapper instanceId 行级对称透传。前端侧两层 dispatcher + store 拓扑与 daemon 同构（TR-AD-22）。
- **结局**：已落地并验证（session-projection 集成测试 + E 层 subagent-stream/restart-restore-all；契约 A 盖章 DtoMapper.ts:360-369）。

## AD-4 SessionRegistry 多会话容器（M3 落地定稿）

**digest**：写多会话容器、动会话生命周期、处理卸载与删除收口时读本文。

- **上下文**：单会话形态下 container 直连唯一 runtime；多会话需要会话级生命周期管理与并发前提。
- **选项**：① 每会话独立 daemon 进程；② 单 daemon 内 SessionRegistry 会话容器（懒加载/卸载/全局预算）。
- **裁决与理由**：选 ②（与 AD-7 全局单例一致）。定稿形态：①生命周期：懒加载（load→restore→buildRuntime）、30min 空闲卸载（执行中不卸载：agentState + hasActiveInstances 双判据）、删除四步收口（abort+stop → whenSettled+settleTimeoutMs 5s 超时防御上界 → cancelSession → 六表清行按序 → 移除广播）；②组合根工厂化（buildRuntime/engineFor 是唯一 new 面；DaemonOptions.engine 扩工厂形态注入多会话并发前提——引擎持有单 run 状态不可并发共享）；③调度器多会话共用全局预算；④启动全量元数据（restoreLatest 废弃）；⑤草稿建会话链（首条消息才落库，20 字符命名）；⑥WriteQueue 分仓（chainKeyOf(session_id) 路由，仓间互不阻塞）；⑦per-session 快照盖章同源（sessionStamp，TR-AD-5）。
- **结局**：已落地并验证（session-registry 集成测试全套 + E 层 CL-1-e2e-multi-session/switch-state-isolation 双跑绿）。
