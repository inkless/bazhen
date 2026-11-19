#![no_main]

use bazhen_holder::process::{
    cmdline_args, procargs2_args, procargs2_env, status_credentials, status_uid,
};
use libfuzzer_sys::fuzz_target;

// Any bytes, as `/proc/<pid>/cmdline` holds them once a program rewrites its own arguments, or as
// `/proc/<pid>/status` or `KERN_PROCARGS2` could: no reader may panic, a status's whole credentials
// hold the effective uid it reads alone, a cmdline splits into one argument more than the NULs
// inside it, and a `KERN_PROCARGS2` answer names exactly as many arguments as it says it holds, or
// none, and an environment just when it names the arguments.
fuzz_target!(|data: &[u8]| {
    let uid = status_uid(data);
    if let Some(credentials) = status_credentials(data) {
        assert_eq!(uid, Some(credentials.uids[1]));
    }
    let inner = data.strip_suffix(b"\0").unwrap_or(data);
    let nuls = inner.iter().filter(|&&b| b == 0).count();
    let expected = if data.is_empty() { 0 } else { nuls + 1 };
    assert_eq!(cmdline_args(data).len(), expected);
    if let Some(args) = procargs2_args(data) {
        let said = data
            .first_chunk::<4>()
            .and_then(|count| usize::try_from(i32::from_ne_bytes(*count)).ok());
        assert_eq!(Some(args.len()), said);
    }
    assert_eq!(
        procargs2_env(data).is_some(),
        procargs2_args(data).is_some()
    );
});
