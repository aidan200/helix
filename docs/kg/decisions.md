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
- **结局**：已落地并验证（E 层 CL-1-e2e-multi-session 分页断言 + restart-restore-all；契约 B §1.3/§1.4/§2.3 回填）。hotfix-20260822 补记（H-2 用户裁决）：加载更早触发面 = 分页胶囊点击——滚动到顶自动触发退役（scrollTop<=0 三重误触发：macOS 橡皮筋过冲/短内容恒 0/程序化落顶自触发，且为 e2e beforeCount 竞态源头）；会话切换恒贴底 + 视口锚定基线随 sessionId 重置（前插补偿只吃同会话高度，旧会话高度不进公式）。数据面（尾窗/游标/前插去重/hasMore 禁用）不变。

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

## AD-1 草稿会话生命周期：内存草稿「不可见 + 转正」（hotfix-20260820 / 用户定稿）

**digest**：动草稿会话、session.list 可见性、agent.instantiated 发布点、welcome 握手、draft 建会话链时读本文。

- **上下文**（用户实测四 bug 同根因）：草稿会话从未设计生命周期——daemon「恒有当前会话」的内存草稿经两面泄漏可见（listSessions 合并零条目热会话；createFresh 即写 agent.instantiated 事件），用户视角「空草稿被保存」；删除活跃会话硬编码转草稿；welcome attach 内存草稿被前端当真实会话激活；草稿态旧会话流式帧串台（frame.ts 守卫 activeId!==null 的 v0.1 假设被草稿态打破）。
- **选项**：① daemon 改「可无当前会话」+ 前端新增 none 视图态（welcome.sessionId 可空）；② 恒有会话不变——内存草稿有 id 但不落盘不可见、首个用户条目「转正」（同 id 复用不裂变），前端草稿保持 null-id。
- **裁决与理由**：用户选 ②——前后端逻辑统一（皆「恒有会话」，唯一区别 = 是否落盘）且协议纯 additive（TR-AD-23①）。定稿形态：a) listSessions 跳过零条目热会话；b) **instantiated 发布点 = 转正**（首个用户条目，promoteDraft 单点恰好一次 + created 补广播去重；draft 链显式 created 广播保持同步先于 sendMessage 防快照吞帧竞态）——取代 AD-5（M5）「会话创建即发布」；c) chat.send{draft:true} 命中零条目当前草稿 → 同 id 转正复用，不预建下一个草稿（懒建归 initialize/rotateCurrent 既有点）；d) 握手命中零条目草稿 → welcome.draft:true + 不 attach 不推快照，前端落草稿态（sessionId=null）；e) 无 none 态——删除活跃会话落草稿即统一的无会话表示（用户确认）；f) chat.send 加可选 model（建会话后首条消息前 setModel；同模型短路零事件，异模型先 promoteDraft 保 instantiated→model.changed 次序）；g) 前端串台双修：frame.ts 后台路由去 activeId!==null（model 配置族前置防误吞）+ ledger welcome attach 静默登记 full 档。
- **结局**：已落地并验证（daemon 453/0、shell 284/0、protocol 33/0、e2e 27/0；T4b 追修 CL-5 trace e2e 次序回归 2 例；热修记录 docs/hotfixes/2026-08-20-draft-session-lifecycle.md）。边界备案：忽略 welcome.draft 的旧客户端草稿握手后须显式 subscribe；set_default 后复用路径不隐式换新默认；零条目会话定向 steer 落盘不触发转正（稀有路径）。

## AD-2 trace 页应用式固定壳布局（hotfix-20260820 / 用户裁决）

**digest**：动 trace 页布局/滚动、评审原型残留、新增页面滚动模式时读本文。

- **上下文**：trace 页原型残留（DemoConsole 五态切换器 + 说明文案 + 路由文本 dev 实际可见）；详情列表无滚动容器无限延伸（body→.p1-page→.p1-tbody 高度链断裂）；布局沿用原型 sticky/页级滚动，与客户端形态冲突。
- **选项**：① 页级滚动（.p4-page 惯例：页面本体 overflow-y，页头随内容滚走）；② 应用式固定壳（页头/控制条/IconRail 固定不出窗口，仅结果框内滚）。
- **裁决与理由**：用户选 ②——「项目未来主要是客户端，不能让 header 或菜单栏滑出窗口」。定稿：DemoConsole 全链移除（组件/dev 管道/样式/i18n）；高度链 .p1-page→.p1-body→.p1-main→.p1-table-card→.p1-tbody 全程 flex+min-height:0，结果框内滚且高度随窗口自适应；实例面板固定栏 + .ip-list 自滚；上下文卡限高 42% 自滚防挤占；原型残留文案（trace.sub/route）清除；chevron 12px 居中方盒消非方盒旋转位移。
- **结局**：已落地并验证（F 层 fidelity 5/5——R-P1-1 断言按新裁决改写为固定壳契约成回归守护；E 层 4/4；shell 单测 284/0）。

## AD-1 SubAgent 经 wire 转发使用共享 CDP 单例（hotfix-20260822 / 用户裁决）

**digest**：给子进程开放 daemon 单例资源、评审进程外转发与 owner 归属隔离、DAG 节点化资源映射时读本文。

- **上下文**：P0-1（web-access 规划审核）否决子进程直连浏览器（各自连 = 管理面分裂），留白「子进程↔daemon 转发通道后置」——SubAgent 一直无 browser 工具（SubAgentProfile 7 工具）。CDP 单例（CdpConnectionManager）内嵌 daemon 进程，子进程是独立 bun 进程，无法共享内存对象。
- **选项**：①子进程直连 CDP（各 new 连接管理器）；②转发通道（子进程 RemoteBrowserPort + wire tool-req/tool-res 帧 + daemon 侧 ScopedBrowserProxy 归属代理）；③主线代办（agent_send 请主线操作浏览器）。
- **裁决与理由**：选 ②。四轮裁决要点：a) 转发通道保 P0-1 单例原则，BrowserTools/CoreToolExecutor 零改动（条件注册先例）；b) ownerId 单命名空间 = agentId（"main" = MAIN_INSTANCE_ID 保留值，非第二体系），各 agent 自开自关、不做所有权移交/共享，回收 = 终态钩子 reclaimOwner + idle sweep 同口径；c) 并发不引队列——安全边界 = tab 归属校验（操作集合不相交），非互斥（sendCDP 单 WS 在飞并发 + id 关联）；d) wire 白名单 = 12 个工具可达方法全量放行，管理面 4 方法（connect/onStatusChange/stop/reclaimOwner）不上 wire（越 owner 边界，归属校验兜不住，有意收窄）；e) lazy connect 调用方无关——SubAgent 首发调用即可拉起连接，主线幂等复用，连接归 daemon 与子进程生命周期解耦；f) 浏览器进程启动能力不做（helix 只发现不启动；未来 Launcher 落 daemon 侧——子进程 spawn 的浏览器临时 profile 不在发现矩阵，主线反不可见）；g) DAG 演进存档：BrowserPort 传输无关（进程内/IPC/未来网络 RPC 可替换），ownerId 直接当 nodeId，main 实例 tab 无终态钩子的缺口（idle sweep 兜底）待节点终态事件自然拉平。
- **结局**：已落地并验证（H-3：daemon 791/791 + shell 385/385 + tsc 零错 + E 层锚面 8/8；commit ee12e17）；规则化入 TR-AD-36。

## AD-1 SubAgent 编排推送闭环与过程监督（hotfix-20260823 / 用户裁决）

**digest**：评审 SubAgent 编排的等待/监督/终止机制、closure 送达保证、主会话委派提示词契约时读本文。

- **上下文**：2026-08-23 多会话实测（两 session 各派一 SubAgent 查天气）暴露四个问题：①SteerHooks 模块级共享实例跨会话 bind 覆盖——closure/abort 串台（A 会话的注入进了 B 会话 LLM 上下文，A 的 LLM 反而说「closure wasn't injected here」）；②无 wait 语义 + 提示词邀请「查询进度」——实测 14 次 agent_status 轮询 + MainAgent 抢跑自行 web_search；③closure 注入是裸 user 文本、无结构化标识（domain source=closure 不落盘不进 UI/LLM）；④aborting/stopped 时 closure 直接丢弃，「保证送达」前提破窗。
- **选项**：①加 wait 工具（阻塞拉取）；②wall-clock timeout 自动 kill；③推送闭环 + 周期进展报告 + 裁决权归 MainAgent/用户。
- **裁决与理由**：选 ③。a) 不加 wait 工具——与 AD-8 秒回+异步注入冲突，阻塞 wait 会把推送模型重新串行化（closure 到达时 main 卡在 wait 调用里，引入 steer/blocked-tool 交互复杂度）；b) 否决 wall-clock timeout——总时长不可区分「干活中」与「hang 死」，误杀长任务；c) 系统只负责送达信息、永不自动终止——stalled（lastEventAt）只警示不杀；周期进展报告（机械 Δ 信封）让 MainAgent 阶段性知情，连续零增量 → agent_inspect 核实 → 确无进展可 kill 重派，由 MainAgent/用户裁决；d) 提示词删「查询进度」轮询邀请，换正向契约（spawn 后结束回合 + closure/报告自动注入 + 不轮询不抢跑 + 零增量 inspect 核实）；e) closure 送达补齐——aborting 期间内存 FIFO 暂存，abort 收尾回 idle 逐条链式 flush（挂 dying run promise settle，规避 agent_end 同步回流段引擎在飞守卫竞态）；stopped 维持可观测丢弃（closure_records 已落盘）。
- **结局**：已落地并验证（T1 hooks 类引用 + T2 aborting flush + T3 报告机制/inspect/提示词：daemon 816/816 + tsc 零错 + default-reviewer 独立评审通过；commit dc2a120/88a50d2/3318d01）；规则化入 TR-AD-37/38/39。

## AD-2 spawn 锚取值反转与出窗语义确认（hotfix-20260823 / 用户裁决）

**digest**：评审 spawn 锚计算、SubAgent 卡片渲染位置、尾窗出窗行为时读本文。

- **上下文**：2026-08-23 用户实测显示 bug——SubAgent 卡片实时渲染在 agent_spawn 工具调用**之前**，切 session 走快照恢复后位置正常。考古（T7-explore）查明：双轨为契约 v0.3 §1 一次性有意设计（commit edfe3cd 同 commit 落地两轨，目的正是消灭前端旧双轨 liveAnchor/anchorFromSnapshot），规则①优先的承重理由 = 确定性权威（append-only 稳定域可重建）+ 重启恢复边界（spawnAnchors 内存 Map 不落盘不可重建，契约明言「不另建持久化事实源」）——两条理由均不因修复失效。但实现层两轨扫描面未真正同源：实时轨只扫 domain entries（tool 执行不落 Entry），快照轨扫 entries+toolCall 合并流——T2.1 记录在案的刻意选择（architecture-feedback.md:23「若在 spawn 瞬间计入 toolCalls 会把 agent_spawn 工具卡本身当锚——语义错误」）正是 bug 根源：刻意避开 toolCall 使锚落到更早的用户消息上，卡片反而跑到工具调用之前。
- **选项**：①实时轨扫描面补 toolCall 记录（钉值 = agent_spawn 工具调用 id，反转 T2.1 判断）；②改契约优先级（spawn 钉值恒优先）；③出窗加兑底桶（贴顶/贴底渲染）。
- **裁决与理由**：选 ①，否 ②③。①用户实测裁决：卡片在 spawn 工具调用前 = bug，正确位置 = 工具调用之后——T2.1「锚落工具卡 = 语义错误」判断反转成立；②契约优先级不动：规则①优先的两承重理由（确定性权威 + 重启兜底）依然成立，且 E-AgentInstance 禁忌禁止锚持久化，完全单轨架构上不可行；③出窗兑底不做——用户裁决「锚出窗的卡片 = 非本页对话历史的卡片，不需要渲染」：聊天流卡片 = 历史锚点标记，运行中实例实时感知归 DrawerRail 活跃事件条（queued+running 全量列表，与装载窗口无关，既有用户裁决行为契约），完成通知归 closure 注入，翻页装载锚后卡片反应式归位（现成行为，零改动）。
- **结局**：已落地并验证（T6：computeSpawnAnchor 扫描面补 toolCall 记录，TDD 先红后绿，daemon 818/818 + tsc 零错；commit d836470）；E-AgentInstance 描述/规则段同步（hotfix-20260823）。
