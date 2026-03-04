# Grace Timer Design

**Problem:** Bridge kills CC after 5 minutes of no SSE clients, regardless of whether CC is mid-turn or the user is momentarily disconnected (iOS Safari drops SSE frequently).

**Solution:** `maybeStartGraceTimer` — a simple precondition + recency check before starting a 5-minute kill countdown. No guard interface, no recheck loop.

## Architecture

```
Last SSE client disconnects (or CC finishes a turn with no audience)
  → maybeStartGraceTimer()
    → preconditions: no clients, process alive, not mid-turn
    → recency: prompt within 10 min? skip. Output within 10 min? skip.
    → all pass → start 5-minute grace timer

Client reconnects OR new prompt arrives
  → cancel grace timer

Grace timer expires
  → SIGTERM → SIGKILL (3s escalation) → delete session
```

## Decision function: `maybeStartGraceTimer()`

Three preconditions must ALL pass:

| Precondition | Field | Rationale |
|--------------|-------|-----------|
| No audience | `clients.size === 0` | Someone's watching — don't kill |
| Process alive | `session.process` | Nothing to kill |
| Not mid-turn | `!turnInProgress` | CC is working — let it finish |

Then two recency guards can still abort:

| Guard | Field | Window | Rationale |
|-------|-------|--------|-----------|
| Prompt recency | `lastPromptAt` | 10 min | User active but iOS dropped SSE |
| Output recency | `lastOutputTime` | 10 min | CC just finished a long agentic run |

If all pass, `startGraceTimer()` begins a 5-minute countdown.

## Call sites

`maybeStartGraceTimer` is called at exactly two moments — the two transitions that can make a session "idle with no audience":

| Trigger | Function | Why |
|---------|----------|-----|
| SSE client disconnects | `detachFromSession()` | Last viewer left |
| CC finishes a turn | `onTurnComplete()` | CC stopped working (no one watching) |

## Cancellation

| Event | Where | Reason |
|-------|-------|--------|
| Client reconnects | `attachToSession()` | `"client-reconnect"` |
| New prompt arrives | `deliverPrompt()` | `"prompt-arrived"` |

Both clear the timer and emit `grace:cancel`.

## Events

| Event | Severity | When |
|-------|----------|------|
| `grace:start` | info | Timer started (5 min countdown) |
| `grace:skip` | debug | Precondition or recency guard prevented timer |
| `grace:cancel` | info | Client reconnected or prompt arrived |
| `grace:expire` | info | Timer fired — process killed, session deleted |

## Constants

| Constant | Default | Env override | Purpose |
|----------|---------|-------------|---------|
| `GRACE_MS` | 5 min | `GRACE_MS` | Kill countdown after all guards pass |
| `RECENCY_MS` | 10 min | (hardcoded) | Prompt/output recency window |
| `KILL_ESCALATION_MS` | 3s | (hardcoded) | SIGTERM → SIGKILL escalation |

## Timing

- **Best case** (no recent activity when last client disconnects): 5 minutes to kill.
- **Worst case** (user just sent something, then walks away): 10 min recency + 5 min grace = 15 minutes.

## Turn lifecycle

| Event | State change |
|-------|-------------|
| Prompt written to CC stdin | `turnInProgress = true`, `lastPromptAt = now` |
| CC emits `result` event | `turnInProgress = false` |
| CC process exits | `turnInProgress = false` (safety net) |
| Any CC stdout line | `lastOutputTime = now` |

## Init timeout (separate mechanism)

A 30-second init timeout catches CC processes that hang during startup (e.g. missing `mcpServers` key in config — see CC Init Hang Diagnosis in CLAUDE.md). Uses `session.initTimer`, fires `init:timeout`, kills the process. Cleared on first CC output. Unrelated to the grace timer.

## Known gaps

- **No safety cap for stuck turns.** If `turnInProgress` stays true forever (CC hung mid-turn with a connected client), the grace timer never starts. There's no `MAX_IDLE_MS` absolute cap.
- **No staleness detection.** If CC is "mid-turn" but hasn't produced stdout in hours, nothing notices. The old design had a `STALE_OUTPUT_MS` concept that was never implemented.
- **Recency window is hardcoded.** `RECENCY_MS` can't be tuned via environment variable.
