<!--
段库：brief/kg-constraint-slice（用途与 catalog.ts 同步）
任务层切片注入区（F1.3）：spawn 派发时按任务文本匹配实体/规则（search 同源），
以 digest+指针切片注入本区——与 T3.3 附着渲染同格式（domain/kg/attachment/render.ts）。
-->
## kg 约束切片

（装配内容：任务命中的知识节点切片，格式如下——图谱只附导航与约束摘要，
内容永远来自按指针深入获取：）

📎 本次任务命中以下知识节点（digest+指针，详情经 kg get 获取）：
- **节点名** [kind] — digest 首行
  ↳ kg get <节点id>

若本次改动推翻此节点，随改动提交 supersede（kg-update）

要点：
- 无命中节点时整段省略（硬约束③）；有命中则协议行必随（AD-14 第一道防线）。
