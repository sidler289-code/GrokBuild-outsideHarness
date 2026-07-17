# Phase 2 verification

Date: 2026-07-17

PowerShell and POSIX bridges implement executable candidate enumeration, five-second semantic-version probes, native-over-WSL tie selection, retained program/prefix/distro identity, real `wslpath` conversion, bounded stdout/stderr, unique temporary directories, timeout tree termination, strict output normalization, and classified degradation.

Both matrices passed:

```text
Phase 2 PowerShell probe and runner matrix passed.
Phase 2 POSIX probe and runner matrix passed.
```

Coverage includes stale/new/broken candidates, explicit override failure, fake WSL distribution/path conversion, prompt-on-stdin, unique `-o`, success, quota, authentication, permission, timeout, process failure, malformed/missing/oversized output, truncation, and cleanup. JSON Schema draft 2020-12 validation and PowerShell/POSIX syntax checks passed. Gate 2 passed.
