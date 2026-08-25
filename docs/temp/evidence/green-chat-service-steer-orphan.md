# GREEN: chat-service-steer-orphan（B 收口清账）

- 实现：`ChatService.settleRunEnd` 收口段（回 idle 后、closureBuffer 续送检查前）`drainAllSteer()` 残留 → 逐条 `engine.error`「注入被丢弃（轮次已收口，引擎侧无后续消费轮）：…」（与 stopped 分支同族可观测丢弃）。
- 文案注意：不硬编码 "closure" 前缀——孤儿来源可为 closure/progress/user steer（abort 后残留）/恢复残留，中性文案覆盖全部。
- 命令与结果：
  - `bun test test/unit/chat-service-steer-orphan.test.ts` → 2 pass / 0 fail（孤儿清账 + 正常 drain 路径回归）
  - `bun test`（apps/daemon 全量）→ 897 pass / 0 fail（895 基线 + 2 新增；restore-restart pendingSteer 跨重启保留语义、closure-flush abort 窗口、定向 steer 等全绿）
  - `bunx tsc --noEmit` → 零错
- 附带自愈特性：存量孤儿（如生产库 00386a2c 的 e19）在所属会话下次任意 run 收口时被同一逻辑清账——无需手工删行。
