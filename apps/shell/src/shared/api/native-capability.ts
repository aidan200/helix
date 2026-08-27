/**
 * shared/api —— 壳原生能力 seam（W6a 原生目录选择；F3 裁决）。
 *
 * 壳（src-tauri）经 initialization_script 在页面脚本前挂
 * `window.helixPickDirectory`（内部走 tauri-plugin-dialog 的目录选择，
 * 平台差异由插件消化：macOS NSOpenPanel / Windows IFileOpenDialog / Linux
 * GTK）。本 seam 是前端唯一访问点——受控 `globalThis` 访问，探测 + 调用
 * 两函数；零 Tauri 内部形态词（AG-17：该字样只许在 Rust 源码字符串里），
 * 纯浏览器 dev 无此挂载点 → hasNativePicker()=false，调用面自然降级。
 *
 * 路径零变换透传（W6a 验收 4）：选中返回的是平台原生路径串（Windows 反斜杠
 * 等），本 seam 与消费面一律透传——禁斜杠转换/拼接/规范化，realpath/校验
 * 由 daemon 侧 workspace.open 在对应平台语义下单点处理（§3.3 前端不重复
 * 实现校验）。
 */

/** 壳注入的原生目录选择函数形态（挂载点声明见 globals.d.ts）。 */
type NativePicker = (initial?: string) => Promise<string | null>;

/** 受控取挂载点（undefined = 无能力：纯浏览器 dev / 壳未注入；
 *  类型面 = globals.d.ts 的全局声明）。 */
function pickerFn(): NativePicker | undefined {
  const fn = globalThis.helixPickDirectory;
  return typeof fn === "function" ? fn : undefined;
}

/** 原生目录选择能力探测（gate 页浏览钮渲染判据）。 */
export function hasNativePicker(): boolean {
  return pickerFn() !== undefined;
}

/**
 * 原生目录选择：`initial` 透传为对话框 defaultPath 提示位（相对/无效由
 * 对话框自身忽略，不预校验）。无能力 → null（不抛错，降级面等价于未选中）。
 * 选中 → 平台原生路径串原样返回（零变换）；取消 → null；底层异常（如能力
 * 未授予）→ null（取消语义，输入框仍可手输）。
 */
export async function nativePickDirectory(initial?: string): Promise<string | null> {
  const pick = pickerFn();
  if (pick === undefined) return null;
  try {
    return await pick(initial);
  } catch {
    return null;
  }
}
