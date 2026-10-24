//! hermes-jobrun — runs one command inside a Windows Job Object.
//!
//! Usage: hermes-jobrun [--memory-mb N] [--cpu-percent N] [--max-processes N] [--stats FILE] -- PROGRAM [ARGS...]
//!
//! The child is created suspended, assigned to the job, then resumed, so neither it nor any of its
//! descendants can run outside the limits. Every process still in the job when this program exits
//! is killed (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE): killing hermes-jobrun kills the whole tree.
//! The exit code is the child's; 125 means hermes-jobrun itself failed (message on stderr).
//! With --stats, a JSON file reports peak memory, CPU time and process counts for the audit log.

use std::ffi::OsString;
use std::path::PathBuf;

mod quote;

#[derive(Debug, Default, PartialEq)]
pub struct Opts {
    pub memory_mb: Option<u64>,
    pub cpu_percent: Option<u32>,
    pub max_processes: Option<u32>,
    pub stats: Option<PathBuf>,
    pub program: OsString,
    pub args: Vec<OsString>,
}

pub fn parse_args(raw: Vec<OsString>) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = raw.into_iter();
    fn num<T: std::str::FromStr>(v: Option<OsString>, name: &str, min: T, max: T) -> Result<T, String>
    where
        T: PartialOrd + Copy,
    {
        let s = v.ok_or(format!("valeur manquante pour {name}"))?;
        let n: T = s
            .to_str()
            .and_then(|x| x.parse().ok())
            .ok_or(format!("valeur invalide pour {name}"))?;
        if n < min || n > max {
            return Err(format!("valeur hors bornes pour {name}"));
        }
        Ok(n)
    }
    loop {
        let a = it.next().ok_or("programme manquant (après --)")?;
        match a.to_str() {
            Some("--memory-mb") => o.memory_mb = Some(num(it.next(), "--memory-mb", 16u64, 1_048_576)?),
            Some("--cpu-percent") => o.cpu_percent = Some(num(it.next(), "--cpu-percent", 1u32, 100)?),
            Some("--max-processes") => o.max_processes = Some(num(it.next(), "--max-processes", 1u32, 10_000)?),
            Some("--stats") => o.stats = Some(PathBuf::from(it.next().ok_or("valeur manquante pour --stats")?)),
            Some("--") => break,
            _ => return Err(format!("option inconnue : {}", a.to_string_lossy())),
        }
    }
    o.program = it.next().ok_or("programme manquant (après --)")?;
    o.args = it.collect();
    Ok(o)
}

#[derive(Debug, Default)]
pub struct Stats {
    pub exit_code: i64,
    pub peak_job_memory_bytes: u64,
    pub peak_process_memory_bytes: u64,
    pub user_ms: u64,
    pub kernel_ms: u64,
    pub total_processes: u32,
    pub active_processes_at_exit: u32,
    pub memory_limit_hit: bool,
}

pub fn stats_json(s: &Stats, o: &Opts) -> String {
    let opt = |v: Option<u64>| v.map(|x| x.to_string()).unwrap_or_else(|| "null".into());
    format!(
        "{{\"sandbox\":\"job-object\",\"exitCode\":{},\"peakJobMemoryBytes\":{},\"peakProcessMemoryBytes\":{},\"userMs\":{},\"kernelMs\":{},\"totalProcesses\":{},\"activeProcessesAtExit\":{},\"memoryLimitHit\":{},\"limits\":{{\"memoryMb\":{},\"cpuPercent\":{},\"maxProcesses\":{}}}}}",
        s.exit_code,
        s.peak_job_memory_bytes,
        s.peak_process_memory_bytes,
        s.user_ms,
        s.kernel_ms,
        s.total_processes,
        s.active_processes_at_exit,
        s.memory_limit_hit,
        opt(o.memory_mb),
        opt(o.cpu_percent.map(u64::from)),
        opt(o.max_processes.map(u64::from)),
    )
}

#[cfg(windows)]
mod win;

fn main() {
    let opts = match parse_args(std::env::args_os().skip(1).collect()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("hermes-jobrun: {e}");
            std::process::exit(125);
        }
    };
    #[cfg(windows)]
    std::process::exit(win::run(&opts));
    #[cfg(not(windows))]
    {
        let _ = opts;
        eprintln!("hermes-jobrun: Windows uniquement (Job Objects)");
        std::process::exit(125);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn os(v: &[&str]) -> Vec<OsString> {
        v.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_limits_and_command() {
        let o = parse_args(os(&["--memory-mb", "512", "--cpu-percent", "50", "--max-processes", "8", "--stats", "s.json", "--", "git", "status", "--short"])).unwrap();
        assert_eq!(o.memory_mb, Some(512));
        assert_eq!(o.cpu_percent, Some(50));
        assert_eq!(o.max_processes, Some(8));
        assert_eq!(o.stats, Some(PathBuf::from("s.json")));
        assert_eq!(o.program, OsString::from("git"));
        assert_eq!(o.args, os(&["status", "--short"]));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_args(os(&["--cpu-percent", "0", "--", "x"])).is_err());
        assert!(parse_args(os(&["--cpu-percent", "101", "--", "x"])).is_err());
        assert!(parse_args(os(&["--memory-mb", "abc", "--", "x"])).is_err());
        assert!(parse_args(os(&["--unknown", "--", "x"])).is_err());
        assert!(parse_args(os(&["--"])).is_err());
        assert!(parse_args(os(&["git"])).is_err());
    }

    #[test]
    fn writes_stats_json() {
        let o = parse_args(os(&["--memory-mb", "64", "--", "x"])).unwrap();
        let s = Stats { exit_code: 3, peak_job_memory_bytes: 10, memory_limit_hit: true, ..Default::default() };
        let j = stats_json(&s, &o);
        assert!(j.contains("\"exitCode\":3"));
        assert!(j.contains("\"memoryLimitHit\":true"));
        assert!(j.contains("\"limits\":{\"memoryMb\":64,\"cpuPercent\":null,\"maxProcesses\":null}"));
    }
}
