# CodeBuddy Runtime Hardening Requirements

## Context

The credentialed CodeBuddy probe exposed two independent failures: the configured API key is currently rejected with
HTTP 401, while the pinned `@tencent-ai/agent-sdk@0.3.43` turns that rejection into assistant text and then waits
indefinitely for a missing `result` message. The adapter must surface authentication failures promptly and must never
leave a Harness run open forever when a vendor stream omits its terminal event.

## Requirements

1. Keep the CodeBuddy dependency pinned to an exact reviewed version and upgrade it from `0.3.43` to `0.3.254`.
2. Treat a successful vendor `result` as the only path to `run.completed`; assistant text is never a success signal.
3. Map SDK exceptions, vendor error messages, and the legacy assistant-form `401 Unauthorized` signal to
   `run.failed`, with credentials redacted.
4. Bound every run with configurable wall-clock and idle timeouts. A timeout must produce exactly one terminal
   `run.failed` event with error code `RUN_TIMEOUT`.
5. Cancellation must return promptly, produce exactly one `run.cancelled` event, resolve pending interactions, and
   initiate SDK abort/interrupt/iterator cleanup without waiting forever for the vendor.
6. If the stream ends without a vendor `result`, emit `HARNESS_PROTOCOL_ERROR` and retain already emitted partial
   output for diagnostics.
7. Cover successful completion, authentication failure, missing terminal, timeout, cancellation, and credential
   redaction with deterministic offline tests.
8. Keep credentials process-local and out of repository files, test fixtures, logs, and emitted events.

## Acceptance criteria

- A legacy 401 assistant message terminates as `AUTHENTICATION_FAILED` after only a short terminal grace period,
  without waiting for the normal idle watchdog.
- A non-yielding SDK stream terminates within the configured test timeout and does not block the event consumer.
- Cancelling a non-yielding stream completes within the configured shutdown grace period.
- Normal and resumed runs continue to pass the adapter conformance kit.
- `pnpm check` passes without a real CodeBuddy credential.

## Out of scope

- Issuing, refreshing, or revoking a CodeBuddy/WorkBuddy credential.
- Declaring real CodeBuddy production readiness before a new valid credential passes the smoke suite.
- Moving the vendor SDK into a separate sidecar or container; that remains a later isolation milestone.
- Changing the public Harness event protocol or adding CodeBuddy-specific fields to shared contracts.

## Dependencies and constraints

- CodeBuddy remains a Preview dependency and must stay isolated inside `packages/adapter-codebuddy`.
- The in-process SDK does not expose a public force-kill API. The adapter can bound its own lifecycle and invoke the
  SDK's public abort/interrupt/iterator APIs; operating-system process-tree containment remains the SDK's responsibility
  until the sidecar/container milestone.
- Real smoke tests remain opt-in and must never run in normal CI.
