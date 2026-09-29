# 🐳 DeepSeek-DSH-MCP

[English](README.md) | **中文**

> **让你的 Claude Code / Codex 多一个"能长期共事的编码搭子"** —— 背后是 DeepSeek Harness。

一个 MCP 服务端：把 DSH 当作**长驻的 agent 运行时**来驱动，而不是包一层命令行。开个会话、扔个目标，它自己写代码、跑脚本、派子代理；你随时能看、能插话、能回头验收。🛠️

🧪 339 项检查全绿 · 🔌 MCP over stdio · 📜 MIT · 💬 开发社区 [linux.do](https://linux.do/)

> 📌 **建议先读 [使用注意事项](USAGE-NOTES.md)** —— 会真正踩到的坑：ACP 模型配置陷阱、**外部 MCP 工具的副作用不受 DSH 沙箱约束**、工作区与 GUI 的注册表缓存、成本控制、以及一张故障速查表。

```
Claude / Codex  ──MCP(stdio)──▶  dsh-mcp
                                    │ 换行分隔 JSON-RPC（ACP）
                                    ▼
                            dsh --profile dsh-mcp        ← 每个会话一个长驻进程
                                    │
                                    ├─ DSH 自带工具（文件/shell/搜索/技能/子代理/workflow）
                                    └─ dsh-mcp-client ─▶ 你自己的其他 MCP 服务器（如 IDA Pro）
```

## ✨ 主要优势

|  |  |
|---|---|
| 🔄 **进程死了对话也不丢** | 对话身份在磁盘上。进程崩溃、被空闲回收、甚至整个服务重启，都不影响继续——下次调用自动 `resume`，记忆完整（跨进程实测）。 |
| 🗣️ **不用傻等** | 回合跑偏了能**插话改口**（打断收敛 ~18ms），或**排队**等这轮跑完再说；打断后会话不损坏。 |
| 📡 **跑完自动通知** | 长任务 `wait=false` 立刻返回 `run_id`；回合结束时**原子写出哨兵文件**，用你宿主的后台任务等它即可。不轮询、不占轮次。 |
| 🪟 **多会话并发** | `dsh_list(only_running)` 看谁在跑，`dsh_read` 游标式增量读——像切窗口一样轮流盯。 |
| 🧠 **灰色思考默认隐藏** | 只给"想了 N 字 / M 秒"的统计，不烧上下文；**不写日志、不落盘**。 |
| 🤫 **默认完全静默** | 一个字节都不输出，不污染宿主日志；stdout 只走协议。 |
| 🧩 **能力可叠加** | DSH 自己还能挂别的 MCP（IDA Pro、浏览器、内部工具）——这是一座通往整个工具箱的桥。 |
| 🛡️ **只读档真能只读** | `read-only` 沙箱 + 审批一律拒绝，适合分析不信任样本。 |

## ⚡ 为什么不是直接把 DSH 包一层

DSH 自带两个可编程入口。`sdk` profile 看着更简单，但它的 JSON-RPC 只有 **3 个请求 + 4 个通知**，缺了三样让 agent 实际不可用的能力；`acp` profile（Agent Client Protocol）全都有。以下结论全部针对 DSH `0.1.7-rc.2` 实测得出。

| 能力 | `sdk` profile | `acp` profile（**本项目**） |
|---|---|---|
| **恢复会话** | ❌ 无 resume 方法，复用 id 报 `already exists` | ✅ `session/resume`，**跨进程实测通过** |
| **中断回合** | ❌ 只能杀进程 | ✅ `session/cancel`，与用户手动按停止同一条路径 |
| **应答审批** | ❌ 无通道，操作静默 fail-closed | ✅ `session/request_permission` 往返 |
| 列出 / 关闭会话 | ❌ 无 | ✅ `session/list`、`session/close` |
| 灰字 vs 黑字 | 同一条消息里靠 `type` 字段分 | ✅ 两条独立通道 `agent_thought_chunk` / `agent_message_chunk` |
| 每会话 MCP 服务器 | ❌ 进程级 | ✅ `session/new` 与 `session/resume` 都接受 `mcpServers` |

**核心思想：进程只是缓存，不是身份。** 对话的身份是 DSH 的 `sessionId`，落盘在 `~/.dsh/sessions`。进程被回收、崩溃、甚至整个 MCP 服务重启，下一次调用都会自动 `session/resume` 把它接回来，历史完整保留。

## 前置要求

- **Node.js ≥ 20**
- **已安装 DSH**（`@deepseek-ai/dsh`），且 `~/.dsh` 下有可用凭据
- 一个由出厂 `acp` 模板派生、名为 **`dsh-mcp`** 的 DSH profile，里面要有**你自己的** provider/模型配置（本仓库刻意不带任何 provider 配置）

## 安装配置

### 1. 建 profile

```bash
dsh dsh-mcp --from-default-profile acp
```

然后编辑 `~/.dsh/profiles/dsh-mcp/cordis.patch.yml`，声明你的 provider 与模型。可以从 [`profile-example/cordis.patch.yml`](profile-example/cordis.patch.yml) 起步。

> ⚠️ **这里有两个坑**（都是踩出来的）：
>
> 1. **ACP 的模型不走 `agent-default-model`**，而是读 `dsh-acp` 插件自己的 `config.provider` / `config.model` —— 而 `acp` bundle 把它硬编码成了 `deepseek-official`。不覆盖 `acp` 这一行，会话会静默跑在错误的 provider 上，报 `no API key for provider route "deepseek-official"`。
> 2. **ACP 的 `reasoning_effort` 默认是空串**（= "Provider default"），不是最大档。本服务在每次 `session/new` 以及每次 `session/resume` 之后都会显式设成 `max` —— 因为新进程不会记住上一次的选择。

### 2. 注册 MCP 服务

**Claude Code**

```bash
claude mcp add dsh-mcp -- node /绝对路径/DeepSeek-DSH-MCP/bin/dsh-mcp.mjs
```

**Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.dsh-mcp]
command = "node"
args = ["/绝对路径/DeepSeek-DSH-MCP/bin/dsh-mcp.mjs"]
```

**通用 MCP 客户端**

```json
{
  "mcpServers": {
    "dsh-mcp": {
      "command": "node",
      "args": ["/绝对路径/DeepSeek-DSH-MCP/bin/dsh-mcp.mjs"]
    }
  }
}
```

### 3. 自检

```bash
node test/smoke.mjs        # 不调用 LLM，验证整条管道
```

## 工具

| 工具 | 作用 |
|---|---|
| `dsh_start` | 建会话：工作区、权限档、审批策略、**思考深度（默认 `max`）**、模型 |
| `dsh_send` | 派任务。**默认 `wait=false`：立刻返回 `run_id` + `sentinel_file`**，回合在后台跑，跑完由哨兵文件通知你（推荐）。`wait=true` 才原地阻塞到回合结束；到期（`timeout_ms`，默认 0 = 一直等）**只会转后台，不取消回合、不丢结果** |
| `dsh_list` | 所有会话及运行状态：`running` / `idle` / `detached`，已跑时长、当前工具、本轮输出。`only_running=true` 只看活动会话 |
| `dsh_read` | **游标式增量读**——看正在跑的会话此刻吐出了什么 |
| `dsh_get` | 会话详情；带 `run_id` 时返回**那一次派活的完整结果**（"回头验收"的入口） |
| `dsh_interject` | 会话在忙时插话：`interject` 打断并改口，`queue` 等本轮跑完接着说。**这一轮同样会写哨兵**，返回里给 `sentinel_file` |
| `dsh_takeover` | **抢占写锁**。锁被别的 DSH 进程占着时的唯一出路（DSH 没有夺锁 API，抢 = 杀掉持有者）。先判定持有者：本服务残留的孤儿 → 自动抢；另一个活着的实例 → 需 `force`；**GUI/未知 → 绝不杀**，只报告 |
| `dsh_interrupt` | 打断当前回合（会话不会损坏） |
| `dsh_release` | 交还会话（释放写锁，之后可在你自己的 DSH GUI 里打开）。仍可 resume |
| `dsh_approval_decide` | 裁决待决审批（仅当 `on_approval=ask`） |
| `dsh_status` | 轻量状态查询 |

## 用法：先派活，回头再验收

MCP 工具调用是**阻塞**的，所以 `dsh_send` **默认就不阻塞**（`wait=false`）：派完立刻拿到收据，回合在后台跑，跑完由哨兵文件唤醒你。整个流程是这样：

```text
1. dsh_send(conversation_id, prompt, wait=false)
     → { run_id: "run-abc123", background: true }        # 约 1ms 返回

2. …继续做你自己的事（实测：期间在另一个会话上跑完了一整个回合）…

3. dsh_status(conversation_id)
     → state=running | elapsed=3.5s | current_tool=pwsh | out=37 chars

4. dsh_read(conversation_id, cursor)                      # 中途偷看
     → [我] … | [轮次] 第 1 轮开始 | [工具] pwsh [in_progress]

5. dsh_get(conversation_id, run_id)                       # 验收
     → status=done, elapsed=20.3s, 完整答复
```

`run_id` 是验收凭据。回合记录**只在内存、只留最近 20 条**；并发跑很多 run 时旧记录会被挤掉，`dsh_get` 就会失败——这正是下面"完成哨兵"自带结果的原因。

## 用法：跑完自动通知（不轮询）

`wait=false` 除了 `run_id`，还会返回 **`sentinel_file`**（哨兵文件路径）以及 **`sentinel_file_posix`**（Bash/MSYS 形式，**直接用它，别无手工转换**——转错了等待任务会一直挂到超时）。回合结束时——**无论成功、失败还是被取消**——本服务都会往这个路径**原子写出**一个含最终 `status` 与 `result` 的小文件。于是你不用轮询、也不用傻等：**用你自己宿主（Claude/Codex）的后台任务等这个文件出现即可，文件一到就会唤醒你。**

```bash
# sent="$sentinel_file_posix"   ← 直接用工具返回里那个字段
sent='/d/AI_MCP/DSH_MCP/.state/runs/<conversation_id>/<run_id>.json'
dl=$(( $(date +%s) + 2100 ))          # 35min 兜底，防服务中途死掉时无限挂
until [ -f "$sent" ]; do
  [ "$(date +%s)" -ge "$dl" ] && { echo "TIMEOUT"; exit 1; }
  sleep 2
done
echo "DONE"                            # 后台任务退出 → 宿主唤醒你 → 读文件收活
```

文件出现后：**直接读它**即得 `status` 和 `result`（推荐——不受内存窗口限制、还扛服务重启），或用 `dsh_get(conversation_id, run_id)` 验收。

设计要点（尤其**多会话并发**）：

- **不串台**：哨兵路径为 `.state/runs/<conversation_id>/<run_id>.json`，按会话分目录。`run_id` 的序号是每会话独立计数的，不同会话在同一毫秒可能生成同名 `run_id`——分目录后各写各的，绝不互相覆盖。每个 run 起一个独立后台任务即可，各自完成、各自唤醒。
- **闩锁语义**：文件写一次并保留。即便 run 在你启动等待任务**之前**就已完成，`[ -f ]` 也立刻为真，不会漏。
- **原子落地**：`tmp` + `rename`，文件一旦存在内容必然完整；每个 run 用独立 tmp，并发写互不干扰。
- **无主动推送**：本服务在 MCP 协议上只应答请求、不发通知；"跑完通知"完全由这个哨兵文件 + 你的后台等待任务实现。
- **★ 哨兵里没有思考内容**：载荷只含正文与思考**统计**；`result.thinking` 会被剥掉并置 `thinking_omitted: true`——本项目的红线是思考不落盘。`dsh_get(run_id)` 在内存里仍能看到它（记录还在时）。设 `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` 可以故意打破这条保证。

> 清理：哨兵内含完整正文，所以服务**启动时会清掉超过 7 天的哨兵**（用 `DSH_MCP_SENTINEL_TTL_MS` 调；`0` 关闭）。等待任务消费后仍建议自行 `rm`。

## 用法：同时控制多个会话

```text
1. dsh_list(only_running=true)
     - … | id=448b239b… | 🔵进行中(已跑9s, 工具=pwsh, 本轮输出=40字) | cwd=…
     - … | id=33427096… | 🔵进行中(已跑8s, 本轮输出=34字)        | cwd=…
2. dsh_read(id,  cursor=0)      # 读第一个，记下 cursor
3. dsh_read(id2, cursor=0)      # 切到第二个
4. dsh_read(id,  cursor=<上次>) # 切回来，只拿增量
```

## 思考内容：默认隐藏

DSH 在模型层就把思考与正文分开，ACP 又把它们做成**两条独立流**。本服务默认隐藏思考内容，只返回**统计**（字数、耗时、段数）——调用方知道它想过，但不必为思考内容付上下文成本。

- `reasoning=hide`（默认）—— 丢弃内容，返回统计
- `reasoning=marker` / `summary` / `full` —— 逐步放出更多内容（注意上下文预算）
- `dsh_read(include_reasoning=true)` —— 只返回**当前正在跑那一轮**的实时思考；不进缓冲，回合结束即丢弃

## 权限

| 档位 | 审批默认 | 用途 |
|---|---|---|
| `danger-full-access`（默认） | `auto-allow` | 零摩擦 |
| `workspace-write` | `auto-allow` | 越界操作会冒泡为待决审批 |
| `read-only` | `auto-deny` | 分析不信任样本（恶意软件、来路不明 dump） |

`on_approval` 可选 `auto-allow` / `auto-deny` / `ask`（`ask` 会把审批挂起，交给 `dsh_approval_decide` 裁决）。

## 会话在 DSH GUI 里的可见性

两件事，别混淆：

| | 取决于 | 现状 |
|---|---|---|
| **工作区是否生效** | 会话的 `cwd` | ✅ 永远正确。进程工作目录、文件落点、沙箱可写根都跟着它 |
| **GUI 里是否分组** | `~/.dsh/storages/workspace.json` 的 `sessionIds` | ⚠️ 本服务会登记，但**正在运行的 DSH 服务把注册表缓存在内存里**，外部改文件要重启 DSH 才生效 |

**"生效"有实测**（[`test/workspace-effect.mjs`](test/workspace-effect.mjs)）：桌面两个文件夹各开一个会话，派活时**不给任何路径**，结果两个会话各自把文件写进了自己的工作区、自报的当前目录正确、没有泄漏到 MCP 服务工作目录 / 家目录 / 临时目录 / 另一个工作区（24/24 全过）。

维护命令：

```bash
node bin/dsh-mcp-workspaces.mjs --list                  # 查看注册表
node bin/dsh-mcp-workspaces.mjs --backfill              # 扫描磁盘上的会话，全部补登记
node bin/dsh-mcp-workspaces.mjs --prune-temp            # 清掉临时目录条目
node bin/dsh-mcp-workspaces.mjs --prune-empty           # 清掉"无会话且路径已不存在"的工作区
node bin/dsh-mcp-workspaces.mjs --purge-test-sessions   # 删测试会话（规则写得很死）
```

> ⚠️ 重启 DSH 之前**别在 GUI 里操作工作区**，否则服务会用内存状态把文件覆盖回去。

## 日志与隐私

默认**完全静默**，一个字节都不输出。

1. MCP 的 **stdout 是协议通道**，混进任何东西都会破坏报文；
2. 本服务被 Claude/Codex 拉起，它的 stderr 会进**对方的日志**；
3. DSH 子进程的 stderr 可能夹带模型输出（**含思考内容**），所以默认既不转发也不落盘。

| 级别 | 行为 |
|---|---|
| `silent`（默认） | 什么都不输出 |
| `info` | 只输出本服务自己的生命周期事件，**绝不含 DSH 的任何输出** |
| `debug` | 更细的本服务事件；仍不打印 DSH 输出 |
| `DSH_MCP_LOG_STDERR=1` | 额外转发 DSH 原始 stderr（**可能含思考内容**） |

**思考内容不落盘**，只有一个**刻意留下**的例外：

- 不写日志（默认静默）；状态文件只有元数据（id、cwd、权限、计数），冒烟测试里有一条断言专门守这个。
- **异步完成哨兵需要把正文写进文件**（否则调用方无法离线收活），但 `result.thinking` 会被**剥掉**并置 `thinking_omitted: true`。测试里专门验证了：即使请求 `reasoning=full`，哨兵里也不出现任何思考文本——而同一 run 在内存（`dsh_get`）里仍能看到。设 `DSH_MCP_SENTINEL_INCLUDE_REASONING=1` 可刻意打破这条。
- 哨兵默认 7 天后由启动清理删除（`DSH_MCP_SENTINEL_TTL_MS`，`0` 表示永久保留）。

（DSH 自己会在 `~/.dsh/sessions` 写会话日志，那是 resume 的依据，不在本服务控制范围内。）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BIN` | 自动探测 | `@deepseek-ai/dsh/lib/bin.js` 路径 |
| `DSH_MCP_PROFILE` | `dsh-mcp` | 驱动用的 DSH profile |
| `DSH_MCP_STATE` | `<仓库>/.state/conversations.json` | 会话注册表，跨重启存活 |
| `DSH_MCP_RUNS_DIR` | `<状态文件同目录>/runs` | 异步完成哨兵的根目录（`<此目录>/<会话id>/<run_id>.json`） |
| `DSH_MCP_SENTINEL_TTL_MS` | `604800000`（7 天） | 启动时清理超过此时长的哨兵；`0` 关闭清理 |
| `DSH_MCP_SENTINEL_INCLUDE_REASONING` | 未设置 | `1` 会把 `result.thinking` 一并写进哨兵（**打破"思考不落盘"的保证**） |
| `DSH_MCP_PERMISSION` | `danger-full-access` | `dsh_start` 未指定时的权限档 |
| `DSH_MCP_REASONING_EFFORT` | `max` | 默认思考深度 |
| `DSH_MCP_IDLE_TTL_MS` | `300000` | 空闲多久回收会话进程（仍可 resume） |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `0`（不设超时） | **仅 `wait=true` 时**的等待上限；到期只转后台，不取消回合 |
| `DSH_MCP_APPROVAL_TIMEOUT_MS` | `300000` | 待决审批的等待上限 |
| `DSH_MCP_REGISTER_WORKSPACE` | `project` | `project` / `all` / `0` |
| `DSH_MCP_LOG` | `silent` | `silent` / `info` / `debug` |
| `DSH_MCP_LOG_STDERR` | 未设置 | `1` 才转发 DSH 原始 stderr |

## 测试

```bash
node test/run.mjs          # 只跑冒烟（不消耗 token）
node test/run.mjs --all    # 全量
node test/cleanup.mjs      # 单独跑收尾清理（只针对临时目录；--dry-run 可预演）
```

测试套件**会自己收尾**：`run.mjs` 结束时必定执行 `cleanup.mjs`，它只清理**系统临时目录里**的测试会话与工作区登记，**绝不动**真实项目里的会话，也不动仓库的 `.state/`（那是你实际使用 MCP 时的会话注册表与哨兵）。要连桌面 `dsh-mcp-test-*` 一起清，得显式跑 `node bin/dsh-mcp-workspaces.mjs --purge-test-sessions`。

| 套件 | 检查数 | 覆盖 |
|---|---|---|
| `smoke` | 28 | 握手、工具表、建会话、配置、注册表纯净性 |
| `boundary` | 42 | 协议边界（重复 initialize、脏行、未知方法）、参数校验、未知 id、游标边界、生命周期幂等、unicode |
| `integration` | 30 | 跨进程 resume 与记忆、中断、两种插话 |
| `async` | 16 | fire-and-forget + 事后验收 |
| `sentinel` | 36 | 完成哨兵：原子性、闩锁语义、多会话并发不串台、被取消也落地、**思考不进文件** |
| `lock` | 39 | **写锁与抢占**：锁错误识别、四类持有者判定、孤儿列举；**端到端**用两个真实 MCP 实例抢同一会话 → 清晰报错 → 拒绝 → `force` 抢占成功 → 接管后可用；以及**插话那一轮也写哨兵**的回归 |
| `timeout` | 34 | **超时语义**：`wait=false` 不受 `timeout_ms` 影响、`wait=true` 到期只转后台（不取消/不丢结果、`busy` 不说谎）、`timeout_ms=0` 一直等、resume 失败会作废进程而不永久卡死 |
| `concurrency` | 31 | 三会话并发 + 实时增量读 |
| `capability` | 22 | 写代码、跑脚本、**自行派子代理**（用磁盘上的子会话头验证） |
| `workspace-effect` | 24 | 不给路径时工作区是否真的生效 |
| `acceptance` | 36 | 两个文件夹 × 两个会话做只读 IDA Pro 分析 |

**合计 339 项检查，全绿。**

## 🔒 写锁：一个会话同一时刻只能有一个写者

DSH 的会话目录有**跨进程写锁**，语义是「**持有者活着就永不过期**」，而且**没有 API 能从活的持有者手里夺走**。这带来两条硬约束：

- 本服务为"保持对话"让一个 DSH 进程常驻 → 期间**你自己的 DSH GUI 打不开这个会话**；反过来，你在 GUI 里开着的会话，本服务也动不了。**两边互斥。**
- 撞上时 DSH 会抛 `SessionAlreadyOwnedError`，但它**不是** JSON-RPC 的标准错误，会被 ACP 包装成笼统的 `-32603 "Internal error"`，真实原因藏在 `error.data` 里。本服务会把 `data` 取出来，翻译成人话并给出可执行动作。

**`dsh_status` 的 `lock_holder` 字段告诉你锁在谁手上**，`dsh_takeover` 按四类分别处置：

| `lock_holder` | 含义 | 抢占行为 |
|---|---|---|
| `self` | 本进程持有 | 无需抢占 |
| `stale-mcp` | **本服务自己留下的孤儿**（MCP 崩了/重启了，子进程还活着握着锁） | ✅ **自动杀掉并接管**（安全） |
| `live-mcp` | 另一个**活着**的 dsh-mcp 实例在用 | ⚠️ 默认拒绝，`force=true` 才夺 |
| `none` | 无登记 —— **多半是你自己的 DSH GUI 正开着它** | ❌ **绝不杀**（那会把你的整个界面、连同正在看的对话一起杀掉），只报告 |

> **操作铁律**：本服务驱动的会话**不要在 DSH GUI 里打开**。要用 GUI 看，先 `dsh_release` 交还；看完再重派（会自动 resume）。
>
> 补充说明：GUI 的会话**跑在 `dsh web` 那个进程里**（不是一会话一进程），所以"杀掉占锁的 GUI"= 杀掉整个 web 服务 = 所有 GUI 会话一起断（磁盘上的会话可 resume，但进行中的回合会丢）。这就是上表最后一行宁可拒绝的原因。

## 已知限制

1. **逐字流式进不了模型上下文** —— MCP 的固有限制，不是 DSH 的。调用方拿到的是分步结果；人能通过 stderr 日志跟进。
2. **真·中途改向做不到** —— ACP 明确拒绝并发 prompt（`a prompt is already in flight for this session`）。`dsh_interject` 是实用等价物：取消 + 立刻开新回合，历史保留。
3. **图片提示不支持** —— ACP 自报 `promptCapabilities: {image: false}`。
4. **`dsh_send` 默认阻塞** —— 长任务用 `wait=false`，再用完成哨兵文件（`sentinel_file`）做"跑完自动通知"，不必轮询。
   本服务不会主动发 MCP 通知，"通知"靠哨兵文件 + 调用方的后台等待任务实现。
5. **首次成功回合之前就死掉的会话可能尚未落盘** —— 此时 resume 会报清晰错误。发出第一条消息后就安全了。
6. **不能改名** —— DSH 的标题子系统没有对外改名接口（`SessionTitleService.rename` 需要进程内的活会话）。标题一律由首条消息自动生成。
7. **`session/list` 只返回 `{sessionId, cwd}`，且排除已打开的会话** —— 对话名由本服务从 DSH 投影缓存补全。

## 💬 社区

本项目的发布与讨论都在 **[linux.do](https://linux.do/)** —— 使用问题、踩坑经验、改进建议都欢迎到那里聊。提 issue 也可以，但在社区里通常回得更快。

## 许可

MIT —— 见 [LICENSE](LICENSE)。