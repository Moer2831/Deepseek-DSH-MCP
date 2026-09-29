# Usage Notes

**English** | [中文](USAGE-NOTES.md)

Practical gotchas and trade-offs you *will* hit when letting Claude / Codex drive DSH through this MCP server. Each item is **symptom → cause → fix**.

---

## 1. Setup

**1.1 The profile must exist first.** Otherwise every turn fails with `no adapter registered for provider "xxx"`. This server ships no provider config; it drives `~/.dsh/profiles/dsh-mcp/`. Create it with `dsh dsh-mcp --from-default-profile acp` and fill in your own provider per [`profile-example/cordis.patch.yml`](profile-example/cordis.patch.yml).

**1.2 ★ The most common trap: ACP's model does NOT come from `agent-default-model`.** You configure your provider there, yet turns fail with `no API key for provider route "deepseek-official"`. ACP reads the `dsh-acp` plugin's own `config.provider` / `config.model`, which the `acp` bundle hard-codes. You must override the `acp` row:

```yaml
- id: acp
  name: "@deepseek-ai/dsh-acp"
  config:
    provider: <yours>
    model: <yours>
```

**1.3 ACP's reasoning effort defaults to empty** (= "Provider default"), not to maximum. This server sets `max` on every `session/new` and after every `session/resume`, since a fresh process remembers nothing. Lower it via `reasoning_effort` on `dsh_start` to save money.

**1.4 Never register dsh-mcp into DSH's own MCP list.** DSH is an MCP client, this server is an MCP server; pointing one at the other recurses forever.

**1.5 `DSH CLI entry not found`.** Set `DSH_BIN` explicitly (auto-detection scans the npx cache, npm global, and common paths).

## 2. Cost and budget

**2.1 `dsh_send` does NOT block by default — stop passing `wait=false` manually.** It is already the default: you get a `run_id` + `sentinel_file` immediately, the turn runs in the background, and the sentinel file wakes you when it finishes. Only pass `wait=true` when you genuinely want to block; it occupies the caller's own turn, and on reaching `timeout_ms` (**default `0` = wait forever**) it **does not cancel the turn and does not lose the result** — it merely downgrades to background and hands you a receipt. A timeout is therefore no longer a disaster, and you should never invent one yourself. Collect with `dsh_get(conversation_id, run_id)` or, better, by reading the sentinel file (immune to the in-memory window).

**2.2 Conversations are long-lived and history accumulates.** Cost grows with turn count. **One conversation per task**; release and start fresh for unrelated work. Watch `context_pressure` from `dsh_get`.

**2.3 Compaction makes the model forget old detail.** DSH summarizes old context under pressure; the model loses fine detail (the on-disk log keeps everything — only the model's view shrinks). Restate critical constraints each turn.

**2.4 `reasoning=full` is expensive** — reasoning is often several times longer than the answer. Keep the default `hide` (stats only); use `marker`/`summary` when you need a peek, `full` only for debugging.

**2.5 Run records are memory-only, last 20.** An old `run_id` eventually returns `unknown run_id`. Persist important results yourself, drain `dsh_read` (also memory, bounded to 500 entries), or — best with `wait=false` — **collect from the completion sentinel file**, which carries the result, is immune to the in-memory window, and survives restarts.

**2.6 Sentinel files consume disk.** They are a *latch*: written once and kept so a late waiter never misses one, so they don't vanish on their own. The service **prunes sentinels older than 7 days at startup** (`DSH_MCP_SENTINEL_TTL_MS`, `0` disables); have your waiter `rm` after consuming. Sentinels **contain no reasoning** — `result.thinking` is stripped and flagged `thinking_omitted`.

## 3. Concurrency and lifecycle

**3.1 One turn per conversation at a time.** ACP rejects concurrent prompts: `a prompt is already in flight for this session`. To redirect, use `dsh_interject` (`interject` = stop and redirect, `queue` = speak after the current turn); to stop, `dsh_interrupt`.

**3.2 Idle processes are reaped after 5 minutes.** `dsh_status` shows `detached` — **this is not an error**. The conversation lives on disk and the next call resumes it transparently.

**3.3 Don't open the same conversation in two places.** DSH session directories carry a cross-process write lock that never expires while the holder lives. `dsh_release` hands it back so you can open it in your own DSH GUI; conversely, a conversation open in your GUI cannot be written by this server.

**3.4 Session ids are server-assigned.** Never invent one; take ids from `dsh_start` / `dsh_list`.

**3.5 ★ The write lock: one writer per conversation at a time.** A session suddenly stops responding with a vague error (`Internal error`, or "this session is in use") and re-dispatching doesn't help. Cause: a DSH session directory carries a **cross-process write lock** whose semantics are "**the holder keeps it while it lives**", with **no API to take it from a live holder**. This server keeps a DSH process alive per conversation, so the two sides are **mutually exclusive**: while we hold a conversation your own DSH GUI cannot open it, and while your GUI has it open our `session/resume` cannot acquire it. The error is opaque because `SessionAlreadyOwnedError` is not a standard JSON-RPC error — ACP wraps it as a generic `-32603 "Internal error"` and hides the real cause in `error.data` (this server now surfaces and translates it). Fix: read `lock_holder` from `dsh_status` — `stale-mcp` (our own orphan: the MCP died but its child still holds the lock) → `dsh_takeover` takes it and kills that orphan; `live-mcp` (another live dsh-mcp instance) → `dsh_release` on that side, or `dsh_takeover(force=true)`; `none` (most likely your GUI has it open) → **never killed by us** — close it in that window and retry.

**3.6 ★ "Taking the lock" means killing the holder, so we must know who that is.** The lock is a Windows named kernel semaphore, released by the kernel when the holder process dies — killing is the *only* way to take it. So this server registers a conversation **only once it actually holds it** (`<state dir>/locks/<conversation id>.json`, with pid + heartbeat). Holders it cannot identify are **never killed**. Why the GUI is untouchable: GUI conversations run inside the single **`dsh web` process** (not one process per conversation), so killing the lock holder would take down your entire UI *and every GUI conversation in that process, including the one you're reading*. Sessions on disk survive resumption, but in-flight turns are lost. **Operational rule: never open a conversation this server drives in your DSH GUI.** To view it there, `dsh_release` first and dispatch again afterwards (it resumes automatically).

**3.7 ★ Crash vs. wedge — measured, don't guess.** A **crash** (the MCP is killed or restarted): the DSH children it spawned **exit with it** — their stdio is a pipe to the parent, so closing it gives them EOF and they shut down. **The lock is therefore released automatically; no orphan keeps holding it**, so a restart always gets it back. The cost: **in-flight turns are interrupted and no sentinel lands** (the process is gone) — don't wait for that file, inspect the workspace (`git status`, files) and decide whether to re-dispatch. A **wedge** (the MCP is alive but stalled; no heartbeat for 90 s) is what `stale-mcp` really means, and `dsh_takeover` handles it **without `force`**. Judge with `dsh_status`'s `lock_holder` — and note that `none` does not mean "the lock is free"; it can also mean "a process we don't manage holds it" (usually the GUI).

**3.8 ★ The async dispatch lifecycle ("dispatch, wait for the task, come back later").** Dispatching asynchronously never leaves a half-held lock: the lock follows the **process** — alive means held, exited means released. Idle reaping is safe: past `DSH_MCP_IDLE_TTL_MS` (5 min default) the process is reaped, the lock is released, and the next dispatch resumes it automatically. Reaping **confirms the process really exited before deleting the registration** (otherwise the lock becomes anonymously held and even `dsh_takeover` refuses). Coming back later has three outcomes: the process is still alive → you continue; it was reaped or you released it → it is rebuilt and resumed automatically; **someone else holds the lock** → you get a "write lock is held" error that names the holder (see 3.5). The only case that loses work is a **crash or restart of the MCP server itself**: its children exit with it, in-flight turns are interrupted and **no sentinel lands** — inspect the workspace instead of waiting for that file.

**3.9 ★★ The silent privilege-escalation trap (the most dangerous pitfall here).** Symptom: `dsh_start(permission: 'read-only')` **returns** `"read-only"` while the session actually runs with **full access** — you think you are analysing a sample in a sandbox and you are not. Cause: if the profile sets `defaultPreset`, `dsh-permission-presets` applies it **at session creation** to the sandbox mode and approval policy, **overriding** the mode `dsh-base` derived from `DSH_PERMISSION_MODE`; pinning `danger-full-access` therefore escalates every session. Correct form: **define the presets but do not write `defaultPreset`**. The plugin then falls back to its inferred default (matching a preset by the sandbox + approval pair), and `dsh-base`'s rule — `mode = DSH_PERMISSION_MODE ?? 'workspace-write'`, `policy = (mode === 'danger-full-access') ? 'never' : 'ask'` — lines up with the three tiers exactly, so **each session's real tier is decided by the env passed at spawn time**. `profile-example/cordis.patch.yml` already does it this way. How to verify: **do not trust the tool's return value** (that is exactly what used to lie) — read **the session's own record** (`permissions.preset` / `sandboxMode` in the projection cache). `test/permission.mjs` does precisely that, checking all three tiers and that their recorded values differ. One more caveat: the tier is fixed at **`dsh_start`**; DSH is designed so that **a resumed session keeps its recorded permission**, so changing the `permission` argument later will not alter an existing conversation — create a new one to change tiers.

**3.10 ★★ Peeking at progress in the web UI takes the write lock away (measured A/B).** Method: have a **separate process** attempt `session/resume` on the same conversation — success means the lock is free, failure (`already owned`) means somebody is writing. That is the only way to see past our own registration table. Result: with the conversation only in the MCP's hands it is **free** (probed twice); the moment you **open** it in the web UI it becomes **held** (`already owned by an active write handle`), and since the only MCP server present had **no child processes**, the holder is the `dsh web` process. Precise wording: **reading content, searching and listing are unaffected** (the lease docs say readers proceed freely), but **the act of opening a conversation in the GUI** takes a write handle — it is not "only sending a message". This is the typical cause of "the task finished and the caller cannot get back in": the MCP dispatches and holds the lock, you open the conversation to watch progress, the GUI takes the lock, and when the task ends the caller's resume is refused. Correct habit: **do not click a running conversation open in the GUI.** To watch progress use **`dsh_read`** (the MCP tool, cursor-based incremental reads) or wait for the sentinel file; if you really want the GUI view, `dsh_release` first (which interrupts a running turn, so it only fits the gaps between tasks).

**3.11 ★★ Opening it once hands the conversation to the GUI permanently (measured; harsher than 3.10).** Measured: you open the conversation in the web UI (the GUI takes the lock), then **switch away to another conversation**, then we probe again — **the lock is still held**. So `dsh web` does **not** release it when you navigate away: **once opened, that conversation belongs to the GUI for the entire lifetime of the web process**, and the MCP cannot touch it again until you **restart `dsh web`**. That is why it is "always": it is not taken on every peek, it is taken once and stays taken — so from then on every retry fails until the GUI restarts. Practical advice: (1) never open a conversation the MCP drives, not even once — seeing its title in the list is fine; (2) to read content, have the agent call `dsh_read` and paste the output to you; (3) if you already opened it, **restart `dsh web`** — switching away in the UI does nothing.

**3.12 ★★ The lossless answer: keep the MCP holding the lock (`DSH_MCP_IDLE_TTL_MS=0`).** The full causal chain, all measured: a task finishes, the conversation sits idle for five minutes, **idle reaping kills the child and frees the write lock**, you happen to open that conversation in the web UI right then, **the GUI takes the lock and never returns it** (navigating away ✗, waiting ✗, **archiving ✗** — verified that the archive really landed), and from then on every MCP resume fails. That is "the caller can never get back in after a task". The fix: **`DSH_MCP_IDLE_TTL_MS=0` is now the default** (never reap), so the MCP keeps holding the write lock. Then opening it in the GUI **opens it read-only and you can still read it** (measured: the turns and answers are visible), and probing from a separate instance confirms **the holder is still this server's own PID with a fresh heartbeat** — the lock was never taken. **Neither side is harmed**: you keep visibility, while the MCP's turns keep running and later calls reconnect normally. Zero data loss, zero duplication, zero extra disk. The cost, measured: **~120 MB per live conversation** (three conversations = 428 MB, linear; ten ≈ 1.2 GB). It will not blow up, but it is real. Three ways to control it: ★ **on by default — `DSH_MCP_MAX_LIVE=8`**: over the cap, the **least recently used** process is reaped (a running turn is never reaped), giving "**bounded memory, locks kept where it matters**" ✓; **after a batch of work — `dsh_release(all=true)`** frees everything at once, dropping memory to zero ✓ and it is lossless (the logs are on disk, everything resumes on demand ✓); or set `DSH_MCP_IDLE_TTL_MS` to a millisecond value (at the cost of the lock being takeable ✗). In one line: reaping saves memory but hands the lock away; not reaping spends memory to buy "never silently locked out". Your data is never at risk either way: a GUI-pinned conversation is intact, and the MCP resumes it normally once `dsh web` restarts — what you lose is only immediate usability, not content.

## 4. Permissions and safety

**4.1 The default is full access.** DSH can touch anything your account can. That default exists because, unattended, ACP's approval channel tends to degrade into silent failures. For untrusted material (malware, unknown dumps, unfamiliar repos) use `permission: "read-only"`.

**4.2 `approval: never` means "deterministically reject", not "auto-allow".** It has no downside under `danger-full-access` only because the sandbox stops producing asks. To let the caller adjudicate escalation, use `workspace-write` + `on_approval: "ask"` + `dsh_approval_decide`.

**4.3 ★ Side effects of *external MCP tools* are NOT covered by DSH's sandbox.** DSH's permission tiers govern DSH's own file and shell tools. Tools from an MCP server mounted into DSH (e.g. IDA Pro's `patch` / `rename` / `set_comments`) execute **inside that MCP server**, where DSH's tier has no effect. For read-only work, forbid write-class tools **in the prompt** and verify afterwards that `tools_used` contains none. Do not rely on `permission` alone.

**4.4 Session logs contain plaintext.** DSH persists conversations under `~/.dsh/sessions` — that is what makes resume possible and it is outside this server's control (this server writes no conversation content to disk). Don't let the agent read credential files, and screen logs before sharing.

## 5. Interaction limits

| You want | Reality |
|---|---|
| Token-by-token streaming | ❌ Cannot enter model context (MCP limitation). Callers get per-step results; humans follow stderr logs |
| Mid-turn steering | ❌ ACP rejects concurrent prompts. `dsh_interject` is the equivalent: cancel + immediately start a new turn (~18 ms to converge) |
| Paste a screenshot | ❌ ACP advertises `promptCapabilities: {image: false}` |
| Rename a conversation | ❌ DSH's title subsystem has no external rename API; titles come from the first message |
| Have the agent ask you questions | ⚠️ `ask_user_question` isn't mounted in the sdk/acp profiles; it won't block waiting for you |

## 6. Workspace visibility

**6.1 "Effective" and "displayed" are different things.** Effectiveness depends on the conversation's `cwd` — always correct, verified. Display depends on `sessionIds` in `~/.dsh/storages/workspace.json`.

**6.2 ★ The running DSH server caches the registry in memory.** MCP-created conversations pile up under "Ungrouped" in the GUI. This server writes the registration file, but a running DSH won't re-read it — **restart DSH**. ⚠️ Before restarting, don't touch workspaces in the GUI, or the server will write its in-memory state back over the file.

**6.3 Temp directories are skipped by default** (`DSH_MCP_REGISTER_WORKSPACE=project`) so test runs don't flood your GUI. Use `all` to include them.

## 7. Privacy

**7.1 Silent by default** — not one byte. MCP's stdout is the protocol channel, and stderr lands in Claude/Codex's logs.

**7.2 Reasoning never reaches disk — with one deliberate exception.** It is not logged, and the state file holds metadata only. Only `dsh_read(include_reasoning=true)` returns live reasoning of the currently running turn, discarded when it ends.

**The exception: the async completion sentinel.** It must persist the *answer* (so a caller can collect offline), but `result.thinking` is **stripped** and replaced by `thinking_omitted: true` — even when `reasoning=full` was requested, no reasoning text appears in the file (a test guards this), while `dsh_get(run_id)` still returns it from memory. `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` breaks this on purpose.

**7.3 Be careful with `DSH_MCP_LOG_STDERR=1`** — it forwards DSH's raw stderr, which may contain reasoning. Local debugging only.

## 8. Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `no adapter registered for provider "xxx"` | profile lacks that provider | check `llm-pi-ai` in your profile patch |
| `no API key for provider route "deepseek-official"` | **classic trap**: `id: acp` not overridden | see §1.2 |
| `a prompt is already in flight for this session` | concurrent dispatch | `dsh_interject` / `dsh_interrupt` |
| `Invalid params: unknown session` | prompted an old id without resuming | handled automatically; seeing it means the flow was bypassed |
| `-32601 Method not found: session/setConfigOption` | ACP methods are snake_case | correct name is `session/set_config_option` |
| workspace does not exist / is not a directory | invalid `cwd` | create it, use an absolute path |
| `unknown conversation` | wrong id / different server instance | get ids from `dsh_list` |
| `unknown run_id` | record evicted (>20) or server restarted | drain `dsh_read`, or dispatch again |
| `DSH process is not running` | reaped or crashed | just dispatch again; it resumes automatically |
| resume fails | the conversation died before its first successful turn and may never have materialized | read-only history; start a new conversation |
| can't open a conversation in your GUI | this server holds the write lock | `dsh_release` first |
| GUI workspace edits wiped this server's registration | server overwrote the file from memory | re-run `--backfill`, and restart DSH before touching the GUI |
| waiter for the sentinel never returns | wrong path — usually a hand-converted Windows path | use **`sentinel_file_posix`** straight from the tool result; keep a timeout as a backstop |
| sentinel has no `thinking` field | intentional — reasoning never reaches disk | read `result.thinking_stats` for the numbers; use `dsh_get(run_id)` for the content while it's in memory |

## 9. Getting the best results

1. **Give goals, not commands.** DSH is an agent: say "add tests for this module and make them pass", not "run pytest". It picks tools, plans steps, and spawns subagents on its own.
2. **One conversation per task** — mixing unrelated work pollutes history and costs more.
3. **Split long work into dispatch + collect**: `wait=false` → do something else → `dsh_get(run_id)`.
4. **Review output via workspace changes** — `workspace_changed` / `diff_stat` tell you which files it touched.
5. **Ask for a plan first** if you want to approve before execution (DSH has plan mode).
6. **Three cost knobs**: lower `reasoning_effort`, keep `reasoning=hide`, release and start fresh.
7. **Don't paste large code blocks into the prompt** — tell it which file to read instead; DSH has its own file tools.