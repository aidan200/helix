# domain/ — 领域层

充血模型（属性 + 行为），framework-free：不 import pi-*、bun/node API、protocol 类型
（AG-02/AG-04；分层见 architecture.md §3.2/§3.3）。

子域现状：

- `agent/`：AgentInstance（agent 实例窗口状态机）、AgentLifecycle（会话级运行态五态 +
  实例注册表）、SteerQueue（注入队列）、SchedulingPolicy（SubAgent 调度纯判定策略）；
- `session/`：Session 聚合、Entry 族（含 Thinking/Compaction/ErrorEntry）、Turn（轮次
  状态机）、SessionSnapshot（快照往返）；
- `task/`：任务三表（job/stage/batch）与 work_item 状态机守卫（job.ts/types.ts）、
  skill manifest 解析与参数校验（manifest.ts）、批次重试策略（retry.ts）；
- `kg/`：知识节点类型与 id 发号（types.ts/node-id.ts）、项目发现与 worktree 归一
  （project-discovery.ts）、锚物化（anchor-materialize.ts）、supersede 链（supersede.ts）、
  附着面（attachment/）与验证报告（verify/）纯逻辑；
- `trace/`：trace 读面投影（TraceQuery/TraceQueryPort——纯投影，不建聚合）；
- `events/`：DomainEvent 事件类型表与常用载荷形状；
- `tools/`：ToolCallRecord（工具调用记录四态）；
- `DomainError.ts`：领域错误类型（非法迁移/违例统一抛出形态）。
