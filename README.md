# DeepSeek-DSH-MCP

**English** | [中文](README.zh.md)

An MCP server that lets **Claude Code / Codex / any MCP client** drive **DeepSeek Harness (DSH)** as a long-lived coding agent — start a conversation, hand it a goal, watch it work, interrupt it, come back later and collect the result.

> 📌 **Read the [Usage Notes](USAGE-NOTES.en.md) first** — the practical gotchas that will actually bite you: the ACP model-config trap, external MCP tools bypassing DSH's sandbox, the workspace/GUI registry cache, cost control, and a troubleshooting table.

```
Claude / Codex  ──MCP(stdio)──▶  dsh-mcp
                                    │ newline-delimited JSON-RPC (ACP)
                                    ▼
                            dsh --profile dsh-mcp        ← one long-lived process per conversation
                                    │
                                    ├─ DSH's own tools (files, shell, search, skills, subagents, workflows)
                                    └─ dsh-mcp-client ─▶ your other MCP servers (e.g. IDA Pro)
```

## Why this exists

DSH ships two programmable entry points. The `sdk` profile looks simpler, but its JSON-RPC surface has only **3 requests and 4 notifications** — and it lacks three things that make an agent unusable in practice. The `acp` profile (Agent Client Protocol) has all of them. Everything below was verified against DSH `0.1.7-rc.2`.

| Capability | `sdk` profile | `acp` profile (**this project**) |
|---|---|---|
| **Resume a conversation** | ❌ no resume method; reusing an id fails with `already exists` | ✅ `session/resume` — verified **across processes** |
| **Interrupt a running turn** | ❌ only by killing the process | ✅ `session/cancel` — the same path as the user's own stop button |
| **Answer approval prompts** | ❌ no channel; operations silently fail closed | ✅ `session/request_permission` round-trip |
| List / close sessions | ❌ none | ✅ `session/list`, `session/close` |
| Gray vs. black streaming | one message, split by a `type` field | ✅ two separate channels: `agent_thought_chunk` / `agent_message_chunk` |
| Per-session MCP servers | ❌ process-wide | ✅ `mcpServers` accepted by `session/new` and `session/resume` |

**Core idea: the process is a cache, not the identity.** A conversation's identity is DSH's `sessionId`, persisted under `~/.dsh/sessions`. If the process is reaped, crashes, or the whole MCP server restarts, the next call transparently `session/resume`s it — history intact.

## Requirements

- **Node.js ≥ 20**
- **DSH installed** (`@deepseek-ai/dsh`), with working credentials under `~/.dsh`
- A DSH **profile named `dsh-mcp`** derived from the shipped `acp` template, containing **your own** provider/model config (this repo deliberately ships no provider config)

## Setup

### 1. Create the DSH profile

```bash
dsh dsh-mcp --from-default-profile acp
```

Then edit `~/.dsh/profiles/dsh-mcp/cordis.patch.yml` and declare your provider and model. Start from [`profile-example/cordis.patch.yml`](profile-example/cordis.patch.yml).

> ⚠️ **Two traps here** (both learned the hard way):
>
> 1. **ACP's model does NOT come from `agent-default-model`.** It comes from the `dsh-acp` plugin's own `config.provider` / `config.model`, which the `acp` bundle hard-codes to `deepseek-official`. If you don't override the `acp` row, your sessions silently run on the wrong provider and fail with `no API key for provider route "deepseek-official"`.
> 2. **ACP's `reasoning_effort` defaults to empty** (= "Provider default"), not to the maximum. This server explicitly sets it to `max` on every `session/new` and after every `session/resume` — because a fresh process does not remember the previous choice.

### 2. Register the server

**Claude Code**

```bash
claude mcp add dsh-mcp -- node /absolute/path/to/DeepSeek-DSH-MCP/bin/dsh-mcp.mjs
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.dsh-mcp]
command = "node"
args = ["/absolute/path/to/DeepSeek-DSH-MCP/bin/dsh-mcp.mjs"]
```

**Generic MCP client**

```json
{
  "mcpServers": {
    "dsh-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/DeepSeek-DSH-MCP/bin/dsh-mcp.mjs"]
    }
  }
}
```

### 3. Try it

```bash
node test/smoke.mjs        # no LLM calls, verifies the whole plumbing
```

## Tools

| Tool | What it does |
|---|---|
| `dsh_start` | Create a conversation: workspace, permission tier, approval policy, **reasoning effort (default `max`)**, model |
| `dsh_send` | Hand it a task. `wait=true` (default) blocks until the turn ends; **`wait=false` returns a `run_id` and a `sentinel_file`** (atomically written when the turn ends, containing the final result — lets you wait for completion via the filesystem, no polling) |
| `dsh_list` | All conversations with live state: `running` / `idle` / `detached`, elapsed time, current tool, output so far. `only_running=true` for active ones |
| `dsh_read` | **Cursor-based incremental read** of what a *running* conversation is producing right now |
| `dsh_get` | Conversation details; with `run_id`, the **final result of that dispatch** (the "collect the result later" entry point) |
| `dsh_interject` | Interject while it's busy: `interject` = stop and redirect, `queue` = wait for the current turn, then speak |
| `dsh_interrupt` | Stop the current turn (the conversation stays healthy) |
| `dsh_release` | Hand the conversation back (frees the write lock so you can open it in your own DSH GUI). Still resumable |
| `dsh_approval_decide` | Adjudicate a pending approval (only when `on_approval=ask`) |
| `dsh_status` | Lightweight status check |

## Workflow: dispatch, then collect later

MCP tool calls **block**. If you let `dsh_send` wait for a 10-minute task, your own turn is stuck and you may hit the host's tool timeout. So for anything long:

```text
1. dsh_send(conversation_id, prompt, wait=false)
     → { run_id: "run-abc123", background: true }        # returns in ~1 ms

2. …keep working on something else (verified: another conversation ran a full turn meanwhile)…

3. dsh_status(conversation_id)
     → state=running | elapsed=3.5s | current_tool=pwsh | out=37 chars

4. dsh_read(conversation_id, cursor)                      # peek mid-flight
     → [me] … | [turn] turn 1 started | [tool] pwsh [in_progress]

5. dsh_get(conversation_id, run_id)                       # collect the result
     → status=done, elapsed=20.3s, full answer
```

`run_id` is the receipt. Run records are **memory-only, last 20 kept**; under many concurrent runs old ones get evicted and `dsh_get` will fail — which is exactly why the completion sentinel below carries the result.

## Workflow: get notified on completion (no polling)

Besides `run_id`, `wait=false` returns a **`sentinel_file`** path plus **`sentinel_file_posix`** (the Bash/MSYS form — use it directly; hand-converting Windows paths is the easiest way to make your waiter hang until timeout). When the turn ends — **whether it succeeds, fails, or is cancelled** — the service **atomically writes** a small file there containing the final `status` and `result`. So you neither poll nor block: **wait for that file with a background task in your own host (Claude/Codex); the moment it appears, you're woken up.**

```bash
# sent="$sentinel_file_posix"   ← copy it straight from the tool result
sent='/d/AI_MCP/DSH_MCP/.state/runs/<conversation_id>/<run_id>.json'
dl=$(( $(date +%s) + 2100 ))          # 35min safety net so a dead service can't hang you forever
until [ -f "$sent" ]; do
  [ "$(date +%s)" -ge "$dl" ] && { echo "TIMEOUT"; exit 1; }
  sleep 2
done
echo "DONE"                            # task exits → host wakes you → read the file to collect
```

Once the file exists: **read it** for `status` and `result` (preferred — immune to the in-memory window and survives restarts), or use `dsh_get(conversation_id, run_id)`.

Design notes (especially under **concurrent multi-session** use):

- **No cross-talk**: the path is `.state/runs/<conversation_id>/<run_id>.json`, namespaced by conversation. `run_id` sequence numbers are counted per-conversation, so two conversations *can* mint the same `run_id` in the same millisecond — the per-conversation directory keeps them apart. Arm one background task per run; each completes and wakes you independently.
- **Latch semantics**: the file is written once and kept. Even if the run finishes *before* you arm the waiter, `[ -f ]` is immediately true — you never miss it.
- **Atomic write**: `tmp` + `rename`; if the file exists its contents are complete. Each run uses its own tmp, so concurrent writes never clobber.
- **No server push**: the service only answers requests over MCP (it sends no notifications). "Completion notification" is entirely the sentinel file plus your background waiter.
- **★ No reasoning in the sentinel**: the payload carries the answer and thinking *statistics* only — `result.thinking` is stripped and replaced by `thinking_omitted: true`, because the project's rule is that reasoning never reaches disk. `dsh_get(run_id)` still returns it from memory while the record lives. `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` breaks that guarantee deliberately.

> Cleanup: sentinels contain full answers, so the service **prunes sentinels older than 7 days at startup** (tune with `DSH_MCP_SENTINEL_TTL_MS`; `0` disables). Your waiter should still `rm` the file after consuming it.

## Workflow: many conversations at once

```text
1. dsh_list(only_running=true)
     - … | id=448b239b… | 🔵 running (9s, tool=pwsh, 40 chars this turn) | cwd=…
     - … | id=33427096… | 🔵 running (8s, 34 chars this turn)        | cwd=…
2. dsh_read(id,  cursor=0)      # read the first, note the cursor
3. dsh_read(id2, cursor=0)      # switch to the second
4. dsh_read(id,  cursor=<prev>) # switch back, deltas only
```

## Reasoning: hidden by default

DSH separates reasoning from answer text at the model layer, and ACP exposes them as **two independent streams**. This server hides reasoning by default and returns only **statistics** (characters, duration, chunk count) — so the caller knows thinking happened without paying for it in context.

- `reasoning=hide` (default) — content dropped, stats returned
- `reasoning=marker` / `summary` / `full` — progressively more content (mind your context budget)
- `dsh_read(include_reasoning=true)` — live reasoning of the *currently running* turn only; it is never buffered and is discarded when the turn ends

## Permissions

| Tier | Approval default | Use for |
|---|---|---|
| `danger-full-access` (default) | `auto-allow` | Zero friction |
| `workspace-write` | `auto-allow` | Out-of-workspace operations surface as pending approvals |
| `read-only` | `auto-deny` | Analyzing untrusted samples (malware, unknown dumps) |

`on_approval` can be `auto-allow`, `auto-deny`, or `ask` (which exposes a pending approval for `dsh_approval_decide` to adjudicate).

## Workspace visibility in the DSH GUI

Two different things — don't confuse them:

| | Depends on | Status |
|---|---|---|
| **Workspace effectiveness** | the conversation's `cwd` | ✅ Always correct. Process working directory, file placement and sandbox write root all follow it |
| **GUI grouping** | `sessionIds` in `~/.dsh/storages/workspace.json` | ⚠️ This server registers it, but **the running DSH server caches the registry in memory** — external file edits only take effect after a DSH restart |

Verified experimentally ([`test/workspace-effect.mjs`](test/workspace-effect.mjs)): two conversations in two desktop folders, given **no path at all**, each wrote its file into its own workspace, self-reported the correct working directory, and leaked nothing into the server's cwd / home / temp / the other workspace (24/24 checks).

Maintenance CLI:

```bash
node bin/dsh-mcp-workspaces.mjs --list                  # inspect the registry
node bin/dsh-mcp-workspaces.mjs --backfill              # register every session found on disk
node bin/dsh-mcp-workspaces.mjs --prune-temp            # drop temp-directory entries
node bin/dsh-mcp-workspaces.mjs --prune-empty           # drop empty workspaces whose path is gone
node bin/dsh-mcp-workspaces.mjs --purge-test-sessions   # delete test sessions (strict rules)
```

> ⚠️ Before restarting DSH, **don't touch workspaces in the GUI** — the server will write its in-memory state back over the file.

## Logging and privacy

Silent by default — **not one byte is written**.

1. MCP's **stdout is the protocol channel**; anything mixed in corrupts the stream.
2. This server is launched by Claude/Codex, so its stderr lands in *their* logs.
3. DSH's own stderr may carry model output **including reasoning**, so it is never forwarded by default.

| Level | Behavior |
|---|---|
| `silent` (default) | nothing at all |
| `info` | this server's own lifecycle events only — **never any DSH output** |
| `debug` | more of our own events; still no DSH output |
| `DSH_MCP_LOG_STDERR=1` | additionally forward DSH's raw stderr (**may contain reasoning**) |

**Reasoning never reaches disk** — with exactly one deliberate exception:

- Not in logs (silent by default), and the state file holds metadata only (id, cwd, permissions, counters) — a smoke-test assertion guards this.
- **The async completion sentinel does persist the answer** (it must, so a caller can collect offline) but **strips `result.thinking`** and marks `thinking_omitted: true`. A test asserts that even when `reasoning=full` is requested, no reasoning text appears in the sentinel — while `dsh_get(run_id)` still returns it from memory. Set `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` to break this on purpose.
- Sentinels are pruned after 7 days by default (`DSH_MCP_SENTINEL_TTL_MS`; `0` keeps them forever).

(DSH itself writes its own session log under `~/.dsh/sessions`; that is what makes resume possible and is outside this server's control.)

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DSH_BIN` | auto-detected | Path to `@deepseek-ai/dsh/lib/bin.js` |
| `DSH_MCP_PROFILE` | `dsh-mcp` | DSH profile to drive |
| `DSH_MCP_STATE` | `<repo>/.state/conversations.json` | Conversation registry, survives restarts |
| `DSH_MCP_RUNS_DIR` | `<state file dir>/runs` | Root for async completion sentinels (`<this>/<conversation_id>/<run_id>.json`) |
| `DSH_MCP_SENTINEL_TTL_MS` | `604800000` (7 days) | Startup pruning age for sentinels; `0` disables pruning |
| `DSH_MCP_SENTINEL_INCLUDE_REASONING` | unset | `1` writes `result.thinking` into the sentinel (**breaks the never-on-disk guarantee**) |
| `DSH_MCP_PERMISSION` | `danger-full-access` | Default tier for `dsh_start` |
| `DSH_MCP_REASONING_EFFORT` | `max` | Default reasoning effort |
| `DSH_MCP_IDLE_TTL_MS` | `300000` | Idle before a conversation's process is reaped (still resumable) |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `1800000` | Max wait for one turn |
| `DSH_MCP_APPROVAL_TIMEOUT_MS` | `300000` | How long a pending approval waits |
| `DSH_MCP_REGISTER_WORKSPACE` | `project` | `project` / `all` / `0` |
| `DSH_MCP_LOG` | `silent` | `silent` / `info` / `debug` |
| `DSH_MCP_LOG_STDERR` | unset | `1` forwards DSH's raw stderr |

## Tests

```bash
node test/run.mjs          # smoke only (no LLM calls)
node test/run.mjs --all    # everything
node test/cleanup.mjs      # suite teardown on its own (temp dirs only; --dry-run to preview)
```

The suite **cleans up after itself**: `run.mjs` always ends with `cleanup.mjs`, which removes test sessions and workspace registrations **inside the OS temp directory only**. Real project sessions and the repo's `.state/` (your live conversation registry and sentinels) are never touched. To also remove `Desktop\dsh-mcp-test-*` artifacts, run `node bin/dsh-mcp-workspaces.mjs --purge-test-sessions` explicitly.

| Suite | Checks | Covers |
|---|---|---|
| `smoke` | 28 | handshake, tool table, conversation creation, config, registry purity |
| `boundary` | 42 | protocol edges (double initialize, malformed lines, unknown method), argument validation, unknown ids, cursor edges, lifecycle idempotence, unicode |
| `integration` | 30 | resume-with-memory across processes, interrupt, both interject modes |
| `async` | 16 | fire-and-forget + later collection |
| `sentinel` | 36 | completion sentinel: atomicity, latch semantics, per-conversation namespacing under concurrency, cancelled runs still land it, and **reasoning never reaching the file** |
| `concurrency` | 31 | three simultaneous conversations + live incremental reads |
| `capability` | 22 | writing code, running scripts, **spawning its own subagents** (verified on disk via child session headers) |
| `workspace-effect` | 24 | workspace actually effective when no path is given |
| `acceptance` | 36 | two folders × two conversations doing a read-only IDA Pro analysis |

**Total: 265 checks, all green.**

## Known limitations

1. **No token-level streaming into model context** — an MCP limitation, not DSH's. Callers get per-step results; humans can follow progress via stderr logs.
2. **True mid-turn steering is impossible** — ACP rejects concurrent prompts (`a prompt is already in flight for this session`). `dsh_interject` is the practical equivalent: cancel, then immediately start a new turn, history preserved.
3. **Image prompts are unsupported** — ACP advertises `promptCapabilities: {image: false}`.
4. **`dsh_send` blocks by default** — use `wait=false` for long tasks, then wait on the completion sentinel file (`sentinel_file`) for a poll-free "done" notification. The service pushes no MCP notifications; the "notification" is the sentinel file plus the caller's background waiter.
5. **A conversation that dies before its first successful turn may never have materialized on disk** — resume then fails with a clear error. Safe after the first message.
6. **No renaming** — DSH's title subsystem has no external rename API (`SessionTitleService.rename` requires a live in-process session). Titles are auto-generated from the first message.
7. **`session/list` returns only `{sessionId, cwd}` and excludes already-open sessions** — titles are filled in by this server from DSH's projection cache.

## License

MIT — see [LICENSE](LICENSE).