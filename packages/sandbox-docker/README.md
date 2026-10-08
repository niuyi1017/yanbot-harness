# Docker Sandbox Adapter

A deployment-only Adapter facade around a fixed Linux guest. It validates an immutable image reference, copies a bounded immutable snapshot through stdin,
and uses the existing Sidecar protocol. It accepts no runtime credentials or arbitrary commands. Containers run non-root with no network, no host bind mounts,
read-only rootfs, bounded tmpfs/CPU/memory/PIDs, and disabled persistent Docker logs.

Cancellation and disposal remove the immutable container ID and verify absence. The guest exits after a 10-second launcher lease gap. An unstarted-create reaper
runs in sandbox Workers at startup and every 15 seconds; it only removes labelled, correctly named created containers older than 60 seconds, without force.

This is an engineering candidate. Paid vendor access, credential brokering, egress, production control-plane deployment, persistent sessions and recovery are not enabled.
See `docs/delivery/four-mode-engineering-preview.md` and `docs/specs/remote-sandbox-executor/` in the repository.
