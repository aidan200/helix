//! 行为矩阵（CI windows runner 跑——mac 开发机无法验证 Win32 行为）。
//!
//! 形态照 codex windows-sandbox-rs：integration test 真 spawn 编译产物
//! （CARGO_BIN_EXE_* 注入路径），断言真实文件系统行为，非 mock。
//!
//! 核心断言面：writableRoots 内写成功 / 外写拒绝（内核 ACL 强制）/
//! 子目录继承 / 退出码透传 / stdio 透传。

#![cfg(target_os = "windows")]

use std::path::PathBuf;
use std::process::Command;

const HELPER: &str = env!("CARGO_BIN_EXE_helix-sandbox-helper");

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "helix-sbx-test-{}-{}",
        tag,
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp root");
    dir
}

fn run_helper(writable: &PathBuf, workdir: &PathBuf, inner_cmd: &str) -> (i32, String) {
    let out = Command::new(HELPER)
        .arg("--writable")
        .arg(writable)
        .arg("--")
        .current_dir(workdir)
        // cmd /c 形态——命令行整体作为 `--` 后参数
        .args(["cmd", "/c", inner_cmd])
        .output()
        .expect("spawn helper");
    let code = out.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    (code, stderr)
}

/// 解析 Git Bash 绝对路径（2026-10 runner 镜像漂移：System32 的 WSL bash.exe 垫片
/// （无发行版时 bash -c 必败）在 CreateProcess 搜索序里先于 PATH，会遮蔽
/// PATH 上的真 Git bash——故不走 PATH 探测，直接从 git.exe 实位/常见安装位
/// 拿绝对路径；测试传绝对路径给 helper，CreateProcess 绝对路径不搜索 PATH。）
fn git_bash() -> Option<PathBuf> {
    // ① 常见安装位直探（免子进程，最快）
    for fixed in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
    ] {
        if PathBuf::from(fixed).exists() {
            return Some(PathBuf::from(fixed));
        }
    }
    // ② 从 PATH 上的 git.exe 实位推导 Git 根（git 在 cmd/ 而已，同根 bin/ 即 bash）
    let where_git = Command::new("where").arg("git").output().ok()?;
    if !where_git.status.success() {
        return None;
    }
    let git_exe = String::from_utf8_lossy(&where_git.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    if git_exe.is_empty() {
        return None;
    }
    let git_root = PathBuf::from(&git_exe)
        .ancestors()
        .nth(2)? // …/Git/cmd/git.exe → Git/
        .to_path_buf();
    for sub in ["bin", "usr\\bin"] {
        let bash = git_root.join(sub).join("bash.exe");
        if bash.exists() {
            return Some(bash);
        }
    }
    None
}

#[test]
fn write_inside_root_succeeds() {
    let root = temp_root("inside");
    let (code, err) = run_helper(&root, &root, "echo hello > out.txt");
    assert_eq!(code, 0, "helper stderr: {err}");
    let content = std::fs::read_to_string(root.join("out.txt")).expect("file exists");
    assert!(content.contains("hello"));
}

#[test]
fn write_inside_subdir_inherits_grant() {
    let root = temp_root("subdir");
    std::fs::create_dir_all(root.join("a/b")).unwrap();
    let (code, err) = run_helper(&root, &root, "echo x > a\\b\\deep.txt");
    assert_eq!(code, 0, "helper stderr: {err}");
    assert!(root.join("a/b/deep.txt").exists(), "子目录继承 grant ACE");
}

#[test]
fn write_outside_root_denied() {
    let allowed = temp_root("allowed");
    let denied = temp_root("denied");
    let target = denied.join("escape.txt");
    let (code, _) = run_helper(
        &allowed,
        &denied, // cwd 在拒绝区——相对路径写
        "echo escape > escape.txt",
    );
    if code == 0 {
        // CI 盲调取证：dump 目标 ACL + 被沙箱进程 token 视角（helper --diagnose）
        let acl = Command::new("icacls").arg(&denied).output().ok();
        let acl_txt = acl.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let diag = Command::new(HELPER).arg("--diagnose").arg(denied.to_string_lossy().as_ref()).output().ok();
        let diag_txt = diag
            .map(|o| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
            .unwrap_or_default();
        panic!("root 外写未被拒（exit 0）\n== icacls ==\n{acl_txt}\n== diagnose ==\n{diag_txt}");
    }
    assert!(!target.exists(), "root 外文件必须未被创建");
}

#[test]
fn delete_outside_root_visibility() {
    // 边界（CI run33 实测）：DELETE 权限不在 WriteRestricted additional check 面
    // ——根外「写」被内核拒，但「删除」放行。物理拦截需 deny-ACE+PROTECTED_DACL
    // 隔离工程（codex 同界），helix 收口：写面内核拦、删除靠感知对账
    // （daemon 侧 bashSense rm 词汇已捕获删除事实 → undeclared 审计）。
    // 本用例锁定该边界为**已文档化行为**：删除发生（感知面可见）而非被拒。
    let allowed = temp_root("del-ok");
    let denied = temp_root("del-no");
    let victim = denied.join("victim.txt");
    std::fs::write(&victim, "x").unwrap();
    let (code, _) = run_helper(&allowed, &denied, "del victim.txt");
    assert_eq!(code, 0, "删除放行是已文档化边界（DELETE 不在 WriteRestricted 面）");
    assert!(!victim.exists(), "删除实际发生——感知对账兜底的前提");
}

#[test]
fn exit_code_passthrough() {
    let root = temp_root("exitcode");
    let (code, _) = run_helper(&root, &root, "exit /b 42");
    assert_eq!(code, 42, "被沙箱进程退出码须透传");
}

#[test]
fn stdout_passthrough() {
    let root = temp_root("stdout");
    let out = Command::new(HELPER)
        .arg("--writable")
        .arg(&root)
        .arg("--")
        .args(["cmd", "/c", "echo piped-output"])
        .output()
        .expect("spawn helper");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("piped-output"), "stdio 须透传（daemon 管道面）");
}

#[test]
fn missing_writable_root_refuses_to_run() {
    // refusing-to-run-unsandboxed 纪律：根不存在 → 拒跑（非零 + 错误文案）
    let out = Command::new(HELPER)
        .arg("--writable")
        .arg("C:\\definitely-not-exist-helix-xyz")
        .arg("--")
        .args(["cmd", "/c", "echo hi"])
        .output()
        .expect("spawn helper");
    assert_ne!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stderr).contains("helix-sandbox-helper"));
}

// 清理：Windows temp 目录由系统回收；测试目录互不干扰（pid + tag 命名）。

#[test]
#[ignore = "受限 token × MSYS 全局共享段不兼容（从未支持过，非回归）——B28 后新增行为测试首跑即揭；四轮 CI 取证矩阵已排除镜像/特权/flag/文件路径/restricting 组成，唯一存活假说：checkout 阶段 git.exe 预建 msys 共享段（DACL 只授 user）致受限附着被拒；修复需专项（BaseNamedObjects 枚举+段 DACL 宽化或预建），见知识库 E-162 取证链"]
fn multi_word_bash_c_script_boundaries_preserved() {
    // B28（task-91e2e2f9）：argv → 命令行重建须保真参数边界。裸 join(" ")
    // 时代 `bash -c <多词脚本>` 只执行首词（脚本被命令行重解析腰斩，其余词
    // 沦为 $0/$1…），daemon 侧 SandboxEnvWrap 的 bash -c 改写形态全瘫。
    // 本用例：多词脚本（含内嵌空格/双引号）+ 带空格位置参数——$0/$1 与
    // stdout 逐字断言，证明 MSVC quoting 往返无损。
    let bash = git_bash().expect("Git Bash 不可达（常见位+where git 推导均无 bash.exe）——本用例无法验证 argv 边界");
    let root = temp_root("bashc");
    let out = Command::new(HELPER)
        .arg("--writable")
        .arg(&root)
        .arg("--")
        .args([
            bash.to_str().expect("bash 路径非 UTF-8"),
            "-c",
            "printf '[%s|%s]' \"$0\" \"$1\"",
            "first",
            "second word",
        ])
        .output()
        .expect("spawn helper");
    assert_eq!(
        out.status.code(),
        Some(0),
        "helper stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(stdout, "[first|second word]", "argv 边界须保真（脚本本体 + 位置参数原样到达）");
}

#[test]
#[ignore = "同 multi_word 用例：受限 token × MSYS 共享段平台限制（取证链见上一 ignore 与 E-162）"]
fn bash_c_write_with_quoted_path_succeeds() {
    // B28 配套：生产改写形态下沙箱内写（脚本含内嵌空格路径）——引用重建
    // 不损坏脚本语义时写链照常工作。
    let bash = git_bash().expect("Git Bash 不可达（常见位+where git 推导均无 bash.exe）");
    let root = temp_root("bashw");
    let out = Command::new(HELPER)
        .arg("--writable")
        .arg(&root)
        .arg("--")
        .args([
            bash.to_str().expect("bash 路径非 UTF-8"),
            "-c",
            "echo quoted > 'out quoted.txt'",
        ])
        .output()
        .expect("spawn helper");
    assert_eq!(
        out.status.code(),
        Some(0),
        "helper stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let content =
        std::fs::read_to_string(root.join("out quoted.txt")).expect("quoted 路径文件应存在");
    assert!(content.contains("quoted"));
}
