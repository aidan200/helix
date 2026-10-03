/**
 * agent 输出面打断常量（E-198 定稿语义的引擎中立锚点）。
 *
 * 历史：原 domain/loop/contracts/markers.ts（helix-loop Phase 0a 拆分件）。
 * 段C 内核退役（2026-10）：domain/loop 整体删除，本常量因跨层共享
 * （pi-engine AbortShaping 修形层 + 管家 KV 投影过滤凭据）迁入
 * domain/agent——引擎中立的输出面语义。原 markers 件中的内核专用常量
 * （中断/截断工具回执文案、audit 形状）随内核与直测退役；pi 侧工具
 * 中断回执由 pi agent-loop 自合成（"Operation aborted"）。
 *
 * `[loop:interrupt]` 前缀 = KV/审计/sediment 过滤的同源识别凭据
 * （E-198 定稿：固定常量文本，b175d8d6 文案批）——**值不可变更**
 * （历史 KV 行按此过滤）。
 */

/** E-198：打断截断标记（turn 级「此处被掐」）——固定常量文本的 user 角色
 *  合成消息（外部中断事件的模型面：三角色 schema 下 user 是外部事件的唯一
 *  合法通道；固定常量 = KV/审计/sediment 过滤的同源识别凭据；provider 面
 *  user 消息恒合法）。语义：已输出内容与未完句已保留，未执行的工具调用
 *  已以中断回执配对入账（D7 配对语义），未完成的思考已丢弃。 */
export const LOOP_INTERRUPTED_MARKER_TEXT =
  "[loop:interrupt] 上一条回复被用户中断，此处截断（已输出内容与未完句已保留，未执行的工具调用已以中断回执配对入账，未完成的思考已丢弃）";
