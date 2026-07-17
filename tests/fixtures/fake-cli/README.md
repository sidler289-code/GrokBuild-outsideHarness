# Fake CLI fixtures

Phase 2 includes deterministic Claude and Codex stand-ins here for candidate
selection, timeout, truncation, error classification, and malformed-output
tests. They must never contact a network service or read outside their test
directory.
