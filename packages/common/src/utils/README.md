# utils/ — 通用纯工具位（占位）

本目录是 @helix/common 的通用纯工具落位（AD-1 / TR-AD-28）。

- **本迭代不填充**：既有 daemon/shell utils 不批量迁移（AD-1 范围控制裁决），
  后续按需逐个迁入，每笔迁入过业务无关性双治理。
- **准入判据（内容纪律，评审守护）**：「换一个产品仍然成立」的通用件；
  领域词汇（Session/Agent/Instance 等领域语义）一律拒绝入内。
- **结构纪律（机械守护）**：import 只允许相对路径与 node:*/bun:* 内置
  说明符——@helix/* 或第三方包 import 即 arch-guard AG-15① 红。
