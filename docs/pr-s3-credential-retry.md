# PR: Fix S3 credential expiry causing CubeStore failures

## Problem

CubeStore pods in production (us-com-1) experience cascading failures when IRSA (IAM Roles for Service Accounts) credentials expire. The failure sequence:

1. Kubernetes projects a service account token (JWT) into the pod via a volume mount
2. CubeStore's background credential refresh loop periodically re-reads the token and calls STS `AssumeRoleWithWebIdentity`
3. When the kubelet is slow to rotate the projected token (or the token file is briefly stale during rotation), the refresh loop re-reads the **same expired token** and gets back expired credentials
4. All subsequent S3 operations (upload, download, delete) fail with **401/403** (`ExpiredToken`)
5. CubeStore has no recovery path — it continues retrying with the stale credentials indefinitely, causing the pod to be stuck in a broken state without triggering a restart

### Impact

- CubeStore router/workers become non-functional but remain "healthy" (liveness probe passes since it doesn't check S3 connectivity)
- Queries that require pre-aggregation data or result caching fail silently
- The pod never restarts because it doesn't crash — it just logs errors forever
- Manual intervention (pod delete) is required to recover

### Observed in production

```
ERROR cubestore::remotefs::s3: S3 upload returned non OK status: 403
ERROR cubestore::remotefs::s3: S3 download returned non OK status: 401
```

These errors repeat indefinitely without recovery.

---

## Solution

Add credential refresh + retry logic to all S3 operations (upload, download, delete) with a configurable exit threshold for unrecoverable failures.

### Behavior

```
S3 operation fails with 401/403
    │
    ├──► Force immediate credential refresh
    │    (re-read token file → STS AssumeRoleWithWebIdentity → new credentials)
    │
    ├──► Retry the failed operation with new credentials
    │
    ├──► Success? → Reset consecutive failure counter → Continue normally
    │
    └──► Still 401/403? → Increment consecutive failure counter
                          │
                          └──► Counter >= CUBESTORE_S3_MAX_AUTH_RETRIES?
                               ├── No  → Return error (caller may retry later)
                               └── Yes → Exit process (code 1) → K8s restarts pod
```

### Why exit the process?

If credential refresh + retry still fails, the IRSA token on disk is likely stale and will remain stale until the kubelet performs rotation. The fastest recovery path is a pod restart, which:

1. Triggers a new projected token mount from the kubelet
2. Starts the pod with fresh credentials from STS
3. Is handled automatically by Kubernetes (no manual intervention)

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `CUBESTORE_S3_MAX_AUTH_RETRIES` | `1` | Max consecutive auth failures (across all operations) before the process exits. Set higher if transient STS failures are expected. |

With the default of `1`, the first auth error that persists after a credential refresh causes an immediate exit. This is intentionally aggressive — a single post-refresh failure strongly indicates the token file itself is stale.

---

## Changes

**File:** `rust/cubestore/cubestore/src/remotefs/s3.rs`

### New fields on `S3RemoteFs`

- `consecutive_auth_failures: AtomicU32` — tracks consecutive auth failures across all operations; reset to 0 on any successful S3 operation
- `max_auth_retries: u32` — threshold from `CUBESTORE_S3_MAX_AUTH_RETRIES` env var

### New methods

| Method | Purpose |
|--------|---------|
| `is_auth_error(status_code)` | Returns true for 401/403 |
| `force_refresh_credentials()` | Re-reads web identity token file, calls STS, swaps bucket credentials |
| `reset_auth_failures()` | Resets counter to 0 (called on success) |
| `record_auth_failure(op, status)` | Increments counter, exits if threshold reached |

### Modified operations

- **`upload_file`** — wraps `put_object_stream` with auth-error detection, refresh, and retry
- **`download_file`** — wraps `get_object_stream` with auth-error detection, refresh, retry (truncates temp file before retry)
- **`delete_file`** — wraps `delete_object` with auth-error detection, refresh, and retry

Each operation follows the same pattern:
1. Attempt operation
2. If 401/403 → `force_refresh_credentials()` → retry
3. If retry also 401/403 → `record_auth_failure()` (may exit)
4. If success → `reset_auth_failures()`

---

## Testing

### Manual validation

1. Deploy to a test cluster with IRSA
2. Manually expire the projected token (delete and let kubelet re-project)
3. Observe: CubeStore detects 403, refreshes credentials, retries successfully
4. Force persistent failure (invalid role ARN): CubeStore exits after threshold, pod restarts

### Edge cases considered

- **Race condition on `consecutive_auth_failures`**: Uses `AtomicU32` with `Relaxed` ordering — acceptable since this is a best-effort threshold (exact count doesn't need to be serialized across operations)
- **Concurrent operations**: Multiple operations may all trigger refresh simultaneously. The last `bucket.swap()` wins, which is fine since all would get the same new credentials
- **Download retry file state**: The temp file is truncated and rewound (`seek(0)` + `set_len(0)`) before retry to avoid corrupted partial data

---

## Related

- **Branch:** `fix/s3-retry-on-expired-token`
- **Base:** `v1.6.39` (upstream cubejs/cube `master`)
- **Deployment:** CubeStore runs as 1 router + 4 workers in atlas-cubejs Helm chart
- **IRSA config:** Pod uses `eks.amazonaws.com/role-arn` annotation, kubelet mounts token at `/var/run/secrets/eks.amazonaws.com/serviceaccount/token`
