# Troubleshooting Guide

**OrionOmega v0.1.1 — Enterprise Documentation**

---

## Diagnostic Tools

Before diving into specific issues, use the built-in diagnostic commands:

```bash
# Check overall system health
orionomega doctor

# View live logs
orionomega logs --follow

# Check the memory subsystem (PINGs Redis, prints the redacted URL)
orionomega status

# Verbose logging for a single session
ORIONOMEGA_LOG_LEVEL=verbose orionomega start
```

Log file location: `~/.orionomega/logs/orionomega.log` (configurable via `logging.file`).

---

## Memory System Issues

### Read the health state first

Memory does not report a connected/disconnected flag. It reports what recall can
currently **do**, which is what actually matters to you:

| `health` | Meaning | What to do |
|----------|---------|------------|
| `ready` | Redis is reachable and the in-process index is fully hydrated | Nothing |
| `rebuilding` | The index is warming from Redis. Recall will under-return until it finishes | Wait; large corpora take tens of seconds |
| `degraded` | Redis is unreachable, or a write failed | Fix Redis (below) |

A `reason` accompanies the non-`ready` states: `redis_unreachable`,
`index_cold`, or `write_failed`. The status bar and the web UI System Health
card render this; `orionomega status` prints it too.

---

### Agent has no memory of previous sessions

**Symptoms:** Agent behaves as if each session is a fresh start. No recall of past decisions, user preferences, or project context.

**Root cause (most common):** Redis is not running, or `memory.redis.url` is misconfigured.

**Diagnosis:**
```bash
# Is Redis up?
redis-cli ping           # expects: PONG

# Can OrionOmega reach it? (issues a PING, prints the redacted URL)
orionomega status
orionomega doctor
```

**Fix:**
1. Start Redis. OrionOmega never provisions it — see the
   [Quick Start prerequisites](getting-started.md#prerequisites) for the command
   on your platform.
2. Verify the URL in `~/.orionomega/config.yaml`:
   ```yaml
   memory:
     redis:
       url: redis://localhost:6379
   ```
3. Restart the OrionOmega gateway.

If `redis-cli ping` returns `NOAUTH Authentication required`, Redis is up but
wants a password — set `memory.redis.password`, or put the credentials in the
URL (`redis://user:pass@host:6379`).

---

### Recall returns 0 results despite records being stored

`memory_search` returns an explicit `NO_RESULTS` marker with the corpus size and
the threshold it used, so the two failure modes are distinguishable:

#### Case A: the searched count is 0 or implausibly small

Nothing is indexed. Two causes:

- **The index is still hydrating.** Health is `rebuilding`. Wait for `ready`.
- **Nothing is being written.** Check `memory.retainOnComplete` is `true` and
  that workflows are finishing without error. Confirm records exist directly:
  ```bash
  redis-cli --scan --pattern 'om:*' | head
  ```
  (Substitute your `memory.redis.keyPrefix` if you changed it from `om:`.)

#### Case B: the corpus is large but nothing cleared the threshold

Retrieval is **lexical only** — keyword overlap plus character-trigram Jaccard,
scored exactly as `computeClientRelevance` does. There are no embeddings, so a
query that shares no vocabulary with the stored text will not match no matter
how semantically close it is. Rephrase with words that actually appear in the
material, or lower `memory.minRelevance`.

#### Case C: you are searching for file contents or command output

**Tool results are stored but not indexed.** They are deliberately kept out of
the search corpus because they dominate volume and pollute term statistics. They
are reachable only through `memory_read` — by segment id from the Memory Map, or
by `{around: seq, radius: n}`.

---

### The agent keeps searching memory and getting nowhere

There is a per-turn call budget: 3 `memory_search` and 2 `memory_read` calls.
Past the cap the tools hard-refuse with a `REFUSED —` message. That is working
as designed — it exists because a zero-result search is a *successful* tool call,
so without the cap an agent that finds nothing can rephrase and retry forever.

If you are seeing refusals routinely, the corpus probably lacks what is being
asked for; see Case B above.

---

### Session summary not being generated

**Symptoms:** End-of-session summaries missing from the `core` scope. Memory does not accumulate across sessions.

**Check 1: The feature is enabled.** `memory.sessionSummary` defaults to `true`;
confirm it has not been turned off.

**Check 2: Minimum message count.** Summaries require at least 5 messages. Very short test sessions are skipped by design.

**Check 3: Debounce window.** Only 1 summary per 5 minutes. If the gateway disconnects and reconnects rapidly (e.g., development restarts), summaries are throttled.

**Check 4: Retry exhaustion.** If the write failed for all 3 retry attempts (500ms, 1000ms, 2000ms), the summary is dropped. Check Redis health.

**Check 5: LLM call failure.** The summarizer uses the `cheap` model. If `models.cheap` is not configured or returns an error, summary generation fails. Check Anthropic API key validity.

---

### Redis is shared with the task queue and jobs are disappearing

BullMQ requires `maxmemory-policy noeviction` or it silently drops jobs, and
that policy is **instance-wide** — selecting a different `db` does not isolate
it. If you have set `orchestration.queue.backend: redis` against the same
instance memory uses, pin the policy:

```bash
redis-cli config set maxmemory-policy noeviction
```

Make it permanent in `redis.conf`. Alternatively point `memory.redis.url` at a
second Redis instance — it is its own config key precisely so you can.

---

### Hot window lost after gateway restart

**Symptoms:** Agent loses recent context after restart. First message each session is treated as fresh.

**Fix:** Enable disk persistence for the hot window in your config or directly in code:

```yaml
# There is no YAML key for this — set programmatically:
# config.contextAssembler.persistPath = '~/.orionomega/hot-window.json'
```

If `persistPath` is not set, the hot window lives in memory only and is lost on restart. This is the current default. Set it during ContextAssembler construction.

Note that only the *verbatim* window is lost. The messages themselves were
already written to Redis, so they remain reachable through recall, the Memory
Map, and `memory_read` — they just stop being reproduced word-for-word at the
top of the turn.

---

## Gateway Issues

### Gateway fails to start: `EADDRINUSE`

Port already in use. Either another OrionOmega instance is running, or another process owns the port.

```bash
# Find what's using port 8000
lsof -i :8000

# Kill it if appropriate
kill -9 <PID>

# Or change the port in config
# gateway.port: 8001
```

---

### WebSocket connections drop after 60 seconds

Most reverse proxies (nginx, caddy) default to a 60s idle timeout. Configure keepalives:

**nginx:**
```nginx
location /ws {
    proxy_pass http://localhost:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

**Caddy:**
```
reverse_proxy localhost:8000 {
    transport http {
        read_timeout 1h
        write_timeout 1h
    }
}
```

---

### 401 Unauthorized on all requests

**Check 1:** `Authorization` header format must be exactly:
```
Authorization: Bearer <your-key>
```
Not `Token`, not `Basic`.

**Check 2:** The key hash in config must match `SHA-256` of the plain key:
```bash
echo -n "your-key" | sha256sum
# Compare output to gateway.auth.keyHash in config
```

**Check 3:** If using WebSocket, pass the key as a query parameter or in the upgrade headers, not in the body.

---

### CORS errors in browser

**Symptom:** Browser console shows `"CORS policy: No 'Access-Control-Allow-Origin'"`.

**Fix:** Add your web UI origin to the allowed list:

```yaml
gateway:
  cors:
    origins:
      - 'http://localhost:3000'
      - 'https://my-company-dashboard.internal'
```

Wildcard `*` is supported but not recommended when auth is enabled.

---

## Workflow Execution Issues

### Worker timed out

**Symptom:** `node_error` event with `"Worker timed out after 300s"`.

The default worker timeout is 300 seconds (5 minutes). For long-running tasks:

```yaml
orchestration:
  workerTimeout: 900  # 15 minutes
```

Per-node timeout overrides are not supported in v0.1.1.

---

### Workflow stuck at planning stage

**Symptoms:** `thinking` events arrive but `plan` never follows. Gateway log shows repeated planner calls.

**Possible causes:**
1. **Planner model rate limit:** Reduce planner call frequency or upgrade your Anthropic tier.
2. **Task too vague:** Add more specific instructions. The planner works best with concrete, actionable requests.
3. **maxSpawnDepth exceeded:** If a nested agent is trying to spawn more workers than `orchestration.maxSpawnDepth` allows, planning fails silently. Increase the limit or restructure the task.

---

### Interrupted workflow not resuming

**Symptoms:** After a gateway restart, interrupted workflow does not continue. `autoResume` is `true`.

**Diagnosis:**
```bash
ls ~/.orionomega/checkpoints/
# Should contain checkpoint files for interrupted workflows
```

If checkpoints are empty or missing, the checkpoint interval elapsed between writes. Lower the interval:

```yaml
orchestration:
  checkpointInterval: 15  # Write every 15 seconds (default: 30)
```

**Note:** Workflows interrupted during a planning step (before any node executed) cannot be resumed — they restart from the beginning.

---

### High API spend / unexpected billing

**Symptoms:** Anthropic API spend is higher than expected.

**Check 1: Worker model assignment.** Verify expensive models are not being used for cheap tasks:
```yaml
models:
  workers:
    research: claude-haiku-4-5-20251001   # not claude-opus-*
    analysis: claude-haiku-4-5-20251001
```

**Check 2: Autonomous mode budget.** If `autonomous.enabled: true`, verify `maxBudgetUsd` is set:
```yaml
autonomous:
  maxBudgetUsd: 10  # Hard cap in USD
```

**Check 3: Session summarizer model.** The `cheap` model is used for summaries. If unset, falls back to `default`:
```yaml
models:
  cheap: claude-haiku-4-5-20251001
```

---

## Skills Issues

### Skill not loading / `skill not found`

**Diagnosis:**
```bash
orionomega skill list
orionomega skill health <name>
```

**Check 1:** Skill directory exists and contains a valid `manifest.json`:
```bash
ls ~/.orionomega/skills/my-skill/manifest.json
```

**Check 2:** `skills.directory` in config points to the right location:
```yaml
skills:
  directory: ~/.orionomega/skills
  autoLoad: true
```

**Check 3:** Manifest JSON is valid. Validate with:
```bash
cat ~/.orionomega/skills/my-skill/manifest.json | python3 -m json.tool
```

---

### Skill health check failing

**Symptoms:** `orionomega skill health <name>` shows `healthy: false`.

If using `BaseSkill`, the `getHealth()` method returns `healthy: false` when `!initialized || !active`. Check initialization:

1. Is the required secret/setting configured? (`orionomega skill setup <name>`)
2. Can the skill reach its upstream service? (network connectivity check)
3. Does the handler script exist? (`ls ~/.orionomega/skills/<name>/handlers/`)

---

### Skill settings not persisting after restart

Settings are written to `~/.orionomega/config.yaml` with `0o600` permissions. Verify:

```bash
ls -la ~/.orionomega/config.yaml
# Should show: -rw------- (600)

grep -A 20 "skills:" ~/.orionomega/config.yaml
```

If settings are missing, the skill may have been set up via CLI (`orionomega skill setup`) which writes to environment variables rather than config. Migrate to the `settings` block approach (see `MIGRATION.md`).

---

## Log Reference

Key log patterns to search for:

| Pattern | Meaning | Action |
|---------|---------|--------|
| `"Memory subsystem init failed"` | Redis unreachable on startup | `redis-cli ping`; check `memory.redis.url` |
| `"redis_unreachable"` | Health went `degraded` mid-session | Restart Redis; the store reconnects |
| `"index_cold"` | Health is `rebuilding` — index still hydrating | Wait; recall improves as it warms |
| `"write_failed"` | A retain did not land durably | Check Redis disk/memory limits and `maxmemory-policy` |
| `"NO_RESULTS"` | A `memory_search` matched nothing above threshold | See "Recall returns 0 results" above |
| `"REFUSED — memory_search limit reached"` | Per-turn tool budget exhausted | Expected guard; see above |
| `"Worker timed out"` | Worker exceeded timeout | Increase `workerTimeout` |
| `"Session summary failed after retries"` | Redis or the LLM was unavailable | Check both |
| `"maxSpawnDepth exceeded"` | Recursive agent spawn blocked | Increase limit or restructure task |

**Enable verbose logging to see full memory pipeline:**
```bash
ORIONOMEGA_LOG_LEVEL=verbose orionomega start 2>&1 | grep -E "(Recall|Retain|similarity|relevance)"
```
