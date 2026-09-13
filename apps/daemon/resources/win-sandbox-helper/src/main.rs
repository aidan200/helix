//! helix-sandbox-helper——Windows 受限 token 命令执行器（U0c 二期②）。
//!
//! 用法：helix-sandbox-helper --writable <dir> [--writable <dir>...] -- <command...>
//!
//! 流程：随机 capability SID → 当前进程 token 构造 WRITE_RESTRICTED 受限 token
//! → 对各 writableRoot 预写 grant(cap SID) 写 ACE → CreateProcessAsUser 起
//! 命令 → 退出码透传。写访问因此被约束在 writableRoots 内（内核 ACL 强制）。
//!
//! refusing-to-run-unsandboxed 纪律（照 codex）：任一环节失败即以非零码
//! 退出并输出错误——绝不降级为未沙箱执行。
//!
//! 参照 codex windows-sandbox-rs（Apache-2.0）裁剪重写：保留 token/ACL 核心
//! 链，砍 conpty/wfp/elevated service/私有桌面/dpapi（codex 的完整桌面隔离
//! 工程——helix 非交互管道形态用不上）。

mod acl;
mod spawn;
mod token;

use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("helix-sandbox-helper: {e:#}");
            std::process::exit(126); // 与规则级 fallback 拒绝码一致（EACCES 惯用）
        }
    }
}

/// 参数解析：--writable <dir>... 与 `--` 后的命令。
fn parse_args(args: &[String]) -> Result<(Vec<PathBuf>, String)> {
    let mut writables: Vec<PathBuf> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--writable" => {
                i += 1;
                let Some(dir) = args.get(i) else {
                    anyhow::bail!("--writable 缺参数");
                };
                writables.push(PathBuf::from(dir));
            }
            "--" => {
                let cmd = args[(i + 1)..].join(" ");
                if cmd.is_empty() {
                    anyhow::bail!("`--` 后缺命令");
                }
                if writables.is_empty() {
                    anyhow::bail!("至少需要一个 --writable <dir>");
                }
                return Ok((writables, cmd));
            }
            other => anyhow::bail!("未知参数: {other}"),
        }
        i += 1;
    }
    anyhow::bail!("缺 `-- <command>` 终结符");
}

fn run(args: &[String]) -> Result<i32> {
    // 诊断模式：--diagnose <path>——被沙箱进程内跑 whoami/icacls 取证（CI 盲调：
    // 根外写未拒类问题需要 token 视角 + ACL 面事实，日志一轮拿全）
    if let Some(path) = args.first().filter(|a| a.as_str() == "--diagnose").and(args.get(1)) {
        let target = path.clone();
        return run_diagnose(&target);
    }
    let (writables, command) = parse_args(args)?;

    // 根必须存在（不存在则 grant ACE 无处落——拒跑优于建目录：helper 不应制造目录）
    for w in &writables {
        if !w.is_dir() {
            anyhow::bail!("writable root 不存在或非目录: {}", w.display());
        }
    }

    unsafe {
        let cap_sid_str = acl::random_cap_sid();
        let cap_sid = token::sid_from_string(&cap_sid_str)
            .with_context(|| format!("cap SID 解析失败: {cap_sid_str}"))?;

        // 预写 grant ACE（先于 token 构造——命令启动时 ACL 必须就位）
        for w in &writables {
            acl::add_allow_write_ace(w, &cap_sid)
                .with_context(|| format!("grant ACE 写入失败: {}", w.display()))?;
        }

        let base = token::current_process_token().context("取当前进程 token 失败")?;
        let sandboxed = token::create_sandbox_token(base, &cap_sid).context("构造受限 token 失败")?;
        windows_sys::Win32::Foundation::CloseHandle(base);

        let code = spawn::spawn_as_user_and_wait(sandboxed, &command)
            .context("受限进程启动失败")?;
        windows_sys::Win32::Foundation::CloseHandle(sandboxed);
        Ok(code)
    }
}


/// 诊断模式：受限 token 视角下跑 whoami /groups + icacls（stdout 透传回测试）。
fn run_diagnose(target: &str) -> Result<i32> {
    unsafe {
        let cap_sid_str = acl::random_cap_sid();
        let cap_sid = token::sid_from_string(&cap_sid_str)?;
        let base = token::current_process_token()?;
        let sandboxed = token::create_sandbox_token(base, &cap_sid)?;
        windows_sys::Win32::Foundation::CloseHandle(base);
        let cmd = format!("whoami /user & whoami /groups & icacls \"{target}\"");
        let r = spawn::spawn_as_user_and_wait(sandboxed, &cmd);
        windows_sys::Win32::Foundation::CloseHandle(sandboxed);
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_writables_and_command() {
        let (w, cmd) = parse_args(&[
            "--writable".into(),
            "C:\\work".into(),
            "--writable".into(),
            "C:\\tmp".into(),
            "--".into(),
            "cmd".into(),
            "/c".into(),
            "echo hi".into(),
        ])
        .unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(cmd, "cmd /c echo hi");
    }

    #[test]
    fn rejects_missing_command() {
        assert!(parse_args(&["--writable".into(), "C:\\x".into()]).is_err());
        assert!(parse_args(&["--".into(), "cmd".into()]).is_err()); // 无 writable
        assert!(parse_args(&["--".into()]).is_err()); // 空命令
        assert!(parse_args(&["--writable".into()]).is_err()); // 缺参数
    }

    #[test]
    fn cap_sid_shape() {
        let sid = acl::random_cap_sid();
        assert!(sid.starts_with("S-1-5-21-"), "SID 形态: {sid}");
        let sid2 = acl::random_cap_sid();
        assert_ne!(sid, sid2, "连续生成的 cap SID 不得相同");
    }
}
