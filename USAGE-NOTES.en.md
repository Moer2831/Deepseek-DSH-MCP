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

**2.1 Long tasks must use `wait=false`.** MCP calls block; `dsh_send(wait=true)` occupies the caller's own turn. Use `wait=false`, get a `run_id`, and collect later with `dsh_get(conversation_id, run_id)`.

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