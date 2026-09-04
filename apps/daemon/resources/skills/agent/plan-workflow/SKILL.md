---
name: plan-workflow
description: 工作台账（plan 三工具）的使用规范——多步/多阶段任务开工前建台账、逐项推进、收口自查；持 plan_create/plan_update/plan_read 工具的 agent 面对多步任务时必用
tools: [plan_create, plan_update, plan_read]
---

# plan-workflow：工作台账使用 SOP

你持有 plan_create / plan_update / plan_read 三工具（工作台账）。台账是你的执行问责面——它对用户可见（chat 页工作台账条），必须与实际进度保持一致。

## 什么时候建台账

- **多步/多阶段任务必建**：三步以上、跨阶段、或需要中途交代进度的任务，开工前先建台账再动手；
- **轻量任务不建**：一两步可完成的问答/单文件小改，直接做，不摆空台账。

## 工作流（五条）

1. **开工前一次建全**：用 plan_create 一次给出全部计划条目（按执行顺序）——创建后不可重建，条目要覆盖从开工到收口的全部关键步骤；
2. **逐项推进不攒批**：用 plan_update 同步状态——开始一项置 in_progress，完成即置 done；放弃置 abandoned 且必须带 note 说明理由与替代方案；
3. **note 记关键事实**：台账 note 记录产物指针（文件路径/知识节点 id）与卡点，供接力恢复与幂等重跑使用；
4. **收口前自查**：收口或向用户交代前用 plan_read 过一遍——全部条目应为 done 或带理由 abandoned，否则先推进再收口；
5. **按条目逐步提交（commit）**：每条目完成且验证绿即提交一次；收尾前先提交——未提交的工作等于没做。

## 强制 plan 的任务批次

任务系统派发强制 plan 的批次时，会在 brief 尾部机械追加「plan 硬约束」段（模板层强制，不可裁）——那是收口机械判据（台账全 resolve 才算批次成功），与本 SOP 同向但更硬：收口顺序固定为先把全部条目（含收口项自身）置 done/abandoned，再输出 CLOSURE 块。
