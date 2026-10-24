//! Windows command-line quoting, the exact inverse of CommandLineToArgvW / the MSVC CRT parser:
//! each argument comes back unchanged, whatever spaces, quotes or backslashes it contains.
//! No shell is involved: cmd.exe metacharacters (& | > ^ %) are plain characters here.

#[allow(dead_code)] // used by the Windows implementation and the tests
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // Backslashes before a quote are doubled, plus one to escape the quote itself.
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // Trailing backslashes are doubled so the closing quote is not escaped.
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

#[allow(dead_code)]
pub fn command_line(program: &str, args: &[String]) -> String {
    std::iter::once(quote_arg(program))
        .chain(args.iter().map(|a| quote_arg(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference parser (MSVC rules), to prove quoting round-trips.
    fn parse(cmd: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut cur = String::new();
        let mut in_quotes = false;
        let mut has = false;
        let chars: Vec<char> = cmd.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '\\' {
                let mut n = 0;
                while i < chars.len() && chars[i] == '\\' {
                    n += 1;
                    i += 1;
                }
                if i < chars.len() && chars[i] == '"' {
                    cur.extend(std::iter::repeat_n('\\', n / 2));
                    if n % 2 == 1 {
                        cur.push('"');
                        i += 1;
                    }
                } else {
                    cur.extend(std::iter::repeat_n('\\', n));
                }
                has = true;
                continue;
            }
            if c == '"' {
                in_quotes = !in_quotes;
                has = true;
            } else if (c == ' ' || c == '\t') && !in_quotes {
                if has {
                    args.push(std::mem::take(&mut cur));
                    has = false;
                }
            } else {
                cur.push(c);
                has = true;
            }
            i += 1;
        }
        if has {
            args.push(cur);
        }
        args
    }

    #[test]
    fn round_trips_tricky_arguments() {
        let cases = [
            "simple",
            "",
            "with space",
            "quote\"inside",
            "trailing\\",
            "C:\\Program Files\\x\\",
            "a\\\\\"b",
            "& | > ^ % ! ( )",
            "\"",
            "\\\\server\\share",
            "tab\there",
        ];
        for c in cases {
            let line = command_line("prog", &[c.to_string()]);
            assert_eq!(parse(&line), vec!["prog".to_string(), c.to_string()], "argument {c:?} → {line}");
        }
    }

    #[test]
    fn leaves_plain_arguments_untouched() {
        assert_eq!(command_line("git", &["status".into(), "--short".into()]), "git status --short");
    }
}
