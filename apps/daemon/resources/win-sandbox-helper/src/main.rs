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

// Windows 专属模块（token/ACL/spawn 链）：cfg 门使非 Windows 宿主可跑纯逻辑
// 单测（cargo test on mac——B28 修复附带；win32 面本体零改动，仅加门）。
#[cfg(target_os = "windows")]
mod acl;
mod quoting;
#[cfg(target_os = "windows")]
mod spawn;
#[cfg(target_os = "windows")]
mod token;

use std::path::PathBuf;

use anyhow::Result;
#[cfg(target_os = "windows")]
use anyhow::Context;

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
/// `--` 后 argv 按逐参数 MSVC quoting 重建命令行（B28：裸 join 丢参数边界，
/// 多词 bash -c 脚本只执行首词——见 quoting.rs）。
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
                let cmd = quoting::build_command_line(&args[(i + 1)..]);
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

#[cfg(target_os = "windows")]
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


#[cfg(not(target_os = "windows"))]
fn run(_args: &[String]) -> Result<i32> {
    // 非 Windows 构建仅为宿主纯逻辑单测形态（cargo test on mac）；真执行面
    // 在 Windows（CI windows runner 行为矩阵）——拒跑保 refusing-to-run 纪律。
    anyhow::bail!("helix-sandbox-helper 仅支持 Windows")
}

/// 诊断模式：受限 token 视角下跑 whoami /groups + icacls（stdout 透传回测试）。
#[cfg(target_os = "windows")]
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
        // 多词参数须包双引号（B28：裸 join 会变成 cmd /c echo hi）
        assert_eq!(cmd, "cmd /c \"echo hi\"");
    }

    #[test]
    fn multi_word_bash_c_script_boundaries_preserved() {
        // B28 生产形态：SandboxEnvWrap 改写命令 = helper -- bash -c <多词脚本>
        // ——脚本本体须作为单参数包双引号传递，不得被命令行重解析腰斩成首词。
        let (_, cmd) = parse_args(&[
            "--writable".into(),
            "C:\\work".into(),
            "--".into(),
            "bash".into(),
            "-c".into(),
            "echo hello world".into(),
        ])
        .unwrap();
        assert_eq!(cmd, "bash -c \"echo hello world\"");
    }

    #[test]
    fn bash_script_with_embedded_quotes_and_positional_args() {
        // 含内嵌双引号脚本 + 带空格位置参数：引号转义、空格参数各自成段
        let (_, cmd) = parse_args(&[
            "--writable".into(),
            "C:\\work".into(),
            "--".into(),
            "bash".into(),
            "-c".into(),
            "printf '[%s|%s]' \"$0\" \"$1\"".into(),
            "first".into(),
            "second word".into(),
        ])
        .unwrap();
        assert_eq!(
            cmd,
            "bash -c \"printf '[%s|%s]' \\\"$0\\\" \\\"$1\\\"\" first \"second word\""
        );
    }

    #[test]
    fn rejects_missing_command() {
        assert!(parse_args(&["--writable".into(), "C:\\x".into()]).is_err());
        assert!(parse_args(&["--".into(), "cmd".into()]).is_err()); // 无 writable
        assert!(parse_args(&["--".into()]).is_err()); // 空命令
        assert!(parse_args(&["--writable".into()]).is_err()); // 缺参数
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn cap_sid_shape() {
        let sid = acl::random_cap_sid();
        assert!(sid.starts_with("S-1-5-21-"), "SID 形态: {sid}");
        let sid2 = acl::random_cap_sid();
        assert_ne!(sid, sid2, "连续生成的 cap SID 不得相同");
    }
}
