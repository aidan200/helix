# ADR：WS 驱动侧（handler 化拆分 / DtoMapper 四域拆分 / 订阅档位演进）

> 来源：WsServerAdapter.ts / handlers/* / DtoMapper 域注释考古迁档。
> 活规则锚：AG-12（driving 只转发不决策）、AD-1（前端零改动守护）、AD-3/AD-4（统一信封）、Q-2b（连接级单档）、Q-3a（干预消息落主轴）。

## 背景

WS 驱动侧（WsServerAdapter，Bun.serve 原生 websocket）承载：hello 握手（token 三分支校验）→ welcome + 快照推送 → 命令帧路由 → 事件帧下发。绑定纪律：仅 127.0.0.1，禁止 0.0.0.0/::（结构保证非 loopback 不可达）。

## 取舍

- **handler 化（AD-1 迁移模式）**：22 个命令 case 体自 routeCommand 机械迁出 handlers/{chat,session,agent,trace,model,auth,resource,web}.ts（语义逐字节等价，仅 this.deps.X→ctx.X 机械代换）；routeCommand 全 case 一行转发——「只转发不决策」（AG-12：ws-server 对 domain 仅 type-only，校验规则调用归 driven）。
- **共享上下文解环**：WsServerAdapter → handlers/auth（值导入）→ handlers/model（WsCommandContext type 导入）→ WsServerAdapter（ConnState type 导入，回边）三模块静态环——两个类型定义上收 handlers/context.ts 后 handlers/* 只依赖本模块（type-only），环解。快照盖章链（sessionStamp/snapshotFrame）留 adapter，session/chat handler 经上下文回调机械引用零行为差（不为省行数造成第二份）。
- **结果帧点对点**：model/auth 9 命令结果改 *.result 结果帧 sendNow 直发（契约 C §2.2，与 session 族同构）；model.set 的 ack 仍为 model.changed 广播不动；错误分支专用错误码（契约 C §4）。
- **事件帧统一信封（AD-3/AD-4）**：全部帧章印 sessionId（事件侧来自 DomainEvent.sessionId；delta 侧来自 StreamDelta.sessionId，缺省组合根注入 defaultSessionId 兜底）+ channel（EVENT_CHANNELS 单点登记）；agent.* 编排族与 SubAgent 工具事件携带 instanceId 时透传（前端按 id 分流投影）。
- **订阅档位（Q-2b 定案）**：连接级 `Map<sessionId, tier>` 取代 v0.2 Set——消除双集交集歧义，切换先升后降不丢帧不串台；monitor 档按白名单在 push 一处过滤（3 类型）；拒绝 daemon 持活跃会话知识（原子换档方案）保持去中心化订阅模型——多窗口协议层零改动。agent.subscribe 登记实例 id 集只记录不过滤（通路语义）。
- **spawn 锚 enrichment**：agent.spawned 帧锚点在 publish 处查调度器内存携带值经 EventMapContext 注入——不进领域事件载荷（不落 domain_events，派生值无第二事实源）。

## 演进史

1. 单文件 DtoMapper（711 行）→ 四职责域拆分（TR-AD-25④ 逐行搬移）：EntryDtoMapper（条目级纯转换 + 跨域辅助）/ SnapshotMapper（快照域 + 尾窗分页）/ SpawnAnchor（锚权威计算）/ EnvelopeMapper（事件帧），原文件留常设 barrel——导出面与拆分前恰等，8 消费端 import 点零改动；依赖方向无环（EnvelopeMapper/SnapshotMapper → EntryDtoMapper；SnapshotMapper → SpawnAnchor）。
2. per-session 快照盖章热修：agentState/model 从 system.getStatus() 全局投影改为视图归属会话同源组装（多会话串台修复，回执与快照双面）。
3. 订阅演进：v0.2 Set（连接级会话集）→ v0.3 连接级单档 Map + tier 白名单过滤（monitor 档消息面）。
4. 投影收敛：entry 排序基元（entrySortKey）与 spawn 锚纯函数迁 @helix/protocol projection 单源（daemon 侧本地模块退役，shell 侧同构收敛）。
