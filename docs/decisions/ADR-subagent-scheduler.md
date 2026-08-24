# ADR：SubAgent 调度域（非线性红线 / 守护式拆分 / 子进程形态 / closure 双产物）

> 来源：SchedulerService.ts / SubagentEventTranslator.ts / ClosureRecorder.ts / SubagentLauncher.ts / ChildMain.ts 注释考古迁档。
> 活规则锚：AD-7（调度编排）、AD-8（双通道异步交付）、AD-10（队列不落盘）、AD-3/TR-AD-24（模型两级解析链——T12 砍 spawn 会话快照级）、O-5（closure 双产物裁决）、O-6（kill 信号序列）、O-7（子进程启动形态）、TR-AD-4（装配同构）。

## 背景

SubAgent 以独立子进程承载（O-7 候选 A 形态：每实例一个 bun 子进程跑 ChildMain.ts，detached 独立进程组；stdio JSON 线协议双向）。调度器管编排语义（预算/队列/stalled/收口），不感知驱动细节。

## 取舍

- **非线性红线**：实例创建/销毁一等 API；不假设按序推进——queued 可直接收口 failed（摘队+位次递减）、kill 可落在任意状态、终态幂等（迟到收口被吞）、重派 = 新 instanceId 新实例。状态权威在 AgentInstance 状态机，调度器只编排不改写规则。
- **预算与队列**：maxConcurrent/maxQueued 判定（SchedulingPolicy 纯函数）；FIFO 内存队列不落盘（AD-10——重启清队，queued→cancelled 收口）；agent-N 序号 daemon 内递增，重启基线 = agent_lifecycle max(N)+1。
- **kill 通道（收口前终止修复）**：收口前先 runner.kill 通知执行载体终止子进程（O-6：TERM→宽限→KILL 升级，宽限缺省 3s）——只收口不发信号时子进程跑到自然收口，迟到回调虽被幂等吞、进程仍耗资源。
- **closure 双产物（O-5 裁决）**：closure_records 记录行（任务报告本体，SQLite 追加行，findings 保 JSON 重启可读）+ reportPath 文件产物（markdown；reportsDir 未配置时不产文件 reportPath=null）；同一 WriteQueue 队列原子写。closure 注入主线走 SteerQueue（source=closure，与用户 steer 同队列 FIFO——MainAgent idle 立即新 turn / running 下轮 turn 边界 drain，AD-8 双通道）。
- **守护式拆分（TR-AD-25④）**：编排门面保留注册表/FIFO 力学/stalled 监视/观测面（12 public API 面零变化）；引擎事件翻译状态机（6 per-instance Map 写侧 + entry id 分配 + 清理序列单点）→ SubagentEventTranslator；closure 收口链（归一/双产物/投影/终态事件/注入）→ ClosureRecorder。依赖单向：门面 → translator/recorder → ports；runner 回调契约零变化（恰 2 回调一行转发）。
- **装配同构（TR-AD-4）**：子进程复用 PiAgentEngineAdapter + SubAgentProfile 声明装配（零 kind 分支）；spawn 快照 env（systemPrompt 三段组装产物 + 生效工具集）launch 时刻定格透传，代际生效（toggle 后新 spawn 跟随新值，已 spawn 实例 env 已定格不受影响）；缺席回退静态声明面。
- **模型两级解析单点（AD-3/TR-AD-24，T12 砍 spawn 会话快照级）**：① profile.model（声明即最高）→ ② uiModelSlot（resource_state kind 槽位 UI 化）→ ③ 全局兜底 getter（auth 分层 AD-2：key/模型源读 auth.json/default_model 现值，换 key 后下一请求/新子进程跟随）。高档有值即短路；返回完整 Model 对象全链透传（单点解析红线）。SubAgent 只认自身 profile 链，不继承 main session 当前模型（spawn 透传值仅填充 AgentInstanceDto.model，不进解析链）。
- **stalled 分级**：idle > 5min 无事件增量 → agent.stalled 警示可重复推（不自动杀，状态仍 running；终止权在用户）；hard 无上限不自动杀。

## 演进史

1. 单体 SchedulerService（spawn/send/kill + 事件翻译 + 收口链内联，~600 行）。
2. FB 修复批：kill 通道补收口前终止信号（原只收口子进程跑到自然收口）。
3. 守护式三拆：scheduler/ 目录（门面 + SubagentEventTranslator + ClosureRecorder），调用次序保持原内联序（reportPath 落盘与 closure 行落盘之间插 injected 事件）。
4. 多会话化：报告目录/记录行/事件按实例归属会话路由（reportsDirFor 注入）；队列与预算仍 daemon 全局一份（TR-AD-11/16）。
5. 重启恢复（AD-10）：恢复产物注入 restoreInstances——终态原样、快照态登记、task/closure/spawnModels 回填观测面、序号续基线；已登记 instanceId 跳过重注册（幂等）。
6. 投影收敛：usage/instance 判定基元单源 @helix/protocol projection。
