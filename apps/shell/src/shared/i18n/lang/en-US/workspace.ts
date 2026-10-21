/** en-US 词条分片：workspace 域（barrel 见 ../en-US.ts）。
 *
 * 业务域分片重构（体量门）：词条自原 en-US.ts 原样迁移（零改写）；
 * 结构一致性由 `satisfies Pick<Translations, 域名>` 编译期兜底。
 */
import type { Translations } from "../zh-CN";

export const workspace = {
  // ── workspace gate (W3; design §2.2) ──
  workspace: {
    gate: {
      title: "Choose a workspace",
      subtitle: "Pick a workspace root for this session; helix manages projects and knowledge under it.",
      recentsTitle: "Recent",
      recentsAriaLabel: "Recently used workspaces",
      invalid: "Unavailable",
      lastUsedAt: "Last used {time}",
      inputTitle: "Enter a path",
      pathPlaceholder: "/path/to/workspace",
      browse: "Browse…",
      browseErrorTitle: "Directory picker failed",
      open: "Open",
      opening: "Opening…",
      cancelSwitch: "Cancel and go back",
      error: {
        invalidRoot: "Invalid path: directory missing, not a directory, unreadable, or a dangerous root (filesystem root / home directory).",
        activeAgent: "Agents are still running; the workspace cannot be switched right now.",
        sendFailed: "Send failed: connection to daemon is unavailable, please retry later.",
        generic: "Failed to open the workspace, please check the path and retry.",
      },
    },
    boot: {
      errorTitle: "Cannot reach daemon",
      errorSub: "Make sure the daemon is running, or retry.",
      retry: "Retry connection",
    },
    // ── top-bar indicator (W4; design §2.3) ──
    indicator: {
      label: "Workspace: {name}",
      busyTitle: "Agents are running; workspace switch is unavailable ({path})",
    },
    // ── settings section (W4; design §2.3) ──
    settings: {
      currentLabel: "Current binding",
      unbound: "Not bound",
      switchAction: "Switch workspace",
      busyNote: "Sessions/agents are running. Wait for them to finish or abort before switching the workspace.",
    },
  },
} satisfies Pick<Translations, "workspace">;
