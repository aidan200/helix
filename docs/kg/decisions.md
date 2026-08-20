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

## AD-1 SubAgent engine.error 呈现面 = agent.failed error 字段（iter-20260819-erio / M5 落地定稿）

**digest**：动 SubAgent 错误透出、写 engine_error 事件分支、评审错误呈现面归属时读本文。

- **上下文**：SubAgent 真实 provider 错误（如「已达到 5 小时的使用上限」）原文不透出——engine.error 帧若挂 instanceId 广播，shell chat.ts 无 instanceId 分流会错位弹主聊天流、与主线错误单值槽互踩（F-6 Q4 方案 2 缺陷形态，AF-1 实证 DtoMapper 零改动假设不成立）。
- **选项**：① engine.error 帧挂 instanceId + 前端分流；② provider 原文塞 agent.failed error 字段走 closure 收口通道透出，engine.error 帧对 SubAgent 实例抑制不广播。
- **裁决与理由**：选 ②（方案 1）。呈现与数据分离：错误呈现面在 SubAgent 卡片/抽屉（TR-AD-17「SubAgent 内部细节不回主线」兑现）；DtoMapper engine.error case 加 SubAgent 守卫（instanceId ≠ 主实例时 return null）；领域事件仍经单写队列落 domain_events 作 trace 数据面（CL-5 通道）。呈现面归属留痕入 TR-AD-17 适用范围。
- **结局**：已落地并验证（E 层 realSubagent spec 两段断言：agent.failed error 含 provider 原文 + closure 摘要含 engine 原因且 closure_records 持久化一致；DtoMapper.ts:681-688 守卫）。

## AD-2 closure 兜底摘要并入错误原因（iter-20260819-erio / M5 落地定稿）

**digest**：动 closure 兜底格式、写 SubAgent 收口失败摘要时读本文。

- **上下文**：SubAgent 未按 closure 协议收口时兜底摘要不含引擎错误原因，用户只见「未收口」不见「为什么」。
- **选项**：① 各消费面（落盘/报告/注入）各自补错误字段；② 兜底摘要生成单点（ChildMain.ts）并入 engine 原因，三消费面自动跟随。
- **裁决与理由**：选 ②——单文件改动、零消费面改动。兜底格式「未按 closure 协议收口（engine: <原因>）：<lastAssistantText>」；engine_error 在 ChildMain start 回调捕获（与 lastAssistantText 并列的局部变量），兜底分支拼接并入。三消费面：closure_records 落盘（TR-AD-17 口径）/ reports md / SteerQueue 注入主线文本（TR-AD-19 恢复语义同源）。
- **结局**：已落地并验证（E 层两段断言之②，与 AD-1 联合断言于 TS2）。

## AD-4 契约版本策略：v0.3 补登 + v0.4 additive 批次（iter-20260819-erio / M5 落地定稿）

**digest**：升契约版本、补登契约历史、规划 additive 批次时读本文。

- **上下文**：PROTOCOL.md 正文停在 v0.2（M4 OI-FV-1「契约 SoT 落后于实际契约」遗留，44 处代码注释锚定迭代内文档的单点风险，实核为 10 处字符串锚点 AF-2）；本迭代新增 trace.query 命令族 + 两落盘事件需定批次归属。
- **选项**：① v0.3 补登与 v0.4 分两版本步进；② v0.3 历史补登 + 新面收拢为 v0.4 一次定形，迭代末一次到位。
- **裁决与理由**：选 ②（TR-AD-23② 一次定形律）。v0.3 补登三处（anchorEntryId / monitor tier / steer 寻址）入 PROTOCOL.md §12；v0.4 批次 = trace.query 命令族 + agent.instantiated + agent.model.changed 同批；EVENT_TYPES/EVENT_CHANNELS 守护计数与 type-surface 穷尽断言同步一次扩（37→40）；PROTOCOL_VERSION 是批次集合标记而非协商位，全仓字面量一步替换（AF-11：升位波及面 = 全仓版本字面量，今后升位任务验收口径写「全仓归零」）。
- **结局**：已落地并验证（type-surface 33/0 + arch-guard 24/0；PROTOCOL_VERSION "0.4" 单点 envelope.ts:15，运行时无 "0.3" 残留；v0.4 例证回写入 TR-AD-23 规则②）。

## AD-5 执行上下文数据面：agent.instantiated 携带 profileSnapshot（iter-20260819-erio / M5 落地定稿）

**digest**：加实例装配期快照、动 profileSnapshot、做执行上下文回溯面时读本文。

- **上下文**（F-9 溯源缺口）：系统提示词/工具集/compaction 声明全为代码常量零落盘，运行期无 instanceId → profile 反查；「定位来路」缺「它是什么配置、被给了什么指令」的回溯面。
- **选项**：① 扩 agent.spawned payload；② 新事件类型 agent.instantiated 统一覆盖主实例/SubAgent 两时点。
- **裁决与理由**：选 ②——主实例随会话创建无 spawned 事件，形态①覆盖缺口终需另造载体；②一次登记进 v0.4 批次（恰逢 AD-4 定形窗口）。发布点装配期单点：主实例 = 会话创建/re-profile（ChatService 引擎装配路径），SubAgent = spawn 时（快照携带三级链解析后的 model，AD-3 联动）；落盘经 WriteQueue 落 domain_events（payload TEXT JSON，零 schema 改动），投影面零动作、DtoMapper 无 case 不广播（AF-6）；降级语义：历史实例无快照页面显式标注「快照缺失」。快照存「组装结果全文」而非引用——为拼接时代（常量基础段 + 迭代状态/kg digest 注入）预留唯一回溯本体。二期边界：LLM 请求级窗口快照不做（createStreamFn 直通零包装无挂钩点）。
- **结局**：已落地并验证（CL-5 E2E 上下文卡双段断言 + 快照缺失降级断言；E 层 27/0）。

## AD-6 模型时间线事件化：agent.model.changed（iter-20260819-erio / M5 落地定稿）

**digest**：动模型切换链路、做模型时间线渲染、补事件落盘缺口时读本文。

- **上下文**（用户设计审查发现）：model.set 是原地换引擎（同一 instanceId 不同模型，F-5），而模型切换零事件零落盘——domain_events 无踪迹；单快照对持久实例会过时撒谎。
- **选项**：① 切换时覆写 instantiated 快照；② 新增 agent.model.changed 事件（{instanceId, from, to}）记变更轨迹。
- **裁决与理由**：选 ②——与 AD-5 同模式同批进 v0.4；发布点 = ChatService model.set 处理路径（主实例原地换引擎时；单发 SubAgent spawn 后不改模型无此事件）；消费面 = trace 页模型时间线（from→to 序列 + 当前生效值高亮）；上下文卡双段渲染 = 基准快照（instantiated）+ 变更轨迹（model.changed 序列 + compaction.completed 里程碑），单发 SubAgent 退化为纯快照零额外成本。
- **结局**：已落地并验证（CL-5 E2E 模型时间线高亮断言 + 重启一致性逐行相等 33 行）。
