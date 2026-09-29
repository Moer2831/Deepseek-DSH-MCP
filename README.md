# 🐳 DeepSeek-DSH-MCP

**English** | [中文](README.zh.md)

> **Give Claude Code / Codex a coding buddy that sticks around** — powered by DeepSeek Harness.

An MCP server that drives DSH as a **long-lived agent runtime** instead of wrapping a CLI. Open a conversation, hand it a goal, and it writes code, runs scripts and spawns its own subagents — while you watch, cut in, and collect the result whenever you like. 🛠️

🧪 467 checks green · 🔌 MCP over stdio · 📜 MIT · 💬 Community: [linux.do](https://linux.do/)

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

## ✨ Why it's different

|  |  |
|---|---|
| 🔄 **A dead process never kills a conversation** | The identity lives on disk. A crash, an idle reap, even restarting this whole server costs you nothing — the next call transparently resumes it, memory intact (verified across processes). |
| 🗣️ **You are never stuck waiting** | Steer a conversation mid-flight — **interject** to stop and redirect (~18 ms to converge), or **queue** a remark for after the current turn. Interrupting never damages the conversation. |
| 📡 **Completion notification, not polling** | Long tasks return instantly with a `run_id`; when the turn ends, a **sentinel file** is written atomically so a background task in *your* host wakes you. No polling, no occupied turn. |
| 🪟 **Many conversations at once** | `dsh_list(only_running)` shows what's live; `dsh_read` gives cursor-based incremental output. Cycle between them like windows. |
| 🧠 **Reasoning hidden by default** | You get "thought for N chars / M seconds" statistics instead of context-burning prose — and it is never logged, never written to disk. |
| 🤫 **Silent by default** | Not one byte on stderr, so nothing pollutes your host's logs. stdout carries the protocol and nothing else. |
| 🧩 **Capabilities compose** | DSH can mount its own MCP servers (IDA Pro, browsers, your internal tooling), so this is a bridge to a whole toolbox. |
| 🛡️ **Read-only that really is read-only** | `read-only` sandbox plus auto-denied approvals, for working on untrusted samples. |

## ⚡ Why not just wrap the DSH CLI?

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
| `dsh_send` | Hand it a task. **Defaults to `wait=false`: returns a `run_id` + `sentinel_file` immediately**, the turn runs in the background and the sentinel file notifies you when it's done (recommended). `wait=true` blocks until the turn ends; hitting `timeout_ms` (default `0` = wait forever) **only downgrades to background — the turn is never cancelled and the result is never lost** |
| `dsh_list` | All conversations with live state: `running` / `idle` / `detached`, elapsed time, current tool, output so far. `only_running=true` for active ones |
| `dsh_read` | **Cursor-based incremental read** of what a *running* conversation is producing right now |
| `dsh_get` | Conversation details; with `run_id`, the **final result of that dispatch** (the "collect the result later" entry point) |
| `dsh_interject` | Interject while it's busy: `interject` = stop and redirect, `queue` = wait for the current turn, then speak. **This round writes a sentinel too**, and the reply carries its `sentinel_file` |
| `dsh_takeover` | **Preempt the write lock.** The only way out when another DSH process holds it (DSH has no steal API — preempting means killing the holder). It classifies the holder first: our own orphaned child → taken automatically; another live instance → needs `force`; **GUI/unknown → never killed**, reported instead |
| `dsh_interrupt` | Stop the current turn (the conversation stays healthy) |
| `dsh_release` | Hand the conversation back (frees the write lock so you can open it in your own DSH GUI). Still resumable |
| `dsh_approval_decide` | Adjudicate a pending approval (only when `on_approval=ask`) |
| `dsh_status` | Lightweight status check |

## Workflow: dispatch, then collect later

MCP tool calls **block**, so `dsh_send` **does not block by default** (`wait=false`): you get a receipt immediately, the turn runs in the background, and the sentinel file wakes you when it finishes. The whole flow:

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
| `DSH_MCP_LOCKS_DIR` | `<state file dir>/locks` | Holder registrations for the write lock. ⚠️ **All instances must agree on this value**, or they cannot see each other's registrations and will misread each other as an unidentifiable holder (a GUI) and refuse to preempt |
| `DSH_MCP_LOCK_STALE_MS` | `90000` | How long without a heartbeat before a holder counts as lost (and becomes auto-preemptible by `dsh_takeover`) |
| `DSH_MCP_IDLE_TTL_MS` | `0` (never reap) | How long a conversation may sit idle before its DSH process is reaped. ★★ **`0` means never reap (the default)**: the server keeps holding the write lock, so **the GUI cannot take it** — opening the conversation there is read-only and still works. Cost: one resident DSH process per conversation. Set a millisecond value (e.g. `300000`) to save memory and accept that the lock can be taken |
| `DSH_MCP_LIST_PROBE_TTL_MS` | `10000` | Cache lifetime for `dsh_list`'s on-disk probe (the probe spawns a DSH process and takes ~1 s) |
| `DSH_MCP_SENTINEL_TTL_MS` | `604800000` (7 days) | Startup pruning age for sentinels; `0` disables pruning |
| `DSH_MCP_SENTINEL_INCLUDE_REASONING` | unset | `1` writes `result.thinking` into the sentinel (**breaks the never-on-disk guarantee**) |
| `DSH_MCP_PERMISSION` | `danger-full-access` | Default tier for `dsh_start` |
| `DSH_MCP_REASONING_EFFORT` | `max` | Default reasoning effort |
| `DSH_MCP_IDLE_TTL_MS` | `300000` | Idle before a conversation's process is reaped (still resumable) |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `0` (no timeout) | Wait bound for **`wait=true` only**; on expiry the turn merely moves to the background |
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
| `prune` | 11 | **sentinel retention**: prunes over-age and crash-leftover files, keeps fresh ones, removes empty shells, `TTL=0` disables pruning, and never touches the conversation registry beside it (no tokens, runs every time) |
| `timeout` | 38 | **timeout semantics**: `wait=false` is unaffected by `timeout_ms`; a `wait=true` expiry merely downgrades to background (turn not cancelled, result not lost, `busy` never lies); `timeout_ms<=0` waits forever; a failed resume invalidates the process instead of wedging the conversation; an empty prompt yields a clear error |
| `lock` | 79 | **write lock and preemption**: four holder classifications, `writeMarker` never overwriting a live holder, malformed/missing registration edge cases; **end-to-end** with two real MCP instances fighting over one conversation → clear error → refusal → `force` takeover; **a crash releases the lock automatically**, **a wedged holder is preempted without `force`**; plus the "one turn, one sentinel" invariant (inline turns and idle interjects included) |
| `cycle` | 30 | **the async dispatch lifecycle**: dispatch → collect the sentinel → idle reap → dispatch again, three rounds with no lock error; re-dispatch right on the reap boundary (widening the race); an immediate re-dispatch after `dsh_release`; and an assertion that reaping leaves no unattributable lock (this suite caught the reaper collecting a freshly spawned process as if it were idle) |
| `concurrency` | 31 | three simultaneous conversations + live incremental reads |
| `capability` | 22 | writing code, running scripts, **spawning its own subagents** (verified on disk via child session headers) |
| `workspace-effect` | 24 | workspace actually effective when no path is given |
| `acceptance` | 36 | two folders × two conversations doing a read-only IDA Pro analysis |

| `multi` | 19 | **several instances and non-ASCII paths**: reproduces "two instances share the registry and the later save drops the earlier instance's conversation", then proves **that conversation is recoverable by id alone from the session store and actually usable**; **recovery never silently escalates privileges** (a read-only conversation stays read-only); no `.tmp` residue; and **CJK / emoji workspace paths** create sessions, do real work, and place files in the right directory |
| `permission` | 11 | ★ **whether the permission tiers actually take effect** (a safety property): it ignores our own return values (the very thing that used to lie) and reads **the session's own record** (`permissions.preset` / `sandboxMode` in the projection cache), checking all three tiers and that their recorded values differ. **This suite caught a silent privilege escalation**: a `defaultPreset` in the profile overrides `DSH_PERMISSION_MODE` at session creation |
| `list` | 13 | **the cost of `dsh_list`** (measured): a default call with the on-disk probe takes ~1 s (it spawns a DSH process) while **repeated calls hit a cache and drop to single-digit milliseconds**; `only_running=true` and `include_closed=false` **skip the probe** with equivalent semantics (unopened on-disk sessions are simply excluded) |

**Total: 467 checks, all green.** (431 in-suite + 36 acceptance)

## 🔒 The write lock: one writer per conversation at a time

A DSH session directory carries a **cross-process write lock** whose semantics are "**the holder keeps it for as long as it lives**" — and there is **no API to take it from a live holder**. Two hard consequences:

- This server keeps a DSH process alive per conversation (that's what makes resume work), so **while it holds one, your own DSH GUI cannot open that conversation** — and vice versa. The two are mutually exclusive.
- On contention DSH throws `SessionAlreadyOwnedError`, which is **not** a standard JSON-RPC error, so ACP wraps it as a generic `-32603 "Internal error"` and hides the real cause in `error.data`. This server surfaces `data` and translates it into something actionable.

**`dsh_status` reports who holds the lock** in its `lock_holder` field, and `dsh_takeover` acts on the four cases:

| `lock_holder` | Meaning | Preemption |
|---|---|---|
| `self` | this process holds it | nothing to do |
| `stale-mcp` | **the holder is alive but went silent** (no heartbeat for 90 s — typically that MCP is wedged) | ✅ **killed and taken over automatically** (safe) |
| `live-mcp` | another **live** dsh-mcp instance is using it | ⚠️ refused by default; `force=true` takes it |
| `none` | no registration — **most likely your own DSH GUI has it open** | ❌ **never killed** (that would kill your whole UI, including the conversation you're reading), reported only |

> **Crash vs. wedge (measured)**: `SIGKILL` the MCP server and its DSH children **exit with it** — their stdio is a pipe to the parent, so closing it gives them EOF and they shut down. **A crash therefore releases the lock automatically; it never leaves an orphan holding it** (a restart always gets it back). What `stale-mcp` really covers is "**the holder is alive but wedged**" (heartbeat expired) — that's the case worth preempting.

### Several instances at once (you may keep more than one host window open)

- **The registry is one document, last writer wins**: when instance B saves, it drops conversations it has never seen — including one instance A just created (reproduced in tests). **This does not break usage**: the service treats the **session store as authoritative and the registry as a cache**, so any session still on disk can be recovered **by id alone** and dispatched to normally.
- **Holder registrations must be shared**: `DSH_MCP_LOCKS_DIR` has to point at the same directory (by default it follows `DSH_MCP_STATE`, so **the defaults are fine**). If you give each instance its own `DSH_MCP_STATE`, **point `DSH_MCP_LOCKS_DIR` at one shared directory explicitly** — otherwise instances cannot see each other's registrations and will misread each other as an unidentifiable holder (a GUI) and refuse to preempt.
- **Recommendation**: unless you have a reason, **let every instance share the default `DSH_MCP_STATE`**.

> **Operational rule**: don't open a conversation this server drives in your DSH GUI. To look at it there, `dsh_release` first; dispatch again afterwards (it resumes automatically).
>
> **★ Why "just opening it" is not safe either (measured A/B)**: the lease really is "held while the holder lives", and **reading content or listing directories is unaffected** — but **clicking a conversation open in the GUI itself** takes a write handle, so **`dsh web` walks away with the lock**. Measured: with the conversation only in the MCP's hands the probe reports **free**; the moment you open it in the web UI it becomes **held: "already owned by an active write handle"**.
>
> **★★ And navigating away does not give it back (also measured)**: after you switch to another conversation the lock is **still** held by `dsh web`. In other words, **opening it once hands that conversation to the GUI for the whole lifetime of the web process**; the MCP cannot touch it again until you **restart `dsh web`**. (That explains "the caller can never get back in after a task": it is not taken every time — it is taken once and stays taken.)
>
> **★ Even archiving the conversation does not release it (measured, with the archive verified to have landed)**: the docs say archiving releases its reference, but the write lock is **not** released with it. So the only known way out is **restarting `dsh web`** (lossless in data terms: the conversation itself is intact and resumes normally afterwards).
>
> **★★ The lossless answer: keep the MCP holding the lock — do not let it go free.** Set **`DSH_MCP_IDLE_TTL_MS=0`** (never reap; this is now the default). Idle reaping saves memory, but it is also the only moment the write lock becomes **free** — and that is exactly when the GUI can take it, after which the MCP never gets it back. With reaping disabled (**measured**): opening the conversation in the GUI **opens it read-only, so you can still read it** ✓ while **the write lock stays with the MCP** ✓✓ (confirmed by probing from a separate instance: the holder is still this server's own PID with a fresh heartbeat) — **neither side is harmed**: you keep visibility, and the MCP can never be locked out. The cost is one resident DSH process per conversation — which is why reaping exists at all. **Use the default to replace a silent, permanent breakage with a "you can look, we can write" split.**
>
> **So you may keep peeking in the GUI as long as the MCP holds the lock** — the view is read-only and harmless. (If the lock is ever free, opening it there hands it to the GUI permanently, which is exactly what the default prevents.) `dsh_read` and the sentinel file remain the fully safe ways to watch progress.
>
> **So to watch progress use `dsh_read` (the MCP tool, with cursor-based incremental reads) or wait for the sentinel file — not the GUI.** If you really want the GUI view, `dsh_release` first (note that this interrupts a running turn, so it only fits the gaps between tasks).
>
> The consequence is precisely "**the task is running, you peek at progress in the web UI, and afterwards the caller cannot get back in**" — the old error wrapping surfaced that as a content-free `Internal error`; the new one names the holder as most likely your own GUI and tells you to close it and retry.
>
> Why the last row refuses: GUI conversations **run inside the `dsh web` process** (not one process per conversation), so "killing the lock holder" would take down the entire web service and every GUI conversation with it. Sessions on disk survive and can be resumed, but in-flight turns are lost.

## Known limitations

1. **No token-level streaming into model context** — an MCP limitation, not DSH's. Callers get per-step results; humans can follow progress via stderr logs.
2. **True mid-turn steering is impossible** — ACP rejects concurrent prompts (`a prompt is already in flight for this session`). `dsh_interject` is the practical equivalent: cancel, then immediately start a new turn, history preserved.
3. **Image prompts are unsupported** — ACP advertises `promptCapabilities: {image: false}`.
4. **Restarting the MCP server takes its children with it** — when this service is restarted or killed, the DSH children it spawned exit too (their stdio is a pipe to us): **in-flight turns are interrupted and no sentinel lands** (judge by inspecting the workspace, don't just wait for the file). The good news: the **write lock is released automatically**, so a restart always gets it back. The service also pushes no MCP notifications; "completion notification" is the sentinel file plus the caller's background waiter.
5. **A conversation that dies before its first successful turn may never have materialized on disk** — resume then fails with a clear error. Safe after the first message.
6. **No renaming** — DSH's title subsystem has no external rename API (`SessionTitleService.rename` requires a live in-process session). Titles are auto-generated from the first message.
7. **`session/list` returns only `{sessionId, cwd}` and excludes already-open sessions** — titles are filled in by this server from DSH's projection cache.

## 💬 Community

This project is announced and discussed on **[linux.do](https://linux.do/)** — usage questions, war stories and suggestions are all welcome there. Issues work too, but you'll usually get a faster answer in the community.

## License

MIT — see [LICENSE](LICENSE).
