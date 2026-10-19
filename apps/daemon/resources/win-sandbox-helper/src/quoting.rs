//! quoting.rs —— argv → Windows 命令行重建（MSVC CRT 解析规则的逆变换）。
//!
//! helper 自身 argv 由 Rust std 按 MSVC 规则从命令行拆出；把 `--` 后 argv
//! 重建回命令行传 CreateProcessAsUserW 时，必须按同一规则逐参数重新
//! quoting——裸 `join(" ")` 会丢参数边界（`bash -c <多词脚本>` 只执行首词，
//! 其余沦为 $0/$1…，Windows 沙箱命令语义被腰斩，B28）。子进程（bash/cmd
//! 等 MSVC CRT 程序）重新解析命令行时按下方规则逐字符还原出原 argv。

/// 单参数 MSVC quoting（与 Rust std Windows 进程启动 / CommandLineToArgvW
/// 的解析规则互为逆变换）：
/// - 空参数 / 含空格、制表符、双引号 → 整体包双引号；否则原样返回；
/// - 包内双引号前：既有连续反斜杠翻倍再补 1 个（共 2n+1）转义引号；
/// - 尾部连续反斜杠翻倍（防收尾引号被 CRT 吃进参数）；其余反斜杠原样。
pub(crate) fn quote_msvc_arg(arg: &str) -> String {
    let needs_quotes = arg.is_empty() || arg.contains([' ', '\t', '"']);
    if !needs_quotes {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes: usize = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..(backslashes * 2 + 1) {
                    out.push('\\');
                }
                out.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push(c);
            }
        }
    }
    for _ in 0..(backslashes * 2) {
        out.push('\\');
    }
    out.push('"');
    out
}

/// argv 重建命令行：逐参数按 MSVC 规则 quoting 后以单空格连接。
/// （空 argv → 空串，由 parse_args 的「`--` 后缺命令」拒绝收口。）
pub(crate) fn build_command_line(args: &[String]) -> String {
    args.iter().map(|a| quote_msvc_arg(a)).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plain_args_pass_through_unquoted() {
        assert_eq!(quote_msvc_arg("cmd"), "cmd");
        assert_eq!(quote_msvc_arg("/c"), "/c");
        // 反斜杠不邻双引号、无空白 → 原样（Windows 路径常态，不加引号）
        assert_eq!(quote_msvc_arg("C:\\work"), "C:\\work");
    }

    #[test]
    fn multi_word_arg_is_quoted() {
        assert_eq!(quote_msvc_arg("echo hello world"), "\"echo hello world\"");
        assert_eq!(build_command_line(&argv(&["bash", "-c", "echo a b"])), "bash -c \"echo a b\"");
    }

    #[test]
    fn embedded_space_and_tab_are_quoted() {
        assert_eq!(quote_msvc_arg("a b"), "\"a b\"");
        assert_eq!(quote_msvc_arg("a\tb"), "\"a\tb\"");
    }

    #[test]
    fn embedded_double_quote_is_escaped() {
        // say "hi" → 引号转义；引号前无反斜杠（n=0 → 1 个反斜杠）
        assert_eq!(quote_msvc_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn backslashes_before_quote_double_plus_escape() {
        // a\"b（chars: a \ " b）→ 引号前 1 个反斜杠翻倍+转义 = 3 个
        assert_eq!(quote_msvc_arg("a\\\"b"), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn trailing_backslashes_double_inside_quotes() {
        // 空白触发入引号 + 尾部反斜杠翻倍（防收尾引号被 CRT 吃进参数）
        assert_eq!(quote_msvc_arg("C:\\work dir\\"), "\"C:\\work dir\\\\\"");
        // "a \"（a 空格 反斜杠）→ 字符序列：引号 a 空格 \ \ 引号（尾部 1 个翻倍）；
        // 用字符向量断言避免转义字面量歧义。
        let chars: Vec<char> = quote_msvc_arg("a \\").chars().collect();
        assert_eq!(chars, vec!['"', 'a', ' ', '\\', '\\', '"']);
    }

    #[test]
    fn bare_trailing_backslash_without_specials_stays_unquoted() {
        // 无空白/引号 → 不入引号，尾部反斜杠也无需翻倍（引号外反斜杠 CRT 原样收）
        assert_eq!(quote_msvc_arg("C:\\work\\"), "C:\\work\\");
    }

    #[test]
    fn interior_backslashes_without_quote_stay_literal() {
        // C:\a\b\c：无空白无引号 → 整体不加引号、反斜杠原样
        assert_eq!(quote_msvc_arg("C:\\a\\b\\c"), "C:\\a\\b\\c");
        // 带空格整体入引号：中部反斜杠（不邻引号）原样，仅尾部翻倍
        assert_eq!(quote_msvc_arg("C:\\a b\\"), "\"C:\\a b\\\\\"");
    }

    #[test]
    fn empty_arg_becomes_empty_quotes() {
        assert_eq!(quote_msvc_arg(""), "\"\"");
        assert_eq!(build_command_line(&argv(&["prog", ""])), "prog \"\"");
    }

    #[test]
    fn command_line_rebuild_matrix() {
        // SandboxEnvWrap 生产形态：bash -c <多词脚本>（含内嵌空格/引号/位置参数）
        assert_eq!(
            build_command_line(&argv(&["bash", "-c", "echo \"a b\" c", "x y"])),
            "bash -c \"echo \\\"a b\\\" c\" \"x y\"",
        );
        // cmd /c <多词>（behavior 矩阵既有形态）
        assert_eq!(
            build_command_line(&argv(&["cmd", "/c", "echo hi"])),
            "cmd /c \"echo hi\"",
        );
    }
}
