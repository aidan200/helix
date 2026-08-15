# 迭代索引

> 每条迭代记录 2-3 行描述（讲清主体改动，尽量精简）。
> 具体过程文档在 workspace（草稿），此处只存索引描述。

## iter-20260815-6tss — iter-20260815-6tss 底座成熟度 M0：helix 首迭代（daemon 六边形 + FSD 前端 + e2e 双层 harness）
- 主体：WS daemon + 浏览器聊天闭环（CL-1~CL-8）：monorepo 基座 / WS 协议 v0 / 统一 Agent Runtime（pi 适配）/ 最小工具集五件 / dev token 与 static serve / P-1 聊天页 / SQLite 持久化与重启恢复。验证两轮全绿（F 29 + E 7 + 重启 3 + 单元 175/37），终验审计通过，kg 沉淀 22+ 节点。
- 触及：TR-AD-2, TR-AD-7, TR-TEST-1, TR-TEST-2, TR-TEST-5, TR-AD-13, TR-AD-14
- 状态：进行中
