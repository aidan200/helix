/**
 * kg 注入条目共享渲染/贪心助手（📎 附着块与任务切片双轨同构收口）。
 *
 * 两受众（主会话 edit 附着 render.ts / SubAgent 任务切片 task-slice.ts）
 * 的单节点条目拼装（粗体 name + kind 徽章 + digest + scene 段 + kg get
 * 指针）与 token 硬顶贪心装入原为约 30 行双轨重复——本文件单源化；
 * 受众/协议行差异（main 版 vs worker 版 supersede 协议、multiProject
 * 指针形态）仍归各自调用方。
 *
 * 纯函数、零 IO（TR-AD-1）。
 */

/** 单节点注入条目：粗体 name + kind 徽章 + digest + scene 段（空 scene 省略）+ 指针行。 */
export function renderKnowledgeEntry(fields: {
  readonly name: string;
  readonly kind: string;
  readonly digest: string;
  readonly scene: string;
}, pointer: string): string {
  const sceneLine = fields.scene !== "" ? `\n  适用：${fields.scene}` : "";
  return `- **${fields.name}** [${fields.kind}] — ${fields.digest}${sceneLine}\n  ↳ ${pointer}`;
}

/**
 * token 硬顶贪心装入（估算口径由 fits 回调闭包收口——估算与渲染同源的
 * 约定归调用方）：按输入序逐项尝试，fits(已选集, 候选) 为真才入选；
 * 超限项让位（不回填），无任何可容项 → 空数组（宁可沉默）。
 */
export function greedyFit<T>(
  items: readonly T[],
  fits: (pickedSoFar: readonly T[], candidate: T) => boolean,
): T[] {
  const picked: T[] = [];
  for (const c of items) {
    if (fits(picked, c)) picked.push(c);
  }
  return picked;
}
