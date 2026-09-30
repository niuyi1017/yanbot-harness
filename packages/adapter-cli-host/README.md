# Generic vendor CLI host

Internal engineering candidate for vendor Sidecar Wrappers. The package has no vendor dependencies and is not
part of the public SDK or platform CLI.

`runVendorCli` requires an absolute executable path, an argv array and an explicit environment. Use
`buildAllowedEnvironment(source, names)` to copy only allowed variables from the chosen source. Arguments are
passed directly with `shell: false`. The current one-shot API closes stdin after startup; interactive input
and credential-directory ownership remain future work.

Stdout is decoded as strict UTF-8 lines, including split code points and CRLF. The host awaits `onStdoutLine`
before delivering another line, applies line and total-output limits, and drains stderr under a separate
byte limit without returning its contents. The Wrapper must parse vendor output, validate the terminal result
and translate it to Harness events. A zero exit code alone does not prove a successful vendor Run.

Startup, total Run, output idle and shutdown deadlines are bounded. An AbortSignal, parser failure or deadline
stops subsequent line delivery and triggers owner cleanup. Already-running asynchronous parser callbacks
must cooperate with cancellation. Public errors contain fixed messages, without vendor output or argv.

`probeVendorVersion` uses the same runner with a smaller output budget and returns the first nonempty stdout
line. The vendor Wrapper must validate it against its pinned version contract before use.

The default POSIX owner starts an independent process group and escalates TERM to KILL while its child remains
owned. Every exit path waits for owner cleanup. After leader exit, the default owner only probes group absence
and reports `CLEANUP_UNVERIFIED` if the group remains; it does not signal a potentially reused PID. Local tests
cover cooperative descendants in that group. This is not proof of containment for detached
or signal-resistant descendants, especially after the leader exits. Windows requires an injected native
process-tree owner and fails before spawn when none is supplied. Windows and Linux certification is pending.

Validation: `pnpm --filter @yanbot-harness/adapter-cli-host test:unit`.
