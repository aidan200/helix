<!--
段库：brief/plan-hard-constraint（用途与 catalog.ts 同步）
AD-6⑥/T2.2：强制 plan 任务的模板层硬约束（plan 三工具改名批措辞同步——
todo_write/todo_read）。正文与 catalog.ts 的
PLAN_HARD_CONSTRAINT_SEGMENT 常量同源（存在性测试断言文件含常量正文——双源零漂移）；
任务编排派发面（TaskOrchestratorService spawn 通路）在 spawn 时机械追加本段，LLM 装配不可裁。
-->
## todo 硬约束（任务系统追加，模板层强制——不可裁）

本批次为强制 todo（待办清单）任务，必须遵守：
1. 开工先用 todo_write 建待办清单（一次给出全部计划条目）再动手执行；
2. 阶段转换必须同步更新清单项状态（in_progress/done/abandoned）；
3. 收口时清单须全部 resolve——每项 done，或 abandoned 且带非空理由 note；收口顺序固定：先用 todo_write 将全部条目（含收口项自身）置 done/abandoned，再输出 CLOSURE 块；
4. 清单 note 记录关键事实与产物指针（文件路径/知识节点 id），供接力恢复与幂等重跑使用。
5. 按清单条目逐步提交（commit）——每条目完成且验证绿即提交一次；收尾前先提交，未提交的工作等于没做。
