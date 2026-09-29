# DeepSeek-DSH-MCP

[English](README.md) | **中文**

一个 MCP 服务，让 **Claude Code / Codex / 任何 MCP 客户端**把 **DeepSeek Harness (DSH)** 当成一个**可长期共事的编码 agent** 来驱动 —— 开一个会话、给它目标、看它干活、中途插话打断、过一会儿再回来验收。

```
Claude / Codex  ──MCP(stdio)──▶  dsh-mcp
                                    │ 换行分隔 JSON-RPC（ACP）
                                    ▼
                            dsh --profile dsh-mcp        ← 每个会话一个长驻进程
                                    │
                                    ├─ DSH 自带工具（文件/shell/搜索/技能/子代理/workflow）
                                    └─ dsh-mcp-client ─▶ 你自己的其他 MCP 服务器（如 IDA Pro）
```

## 为什么需要它

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
| `dsh_send` | 派任务。`wait=true`（默认）阻塞到回合结束；**`wait=false` 立刻返回 `run_id`** |
| `dsh_list` | 所有会话及运行状态：`running` / `idle` / `detached`，已跑时长、当前工具、本轮输出。`only_running=true` 只看活动会话 |
| `dsh_read` | **游标式增量读**——看正在跑的会话此刻吐出了什么 |
| `dsh_get` | 会话详情；带 `run_id` 时返回**那一次派活的完整结果**（"回头验收"的入口） |
| `dsh_interject` | 会话在忙时插话：`interject` 打断并改口，`queue` 等本轮跑完接着说 |
| `dsh_interrupt` | 打断当前回合（会话不会损坏） |
| `dsh_release` | 交还会话（释放写锁，之后可在你自己的 DSH GUI 里打开）。仍可 resume |
| `dsh_approval_decide` | 裁决待决审批（仅当 `on_approval=ask`） |
| `dsh_status` | 轻量状态查询 |

## 用法：先派活，回头再验收

MCP 工具调用是**阻塞**的。如果让 `dsh_send` 等一个 10 分钟的任务，你自己的回合就被卡住，还可能撞上宿主的工具超时。所以长任务要这样：

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

`run_id` 是验收凭据。回合记录**只在内存、只留最近 20 条**；需要长期留存请自行落盘，或用 `dsh_read` 拉取。

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

**思考内容不落任何地方**：不写日志、不落盘。状态文件只有元数据（id、cwd、权限、计数），冒烟测试里有一条断言专门守这个。（DSH 自己会在 `~/.dsh/sessions` 写会话日志，那是 resume 的依据，不在本服务控制范围内。）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BIN` | 自动探测 | `@deepseek-ai/dsh/lib/bin.js` 路径 |
| `DSH_MCP_PROFILE` | `dsh-mcp` | 驱动用的 DSH profile |
| `DSH_MCP_STATE` | `<仓库>/.state/conversations.json` | 会话注册表，跨重启存活 |
| `DSH_MCP_PERMISSION` | `danger-full-access` | `dsh_start` 未指定时的权限档 |
| `DSH_MCP_REASONING_EFFORT` | `max` | 默认思考深度 |
| `DSH_MCP_IDLE_TTL_MS` | `300000` | 空闲多久回收会话进程（仍可 resume） |
| `DSH_MCP_PROMPT_TIMEOUT_MS` | `1800000` | 单回合等待上限 |
| `DSH_MCP_APPROVAL_TIMEOUT_MS` | `300000` | 待决审批的等待上限 |
| `DSH_MCP_REGISTER_WORKSPACE` | `project` | `project` / `all` / `0` |
| `DSH_MCP_LOG` | `silent` | `silent` / `info` / `debug` |
| `DSH_MCP_LOG_STDERR` | 未设置 | `1` 才转发 DSH 原始 stderr |

## 测试

```bash
node test/run.mjs          # 只跑冒烟（不消耗 token）
node test/run.mjs --all    # 全量
```

| 套件 | 检查数 | 覆盖 |
|---|---|---|
| `smoke` | 28 | 握手、工具表、建会话、配置、注册表纯净性 |
| `boundary` | 42 | 协议边界（重复 initialize、脏行、未知方法）、参数校验、未知 id、游标边界、生命周期幂等、unicode |
| `integration` | 30 | 跨进程 resume 与记忆、中断、两种插话 |
| `async` | 16 | fire-and-forget + 事后验收 |
| `concurrency` | 31 | 三会话并发 + 实时增量读 |
| `capability` | 22 | 写代码、跑脚本、**自行派子代理**（用磁盘上的子会话头验证） |
| `workspace-effect` | 24 | 不给路径时工作区是否真的生效 |
| `acceptance` | 36 | 两个文件夹 × 两个会话做只读 IDA Pro 分析 |

**合计 229 项检查，全绿。**

## 已知限制

1. **逐字流式进不了模型上下文** —— MCP 的固有限制，不是 DSH 的。调用方拿到的是分步结果；人能通过 stderr 日志跟进。
2. **真·中途改向做不到** —— ACP 明确拒绝并发 prompt（`a prompt is already in flight for this session`）。`dsh_interject` 是实用等价物：取消 + 立刻开新回合，历史保留。
3. **图片提示不支持** —— ACP 自报 `promptCapabilities: {image: false}`。
4. **`dsh_send` 默认阻塞** —— 长任务用 `wait=false`。
5. **首次成功回合之前就死掉的会话可能尚未落盘** —— 此时 resume 会报清晰错误。发出第一条消息后就安全了。
6. **不能改名** —— DSH 的标题子系统没有对外改名接口（`SessionTitleService.rename` 需要进程内的活会话）。标题一律由首条消息自动生成。
7. **`session/list` 只返回 `{sessionId, cwd}`，且排除已打开的会话** —— 对话名由本服务从 DSH 投影缓存补全。

## 许可

MIT —— 见 [LICENSE](LICENSE)。