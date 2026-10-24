//! Windows implementation: Job Object with limits, suspended child, accounting.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAndIoAccountingInformation,
    JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, INFINITE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

use crate::quote::command_line;
use crate::{stats_json, Opts, Stats};

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn fail(what: &str) -> i32 {
    eprintln!("hermes-jobrun: {what} (erreur Windows {})", unsafe { GetLastError() });
    125
}

/// Closes the job handle when dropped: KILL_ON_JOB_CLOSE then ends every remaining process.
struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

pub fn run(o: &Opts) -> i32 {
    unsafe {
        let job = Owned(CreateJobObjectW(null(), null()));
        if job.0.is_null() {
            return fail("CreateJobObjectW");
        }

        let mut ext: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        ext.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if let Some(mb) = o.memory_mb {
            ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            ext.JobMemoryLimit = (mb * 1024 * 1024) as usize;
        }
        if let Some(n) = o.max_processes {
            ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            ext.BasicLimitInformation.ActiveProcessLimit = n;
        }
        if SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &ext as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            return fail("SetInformationJobObject (limites)");
        }
        if let Some(pct) = o.cpu_percent {
            // CpuRate is expressed in 1/100 of a percent of the whole machine.
            let cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 { CpuRate: pct * 100 },
            };
            if SetInformationJobObject(
                job.0,
                JobObjectCpuRateControlInformation,
                &cpu as *const _ as *const c_void,
                size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
            ) == 0
            {
                return fail("SetInformationJobObject (CPU)");
            }
        }

        let program = o.program.to_string_lossy().into_owned();
        let args: Vec<String> = o.args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        let app = wide(&program);
        let mut cmd = wide(&command_line(&program, &args));

        let mut si: STARTUPINFOW = zeroed();
        si.cb = size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        let mut pi: PROCESS_INFORMATION = zeroed();
        // Suspended: nothing runs before the process belongs to the job.
        if CreateProcessW(
            app.as_ptr(),
            cmd.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            null(),
            null(),
            &si,
            &mut pi,
        ) == 0
        {
            return fail(&format!("CreateProcessW({program})"));
        }
        let process = Owned(pi.hProcess);
        let thread = Owned(pi.hThread);
        if AssignProcessToJobObject(job.0, process.0) == 0 {
            TerminateProcess(process.0, 125);
            return fail("AssignProcessToJobObject");
        }
        if ResumeThread(thread.0) == u32::MAX {
            TerminateProcess(process.0, 125);
            return fail("ResumeThread");
        }
        if WaitForSingleObject(process.0, INFINITE) != WAIT_OBJECT_0 {
            return fail("WaitForSingleObject");
        }
        let mut code: u32 = 0;
        GetExitCodeProcess(process.0, &mut code);

        if let Some(path) = &o.stats {
            let mut acc: JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION = zeroed();
            let mut lim: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            QueryInformationJobObject(
                job.0,
                JobObjectBasicAndIoAccountingInformation,
                &mut acc as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            );
            QueryInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &mut lim as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                null_mut(),
            );
            let peak = lim.PeakJobMemoryUsed as u64;
            let s = Stats {
                exit_code: code as i64,
                peak_job_memory_bytes: peak,
                peak_process_memory_bytes: lim.PeakProcessMemoryUsed as u64,
                // Times are in 100-nanosecond units.
                user_ms: (acc.BasicInfo.TotalUserTime / 10_000) as u64,
                kernel_ms: (acc.BasicInfo.TotalKernelTime / 10_000) as u64,
                total_processes: acc.BasicInfo.TotalProcesses,
                active_processes_at_exit: acc.BasicInfo.ActiveProcesses,
                // A commit refused at the limit usually ends the process: near-limit peaks are reported.
                memory_limit_hit: o.memory_mb.is_some_and(|mb| peak + 4 * 1024 * 1024 >= mb * 1024 * 1024),
            };
            if let Err(e) = std::fs::write(path, stats_json(&s, o)) {
                eprintln!("hermes-jobrun: statistiques non écrites : {e}");
            }
        }
        drop(thread);
        drop(process);
        drop(job); // remaining descendants are killed here
        code as i32
    }
}
