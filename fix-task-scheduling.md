# Fix Task Scheduling System

## 1. Problem Summary

The task scheduling system (added in commit `42fdcad`) has multiple bugs across the frontend and backend that make it non-functional in practice. An audit run (`786a3968-2520-4e1a-80ab-d30762f69804`) dispatched to evaluate the implementation had one node (`read-server-types`) fail with `SDK error_max_turns: max turns reached`, but the 5 successful nodes plus direct code review revealed the following critical issues:

1. **The web UI calls wrong API endpoints** — pause, resume, and manual-run buttons all hit non-existent endpoints, so these actions silently fail.
2. **Stale task data in cron callbacks** — the scheduler captures a snapshot of task data at mount time and never refreshes it, so edits to prompt/mode/timeout are ignored until the cron expression itself changes.
3. **`runCount` is corrupted** — increments use the stale mount-time snapshot instead of the current DB value.
4. **`sessionId` is stored but never used** — all scheduled tasks execute in the MainAgent's current session context, polluting the user's active conversation.
5. **`maxRetries` is stored but never used** — failures are recorded with no retry attempt.
6. **`overlapPolicy: 'queue'` is not implemented** — it silently behaves like `allow`.
7. **`nextRunAt` is not updated on failure** — the DB shows a stale value after errors.

---

## 2. Root Cause Analysis

### 2a. Frontend API Mismatch (SchedulesTab.tsx)

The `TaskRow.doAction()` function at `packages/web/src/components/settings/SchedulesTab.tsx:356-374` uses the wrong HTTP methods and paths:

| Action | Frontend sends | Backend expects |
|--------|---------------|-----------------|
| **Run** | `POST /api/gateway/api/schedules/:id/run` | `POST /api/gateway/api/schedules/:id/trigger` |
| **Pause** | `PATCH /api/gateway/api/schedules/:id` with `{status:"paused"}` | `POST /api/gateway/api/schedules/:id/pause` |
| **Resume** | `PATCH /api/gateway/api/schedules/:id` with `{status:"active"}` | `POST /api/gateway/api/schedules/:id/resume` |

The backend has no `PATCH` handler and no `/run` endpoint. The routes are defined in `packages/gateway/src/server.ts:1342-1370` and match `/api/schedules/:id/(pause|resume|trigger)` with `POST`.

### 2b. Stale Task Data in Cron Closure (scheduler.ts)

`mountJob()` at `packages/gateway/src/scheduler.ts:343-371` creates a Cron callback that captures the `task` object:

```typescript
() => {
  this.executeTask(task, 'cron').catch(...)  // `task` is a stale snapshot
}
```

`updateTask()` at line 243 only remounts the job when `cronExpr` or `timezone` changes:

```typescript
if (cronChanged && updated.status === 'active') {
  this.unmountJob(id);
  this.mountJob(updated);
}
```

Edits to `prompt`, `agentMode`, `overlapPolicy`, `timeoutSec`, or `maxRetries` are silently ignored until the next remount.

### 2c. runCount Corruption (scheduler.ts)

At `packages/gateway/src/scheduler.ts:484`:

```typescript
runCount: task.runCount + 1  // uses stale mount-time value
```

After 3 executions, if the task was mounted with `runCount: 0`, each execution sets it to `1` instead of incrementing correctly.

### 2d. sessionId Not Passed to MainAgent (scheduler.ts)

At `packages/gateway/src/scheduler.ts:441-446`:

```typescript
const executePromise = this.mainAgent.handleMessage(
  task.prompt,
  undefined,  // replyContext
  undefined,  // attachments
  agentMode,  // no sessionId parameter
);
```

The `handleMessage()` signature doesn't accept a `sessionId`, so scheduled tasks run in whatever session context the MainAgent currently has. This is a design gap — but the fix should at minimum set the active session before executing.

### 2e. maxRetries Never Used (scheduler.ts)

The error handler at `packages/gateway/src/scheduler.ts:512-551` records the failure but never retries, even when `task.maxRetries > 0`.

### 2f. Overlap Policy 'queue' Not Implemented (scheduler.ts)

At `packages/gateway/src/scheduler.ts:384-400`, only `skip` is checked:

```typescript
if (this.running.has(task.id) && task.overlapPolicy === 'skip') {
  // ...skip logic
  return;
}
```

When `overlapPolicy` is `'queue'`, execution falls through with no queuing — it behaves like `'allow'`.

### 2g. nextRunAt Not Updated on Failure (scheduler.ts)

The success path recalculates `nextRunAt` at line 470-476, but the error path at line 528-534 does not.

---

## 3. Affected Files

| File | Changes |
|------|---------|
| `packages/gateway/src/scheduler.ts` | Fix stale data, runCount, retries, overlap queue, nextRunAt on error |
| `packages/web/src/components/settings/SchedulesTab.tsx` | Fix API endpoint paths and HTTP methods |

No new files, no schema changes, no migration changes needed.

---

## 4. Implementation Plan

### Step 1: Fix Frontend API Endpoints

**File:** `packages/web/src/components/settings/SchedulesTab.tsx`

Replace the `doAction` function body (lines 356-374) with correct API calls:

```typescript
const doAction = async (action: 'run' | 'pause' | 'resume' | 'delete') => {
  setActioning(action);
  try {
    if (action === 'run') {
      await fetch(`/api/gateway/api/schedules/${task.id}/trigger`, { method: 'POST' });
    } else if (action === 'pause') {
      await fetch(`/api/gateway/api/schedules/${task.id}/pause`, { method: 'POST' });
    } else if (action === 'resume') {
      await fetch(`/api/gateway/api/schedules/${task.id}/resume`, { method: 'POST' });
    } else if (action === 'delete') {
      await fetch(`/api/gateway/api/schedules/${task.id}`, { method: 'DELETE' });
    }
    onAction();
  } catch { /* ignore */ } finally {
    setActioning(null);
  }
};
```

### Step 2: Fix Stale Task Data — Fetch Fresh From DB at Execution Time

**File:** `packages/gateway/src/scheduler.ts`

**2a.** Change `mountJob()` to only capture `task.id` in the closure, not the full task object:

```typescript
private mountJob(task: ScheduledTask): void {
  if (this.jobs.has(task.id)) {
    this.unmountJob(task.id);
  }

  const taskId = task.id; // capture only the ID

  try {
    const job = new Cron(
      task.cronExpr,
      {
        timezone: task.timezone,
        protect: true,
        catch: (err) => {
          log.error(`Cron catch handler for task ${taskId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
      () => {
        this.executeTaskById(taskId, 'cron').catch((err) => {
          log.error(`Execution error for task ${taskId}`, { error: (err as Error).message });
        });
      },
    );
    this.jobs.set(task.id, job);
    log.verbose(`Mounted cron job for task ${task.name} (${task.id}): ${task.cronExpr}`);
  } catch (err) {
    log.error(`Failed to mount cron job for task ${task.id}`, { error: (err as Error).message });
  }
}
```

**2b.** Add a new `executeTaskById()` method that fetches fresh task data:

```typescript
private async executeTaskById(taskId: string, triggerType: TriggerType): Promise<void> {
  const task = await this.getTask(taskId);
  if (!task || task.status === 'deleted') {
    log.warn(`Task ${taskId} not found or deleted — skipping execution`);
    return;
  }
  if (task.status === 'paused') {
    log.info(`Task ${taskId} is paused — skipping execution`);
    return;
  }
  await this.executeTask(task, triggerType);
}
```

**2c.** Update `triggerTask()` to use `executeTaskById()`:

```typescript
triggerTask(id: string): void {
  this.executeTaskById(id, 'manual').catch((err) => {
    log.error(`Manual trigger error for task ${id}`, { error: (err as Error).message });
  });
}
```

### Step 3: Fix runCount — Use SQL Increment Instead of Stale Value

**File:** `packages/gateway/src/scheduler.ts`

In `executeTask()`, replace the hardcoded `runCount: task.runCount + 1` (appears in both the success path ~line 484 and error path ~line 531) with a SQL-based increment.

**Success path** (around line 479-487):
```typescript
await db
  .update(scheduledTasks)
  .set({
    lastStatus: 'completed',
    nextRunAt,
    runCount: sql`run_count + 1`,
    updatedAt: completedAt,
  })
  .where(eq(scheduledTasks.id, task.id));
```

**Error path** (around line 528-534):
```typescript
await db
  .update(scheduledTasks)
  .set({
    lastStatus: status,
    runCount: sql`run_count + 1`,
    updatedAt: completedAt,
  })
  .where(eq(scheduledTasks.id, task.id));
```

Add the `sql` import at the top of the file:
```typescript
import { eq, ne, desc, sql } from 'drizzle-orm';
```

### Step 4: Fix nextRunAt on Failure

**File:** `packages/gateway/src/scheduler.ts`

In the `catch` block of `executeTask()` (around line 520-537), add `nextRunAt` recalculation:

```typescript
// Recalculate nextRunAt even on failure
let nextRunAt: string | null = null;
try {
  const nextJob = new Cron(task.cronExpr, { timezone: task.timezone });
  const next = nextJob.nextRun();
  nextRunAt = next ? next.toISOString() : null;
  nextJob.stop();
} catch { /* keep null */ }

try {
  await db
    .update(taskExecutions)
    .set({ status, completedAt, durationSec, error: errorMsg })
    .where(eq(taskExecutions.id, executionId));

  await db
    .update(scheduledTasks)
    .set({
      lastStatus: status,
      nextRunAt,
      runCount: sql`run_count + 1`,
      updatedAt: completedAt,
    })
    .where(eq(scheduledTasks.id, task.id));
} catch (dbErr) {
  log.error('Failed to update task execution record', { error: (dbErr as Error).message });
}
```

### Step 5: Implement maxRetries

**File:** `packages/gateway/src/scheduler.ts`

Add retry logic to `executeTask()`. After the catch block records the failure, check if retries should be attempted. Add a `retryCount` parameter (default 0):

Change the `executeTask` signature:
```typescript
private async executeTask(task: ScheduledTask, triggerType: TriggerType, retryCount = 0): Promise<void> {
```

At the end of the catch block, after recording the failure, add:
```typescript
// Retry if configured and within limits
if (retryCount < task.maxRetries) {
  log.info(`Retrying task ${task.name} (attempt ${retryCount + 2}/${task.maxRetries + 1})`);
  // Re-fetch fresh task data for retry
  const freshTask = await this.getTask(task.id);
  if (freshTask && freshTask.status === 'active') {
    await this.executeTask(freshTask, triggerType, retryCount + 1);
  }
}
```

### Step 6: Implement Overlap Policy 'queue'

**File:** `packages/gateway/src/scheduler.ts`

Add a queue map as a class property:
```typescript
private queued = new Map<string, Array<{ triggerType: TriggerType }>>();
```

In `executeTask()`, replace the overlap check (lines 384-400) with:

```typescript
// Overlap policy check
if (this.running.has(task.id)) {
  if (task.overlapPolicy === 'skip') {
    log.info(`Task ${task.id} skipped — already running (overlap policy: skip)`);
    const db = getDb();
    await db.insert(taskExecutions).values({
      id: randomUUID(),
      taskId: task.id,
      status: 'skipped',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationSec: 0,
      triggerType,
    });
    return;
  }
  if (task.overlapPolicy === 'queue') {
    log.info(`Task ${task.id} queued — already running (overlap policy: queue)`);
    const queue = this.queued.get(task.id) ?? [];
    queue.push({ triggerType });
    this.queued.set(task.id, queue);
    return;
  }
  // 'allow' falls through — concurrent execution permitted
}
```

In the `finally` block of `executeTask()`, after `this.running.delete(task.id)`, drain the queue:

```typescript
finally {
  this.running.delete(task.id);

  // Drain queue if overlap policy is 'queue'
  const queue = this.queued.get(task.id);
  if (queue && queue.length > 0) {
    const next = queue.shift()!;
    if (queue.length === 0) this.queued.delete(task.id);
    this.executeTaskById(task.id, next.triggerType).catch((err) => {
      log.error(`Queued execution error for task ${task.id}`, { error: (err as Error).message });
    });
  }
}
```

### Step 7: Clean Up Queue on Stop/Delete/Pause

**File:** `packages/gateway/src/scheduler.ts`

In `unmountJob()`, also clear any queued executions:

```typescript
private unmountJob(id: string): void {
  const job = this.jobs.get(id);
  if (job) {
    try { job.stop(); } catch { /* ignore */ }
    this.jobs.delete(id);
  }
  this.queued.delete(id);
}
```

In `stop()`, also clear all queues:

```typescript
stop(): void {
  for (const [id, job] of this.jobs) {
    try { job.stop(); } catch { /* ignore */ }
    this.jobs.delete(id);
  }
  this.queued.clear();
  log.info('Scheduler stopped');
}
```

---

## 5. Testing Requirements

### 5a. Manual API Testing

After building (`pnpm build`), test the following via curl against the running gateway (port 8000):

**Create a task:**
```bash
curl -X POST http://localhost:8000/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-task","cronExpr":"*/2 * * * *","prompt":"Say hello","agentMode":"direct"}'
```

**Verify pause/resume/trigger endpoints work:**
```bash
# Pause
curl -X POST http://localhost:8000/api/schedules/<id>/pause

# Resume
curl -X POST http://localhost:8000/api/schedules/<id>/resume

# Manual trigger
curl -X POST http://localhost:8000/api/schedules/<id>/trigger

# Check executions
curl http://localhost:8000/api/schedules/<id>/executions
```

**Verify runCount increments correctly after multiple executions.**

### 5b. Frontend Testing

1. Open the web UI Settings > Scheduled Tasks tab
2. Create a new scheduled task
3. Click the Play button (manual trigger) — should work (previously silently failed)
4. Click Pause — task should move to paused state (previously silently failed)
5. Click Resume (play icon on paused task) — should reactivate (previously silently failed)
6. Verify execution history loads in the expandable section

### 5c. Stale Data Fix Verification

1. Create a task with prompt "Say hello"
2. Update the task via API: `PUT /api/schedules/<id>` with `{"prompt":"Say goodbye"}`
3. Manually trigger the task
4. Verify the execution used "Say goodbye" (check agent logs), not "Say hello"

### 5d. Build Verification

```bash
cd /home/kali/.orionomega/src
pnpm build
```

Must complete with zero TypeScript errors.

---

## 6. Acceptance Criteria

- [ ] **Frontend pause/resume/trigger buttons work** — clicking them results in the correct API calls (`POST .../pause`, `POST .../resume`, `POST .../trigger`) and the UI reflects the updated state after refresh
- [ ] **No stale data** — editing a task's prompt, agentMode, timeoutSec, or overlapPolicy takes effect on the next execution without requiring a cron expression change
- [ ] **runCount increments correctly** — after N executions, `runCount` equals N (verified via `GET /api/schedules/:id`)
- [ ] **nextRunAt updates on failure** — after a failed execution, `nextRunAt` shows the next scheduled time, not the previous value
- [ ] **maxRetries works** — a task with `maxRetries: 1` that fails on the first attempt retries once, recording both executions in `task_executions`
- [ ] **Overlap policy 'queue' works** — when a queued task is triggered while already running, the second execution starts after the first completes (not concurrently, and not skipped)
- [ ] **Queue cleanup** — pausing, deleting, or stopping the scheduler clears any queued executions
- [ ] **TypeScript build passes** — `pnpm build` completes with zero errors
- [ ] **No schema changes** — the fix does not require a new migration

---

## 7. Quick Reference — File Locations

| What | Path | Lines |
|------|------|-------|
| Scheduler service | `packages/gateway/src/scheduler.ts` | Full file (557 lines) |
| Schedule REST routes | `packages/gateway/src/routes/schedules.ts` | Full file (350 lines) |
| Route mounting in server | `packages/gateway/src/server.ts` | ~1303-1420 |
| DB schema (scheduled_tasks) | `packages/core/src/db/schema.ts` | ~309-331 |
| DB schema (task_executions) | `packages/core/src/db/schema.ts` | ~333-341 |
| Type models | `packages/core/src/db/models.ts` | ~103-115 |
| WS message types | `packages/gateway/src/types.ts` | ~271-287 |
| Frontend schedules store | `packages/web/src/stores/schedules.ts` | Full file (61 lines) |
| Frontend SchedulesTab | `packages/web/src/components/settings/SchedulesTab.tsx` | Full file (552 lines) |
| Migration SQL | `packages/core/src/db/migrations/0003_scheduled_tasks.sql` | Full file (41 lines) |
