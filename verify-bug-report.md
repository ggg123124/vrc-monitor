## Bug Description

`hermes verify` hangs indefinitely (or fails readiness) when verifying a Node.js service project on **Windows**. The start-phase readiness check and teardown both misbehave with long-running Node daemons that print substantial stdout at startup.

Two distinct defects were observed, both rooted in `agent/verify/runner.py`:

**Defect 1 — teardown deadlock (hang):** When readiness *passes*, verify hangs forever at `proc.stdout.read()` (line ~229) because the spawned Node child survives teardown and keeps the stdout pipe open.

**Defect 2 — readiness timeout (app hangs during poll):** When the app prints a lot of startup output (a 55-tool MCP server prints ~30KB of tool descriptions), verify's `_poll_readiness` loop does not consume the child's stdout. On Windows, the pipe buffer fills, the Node process's synchronous `console.log` blocks, the event loop stalls, and the HTTP server stops responding — so readiness never succeeds. The app is fine when launched directly.

## Steps to Reproduce

Environment: Windows 10 (10.0.22621), Hermes Agent v0.20.0, Node v26.7.0.

1. Clone a Node.js service that prints substantial startup output and runs a long-lived HTTP server (e.g. a project whose `npm run start` starts a daemon listening on a fixed port).
2. Run: `hermes verify --json --port 8799 --ready-timeout 90` in the project root (recipe detected as "Node.js app", `start: npm run start`).
3. Observe:
   - With a short `--ready-timeout`, verify reports `readiness: {ready: false, error: "timed out"}` while the service is actually healthy when started manually.
   - With a long `--ready-timeout`, once readiness succeeds, the verify process never exits (hang), and the spawned Node process survives the `kill` of the verify process.

Observed in my run: `readiness: {"url": "http://127.0.0.1:8799/health", "ready": false, "statusCode": null, "duration": 99.078, "error": "timed out"}` — meanwhile `curl http://127.0.0.1:8799/health` returned 200 and `{"ok": true, "auth": {"authenticated": true}}` the moment the service was started directly with `node start-monitor.js` (connected in 3s).

## Expected Behavior

- Verify's readiness poll should not starve the child's stdout pipe (drain it or redirect to a file).
- Teardown on Windows should terminate the full process tree (e.g. `taskkill /T /F` or job objects), not just the direct shell child, and `stdout.read()` should not block forever waiting on a pipe held open by an orphaned grandchild.

## Actual Behavior

- Readiness times out because the child's stdout pipe fills and the app's synchronous writes block its event loop.
- When readiness passes, verify hangs forever at `proc.stdout.read()`; the grandchild Node process keeps running after verify is killed, holding port 8799.

## Root Cause Analysis

In `agent/verify/runner.py`:

1. `_run_start_phase` (lines ~202-239): `subprocess.Popen(recipe.start, shell=True, stdout=subprocess.PIPE, ...)` — while `_poll_readiness(url, ready_timeout)` polls the HTTP endpoint (interval 1.0s), **nothing reads `proc.stdout`**. On Windows, the pipe buffer (~4-64KB) fills once the app prints enough startup output; the child's synchronous `console.log` blocks, stalling its event loop so the HTTP server can't answer. POSIX doesn't hit this as easily (larger buffers / non-blocking semantics differ), which is why it's Windows-specific in practice.

2. `_terminate_process_group` (lines ~162-199): on Windows there is no `os.killpg`, so it falls back to `proc.terminate()` — which kills only the `cmd.exe`/npm shell, **not the Node grandchild**. The grandchild inherits the stdout pipe handle; `proc.stdout.read()` (line 229) then blocks forever waiting for EOF that never comes.

## Suggested Fix Direction

- During readiness polling, drain `proc.stdout` (read it in a background thread/loop, or redirect the child's stdout to a temp file / `DEVNULL` — note `DEVNULL` alone doesn't help if the child writes via inherited handle; an explicit drain is safest).
- On Windows teardown, kill the whole tree with `taskkill /PID <pid> /T /F` (or use a Job Object with `CREATE_BREAKAWAY_FROM_JOB`), then close the stdout pipe / read with a bounded timeout so a surviving grandchild can't deadlock verify.

## Environment

- OS: Windows 10 (10.0.22621.4317)
- Hermes Agent: v0.20.0 (2026.8.3), commit 10b2b11
- Node.js: v26.7.0, npm 11.19.0
- Verified via bash (git-bash / MSYS) shell
