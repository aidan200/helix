# 候选台账（candidates）

## pending

## deferred

## applied

### TR-AD-6
- changeType: 修改
- targetNode: TR-AD-6
- scope: docs/kg/architecture-rules.md TR-AD-6（规则正文与适用范围中「默认模型 → helix.db default_model 表」表述待同步为 runtime_config KV 表）
- project: helix
- reason: 用户裁决 D1/D2（原话「为了一个配置独占一个sqlite表有点多余了，应该创建一个专门的运行时配置的kv结构表」+ port 层一步到位抽通用面）：default_model 单行表退役 → runtime_config KV 表（key TEXT PRIMARY KEY, value TEXT NOT NULL）；DefaultModelPort 接口签名零变、实现换 RuntimeConfigStore KV 底座（default_model 键 + builtin 兜底语义包装）；启动幂等迁移（旧表有值且 KV 无键 → 迁入并 drop 旧表；KV 优先；二次打开幂等，WriteQueue.ts:553）；后续 last_mode 等运行时键复用 KV 底座（本期最小面未新增键）。AD-2「经常变的状态不进 JSON」原则不变，仅落点从独占表改 KV
- evidence: default-model.test.ts 8 例（新库直建 KV 表不建旧表 / KV 读写+fallback 兜底 / 落盘跨实例观测 / 旧表迁移幂等+KV 优先+空旧表仅 drop / set_default 后新建会话继承真引擎构造期 / 预置旧表库全链路启动迁移+重启幂等）；bun test apps/daemon 877 pass（T1 时点，895 终态）；commit 2390c1a
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/sqlite-session/RuntimeConfigStore.ts（新增）；schema.ts（runtime_config 建表 + default_model 停建）；WriteQueue.ts（KV job + :553 旧表迁移）；application/ports/outbound/RuntimeConfigPort.ts（新增）；DefaultModelStore.ts（KV 包装改写）；infrastructure/assembly/buildPersistence.ts（装配）
- sourceTask: task-T1（default-coder agt_XRNQTP99EM2A 超时未闭环 + MainAgent 复核验收，2026-08-24）
- createdIn: task-20260824-p1-mode
- decisionLog: 用户裁决「apply吧」（2026-08-24）——节点正文直写（规则/适用范围 default_model 表述 → runtime_config KV 表；testedBy 补 default-model.test.ts；updatedIn 刷新）

### TR-AD-2-r2
- changeType: 修改
- targetNode: TR-AD-2
- scope: docs/kg/architecture-rules.md TR-AD-2（outbound port 清单与计数：生效 11 → 12，补 RuntimeConfigPort）
- project: helix
- reason: P1 T1 新增 RuntimeConfigPort（通用运行时配置 KV 出站口，get/set）：outbound 生效 port 11 → 12；DefaultModelPort 保留（KV 包装，调用面零改动——buildSessionStack/ModelService/container 消费点不变）；守护测试 ports 文件数 ≥9 为下限断言、与 12 兼容无需调整
- evidence: arch-guard.test.ts + protocol-import.test.ts pass；四包 typecheck 全绿；commit 2390c1a
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/ports/outbound/RuntimeConfigPort.ts（新增，port 文件只放接口）；apps/daemon/src/adapters/driven/sqlite-session/RuntimeConfigStore.ts（实现，落位与 DefaultModelStore 同构）
- sourceTask: task-T1（default-coder agt_XRNQTP99EM2A + MainAgent 复核验收，2026-08-24）
- createdIn: task-20260824-p1-mode
- decisionLog: 用户裁决「apply吧」（2026-08-24）——节点正文直写（outbound 清单 11 → 12 补 RuntimeConfigPort；TR-AD-1 节点内镜像枚举同批纠正）

### E-AgentProfile-r3
- changeType: 修改
- targetNode: E-AgentProfile
- scope: docs/kg/domain.md E-AgentProfile（model 槽位段绑定语境：main-session 绑定从硬编码改模式注册表驱动）
- project: helix
- reason: P1 会话模式：main 实例 profileKind 不再硬编码 "main-session"——session 一对一绑定模式（session.mode 建会话定格），profileKind 解析单点 = daemon application/services/modes.ts（import @helix/protocol MODES 注册表——domain 层禁 import protocol，AG-02 白名单，故落 application；未知/缺省 mode fallback default）；engineFor 模型/thinking 槽位 kind 参数化（buildSessionStack 从 profileKindOf(mode) 取值，default 下行为零变化；解析链优先级本身不变：槽位 ?? 全局兑底）；热草稿转正复用条件加 profileKind 一致性（不一致丢弃重建走 createFresh，零条目草稿无成本；复用零条目前提不因一致弱化——sendMessage 同步落聚合使转正后必有内容）；session_state.mode 持久化（可空列 + 守护式补列 + 恢复侧 resolveModeId 归一旧行 default，T10a main_instance_id 同构形态）
- evidence: modes.test.ts（结构守护：engineFor 槽位 kind 从 mode 解析、字面量参数化钉子）；session-registry-draft.test.ts（profileKind 不一致丢弃重建 + 复用前提钉死）；session-registry.test.ts 冷恢复 + restore-restart.test.ts SIGTERM 重启快照等价（mode 持久化前后对照）；chat-send-mode.test.ts（透传/缺省/非草稿链忽略）；daemon 895 pass；commit 4da73d4
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/modes.ts（resolveModeId/profileKindOf 单点）；apps/daemon/src/infrastructure/assembly/buildSessionStack.ts（engineFor(sessionId, mode?) 槽位参数化）；apps/daemon/src/application/services/SessionRegistry.ts（startDraftSession mode 参 + 复用条件 + 实例创建）；sqlite-session schema.ts/WriteQueue.ts/rows/RowMapper.ts（mode 列）+ RestoreService.ts:110-112（归一）
- sourceTask: task-T3（default-coder agt_2VAXTR1J1YB5 半途死亡 + agt_T2PPM81MYDK5 续作闭环，2026-08-24）
- createdIn: task-20260824-p1-mode
- decisionLog: 用户裁决「apply吧」（2026-08-24）——节点正文直写（描述/规则/关系三段补模式注册表驱动；顺带纠正 TR-AD-24-r3 两级链与 TR-AD-40-r4 默认关在本节点的滞后残留——四级→两级、兜底 medium→默认关、默认模型存储→runtime_config 键）

### TR-AD-49
- changeType: 新增
- scope: docs/kg/architecture-rules.md（技术规则新增——会话模式机制：绑定/锁定语义/过程信息边界/扩展路线/shell 读面）
- project: helix
- reason: 用户裁决序列（P1 设计对话 2026-08-24）：①模式 = session 与 agent 绑定的一等概念，注册表在 @helix/protocol（MODES/ModeId/DEFAULT_MODE_ID；ModeSpec.kind = single|staged|orchestrated 三值联合——P2 phase/P3 workflow 不返工；mode wire 面一律 string + 未知 fallback default，类型层不锁死联合使 fallback 可表达）；②锁定语义 = 结构不可能（非校验拒绝）：草稿切换唯一入口 = shell ui/set-draft-mode（仅草稿生效 + 同步丢弃 draft model/thinking 暂存），唯一上送点 = chat.send{draft:true,mode}（非 default 才带），daemon 唯一消费点 = startDraftSession；建会话定格落库 + 快照/welcome 回带只读；无 mode.set 命令、非草稿链 mode 忽略（测试钉死）；③过程信息边界（D6，用户原话「过程信息的生命周期是临时的，仅用于某个模式的某个session中，一旦结束了就不需要了，需要持久化的信息都在知识图谱」）：模式过程信息（P2 迭代空间/P3 工作流空间、阶段交接摘要）= session 级临时态，会话结束销毁、不落 workspace 文件不建持久表；跨会话沉淀归未来「项目知识图谱」（随更改动态更新）——过程空间永不自带持久层，本边界约束 P2/P3 设计；④扩展路线：P2 phase（staged：design/build/verify 三阶段 agent；阶段切换 = main 实例收口换新实例（同 session 新 profileKind，F1.9 一等创建/销毁天然支持）+ 交接摘要注入新实例初始上下文（closure summary 形态），时机倾向 T1 切换时收口生成（P2 定稿）；resource_state 槽位按 profileKind 天然隔离三 agent 配置；欢迎词走前端 i18n 渲染不进 context）；P3 workflow（orchestrated：编排者 agent 常驻 + node = agent/逻辑节点，循环/并行/分支/节点退出复用既有 agent_spawn/send/status 编排工具 + closure 协议，共享过程空间基础设施）；⑤shell 读面：header 模式选择器（草稿可切/已建只读，MODES 数据驱动）替换 main-session 静态 chip（chat.header.session 词条退役）；草稿徽标三级回退 = 本地暂存 ?? 模式槽位模型 ?? 全局默认（agentConfig.slots = agent.config.list.result 真消费提升的 topology 读面，connected 初拉 + revision 失效重拉，不新建第三条平行配置读面）；thinking picker 草稿刻度基准 = 槽位模型能力位、显示值 = 本地暂存 ?? 槽位 thinking ?? 默认关；已建会话语义零侵染（P-3 菜单与 thinking.set 覆盖链不动）
- evidence: protocol 93 + daemon 895 + shell 515 全绿；四包 typecheck；e2e 28 fail 经基线对照（P1 前 e4f3990 同结果）确认环境既有非回归；chat-send-mode.test.ts ⑥ 非草稿链零调用钉死；session-mode.test.ts 12 例（切换丢弃/同值仍丢弃/草稿文本附件不丢/已建防御/快照收权/切换重置/new-draft 重置/welcome 三态）；P-1-top-bar.test.tsx（草稿可切/已建只读/home chip 保留）；SessionContext.mode.test.tsx 4 例（slots 初拉/失效重拉/端到端/send mode 透传）；PROTOCOL.md §18 微批登记（版本位不 bump，bump 决策留后续批次）；commits 460b048/4da73d4/f04b9d9
- implementationStatus: 完整实现（P1 范围；P2/P3 为路线图非本期交付）
- implementedCode: packages/protocol/src/modes.ts（注册表）；apps/daemon/src/application/services/modes.ts（解析单点）；apps/shell/src/entities/session/model/state.ts:364-371,437-442（SessionState.mode + ui/set-draft-mode）；consumers/agent-config.ts:53-69（slots 读面）+ consumers/snapshot.ts/conn.ts（收权）；widgets/top-bar/ui/P-1-top-bar.tsx:41-134（ModeChip）+ :174-199（三级徽标回退）；features/thinking-level/ui/ComposerThinkingPicker.tsx:89-115（草稿基准换源）；shared/api/commands.ts:65-70（chatSendDraftCommand mode）
- sourceTask: task-T2/T3/T4（default-coder agt_13MPD57TNT5A / agt_2VAXTR1J1YB5+agt_T2PPM81MYDK5 / agt_E50DZR0MPZNQ+agt_A8AQGXXMHR8W，2026-08-24；含 T3/T4 两条 agent 沉淀候选并入：session_state.mode 列形态、agentConfig.slots 读面）
- createdIn: task-20260824-p1-mode
- decisionLog: 用户裁决「apply吧」（2026-08-24）——新增规则发号 TR-AD-49 落 architecture-rules.md 末尾（kg-node frontmatter + 规则/理由/适用范围/反例；formalId 由 AD-default-20260824-5 发号转换）

### TR-AD-40-r4
- changeType: 修改
- targetNode: TR-AD-40
- scope: docs/kg/architecture-rules.md TR-AD-40（链语义改默认关 + off 升格 + setModel 重播——节点正文「兜底 medium」旧语义待同步）
- project: helix
- reason: 用户裁决 D 方案（思考默认不开启）+「off 升格为合法 override 值」：主会话链改 [会话覆盖, profile 槽位]（删兜底 medium，全链未配置 = 不传 reasoning = pi-ai 显式关思考）；off 为合法 override 值——resolveEffectiveThinking 在 clampThinkingLevel 前短路返回 undefined（off:null map 模型 clamp(off) 会向上找最近支持档、语义反转「想关反而开」，短路必须先于 clamp）；SubAgent 链去兜底（未配置 → HELIX_THINKING_LEVEL env 缺席 → 子进程不装注入器）；model.set 成功后重播 thinking.changed（换模只改 effective 不改 override；引擎无 currentThinking 观测面不广播）；协议 §17.11 批内补登 + AgentInstantiatedPayload.thinkingLevel 必填→可选协同
- evidence: thinking-set-chain.test.ts off:null 反例钉桩（旧实现 effective=minimal 语义反转实锤）+ setModel 重播 WS 用例；PROTOCOL.md §15.8/§16.4/§16.5/§17.11 补登；bun test apps/daemon 865 pass（T1 时点）；commit a9a6c9d
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/thinking-resolve.ts:30-33（off 短路）；apps/daemon/src/infrastructure/assembly/buildSessionStack.ts:271,373-376（删兜底）；apps/daemon/src/application/services/ModelService.ts:85-91（setModel 重播）；apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts（resolveThinkingFor 去兜底）
- sourceTask: task-T1（default-coder agt_T75RT55AB6G，2026-08-24）
- createdIn: task-20260824-t1
- decisionLog: 用户裁决「apply吧」（2026-08-24 批量人审）——formalId=TR-AD-40 与既有 applied 条目撞号，直写先例（iter-20260823-6ps5 同款）：节点正文+围栏已直写落库（链改 [覆盖, 槽位] 两级 + 默认关 + off clamp 前短路 + setModel 重播 + instantiated.thinkingLevel 可选）。

### E-AgentInstance-r5
- changeType: 修改
- targetNode: E-AgentInstance
- scope: docs/kg/domain.md E-AgentInstance（实例 ID 统一 agent-<唯一串> 含 main；kind 判别 + legacy 只读兼容 + wire 归属编码一致性）
- project: helix
- reason: 用户裁决「agent的id应该是同一的agent-N，包括main agent……未来一个session中的main agent也可能是多个的，所以都用main会有问题。N不能是纯数字，而是Id生成的逻辑，一个不易重复的字符串」+ 迁移方案 A（一次性全切 + 旧行只读兼容）：所有实例（含 main）instanceId = agent-<crypto.randomUUID 派生 hex 唯一串>（生成单点 newInstanceId）；主/Sub 区分由 kind 承载（AgentInstanceDto.kind + isMainInstanceId/isMainChannel/isWireMainAttribution 判别单点——shell/daemon/wire 三层同构）；legacy "main" 字面/缺省 = 读侧推断（历史行只读兼容，写侧不再产出）；seq/agentSeqOf/maxAgentSeq 序号基线整体退役（唯一串下无序号概念）；wire 写侧全实例显式携带 instanceId（「省略=main」线格式优化退役为读侧兼容）；持久化 session_state.main_instance_id 列 + 5 表 DEFAULT main 回填保留；wire 归属编码一致性铁律：thinking delta 载荷与 completed entry.instanceId 同编码（主实例归一 legacy main——错位致 shell thinkingStreams 槽位键悬挂，T10d R4 红点根因）；MAIN_INSTANCE_ID 常量全仓退役
- evidence: T10a-d 全链：daemon 872 绿（agent-hex 正则钉 + 旧库恢复兼容用例）+ protocol 87（envelope 写侧显式携带钉）+ shell 478（新形态/legacy 两钉）+ E 层 e2e 31/31；commits 668a522（15 增量）/ed5cf3a..5ccd416/248c3a4+333f82d/072657b+037f794+f1f2f92+8faa5a4
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/domain/agent/AgentInstance.ts（newInstanceId + agentSeqOf 退役）；apps/daemon/src/application/services/scheduler/SchedulerService.ts（spawn 唯一串）；apps/daemon/src/adapters/driving/ws-server/EventStream.ts:265-275（delta 归属编码）；apps/daemon/src/adapters/driving/ws-server/EntryDtoMapper.ts（isWireMainAttribution）；apps/shell/src/entities/session/model/state.ts（isMainChannel + mainInstanceId 快照习得）
- sourceTask: task-T10a/b/c/d（default-coder agt_X10DEN2BAJ0W + agt_FP723FQCWQ7W + agt_W3EWEQ0WNYPC + agt_0TNJM95GZ2PY + MainAgent，2026-08-24）
- createdIn: task-20260824-t10
- decisionLog: 用户裁决「apply吧」（2026-08-24 批量人审）——formalId=E-AgentInstance 与既有 applied 条目撞号，直写先例：节点正文+围栏已直写落库（agent-<hex> 统一含 main + kind 判别 + legacy 只读兼容 + wire 归属编码一致性铁律 + 序号基线退役）。

### TR-AD-24-r3
- changeType: 修改
- targetNode: TR-AD-24
- scope: docs/kg/architecture-rules.md TR-AD-24（SubAgent 模型链四级→两级——节点正文已随 T12 commit 直写，本条补台账审计痕）
- project: helix
- reason: 用户裁决③「只需要subagent根据自己的profile来就行，没有spawn，也没有继承main session的选择」：SubAgent 模型链砍 spawn 会话快照级——四级（profile.model ?? kind 槽位 ?? spawn 会话快照 ?? 全局兑底）改两级（profile.model ?? subagent-worker 槽位 ?? 全局兑底，resolveSubagentModelId 单点供给 spawn 透传/快照）。语义收益：SubAgent 只认自身 profile、不继承 main session 选择；P-2 能力预览基准（槽位模型 ?? 全局默认）与 spawn 实际模型同源——「配置被静默稀释」根因消除（实证：会话模型 A + 槽位 B → spawn 用 B）。backfill.currentModelOf/spawnModelSource 装配退役。注：节点正文与 derivedFrom（T12 用户裁决）已随 T12 commit a23700c 直写落库，本条为台账审计补录
- evidence: subagent-model-chain 测试矩阵（两级链 + 会话模型不泄漏钉桩）；container.ts backfill 退役；P-2 subagent 卡缺省文案「跟随全局默认」；bun test 872 绿；commit a23700c（MainAgent 验签代签——agent 超时未闭环）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts（resolveModelFor 两级链）；apps/daemon/src/infrastructure/assembly/buildSessionStack.ts:331-338（spawn 入参改 resolveSubagentModelId）；apps/daemon/src/infrastructure/container.ts:396-397（backfill 退役）
- sourceTask: task-T12（default-coder agt_Q4ZRM3B75YVH 超时 + MainAgent 验签，2026-08-24）
- createdIn: task-20260824-t12
- decisionLog: 用户裁决「apply吧」（2026-08-24 批量人审）——formalId=TR-AD-24 与既有 discarded 条目撞号，直写先例：节点正文已随 T12 commit a23700c 直写（两级链），本次补围栏 updatedIn 与台账审计痕。

### TR-AD-8-r2（task-20260821-s1s4）
- changeType: 修改
- targetNode: TR-AD-8
- scope: docs/kg/architecture-rules.md TR-AD-8（路由终态修订 + AppLayout 统一布局壳契约；适用范围/反例/frontmatter 同步）
- project: helix
- reason: S1-S4 布局统一用户裁决：四页自建页壳（app-header/p4-head/ag-head/p1-head 三套头部三种滚动模型）收敛为 AppLayout 统一壳（header 48px 全宽固定 + sidebar 可选槽 + main 唯一滚动容器）；路由六页签→五页签（/models 独立页退役，模型配置迁 settings 分区导航首项，chat 快捷入口链同批退役）；IconRail 品牌位换 HelixLogo、主题切换单钮入 rail（header 分段钮退役）；各页 sidebar 语义自决（chat 会话清单/trace 上下分区/settings 分区导航/project 槽位预留）；scanline 全局单份；沉淀点：AppLayout 布局契约 + 清单选择器 sidebar 化模式（TraceSidebar）
- evidence: 集成终验 336/336 单测 + tsc 零错 + e2e 全量 31 passed（F 层 mock + E 层真 daemon）；commit 96beca4/290eca1/4c87172/df28ca0/ef6176d
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/widgets/app-layout/ui/AppLayout.tsx；apps/shell/src/widgets/nav-rail/ui/IconRail.tsx；apps/shell/src/pages/settings/ui/SettingsNav.tsx；apps/shell/src/pages/trace/ui/TraceSidebar.tsx
- sourceTask: S1-S4 前端布局统一（MainAgent，2026-08-21）
- createdIn: task-20260821-s1s4
- decisionLog: 用户裁决「按上述内容发起 kg 同步」——直写落盘（formalId=TR-AD-8，节点 id 稳定）

### E-AgentProfile-r2（task-20260821-s1s4）
- changeType: 修改
- targetNode: E-AgentProfile
- scope: docs/kg/domain.md E-AgentProfile 描述段 + docs/kg/architecture-rules.md TR-AD-24 适用范围（UI 承接事实文本修正）
- project: helix
- reason: 两处「UI 管理归 skills 页下迭代」过时：智能体页（/skills 路由）已承接 profile kind 维配置 UI（双 kind 卡片模型/工具/技能），模型下拉复用 filterAvailableModels 与 chat P-3 同一可用性口径（零复制实现，含 requestAuthList 数据链）
- evidence: S3a 闭环（test:shell 328/328；F 层 e2e 129/129；E 层 CL-skills-e2e 4/4 真 daemon）
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/pages/skills/AgentPage.tsx；apps/shell/src/features/model-switch/model/available-models.ts
- sourceTask: S3a（SubAgent 实现 + MainAgent 同步提案，2026-08-21）
- createdIn: task-20260821-s1s4
- decisionLog: 用户裁决「按上述内容发起 kg 同步」——直写落盘（formalId=E-AgentProfile，节点 id 稳定）

### E-智能体配置资源（iter-20260821-m6）
- changeType: 新增
- scope: docs/kg/domain.md（业务实体新增）
- project: helix
- reason: M6 新业务实体：按 profile kind 维的资源启停状态（resource_state 表，三资源类型，缺省无记录=启用，合取生效语义）；main 槽位四级链/subagent 槽位三级链 UI 化；skills 双层目录扫描
- evidence: M6 T1 闭环（resource-state.test/resource-service.test/skill-scanner.test 全绿）；E 层 CL-skills-e2e 4/4（toggle 持久/模型槽位往返/磁盘漂移 skipped）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/sqlite-session/ResourceStateStore.ts；application/services/ResourceService.ts；adapters/driven/pi-engine/SkillScanner.ts
- sourceTask: M6 规划+T1（MainAgent，2026-08-21）
- createdIn: iter-20260821-m6
- decisionLog: M6 收尾用户裁决「全 apply」——四条核心候选一次性落盘（提案全文存工作区 docs/temp/development/（非仓内），此处为仓内事实源）

### TR-AD-27（iter-20260821-m6）
- changeType: 新增
- scope: docs/kg/architecture-rules.md（技术规则新增）
- project: helix
- reason: SystemPrompt 三段组装器规则化：组装唯一来源+同源派生双断+agentskills.io 内容对齐（格式自决）+无条件化纪律（用户裁决：错配=使用不当）；双源漂移治愈（profile-slim 词边界断言常设守护）
- evidence: M6 T2 闭环（system-prompt-assembler.test ①-⑦/profile-slim.test 红→绿分离可辨）；resource-refresh-chain.test toggle 后下一 run systemPrompt 变化断言
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/SystemPromptAssembler.ts；adapters/driven/tools/ToolPromptSnippets.ts
- sourceTask: M6 T2（SubAgent sediment + MainAgent 提案，2026-08-21）
- createdIn: iter-20260821-m6
- decisionLog: M6 收尾用户裁决「全 apply」

### TR-AD-24-r2（iter-20260821-m6）
- changeType: 修改
- targetNode: TR-AD-24
- scope: docs/kg/architecture-rules.md TR-AD-24（state 直改族谱扩面）
- project: helix
- reason: setTools/setSystemPrompt 与 setModel 同构直改六层链（不走 prepareNextTurn——CompactionHook 首非空短路机械裁决同源）；pi 官方语义背书（Assigning state.tools copies the top-level array）；kind 维配置变更刷新链 + SubAgent 代际生效 + main 槽位四级链读面
- evidence: M6 T2 闭环（engine-state-mutation.test ② in-flight 定格机械判据——FakeLLM 捕获 llmContext）；resource-refresh-chain.test ③（toggle 关 grep 后 tools 收缩 7 名双断）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime.ts（setTools/setSystemPrompt）；PiAgentEngineAdapter.ts；AgentEnginePort.ts；ChatService.ts
- sourceTask: M6 T2（SubAgent sediment + MainAgent 提案，2026-08-21）
- createdIn: iter-20260821-m6
- decisionLog: M6 收尾用户裁决「全 apply」；同节点二次修改按 desk 先例直写落盘（formalId=TR-AD-24，节点 id 稳定）

### TR-AD-23-r2（iter-20260821-m6）
- changeType: 修改
- targetNode: TR-AD-23
- scope: docs/kg/architecture-rules.md TR-AD-23（例证链补 v0.6）
- project: helix
- reason: 契约版本一次定形例证链第四例：v0.6 = agent.config.* 命令族 additive（22→24 命令 + 40→43 事件 + snippet 字段补登），四面同构同批零形状变更
- evidence: M6 T3 闭环（sot 五断言含 ④ agent.config presence 8 条；catalog 逐字面量清单；PROTOCOL.md §15.3/§16.4/§17.6 登记）
- implementationStatus: 完整实现
- implementedCode: packages/protocol/src/commands.ts；packages/protocol/src/events/agent.ts；packages/protocol/src/events/index.ts；packages/protocol/PROTOCOL.md
- sourceTask: M6 T3（SubAgent sediment + MainAgent 提案，2026-08-21）
- createdIn: iter-20260821-m6
- decisionLog: M6 收尾用户裁决「全 apply」；同节点二次修改按 desk 先例直写落盘（formalId=TR-AD-23）

### TR-AD-2
- changeType: 修改
- targetNode: TR-AD-2
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：TR-AD-2 规则文本漂移——①outbound 端口枚举不全（文本列 3 个，实际 6 个：AgentEnginePort/SessionRepositoryPort/ToolExecutorPort/EventPublisherPort/SystemPort/ClockPort）；②「由 driven adapter 实现」不普遍成立（EventPublisherPort 实现方在 driving 侧：EventStream.ts:24 / CliAdapter.ts:13；ClockPort 由组合根 container.ts:130 内联实现）；③PathsPort 定义后悬空（全仓零实现零消费，与架构审计 Minor 发现同源）。port 零实现与 inbound/outbound 分向核心约束本身成立，仅文本滞后。修正方向：规则文本改（枚举更新 + 实现方表述改为「由 adapter 或组合根实现」，PathsPort 处置联动架构审计裁决）
- evidence: final-verification/l3-review-rules.md TR-AD-2 详评；EventStream.ts:24、CliAdapter.ts:13、container.ts:130、ports/outbound/PathsPort.ts
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/ports/outbound/*（6 ports）；adapters/driving/ws-server/EventStream.ts:24；adapters/driving/cli/CliAdapter.ts:13；infrastructure/container.ts:130
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE 13 条复核 8 一致 5 不一致）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-②（用户批准）：L3 语义复核判文本漂移——outbound 枚举补全 6 个、实现方表述改「driven/driving/组合根三类落位」、PathsPort 悬空注记；同步补 governs 边与代码锚（决策 E）

### TR-AD-7
- changeType: 修改
- targetNode: TR-AD-7
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：TR-AD-7 单句「pi 库 import 只允许出现在 adapters/driven/pi-engine」与其自身工具条款矛盾——CoreToolExecutor/GrepTool（adapters/driven/tools/）运行时 import pi-agent-core/node 是工具封装条款（AD-10）的必然要求；守护测试 AG-04 实际口径已允许 pi-engine 与 tools 两目录，代码与守护一致、唯规则文本滞后。修正方向：规则文本改为「仅允许出现在 adapters/driven/pi-engine 与 adapters/driven/tools（工具接线域）」，与 TR-TEST-2 ① 同根因一次修正
- evidence: final-verification/l3-review-rules.md TR-AD-7 详评；CoreToolExecutor.ts:6,8,14 / GrepTool.ts:6-7；arch-guard.test.ts AG-04 describe 两目录口径
- implementationStatus: 完整实现
- implementedCode: adapters/driven/tools/CoreToolExecutor.ts:6-14；adapters/driven/tools/GrepTool.ts:6-7；test/arch-guard/arch-guard.test.ts AG-04
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-②（用户批准）：pi import 边界改为「pi-engine 与 driven/tools 工具接线域」两目录口径（与守护 AG-04 一致，消除与 AD-10 工具条款的自相矛盾）；联动 TR-TEST-2 同批修正

### TR-TEST-1
- changeType: 修改
- targetNode: TR-TEST-1
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：TR-TEST-1 三处文本漂移——①「测试统一用 Bun test 运行器」过宽（daemon=bun test，shell=vitest，fidelity/e2e=Playwright 三轨实状）；②unit 层定义「domain 纯单测」滞后（test/unit 实含 infrastructure/adapter 模块单测 7 文件）；③fidelity 保真面「保留真 runtime/WS/持久化链路」与 F 层实现错位（F 层=浏览器侧 fake WebSocket 注入无 daemon；该描述现状更贴近 E 层=真 daemon+FakeLLM+真 WS+真持久化）。四层机制与 e2e 六步口径本身成立。修正方向：规则文本改（三处口径各一句）；F/E 层正式重定义与 SPEC-iter-20260815-6tss-1/2 终验裁决联动
- evidence: final-verification/l3-review-rules.md TR-TEST-1 详评；package.json:7,12；e2e/harness/{mock-init,fixtures}.ts 头注；apps/daemon/test/unit/*
- implementationStatus: 完整实现
- implementedCode: package.json test 脚本三轨；apps/daemon/test/unit/*；e2e/harness/*（F 层）；apps/daemon/test/e2e/launcher.ts（E 层）
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-②（用户批准）：三处口径修正——运行器三轨（bun test/vitest/Playwright）、unit 层含 infrastructure/adapter 模块单测、fidelity 保真面改为 F 层 fake WebSocket 注入 + e2e=E 层真 daemon 闭环

### TR-TEST-2
- changeType: 修改
- targetNode: TR-TEST-2
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：TR-TEST-2 ①「pi 库 import 仅出现在 adapters/driven/pi-engine」与守护测试 AG-04 实际口径（pi-engine 与 tools 两目录）不一致——与 TR-AD-7 同根因，建议联动一次修正。四项守护机制本身（依赖方向扫描/port 零实现/写路径唯一/TestProfile 扩展公式）全部存在且实跑 27 pass 全绿
- evidence: final-verification/l3-review-rules.md TR-TEST-2 详评；arch-guard.test.ts AG-04 标题口径
- implementationStatus: 完整实现
- implementedCode: apps/daemon/test/arch-guard/arch-guard.test.ts（AG-01/02/04/06/10/11）+ apps/shell/src/tests/ag-scans.test.ts（AG-13/14/15/16）
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-②（用户批准）：①pi import 口径与 TR-AD-7 联动改两目录；其余三项守护机制表述不变（复核确认全部在位且实跑 27 pass）

### TR-TEST-5
- changeType: 新增
- scope: domain
- project: helix
- reason: 可复用 e2e harness 基座：mock-init（addInitScript 替换 window.WebSocket 实现剧本回放注入，保留 OPEN/CONNECTING 静态常量防 readyState 门控吞帧；vite HMR 透传原生）/ protocol（帧构造类型直引 @helix/protocol，mock 与真实协议零漂移）/ scenarios（S1/S2/S3/S5/S7 剧本）/ MockController / style-utils（token 通道变量派生值断言 + transition 收敛 poll + 圆角四角展开）。TS3（真 daemon + FakeLLM E 层）与 TS4（重启恢复）及后续迭代表现验证直接同构迁移：仅将 fake WebSocket 换成真连接 + daemon 装配。候选落点建议：testing-rules 新 TR-TEST 条目（表现验证 mock 挂点与契约等价纪律）或并入 TR-TEST-3 正文扩展——由终验人审裁决（proposedId SPEC-iter-20260815-6tss-1 为临时号，正式号以人审签发为准）
- evidence: worktree commit 51b46ff（分支 dev-iter-20260815-6tss）：e2e/ 18 文件 +1663 行（harness 7 模块 + 6 个 fidelity spec + playwright.config.ts），git diff 对 apps/packages 生产源码 0 改动；TS2 29/29 用例连跑 5+ 次稳定（evidence/e2e/CL-7-fidelity-suite-green-*.txt）；mock 帧构造类型直引 packages/protocol/src，与真实协议不漂移（AG-13 两端同源结构性保证）
- implementationStatus: 完整实现
- implementedCode: e2e/harness/{mock-init,protocol,scenarios,mock-session,fixtures,style-utils,evidence}.ts（commit 51b46ff）
- sourceTask: verification/test-plan TS1+TS2 闭环（phase-tester agt_BACKRMZ8V746，2026-08-15，DONE 29/29 绿）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-①（用户批准 2026-08-15）：SPEC-1（F 层 mock harness）与 SPEC-2 合并落库为新条目 TR-TEST-5「表现验证双层装配纪律」；正文合并两层装配纪律，代码锚双向挂 harness 与 spec

### TR-AD-13
- changeType: 新增
- scope: domain
- project: helix
- reason: 终验决策 D（用户批准 2026-08-15）：architecture-feedback T1.8 标注「可沉淀」但从未进 kg 台账的两条设计模式级知识——WriteQueue 单写通道模式（跨项目可复用，产物文件写入通道/pi-session-backend 均有明确预期消费点）。终验人审裁决落库，正式号 TR-AD-13（临时号 SPEC-iter-20260815-6tss-3）
- evidence: development/architecture-feedback.md T1.8 实现反馈沉淀候选节 + task-T1.8-report.md
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts
- sourceTask: final-verification 决策 D 执行（MainAgent，2026-08-15，用户批准终验报告 §七）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 D（用户批准）：WriteQueue 单写通道模式落库 TR-AD-13（T1.8 可沉淀知识补账）

### TR-AD-14
- changeType: 新增
- scope: domain
- project: helix
- reason: 终验决策 D（用户批准 2026-08-15）：architecture-feedback T1.8 标注「可沉淀」但从未进 kg 台账的两条设计模式级知识——RowMapper 充血↔贫血转换模板（跨项目可复用，产物文件写入通道/pi-session-backend 均有明确预期消费点）。终验人审裁决落库，正式号 TR-AD-14（临时号 SPEC-iter-20260815-6tss-4）
- evidence: development/architecture-feedback.md T1.8 实现反馈沉淀候选节 + task-T1.8-report.md
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/sqlite-session/rows/RowMapper.ts
- sourceTask: final-verification 决策 D 执行（MainAgent，2026-08-15，用户批准终验报告 §七）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 D（用户批准）：RowMapper 充血↔贫血转换模板落库 TR-AD-14（T1.8 可沉淀知识补账）

### E-AgentInstance
- changeType: 修改
- targetNode: E-AgentInstance
- scope: E-AgentInstance 规则区状态机一行
- project: helix
- reason: L3 语义复核判不一致：节点文本把 kill（动作）列为状态机独立终态 killed；实现为 InstanceState 无 killed（AgentInstance.ts:33-35），running→仅 done|failed（:60-62），kill 收口=failed 单一终态（SchedulerService.ts:286-293 closure.status="failed"）。修正方向：文本改为「done/failed（kill 收口=failed 单一终态）」——改文本级，零改码/零改锚
- evidence: domain.md:196 文本 vs AgentInstance.ts:60-62/SchedulerService.ts:286-293/DomainEvent.ts:114-115 实现
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/domain/agent/AgentInstance.ts:33-35,57-63; apps/daemon/src/application/services/scheduler/SchedulerService.ts:286-293
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_0H70KD8HXWB9，2026-08-16，DONE 8 节点 5 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判文本漂移——节点文本把 kill（动作）列为独立终态 killed；实现 kill 收口=failed 单一终态（AgentInstance.ts:60-62 / SchedulerService.ts:286-293）。修正：状态机行改「done/failed（kill 收口 = failed 单一终态，无独立 killed 态）」。改文本级，零改码零改锚。

### E-会话聚合
- changeType: 修改
- targetNode: E-会话聚合
- scope: E-会话聚合 描述区「M2 起…SubAgent Entry 亦入聚合」子句
- project: helix
- reason: L3 语义复核判不一致：「SubAgent Entry 亦入聚合」宣称 SubAgent 条目进聚合 Entry 树；实现中 SubAgent 内容只进 domain_events 挂 instanceId 事件行（SchedulerService.onInstanceEvent 转 tool.call.*/usage.recorded，抽屉读面=per-instance 事件流），聚合 Entry 树仅主实例（Session.ts:119 硬编码 MAIN_INSTANCE_ID）——与 AD-8 决策原文一致、与节点文本不符。修正方向：改为「SubAgent 内容以挂 instanceId 的领域事件入会话级存储（domain_events，trace 四维可查，抽屉消费）；聚合 Entry 树当前仅主实例（closure 注入以 isSteer entry、main 归属落树）」——改文本级
- evidence: domain.md:91 vs Session.ts:119 / RowMapper.ts:75 / SchedulerService.onInstanceEvent / decision-register.md AD-8
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/domain/session/Session.ts:119; apps/daemon/src/application/services/scheduler/SchedulerService.ts onInstanceEvent; apps/daemon/src/adapters/driven/sqlite-session/rows/RowMapper.ts:75
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_0H70KD8HXWB9，2026-08-16，DONE 8 节点 5 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判文本漂移——「SubAgent Entry 亦入聚合」与实现及 AD-8 决策原文不符（SubAgent 内容走 domain_events 挂 instanceId 事件行，聚合 Entry 树仅主实例 Session.ts:119）。修正：载体表述改事件行口径 + 声明 v0.1 边界（SubAgent Entry 进聚合与恢复重放为 M3+ 子项，与 TR-AD-15 边界声明联动）。改文本级。

### E-ClosureRecord
- changeType: 修改
- targetNode: E-ClosureRecord
- scope: E-ClosureRecord 规则区 O-5 一句
- project: helix
- reason: L3 语义复核判不一致：节点规则行「reportPath 产物形态待开发裁决（O-5）」已过期——O-5 已在 T2.3 裁决双产物并实现（closure_records 记录行 + <home>/reports/<session>/<agentId>.md，container.ts:196 生产装配 reportsDir，green-t23 证据通过）。修正方向：改为「O-5 已裁决双产物：closure_records 行 + reports/<session>/<agentId>.md（reportsDir 未配置时不产文件，reportPath=null）」——改文本级
- evidence: domain.md:215 vs SchedulerService.ts 收口链①/container.ts:196/evidence/green-t23-closure-orchestration.md:28
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/scheduler/SchedulerService.ts onInstanceClosure ①双产物; apps/daemon/src/infrastructure/container.ts:196
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_0H70KD8HXWB9，2026-08-16，DONE 8 节点 5 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判文本时效过期——「reportPath 产物形态待开发裁决（O-5）」已被 T2.3 裁决双产物并实现（closure_records 行 + reports/<session>/<agentId>.md，container.ts:196，green-t23 证据）。修正：改「已裁决（O-5 双产物）」+ reportsDir 未配置兜底语义。改文本级。

### TR-AD-1
- changeType: 修改
- targetNode: TR-AD-1
- scope: helix/docs/kg/architecture-rules.md TR-AD-1；写 daemon 代码、加 adapter 时的落位指引面
- project: helix
- reason: L3 语义复核判不一致（文本滞后，非实现违规）：①driven 清单漏 subagent（本迭代新增 driven adapter：SubagentLauncher+child 子进程+transport）；②services 清单漏 SchedulerService（另有 InstanceRunner.ts 内部接缝接口，规则未禁止）；③ports 列举未反映 inbound/outbound 双子目录现状（inbound 4 + outbound 6 文件）。核心断言（四层目录/单向依赖/domain framework-free/infrastructure 唯一全层装配点）由 AG-02 守护 pass 未失真。修正方向：driven 清单补 subagent；services 清单补 SchedulerService；ports 描述与 TR-AD-2 修正后双向清单对齐
- evidence: apps/daemon/src/adapters/driven/subagent/（目录树）；apps/daemon/src/application/services/ 实际 5 文件（含 SchedulerService.ts、InstanceRunner.ts）；apps/daemon/src/application/ports/{inbound,outbound}/（4+6 文件）
- implementationStatus: 部分实现
- implementedCode: helix/docs/kg/architecture-rules.md#TR-AD-1（规则段各层组件列举句）
- sourceTask: final-verification L3 语义复核·既有规则面（phase-reviewer agt_5WW40CXSS8SD，2026-08-16，DONE 9 节点 6 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判组件清单滞后——driven 补 subagent（SubAgent 子进程 launcher/child/transport）、services 补 SchedulerService、ports 改 inbound/outbound 双向组织（对齐 TR-AD-2 修正后清单）。核心断言（四层/单向依赖/framework-free/组合根唯一全层装配点）由 AG-02 守护未失真。改文本级。

### TR-AD-15
- changeType: 修改
- targetNode: TR-AD-15
- scope: docs/kg/architecture-rules.md TR-AD-15 三层模型段与 UI 时间线段
- project: helix
- reason: 规则声称「聚合是全历史 Entry 树、跨实例持续追加」「重启后按 Entry 的 instanceId 归属恢复各实例全流」，现状 SubAgent Entry 不进聚合（数据只到 domain_events 领域事件层）、重启仅恢复实例骨架/closure/账目，前端 channelsFromSnapshot 已备 entriesByInstance 归流面但 daemon 侧无数据供给，且规则文本未声明该边界。修正方向：文本声明边界（行为面子项未兑现归后续迭代，与 OI-2 pendingSteer 归 M3 同款处理）；实现补齐（SubAgent Entry 进聚合+恢复重放进快照 entries）为 M3+ 优化机会不随本候选
- evidence: Session.ts:119；ChatService.ts:469-472；SchedulerService.ts:314-330；RowMapper.ts:75；restore-orchestration.test.ts:122-319；session-reducer.ts:485-510
- implementationStatus: 部分实现
- implementedCode: apps/daemon/src/domain/session/Session.ts:119（instanceId 写死 MAIN_INSTANCE_ID + 注释「SubAgent 追加路径 T2.x 接」）；SchedulerService.ts:314-330（SubAgent 工具调用只转领域事件不进聚合）
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判 Important 未兑现面——「聚合跨实例持续追加」「重启恢复各实例全流」的行为面子项（SubAgent Entry 进聚合+恢复重放）未实现（Session.ts:119 写死 main）。修正：三层模型段与 UI 时间线段声明 v0.1 实现边界（SubAgent 内容走 domain_events 事件行、抽屉=per-instance 事件流；行为面补齐为 M3+ 子项与 OI-2 同批，届时撤边界）。机制面（instanceId 全链路/trace 四维/状态机一等操作）复核一致。改文本级。

### TR-AD-18
- changeType: 修改
- targetNode: TR-AD-18
- scope: docs/kg/architecture-rules.md TR-AD-18 compaction 段
- project: helix
- reason: 机制同路径成立（compactionHooks 无 kind 分支，AG-10 口径），但 SubAgentProfile 未声明 compaction 参数 → SubAgent 实例实际未装配，「同路径获得」易误读为实际获得；另 AgentProfile.ts:40 注释与实现矛盾放大误读。修正方向：TR-AD-18 措辞改为「同路径可装配（profile 声明即获得；SubAgent 当前未声明）」；同步修 AgentProfile.ts:40 注释（代码注释一行，随下迭代）
- evidence: AgentRuntime.ts:150-151（profile.compaction?.enabled 声明即装配，缺省不挂）；SubAgentProfile.ts:39-45（未声明 compaction 字段）；AgentProfile.ts:40（注释「缺省 DEFAULT_COMPACTION」与实现矛盾）
- implementationStatus: 部分实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime.ts:150-151
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判 minor 措辞易误读——「主实例与 SubAgent 实例同路径获得 compaction」改为「同路径可装配（profile 声明即获得；SubAgentProfile 当前未声明，SubAgent 实例实际未装配）」（AgentRuntime.ts:150-151 + SubAgentProfile.ts:39-45）。三通道机制/协议 additive 纪律/守护面复核一致。改文本级；AgentProfile.ts:40 注释矛盾随下迭代优化项 #12。

### TR-AD-19
- changeType: 修改
- targetNode: TR-AD-19
- scope: docs/kg/architecture-rules.md TR-AD-19 恢复重建面段
- project: helix
- reason: 恢复重建面声称「Entry 树（含 thinking/compaction/各实例 Entry，按 instanceId 归属）→ 主线视图 + 抽屉全流」，其中「各实例 Entry」部分未兑现——重启后抽屉只有卡片骨架+closure 尾卡（主体恢复语义全对上）。与 TR-AD-15 候选同根因，修正方向随其联动：文本声明边界，两节点措辞同步修订
- evidence: RestoreService.ts:31-45（恢复面清单仅注册表/Entry 树（主实例）/账目/closure）；restore-orchestration.test.ts:122-319（断言面无全流）
- implementationStatus: 部分实现
- implementedCode: apps/daemon/src/application/services/RestoreService.ts:31-45（恢复面不含 SubAgent Entry 重放）
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A（用户批准终验报告 §七，2026-08-16）：L3 语义复核判 Important 未兑现面——恢复重建面「各实例 Entry→抽屉全流」与 TR-AD-15 同根因未兑现（RestoreService.ts:31-45 恢复面不含 SubAgent Entry 重放）。修正：恢复重建面段声明 v0.1 边界（重启后抽屉=卡片骨架+closure 尾卡，全流重放 M3+ 子项，引用 TR-AD-15 边界声明）。主体恢复语义（failed 收口/queued→cancelled/不自动续跑/三源）复核一致。改文本级。

### TR-AD-5
- changeType: 修改
- targetNode: TR-AD-5
- scope: apps/daemon WS 快照组装面 + SessionPort/SessionRegistry；docs/kg/architecture-rules.md TR-AD-5
- project: helix
- reason: TR-AD-5 修改（T5.1 热修沉淀，OI-VER-5 根因修复后的新边界）：新增 per-session 帧章纪律——system.getStatus() 是系统级/最近活跃会话投影读面，仅用于 welcome 单会话握手等自洽场景；per-session 帧（session.subscribe / draft 建会话快照）禁止用它盖章（多会话下 current ≠ 目标会话即串台）。per-session 帧章由 SessionStateView.agentState/model 随视图同源组装（SessionRegistry.buildView 从目标会话 runtime 直读）
- evidence: commit d3ed899；E 层 CL-1-e2e-switch-state-isolation 三面断言绿（R1 9.1s / R2 9.2s 双跑）；reviews/task-T5.1-review.md 通过
- implementationStatus: 完整实现
- implementedCode: WsServerAdapter.ts（sessionStamp）；SessionPort.ts（SessionStateView.agentState/model）；SessionRegistry.ts（buildView）；container.ts（getStatus 注释）
- sourceTask: task-T5.1-report.md（architecture-feedback「T5.1 热修 sediment 留档」节）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #7，2026-08-17）：T5.1 热修（OI-VER-5 critical 根因修复）沉淀 per-session 帧章纪律——新增段落 + anchors 扩 ws-server/switch-isolation + 反例补串台场景；规则本体不动。formalId=TR-AD-5。

### TR-AD-6
- changeType: 修改
- targetNode: TR-AD-6
- scope: docs/kg/architecture-rules.md TR-AD-6（config 清单句修订）
- project: helix
- reason: TR-AD-6 文本修订（G-3）：config.json 清单句——T2.3 瘦身后 provider API keys 迁 ~/.helix/auth.json、默认模型迁 SQLite default_model 表、ModelCatalog 缓存落盘（models-store.json）；TR-AD-6 正文中 config.json 内容清单句需同步修订（models 数据面迁出，config.json 仅剩 daemon 配置面）；新增 auth.json/models-store 路径必须经 paths.ts 单点派生（勿复制 container.ts:196 reports 旁路先例）
- evidence: t2.3-config-migration-notes.md（迁移映射 + 幂等断言）；config-migration.test；verification TS5 契约对齐三契约盖章
- implementationStatus: 完整实现
- implementedCode: config 读面瘦身（b820874）；auth-store.ts/model-catalog.ts 路径经 paths.ts
- sourceTask: task-T4.2-brief.md §5（G-3 候选材料，T2.3 落账 id 冲突留档）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #11，2026-08-17）：G-3 文本修订——config.json 清单句按 T2.3 瘦身后实况改写（模型数据面迁出，auth.json/models-store.json/default_model 表落位），新增路径单点派生要求；anchors 扩 auth-store/model-catalog。formalId=TR-AD-6。

### E-认证凭据
- changeType: 新增
- scope: docs/kg/domain.md（业务实体新增）
- project: helix
- reason: 新业务实体候选：E-认证凭据（auth.json，正式名待人审签发）——Record<providerId, type-tagged Credential 联合>（pi 生态格式等价）；0600 权限 + pid 文件锁 + 原子写；独立生命周期（key 增删/验证态）、唯一标识、多模块消费（auth 命令族 + 连通验证 verify + set_model apiKey 跟随 + E 层 seed 面与 E-模型目录关联）
- evidence: auth-store.test（类型级等价断言 + 0600 权限）；e2e/CL-3-e2e-model-chain（auth.json 0600 断言）；E 层 prepHome seed 先例（{provider:{type:api_key,key}}）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/infrastructure/auth-store.ts（0600+pid 锁+原子写）；路径经 paths.ts 单点派生
- sourceTask: verification/kg-inspection.md（entity 覆盖率审计候选 ②，建议终验落账）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #16，2026-08-17）：verification entity 覆盖率审计候选 ② 落库——新业务实体 E-认证凭据（四节完整），TR-AD-6/TR-AD-7/AD-2 联动。formalId=E-认证凭据。

### E-模型目录
- changeType: 新增
- scope: docs/kg/domain.md（业务实体新增）
- project: helix
- reason: 新业务实体候选：E-模型目录（ModelCatalog，正式名待人审签发）——builtin 39 providers 静态表 + pi.dev overlay 合并（ETag 条件刷新/4h 缓存）+ 落盘兜底（models-store.json）+ 防降级；独立生命周期（缓存刷新）、唯一标识（ETag/缓存文件）、多模块消费（daemon ModelCatalogPort/ModelService + shell P-3/P-4 + protocol model 族）。默认模型（SQLite default_model 表）为其附属状态，关系节提及即可
- evidence: model-catalog.test（builtin 39/overlay ETag 三分支/防降级/落盘兜底）；e2e/CL-3-e2e-model-chain；无外网单测覆盖（离线保缓存/兜底 builtin）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts；ModelCatalogPort；shell P-3/P-4 消费
- sourceTask: verification/kg-inspection.md（entity 覆盖率审计候选 ①，建议终验落账）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #15，2026-08-17）：verification entity 覆盖率审计候选 ① 落库——新业务实体 E-模型目录（四节完整），与 E-认证凭据/TR-AD-6/TR-AD-7 联动。formalId=E-模型目录。

### TR-AD-21
- changeType: 新增
- scope: packages/protocol 事件目录 + daemon WS 发帧面 + shell dispatcher（模式规则）
- project: helix
- reason: 点对点命令结果帧模式（三度同构，建议新 TR，正式号待人审签发）：命令结果 = 点对点结果帧（*.result 事件类型 + WsServerAdapter.sendNow 直发发起连接，不经 EventStream 广播）；状态变化 = 广播（EventStream 章印路由）。新增命令族直接套用：EVENT_TYPES/EVENT_CHANNELS/守护计数同步 + shell dispatcher 先 no-op 占位后接真消费。源决策 = 契约 B §2.3 机制注记 / AD-4
- evidence: T2.2 session 族 2 帧（session.list.result/loadHistory.result）+ 微批 model/auth 族 9 帧完全同构；契约 B/C 已回填；type-surface 守护计数同步；TS5 契约对齐 PASS
- implementationStatus: 完整实现
- implementedCode: WsServerAdapter.sendNow；EVENT_TYPES/EVENT_CHANNELS/exports 计数；shell dispatcher 占位→真消费两阶段
- sourceTask: architecture-feedback.md #41（T2.3-result-frames sediment 候选）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #13，2026-08-17）：点对点命令结果帧模式三度同构（T2.2×2 + 微批×9）规则化，签发新号 TR-AD-21。formalId=TR-AD-21。

### TR-AD-22
- changeType: 新增
- scope: daemon SessionProjection + shell dispatcher/store 拓扑（模式规则）
- project: helix
- reason: 事件分发两层拓扑模式（daemon/shell 同构，建议新 TR，正式号待人审签发）：daemon 侧 SessionProjection（fan-out 显式消费者 + 共享聚合访问器 + 幂等去重集 + persistedState 组合面，经 SessionRegistry 按会话实例化）与 shell 侧 dispatcher 两层（会话 store 级 SessionState 域 + 拓扑级 directory 消费者 TopologyState 域；三向路由：活跃完整 store / 后台轻量 store / 系统帧）完全同构——按 sessionId 分实例化，新增事件族 = additive 扩展面
- evidence: SessionProjection.ts 187 行（daemon）；dispatcher.ts 两层消费者（shell）；双端零漂移三层守护（type-surface 恰等 + dispatcher 全类型消费恰等 + routeCommand 21 case 对齐）；session-projection.test / session-store.test
- implementationStatus: 完整实现
- implementedCode: application/services/SessionProjection.ts；shell src shared/protocol dispatcher（会话 store 级 + 拓扑级两层消费者）+ 三向路由 dispatchFrame
- sourceTask: architecture-feedback.md #20/#23/#31（T2.1/T2.2/T3.1 sediment 候选）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #14，2026-08-17）：事件分发两层拓扑（daemon SessionProjection ↔ shell dispatcher/store 同构，#20/#23/#31 三度沉淀合并）规则化，签发新号 TR-AD-22。formalId=TR-AD-22。

### TR-AD-18-r2
- changeType: 修改
- targetNode: TR-AD-18
- scope: docs/kg/architecture-rules.md TR-AD-18（三通道与协议 additive 演进）或新条目；错误链路实现/评审/测试剧本编写时的规则依据面
- project: helix
- reason: 热修后新增设计事实：①provider 失败的协议形态——pi-ai 将 HTTP 失败规范化为流内 error 帧（非异常），errorMessage 含 provider 原文；引擎错误经 engine.error 事件透传前端（错误卡）；②error 轮语义——不产 assistant 气泡、turn 收口、全零 usage 不入账（零成本非真实计费）；③mock 契约等价的错误面——FakeLLM/剧本须覆盖 error 帧路径（TR-TEST-3 等价原则的错误维度，E 层 errorReply 剧本为断言面）。建议并入 TR-AD-18（三通道→含错误通道）或独立条目，由下迭代终验人审裁决
- evidence: docs/hotfixes/2026-08-16-engine-error.md；packages/protocol/src/events/chat.ts（engine.error 第 24 事件，EngineErrorEvent:105）；PiAgentEngineAdapter.ts message_end stopReason=error 分支；ChatService.ts error 轮零账不入账；e2e/CL-7-e2e-engine-error.spec.ts（FakeLLM errorReply 剧本与真实 pi-ai 失败帧同构）；现场验证：真 z.ai 429 → engine.error 帧含 provider 原文
- implementationStatus: 完整实现
- sourceTask: post-iteration 热修（MainAgent，2026-08-16，docs/hotfixes/2026-08-16-engine-error.md；用户现场报障驱动）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验裁决（用户批准终验报告 §六 #1，2026-08-17）：错误通道三设计事实并入 TR-AD-18（三通道→四通道，更名 + 错误轮语义段落）。因 formalId=TR-AD-18 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-18，节点 id 稳定不变）。

### AD-3
- changeType: 修改
- targetNode: AD-3
- scope: apps/daemon 全链路；apps/shell src 与 e2e/ 零触碰
- project: helix
- reason: AD-3 daemon 侧落地（与既有 AD-3 类型登记候选同目标、不同实施面，终验合并裁决）：①SchedulerService 只产事件零聚合写（守护断言入集成测试）；②SessionProjection 会话投影消费者（SubAgent Entry 落聚合 instanceId 归属 + usageLedger 并入 + write-through 迁入）；③WS 统一信封 sessionId 路由 + EVENT_CHANNELS 章印；④恢复重放含 SubAgent 历史；⑤RowMapper/DtoMapper instanceId 行级对称透传。E 层断言定稿 daemon 级证据，E 层归 T4.2。
- evidence: SessionProjection.ts（新，187 行）；SchedulerService 零聚合写守护（test/integration/session-projection.test.ts ②）；EventStream 按 sessionId 路由；RestoreService.replaySubAgentHistory；bun test apps/daemon 313 pass；MainAgent 统一回归 F 65 / E 15 全绿
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/SessionProjection.ts（新）；SchedulerService.ts onInstanceEvent；EventStream.ts/WsServerAdapter.ts；DtoMapper.ts；RestoreService.ts；Session.ts；container.ts
- sourceTask: task-T2.1-report.md
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #2，2026-08-17）：事件分发统一信封路由落地定稿落 docs/kg/decisions.md 决策档案 AD-3（上下文/选项/裁决与理由/结局四节，kg A-1 模型决策非图节点）。因 kind=decision 不在 kg apply block 流转支持面 + targetNode 无既有节点块，按 desk 先例由 MainAgent 人审直写落盘（formalId=AD-3）。

### CL-iter-20260816-6q6f-1786980800604
- changeType: 新增
- scope: verification 阶段回归取证（零生产代码改动，纯证据落盘）
- project: helix
- reason: M5 热修复批次六提交（d3ed899/c487c95/5959533/23f6043/55ac055/9936d48）Round-2 独立回归验收记录：F 层 91/91 全绿零回退 + E 层 20/20×2 双跑全绿（T5.1 switch-state-isolation 修复回归成立），T5.1-T5.6 修复要点全部应答（含 T5.6 dev 控件 grep 零残留复核）。作为迭代验收留痕候选供终验人审裁决。
- evidence: evidence/e2e/verification-r2-CL-all-f-20260817T152736Z.txt「M5 六提交复核要点应答」节 + 4 张 verification-r2-CL-1-f-shot-*.png；E 层配套 evidence/e2e/verification-r2-CL-e-layer-round{1,2}-*.txt
- implementationStatus: 完整实现
- implementedCode: e2e/CL-1-activity-rail-inline.spec.ts:31（T5.5 新剧本）；e2e/CL-3-model-menu.spec.ts:144,159（T5.3 断言）；worktree HEAD 9936d48
- sourceTask: development/task-TC6.1-report.md
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #3，2026-08-17）：M5 六提交 Round-2 回归验收留痕——不立 kg 节点（非规则/实体/决策形态），留痕由 ITERATIONS.md 迭代条目 + verification-report Round-2 节 + evidence/e2e/verification-r2-* 承载。台账直接流转 applied。

### TR-AD-15-revoke
- changeType: 修改
- targetNode: TR-AD-15
- scope: docs/kg/architecture-rules.md TR-AD-15（撤 v0.1 边界段）
- project: helix
- reason: TR-AD-15 撤边界（#45 草案）：删去「v0.1 实现边界（M2 终验 L3 复核登记）……届时撤本边界声明」整段；规则本体（instanceId 全链路/机制同构/三层模型）不动，被会话投影强化。条件成就：①聚合 Entry 树已含 SubAgent 条目（Entry.instanceId 归属，Session.pushEntry 参数化）②恢复重放进快照 entries（RestoreService.replaySubAgentHistory，agent_kind=subagent 事件流补齐）③前端归流既有
- evidence: e2e/CL-1-e2e-restart-restore-all.spec.ts + e2e/CL-1-e2e-subagent-stream.spec.ts + session-projection.test ③；architecture-feedback #45 草案原文
- implementationStatus: 完整实现
- implementedCode: Session.pushEntry（instanceId 参数化）；RestoreService.replaySubAgentHistory
- sourceTask: task-T4.2-report.md（architecture-feedback #45 留档）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #4，2026-08-17）：撤 v0.1 边界段（条件成就：SubAgent Entry 进聚合 + 恢复重放，E 层证据在档）。因 formalId=TR-AD-15 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-15，节点 id 稳定不变）。

### TR-AD-19-revoke
- changeType: 修改
- targetNode: TR-AD-19
- scope: docs/kg/architecture-rules.md TR-AD-19（恢复重建面撤 v0.1 边界）
- project: helix
- reason: TR-AD-19 撤边界（#46 草案）：恢复重建面删去括注「v0.1 边界：SubAgent Entry 未进聚合，抽屉全流重放为 M3+ 子项……重启后抽屉 = 卡片骨架 + closure 尾卡」，改写为「Entry 树（主实例主轴 + SubAgent per-instance channel）→ 主线视图 + 抽屉全流重放（SubAgent 历史含在内）」。规则本体（failed 收口不自动续跑/cancelled 区分/重试归编排层）不动
- evidence: e2e/CL-1-e2e-restart-restore-all.spec.ts（重启后抽屉历史可见）；session-registry.test ③（删除会话 queued→cancelled/running→kill 复用终态语义）；architecture-feedback #46 草案原文
- implementationStatus: 完整实现
- implementedCode: RestoreService.replaySubAgentHistory（agent_kind=subagent 事件流补齐重放）
- sourceTask: task-T4.2-report.md（architecture-feedback #46 留档）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #5，2026-08-17）：恢复重建面撤 v0.1 边界括注（与 TR-AD-15 联动）。因 formalId=TR-AD-19 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-19，节点 id 稳定不变）。

### E-会话聚合-r2
- changeType: 修改
- targetNode: E-会话聚合
- scope: docs/kg/domain.md E-会话聚合（描述联动）
- project: helix
- reason: E-会话聚合 描述联动（#47 草案，三处联动之三）：domain.md E-会话聚合节「聚合 Entry 树 v0.1 仅主实例……见 TR-AD-15 边界声明」句改写为「聚合 Entry 树含主实例主轴 + SubAgent per-instance 归属条目（Entry.instanceId；经会话投影 SessionProjection 落树）；快照尾窗切法保留 per-instance channel 完整性（AD-1 硬约束）」。与 TR-AD-15/19 撤边界同批联动
- evidence: e2e/CL-1-e2e-multi-session.spec.ts；session-registry.test ④；architecture-feedback #47 草案原文
- implementationStatus: 完整实现
- implementedCode: Session.pushEntry；SessionProjection.ts；SessionRegistry.buildView（尾窗切法）
- sourceTask: task-T4.2-report.md（architecture-feedback #47 留档）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #6，2026-08-17）：描述联动（聚合 Entry 树含 SubAgent 归属条目，三处联动之三）。因 formalId=E-会话聚合 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=E-会话聚合，节点 id 稳定不变）。

### AD-1-finalize
- changeType: 修改
- targetNode: AD-1
- scope: AD-1（尾窗+分页决策）落地形态回写
- project: helix
- reason: AD-1 落地定稿（task-T2.2 sediment 留档）：尾窗+分页参数定稿——快照尾窗 30 条（per-instance channel 完整性硬约束）；loadHistory 游标分页 50 上限 200；草稿建会话链 draft:true 标记；清单/历史结果 = 点对点结果帧（session.list.result / session.loadHistory.result，连接私有读面不广播，契约 B 已回填）；恢复重放含 SubAgent 历史（RestoreService.replaySubAgentHistory）
- evidence: 契约 B §1.3/§1.4/§2.3 已回填（verification TS5 契约对齐 PASS 盖章）；session-registry 集成断言；e2e/CL-1-e2e-multi-session.spec.ts 分页断言
- implementationStatus: 完整实现
- implementedCode: SessionRegistry（尾窗/卸载/收口）；EventStream/WsServerAdapter（点对点结果帧）
- sourceTask: task-T2.2-report.md（propose 落账阻断留档，OI-VER-1 ①）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #8，2026-08-17）：AD-1 落地定稿落 docs/kg/decisions.md 决策档案 AD-1（上下文/选项/裁决与理由/结局四节，kg A-1 模型决策非图节点；尾窗 30/分页 50 上限 200/点对点结果帧/恢复重放）。因 kind=decision 不在 kg apply 支持面 + targetNode 无既有节点块，按 desk 先例由 MainAgent 人审直写落盘（formalId=AD-1）。

### AD-2-finalize
- changeType: 修改
- targetNode: AD-2
- scope: AD-2（模型模块决策）落地形态回写
- project: helix
- reason: AD-2 落地定稿（task-T2.3 sediment 留档）：①auth.json（Record<providerId, Credential 联合>，0600+pid 锁+原子写，路径经 paths.ts 单点派生）②默认模型 SQLite 单写③ModelCatalog 自实现（builtin 39 静态表 + pi.dev overlay ETag 三分支/防降级/落盘兜底，零 pi-coding-agent，落位 driven 而非 application——AG-04 合规）④set_model 链：AgentState.model 直改（in-flight 不变，下一 turn 生效）⑤config 瘦身迁移幂等（skipConfig 重定义：真引擎模式 = options.engine 缺省，skipConfig 只跳过 config 读面）
- evidence: auth-store.test（类型级等价断言 + 0600）；model-catalog.test（ETag 三分支/防降级）；set_model 真引擎序列断言；config-migration.test 幂等；e2e/CL-3-e2e-model-chain（auth.json 0600 + builtin fallback）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/infrastructure/auth-store.ts；pi-engine/model-catalog.ts（driven 落位）；ModelService；SQLite default_model 表
- sourceTask: task-T2.3-report.md（propose 落账阻断留档，OI-VER-1 ②）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #9，2026-08-17）：AD-2 落地定稿落 docs/kg/decisions.md 决策档案 AD-2（上下文/选项/裁决与理由/结局四节，kg A-1 模型决策非图节点；auth.json 0600/SQLite 默认/ModelCatalog driven/set_model 链/config 瘦身）。因 kind=decision 不在 kg apply 支持面 + targetNode 无既有节点块，按 desk 先例由 MainAgent 人审直写落盘（formalId=AD-2）。

### AD-4-finalize
- changeType: 修改
- targetNode: AD-4
- scope: AD-4（SessionRegistry 决策）落地形态回写
- project: helix
- reason: AD-4 落地定稿（task-T2.2 sediment 留档）：SessionRegistry 落地形态——①生命周期（懒加载/30min 空闲卸载/执行中不卸载）②组合根工厂化（1:1 与 write-through 保持）③调度器多会话共用全局预算④启动全量元数据（restoreLatest 废弃）⑤草稿建会话链 20 字符命名⑥删除六表清行按序收口（whenSettled+settleTimeoutMs 5s 超时防御上界）⑦WriteQueue 分仓（chainKeyOf(session_id) 路由，仓间互不阻塞）⑧引擎多会话并发前提注入（DaemonOptions.engine 工厂形态）
- evidence: session-registry.test 全套（生命周期/删除收口/分仓）；调度器多会话共用预算集成断言；daemon 324 单测绿；E 层 CL-1-e2e-multi-session/restart-restore-all
- implementationStatus: 完整实现
- implementedCode: SessionRegistry.ts；container.ts（组合根工厂化 + engine 工厂注入）；WriteQueue（sessionTails 分仓）；SchedulerService（全局预算）
- sourceTask: task-T2.2-report.md（propose 落账阻断留档，OI-VER-1 ①）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #10，2026-08-17）：AD-4 落地定稿落 docs/kg/decisions.md 决策档案 AD-4（上下文/选项/裁决与理由/结局四节，kg A-1 模型决策非图节点；生命周期/工厂化/全局预算/删除收口/WriteQueue 分仓/引擎工厂）。因 kind=decision 不在 kg apply 支持面 + targetNode 无既有节点块，按 desk 先例由 MainAgent 人审直写落盘（formalId=AD-4）。

### TR-AD-7-r3
- changeType: 修改
- targetNode: TR-AD-7
- scope: docs/kg/architecture-rules.md TR-AD-7（模型能力来源句 + auth.json 格式句修订）
- project: helix
- reason: TR-AD-7 文本修订（G-3）：①模型能力来源句——模型目录来源 = builtin 39 providers 静态表 + pi.dev overlay 合并（自实现 ModelCatalog，零 pi-coding-agent 依赖），正文「模型能力来源」句需同步；②auth.json 格式句——Record<providerId, type-tagged Credential 联合>（pi 生态等价，0600+pid 锁），OAuth 类型面支持、登录流不做
- evidence: model-catalog.test（builtin 39/overlay/防降级/落盘兜底）；auth-store.test（Credential 联合类型级等价断言）
- implementationStatus: 完整实现
- implementedCode: pi-engine/model-catalog.ts（自实现，零 pi-coding-agent）；infrastructure/auth-store.ts
- sourceTask: task-T4.2-brief.md §5（G-3 候选材料，T2.3 落账 id 冲突留档——discarded 已有 TR-AD-7-r2）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #12，2026-08-17）：模型能力来源句 + auth.json 格式句修订（G-3）。因 formalId=TR-AD-7 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-7，节点 id 稳定不变）。

### TR-AD-2-r3
- changeType: 修改
- targetNode: TR-AD-2
- scope: docs/kg/architecture-rules.md TR-AD-2（落位枚举补 infrastructure 形态）
- project: helix
- reason: TR-AD-2 落位枚举缺口（终验全局审计 N1）：AuthStorePort 实现落 infrastructure/auth-store.ts（独立模块），不属规则文本「三类落位」（driven/driving/组合根内联）任一，属第四形态「infrastructure 纯技术文件 port」（与 dev-token/config 同类）。实现是有意裁决（AG-06③ renameSync 白名单显式列名 + 组合根装配），规约文本未覆盖——修订 TR-AD-2 补第四类落位
- evidence: docs/kg/architecture-rules.md TR-AD-2 规则段「三类落位」句 vs apps/daemon/src/infrastructure/auth-store.ts:97（export class AuthStore implements AuthStorePort）+ arch-guard.test.ts AG-06③（renameSync 白名单 isAuthStore）；审计报告 §1.4 N1
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/infrastructure/auth-store.ts:1-244（AuthStore implements AuthStorePort）
- sourceTask: final-verification/architecture-audit-20260817.md（phase-architect findings，自动落账异常手动补）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #17，2026-08-17）：落位枚举补第四类（infrastructure 纯技术文件 port）。与 TR-AD-2-r4 同节点合并修订一次落盘。因 formalId=TR-AD-2 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=TR-AD-2，节点 id 稳定不变）。

### TR-AD-2-r4
- changeType: 修改
- targetNode: TR-AD-2
- scope: docs/kg/architecture-rules.md TR-AD-2（outbound/inbound 端口枚举计数句）
- project: helix
- reason: TR-AD-2 端口枚举计数修订（L3 复核判不一致项）：正文「outbound port 生效 5 个」滞后于 T2.3 模型迁移实况——实际生效 8 个（9 文件 − PathsPort 悬空），新增 AuthStorePort/DefaultModelPort/ModelCatalogPort 三 outbound + inbound 新增 ModelPort/SessionDirectoryPort。核心断言（双向结构/AG-01 port 零实现/PathsPort 悬空注记）全部吻合，仅枚举清单滞后。与 TR-AD-2-r3（落位第四形态）同节点不同修订面，建议 apply 时合并修订
- evidence: docs/kg/architecture-rules.md TR-AD-2 规则段「出口端口生效 5 个」vs apps/daemon/src/application/ports/outbound/（9 文件）；arch-guard.test.ts:39 断言 ports 文件数 ≥9（守护已更新、文本未跟进）；bun test arch-guard 22/22 pass
- implementationStatus: 完整实现
- implementedCode: ports/outbound/AuthStorePort.ts（实现在 infrastructure/auth-store.ts:151）；ports/outbound/DefaultModelPort.ts（sqlite-session/DefaultModelStore.ts:13）；ports/outbound/ModelCatalogPort.ts（pi-engine/model-catalog.ts:117）；inbound 新增 ModelPort/SessionDirectoryPort
- sourceTask: reviews/l3-semantic-review-batch1.md（L3 复核批次 1 findings，自动落账 id 撞号手动另立）
- createdIn: iter-20260816-6q6f
- decisionLog: 终验裁决（用户批准终验报告 §六 #18，2026-08-17）：端口枚举计数修订（outbound 5→8 + inbound 新增 ModelPort/SessionDirectoryPort），与 TR-AD-2-r3 合并落盘于同一次 TR-AD-2 块修订。同上 MainAgent 直写（formalId=TR-AD-2）。

### TR-AD-23
- changeType: 修改
- targetNode: TR-AD-23
- scope: 协议契约文档面：TR-AD-23 规则②例证与 updatedIn 元数据
- project: helix
- reason: TR-AD-23 规则②「契约版本一次定形」正文仅以 v0.3 为批次例证；本迭代契约 v0.4（trace.query 命令族 + agent.instantiated/model.changed 事件 + engine.error 抑制守卫）已按同一 additive/一次定形律落地且代码侧完整实现，建议将 v0.4 补为规则②第二例证并推进 updatedIn 元数据。
- evidence: packages/protocol/src/envelope.ts:15 PROTOCOL_VERSION="0.4"；packages/protocol/src/events/index.ts:8 v0.4 新增清单；apps/daemon/src/adapters/driving/ws-server/DtoMapper.ts:681-688 engine.error 抑制守卫
- implementationStatus: 完整实现
- implementedCode: packages/protocol/src/envelope.ts:15；packages/protocol/src/events/index.ts:8（v0.4 清单；旧单文件行号列 278,537-543,638,689 随拆分失效，文件级锚随 TR-AD-21-r2 处方）；packages/protocol/src/commands.ts:266
- sourceTask: l3-semantic-review (phase-reviewer agt_BF0QPNMSKF6R)
- createdIn: iter-20260819-erio
- decisionLog: 终验裁决（用户批准终验报告 §六 #1，2026-08-20）：规则②「契约版本一次定形」补 v0.4 为第二例证（trace.query 命令族 + agent.instantiated/model.changed 落盘事件 + engine.error SubAgent 抑制守卫同批，iter-20260819-erio）；derivedFrom 增 AD-4；updatedIn 推进 iter-20260819-erio。证据：envelope.ts:15 PROTOCOL_VERSION="0.4"、events/index.ts:8 v0.4 清单、DtoMapper.ts:681-688 抑制守卫。formalId=TR-AD-23。

### E-AgentProfile
- changeType: 修改
- targetNode: E-AgentProfile
- scope: domain.md E-AgentProfile 规则节单句措辞修正，无代码改动
- project: helix
- reason: L3 判漂移：E-AgentProfile 规则宣称「model 解析收束 infrastructure/config 单点」，实际 SubAgent 模型三级解析单点为 SubagentLauncher.resolveModelFor（代码注释自称「AD-3 三级模型解析单点」），infrastructure/config.ts 仅做 config.json 解析不含模型解析。修正方向：改「SubagentLauncher.resolveModelFor 单点（launch 段唯一消费点）」；三级链优先级实质语义不变
- evidence: docs/kg/domain.md:45 vs apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts:120-147、apps/daemon/src/infrastructure/config.ts:38-93
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts:128 (resolveModelFor)
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_2P5KN9XRVHJ6；自动落账静默丢失后 MainAgent 补登）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：L3 语义复核判文本漂移——规则宣称「model 解析收束 infrastructure/config 单点」，实际解析单点为 SubagentLauncher.resolveModelFor（SubagentLauncher.ts:128）。修正：落位宣称改为 SubagentLauncher.resolveModelFor 单点 + anchors 补 SubagentLauncher.ts；三级链实质语义不变。改文本级，零改码。

### E-智能体配置资源
- changeType: 修改
- targetNode: E-智能体配置资源
- scope: domain.md E-智能体配置资源 描述/禁忌节措辞修正，无代码改动
- project: helix
- reason: L3 判漂移：E-智能体配置资源 描述宣称 skills 扫描「双层目录（user+project）」，代码实为三层输入 user/project/builtin（builtin = daemon 随仓 resources/skills，含 web-access），且 ResourceService 已实现 builtin-immutable 跳过语义。修正方向：「双层目录」→「三层目录（user=~/.helix/skills + project=<工作区>/.helix/skills + builtin=daemon 随仓 resources/skills，builtin 层不可禁用）」；禁忌「双层自有目录」措辞同步修正
- evidence: docs/kg/domain.md:369 vs apps/daemon/src/adapters/driven/pi-engine/SkillScanner.ts:13-16,41-45、apps/daemon/src/infrastructure/paths.ts:62、apps/daemon/src/application/services/ResourceService.ts:100、apps/daemon/resources/skills/web-access
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/SkillScanner.ts:41-45 (this.inputs 三层)
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_2P5KN9XRVHJ6；自动落账静默丢失后 MainAgent 补登）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：L3 语义复核判文本漂移——描述宣称 skills 扫描「双层目录」，代码实为三层 user/project/builtin（SkillScanner.ts:41-45；ResourceService.ts:100 builtin-immutable）。修正：描述改三层目录 + builtin 不可禁用语义，禁忌「双层自有目录」同步改「三层自有目录」。改文本级，零改码。

### TR-AD-29
- changeType: 新增
- scope: 注释/文档纪律（daemon src 先行，protocol 面后续批）
- project: helix
- reason: T3.2 注释考古批确立的可复用判据：18 族机械可判定叙事模式 + 活锚白名单 + 三分类落地（行级强约束留锚/文件级考古迁 ADR/纯叙事全删）+ ADR 目录准入判据。720 行叙事清理零代码语义变更（216 对逐字节校验）。建议落 testing-rules 或 architecture-rules convention 层新条目
- evidence: evidence/green-t3-2-comment-adr.md；evidence/red-t3-2-comment-narrative.md；docs/decisions/ 五 ADR
- nodeDraft: {"digest":"清理或新写代码注释、处理任务号/迭代号叙事、落 ADR 时","graph":"tech","governs":[],"kind":"rule","layer":"convention","name":"注释叙事三分类与 ADR 落档判据","scope":"domain","sections":{"反例":"新写「T3.3：AD-1 单源收编（iter-20260821-dg90）」式任务号叙事注释——写完即腐（AgentInstance.ts L27 实证）；或把文件级演进史大段留在源码文件头——应迁 docs/decisions/ ADR 留指针。","理由":"任务号/迭代号叙事注释写完即开始腐烂（所指批次完成后语义悬空），18 族模式机械可判定使清理可脚本化；文件级考古迁 ADR 保留背景/取舍/演进史三要素，比留在源码注释更可持续；活锚白名单防止清理误伤仍在生效的约束引用。","规则":"代码注释三分类判据：①行级强约束——保留约束表述与活锚（TR-AD-N/AD-N/AG-N/TR-TEST-N/O-N 活观察节点/Q-Na 契约款/§文档节引用），删任务号叙事尾巴；②文件级考古——迁 docs/decisions/ ADR（含背景/取舍/演进史三要素），源文件留当前契约 + ADR 指针；③纯叙事——全删。叙事模式 18 族机械可判定（追修/原T/任务号T/里程碑M/闭环CL/需求点F/K系/O系/TS系/spike/迭代号/TP/AF/FB/OI/C系/D批/G系）。ADR 目录准入判据：有独立演进史与取舍的决策域才立 ADR，一次性实现细节不立。","适用范围":"全部源码注释的新写与清理评审；docs/decisions/ ADR 新增准入；注释清理批次任务的判型依据。"},"stack":"backend"}
- implementationStatus: 完整实现
- implementedCode: docs/decisions/{persistence,composition-root,session-lifecycle,subagent-scheduler,ws-server}.md
- sourceTask: T3.2（终验 C1 补登）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：T3.2 注释考古批判据沉淀为新 convention 规则——18 族机械可判定叙事模式 + 活锚白名单 + 三分类落地（行级强约束留锚/文件级考古迁 ADR/纯叙事全删）+ ADR 目录准入判据。正式号 TR-AD-29（用户批准建议号）。

### TR-AD-30
- changeType: 新增
- scope: daemon 组合根事件扇出组装面；未来任何 push 序即语义的多目标发布组装可复用
- project: helix
- reason: architecture §8 钦定「终验后按实证沉淀」项之一：fan-out 带名注册表 + 顺序约束断言模式。终验实证：NamedFanoutTarget 注册表序即语义唯一权威（wireEventFanout 六目标），顺序专项测试将「先事件行后状态行」口头契约转为机械断言，resources.changed 三负边界亦有断言面
- evidence: apps/daemon/src/infrastructure/assembly/wireEventFanout.ts:15-19,63-117；apps/daemon/test/integration/fanout-assembly.test.ts:111-118,157-174；architecture.md §4.2.4
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/infrastructure/assembly/wireEventFanout.ts（NamedFanoutTarget/FanoutPublisher/wireEventFanout）+ fanout-assembly.test.ts:111-118（顺序断言）
- sourceTask: final-verification 全局审计（phase-architect agt_X2ST92169WQ6；自动落账静默丢失后 MainAgent 补登）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：architecture §8 钦定「终验后按实证沉淀」项之一——fan-out 带名注册表 + 顺序约束断言模式，终验架构师审计实证背书（wireEventFanout.ts + fanout-assembly.test.ts:111-118/157/174）。正式号 TR-AD-30（用户批准建议号）。

### TR-AD-31
- changeType: 新增
- scope: application 服务依赖面设计；适用于一切「生产必填钩子 + 测试宽松注入」的服务
- project: helix
- reason: architecture §8 钦定「终验后按实证沉淀」项之二：依赖两形态接口模式（完整形态生产必填 + 测试形态宽松）。终验实证：ChatServiceDeps（四钩子必填）/ChatServiceTestDeps（可选）落地，组合根装配点编译期保证全钩子在位，根治 A4「?.() 静默跳过」。边界备注：构造器签名取联合类型致内部仍存不可达兜底分支（:137/150/209/267）——运行期分支消灭依赖装配纪律而非类型收窄，后续可构造器收窄 + 测试工厂包缺省填充彻底消分支
- evidence: apps/daemon/src/application/services/ChatService.ts:53-85（两形态定义）,108（联合构造器）,137/150/209/267（兜底分支）；architecture.md §4.2.6
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/ChatService.ts:53-85（ChatServiceDepsBase/ChatServiceDeps/ChatServiceTestDeps 三件套）
- sourceTask: final-verification 全局审计（phase-architect agt_X2ST92169WQ6；自动落账静默丢失后 MainAgent 补登）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：architecture §8 钦定「终验后按实证沉淀」项之二——依赖两形态接口模式（生产必填+测试宽松），终验架构师审计实证背书；含构造器兜底分支边界备注与后续收窄方向。正式号 TR-AD-31（用户批准建议号）。

### E-iter-20260821-dg90-1
- changeType: 修改
- targetNode: E-会话聚合
- scope: domain session 聚合判定面
- project: helix
- reason: T1.2 将「会话是否为空」判定收敛为 Session.isEmpty 单一事实源，消灭多处散落的 entries.length===0 同义判定；建议在 E-会话聚合 规则节补一句「空判定唯一口径 = Session.isEmpty」
- evidence: evidence/green-t1-2-session-is-empty.md；daemon 686/0 三轨绿
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/domain/session/Session.ts（isEmpty）
- sourceTask: T1.2（终验 C1 补登，原断裂见 dev-final-arch-review §3.1）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：Session.isEmpty 空判定单一事实源沉淀——E-会话聚合 规则节补「空判定唯一口径 = Session.isEmpty」句。因 formalId=E-会话聚合 与台账既有 applied 条目撞号（同节点二次修改超出 kg apply 流转支持面），按 desk 先例由 MainAgent 人审直写落盘（formalId=E-会话聚合，节点 id 稳定不变）。

### SPEC-iter-20260821-dg90-3
- changeType: 修改
- targetNode: TR-AD-23
- scope: packages/protocol 职责边界
- project: helix
- reason: T3.1 确立「协议包 = 类型契约 + 行为契约」扩张（CL-4 定案）：无 IO 纯函数 projection（usage/instance/trace 三域）落 packages/protocol/src/projection/，daemon/shell/fake-transport 三方薄适配消费，消灭平行实现。建议 TR-AD-23（或人审另指节点/新号）补「纯函数行为面可落 protocol 包」条款
- evidence: evidence/green-t3-1-protocol-projection.md；projection 三域单测 28 例；fake 655→559 镜像段零残留
- implementationStatus: 完整实现
- implementedCode: packages/protocol/src/projection/{usage,instance,trace}.ts
- sourceTask: T3.1（终验 C1 补登）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：TR-AD-23 补④律「协议包职责 = 类型契约 + 行为契约」（projection 三域纯函数单源，CL-4 定案）+ derivedFrom 增 CL-4 + anchors 增 projection/。因 formalId=TR-AD-23 撞号，按 desk 先例 MainAgent 直写落盘（节点 id 稳定）。

### SPEC-iter-20260821-dg90-5
- changeType: 修改
- targetNode: TR-TEST-3
- scope: daemon 测试 fixture 纪律
- project: helix
- reason: AF-10 fixture 规约候选：测试 fixture 优先走 ClockPort 等 port 真实路径注入，白盒内部状态构造仅限全库 grep 实证的唯一访问点并需显式标注；建议 TR-TEST-3（保真度面）补此条款
- evidence: development/architecture-feedback.md AF-10；session-registry-draft.test.ts 白盒 fixture 全库 grep 唯一访问点实证
- implementationStatus: 完整实现
- implementedCode: apps/daemon/test/unit/session-registry-draft.test.ts
- sourceTask: AF-10（终验 C1 补登，dev-final-arch-review §3.1）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：TR-TEST-3 补 fixture 注入规约（port 真实路径优先，白盒构造仅限 grep 实证唯一访问点并显式标注，AF-10）+ fake-transport 口径句升级「同引 protocol 单源」。因 formalId=TR-TEST-3 撞号（discarded 既有条目），按 desk 先例 MainAgent 直写落盘（节点 id 稳定）。

### SPEC-iter-20260821-dg90-6
- changeType: 修改
- targetNode: TR-TEST-6
- scope: e2e harness 卫生纪律
- project: helix
- reason: 「批末/终验 e2e 全量前清 TMPDIR」约定候选：本迭代两次兑现预警（daemon 测试 helix-* 残留致 e2e globalSetup 卫生预检拦截，清理后复跑全绿）。建议 TR-TEST-6 补「e2e 全量批次前清 TMPDIR helix-* 残留」条款或落 e2e harness 文档
- evidence: verification/verification-report.md §二 e2e 执行注记（TMPDIR 27+ 残留拦截后复跑全绿）；task-T0.1-report 批注
- implementationStatus: 完整实现
- implementedCode: e2e/harness/tmp-hygiene.ts；e2e/harness/e2e-global-setup.ts
- sourceTask: OI-4 / 终验 C4（verification-report §六）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：TR-TEST-6 补「批末/终验 e2e 全量前清 TMPDIR helix-* 残留」约定（OI-4，本迭代两批次兑现）。因 formalId=TR-TEST-6 撞号，按 desk 先例 MainAgent 直写落盘（节点 id 稳定）。

### E-iter-20260821-dg90-2
- changeType: 修改
- targetNode: E-模型目录
- scope: domain.md E-模型目录 描述节计数措辞修正，无代码改动
- project: helix
- reason: L3 语义复核判文本漂移：E-模型目录 描述宣称「builtin 39 providers 静态表」，当前依赖 pi-ai 0.84.2 的 builtin 实为 40 providers（上游版本演进净增 1）。修正方向：更新计数为 40，或去除硬编码数字改「builtin 静态表（provider 数随 pi-ai 版本演进）」防再次漂移
- evidence: docs/kg/domain.md:336 vs 运行时探测（apps/daemon 下 bun eval：new ModelCatalog({now}).providerIds().length===40，@earendil-works/pi-ai@0.84.2）；apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts:129,135
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts:129,135 (builtinModels()/getProviders)
- sourceTask: final-verification L3 语义复核·实体面（phase-reviewer agt_2P5KN9XRVHJ6）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：L3 判漂移——E-模型目录「builtin 39 providers」去硬编码改「provider 数随 pi-ai 版本演进（0.84.2=40）」。因 formalId=E-模型目录 撞号，按 desk 先例 MainAgent 直写落盘（节点 id 稳定）。

### SPEC-iter-20260821-dg90-7
- changeType: 修改
- targetNode: TR-AD-1
- scope: architecture-rules.md TR-AD-1 规则节 driven/ 枚举手句
- project: helix
- reason: L3 判漂移：TR-AD-1 规则文本 driven/ 枚举（pi-engine/sqlite-session/tools/subagent/static-serve 五个）缺第 6 个 driven adapter cdp/（BrowserPort 的 CDP 实现域，零 pi import、不入 AG-04 三根——枚举补列即可，AG-04 口径不变）。本迭代新条款（@helix/common 例外/三项白名单/assembly 锚面）经核与 AG-02 实状一致无需改
- evidence: docs/kg/architecture-rules.md:33；apps/daemon/src/adapters/driven/cdp/CdpConnectionManager.ts:4；apps/daemon/test/arch-guard/arch-guard.test.ts:53-135
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/cdp/{CdpConnectionManager,browser-discovery,TabRegistry}.ts
- sourceTask: final-verification L3 语义复核·规则前半批（phase-reviewer agt_91CNPK5MC1AA，reviews/l3-arch-rules-batch1-review.md）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：L3 判漂移——TR-AD-1 driven/ 枚举补 cdp/（BrowserPort CDP 实现域，零 pi import、不入 AG-04 三根）；同块 inbound/outbound 枚举句同步补全。因 formalId=TR-AD-1 撞号，按 desk 先例 MainAgent 直写落盘（节点 id 稳定）。

### SPEC-iter-20260821-dg90-8
- changeType: 修改
- targetNode: TR-AD-2
- scope: architecture-rules.md TR-AD-2 规则节 inbound/outbound 清单与计数
- project: helix
- reason: L3 判漂移：TR-AD-2 outbound「出口端口生效 8 个」实为 10（后续迭代新增 BrowserPort/ResourceStatePort/SkillSourcePort）；inbound 枚举 4 个实为 7（缺 ChatPort/ResourceConfigPort/SessionPort 及其实现者归属）。修正方向：更新双向清单与计数，或改「详见守护/目录」弱断言。PathsPort 已删与 AG-01 ≥9 断言仍成立
- evidence: docs/kg/architecture-rules.md:71；apps/daemon/src/application/ports/outbound/{BrowserPort,ResourceStatePort,SkillSourcePort}.ts:1；ports/inbound/{ChatPort,ResourceConfigPort,SessionPort}.ts:1
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/ports/{inbound,outbound}/（inbound 7 port + outbound 10 port）
- sourceTask: final-verification L3 语义复核·规则前半批（phase-reviewer agt_91CNPK5MC1AA）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：L3 判漂移——TR-AD-2 outbound 8→10（+BrowserPort/ResourceStatePort/SkillSourcePort）、inbound 补 ChatPort/ResourceConfigPort/SessionPort 及其实现者归属。因 formalId=TR-AD-2 撞号，按 desk 先例 MainAgent 直写落盘（节点 id 稳定）。

### SPEC-iter-20260821-dg90-9
- changeType: 修改
- targetNode: TR-AD-7
- scope: architecture-rules.md TR-AD-7 规则节工具集枚举与 builtin providers 计数
- project: helix
- reason: L3 判漂移两处：①TR-AD-7 工具集枚举「四 core + grep + 编排三工具」缺 web 族——CoreToolExecutor 已注册 createWebSearchTool/createWebFetchTool（静态族）与条件注册 createBrowserTool（动态族薄转投 BrowserPort）；②「builtin 39 providers」实测 pi-ai 0.84.2 为 40（版本演进机械漂移，建议核正数字或去具体数断言）。其余红线（两包依赖/providers/all//node/AG-04 三根/auth.json/default_model）经核全部一致
- evidence: docs/kg/architecture-rules.md:262；apps/daemon/src/adapters/driven/tools/CoreToolExecutor.ts:103-114；tools/web/{WebSearchTool,WebFetchTool,BrowserTools}.ts:1；cd apps/daemon && bun -e 'builtinModels().getProviders().length' → 40
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/tools/web/ + CoreToolExecutor.ts:97-114
- sourceTask: final-verification L3 语义复核·规则前半批（phase-reviewer agt_91CNPK5MC1AA）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：L3 判漂移——TR-AD-7 工具集枚举补 web 族（web_search/web_fetch 静态 + browser 条件注册薄转投 BrowserPort）+ builtin providers 去硬编码。因 formalId=TR-AD-7 撞号，按 desk 先例 MainAgent 直写落盘（节点 id 稳定）。

### SPEC-iter-20260821-dg90-10
- changeType: 修改
- targetNode: TR-AD-13
- scope: architecture-rules.md TR-AD-13 规则节首句（串行化语义）与理由节
- project: helix
- reason: L3 判漂移：TR-AD-13「FIFO promise 链串行化保证顺序」已结构演进为分仓 FIFO（sessionTails 每会话仓 + globalTail 全局链；仓内严格 FIFO、仓间互不阻塞；AD-4 / architecture-feedback #19 落位）。修正方向：规则首句改写为分仓语义并补记来源。onError 不断链、close=drain+幂等、AG-06 单写点扫描三条款经核仍成立
- evidence: docs/kg/architecture-rules.md:492；apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts:96-102（分仓）、272-277（close 幂等）；arch-guard.test.ts:228-300（AG-06）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/sqlite-session/WriteQueue.ts:96-234
- sourceTask: final-verification L3 语义复核·规则前半批（phase-reviewer agt_91CNPK5MC1AA）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：L3 判漂移——TR-AD-13「FIFO promise 链」改分仓 FIFO + 全局链口径（sessionTails 仓内 FIFO、globalTail 全局链，AD-4 落位）。因 formalId=TR-AD-13 撞号，按 desk 先例 MainAgent 直写落盘（节点 id 稳定）。

### TR-AD-40
- changeType: 修改
- targetNode: TR-AD-40
- scope: docs/kg/architecture-rules.md TR-AD-40（AD-2 字符串透传语义 protocol 侧锚点回填）
- project: helix
- reason: T1.1 闭环 sediment：AD-2（档位全暴露、必选、字符串透传）protocol 侧完整实现——thinking 批四块全部新增字段 string 透传、零第二份枚举（grep 验证）
- evidence: commands.ts:374-392; events/thinking.ts:15-18; types/model.ts:20-30; events/agent.ts:68-73; grep ThinkingLevel 仅注释命中
- implementationStatus: 完整实现
- implementedCode: packages/protocol/src/commands.ts#ThinkingSetPayload; packages/protocol/src/events/thinking.ts#ThinkingChangedPayload; packages/protocol/src/types/model.ts#CatalogModel; packages/protocol/src/events/agent.ts#AgentInstantiatedPayload
- sourceTask: T1.1（SubAgent sediment + MainAgent 提案，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #1，2026-08-24）：同节点三候选（本条 + TR-AD-40-r2 + TR-AD-40-r3）合并落块——anchors.implementedBy 扩 protocol 命令/事件族 + handlers/thinking.ts + thinking-resolve.ts + ChildMain.ts + AgentEnginePort.ts 共 7 处、新增 testedBy 4 处，规则正文补 env 键名/注入器名/clamp 单点/观测面双位锚定；r2/r3 内容已并入本块，另两条 discard 留审计痕。formalId=TR-AD-40，节点 id 稳定。

### TR-AD-41
- changeType: 修改
- targetNode: TR-AD-41
- scope: docs/kg/architecture-rules.md TR-AD-41（AD-4 会话级参数协议演进模式 protocol 侧锚点回填——①②④ 三块）
- project: helix
- reason: T1.1 闭环 sediment：AD-4 protocol 包侧 ①②④ 三块完整实现（thinking.set/thinking.changed 命令族、CatalogModel 能力位、agent.instantiated +thinkingLevel）；③ SessionStateView 扩字段与 daemon 映射归 T1.2（brief 边界内划分，非部分实现）
- evidence: packages/protocol/test/type-surface/thinking.test.ts:61-62,109-110（chat.send 零字段负断言）; types/model.ts:20-30; events/agent.ts:68-73; envelope.ts:14 v0.11 + PROTOCOL.md §17.11
- implementationStatus: 完整实现
- implementedCode: packages/protocol/src/commands.ts#ThinkingSetCommand; packages/protocol/src/types/model.ts#CatalogModel; packages/protocol/src/events/agent.ts#AgentInstantiatedPayload; packages/protocol/test/type-surface/thinking.test.ts
- sourceTask: T1.1（SubAgent sediment + MainAgent 提案，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #2，2026-08-24）：同节点两候选（本条 + TR-AD-41-r2）合并落块——anchors 扩 handlers/thinking.ts + ModelService/ChatService/SessionRegistry + buildSessionStack + events/agent.ts 共 6 处、新增 testedBy 3 处，规则正文补 thinking.set 全链锚定 + 回放末值零新事件流 + 同构模板第二次实例化表述；r2 内容已并入，另条 discard 留审计痕。formalId=TR-AD-41，节点 id 稳定。

### TR-AD-42
- changeType: 修改
- targetNode: TR-AD-42
- scope: docs/kg/architecture-rules.md TR-AD-42（能力位驱动 UI 首次完整实例化锚点回填）
- project: helix
- reason: T2.1 闭环 sediment：AD-2/AD-3/AD-5 的 shell 消费面落地——thinkingSetCommand 构造器（字符串零校验透传）+ CatalogModel.thinkingLevels 直接驱动滑块刻度（不硬编码六档）+ entities/session thinking 切片 {override,effective} 双位（thinking.changed 广播 + 快照 additive 防御消费）+ ThinkingLevelSlider 共用原子组件（props: levels/value/ghostValue/disabled/peak/onSelect）+ ComposerThinkingPicker（trigger chip + popover）+ PEAK 四要素全 token 零新色板（reduced-motion 光束静止）；dispatcher 路由守护同步扩（thinking.changed 消费者）
- evidence: commands.test.ts + ComposerThinkingPicker.test.tsx 能力位三变体/clamped + ThinkingLevelSlider.test.tsx 10 用例 + thinking-level.css.test.ts 6 用例 + consumers/thinking-level.test.ts 6 用例；test:shell 422 全绿
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/shared/api/commands.ts#thinkingSetCommand; apps/shell/src/features/thinking-level/ui/ThinkingLevelSlider.tsx; apps/shell/src/features/thinking-level/ui/ComposerThinkingPicker.tsx; apps/shell/src/features/thinking-level/model/thinking-capability.ts#resolveThinkingCapability; apps/shell/src/entities/session/model/state.ts#ThinkingSlice; apps/shell/src/entities/session/model/consumers/thinking-level.ts; apps/shell/src/shared/ui/styles/workbench.css（.tp-*/.tl-*/.beam）
- sourceTask: T2.1（SubAgent sediment + MainAgent 补录，2026-08-23；submit_result 自动落账故障见 ISSUE-kg-propose-path）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #6，2026-08-24）：同节点两候选（本条 + TR-AD-42-r2）合并落块——anchors.implementedBy 扩 features/thinking-level + entities/session + shared/api/commands.ts + shared/lib/catalog-match.ts 共 4 处（含 r2 全目录补登）、新增 testedBy 6 处，规则正文补 getSupportedThinkingLevels 滤 off 映射式 + 首个完整实例化表述；r2 内容已并入，另条 discard 留审计痕。formalId=TR-AD-42，节点 id 稳定。

### TR-AD-43
- changeType: 新增
- scope: docs/kg/architecture-rules.md（convention 层新规——WS 命令拉取效应必须连接态门控）
- project: helix
- reason: T3.2 打回修复沉淀：ComposerThinkingPicker requestModelConfig 挂载效应早于 WS 握手触发，HelixWsClient.send 握手前静默拒绝且无重试 → fresh-load 目录帧丢失（T2.1 bug 类通用形态）；修法 = 效应 conn === "connected" 门控 + 握手完成重发补拉（AgentPage [conn,...] 依赖先例）；适用范围 = shell 全部挂载期/进页期 WS 命令拉取效应（model.catalog/model.get_default/auth.list/agent.config.list 同族）
- evidence: commit 3ec1f81；回归用例「握手前挂载不发 → connected 后必拉」；evidence/CL-1-fidelity-checklist.md P-1 偏差记录（已修复注记）
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/features/thinking-level/ui/ComposerThinkingPicker.tsx:40-48
- sourceTask: T3.2 打回修复（SubAgent sediment + MainAgent 补录，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #12，2026-08-24）：新 convention 正式号 TR-AD-43（T3.2 打回修复沉淀：ComposerThinkingPicker requestModelConfig 早于握手触发致 fresh-load 目录帧丢失，修法 = conn 门控 + 握手完成重发，commit 3ec1f81 + 回归用例）。发号权在人，用户经终验报告批准签发。

### TR-AD-44
- changeType: 新增
- scope: docs/kg/architecture-rules.md（convention 层新规——配置资源槽位经 getter 折叠进 profile 读面）
- project: helix
- reason: 架构师终审 F-1 裁决采纳沉淀：「配置资源槽位经 getter 折叠进 profile 读面，静态声明优先；解析单点本体保持字面链形状」——SubagentLauncherDeps.profile 扩为 AgentProfile | (() => AgentProfile)（deps.model/apiKeys 注入源模式同构先例），组合根 getter 在 launch 时刻合并 resource_state 槽位；同形态已两处靠注释维系（launcher 解析 + subagentSnapshotFor 快照供给手工复制同一链序），复制点越多注释维系越脆，应落显式约定
- evidence: SubagentLauncher.ts:47-53（deps.profile 联合类型）+ :168-171（profileNow 归一读面）+ :177-182（resolveThinkingFor 两级字面形状）；buildSessionStack.ts:203-210（getter 折叠）+ :267-277（subagentSnapshotFor 同源同时点）；architect-review.md F-1 裁决
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts#profileNow; apps/daemon/src/infrastructure/assembly/buildSessionStack.ts#getter 折叠段
- sourceTask: 架构师终审 F-1（MainAgent 补录，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #13，2026-08-24）：新 convention 正式号 TR-AD-44（架构师终审 F-1 裁决采纳：「配置资源槽位经 getter 折叠进 profile 读面，静态声明优先；解析单点本体保持字面链形状」——deps.profile 联合类型 + 组合根 getter 折叠，SubagentLauncher.ts:47-53/168-182 + buildSessionStack.ts:203-210/267-277）。发号权在人，用户经终验报告批准签发。

### TR-AD-36
- changeType: 修改
- targetNode: TR-AD-36
- scope: GC 正确性类检出
- project: helix
- reason: rotten-pointer: anchor → apps/daemon/src/adapters/driven/subagent/ScopedBrowserProxy.ts (docs/kg/architecture-rules.md)；rotten-pointer: anchor → apps/daemon/src/adapters/driven/subagent/child/RemoteBrowserPort.ts (docs/kg/architecture-rules.md)；rotten-pointer: anchor → apps/daemon/test/unit/subagent-remote-browser-port.test.ts (docs/kg/architecture-rules.md)；rotten-pointer: anchor → apps/daemon/test/unit/subagent-scoped-browser-proxy.test.ts (docs/kg/architecture-rules.md)；rotten-pointer: anchor → apps/daemon/test/unit/subagent-wire.test.ts (docs/kg/architecture-rules.md)
- evidence: kg gc_report
- sourceTask: kg-gc
- createdIn: (gc-report)
- decisionLog: 终验裁决（用户批准终验报告 §7 #14，2026-08-24）：GC 直写候选收账——终验复验五处锚点文件现行均在位（child/RemoteBrowserPort.ts / ScopedBrowserProxy.ts / transport/wire.ts / 三个 test/unit/subagent-*.test.ts），gc_report 复跑 correctness=0（verification 期检出系时点快照/索引口径差异，不复现）；现行块零变化落块，apply 仅作台账收口（entry.id === formalId 无撞号）。

### TR-AD-10
- changeType: 修改
- targetNode: TR-AD-10
- scope: docs/kg/architecture-rules.md TR-AD-10（trust 职责补「规划位（未落地）」标注）
- project: helix
- reason: L3 语义复核判不一致（轻微）：四职责枚举中 trust（「desk 现成 Rust 资产按此边界搬运」）在 src-tauri 零代码承载（grep 全目录零命中，contracts/architecture.md 亦无 trust 概念），属宣称未兑现的规划位——审计者按文本在壳内找 trust 实现会落空。修正：trust 款加「规划位（未落地）」标注或改述「三类已落地职责 + trust 规划项」（改文本级）
- evidence: docs/kg/architecture-rules.md:377 vs apps/shell/src-tauri/ 全目录 trust 零命中；三职责落地证据 lib.rs:1-6/229、main.rs:99/120-127；final-verification/l3-review-a.md §8
- implementationStatus: 完整实现
- implementedCode: apps/shell/src-tauri/src/lib.rs:1-6 + main.rs:99,120-127（三职责落地，trust 缺位）
- sourceTask: final-verification L3 语义复核·批次 A（phase-reviewer agt_VTR24J07WECN，2026-08-24；propose 撞号经 MainAgent 手动合并）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #18，2026-08-24）：L3 复核判不一致（轻微）修正——trust 职责在 src-tauri 零代码承载（grep 全目录零命中），改为「已落地三类 + trust 规划位（未落地）」口径并补反例「零承载零宣称」；updatedIn 刷 iter-20260823-6ps5。改文本级，零改码。formalId=TR-AD-10，节点 id 稳定。

### TR-AD-45
- changeType: 新增
- scope: docs/kg/architecture-rules.md（技术规则新增——P-1 chat composer 推理控件默认关显示形态）
- project: helix
- reason: P-1 推理控件默认关语义的显示决策：滑块 OFF 为 UI 合成第 0 刻度（levels = ["off", ...CatalogModel.thinkingLevels]，协议/目录零变更——off 不进 pi-ai 档位枚举）；chip 无覆盖与显式关同态显示 OFF（AUTO 退场），滑块以 ghost 空心/实心 thumb 区分两态；选 OFF → thinking.set("off") 协议透传（daemon 侧 TR-AD-40 短路处理）；PEAK 判据入参用能力档序列（不含 off）防误判；popover scope 文字提示删除（用户裁决）；能力位驱动刻度数不变（TR-AD-42 复用）
- evidence: ComposerThinkingPicker.test.tsx「OFF 第 0 刻度」describe 三用例（off 刻度渲染+ghost / 选 off 发令 / 显式关实心）；vitest 449/449；commit f9a49d8
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/features/thinking-level/ui/ComposerThinkingPicker.tsx:80-84,131
- sourceTask: task-T2（default-coder agt_256H5F5XRE5H，2026-08-24）
- createdIn: task-20260824-t2
- decisionLog: 用户裁决「apply吧」（2026-08-24 批量人审）——发号 TR-AD-45 落库

### TR-AD-46
- changeType: 新增
- scope: docs/kg/architecture-rules.md（技术规则新增——推理强度默认档中位规则 defaultLevelFor）
- project: helix
- reason: 用户裁决「所有模型的推理强度默认都取中间档位，如果只有两个档位则取第一档位，最高档位默认都不选」：defaultLevelFor(levels) = levels[Math.floor((n-1)/2)]（n=2 取低档、n=3 取中、n=4 取低中位、n=1 唯一档例外、空数组 undefined 不写）；纯函数沉淀于 thinking-capability 模型段（AG-14）；消费位 = P-2 开关 off→on 翻转时的默认档写入（开 on 即写槽位；off 由开关承担，P-2 滑块无 OFF 刻度、ghost 预览位随开关形态退役）
- evidence: thinking-capability.test.ts 7/7（[low,high,max]→high、[low,high]→low、[minimal,low,medium,high]→low、n=1、空数组、最高档负断言）；P-2-ThinkingField.test.tsx「off → on：onSelect 中位档」矩阵；AgentPage.test.tsx 点开关 → set_enabled{name:medium}；commit e2e466d
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/features/thinking-level/model/thinking-capability.ts:35-41
- sourceTask: task-T3（default-coder agt_EVCCYR5Q440C，2026-08-24）
- createdIn: task-20260824-t3
- decisionLog: 用户裁决「apply吧」（2026-08-24 批量人审）——发号 TR-AD-46 落库

### TR-AD-47
- changeType: 新增
- scope: docs/kg/architecture-rules.md + packages/protocol/PROTOCOL.md §16.3/§17.11（steer source 消息类型区分规则）
- project: helix
- reason: closure 注入与用户 steer 的消息类型区分：SteerSource = "user"|"closure"|"progress" 协议单点定义（additive 批内补登不 bump），贯通 steer.queued/drained 载荷 + MessageEntryDto + Entry 物种 + steer_queue.source 列（守护式 ALTER，旧行 NULL 前向兼容 = 缺省按 user 渲染）；ChatService.injectClosure 签名扩展带 source（调度链 ClosureRecorder 传 closure、周期进展报告传 progress）；实时 chat.message.completed 帧 entry.source 透传；三值由协议面定死（helix 自有枚举——AD-2 字符串透传原则不适用，已落 PROTOCOL.md 字段行语义列）；domain 与 protocol 各自定义同值域枚举（domain 不 import @helix/protocol 纪律，adapter 层映射）
- evidence: chat-service.test.ts describe⑥（user/closure/progress 三源 + idle 注入快照可见）；closure-chain.test.ts pendingSteer 双源；scheduler-progress-report.test.ts sources 断言；sqlite-persistence TP-CL8-1（DB 行 source + 冷恢复不丢）；sqlite-schema-migration 守护式补列；daemon 872 绿；commits 027b41f + b7f63dd
- implementationStatus: 完整实现
- implementedCode: packages/protocol/src/types/chat.ts（SteerSource 单点）；apps/daemon/src/domain/session/Entry.ts（source 字段）；apps/daemon/src/application/services/ChatService.ts（injectClosure 签名 + publishMessageCompleted source）；apps/daemon/src/adapters/driven/sqlite-session（steer_queue.source）；apps/daemon/src/adapters/driving/ws-server/EnvelopeMapper.ts
- sourceTask: task-T11a+T11b（default-coder agt_726P6CWWC3NZ + agt_Q94ZMJHPHXE6，2026-08-24）
- createdIn: task-20260824-t11
- decisionLog: 用户裁决「apply吧」（2026-08-24 批量人审）——发号 TR-AD-47 落库

### TR-AD-48
- changeType: 新增
- scope: docs/kg/architecture-rules.md（UI 显示规则——主时间轴注入徽标 source 变体）
- project: helix
- reason: 主时间轴 closure/progress 注入与用户 steer 视觉分离：MessageBubble/SteerBadge 按 entry.source 分族——closure=amber「CLOSURE」、progress=cyan「PROGRESS」、user/缺省=既有 violet STEER 两态不变（老数据缺省按 user，T11a 口径）；idle 注入无 steerState 时渲染静态来源徽标；实时帧区分经 MessageCompletedPayload.source additive 透传（不再仅靠快照对账）；ClosureCard（抽屉/终态面）不动——本规则只管主时间轴注入内容
- evidence: MessageBubble.test.tsx source 三态钉 + 用户 steer/缺省回归钉；session-reducer.test.ts 缺省不带键；shell 475 绿；commit b7f63dd
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/widgets/chat-stream/ui/MessageBubble.tsx:15-52（SteerBadge source 变体）；apps/shell/src/entities/session/model/consumers/chat.ts（confirmSteerEcho/drainSteer source）
- sourceTask: task-T11b（default-coder agt_Q94ZMJHPHXE6，2026-08-24）
- createdIn: task-20260824-t11b
- decisionLog: 用户裁决「apply吧」（2026-08-24 批量人审）——发号 TR-AD-48 落库

## discarded

### SPEC-iter-20260815-6tss-2
- changeType: 新增
- scope: domain
- project: helix
- reason: E 层 e2e 可复用装配（真 daemon + FakeLLM）：bun 子进程 launcher（stdout 控制行协议 + SIGTERM 优雅停机）+ Node 侧 DaemonProcess fixture（--home tmp / 端口管理 / 重启重试）+ 剧本 JSON 契约（reply/replyFromResult/tool + 流式分片制造可打入窗口）+ globalSetup（端口预检 + VITE_HELIX_PORT 烘焙 dist）。后续迭代浏览器级 E2E 改剧本即可扩展；真实 LLM 联调形态换 streamFnOverride 实现即可。候选落点建议：与 SPEC-iter-20260815-6tss-1（F 层 harness）合并为 testing-rules 表现验证装配条目——由终验人审裁决（临时号，正式号以人审签发为准）
- evidence: commit 70154fd（分支 dev-iter-20260815-6tss，12 文件 +1369 行，生产源码零触碰）；全量 npx playwright test -c playwright.e2e.config.ts → 6 绿 + 1 预期红（32s）；F 层回归 29 绿 / bun test apps/daemon 161 绿；--home tmp 隔离，真实 ~/.helix 零触碰
- implementationStatus: 完整实现
- implementedCode: e2e/harness/daemon-script.ts（剧本契约）+ e2e/harness/daemon-fixture.ts（DaemonProcess + e2e fixture）+ apps/daemon/test/e2e/launcher.ts（bun 侧装配）+ e2e/harness/e2e-global-setup.ts + playwright.e2e.config.ts
- sourceTask: verification/test-plan TS3+TS4 闭环（phase-tester agt_W239GDV2H5TH，2026-08-15，DONE_WITH_CONCERNS 6绿+1预期红）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 A-①（用户批准 2026-08-15）：与 SPEC-iter-20260815-6tss-1 合并落库为 TR-TEST-5「表现验证双层装配纪律」——E 层装配纪律已并入 TR-TEST-5 正文（launcher/DaemonProcess/剧本契约/globalSetup），本条 discard 保留审计痕，知识不丢失

### TR-AD-2-r2
- changeType: 修改
- targetNode: TR-AD-2
- scope: helix/docs/kg/architecture-rules.md TR-AD-2；新增 port 时落位/归类决策的规则依据面
- project: helix
- reason: L3 语义复核判不一致（Important）：文本 outbound 清单列 SystemPort，实际自 9304a9d 起位于 ports/inbound/（组合根内联实现、driving ws-server 调用）；outbound 实际生效 5 个 + PathsPort（悬空豁免）。错位系上迭代修正 3155a7e 引入。附带：inbound 描述未涵盖 AgentOrchestrationPort 亦被 driven tools（编排三工具）调用、SystemPort 由组合根实现两个 M2 新形态。修正方向：outbound 清单改 5 个生效 port（去 SystemPort，PathsPort 豁免注记保留）；SystemPort 移 inbound 侧并注明实现方为组合根/生命周期侧；inbound 调用方补「编排三工具经 AgentOrchestrationPort 回口（TR-AD-16 同口径）」
- evidence: apps/daemon/src/application/ports/inbound/SystemPort.ts:13；infrastructure/container.ts（system 组合根内联实现）；ports/inbound/README.md；git show 3155a7e diff（清单为修正时新写未核对目录）；git log --follow ports/inbound/SystemPort.ts → 9304a9d 创建即 inbound
- implementationStatus: 部分实现
- implementedCode: helix/docs/kg/architecture-rules.md#TR-AD-2（规则段 outbound 清单句与 inbound 描述句）
- sourceTask: final-verification L3 语义复核·既有规则面（phase-reviewer agt_5WW40CXSS8SD，2026-08-16，DONE 9 节点 6 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A 执行记录（用户批准 2026-08-16）：修正内容已由 project_write_tech_rules 直接落库（architecture-rules.md TR-AD-2 现行文本 = outbound 生效 5 个 + SystemPort 归 inbound + M2 两新形态调用方），正式号 TR-AD-2 与上迭代 applied 台账条目撞号无法二次 apply——本条 discard 保留审计痕，修正事实以上迭代 TR-AD-2 applied 条目 + 本 decisionLog 为准。知识不丢失。

### TR-AD-7-r2
- changeType: 修改
- targetNode: TR-AD-7
- scope: helix/docs/kg/architecture-rules.md TR-AD-7；pi 库使用红线规则文本
- project: helix
- reason: L3 语义复核判不一致（Important）：①工具集文本「四内置+grep」过时——CoreToolExecutor 现为八工具（四内置 + grep + 编排三工具 agent_spawn/agent_send/agent_status）；②pi import 域文本两域 vs AG-04 白名单本迭代已扩三域（+adapters/driven/subagent：SubagentLauncher/ChildMain/scriptedEngine import pi 符号）——守护前进、文本未同步，「同口径」断言失效。修正方向：工具集清单补编排三工具；pi import 允许域补第三域 subagent，与 AG-04 恢复同口径
- evidence: apps/daemon/src/adapters/driven/tools/CoreToolExecutor.ts（八工具注册表）；tools/agent/AgentOrchestrationTools.ts:1-16（薄转投）；arch-guard.test.ts:106-126（AG-04 三域白名单）；grep pi → 13 文件全在 pi-engine/tools/subagent 三 driven 域
- implementationStatus: 部分实现
- implementedCode: helix/docs/kg/architecture-rules.md#TR-AD-7（规则段工具集句 + pi import 域句）
- sourceTask: final-verification L3 语义复核·既有规则面（phase-reviewer agt_5WW40CXSS8SD，2026-08-16，DONE 9 节点 6 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A 执行记录（用户批准 2026-08-16）：修正内容已由 project_write_tech_rules 直接落库（architecture-rules.md TR-AD-7 现行文本 = 八工具集 + pi import 三域含 subagent + 锚补 subagent 目录），正式号 TR-AD-7 与上迭代 applied 台账条目撞号——discard 留审计痕，修正事实以上迭代 TR-AD-7 applied 条目 + 本 decisionLog 为准。知识不丢失。

### TR-TEST-2-r2
- changeType: 修改
- targetNode: TR-TEST-2
- scope: docs/kg/testing-rules.md TR-TEST-2 规则段①款
- project: helix
- reason: 守护测试 AG-04 白名单已扩为 pi-engine/tools/subagent 三目录（T2.2 新增 subagent/ 为 pi driven 域子进程形态），规则文本仍写两目录——作为落位/评审判据会误判 subagent/ 内合法 pi import 为违规，且与守护测试口径分叉。修正方向：①款更新为「仅出现在 adapters/driven/pi-engine、adapters/driven/tools 与 adapters/driven/subagent（subagent/ 为 pi driven 域的子进程形态）」，与 TR-AD-7 修正候选同批
- evidence: arch-guard.test.ts:106-117（AG-04 allowedRoots = pi-engine/tools/subagent + 注释「白名单新增第三个 driven 根」）；SubagentLauncher.ts:2、ChildMain.ts:20、scriptedEngine.ts:2-4 共 5 处 pi import
- implementationStatus: 部分实现
- implementedCode: apps/daemon/test/arch-guard/arch-guard.test.ts:106-117
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A 执行记录（用户批准 2026-08-16）：修正内容已由 project_write_tech_rules 直接落库（testing-rules.md TR-TEST-2 ①款 = pi import 三根口径 pi-engine/tools/subagent，与 TR-AD-7 同批），正式号 TR-TEST-2 与上迭代 applied 条目撞号——discard 留审计痕，修正事实以上迭代 applied 条目 + 本 decisionLog 为准。知识不丢失。

### TR-TEST-5-r2
- changeType: 修改
- targetNode: TR-TEST-5
- scope: docs/kg/testing-rules.md TR-TEST-5 E 层段
- project: helix
- reason: 端口预检 fail-fast 实际在 globalSetup，DaemonProcess fixture 内是端口占用重试缓冲；同段后文已正确归属，属并列归属措辞错位。修正方向：文本微调为预检归 globalSetup、fixture 为重试缓冲（minor 措辞级）
- evidence: e2e/harness/e2e-global-setup.ts:3（预检 fail-fast 在 globalSetup）；e2e/harness/daemon-fixture.ts:96-104（fixture 内为端口占用重试缓冲）
- implementationStatus: 完整实现
- implementedCode: e2e/harness/e2e-global-setup.ts:3
- sourceTask: final-verification L3 语义复核·新增/修订规则面（phase-reviewer agt_SJ9V8S3XEMC0，2026-08-16，DONE 12 节点 9 一致 3 不一致）
- createdIn: iter-20260816-uzvg
- decisionLog: 终验决策 A 执行记录（用户批准 2026-08-16）：措辞修正已由 project_write_tech_rules 直接落库（testing-rules.md TR-TEST-5 E 层段 = fixture 端口占用重试缓冲、预检 fail-fast 归 globalSetup），正式号 TR-TEST-5 与上迭代 applied 条目撞号——discard 留审计痕。知识不丢失。

### TR-TEST-6
- changeType: 修改
- targetNode: TR-TEST-6
- scope: GC 正确性类检出
- project: helix
- reason: rotten-pointer: anchor → e2e/CL-4-teardown-residue.spec.ts (docs/kg/testing-rules.md)
- evidence: kg gc_report
- sourceTask: kg-gc
- createdIn: (gc-report)
- decisionLog: 终验决策 B（用户批准 2026-08-16）：rotten-pointer 候选为 dev→main 合并时序现象——合并后 gc_report correctness=0，锚 e2e/CL-4-teardown-residue.spec.ts 已可解析（kg-inspection §六预测兑现）。候选使命完成，按「合并自愈」discard。TR-AD-8 孤儿信号为该节点暂无入边（新规则），卫生类阈值内 PASS。

### TR-AD-8
- changeType: 修改
- targetNode: TR-AD-8
- scope: 级联校验（apply E-会话聚合）
- project: helix
- reason: 邻居 TR-AD-8 的锄点 apps/shell/src/ 符号解析失败（符号已消失？）
- evidence: kg apply 级联校验 @ iter-20260816-uzvg
- sourceTask: kg-apply
- createdIn: iter-20260816-uzvg
- decisionLog: 终验裁决（2026-08-16）：apply 级联校验误报——symbol-gone 针对的是目录级锚（apps/shell/src/ 等分层目录指针，非代码符号，codegraph 符号解析天然不含目录）。目录锚是 TR-AD-1/TR-AD-2/TR-AD-8 的既有语义形态（指层不指文件），非腐烂指针。discard；如后续需文件级锚精化列入优化项 #15（anchor 覆盖率回升）一并处理。

### TR-TEST-4
- changeType: 修改
- targetNode: TR-TEST-4
- scope: domain
- project: helix
- reason: L3 语义复核判轻度不一致（行为缺口非文本漂移）：E 层 daemon fixture 违反「测试结束清理 tmp」字面纪律——daemon-fixture.ts:16 导入 rmSync 未用，teardown（:266-268）只 stop() 不删 helix-e2e-home-* tmp 目录（每次 e2e 运行残留一套 home 含 helix.db/logs/sandbox）。隔离核心全部满足（mkdtemp tmp home/真实 ~/.helix 零触碰/端口预检 fail-fast/全 argv 传参）。修正方向：代码改——teardown 在全部 daemon 收尾后统一 rmSync(home,{recursive,force})（注意 TS4 重启场景同 home 复用语义），约 3 行；规则文本不动。终验阶段不改生产代码，建议随 pending 候选 apply（合并落 TR-TEST-5 时同批）或 M2 处理由人审裁决
- evidence: final-verification/l3-review-rules.md TR-TEST-4 详评；对照 integration/sqlite-persistence.test.ts:99,117,213,261 有 rmSync 清理
- implementationStatus: 部分实现
- implementedCode: e2e/harness/daemon-fixture.ts:16,80,266-268（teardown 缺 rmSync）
- sourceTask: final-verification L3 语义复核·规则面（phase-reviewer agt_A3RMAK9S5SNP，2026-08-15，DONE）
- createdIn: iter-20260815-6tss
- decisionLog: 终验决策 B（用户批准 2026-08-16）：deferred 候选的修正方向已由本迭代 T5.2 teardown 三件套完整兑现并固化为 TR-TEST-6（daemon-fixture teardown 统一 rmSync + 三面断言 + x2 连跑零残留，E 层 14 passed 证据）——「测试结束清理 tmp」字面纪律现为真实现。候选使命完成，discard 保留审计痕（上迭代 iter-20260815-6tss 遗留收口）。
- deferHistory: [iter-20260815-6tss]

### CL-iter-20260818-mq5a-1
- changeType: 修改
- targetNode: TR-TEST-6
- placement: docs/kg/testing-rules.md TR-TEST-6 节点（正文增补外补条目 + anchors 扩充）
- scope: docs/kg/testing-rules.md TR-TEST-6 节点正文增补外补条目 + anchors 扩充；影响下游 kg-inspection 判据口径声明
- project: helix
- reason: CL-7 裁决（Q-5 全收）「判据入 TR-TEST-6 外补条目」：判据已完整实现并接线，但 testing-rules.md 正文零变更、全仓搜「外补」零命中——迭代产物（verification-report.md:93 / kg-inspection.md:33）声称已落与 main 现状矛盾（声明性漂移）。L3 复核（phase-reviewer 批 3）判 TR-TEST-6 不一致并产四节 update 草案
- evidence: git log -- docs/kg/testing-rules.md 末次 2308bc2（上迭代终验沉淀），本迭代零变更；grep「外补|TMPDIR|预检|卫生」testing-rules.md 仅 TR-TEST-5 端口预检（:167）无关命中；task-T4.3-brief.md:8,15（CL-7/Q-5 裁决「判据入 TR-TEST-6 外补条目」）；task-T4.3-report.md:6（外补草稿待落 kg）；verification-report.md:93 / kg-inspection.md:33（声称已落，与 main 现状矛盾——声明性漂移）
- nodeDraft: {"anchors":{"implementedBy":["e2e/harness/tmp-hygiene.ts","e2e/harness/e2e-global-setup.ts"],"testedBy":["e2e/CL-4-teardown-residue.spec.ts"]},"derivedFrom":["CL-7（Q-5 全收）"],"digest":"写 e2e harness、新增临时目录前缀、配 CI 连跑、排查测试残留时","graph":"tech","kind":"rule","layer":"common","name":"TR-TEST-6 外补条目（TMPDIR 全前缀卫生预检判据）","sections":{"counterExample":"预检只进 spec 不进 globalSetup（spec 内预检已晚于构建，拦不住本轮污染）；afterAll 回收旁路散点化（各测试自记自删，漏一处即破坏断言面）","rationale":"连跑两轮断言（test:e2e:x2）只证本轮零残留，防不了外部残留污染断言面；跑前预检把「进入断言面前先证清白」机制化为 fail-fast，红/绿双路径已在 iter-20260818-mq5a 实证（首跑拦截 896 条开发阶段中断遗留）","rule":"外补条目（iter-20260818-mq5a CL-7）：E 层 globalSetup 首步执行 TMPDIR 全前缀卫生预检（helix-* 前缀残留=0 才放行，非零 fail-fast 报清单，先于端口预检与构建）；残留断言面前缀面扩至 helix-* 全前缀（不限于单一迭代前缀）；bun test 侧自建沙箱 afterAll 统一回收"},"status":"active","updatedIn":"iter-20260818-mq5a"}
- implementationStatus: 完整实现
- implementedCode: e2e/harness/tmp-hygiene.ts（全文件：HELIX_TMP_PREFIX/listHelixTmpResidue/assertTmpHygiene + CLI 红绿自证）；e2e/harness/e2e-global-setup.ts:15,34（globalSetup 首步接线）；e2e/CL-4-teardown-residue.spec.ts:102-119（三面断言扩 helix-* 全前缀）；apps/daemon/test/integration/tools-loop.test.ts:111,278（afterAll 沙箱回收）；package.json:17（test:e2e:x2）
- sourceTask: final-verification/l3-semantic-review-batch3-shell-lifecycle-persistence-profile-testing.md（phase-reviewer 批 3 L3 语义复核）
- createdIn: iter-20260818-mq5a
- decisionLog: 终验人审 apply 执行记录（用户批准终验报告 2026-08-18，裁决①=采纳修正）：TR-TEST-6 外补条目内容已由 project_write_tech_rules 直接落库（testing-rules.md TR-TEST-6：正文增补外补条款「globalSetup 首步 TMPDIR 全前缀卫生预检 + 断言面前缀面扩展 + afterAll 沙箱回收」+ anchors 扩充 tmp-hygiene.ts/e2e-global-setup.ts + relations dependsOn TR-TEST-4/5 保留 + updatedIn=iter-20260818-mq5a）。正式号 TR-TEST-6 与上迭代（6q6f 终验决策 B）discarded 条目撞号——台账 id 唯一性缺口：propose 侧已用临时号 CL-iter-20260818-mq5a-1 绕过，apply 侧 ledgerHas 查重含 discarded 分区不可绕。按 6q6f 终验决策 A 同款处置：discard 留审计痕，修正事实以本条目 + testing-rules.md TR-TEST-6 现文为准。知识不丢失；修复 verification-report.md:93 声明性漂移。来源：L3 语义复核批 3（phase-reviewer）。撞号工具缺口记优化机会 #13（扩 apply 侧）。

### E-会话聚合
- changeType: 修改
- targetNode: E-会话聚合
- scope: domain
- project: helix
- reason: hotfix-20260820 草稿会话生命周期定稿（用户实测四 bug 同根因，用户选「恒有会话 + 内存草稿不可见/转正」方案）：E-会话聚合 描述补内存草稿语义（零条目草稿有 id 不落盘、双面不可见、首个用户条目经 promoteDraft 转正）；规则补「草稿不进清单不写事件、首条消息才落库并转正」；digest 补「动草稿会话转正时」；updatedIn 推进 hotfix-20260820
- evidence: docs/hotfixes/2026-08-20-draft-session-lifecycle.md；SessionRegistry.ts listSessions/promoteDraft/probeCurrentDraft/startDraftSession；draft-promotion.test.ts + session-registry-draft.test.ts 14 用例全绿；daemon 453/0
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/SessionRegistry.ts（listSessions 零条目跳过/promoteDraft 转正单点/startDraftSession 复用/probeCurrentDraft 握手探测）、ChatService.ts onFirstUserEntry、WsServerAdapter.ts 握手 draft 分支、packages/protocol events.ts（welcome.draft）/commands.ts（chat.send.model）
- sourceTask: hotfix-20260820 task-T4（default-coder agt_3KJRVXQTNT1H，DONE；sediment 候选因无活跃迭代未自动落账，MainAgent 手动补录）
- createdIn: hotfix-20260820
- decisionLog: 用户批准同步（2026-08-20「把一些修改更新到文档和图谱」）：apply——节点正文已直接修订；决策语义档案落 decisions.md hotfix-20260820 AD-1（含取代 AD-5 M5「会话创建即发布」的发布点变更与全部边界备案）

### TR-AD-22
- changeType: 修改
- targetNode: TR-AD-22
- scope: domain
- project: helix
- reason: hotfix-20260820 bug3（草稿态流式串台）修复触及规则描述的帧路由事实：frame.ts 后台路由守卫原含 activeId!==null（v0.1 假设「activeId null 仅首连前」），被草稿态（active.sessionId===null）打破——旧会话帧绕过路由直写草稿 store。规则正文补「后台路由不依赖 activeId 非空 + model 配置族前置拓扑级消费防误吞」；updatedIn 推进 hotfix-20260820
- evidence: frame-dispatch.test.ts 新增 3 用例（草稿态后台帧轻量消费/未知丢弃/model.get.result 不吞）RED→GREEN；subscription-ledger welcome attach 静默登记 full 档；shell 284/0
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/entities/session/model/dispatcher/frame.ts（守卫修正+族序调整）、subscription-ledger.ts（onSnapshot 首连分支 tiers 登记）
- sourceTask: hotfix-20260820 task-T2（default-coder agt_Y7J5DA6B4FWS，DONE）
- createdIn: hotfix-20260820
- decisionLog: 用户批准同步（2026-08-20）：apply——规则正文已直接修订；路由假设废止事实同录 decisions.md hotfix-20260820 AD-1(g)

### TR-AD-23
- changeType: 修改
- targetNode: TR-AD-23
- scope: domain
- project: helix
- reason: hotfix-20260820 契约 additive 两字段（ConnectionWelcomePayload.draft?、ChatSendPayload.model?）为规则①「可选参数扩展优先于新命令对」新例证（与 subscribe 扩 tier、steer 扩 instanceId 同模式）；规则①文本补例证；updatedIn 推进 hotfix-20260820
- evidence: packages/protocol events.ts/commands.ts diff；PROTOCOL.md §14 additive 登记；test:protocol 33/0
- implementationStatus: 完整实现
- implementedCode: packages/protocol/src/events/notification.ts:8（ConnectionWelcomePayload.draft?）、packages/protocol/src/commands.ts（ChatSendPayload.model?）、packages/protocol/PROTOCOL.md
- sourceTask: hotfix-20260820 task-T4（default-coder agt_3KJRVXQTNT1H，DONE）
- createdIn: hotfix-20260820
- decisionLog: 用户批准同步（2026-08-20）：apply——例证已补入规则①正文（纯文本例证增补，规则语义不变）

### TR-AD-26
- changeType: 修改
- targetNode: TR-AD-26
- scope: GC 正确性类检出
- project: helix
- reason: rotten-pointer: anchor → apps/shell/src/pages/trace/model/trace-model.test.ts (docs/kg/architecture-rules.md)；rotten-pointer: anchor → packages/protocol/test/type-surface/catalog.test.ts (docs/kg/architecture-rules.md)；rotten-pointer: anchor → packages/protocol/test/type-surface/sot-consistency.test.ts (docs/kg/architecture-rules.md)
- evidence: kg gc_report
- sourceTask: kg-gc
- createdIn: (gc-report)
- decisionLog: 终验决策（用户批准终验报告 §五，2026-08-20）：过期候选 discard——合并后 6 腐烂锚全部自愈（锚已指向 type-surface/ 新路径），候选描述的锚路径问题已不存在；锚修订事实由 149a5f2 + 合并承载。

### TR-TEST-3
- changeType: 修改
- targetNode: TR-TEST-3
- scope: GC 正确性类检出
- project: helix
- reason: rotten-pointer: anchor → apps/shell/src/shared/api/fake-transport.test.ts (docs/kg/testing-rules.md)
- evidence: kg gc_report
- sourceTask: kg-gc
- createdIn: (gc-report)
- decisionLog: 终验决策（用户批准终验报告 §五，2026-08-20）：过期候选 discard——合并后锚自愈（fake-transport.test.ts 锚有效），候选描述问题已不存在。

### TR-AD-24
- changeType: 修改
- targetNode: TR-AD-24
- scope: GC 正确性类检出
- project: helix
- reason: rotten-pointer: anchor → apps/daemon/src/application/services/SchedulerService.ts (docs/kg/architecture-rules.md)
- evidence: kg gc_report
- sourceTask: kg-gc
- createdIn: (gc-report)
- decisionLog: 终验决策（用户批准终验报告 §五 A 类，2026-08-20）：锚修订已直写落库（architecture-rules.md TR-AD-24 implementedBy → scheduler/SchedulerService.ts，updatedIn=iter-20260820-qhv8；kg rebuild 后 gc correctness=0 实证）——正式号 TR-AD-24 无撞号但正文零变化纯锚维护，按 desk 先例 discard 留审计痕，修正事实以现行文档为准，知识不丢失。

### TR-AD-21-r2
- changeType: 修改
- targetNode: TR-AD-21
- scope: GC 正确性类检出（gc 工具链缺陷手动补）
- project: helix
- reason: rotten-pointer ×2（活跃）：anchor → packages/protocol/src/events.ts（已拆为 events/ 八族，应改 events/index.ts）；anchor → packages/protocol/test/type-surface.test.ts（已拆为 type-surface/，应改 catalog.test.ts）。gc 因 id 判重误报未生成候选，手动纳入终验裁决
- evidence: kg gc_report（终验复跑）；packages/protocol/src/events/（8 文件）；packages/protocol/test/type-surface/（9 test + samples）
- sourceTask: verification/kg-inspection.md 追记（gc 未自动入账，验证报告 §七.1② 显式移交终验）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 A 类，2026-08-20）：锚修订已直写落库（TR-AD-21 anchors → events/index.ts + type-surface/catalog.test.ts，updatedIn=iter-20260820-qhv8）——正式号 TR-AD-21 与台账既有 applied 条目撞号，按 desk 先例 discard 留审计痕，修正事实以现行文档为准，知识不丢失。

### TR-AD-15-r2
- changeType: 修改
- targetNode: TR-AD-15
- scope: domain
- project: helix
- reason: 锚点跟随（正文零变化）：TR-AD-15 两符号锚半失效——DtoMapper.ts 已变为 18 行常设 barrel，isMainAxisEntry 定义迁 EntryDtoMapper.ts:34（经 barrel 仍可导入，锚半有效）、instanceChannels 为私有函数迁 SnapshotMapper.ts:139（锚导航失准）。修订：DtoMapper.ts#isMainAxisEntry → EntryDtoMapper.ts#isMainAxisEntry；DtoMapper.ts#instanceChannels → SnapshotMapper.ts#instanceChannels；其余锚不变。批次C 判正文一致（锚腐不影响语义）
- evidence: drafts/tr-audit-drafts.md 修订 3；EntryDtoMapper.ts:34（isMainAxisEntry）；SnapshotMapper.ts:139（instanceChannels，私有）；DtoMapper.ts 现 18 行 barrel
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driving/ws-server/EntryDtoMapper.ts#isMainAxisEntry；SnapshotMapper.ts#instanceChannels
- sourceTask: final-verification 全局审计（phase-architect agt_FN9T9KTS00W6，drafts/tr-audit-drafts.md 修订 3；批次C 附注同发现）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 A 类，2026-08-20）：锚修订已直写落库（TR-AD-15 两符号锚 → EntryDtoMapper.ts#isMainAxisEntry / SnapshotMapper.ts#instanceChannels）——正式号 TR-AD-15 与既有 applied 条目（TR-AD-15-revoke）撞号，按 desk 先例 discard 留审计痕，知识不丢失。

### TR-AD-1-r2
- changeType: 修改
- targetNode: TR-AD-1
- scope: domain
- project: helix
- reason: L3 语义复核判局部不一致：正文 application 子句「只依赖 domain 与自有 port」与现行守护口径不符——CL-5 裁决（T4.1，8059972）后 AG-02② 白名单固化为 {domain, 自有 port, @helix/protocol, node:path}（4 文件 import MAIN_INSTANCE_ID + ClosureRecorder import node:path）。按现文本执行会误判 5 处违规并与 AG-13 取源单源守护冲突。修改：依赖面枚举改「domain + 自有 port + @helix/protocol（MAIN_INSTANCE_ID 单源）+ node:path（ClosureRecorder 产物路径）」并注明以 AG-02② 白名单为准。四层结构/domain 零外依赖/禁 adapters/pi/组合根装配等核心约束全部成立
- evidence: docs/kg/architecture-rules.md:31；apps/daemon/test/arch-guard/arch-guard.test.ts:78-96（AG-02② 白名单）；git 8059972（CL-5 白名单化，晚于节点 updatedIn）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/{ChatService,RestoreService,SessionRegistry,SessionProjection}.ts（MAIN_INSTANCE_ID）；scheduler/ClosureRecorder.ts（node:path）；守护 arch-guard.test.ts:78 AG-02②
- sourceTask: final-verification L3 语义复核·规则面（批次B，phase-reviewer agt_KWBREVB1SE5Z；sedimentLedger 自动落账异常，MainAgent 手动补）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 B 类，2026-08-20）：L3 文本修正已直写落库（TR-AD-1 application 依赖面补 CL-5 白名单 @helix/protocol MAIN_INSTANCE_ID + node:path，注明以 AG-02② 为准）——正式号 TR-AD-1 与既有 applied 条目撞号，按 desk 先例 discard 留审计痕，知识不丢失。

### TR-AD-2-r5
- changeType: 修改
- targetNode: TR-AD-2
- scope: domain
- project: helix
- reason: L3 语义复核判两处子句漂移：①「PathsPort 定义后悬空待决」已过期——PathsPort 已被 F-7 删除（620fbe3，outbound/README.md:4 残留一次词面提及）；②四类落位枚举缺第五落位——SessionProjection（application service）自 T2.1 起 implements EventPublisherPort 作为 fan-out 投影目标（container.ts:377 装配），服务消费面 = 组合根内联 fanout（container.ts:198）。修改：PathsPort 句改「已删除（F-7）」；落位枚举补注 EventPublisherPort 的 application 侧投影实现。ports 接口纯度/双向结构/8 出口/≥9 守护全部核实成立
- evidence: docs/kg/architecture-rules.md:68；git 620fbe3（F-7 删 PathsPort）；SessionProjection.ts:61（implements EventPublisherPort）；container.ts:197-204,377-386；git e0e9ad1（T2.1 会话投影）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/ports/outbound/（现 8 port 无 PathsPort）；application/services/SessionProjection.ts:61；infrastructure/container.ts:198,377
- sourceTask: final-verification L3 语义复核·规则面（批次B，phase-reviewer agt_KWBREVB1SE5Z；sedimentLedger 自动落账异常，MainAgent 手动补）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 B 类，2026-08-20）：L3 文本修正已直写落库（TR-AD-2：PathsPort 句改「已删除（F-7）」+ 落位枚举补第五类 application service 投影实现 SessionProjection）——正式号 TR-AD-2 与既有 applied 条目撞号（r3/r4 先例同），按 desk 先例 discard 留审计痕，知识不丢失。

### TR-AD-6-r2
- changeType: 修改
- targetNode: TR-AD-6
- scope: domain
- project: helix
- reason: L3 语义复核判编辑事故：节点正文含两组完整四节——第二组（architecture-rules.md:229-238）为 T2.3 更新前旧版残留（08-16 更新时旧四节未删），旧版宣称 config.json 含 apiKeys 0600，与现行（apiKeys→auth.json、默认模型→default_model 表、模型目录→models-store.json）直接矛盾；kg 解析时旧版内容可能并入检索面产生第二事实源。修改：删除 229-238 旧版四节（第一组 217-226 与代码完全一致，保留）
- evidence: docs/kg/architecture-rules.md:229-238（旧版四节）；对照 paths.ts:22-24、container.ts:190-196、WriteQueue.ts:238-241、test/unit/{paths,config,auth-store}.test.ts 18/18 绿
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/infrastructure/paths.ts:21-24,51-53；infrastructure/auth-store.ts；pi-engine/model-catalog.ts
- sourceTask: final-verification L3 语义复核·规则面（批次B，phase-reviewer agt_KWBREVB1SE5Z；sedimentLedger 自动落账异常，MainAgent 手动补）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 B 类，2026-08-20）：编辑事故修正已直写落库（TR-AD-6 删除 T2.3 前旧版四节残留，消除第二事实源；新版四节保留）——正式号 TR-AD-6 与既有 applied 条目撞号，按 desk 先例 discard 留审计痕，知识不丢失。

### E-AgentInstance-r2
- changeType: 修改
- targetNode: E-AgentInstance
- scope: domain
- project: helix
- reason: L3 语义复核判两处不一致（文本+锚元数据，代码无改动需求）：①状态机口径失真——规则节把 stalled 列入状态机迁移目标，但 InstanceState 无 stalled（queued/running/done/failed/cancelled），agent.stalled 为可重复警示事件且状态保持 running（SchedulerService.ts:55「警示可重复推，不自动杀」；protocol agent.ts:33「非状态迁移」）。修改：改「queued{位次} → running → done/failed；stalled 为 running 态上的可重复警示事件（非状态迁移）」。②anchors 迁移未同步——computeAnchorEntryId/lastMainAnchorId/AnchorScanEntry 已自 DtoMapper.ts 迁 SpawnAnchor.ts（TR-AD-25④ 四域拆分）；SchedulerService.ts 路径已变 scheduler/ 子目录。其余主张（kill=failed 单一终态/重启清队 cancelled/PK(session_id,instance_id)/e{N} id 体系/daemon 权威计算）全部成立
- evidence: AgentInstance.ts:53,:10-14,:70-71；scheduler/SchedulerService.ts:55；packages/protocol/src/events/agent.ts:33；SpawnAnchor.ts:1-56；scheduler/SchedulerService.ts:136/:219；docs/kg/domain.md E-AgentInstance 节
- implementationStatus: 完整实现
- implementedCode: SpawnAnchor.ts:27-56 computeAnchorEntryId；AgentInstance.ts:53-77 InstanceState 状态机；scheduler/SchedulerService.ts:136/219 spawnAnchors/spawnAnchorOf
- sourceTask: final-verification L3 语义复核·实体面（批次A重派，phase-reviewer agt_5PS876EC5PVA；自动落账 id 判重失败，MainAgent 手动补）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 A/B 类，2026-08-20）：修正已直写落库（E-AgentInstance：状态机 stalled 改警示事件口径 + anchors 随迁 SpawnAnchor.ts/scheduler/）——正式号 E-AgentInstance 与既有 applied 条目撞号，按 desk 先例 discard 留审计痕，知识不丢失。

### E-HookSet-r2
- changeType: 修改
- targetNode: E-HookSet
- scope: domain
- project: helix
- reason: L3 语义复核判不一致：描述/规则两节宣称 shouldStopAfterTurn 为 HookSet 处理器槽位，但代码 HookSet 接口仅 name/bind/beforeToolCall/prepareNextTurn/transformContext，组合器仅三个，全仓零引用（仅 docs 命中；pi 侧钩子位存在但未接线）。「事件流处理器」实由 bind() 装配回调承载。修改：槽位清单收敛为实际面（beforeToolCall/prepareNextTurn/transformContext + bind 装配回调 + SteerCapable steer/abort 能力面），shouldStopAfterTurn 显式标注「pi 侧可用、helix 未接线」扩展位；**同源联动修正 TR-AD-4 正文槽位枚举**（architecture-rules.md:137 同表述）。代码无改动需求
- evidence: HookSet.ts:15-61；AgentRuntime.ts:65-67,:118-148；全仓 grep shouldStopAfterTurn → 仅 docs/kg/domain.md:71/:74、architecture-rules.md:137；pi-agent-core@0.84.2 dist/types.d.ts:191（钩子位存在未接线）
- implementationStatus: 完整实现
- implementedCode: HookSet.ts:15-61（HookSet 接口 + SteerCapable）；AgentRuntime.ts:52-70；hooks/{MinimalHooks,SteerHooks,CompactionHook}.ts
- sourceTask: final-verification L3 语义复核·实体面（批次A重派，phase-reviewer agt_5PS876EC5PVA；自动落账未持久化，MainAgent 手动补）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 B 类，2026-08-20）：修正已直写落库（E-HookSet 槽位清单收敛为实际面 + shouldStopAfterTurn 标注未接线扩展位；联动修正 TR-AD-4 正文同源槽位枚举）——正式号 E-HookSet，按 desk 先例 discard 留审计痕，知识不丢失。

### E-模型目录-r2
- changeType: 修改
- targetNode: E-模型目录
- scope: domain
- project: helix
- reason: L3 语义复核判单点低危不一致：描述节「304 未变更不落盘」与实现不符——refreshAll 刷新轮（含全 304）结束后无条件 persistStore 落盘（仅 checkedAt 元数据前移，4h 窗口跨重启所必需）；目录数据面「304 不重拉不丢失」成立。修改：「304 只挪 checkedAt（目录数据不变）；刷新轮统一 best-effort 落盘（含 checkedAt 元数据）」。其余主张全部成立
- evidence: model-catalog.ts（refreshAll 末行无条件 persistStore；304 分支只更新 checkedAt）；model-catalog.test.ts:178-198；node 实测 MODELS 静态键=39
- implementationStatus: 完整实现
- implementedCode: model-catalog.ts：ModelCatalog.refreshAll/refreshProvider（304 分支）/persistStore（tmp+rename 原子写）
- sourceTask: final-verification L3 语义复核·实体面（批次A重派，phase-reviewer agt_5PS876EC5PVA；自动落账未持久化，MainAgent 手动补）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 B 类，2026-08-20）：修正已直写落库（E-模型目录：304 落盘语义改「只挪 checkedAt + 刷新轮统一 best-effort 落盘」）——正式号 E-模型目录 与既有 applied 条目撞号（2026-08-17 新增条目），按 desk 先例 discard 留审计痕，知识不丢失。

### TR-AD-26-r2
- changeType: 修改
- targetNode: TR-AD-26
- scope: domain
- project: helix
- reason: TR-AD-26 ②律实现证据补充：node 直跑脚本引用 workspace TS 包时包入口无扩展名 re-export 无法解析（node 24 type-stripping），落地为直读自包含源文件（envelope.ts）import。建议在 TR-AD-26 规则②补一句实现注记（锚 perf-a11y-audit.mjs#V 已在场）
- evidence: commit 279713c；scripts/perf-a11y-audit.mjs:23,30
- implementationStatus: 完整实现
- implementedCode: scripts/perf-a11y-audit.mjs:23,30
- sourceTask: development/kg-sediment-backlog.md A1（task-T2.2-report deviation）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 C 类 A1，2026-08-20）：知识沉淀已直写落库（TR-AD-26 ②律补 node 直跑脚本实现注记：优先 import 自包含单文件源）——正式号 TR-AD-26 与既有 pending gc 条目同节点，按 desk 先例 discard 留审计痕，知识不丢失。

### TR-AD-23-r2
- changeType: 修改
- targetNode: TR-AD-23
- scope: domain
- project: helix
- reason: TR-AD-23②「契约版本一次定形」例证链补 v0.5 批次：payload 形状全量回迁正文 + §14 微批字段定形 + SoT 五断言同批（iter-20260820-qhv8）。正文例证追加属语义变化，留人审裁决
- evidence: commits b141211 + 2280c93；evidence/dev/T2.3/
- implementationStatus: 完整实现
- implementedCode: packages/protocol/PROTOCOL.md §15/§16/§17；packages/protocol/test/type-surface/sot-consistency.test.ts
- sourceTask: development/kg-sediment-backlog.md A2（task-T2.3-report sediment）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 C 类 A2，2026-08-20）：知识沉淀已直写落库（TR-AD-23 ②律例证链补 v0.5 批次：payload 全量回迁 + §14 微批定形 + 五断言同批）——正式号 TR-AD-23 与既有 applied 条目撞号（erio 条目），按 desk 先例 discard 留审计痕，知识不丢失。

### SPEC-iter-20260820-qhv8-1
- changeType: 新增
- scope: domain
- project: helix
- reason: 解环验证纪律（建议新 TR-TEST-7）：循环依赖解环时回边常为 import type（编译期擦除、运行时不构成环但静态面是环）；验证工具必须统计 type import 且先做阳性对照（以已知环复现确认灵敏度，再宣称消环）。T3.2 实证；下迭代 madge 常设挂接（优化池 N2）时为直接消费点
- evidence: evidence/dev/T3.2/madge-circular.md（三环复现→F-8 消失/F-11 仍在）；evidence/regression/10-madge-circular.txt
- implementationStatus: 完整实现
- implementedCode: evidence/dev/T3.2/madge-circular.md；bunx madge --circular --extensions ts
- sourceTask: development/kg-sediment-backlog.md B1（task-T3.2-report）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 C 类 B1，2026-08-20）：正式号签发 TR-TEST-7（循环依赖解环验证纪律：type 回边统计 + 阳性对照先行），已经 project_write_tech_rules 落库 testing-rules.md（INDEX 已注册，kg nodes=45 实证）——临时号候选按流程 discard 归档，知识不丢失。

### TR-TEST-2-r3
- changeType: 修改
- targetNode: TR-TEST-2
- scope: domain
- project: helix
- reason: 守护面随被守护代码迁移原则（建议 TR-TEST-2 补⑤条）：源码路径字符串型守护断言（如 session-projection 零聚合写守护直读源码断言）在守护对象拆分时必须随迁扩展至全部产物（守护面 = 目录全部产物），防拆分绕过守护。T3.3 实证：事件翻译逻辑拆出后守护圈扩 scheduler/ 三文件，否则「只产事件不写聚合」对 translator 失效——守护语义跟随被守护代码，而非跟随文件名
- evidence: git 17b97f1 -- apps/daemon/test/integration/session-projection.test.ts
- implementationStatus: 完整实现
- implementedCode: apps/daemon/test/integration/session-projection.test.ts（守护面随 scheduler/ 三文件扩展）；apps/daemon/test/unit/structure.test.ts
- sourceTask: development/kg-sediment-backlog.md B2（task-T3.3-report sediment）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 C 类 B2，2026-08-20）：知识沉淀已直写落库（TR-TEST-2 补⑤守护面随迁条 + anchors 补 arch-guard/session-projection）——正式号 TR-TEST-2 与 discarded 历史条目（TR-TEST-2-r2）撞号，按 desk 先例 discard 留审计痕，知识不丢失。

### TR-TEST-6-r2
- changeType: 修改
- targetNode: TR-TEST-6
- scope: domain
- project: helix
- reason: TR-TEST-6 补 EVIDENCE_DIR 迭代感知三态契约（锚+一句正文）：env HELIX_EVIDENCE_ITER 优先 → git 分支 dev-<iterId> → 报错兜底（无静默兜底）；工作区根向上查 docs/iterations 祖先穿透 .worktrees。TMPDIR 预检排除表白名单化不弱化检出力。正文已隐含覆盖，纯锄补充+一句契约声明可 apply
- evidence: commits 5710f88/a5b7072；双向验证证据在 task-T4.2-report
- implementationStatus: 完整实现
- implementedCode: e2e/harness/evidence.ts（三态解析单点）；e2e/harness/tmp-hygiene.ts:30（前缀白名单）；.github/workflows/ci.yml（upload 跟随面）
- sourceTask: development/kg-sediment-backlog.md B3（task-T4.2-report sediment ×2）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 C 类 B3，2026-08-20）：知识沉淀已直写落库（TR-TEST-6 补 EVIDENCE_DIR 三态契约段 + anchors 补 evidence.ts）——正式号 TR-TEST-6，按 desk 先例 discard 留审计痕，知识不丢失。

### TR-AD-25-r2
- changeType: 修改
- targetNode: TR-AD-25
- scope: domain
- project: helix
- reason: TR-AD-25 孤儿节点补挂 governs 边（候选：E-调度器/E-会话聚合/E-领域事件与单写队列——本批四拆分产物所在域）+ derivedFrom F-9 计数更正（16 个 → 收口复测 20 .ts + 2 .tsx，热修批后测试自然增长所致，T4.3 复测与 T4.1 实测恰等）
- evidence: docs/kg/architecture-rules.md TR-AD-25（governs 空）；evidence/regression/09b-size-pool-recheck.txt（20 .ts 与 T4.1 实测恰等）
- implementationStatus: 完整实现
- implementedCode: scripts/audit-assert.ts；.github/workflows/ci.yml；scheduler//handlers//events//type-surface/ 四拆分产物
- sourceTask: verification/kg-inspection.md §三（orphan 建议补挂 governs 边）+ development/optimization-opportunities.md §6（F-9 计数更正）
- createdIn: iter-20260820-qhv8
- decisionLog: 终验决策（用户批准终验报告 §五 C 类，2026-08-20）：修正已直写落库（TR-AD-25 补挂 governs 三边消除 orphan——kg rebuild 后 hygiene=0 实证 + derivedFrom 补 F-9 计数更正条 + ③律计数同步 20+2）——正式号 TR-AD-25，按 desk 先例 discard 留审计痕，知识不丢失。

### SPEC-iter-20260821-dg90-2
- changeType: 修改
- targetNode: TR-AD-1
- scope: infrastructure 组合根装配面
- project: helix
- reason: T2.3 组合根装配形态显式化：生产 DaemonOptions 瘦身四字段 vs TestDaemonOptions 十五字段两形态分离；assembleDaemon 共享装配核心 + EngineAssemblyMode 显式联合消灭「engine===undefined 即生产」隐式分支。TR-AD-1 修订已覆盖锚面扩 assembly/，本候选补「生产/测试两形态 + 显式模式联合」条款（可能与本迭代 TR-AD-1 修订部分重叠，人审可判冗余 discard）
- evidence: evidence/green-t2-3-test-daemon-factory.md；evidence/red-t2-3-explicit-mode.md；arch-guard explicit-mode 8 断言常驻
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/infrastructure/container.ts（assembleDaemon）；apps/daemon/test/helpers/createTestDaemon.ts
- sourceTask: T2.3（终验 C1 补登）
- createdIn: iter-20260821-dg90
- decisionLog: 终验决策（用户批准终验报告 §五「按建议执行」，2026-08-22）：discard——组合根生产/测试两形态 + EngineAssemblyMode 条款已被本迭代 TR-AD-1 修订覆盖（适用范围含「DaemonOptions 生产/测试形态（createTestDaemon）」、反例含「测试注入口写回生产 DaemonOptions=H2.3 两形态分离违例」），重复记录即双轨风险。注：候选提的「两形态接口模式」一般化部分已由 SPEC-iter-20260821-dg90-12（TR-AD-31）承载。

### TR-AD-36（hotfix-20260822）
- changeType: 新增
- scope: docs/kg/architecture-rules.md（技术规则新增）+ docs/kg/decisions.md（AD-1 hotfix-20260822 决策档案）
- project: helix
- reason: H-3 落地 P0-1 留白形成可复用新模式：daemon 进程内共享单例资源（CDP）不向子进程扩散实现，子进程经 BrowserPort 进程外实现（RemoteBrowserPort）+ wire tool-req/tool-res 帧转发，daemon 侧 ScopedBrowserProxy 纯函数收口归属校验（ownerId 强制=instanceId/tabId 归属拒绝/listTabs 过滤/管理面 4 方法不上 wire 有意收窄）；ownerId 单命名空间=agentId（"main"=MAIN_INSTANCE_ID 保留值）；lazy connect 调用方无关（SubAgent 首发可拉起，主线幂等复用）；并发靠归属校验不靠队列；截图路径过 IPC 图片体不过。BrowserPort.getStatus/listTabs async 化（远程化适配）。DAG 演进兼容存档（ownerId→nodeId 直用）。用户四轮裁决全文入 decisions.md AD-1（hotfix-20260822）。
- evidence: H-3 闭环（task-h3-subagent-cdp；daemon 791/791 + shell 385/385 + tsc 零错 + E 层锚面 8/8；commit ee12e17）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/subagent/child/RemoteBrowserPort.ts；adapters/driven/subagent/ScopedBrowserProxy.ts；adapters/driven/subagent/transport/wire.ts；adapters/driven/subagent/SubagentLauncher.ts；adapters/driven/subagent/child/ChildMain.ts
- sourceTask: H-3 SubAgent 接入 CDP（设计 design-subagent-cdp.md + 用户两轮裁决，2026-08-22）
- createdIn: hotfix-20260822
- decisionLog: 用户裁决「一起沉淀吧」（2026-08-22）——直写落盘（formalId=TR-AD-36，节点 id 稳定；提案全文 docs/temp/development/kg-sync-proposal-h123.md）

### TR-AD-35-r2（hotfix-20260822）
- changeType: 修改
- targetNode: TR-AD-35
- scope: docs/kg/architecture-rules.md TR-AD-35（规则段前置自检面扩展 + sidecar 父死看门狗义务；反例段补两条；anchors 补 parent-watchdog/dev-desktop 测试锚）
- project: helix
- reason: H-1 前置自检面扩展：cargo/rustc 一行提示 + rg 存在性检查（缺失自动 fetch-rg 幂等补，失败警告不阻塞）；tauri dev --config override 剥离 bundle 资源生产校验（RFC 7386 实测：数组覆盖成立、resources 必须 [] 非 {}、v2 格式无 tauri 包装键）；vite 端口覆盖位 devUrl 随动（修 F4.2 既有隐患：tauri dev 空等默认 5173 至 180s 超时退出）。H-4 sidecar 父死看门狗：壳异常死亡（Ctrl+C 前台组广播秒杀/SIGKILL/崩溃）时 sidecar reparent 成 pid 1 孤儿持锁常驻砖化下次启动（用户 100% 复现实证）；sidecar 形态周期判 ppid==1 → SIGTERM 同路径优雅关停；契约 sidecar-lifecycle.md §3 补款同步。
- evidence: H-1（dev-desktop 17/17 + scripts 35/35 + 干净态端到端冒烟；commit 211b6d2）；H-4（unit 4/4 + 集成真孤儿化先红后绿 + daemon 791/791；工作区未提交）
- implementationStatus: 完整实现
- implementedCode: scripts/dev-desktop.ts；scripts/dev-desktop.test.ts；apps/daemon/src/infrastructure/parent-watchdog.ts；apps/daemon/src/main.ts
- sourceTask: H-1 dev-desktop 前置体验热修（iter-20260822-m1uc 已决策待办）+ H-4 sidecar 孤儿持锁砖化修复（2026-08-22）
- createdIn: hotfix-20260822
- decisionLog: 用户裁决「一起沉淀吧」（2026-08-22）——直写落盘（formalId=TR-AD-35，节点 id 稳定）

### AD-1-M3-补记（hotfix-20260822）
- changeType: 修改
- targetNode: 无（decisions.md AD-1「聚合/窗口三层模型与尾窗快照」结局段补记——AD-N 非图节点，不产生 kg 节点变更）
- scope: docs/kg/decisions.md AD-1（M3）结局段
- project: helix
- reason: H-2 用户裁决：加载更早触发面 = 分页胶囊点击（滚动到顶自动触发退役——scrollTop<=0 吃橡皮筋过冲/短内容恒 0/程序化落顶自触发三重误触发，且为 e2e beforeCount 竞态源头 OI-VER-1④）；会话切换恒贴底 + 锚定基线随 sessionId 重置（前插补偿只吃同会话高度）。分页数据面（AD-1 主体口径）不变。
- evidence: H-2 闭环（task-h2-chat-loadmore；shell 385/385 + F 层 e2e 128/129（唯一失败为基线既挂 CL-4 F3.4，stash 对照实证）+ E 层 CL-1 多会话真 daemon 通过；commit 47bb1fa）
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/widgets/chat-stream/ui/MessageFlow.tsx；apps/shell/src/widgets/chat-stream/ui/MessageFlow.test.tsx
- sourceTask: H-2 chat 加载更多热修（2026-08-22）
- createdIn: hotfix-20260822
- decisionLog: 用户裁决「一起沉淀吧」（2026-08-22）——直写落盘（决策档案补记，无图节点变更）

### AD-1（hotfix-20260823）
- changeType: 新增
- targetNode: 无（decisions.md 决策档案条目——AD-N 非图节点，不产生 kg 节点变更；TR-AD-37/38/39 derivedFrom 指向本条目）
- scope: docs/kg/decisions.md AD-1（hotfix-20260823：SubAgent 编排推送闭环与过程监督）
- project: helix
- reason: 2026-08-23 多会话实测暴露四问题（SteerHooks 共享串台/轮询与抢跑/裸 user 文本注入/aborting 丢 closure）；用户四轮裁决定案：不加 wait 工具、否决 wall-clock timeout、系统只送达信息永不自动终止、提示词换正向契约、closure 送达补齐
- evidence: T1+T2+T3 闭环（daemon 816/816 + tsc 零错 + default-reviewer 独立评审通过；commit dc2a120/88a50d2/3318d01）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/runtime/AgentProfile.ts；AgentRuntime.ts；application/services/ChatService.ts；application/services/scheduler/SchedulerService.ts；SubagentEventTranslator.ts
- sourceTask: T1/T2/T3（SubAgent 实现 + MainAgent 同步提案，2026-08-23）
- createdIn: hotfix-20260823
- decisionLog: 用户裁决「落吧」（2026-08-23）——直写落盘（决策档案条目，无图节点变更）

### TR-AD-37（hotfix-20260823）
- changeType: 新增
- targetNode: TR-AD-37
- scope: docs/kg/architecture-rules.md TR-AD-37（AgentProfile hooks = HookCtor 构造器引用声明 + 装配点实例化）
- project: helix
- reason: P0 串台根因教训：SteerHooks.bind 携带 agent 引用，模块级共享 hooks 实例被后建会话 bind 覆盖 → steer/abort 注入错误会话（实测双 session 交叉注入直证）；工厂方案被 AG-10 守护否决，最终形态 = 类引用纯数据声明 + AgentRuntime 装配点 new——守护零改动即绿；新 HookSet 须提供 static readonly hookName（快照读面经 H.hookName，H.name 是类名语义禁用）
- evidence: T1 闭环（profile-hooks-isolation 3/3 同一常量 profile 双 runtime 断言不串台；daemon 816/816 + tsc 零错；commit dc2a120）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/runtime/AgentProfile.ts（HookCtor）；AgentRuntime.ts（装配点实例化）；SteerHooks.ts/MinimalHooks.ts（static hookName）；MainSessionProfile.ts/SubAgentProfile.ts（类引用声明）
- sourceTask: T1（SubAgent 实现 + MainAgent 同步提案，2026-08-23）
- createdIn: hotfix-20260823
- decisionLog: 用户裁决「落吧」（2026-08-23）——直写落盘（formalId=TR-AD-37，节点 id 稳定）

### TR-AD-38（hotfix-20260823）
- changeType: 新增
- targetNode: TR-AD-38
- scope: docs/kg/architecture-rules.md TR-AD-38（closure 送达保证：aborting 暂存 + idle 链式 flush）
- project: helix
- reason: 推送模型前提「closure 保证送达」在 aborting 分支破窗（直丢）；修复形态与时序窗口教训：agent_end 同步回流段内 idle 已置但引擎 promise 未 settle（在飞守卫），flush 必须挂 dying run promise settle 后逐条链式执行；closure 一律顶层新 turn 送达不并入 steer 队列；stopped 维持可观测丢弃（落盘恢复语义已覆盖）
- evidence: T2 闭环（chat-service-closure-flush 6/6 含 FIFO 保序/抢占续送/红态复现 4fail→绿；commit 88a50d2）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/ChatService.ts（closureBuffer/scheduleClosureDrain/drainClosureBuffer）
- sourceTask: T2（SubAgent 实现 + MainAgent 同步提案，2026-08-23）
- createdIn: hotfix-20260823
- decisionLog: 用户裁决「落吧」（2026-08-23）——直写落盘（formalId=TR-AD-38，节点 id 稳定）

### TR-AD-39（hotfix-20260823）
- changeType: 新增
- targetNode: TR-AD-39
- scope: docs/kg/architecture-rules.md TR-AD-39（SubAgent 过程监督契约：周期进展报告机械Δ + agent_inspect + 永不自动终止）
- project: helix
- reason: 死循环检测的结构性盲区（stalled 只抓零事件，事件流不断但无进展抓不到；wall-clock timeout 误杀长任务）→ 裁决权归 MainAgent/用户；四件套：reportIntervalMs 周期注入一行机械 Δ 信封（injectClosure 同通道）/ translator 计数器与 20 容量轨迹环缓冲 / agent_inspect 核实工具 / 提示词正向契约（结束回合+自动注入+不轮询不抢跑+零增量 inspect 核实）；机械 Δ 防 compaction 丢判定依据；缺省关闭防监督成本无差别摊派
- evidence: T3 闭环（scheduler-progress-report 8/8 + agent-inspect 6/6 + main-prompt-contract 2/2；commit 3318d01）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/scheduler/SchedulerService.ts（定时器+信封+四点清理）；SubagentEventTranslator.ts（计数器+环缓冲）；AgentOrchestrationPort.ts（inspect）；AgentOrchestrationTools.ts（agent_inspect 工具）；MainSessionProfile.ts（正向契约提示词）
- sourceTask: T3（SubAgent 实现 + MainAgent 同步提案，2026-08-23）
- createdIn: hotfix-20260823
- decisionLog: 用户裁决「落吧」（2026-08-23）——直写落盘（formalId=TR-AD-39，节点 id 稳定）

### AD-2（hotfix-20260823）
- changeType: 新增
- targetNode: 无（decisions.md 决策档案条目——AD-N 非图节点，不产生 kg 节点变更；E-AgentInstance-r3 描述/规则段 derivedFrom 指向本条目）
- scope: docs/kg/decisions.md AD-2（hotfix-20260823：spawn 锚取值反转与出窗语义确认）
- project: helix
- reason: 用户实测显示 bug 考古裁决：双轨 = 契约 v0.3 §1 一次性有意设计（非迭代残留），规则①优先两承重理由（确定性权威 + 重启恢复边界）不失效；T2.1「锚落工具卡 = 语义错误」刻意判断是 bug 根源（避开 toolCall 致锚落更早用户消息），实测反转成立（T6 钉值 = agent_spawn 工具调用 id）；出窗兑底否掉——聊天流卡片 = 历史锚点标记，运行态归 DrawerRail 活跃事件条，出窗不渲染为正确产品行为
- evidence: T7-explore 考古报告（git log -S 实证双轨同 commit edfe3cd 落地 + 契约原文引用）+ T6 闭环（spawn-anchor 测试先红后绿；daemon 818/818 + tsc 零错；commit d836470）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/infrastructure/container.ts#computeSpawnAnchor（扫描面补 toolCall 记录）
- sourceTask: T6/T7-explore（SubAgent 实现 + MainAgent 同步提案，2026-08-23）
- createdIn: hotfix-20260823
- decisionLog: 用户裁决「落吧」（2026-08-23）——直写落盘（决策档案条目，无图节点变更）

### E-AgentInstance-r3（hotfix-20260823）
- changeType: 修改
- targetNode: E-AgentInstance
- scope: docs/kg/domain.md E-AgentInstance（描述段 spawn 锚语义双规则精确化 + 规则段出窗语义再确认 + anchors 补 container.ts#computeSpawnAnchor + updatedIn）
- project: helix
- reason: T6 后 spawn 钉值语义变化（扫描面含 toolCall 记录，钉值 = agent_spawn 工具调用 id）需与规则①快照语义并录；出窗不渲染语义获用户 2026-08-23 再确认（卡片 = 历史锚点标记，运行态归 DrawerRail，翻页反应式归位）——原文「运行中实例感知归抽屉全量列表」语义不变仅精确化
- evidence: commit d836470（T6）+ 用户裁决对话（2026-08-23）
- implementationStatus: 完整实现
- implementedCode: packages/protocol/src/projection/instance.ts#computeAnchorEntryId；apps/daemon/src/infrastructure/container.ts#computeSpawnAnchor
- sourceTask: T6/T7-explore（SubAgent 实现 + MainAgent 同步提案，2026-08-23）
- createdIn: hotfix-20260823
- decisionLog: 用户裁决「落吧」（2026-08-23）——直写落盘（formalId=E-AgentInstance，节点 id 稳定）

### TR-AD-40-r2（iter-20260823-6ps5）
- changeType: 修改
- targetNode: TR-AD-40
- scope: docs/kg/architecture-rules.md TR-AD-40（AD-1 落点二 + §3.5 注入器装配点 2 锚点回填）
- project: helix
- reason: T1.3 闭环 sediment：SubagentLauncher.resolveThinkingFor 两级链（profile.thinkingLevel ?? medium，launch 段唯一消费点）+ HELIX_THINKING_LEVEL env 定格透传 + deps.profile 扩 getter 注入源形态（组合根把 resource_state subagent-worker 槽位折叠进 profile 读面，静态声明优先）；主会话覆盖零读面红线以依赖类型机械保证；model-provider 新增 supportsThinkingLevel/wrapStreamFnThinking 纯透传注入器，包装在 streamFnOverride 外侧（fake 剧本通道不破坏）
- evidence: test/unit/subagent-thinking-chain.test.ts 6 用例 + test/integration/subagent-child.test.ts 真子进程 4 用例（xhigh/medium 捕获 options.reasoning）+ model-provider.test.ts 6 新用例全绿
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts#resolveThinkingFor; apps/daemon/src/infrastructure/assembly/buildSessionStack.ts#deps.profile getter; apps/daemon/src/adapters/driven/pi-engine/model-provider.ts#supportsThinkingLevel/wrapStreamFnThinking; apps/daemon/src/adapters/driven/pi-engine/PiAgentEngineAdapter.ts#resolveThinking 选项; apps/daemon/src/adapters/driven/subagent/child/ChildMain.ts#HELIX_THINKING_LEVEL
- sourceTask: T1.3（SubAgent sediment + MainAgent 补录，2026-08-23；submit_result sedimentLedger 落账故障经 ISSUE-kg-propose-path 记录）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #3，2026-08-24）：内容已并入同节点合并落块（TR-AD-40 anchors 扩含 r2 全部增量：SubagentLauncher.resolveThinkingFor/ChildMain HELIX_THINKING_LEVEL/model-provider 注入器/buildSessionStack getter，testedBy 含 subagent-thinking-chain/subagent-child/model-provider）——本条 discard 留审计痕，知识不丢失（合并块已承载），decisionLog 见 TR-AD-40 applied 条目。

### TR-AD-40-r3（iter-20260823-6ps5）
- changeType: 修改
- targetNode: TR-AD-40
- scope: docs/kg/architecture-rules.md TR-AD-40（AD-1 落点一 + AD-3 解析链/观测面锚点回填）
- project: helix
- reason: T1.2 闭环 sediment：主会话解析链 [引擎覆盖（回读自引用闭包）, main-session 槽位, 兜底 medium] → resolveEffectiveThinking 能力过滤 clamp（装配于 buildSessionStack engineFor 生产组合根，注入器复用 T1.3 wrapStreamFnThinking，包装在 streamFnOverride 外侧）；观测面 currentThinking {override, effective} 双位（意图/生效分离）
- evidence: thinking-set-chain.test.ts「覆盖 → 生效档钳制 → 换模无损」断言序列绿；生产组合根接线用例绿（TR-TEST-5）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/thinking-resolve.ts:24#resolveEffectiveThinking; apps/daemon/src/adapters/driven/pi-engine/PiAgentEngineAdapter.ts:184#currentThinking; apps/daemon/src/application/ports/outbound/AgentEnginePort.ts:153#AgentThinkingState; apps/daemon/src/infrastructure/assembly/buildSessionStack.ts#engineFor
- sourceTask: T1.2（SubAgent sediment + MainAgent 补录，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #4，2026-08-24）：内容已并入同节点合并落块（TR-AD-40 规则正文补 resolveEffectiveThinking clamp 单点 + currentThinking 双位观测面 + thinking-resolve.ts/AgentEnginePort.ts anchors + thinking-set-chain testedBy）——本条 discard 留审计痕，知识不丢失，decisionLog 见 TR-AD-40 applied 条目。

### TR-AD-41-r2（iter-20260823-6ps5）
- changeType: 修改
- targetNode: TR-AD-41
- scope: docs/kg/architecture-rules.md TR-AD-41（AD-4①③ 主会话命令族 + 跨冷恢复锚点回填）
- project: helix
- reason: T1.2 闭环 sediment：AD-4① thinking.set 主会话全链（handlers/thinking.ts → ModelService/ChatService → AgentEnginePort 扩面 → PiAgentEngineAdapter → AgentRuntime → domain_events 单写队列落盘 → thinking.changed 广播；per-session 直改命令族同构模板第二次实例化）；AD-4③ RestoreService.restoreThinkingOverride 只读回放末值（零新事件流铁律）→ buildRuntime 直写引擎内存（绕过发布面）+ SessionStateView additive thinking 字段；与 model.set 不恢复差异负断言钉死
- evidence: thinking-set-chain.test.ts 全链绿（含错误先例 invalid_payload/session.not_found）；thinking-restore.test.ts 两条绿（model 负断言 + 零新事件流行数断言 + 多次覆盖末值断言）
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driving/ws-server/handlers/thinking.ts:17; apps/daemon/src/application/services/ModelService.ts:87; apps/daemon/src/application/services/ChatService.ts:175; apps/daemon/src/adapters/driven/pi-engine/runtime/AgentRuntime.ts:139; apps/daemon/src/adapters/driven/pi-engine/PiAgentEngineAdapter.ts:171; apps/daemon/src/application/services/RestoreService.ts:156#restoreThinkingOverride; apps/daemon/src/application/services/SessionRegistry.ts:465+621; apps/daemon/src/infrastructure/assembly/buildSessionStack.ts:375
- sourceTask: T1.2（SubAgent sediment + MainAgent 补录，2026-08-23；submit_result 自动落账故障见 ISSUE-kg-propose-path）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #5，2026-08-24）：内容已并入同节点合并落块（TR-AD-41 规则正文补 thinking.set 全链锚定 + restoreThinkingOverride 回放末值零新事件流 + 同构模板第二次实例化表述；anchors 扩 handlers/thinking.ts/ModelService/ChatService/SessionRegistry/buildSessionStack/events/agent.ts，testedBy 扩 thinking-set-chain/thinking-restore/type-surface/thinking）——本条 discard 留审计痕，知识不丢失，decisionLog 见 TR-AD-41 applied 条目。

### TR-AD-42-r2（iter-20260823-6ps5）
- changeType: 修改
- targetNode: TR-AD-42
- scope: docs/kg/architecture-rules.md TR-AD-42 anchors.implementedBy 增补一行（规则正文不变）
- project: helix
- reason: T3.2 闭环 sediment：能力位驱动 UI 规则锚点补全——features/thinking-level（ui + model 全目录）为首个完整实例化
- evidence: evidence/CL-1-fidelity-checklist.md 横切项「能力位 mock 矩阵」；bun run test:shell 446 全绿；E2E CL-1-thinking-* 5/5 绿
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/features/thinking-level/
- sourceTask: T3.2（SubAgent sediment + MainAgent 补录，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #7，2026-08-24）：内容已并入同节点合并落块（TR-AD-42 anchors.implementedBy 含 features/thinking-level 全目录 + 规则正文补「首个完整实例化」表述）——本条 discard 留审计痕，知识不丢失，decisionLog 见 TR-AD-42 applied 条目。

### E-AgentProfile-r3（iter-20260823-6ps5）
- changeType: 修改
- targetNode: E-AgentProfile
- scope: docs/kg/domain.md E-AgentProfile + E-智能体配置资源（AD-6 thinkingLevel 可选维落地锚点回填）
- project: helix
- reason: T1.3 闭环 sediment：AgentProfile + 可选 thinkingLevel（纯声明）+ 配置资源 7 步链（ResourceType+"thinking" 槽位型 / WriteQueue 通用 slotValue 原子替换 job / ResourceStateStore / ResourceService 三态 / protocol DTO v0.11 批内补登（M6 T4 先例，版本位未再 bump）/ resource.ts handler 零校验透传 / EventStream 广播）；kind 维合取不传染、缺省无记录=未配置语义不变（负断言守护）
- evidence: resource-service.test.ts 3 新用例 + resource-state.test.ts④ + agent-config-ws.test.ts⑫ 全绿
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/runtime/AgentProfile.ts#thinkingLevel; application/ports/outbound/ResourceStatePort.ts; adapters/driven/sqlite-session/WriteQueue.ts#slotValue; adapters/driven/sqlite-session/ResourceStateStore.ts; application/services/ResourceService.ts; packages/protocol/src/events/agent.ts#AgentConfigProfileBlock; packages/protocol/src/commands.ts#resourceType
- sourceTask: T1.3（SubAgent sediment + MainAgent 补录，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #8，2026-08-24）：修正已直写落库（E-AgentProfile 节点经 project_write_domain 直写——描述补配置资源 7 步链 + thinking 槽位读写面，anchors 扩 ResourceService/ResourceStateStore/ResourceStatePort/WriteQueue/protocol events+commands 共 6 处）——formalId=E-AgentProfile 与既有台账 applied 条目（iter-20260816-uzvg「### E-AgentProfile」）撞号无法二次 apply，按 desk 先例直写落盘 + 本条 discard 留审计痕，修正事实以现行 domain.md 为准，知识不丢失。与 E-AgentProfile-r4 同批直写。

### E-AgentProfile-r4（iter-20260823-6ps5）
- changeType: 修改
- targetNode: E-AgentProfile
- scope: docs/kg/domain.md E-AgentProfile（AD-6 shell 消费面锚点回填）
- project: helix
- reason: T2.2 闭环 sediment：AD-6 的 shell 读写面落地——读 = agent.config list.result profiles[].thinkingLevel（null → unset ghost）；写 = set_enabled resourceType="thinking" 槽位语义（set=档位字符串透传；clear=name "-" enabled=false），applied 等 changed 广播 revision 重拉收口；kind 维合取语义不变。另 AD-2/AD-5 的 P-2 表达：字段零档位校验原样透传；canonical 序仅作展示位镜像（thinking-resolution.ts，spawn 解析权威在 daemon）；ThinkingLevelSlider 双消费位落地（props 契约零改动，PEAK 同一 .peak class）
- evidence: AgentPage.test.tsx P-2 ①~⑥ + thinking-resolution.test.ts 七例 + thinking-level.css.test.ts 字段壳断言；test:shell 437 全绿
- implementationStatus: 完整实现
- implementedCode: apps/shell/src/pages/skills/ui/P-2-ThinkingField.tsx; apps/shell/src/pages/skills/AgentPage.tsx:185-191; apps/shell/src/pages/skills/model/agent-config-model.ts#pendingKeyOf; apps/shell/src/features/thinking-level/model/thinking-resolution.ts; apps/shell/src/shared/ui/styles/workbench.css:644#.tl-box.peak
- sourceTask: T2.2（SubAgent sediment + MainAgent 补录，2026-08-23；submit_result 自动落账故障见 ISSUE-kg-propose-path）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #9，2026-08-24）：修正已直写落库（E-AgentProfile 节点直写——描述补 shell 读写面（set_enabled thinking 槽位语义 + applied 收口 + 刻度能力位驱动），anchors 扩 P-2-ThinkingField/AgentPage/agent-config-model/thinking-resolution 共 4 处）——撞号直写先例同 E-AgentProfile-r3，知识不丢失，修正事实以现行 domain.md 为准。

### E-模型目录（iter-20260823-6ps5）
- changeType: 修改
- targetNode: E-模型目录
- scope: docs/kg/domain.md E-模型目录（AD-4② CatalogModel 防腐能力位映射锚点回填）
- project: helix
- reason: T1.3 闭环 sediment：model-catalog snapshot() 防腐映射单点 reasoning 直透 + thinkingLevels = pi-ai getSupportedThinkingLevels(model).filter(≠"off")（canonical 升序与缺席键规则保持 pi-ai SoT；helix 不引入 off 语义）；handlers/model.ts 两处 T1.1 保守占位移除、真实映射接通
- evidence: test/unit/model-catalog.test.ts 三变体（full/tri/none）+ ws-server-spy.test.ts 直透断言全绿
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/model-catalog.ts#snapshot; apps/daemon/src/application/ports/outbound/ModelCatalogPort.ts#CatalogModelView; apps/daemon/src/adapters/driving/ws-server/handlers/model.ts
- sourceTask: T1.3（SubAgent sediment + MainAgent 补录，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #10，2026-08-24）：修正已直写落库（E-模型目录 直写——描述补 thinking 能力位防腐段（snapshot() reasoning 直透 + thinkingLevels = getSupportedThinkingLevels 滤 off、pi-ai SoT），规则补派生公式单点条款，anchors 扩 ModelCatalogPort/handlers/model.ts + testedBy ws-server-spy）——formalId=E-模型目录 与既有 applied 条目（iter-20260816-6q6f「### E-模型目录」）撞号，按 desk 先例直写落盘 + discard 留审计痕，知识不丢失。

### E-AgentInstance-r4（iter-20260823-6ps5）
- changeType: 修改
- targetNode: E-AgentInstance
- scope: docs/kg/domain.md E-AgentInstance（AD-4④ agent.instantiated 携带 thinkingLevel 锚点回填）
- project: helix
- reason: T1.3 闭环 sediment：agent.instantiated 落盘事件携带 thinkingLevel（domain payload 可选字段；SchedulerService.spawn 签名不扩，经 subagentSnapshotFor 组装回调 {profileSnapshot, thinkingLevel} 同源同时点供给；只落盘不广播语义不变）；边界：主实例 instantiated 在 T1.2 主会话链落地前不携带，后续可将 domain 侧收窄必填对齐（feedback F-3）
- evidence: subagent-thinking-chain.test.ts 末组发布面 spy 断言全绿
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/scheduler/SchedulerService.ts#spawn instantiated 发布块; apps/daemon/src/domain/events/DomainEvent.ts#AgentInstantiatedPayload.thinkingLevel; apps/daemon/src/infrastructure/assembly/buildSessionStack.ts#subagentSnapshotFor
- sourceTask: T1.3（SubAgent sediment + MainAgent 补录，2026-08-23）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #11，2026-08-24）：修正已直写落库（E-AgentInstance 直写——描述补 agent.instantiated 携带 thinkingLevel 段（subagentSnapshotFor 同源同时点供给 + 主实例暂不携带可选边界），规则补「spawn 时刻定格快照」条款，anchors 扩 DomainEvent.ts#AgentInstantiatedPayload/buildSessionStack.ts#subagentSnapshotFor + testedBy subagent-thinking-chain）——formalId=E-AgentInstance 与既有 applied 条目（iter-20260816-uzvg）撞号，直写先例，知识不丢失。

### E-会话聚合-r3（iter-20260823-6ps5）
- changeType: 修改
- targetNode: E-会话聚合
- scope: docs/kg/domain.md E-会话聚合（thinking 覆盖持久化语义一句）
- project: helix
- reason: verification 4.1 entity 覆盖率审计建议项终验落账：会话级 thinking 覆盖的持久化语义补入 E-会话聚合——覆盖意图经 thinking.set 命令族落 domain_events（单写队列），跨冷恢复由 RestoreService.restoreThinkingOverride 只读回放末值直写引擎内存（绕过发布面，零新事件流），SessionStateView additive thinking {override,effective} 双位读面随快照出会话
- evidence: verification/verification-report.md §4.1 建议项；apps/daemon/test/integration/thinking-restore.test.ts（回放末值 + 零新事件流断言）；台账 TR-AD-41-r2 sediment evidence
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/application/services/RestoreService.ts#restoreThinkingOverride; apps/daemon/src/adapters/driving/ws-server/handlers/thinking.ts; apps/daemon/src/application/ports/inbound/SessionPort.ts#SessionStateView.thinking
- sourceTask: verification TC4.1 entity 审计建议项（MainAgent 终验补录，2026-08-24；propose 路径拼接 bug 经 ISSUE-kg-propose-path 先例手动合并）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #15，2026-08-24）：修正已直写落库（E-会话聚合 直写——描述补 thinking 覆盖持久化段（thinking.set 落 domain_events 单写队列 + RestoreService 回放末值直写引擎内存零新事件流 + SessionStateView additive 双位读面），规则补恢复零新事件流铁律，anchors 首次补齐 Session.ts/SessionPort/RestoreService/handlers/thinking.ts + testedBy thinking-restore/thinking-set-chain）——formalId=E-会话聚合 与既有 applied/discarded 条目撞号（2 处），直写先例，知识不丢失。

### E-智能体配置资源-l3（iter-20260823-6ps5）
- changeType: 修改
- targetNode: E-智能体配置资源
- scope: docs/kg/domain.md E-智能体配置资源（删除节点闭合围栏后的旧版「双层」残留段）
- project: helix
- reason: L3 语义复核判不一致：domain.md:381-393 节点闭合围栏后残留一整段旧版正文（「skills 扫描双层目录」「用户裁决：双层自有目录」），与代码三层事实（SkillScanner user/project/builtin 三源）及节点自身三层正文自相矛盾——iter-20260821-dg90 层数校正的编辑残片。修正：删除残留段，节点正文以三层版为准（改文本级，零改码）
- evidence: docs/kg/domain.md:381-393 vs SkillScanner.ts:5-7,40-46 + ResourceService.ts:103（builtin-immutable）；final-verification/l3-review-a.md §2
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/pi-engine/SkillScanner.ts:40-46
- sourceTask: final-verification L3 语义复核·批次 A（phase-reviewer agt_VTR24J07WECN，2026-08-24；propose 撞号经 MainAgent 手动合并）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #16，2026-08-24）：修正已直写落库（E-智能体配置资源 直写——节点块外残留旧版「双层」段落已随直写清除（domain.md「双层」零命中）；块内文本同步 resource_type 扩 thinking 四类 + 槽位型通用 slotValue job + anchors 扩 protocol commands/events/WriteQueue + testedBy agent-config-ws）——formalId=E-智能体配置资源 与既有 applied 条目撞号，直写先例，知识不丢失。

### TR-AD-6-l3（iter-20260823-6ps5）
- changeType: 修改
- targetNode: TR-AD-6
- scope: docs/kg/architecture-rules.md TR-AD-6（「零 process.env」例外款补 subagent 父子 IPC 豁免族）
- project: helix
- reason: L3 语义复核判不一致：规则文本「工具/业务代码维持零 process.env（AF-2）」+「唯一例外=壳→daemon 注入面（读取收束 container.ts 单点）」漏列第二条豁免族：AG-08 守护实际白名单含 adapters/driven/subagent/ 全目录（父子进程 env IPC 通道），ChildMain.ts:147-163 直接读 7+ 个 HELIX_* 键且不收束 container.ts——按文本执行评审会把合法代码判违规。修正：例外款补「subagent/ 父子进程 env IPC 面（传输通道非配置源；读取限该目录，AG-08 白名单第二族）」，与守护测试注释对齐（改文本级）
- evidence: docs/kg/architecture-rules.md:201-202 vs apps/daemon/test/arch-guard/arch-guard.test.ts:307-313 + ChildMain.ts:147-163 + SubagentLauncher.ts:194-212；final-verification/l3-review-a.md §5
- implementationStatus: 完整实现
- implementedCode: apps/daemon/test/arch-guard/arch-guard.test.ts:306-330（AG-08 双白名单守护）
- sourceTask: final-verification L3 语义复核·批次 A（phase-reviewer agt_VTR24J07WECN，2026-08-24；propose 撞号经 MainAgent 手动合并）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #17，2026-08-24）：修正已直写落库（TR-AD-6 经 project_write_tech_rules 直写——例外款扩为两族：①跨进程启动注入面（原）②subagent 父子 env IPC 面（ChildMain.ts:147-163 HELIX_* 直读合法，AG-08 白名单第二族），理由/适用/反例同步，anchors 扩 ChildMain.ts）——formalId=TR-AD-6 与既有 applied 条目（iter-20260816-6q6f「### TR-AD-6」）撞号，直写先例，知识不丢失。

### TR-AD-24-l3（iter-20260823-6ps5）
- changeType: 修改
- targetNode: TR-AD-24
- scope: docs/kg/architecture-rules.md TR-AD-24（SubAgent 模型解析链枚举三级→四级；与 pending TR-AD-PROFILE-GETTER-FOLD 合并裁决）
- project: helix
- reason: L3 语义复核判不一致：规则正文断言 SubAgent 模型来源「三级优先级解析（①SubAgentProfile.model → ②spawn 会话快照 → ③全局兑底）」，但代码自 M6 T2（478ab2c）起实为四级链——kind 槽位（uiModelSlot）插入 ①② 之间（subagent-worker kind 槽位设定时优先于 spawn 会话快照），与正文②优先级表述直接冲突；次要：正文①「装配期 resolveModelSlot 解析」实为 launch 期 resolveModel。修正：枚举改「profile.model 静态声明 ?? kind 槽位（launch 期读现值定格）?? spawn 快照 ?? 全局兑底」，与 pending 候选 TR-AD-PROFILE-GETTER-FOLD（getter 折叠进 profile 读面）合并裁决落账（改文本级）
- evidence: SubagentLauncher.ts:141-163（resolveModelFor 四级链 docstring）+ buildSessionStack.ts:219-224（uiModelSlot 接线）+ :269-270（链序注释）；final-verification/l3-review-b.md §TR-AD-24
- implementationStatus: 完整实现
- implementedCode: apps/daemon/src/adapters/driven/subagent/SubagentLauncher.ts:141-163; apps/daemon/src/infrastructure/assembly/buildSessionStack.ts:219-224,269-270
- sourceTask: final-verification L3 语义复核·批次 B（phase-reviewer agt_G87FT6KQCAQV，2026-08-24；propose 落账故障经 MainAgent 手动合并）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #19，2026-08-24）：修正已直写落库（TR-AD-24 经 project_write_tech_rules 直写——SubAgent 模型链三级→四级枚举（kind 槽位插入 ①② 之间，launch 期 getter 折叠定格引 TR-AD-44）、名称同步四级链、①「装配期 resolveModelSlot」改「launch 期 resolveModelFor」、anchors 扩 buildSessionStack + testedBy subagent-thinking-chain）——formalId=TR-AD-24 与既有 discarded 条目（qhv8「### TR-AD-24」）撞号，直写先例，知识不丢失。

### TR-AD-26-l3（iter-20260823-6ps5）
- changeType: 修改
- targetNode: TR-AD-26
- scope: packages/protocol/PROTOCOL.md §3 四处注释散文 0.10→0.11 机械修（+可选：sot ① 断言面扩全 §3 0.1x 字面量）
- project: helix
- reason: L3 语义复核判不一致：PROTOCOL.md §3 代码块自称「envelope.ts 现行定义的忠实呈现（逐项抄源）」，但四处注释散文仍手写 "0.10"（:52/:56/:68/:84），与单点 envelope.ts:18-24（已 v0.11）不一致——违反 TR-AD-26②「引用版本一律从单点读…禁止手写字面量」既有断言，反例形态部分复发（v0.11 批只机械跟随了标题+导出行）；sot ① 断言只提取标题行+导出行字面量，注释面漂移逃逸守护（实测 5/5 绿佐证盲区）。修正：①机械修四处 0.10→0.11（含 PROTOCOL.md 文档修复）；②可选裁决：sot ① 提取面扩至 §3 全部 0.1x 字面量
- evidence: packages/protocol/PROTOCOL.md:52/56/68/84 vs envelope.ts:18-24；sot-consistency.test.ts:109-117（断言粒度）；bun test sot-consistency 5 pass；final-verification/l3-review-b.md §TR-AD-26
- implementationStatus: 部分实现（四处字面量待修；守护面扩展为可选裁决）
- implementedCode: packages/protocol/PROTOCOL.md:52,56,68,84（待修）；packages/protocol/src/envelope.ts:18-24（单点已 0.11）
- sourceTask: final-verification L3 语义复核·批次 B（phase-reviewer agt_G87FT6KQCAQV，2026-08-24；propose 落账故障经 MainAgent 手动合并）
- createdIn: iter-20260823-6ps5
- decisionLog: 终验裁决（用户批准终验报告 §7 #20，2026-08-24）：机械修已直写落库（PROTOCOL.md 14 处「当前版本位」引用 0.10→0.11——§2 序列图 4 帧/握手校验/§3 信封注释 4 处/§6 错误表 2 处/§8 版本位/版本史 v0.10 去当前标注 + v0.11 当前条目；历史批登记（§17.10 等）字面量合法保留；sot-consistency 复跑 5/5 绿）——TR-AD-26 节点文本零变化（违例在 PROTOCOL.md 非规则正文），formalId=TR-AD-26 与既有 discarded 条目撞号，机械修留本 decisionLog 审计痕；子项「sot ① 断言面扩 §3 全字面量」转优化机会清单 #2/#3。

### E-SteerQueue
- changeType: 修改
- targetNode: E-SteerQueue
- scope: 级联校验（apply TR-AD-47）
- project: helix
- reason: 邻居 E-SteerQueue 的锄点 apps/daemon/src/domain/session/Session.ts#applySteer 符号解析失败（符号已消失？）；邻居 E-SteerQueue 的锄点 apps/daemon/src/domain/session/Session.ts#steerEntry 符号解析失败（符号已消失？）；邻居 E-SteerQueue 的锄点 apps/daemon/src/domain/session/Session.ts#applyDirectedSteer 符号解析失败（符号已消失？）；邻居 E-SteerQueue 的锄点 apps/daemon/src/domain/agent/SteerQueue.ts#SteerQueue 符号解析失败（符号已消失？）；邻居 E-SteerQueue 的锄点 apps/daemon/src/application/services/ChatService.ts#steer 符号解析失败（符号已消失？）；邻居 E-SteerQueue 的锄点 apps/daemon/src/application/services/ChatService.ts#steerInstance 符号解析失败（符号已消失？）
- evidence: kg apply 级联校验 @ task-20260824-thinking-unify
- sourceTask: kg-apply
- createdIn: task-20260824-thinking-unify
- decisionLog: 级联误报（符号索引过期）：apply TR-AD-47 时锚符号解析失败，但逐一验证全部健在——Session.ts:88 applySteer / SteerQueue.ts:33 class SteerQueue / ChatService.ts:272 steer / :274 steerInstance 调用链完整；codegraph 符号索引 last-indexed 8-16，此后 T10/T11/T12 大量代码变更未重建所致。非节点事实漂移，discard；根治 = codegraph 索引重建（另行安排）
