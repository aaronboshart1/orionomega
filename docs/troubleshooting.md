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

# Check memory subsystem
orionomega status --memory

# Verbose logging for a single session
ORIONOMEGA_LOG_LEVEL=verbose orionomega start
```

Log file location: `~/.orionomega/logs/orionomega.log` (configurable via `logging.file`).

---

## Memory System Issues

### Agent has no memory of previous sessions

**Symptoms:** Agent behaves as if each session is a fresh start. No recall of past decisions, user preferences, or project context.

**Root cause (most common):** Hindsight server not running, or `hindsight.url` misconfigured.

**Diagnosis:**
```bash
# Check if Hindsight is running
curl http://localhost:8888/health

# Check OrionOmega can reach it
orionomega doctor --check memory
```

**Fix:**
1. Start the Hindsight server: `hindsight serve --port 8888`
2. Verify URL in `~/.orionomega/config.yaml`:
   ```yaml
   hindsight:
     url: http://localhost:8888
   ```
3. Restart OrionOmega gateway.

---

### Recall returns 0 results despite memories being stored

**Symptoms:** Log shows `"API returned 0 results"` or `"All N results filtered below relevance threshold"`. The TUI memory panel shows no recalls.

**These are different problems — read the log carefully:**

#### Case A: `"API returned 0 results"`

The Hindsight server found no candidates. Usually means the bank is empty or the query is too short.

```
# Verify memories exist
curl http://localhost:8888/v1/default/banks/core | jq .memory_count
```

If `memory_count` is 0, memories are not being stored. Check `retainOnComplete` is `true` and workflow is completing without error.

#### Case B: `"All N results filtered below relevance threshold"`

The Hindsight server found candidates but the client discarded all of them. Log includes `topScore` — the highest relevance score before filtering.

- If `topScore` is between `0.05` and `0.14`: client-side scoring is active and the threshold is too high. This was the pre-fix behavior. **Upgrade to v0.1.1** which lowers the threshold to `0.15` and uses client-side scoring correctly.
- If `topScore` is `0.00`: all API results had `relevance=0` and client-side fallback also scored them at 0. The query or content may be too short/generic.

**Verify the threshold configuration:**
```bash
grep -r "minRelevance" ~/.orionomega/ 2>/dev/null
# Should be 0.15 or lower, not 0.3
```

---

### Recall effectiveness below 10%

**Symptoms:** Log warning: `"Recall effectiveness critically low: X% surfaced (N/M)"`

This means fewer than 10% of Hindsight's returned results pass the relevance filter. Causes:

1. **Embedding backend not configured** (pre-fix behavior): API returns `relevance=0`, fallback scorer is used. If you see `"client-scored"` in the recall log, this is expected behavior in v0.1.1 — the threshold is already calibrated for this case.

2. **Threshold set too high by a custom caller:** Check if any code passes `minRelevance > 0.15` in recall options.

3. **Structural prefix contamination:** Content stored with `[user]`, `Task:`, or similar prefixes confuses keyword scoring. **v0.1.1 strips these automatically** in the similarity normalizer.

---

### Mental model returns 404 on first run

**Symptoms:** Log shows `"Failed to seed mental model"` or `"GET .../mental-models/user-profile → 404"`.

**This is expected on the very first run.** v0.1.1 seeds mental models automatically via `seedMentalModelsIfNeeded()` — it detects 404 and calls `refreshMentalModel()` to create them.

If seeding itself fails with 404, the `infra` bank may not exist yet. Create it:
```bash
curl -X PUT http://localhost:8888/v1/default/banks/infra \
  -H "Content-Type: application/json" \
  -d '{"name": "Infrastructure map"}'
```

---

### Session summary not being generated

**Symptoms:** End-of-session summaries missing from core bank. Memory does not accumulate across sessions.

**Check 1: Minimum message count.** Summaries require at least 5 messages. Very short test sessions are skipped by design.

**Check 2: Debounce window.** Only 1 summary per 5 minutes. If the gateway disconnects and reconnects rapidly (e.g., development restarts), summaries are throttled.

**Check 3: Retry exhaustion.** If the Hindsight server was unreachable for all 3 retry attempts (500ms, 1000ms, 2000ms), the summary is dropped. Check Hindsight server health and logs.

**Check 4: LLM call failure.** The summarizer uses the `cheap` model. If `models.cheap` is not configured or returns an error, summary generation fails. Check Anthropic API key validity.

---

### Hot window lost after gateway restart

**Symptoms:** Agent loses recent context after restart. First message each session is treated as fresh.

**Fix:** Enable disk persistence for the hot window in your config or directly in code:

```yaml
# There is no YAML key for this — set programmatically:
# config.contextAssembler.persistPath = '~/.orionomega/hot-window.json'
```

If `persistPath` is not set, the hot window lives in memory only and is lost on restart. This is the current default. Set it during ContextAssembler construction.

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
| `"Memory subsystem init failed"` | Hindsight unreachable on startup | Check Hindsight service |
| `"All N results filtered"` | Relevance threshold too high | Verify v0.1.1+ is installed |
| `"Recall effectiveness critically low"` | <10% of results passing filter | Check scoring configuration |
| `"Worker timed out"` | Worker exceeded timeout | Increase `workerTimeout` |
| `"Session summary failed after retries"` | Hindsight or LLM unavailable | Check both services |
| `"maxSpawnDepth exceeded"` | Recursive agent spawn blocked | Increase limit or restructure task |
| `"Memory flush failed"` | Pre-compaction flush error | Check Hindsight health |
| `"Mental model seeding failed"` | Model creation failed on first run | Check bank exists |

**Enable verbose logging to see full memory pipeline:**
```bash
ORIONOMEGA_LOG_LEVEL=verbose orionomega start 2>&1 | grep -E "(Recall|Retain|similarity|relevance)"
```
