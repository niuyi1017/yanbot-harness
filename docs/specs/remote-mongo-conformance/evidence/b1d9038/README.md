# Real Mongo persistence evidence

Source `b1d9038d25efc4ff46a5c87ac6b06061193fa275`.
[CI 37817039436](https://github.com/niuyi1017/yanbot-harness/actions/runs/37817039436).

MongoDB 8.0.32, single-node replica set. Eight tests passed; none failed or skipped.
The report covers legacy index migration, sequential no-key runs, concurrent idempotency, Session locking, organization admission,
transaction rollback, durable refresh-reuse revocation, and reconnection with tenant/cursor isolation.

This is actual engine evidence. It does not certify production credentials, TLS, backups or multi-node failover.
The complete Worker path still used the memory store at this commit; a subsequent gate adds Mongo to that path.
