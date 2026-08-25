# RED: chat-service-steer-orphan（B 收口清账）

- 命令：`cd apps/daemon && bun test test/unit/chat-service-steer-orphan.test.ts`
- 结果：1 pass / 1 fail
  - fail = 孤儿场景「收口后队列清空」断言（Expected length: 0 / Received length: 1）——pendingSteer 残留 1，孤儿复现，为正确原因失败（无实现）；
  - pass = 正常 drain 路径回归保护（FakeAgentEngine 必 drain 策略，现状即绿）。
- 复现载体：NoDrainEngine（steer 只登记、run 收尾不消费）镜像生产 pi 时序（session 00386a2c 现场）。
