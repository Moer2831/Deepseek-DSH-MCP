# DSH-MCP 功能设计（v0.2 草案）

> 目标：做一个 MCP Server，让 **Codex / Claude Code** 能调用 **DeepSeek Harness (DSH)** 当"外包工程师"——写代码、搭脚手架、跑任务，并且 DSH 自己还能挂它自己的 MCP。
>
> 本文只谈**功能与接口**，不写实现代码。所有技术判断都基于对本机 DSH 0.1.7-rc.2 的实测（见 §2 证据）。

---

## 0. ⚠️ 架构修订（v0.2）：后端改用 `acp` profile，不要用 `sdk`

初版把后端定成 `dsh --profile sdk`。**这是错的**——SDK 协议缺三样致命能力（不能恢复、不能中断、审批不可应答），而 **DSH 自带的另一个 profile 一次全给了**。

`dsh --profile acp` 的描述就是 *"Serve automation clients over Agent Client Protocol stdio"*——**它就是为程序化客户端准备的**，而且是同一套 `dsh-base` 能力面。实测它自报的能力：

```json
{"agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
 "agentCapabilities":{"sessionCapabilities":{"close":{},"list":{},"resume":{}},
                      "mcpCapabilities":{"http":true},
                      "promptCapabilities":{"image":false,"audio":false,"embeddedContext":false}},
 "authMethods":[]}
```

**两个协议的能力对照（SDK 列为实测的"做不到"，ACP 列为实测的"做得到"）：**

| 能力 | `sdk` profile | `acp` profile |
|---|---|---|
| **恢复会话** | ❌ 已存在 id 报 `already exists`，无 resume 方法 | ✅ **`session/resume` 跨进程实测通过**（杀掉创建者进程后在新进程恢复成功） |
| **中断回合** | ❌ 无 cancel，只能杀进程 | ✅ `session/cancel` → `AcpSession.cancel()` → `agent.cancel({kind:'user'})`（**和用户手动按停止是同一条路径**） |
| 会话列表 | ❌ 无 | ✅ `session/list`（注意：**只列"未打开"的**，见 §4.A2） |
| 关闭会话 | ❌ 无（只能关整个进程） | ✅ `session/close` |
| **审批应答** | ❌ 无通道，操作静默失败 | ✅ `session/request_permission` 客户端往返 → **中间档权限救回来了** |
| 灰/黑分流 | 同一 `assistant/message` 里靠 `type` 分 | ✅ **两个独立流通道**：`agent_thought_chunk`（灰）/ `agent_message_chunk`（黑） |
| 每会话 MCP 服务器 | ❌ 进程级配置 | ✅ `session/new` 与 `session/resume` 都接受 `mcpServers` 参数 |
| 模型/思考档 | 进程级 `initialize` | ✅ `session/setConfigOption`；**恢复时还会带回原会话的 `configOptions`** |
| 会话 id | 客户端指定 | 服务端分配（`session/new` 返回），恢复时原样传回 |

**唯一保留 SDK 协议理由的场景**：当你需要"自己指定会话 id"或"极简 3 方法"时。其余一律用 ACP。

传输层两者一样：**换行分隔 JSON-RPC over stdio**，且都绑定了 `stdin EOF → 有界退出`，所以生命周期管理代码可以共用。

**ACP 的三个坑（实测）：**
1. `session/list` **排除本进程已打开的会话**（设计如此——它是给客户端"打开最近会话"用的）。所以"列出全部"必须两路合并：本进程持有的 + `list` 返回的。
2. `session/list` 只返回 `{sessionId, cwd}`，**不含标题**（ACP schema 允许 `title`，但 dsh-acp 只映射了 id 和 cwd）。对话名仍需从 `session/title` 事件或投影缓存取。
3. `session/resume` **校验 cwd**：与持久化记录不同目录会报 `invalidParams: session cwd does not match`。恢复时必须传原工作区。
4. 图片提示**不支持**（`promptCapabilities.image: false`），初版 §4.B8 里"contentBlocks 支持图片"这条对 ACP 不成立。
5. 好消息：ACP 的 resume **不走** headless 那个 `assertAdoptable` 门槛 ⇒ **web GUI 建的会话也能被恢复**（headless 做不到，这正是初版卡死的地方）。

---

## 1. 一句话结论

**不要**把 DSH 当成"被 CLI 调用的命令行工具"来包，而要把它当成**可长驻的 agent 运行时**来驱动：

```
Codex / Claude  ──MCP(stdio)──▶  dsh-mcp（我们写）
                                      │ 换行分隔 JSON-RPC（ACP）
                                      ▼
                              dsh --profile acp        ← 每个会话一个长驻进程
                                      │
                                      ├─ 自己的工具（fs/pwsh/搜索/技能/子代理/workflow）
                                      └─ dsh-mcp-client ─▶ 用户自己的 MCP 服务器
```

会话的"活着"体现在进程上，但**因为 ACP 支持 `session/resume`，进程不再是单点故障**：进程崩了/被回收/被杀，重建一个进程 resume 回来即可继续对话。这是 v0.2 相对初版最重要的修正。

---

## 2. 已核实的技术底座

> 本节主要记录 **SDK 协议**的实测证据，用于对照与排错。**实际实现请走 §0 的 ACP 路线**；ACP 的报文形状见 §0 与 §5。

### 2.1 后端进程与协议（`dsh --profile sdk`）

传输：**换行分隔 JSON-RPC over stdio**（每行一个 JSON 对象，无 LSP 式 Content-Length 头）。实测握手成功、`shutdown` 干净退出（exit code 0）。

**客户端 → 服务端（仅 3 个方法）**

| 方法 | 参数 | 返回 |
|---|---|---|
| `initialize` | `{cwd, provider, model, reasoningEffort?, maxTokens?}` | `{serverInfo:{name:'deepseek-harness-sdk-runtime', version}}` |
| `session/prompt` | `{sessionId, contentBlocks:[...]}` | `{messageId}` |
| `shutdown` | — | `{}` |

**服务端 → 客户端（仅 4 个通知）**

| 通知 | 载荷 | 用途 |
|---|---|---|
| `session.event` | `{sessionId, event}` | **完整会话事件流**：助手消息、工具调用/结果、回合与步骤边界、标题… |
| `session.status` | `{sessionId, status:'idle'\|'running'}` | **回合完成判定** |
| `subagent.started` | `{parentSessionId, childSessionId}` | 子代理派生 |
| `subagent.finished` | `{parentSessionId, childSessionId, status, stopReason, lastAssistantMessage?}` | 子代理收尾 |

关键性质：
- `session/prompt` 的 `sessionId` **未知时惰性创建 agent+会话对** → 会话 id 完全由我们掌控，可以直接用 DSH 原生格式 `session-<uuid>`，于是**磁盘上的会话目录、标题、transcript 全部对齐**，用户在自己的 DSH GUI 里也能看到这些对话。
- ⚠️ **但传一个"已存在于磁盘"的 id 会直接报错**（实测 `{"code":-32603,"message":"session \"X\" already exists"}`），因为服务端只调 `agents.create()`，从不调 `agents.resume()`。**⇒ 跨进程恢复会话在这条协议上不可能。** 同一进程内复用同一 id 可以继续对话；进程一死，那个会话就再也接不回来了。
- `initialize` 一次定全局 `cwd/provider/model/reasoningEffort/maxTokens` → 想换模型或工作目录就得换进程。
- 协议**没有**会话列表、没有标题读取、没有重命名、没有中断方法 → 这些都要我们自己补（见 §4）。

### 2.2 会话身份、标题与存储

| 项目 | 事实 |
|---|---|
| 存储根 | `%USERPROFILE%\.dsh\sessions\<项目key>\<会话id>\session.v4.jsonl.zstd` |
| 项目 key | 工作目录转义而来，如 `--D-AI_MCP-DSH_MCP--` |
| 物理格式 | **多帧拼接 zstd**，每帧是一批已压缩的 JSONL 记录（实测 295KB 文件 = 189 帧 / 1.04MB 明文 / 349 条记录） |
| 首帧 | `{"type":"session", version, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset}` |
| **并行写锁** | `SessionWriteLease`：POSIX `flock` / **Windows 命名内核信号量**，持有者活着就**永不过期**，争用抛 `SessionAlreadyOwnedError`。**读者不受影响。** |
| 投影缓存 | `.dsh\storages\session_projcache\sessions\<id>.json` → `record.rows.title.val`（标题）、`sandboxMode`、`tokenUsage`、`contextPressure`；每 200 事件或 5 秒写一次 |
| 工作区注册表 | `.dsh\storages\workspace.json` → `workspaces[id] = {path, title, sessionIds, createdAt, updatedAt}` + `pinnedSessionIds` / `archivedSessionIds` |

**对话标题（用户明确要的功能）已经有两条原生来源：**

1. **会话日志里的 `session/title` 事件**：`{title, messageSeqs, source:{kind:'fallback'|'llm'}}`
   - `fallback` = 截取首条用户消息（`session-title` 插件配置：`fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80`）
   - `llm` = 由 `session-title-first-prompt-llm` 生成（`targetWords: 5, targetCjkCharacters: 10, maxOutputTokens: 64`，系统提示要求"用消息的语言、约 5 词 / 10 个汉字、纯文本"）。
     ⚠️ 该插件在 **sdk profile 里是 `disabled: true`**，所以走 SDK 起的会话默认只有 fallback 标题。我们的专用 profile 应当把它打开。
2. **投影缓存 `record.rows.title.val`**（读历史会话时用，读者不加锁，安全）。

> 因为 `session.event` 会把 `session/title` 推给我们，**活跃会话的标题是实时到手的**，不需要读磁盘。

### 2.3 内容模型：灰色字 vs 黑色字

DSH 在 LLM 层就区分两种增量：`text-delta`（黑）与 `reasoning-delta`（灰），并有 `joinAssistantStreamText()` 这类"只拼 text-delta、排除 reasoning"的读取器。

落到会话事件上，**已完成的消息已经把两者分好了字段**：

```jsonc
{"type":"assistant/message","data":{"turn":5,"step":11,"message":{
  "role":"assistant",
  "content":[
    {"type":"reasoning","text":"…灰色思考…"},
    {"type":"text","text":"…黑色正文…"},
    {"type":"tool-call","id":"call_…","name":"pwsh","arguments":"{…}"}
  ]}}}
```

实测某真实会话：43 条 `assistant/message` 中，`reasoning` 部件 43 个、`text` 部件 14 个、`tool-call` 部件 61 个。

**重要否定结论**：持久化日志里 `assistant/attempt.stream` 只存了 `usage` 和 `finish` 块；token 级增量被**打包压缩**进 `{type:'text-chunks'|'reasoning-chunks'|'tool-call-chunks', time0, index, dt[], texts[]}` 记录（`AssistantStreamRecord`），不是逐条实时事件。SDK 只转发持久化事件（`ctx.on("session/event") → notify("session.event")`），所以：

> **通过 SDK 协议拿不到真正的逐字流式增量。** 能拿到的是"每个 step 一条完整 assistant/message"。想在 MCP 侧做"逐字流式"必须换集成点（web 通道或 in-process 插件），代价很大——不建议 MCP 首选方案走这条路。见 §6 给出的替代设计。

### 2.4 DSH 自身能力面与 profile

Profile = `~/.dsh/profiles/<name>/`，由 `package.json` 的 `dsh.profile.bundles`（bundle 层）+ `cordis.patch.yml`（用户覆盖层，**`{id, name, config}` 数组，支持 `!!js` 表达式**）+ `--patch` 叠加组成。

实测 `--dump-config` 得知：

- **`sdk` profile 并不裸**：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-sdk-app`，已含全套编码能力——fs 读写、pwsh/bash、文件搜索、技能、agent 指令（AGENTS.md）、todo、目标、计划模式、子代理（spawn/fork）、workflow、压缩与工具结果剪枝、token 计量、沙箱与审批、会话持久化与投影缓存、会话标题。
- **它缺的是部署方的私有配置**：`llm-pi-ai` 没有 config（所以 `initialize` 里传一个未注册的 provider 名，会直接得到 `no adapter registered for provider "..."`），`agent-default-model` 仍是出厂默认（`deepseek-official/deepseek-flash`）。
  私有 provider 的完整定义（baseURL、apiKeyEnv、模型与 reasoningEfforts、contextWindow/maxTokens）只存在于你自己的 profile 补丁层里 —— 所以**本服务不自带任何 provider 配置**，请在你自己的 profile 中声明。
- 可直接用环境变量控制权限：`DSH_PERMISSION_MODE`（默认 `workspace-write`；设为 `danger-full-access` 时审批策略自动变成 `never`）。

**结论：我们必须自带一个专用 profile（例如 `mcp-bridge`），把用户的 provider/model 与所需能力 bundle 显式列进去**，不能直接复用 `sdk`。

### 2.5 让 DSH 用"自己的 MCP"

实测：`dsh-base` 和 web profile **都只挂了 `@deepseek-ai/dsh-mcp-resources`，没有挂 `@deepseek-ai/dsh-mcp-client`**；`.dsh` 下也没有任何现存 MCP 配置。所以"让 DSH 用 MCP"是纯新增能力，机制是往 profile 补丁层加条目：

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github              # [A-Za-z0-9_-]{1,32}，同作用域内唯一
    transport: stdio                # 或 streamable-http
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env: { GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN }
    toolCallTimeoutMs: 60000
    failOnStartupError: false
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }
```

要点：
- 工具以 `mcp__<serverName>__<rawName>` 注册——**和 Claude Code / Codex 的命名形状一致**。
- 默认**不启用任何服务器**；stdio 连接前会先起一个临时探针进程。
- `env` 是在**擦洗过的环境**上合并：环境里匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量和所有 `DSH_*` 会被丢弃，必须显式传。
- 不支持 MCP prompt 模板；资源按需读取。

---

## 3. 五个硬约束（设计必须先认下来）

1. **一个会话同一时刻只能有一个写者。** 写锁活到进程退出且不过期。⇒ "保持对话"= 长驻 SDK 进程；同时**用户在自己的 GUI/TUI 里打开同一个会话会失败**。因此必须有空闲回收 + 显式"交还会话"。
2. **`initialize` 的参数是进程级全局的。** 换 `cwd`/`model`/`reasoningEffort` 必须换进程 ⇒ 进程池按 `(cwd, provider, model, reasoningEffort)` 分桶。
3. **SDK 不提供会话列表/标题/重命名/中断。** ⇒ 列表读磁盘（投影缓存 + 日志 + `workspace.json`）、标题从 `session/title` 事件拿、重命名只能做我们自己的别名层、中断需要用别的办法（见开放问题 Q3）。
4. **MCP 拿不到逐字流式。** 且 MCP 工具结果最终是"文本进模型上下文"，宿主 UI 才会渲染 ⇒ 见 §6。
5. **递归风险。** DSH 能挂 MCP，我们能挂 DSH。若把 dsh-mcp 自己注册进 DSH 的 MCP 列表 → 无限递归。必须显式拒绝/检测。

6. ~~**会话不可恢复、回合不可中断、审批不可应答**~~ → ✅ **已在 v0.2 由改用 `acp` profile 解决**（见 §0）。以下仅作为"若坚持用 SDK 协议"的约束记录：
   - SDK 下复用已存在的会话 id → 报错；进程死 = 该会话永久只能只读；
   - SDK 下没有任何 cancel/interrupt 方法，**唯一停止回合的办法是杀进程**（代价同上）；
   - SDK 下没有审批通道，服务端从不发 server→client 请求，默认 `workspace-write` + `ask` 时所有需审批操作都以 `unavailable` **静默失败**（fail-closed）。
   - **ACP 下三条全部可用**：`session/resume` / `session/cancel` / `session/request_permission`。因此权限档也不必再被迫只留"完全权限"——中间档配审批往返是可行的。
   - 仍建议默认 `DSH_PERMISSION_MODE=danger-full-access`（少往返、少摩擦），但现在是**选择**而非**无奈**。注意 `approval.policy: never` 的语义是"每次询问都确定性拒绝"，不是自动放行。
7. **新增 profile 行必须用 `insert:`。** 裸写 `- id: xxx` + `name:` 是"覆盖已存在的行"语义，匹配不到 id 时只打印 `patch: entry not found` 然后**静默跳过**（官方 README 的示例恰好漏了 `insert:`，是个坑）。

补充：`workspace.json` 是单文件共享存储（原子写、后写覆盖），我们的进程和用户 GUI 同时改它可能互相覆盖 ⇒ 固定/归档这类写入要克制。

---

## 4. 功能清单

### A. 会话生命周期（用户点名要的"对话名字和 id"+"保持对话"）

| # | 功能 | 说明 |
|---|---|---|
| A1 | 新建会话 | 绑定 `cwd`（工程目录）、`model/provider`、`reasoningEffort`、权限档，生成 `session-<uuid>` 作为 id，返回 id + 标题 |
| A2 | 列出会话 | 合并三源：我们自己的注册表（活跃进程）→ 投影缓存（标题/token/上下文压力）→ `workspace.json`（按工程分组、置顶/归档）。支持按 `cwd`、时间、状态过滤 |
| A3 | 会话详情 | 标题、id、cwd、模型、创建/更新时间、回合数、token 用量、上下文压力、最后一条消息摘要、是否"活着" |
| A4 | 改标题 | DSH 自动标题只读；我们维护别名层（可写进我们自己的注册表），返回"原生标题 vs 别名"两个字段 |
| A5 | 恢复会话 | **SDK 协议不支持**（既有 id 会报 `already exists`）。可行路径只有：① 让 SDK 常驻进程永不死（配合 I3/I4）；② 新建会话并把旧 transcript 作为种子注入（伪造历史，注意 `isSeeded`/`session/end-seed`）；③ 自己写一个 DSH 插件补 `session/resume` 方法。headless 的 `--session-id` 也不能用作替代——它受 `assertAdoptable` 限制，**拒绝任何带 `agentPreset` 的会话**，而 web profile 创建的会话全部带 `agentPreset: "standard"`（实测 5/5 全被拒） |
| A6 | 交还会话 | 关闭进程、释放写锁，把会话还给用户 GUI；`keep`（保留历史）vs `delete` |
| A7 | 删除会话 | 删会话目录 + 投影缓存条目 + 注册表，需二次确认语义 |
| A8 | 置顶/归档 | 写 `workspace.json` 的 `pinnedSessionIds` / `archivedSessionIds`（注意约束 5 的写冲突） |
| A9 | 跨会话搜索 | 可选启用 `dsh-session-query-sqlite`（默认 `path: ':memory:', openAt: never`）建索引后检索历史 |
| A10 | 分叉会话 | 从某轮切出新会话（拷贝前缀事件 + 新 id） |

### B. 任务执行与运行控制

| # | 功能 | 说明 |
|---|---|---|
| B1 | 发任务（阻塞） | 发 prompt，等到 `session.status = idle`（或 `turn/end`）再返回结果 |
| B2 | 发任务（异步） | 立即返回 `run_id` + `sentinel_file`；回合终止时原子写出含最终结果的哨兵文件（见 B9），调用方用文件系统等待"跑完自动通知"，无需轮询 |
| B3 | 游标增量读取 | `read(run_id, cursor)` → 自上次以来的黑色正文 + 工具事件 + 新 cursor（"流式"的落地形态） |
| B4 | 打断 | 停止当前回合（协议无中断方法，实现路径见 Q3） |
| B5 | 运行状态 | `idle/running`、当前 turn/step、正在跑哪个工具 |
| B6 | 用量计量 | `tokenUsage.totals` / `contextPressure` / `contextWindow`，让调用方能管预算 |
| B7 | 回合排队 | 同会话内串行排队（DSH 单会话单回合），避免并发踩踏 |
| B8 | 上下文注入 | `contentBlocks` 支持文本与图片；支持 DSH 的 `@路径` 引用语法把文件带进会话 |
| B9 | 异步完成哨兵 | `wait=false` 的 run 终止（done/error/cancelled）时，往 `<RUNS_DIR>/<conversation_id>/<run_id>.json` 原子写出含 `status`+`result` 的文件；调用方（Claude/Codex）用后台任务 `until [ -f ]` 等它出现即被唤醒，无需轮询、也不占轮次 |

**B9 设计要点（并发正确性）**：本服务在 MCP 协议上只应答请求、**不主动推通知**，"跑完通知"由哨兵文件 + 调用方后台等待任务共同实现。
- **按会话分目录**：`run_id` 序号是每会话独立计数的，不同会话可能同毫秒生成同名 `run_id`；`<conversation_id>/` 前缀使其各写各的、不串台。会话内 `dsh_send` 忙时直接拒绝、序号单调，故会话内唯一。
- **闩锁语义**：文件写一次并保留 —— 即使 run 在等待任务启动前就完成，`[ -f ]` 也立刻为真，不漏。
- **原子落地**：`tmp`(带 pid+随机后缀) + `rename`，存在即完整；每个 run 独立 tmp，并发写互不覆盖（**刻意不复用** `save()` 那个共享 `${STATE_FILE}.tmp`）。
- **自带结果**：内存 run 记录只留最近 `MAX_RUNS` 条、并发多 run 时会被挤掉；哨兵内含 `result`，收活读文件即可，不依赖内存、且扛服务重启。
- **隐私（唯一的落盘例外）**：哨兵必须带上正文，调用方才能离线收活——所以它是本项目**唯一**会把对话内容写到磁盘的地方。但 `result.thinking` 默认被**剥掉**并置 `thinking_omitted: true`（`sanitizeResultForSentinel`），维持"思考不落盘"的总体保证；要连思考一起落盘必须显式设 `DSH_MCP_SENTINEL_INCLUDE_REASONING=1`。测试 `test/sentinel.mjs` 专门守这一点：请求 `reasoning=full` 时哨兵原文里不得出现思考文本，而同一 run 在内存（`dsh_get`）里仍可见。
- **留存**：哨兵是闩锁、不会自行消失，且内含正文，故服务**启动时**按 `DSH_MCP_SENTINEL_TTL_MS`（默认 7 天）清理过期哨兵与崩溃残留的 `.tmp`（`pruneSentinels`）。只在启动做一次，因此绝不会误删"当前正在等待的"哨兵。
- **给调用方的便利**：返回值同时给出 `sentinel_file_posix`（`D:\a\b` → `/d/a/b`）。手工转换 Windows 路径是等待任务白等到超时最常见的原因。
- **落点**：`tools.dsh_send` 的 `wait=false` 分支在 `.then`/`.catch` 各调一次 `hub.writeRunSentinel()`（覆盖所有终止态）；`createRun` 起跑前 `clearRunSentinel()` 防御历史残留。

### C. 输出与思考控制（用户点名要的"默认隐藏思考内容"）

| # | 功能 | 说明 |
|---|---|---|
| C1 | 思考档位 | `reasoning: hide`（默认）/ `marker`（只留占位与字数）/ `summary`（首 N 行或首尾）/ `full` |
| C2 | 输出形态 | `answer`（只要黑色正文）/ `transcript`（含工具调用与结果）/ `events`（原始事件流，调试用） |
| C3 | 工具调用展示 | 是否展示工具名/参数/结果；`hide_tool_args` 单独开关（参数里可能带密钥） |
| C4 | 密钥脱敏 | 返回值过一遍脱敏（真实会话日志里出现过明文 API key、token） |
| C5 | 长度与溢出 | `max_output_chars` + 超限落盘并返回文件引用（DSH 自己也有 spill：`maxInlineTokens: 12500`、工具结果剪枝 `thresholdChars: 8192`） |
| C6 | 思考统计 | 即使隐藏内容，也返回"思考了 N 字 / 用了 M 秒 / 几个步骤"，让调用方知道发生了什么 |

### D. 流式与进度（对应"黑色字仍然流式传输"）

| # | 功能 | 说明 |
|---|---|---|
| D1 | 进度通知 | MCP `notifications/progress`：阶段化推送（启动→思考→写代码→跑工具→完成） |
| D2 | 灰色思考走日志通道 | 用 MCP `notifications/message`（log, level=debug/info）推送思考——多数宿主渲染成**暗色/折叠旁注**，这正是"灰色字"最接近的等价物，且**不污染模型上下文** |
| D3 | 黑色正文增量 | 两种：游标轮询（B3）或"分块结果"（每步返回一段） |
| D4 | 订阅 | 会话 transcript 作为 MCP resource + `resources/subscribe`（Claude 支持；DSH 的 mcp-client 不支持，对称性要注意） |
| D5 | 心跳 | 长任务期间定期推进度，避免宿主判定超时 |

### E. 代码 / 脚手架专用（这是"用来做脚手架"的核心价值）

| # | 功能 | 说明 |
|---|---|---|
| E1 | **返回变更 diff** | 回合结束后返回工作区变更（`workspace/changes` 事件 + `git diff --stat`）。**让调用方 agent 能审阅 DSH 的产出再决定是否接受**——这是"外包工程师"模式的关键 |
| E2 | 计划模式 | 只出计划不落地（`dsh-plan-mode`），调用方批准后再执行 |
| E3 | 审查模式 | 对既有改动做对抗式审查 |
| E4 | 接受/回滚 | 会话级 checkpoint（DSH 有 `dsh-session-checkpoint-policy`）配合 git 做回滚 |
| E5 | 工程模板 | 把常见脚手架套路做成 MCP prompt 模板（如"初始化一个 X 项目"） |
| E6 | 测试/构建 | 不必单独做工具——DSH 自己有 pwsh/bash，发任务即可 |

### F. DSH 能力面（"允许 DSH 使用自己的 MCP"）

| # | 功能 | 说明 |
|---|---|---|
| F1 | **生成专用 profile** | 首次运行脚手架出 `~/.dsh/profiles/mcp-bridge/`：bundles + provider/model + 权限档 + 标题 LLM 打开 |
| F2 | **MCP 服务器增删查** | 往 profile 补丁层写 `dsh-mcp-client` 条目：`mcp_list` / `mcp_add` / `mcp_remove` / `mcp_test`（连通性探针） |
| F3 | 插件管理 | `plugins_list` / `plugin_add` / `plugin_remove`（走 `dsh plugin --profile …`） |
| F4 | 技能清单 | 列出 filesystem 技能与 office 技能 |
| F5 | 配置查看 | `--dump-config` 的等价能力，返回合成后的插件树 |
| F6 | 模型清单 | 可用 provider/model/`reasoningEffort` 档位（从 profile 配置解析） |
| F7 | 指令文件 | 报告 AGENTS.md / agent-instructions 的发现结果（`maxBytes: 65536`） |
| F8 | 自检 doctor | 凭据是否可用、profile 是否就绪、node 版本、Windows 执行策略、zstd 可用性 |

### G. 权限与审批（MCP 场景下最容易出事的地方）

| # | 功能 | 说明 |
|---|---|---|
| G1 | 权限档 | **默认 `danger-full-access`，其余档位可选**（用户已决策）。ACP 有审批往返后 `workspace-write` 不再是废档——它的越界操作会以 `session/request_permission` 冒泡给调用方裁决。`read-only` 适合分析不信任样本（恶意软件/来路不明 dump）的场景。⚠️ 任何档位都**不放开** `fs-observation-policy`（强制先读后写，要关需单独 patch 该行 `disabled: true`） |
| G2 | 环境变量通道 | 用 `DSH_PERMISSION_MODE` 控制沙箱与审批（`danger-full-access` ⇒ 审批 `never`） |
| G3 | **审批转交调用方裁决** | ✅ **v0.2 恢复**：ACP 有 `session/request_permission` 客户端往返（`dsh-acp/lib/index.js:1134`），所以 `dsh_approval_decide(conversation_id, approval_id, outcome)` 这类工具**做得出来**——把 DSH 的越权/提权请求冒泡给 Codex/Claude 决定，"一律放行"和"一律拒绝"之外的第三条路。裁定结果回落为 ACP 的 permission outcome（`allowed-once` / `rejected` / `cancelled`） |
| G4 | 工具白/黑名单 | 按会话限制可用工具 |
| G5 | 失败关闭 | 无人裁决时按 fail-closed 处理（DSH 原生行为就是如此） |

### H. MCP 协议形态

| # | 功能 | 说明 |
|---|---|---|
| H1 | Tools | 主接口，见 §5 |
| H2 | Resources | `dsh://conversation/<id>`、`/transcript`、`/diff`、`/profiles`、`/mcp-servers` |
| H3 | Prompts | 脚手架/审查模板 |
| H4 | 递归防护 | 拒绝把 dsh-mcp 自身注册进 DSH 的 MCP 列表；检测调用链深度 |
| H5 | 能力协商 | 按客户端能力决定是否发 progress/log 通知（Codex 与 Claude 支持度不同） |

### I. 运维

| # | 功能 | 说明 |
|---|---|---|
| I1 | 进程池 | 按 `(cwd, provider, model, reasoningEffort)` 复用长驻 SDK 进程 |
| I2 | 并发控制 | 全局上限 + 每会话互斥 |
| I3 | 空闲回收 | TTL 到期 shut down，**释放写锁**，把会话还给用户 |
| I4 | 崩溃恢复 | 注册表持久化到磁盘；启动时对账（哪些会话还活着、哪些锁被占） |
| I5 | 可观测 | 保留 DSH 的 stderr 诊断 + 自己的 NDJSON 事件日志，便于排障 |
| I6 | Windows 适配 | **本机 `dsh.ps1` 被执行策略拦住**（`running scripts is disabled`）⇒ 必须用 `node <bin.js>` 或 `dsh.cmd` 拉起，不能依赖 `.ps1` shim |
| I7 | 多 `DSH_HOME` | 支持隔离环境（测试/多账号），默认共用 `~/.dsh` 以共享凭据与历史 |

---

## 5. 工具接口草案

工具名统一 `dsh_` 前缀，避免与调用方自身工具撞名。

**会话**

| 工具 | 主要入参 | 返回 |
|---|---|---|
| `dsh_start` | `cwd, model?, provider?, reasoning_effort?, permission?, reasoning_mode?, title?` | `{conversation_id, title, cwd, model, created_at}` |
| `dsh_list` | `cwd?, limit?, include_archived?, only_alive?` | `[{id, title, cwd, updated_at, alive, turns, tokens}]` |
| `dsh_get` | `conversation_id` | `{id, title, alias?, cwd, model, turns, usage, context_pressure, last_message, alive}` |
| `dsh_rename` | `conversation_id, alias` | `{id, native_title, alias}` |
| `dsh_resume` | `conversation_id, permission?` | ⚠️ 见 A5，SDK 下不可行；退化为"新建 + 注入旧 transcript" |
| `dsh_release` | `conversation_id, delete?` | `{released, deleted}` |
| `dsh_delete` | `conversation_id, confirm` | `{deleted}` |
| `dsh_search` | `query, cwd?, limit?` | `[{id, title, seq, snippet}]` |

**执行**

| 工具 | 主要入参 | 返回 |
|---|---|---|
| `dsh_send` | `conversation_id, prompt, wait?, timeout_ms?, reasoning?, output?, max_chars?` | `wait=true`：`{run_id, status, answer, thinking_stats, tools_used, diff, usage, cursor}`；`wait=false`：`{run_id, accepted, background, sentinel_file}`（完成哨兵见 B9） |
| `dsh_run` | 同上但 `wait=false` 语义 | `{run_id, sentinel_file}` |
| `dsh_read` | `run_id, cursor?, reasoning?` | `{status, text_delta, events, cursor, done}` |
| `dsh_status` | `conversation_id` | `{status, turn, step, current_tool}` |
| `dsh_interrupt` | `conversation_id` | `{interrupted}` |
| `dsh_transcript` | `conversation_id, from_seq?, to_seq?, reasoning?, include_tools?` | 结构化 transcript |
| `dsh_diff` | `conversation_id, run_id?` | `{files, patch, stat}` |
| `dsh_decide_approval` | `conversation_id, approval_id, outcome` | `{decided}` |

**DSH 能力面**

| 工具 | 主要入参 | 返回 |
|---|---|---|
| `dsh_mcp_list` | `profile?` | `[{id, serverName, transport, command/url}]` |
| `dsh_mcp_add` | `profile?, serverName, transport, command?/args?/env?/cwd?/url?/headers?` | `{added, probed, tools[]}` |
| `dsh_mcp_remove` | `profile?, id` | `{removed}` |
| `dsh_profiles` | — | `[{name, bundles, path}]` |
| `dsh_profile_create` | `name, from?, providers?, model?` | `{created, path}` |
| `dsh_plugins` | `profile?` | `[{id, name, disabled}]` |
| `dsh_skills` | `cwd?` | `[skill]` |
| `dsh_models` | `profile?` | `[{provider, models:[{id, reasoningEfforts, contextWindow}]}]` |
| `dsh_doctor` | — | `{credentials, profile, node, execPolicy, zstd, ok}` |

---

## 6. "灰色字"在 MCP 里到底长什么样（重要澄清）

你的直觉来自 DSH 的终端 UI：思考是灰的、正文是黑的，都逐字滚出来。**MCP 没有颜色通道，也没有"把工具执行中的字符实时塞进模型上下文"的标准机制**——工具结果最终是一段文本，由**宿主的 UI** 决定怎么渲染。所以要拆成两件事来满足：

**① 默认隐藏思考 → 直接做到位（我们没有这个问题）**
`assistant/message.content[]` 已经把 `reasoning` 和 `text` 分成不同部件，默认丢弃 `reasoning` 即可，零成本、无歧义。同时返回"思考统计"（C6），让调用方知道 DSH 想过但看不到内容。

**② 想看思考时，用三条通道模拟"灰色"**

| 通道 | 效果 | 代价 |
|---|---|---|
| 塞进工具结果，用引用块/`<thinking>` 包裹 | 多数终端会以缩进/暗色渲染引用块，最接近"灰色" | 占用模型上下文（可能很贵） |
| 走 `notifications/message`（MCP log） | 宿主通常渲染为**暗色或折叠的旁注**，视觉上就是"灰色"，且**不占模型上下文** | 需要宿主支持 log 通知；不进模型视野 |
| 走 `notifications/progress` | 只显示"正在思考（已隐藏 1.2k 字）" | 看不到内容，但能感知节奏 |

**推荐默认组合**：结果里 `reasoning: hide` + 思考走 log 通知（灰色、可折叠、不烧 token）+ 正文走进度与分块结果（黑色）。

**③ "黑色字流式"的现实边界**
逐字流式是**宿主 UI 的能力**，MCP Server 只能提供"可增量拉取"和"进度推进"。所以落地为：
- `dsh_send(wait=false)` 拿 `run_id` → `dsh_read(run_id, cursor)` 反复拉增量（调用方 agent 每步都能看到新内容）；
- 同时用 progress/log 通知让**人**在 Codex/Claude 的终端里看到滚动的进度。

如果确实想要"人对着终端看灰黑逐字滚动"，正确做法是**另配一个瘦 CLI/TUI 伴生进程**（直连同一个会话），而不是硬塞进 MCP。这条可以在 M3 再说。

---

## 7. 非目标（明确不做，避免走偏）

1. **不把 DSH 的工具 1:1 代理出去**（不要暴露 `dsh_read_file`/`dsh_run_pwsh` 之类）。调用方 agent 已有自己的文件与命令工具；那样做只会变成又一层无意义的 shell。
2. **不做命令执行的通用包装**——我们的抽象单位是"对话 + 任务"，不是"命令"。
3. **不重实现会话存储**——直接复用 DSH 的目录与投影缓存，保证用户在 DSH GUI 里能看到同一批对话。
4. **不让 DSH 与调用方互相递归调用**（H4）。
5. **不做逐字流式的内核改造**（除非 M3 明确要求另配 TUI）。

---

## 8. 分期实施建议

**M1（打通闭环，最有价值）**
`dsh_start` / `dsh_send` / `dsh_list` / `dsh_get` / `dsh_release` + 专用 profile 脚手架（provider/model/权限/标题 LLM）+ 思考默认隐藏 + Windows 拉起方式 + 进程池与空闲回收。

**M2（把它变成好用的"外包工程师"）**
`dsh_diff`、计划模式、`dsh_read` 游标增量、progress/log 通知、审批**报告**（G3，注意不可应答）、脱敏、`dsh_search`（需先开 `session-query-sqlite` 的 `openAt`，默认 `never` 时全文搜索直接报 `SESSION_QUERY_SEARCH_DISABLED`）、resources/prompts。

**M3（能力面与体验）**
MCP 服务器增删查（F2）、插件与技能管理、`dsh_doctor`、分叉/回滚、可选 TUI 伴生进程。

---

## 9. 需要你决策的开放问题

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | 会话空间：与用户 GUI 共用 `~/.dsh`（历史统一、但会抢写锁）还是独立 `DSH_HOME`（隔离、但要另配凭据）？ | 默认共用，提供 `--dsh-home` 覆盖；MCP 起的会话打标记便于过滤 |
| Q2 | 空闲回收 TTL 默认值？（太长会占锁让用户打不开，太短会反复重启丢上下文） | 5 分钟，且 `dsh_release` 可显式交还 |
| Q3 | **中断怎么做？** SDK 协议没有 cancel，且杀进程 = 永久失去该会话（约束 6） | 强烈倾向 ②：写个极小 DSH 插件补 `session/interrupt`。① 已排除——headless 无法接管 web 建的会话 |
| Q4 | 默认权限档给哪一档？ | ✅ **已定：默认 `danger-full-access`，其余可选。** 成因几经变化：SDK 协议没有审批通道时中间档等于废档（越界操作静默失败）；**改用 ACP 后 `session/request_permission` 让中间档复活**，所以现在是"默认最省事 + 需要时可收窄"，而不是被迫只留一档。`read-only` 留给分析不信任样本的场景。注意 `approval.policy: never` 的语义是"每次询问都确定性拒绝"（不是自动放行），它只在 `danger-full-access` 下无副作用——因为沙箱根本不产生询问 |
| Q5 | 会话 id 是否直接采用 DSH 原生 `session-<uuid>`？ | ✅ 已定：采用。实测语义 = 全新 id 落成磁盘会话 id（磁盘/标题/GUI 全对齐）；已存在的 id 直接报错。故**每个会话只在首次 prompt 生成一次 id，之后仅在本进程内复用** |
| Q6 | 首版面向 Codex 还是 Claude Code？（两者 MCP 能力不同：progress/log 通知、resources、prompts 支持度有差异） | 先保 Codex 的保守子集（tools 即可），Claude 的增强能力渐进加 |
| Q7 | 要不要把 `session-title-llm` 打开（每个会话多一次小 LLM 调用换更好的标题）？ | 打开，标题质量对"列表里找对话"影响很大 |
| Q8 | 是否需要"多 DSH 会话协同"（一个 MCP 调用里让 DSH 用 subagent/workflow 并行）？ | DSH 原生已经支持，M1 不用额外做，但返回值要能体现子代理树 |

---

## 附：实现与验证

本文是**设计文档**，记录的是"为什么要这么设计"以及支撑它的实测证据。落地实现与可复跑的验证在别处：

| 位置 | 内容 |
|---|---|
| [`src/`](src) | 实现：ACP 客户端、会话池与注册表、工具层、MCP 服务端、工作区登记 |
| [`test/`](test) | 可复跑的测试套件（冒烟 / 边界 / 集成 / 异步 / 并发 / 能力 / 工作区有效性 / 验收），合计 229 项检查 |
| [`README.md`](README.md) / [`README.zh.md`](README.zh.md) | 使用文档（英文 / 中文） |
| [`profile-example/cordis.patch.yml`](profile-example/cordis.patch.yml) | DSH profile 补丁层模板（含两个必踩的坑的说明） |

设计期间用于取证的一次性探针（解码多帧 zstd 会话日志、对 `--profile sdk` 做零成本握手、对 IDA broker 做完整 MCP 握手、A/B 对照验证连接失败会报错等）在实现定型后已删除；其结论已固化进本文与测试断言。