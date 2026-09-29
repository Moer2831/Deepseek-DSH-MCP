# 使用注意事项

[English](USAGE-NOTES.en.md) | **中文**

让 Claude / Codex 通过本 MCP 驱动 DSH 时，会真正踩到的坑与关键取舍。每条都写成 **现象 → 原因 → 对策**。

---

## 一、注册与启动

### 1.1 profile 必须先建，否则连不上模型
- **现象**：所有回合都失败，报 `no adapter registered for provider "xxx"`。
- **原因**：本服务不自带任何 provider 配置，它驱动的是 `~/.dsh/profiles/dsh-mcp/` 这个 profile。
- **对策**：`dsh dsh-mcp --from-default-profile acp`，然后照 [`profile-example/cordis.patch.yml`](profile-example/cordis.patch.yml) 填上你自己的 provider。

### 1.2 ★ 最常见的坑：ACP 的模型不走 `agent-default-model`
- **现象**：明明在 `agent-default-model` 里配了自己的 provider，会话却报 `no API key for provider route "deepseek-official"`。
- **原因**：ACP 的模型读的是 `dsh-acp` 插件自己的 `config.provider` / `config.model`，而 `acp` bundle 把它**硬编码**成了 `deepseek-official`。
- **对策**：profile 补丁层里必须覆盖 `id: acp` 那一行的 `config`：
  ```yaml
  - id: acp
    name: "@deepseek-ai/dsh-acp"
    config:
      provider: <你的 provider>
      model: <你的模型>
  ```

### 1.3 ACP 的思考深度默认**不是** max
- **现象**：以为思考深度已经是最大档，其实没有。
- **原因**：ACP 的 `reasoning_effort` 初始值是**空串**（= "Provider default"）。
- **对策**：本服务已在每次 `session/new` 与每次 `session/resume` 之后显式设成 `max`，你无需处理；但要记住这是本服务补的，不是 DSH 的默认行为。想省钱就在 `dsh_start` 传 `reasoning_effort: low|medium|high|xhigh|default`。

### 1.4 千万别把 dsh-mcp 自己注册进 DSH 的 MCP 列表
- **现象**：无限递归 —— DSH 调用 dsh-mcp，dsh-mcp 再拉起一个 DSH……
- **原因**：DSH 是 MCP 客户端，本服务是 MCP 服务端，两边都能挂对方。
- **对策**：不要把它写进任何 DSH profile 的 `dsh-mcp-client` 条目。

### 1.5 `DSH_BIN` 探测失败
- **现象**：启动即报 `DSH CLI 入口未找到`。
- **原因**：DSH 装在非常规位置（本服务按 npx 缓存 → npm 全局 → 常见路径的顺序通配搜索）。
- **对策**：显式设置 `DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js`。

---

## 二、成本与预算（最容易失控的一块）

### 2.1 `dsh_send` **默认就不阻塞** —— 别再多此一举传 `wait=false`
- **现状**：`wait=false` 已经是**默认值**。派完立刻拿到 `run_id` + `sentinel_file`，回合在后台跑，跑完由哨兵文件唤醒你。
- **什么时候才该传 `wait=true`**：只有你真要"原地等结果"时。它会占住调用方自己的回合；到达 `timeout_ms`（**默认 0 = 一直等**）后**不会取消回合、也不会丢结果**，只会转成后台并把收据给你。所以"超时"再也不是灾难，你不必再自己发明超时。
- **验收**：`dsh_get(conversation_id, run_id)`，或直接读哨兵文件（推荐，不受内存窗口限制）。

### 2.2 会话是"长期"的，历史会一直累积
- **现象**：同一个会话聊到后面越来越贵、越来越慢。
- **原因**：`conversation_id` 复用时会带着完整历史继续；token 成本随轮数线性上升。
- **对策**：**一个会话干一件事**，做完就 `dsh_release`；新任务开新会话。需要长跑时留意 `dsh_get` 返回的 `context_pressure`。

### 2.3 上下文压缩会让模型"忘记"老细节
- **现象**：聊了很久之后，agent 记不清早期的具体内容。
- **原因**：DSH 在压力到阈值时会自动压缩（摘要化的旧内容 + 保留最近一部分），**模型看不到老细节了**（注意：磁盘上的会话日志并没丢，压缩只是"模型视角"的）。
- **对策**：关键约束在每轮里重申；或者把重要结论自己记下来。`dsh_get` 的 `context_pressure.pressureTokens / contextWindow` 能提前看出压力。

### 2.4 `reasoning=full` 很烧上下文
- **现象**：账单比预期高很多 / 上下文很快被撑满。
- **原因**：思考内容往往比正文长好几倍。
- **对策**：默认就用 `hide`（只给字数/耗时统计）。真需要时用 `marker` 或 `summary`，`full` 只在排障时短暂使用。

### 2.5 回合记录只在内存、只留 20 条
- **现象**：过一会儿再 `dsh_get(run_id)` 报 `未知 run_id`。
- **原因**：run 记录（含结果正文）只在内存里，服务重启即消失，且只保留最近 20 条。
- **对策**：用 `wait=false` 时**直接靠完成哨兵文件收活**（它自带结果、不受内存窗口限制、还扛服务重启）；否则当场落盘，或用 `dsh_read` 把输出缓冲拉干（同样是内存、有界 500 条）。

### 2.6 哨兵文件会占磁盘
- **现象**：`.state/runs/<会话id>/` 下文件越攒越多，每个都含完整正文。
- **原因**：哨兵是**闩锁**——写一次并保留，晚到的等待方才能不漏，所以它不会自己消失。
- **对策**：服务**启动时会清掉超过 7 天的**（`DSH_MCP_SENTINEL_TTL_MS` 调，`0` 关闭）。等待任务消费后顺手 `rm` 更干净。哨兵**不含思考内容**（`result.thinking` 被剥掉并标 `thinking_omitted`）。

---

## 三、并发与会话管理

### 3.1 一个会话同一时刻只能跑一个回合
- **现象**：`dsh_send` 报"会话正在跑另一个回合"。
- **原因**：ACP **明确拒绝并发 prompt**：`a prompt is already in flight for this session`。
- **对策**：改口用 `dsh_interject`（`interject` 打断改口 / `queue` 排队接着说），或先 `dsh_interrupt`。

### 3.2 空闲 5 分钟进程会被回收
- **现象**：`dsh_status` 显示 `detached`。
- **原因**：省资源。**这不是错误** —— 会话本体在磁盘上，下次派活会自动 `session/resume` 复活，历史完整。
- **对策**：不用管。想让它一直热着就调大 `DSH_MCP_IDLE_TTL_MS`，或者定期 `dsh_status`（会刷新 `lastUsedAt` 吗？不会——只有派活算使用。所以真要常驻就调 TTL）。

### 3.3 同一个会话别在两处同时打开
- **现象**：你自己的 DSH GUI 打不开某个会话，或者对方报被占用。
- **原因**：DSH 的会话目录有**跨进程写锁**，持有者活着就不过期。
- **对策**：`dsh_release` 交还会话（释放写锁），之后你就能在 GUI 里打开它；反之，你在 GUI 里开着的会话，本服务也写不进去。

### 3.4 会话 id 是服务端分配的，不要自己编
- **现象**：拿一个手写的 id 去 `dsh_get`，报 `未知会话`。
- **原因**：id 由 DSH 在 `session/new` 时分配，本服务原样保留。
- **对策**：一律从 `dsh_start` / `dsh_list` 拿 id。

---

### 3.5 ★ 写锁：一个会话同一时刻只能有一个写者
- **现象**：某个会话突然动不了，报错含糊（`Internal error` 或「当前会话已被占用」），重派也没用。
- **原因**：DSH 的会话目录有**跨进程写锁**，语义是**持有者活着就永不过期**，而且**没有 API 能从活的持有者手里夺走**。本服务为"保持对话"让 DSH 进程常驻，于是两边**互斥**：
  - 本服务持有期间，**你自己的 DSH GUI 打不开这个会话**；
  - 你在 GUI 里开着的会话，本服务的 `session/resume` 也拿不到锁。
- **为什么错误看不懂**：`SessionAlreadyOwnedError` 不是 JSON-RPC 标准错误，会被 ACP 包成笼统的 `-32603 "Internal error"`，真实原因藏在 `error.data` 里（本服务现在会取出来并翻译成人话）。
- **对策**：看 `dsh_status` 的 `lock_holder` 字段：
  - `stale-mcp`（本服务自己留下的孤儿：MCP 崩了/重启了，子进程还握着锁）→ `dsh_takeover` **直接抢**，会自动杀掉那个孤儿子进程；
  - `live-mcp`（另一个活着的 dsh-mcp 实例在用）→ 先在那边 `dsh_release`；确实要夺用 `dsh_takeover(force=true)`；
  - `none`（多半是你自己的 GUI 开着它）→ **本服务绝不杀**，请在那个窗口里关掉该会话后重试。

### 3.6 ★ "抢锁" = 杀掉持有者，所以必须先知道那是谁
- **原因**：锁是 Windows 命名内核信号量，持有者进程一死内核就释放 —— 这是**唯一**的夺锁手段。
- **所以**本服务只登记**自己的子进程在真正拿到锁之后**的持有状态（`<状态目录>/locks/<会话id>.json`，含 pid + 心跳）。判定不了的持有者**一律不杀**。
- **为什么对 GUI 绝不杀**：GUI 的会话跑在 **`dsh web` 那一个进程里**（不是一会话一进程）。杀掉占锁的它 = 整个界面 + **该进程里所有 GUI 会话（含你正在看的那个）一起断**。磁盘上的会话能 resume，但进行中的回合会丢。
- **操作铁律**：本服务驱动的会话**不要在 GUI 里打开**。要用 GUI 看，先 `dsh_release` 交还；看完再重派（会自动 resume）。

### 3.7 ★ 崩溃 vs 卡死（实测结论，别猜）
- **崩溃**（MCP 被强杀 / 重启）：它拉起的 DSH 子进程会**跟着退出** —— 子进程的 stdio 是连着父进程的管道，管道一关它就见到 EOF 自杀。所以**锁会自动释放，不会留下握着锁的孤儿**，重启后总能拿回来。
  - 代价是：**进行中的回合会被中断，而且哨兵不会落地**（进程没了）。这时**别干等哨兵**，去核对工作区状态（`git status` / 文件），再决定是否重派。
- **卡死**（MCP 还活着但不动了，心跳超过 90 秒没续）：这才是 `stale-mcp`，用 `dsh_takeover`（**不需要 force**）自动接管。
- **判据**：看 `dsh_status` 的 `lock_holder`。注意 `none` 不等于"锁空着"，也可能是"锁在非本服务的进程手里"（多半是 GUI）。

### 3.8 ★ 异步派活的生命周期（"派完 → 等 task → 回头再进"）
- **不会**因为你异步派活就留下什么"半持锁"状态：锁跟着**进程**走 —— 进程活着就握着，进程退出就释放。
- **空闲回收是安全的**：空闲超过 `DSH_MCP_IDLE_TTL_MS`（默认 5 分钟）后回收进程 → 锁释放 → 下次派活自动 resume 复活。回收时**先确认进程真的退出、再删登记**（否则锁会变成"无名持有"，连 `dsh_takeover` 都拒绝）。
- **回头再进的三种情形**：
  - 进程还活着 → 直接续上 ✓
  - 进程已被回收（或你 `dsh_release` 过）→ 自动重建 + resume ✓
  - **锁被别人占着** → 报"写锁被占用"并告诉你是谁（见 §3.5）✓
- **唯一会丢东西的情况**：**MCP 服务本身**崩了/被重启 —— 它拉起的子进程会一起退出，进行中的回合中断且**哨兵不会落地**。这时去核对工作区状态，别干等哨兵。

## 四、权限与安全（认真看）

### 4.1 默认是"完全权限"
- **现象**：DSH 能碰你账户能碰的任何东西。
- **原因**：默认 `danger-full-access` —— 这是为了零摩擦，因为**ACP 的审批通道在无人值守时很容易变成"静默失败"**。
- **对策**：分析不信任的东西（恶意软件、来路不明的 dump、陌生仓库）时，用 `permission: "read-only"`（沙箱只读 + 审批一律拒绝）。

### 4.2 `approval: never` 的语义是"确定性拒绝"，不是"自动放行"
- **现象**：以为关掉审批就万事大吉，结果某些操作还是失败。
- **原因**：`never` = 每次询问都返回拒绝。它之所以在 `danger-full-access` 下没副作用，是因为沙箱根本不产生询问。
- **对策**：需要"越界操作由调用方裁决"时，用 `permission: "workspace-write"` + `on_approval: "ask"`，再用 `dsh_approval_decide` 裁决。

### 4.3 ★ MCP 工具的副作用**不受** DSH 沙箱约束
- **现象**：以为设了 `read-only` 就绝对安全，结果 IDA 数据库被改了 / 外部系统被写了。
- **原因**：DSH 的沙箱管的是它**自己**的文件与命令工具。挂在 DSH 下的**外部 MCP 工具**（例如 IDA Pro 的 `patch` / `rename` / `set_comments`）是在**那个 MCP 服务器**里执行的，DSH 的权限档管不到。
- **对策**：只读场景要在**提示词里明确禁止**写类工具（例如"不要调用 patch/rename/set_comments/put_int/declare_type 等"），并在事后核对 `tools_used` 里没有写类工具。别只依赖 `permission`。

### 4.4 会话日志里会出现明文内容
- **现象**：DSH 的会话日志（`~/.dsh/sessions`）里可能记录到密钥、token 等。
- **原因**：那是 DSH 自己的对话持久化，是 resume 的依据，不受本服务控制。本服务**不**把对话内容写进自己的任何文件。
- **对策**：别让 agent 去读凭据文件；分享日志前先筛一遍。

---

## 五、交互体验的边界（别期待错）

| 你想要的 | 实际能做到的 |
|---|---|
| 逐字流式输出 | ❌ 进不了模型上下文（MCP 固有限制）。调用方拿到的是**分步**结果；人能通过 stderr 日志跟进 |
| 中途插话让模型即时改向 | ❌ ACP 拒绝并发 prompt。`dsh_interject` 是等价物：**取消 + 立刻开新回合**，历史保留（实测打断收敛 ~18ms） |
| 给 DSH 看截图 | ❌ ACP 自报 `promptCapabilities: {image: false}` |
| 给会话改个名字 | ❌ DSH 标题子系统没有对外改名接口，标题一律按首条消息自动生成 |
| 让 agent 主动问我问题 | ⚠️ `ask_user_question` 工具在 sdk/acp profile 里没挂载，它不会卡住等你 |

---

## 六、工作区与 GUI 可见性

### 6.1 "生效"和"显示"是两件事
- **生效**（会话真的在那个目录里干活）取决于会话的 `cwd` —— **永远正确**，已实测。
- **显示**（GUI 里的工作区分组）取决于 `~/.dsh/storages/workspace.json` 里的 `sessionIds`。

### 6.2 ★ 正在运行的 DSH 服务把注册表缓存在内存里
- **现象**：MCP 建的会话在 GUI 里都堆在"未分组"。
- **原因**：本服务会把工作区登记进文件，但**运行中的 DSH 服务不会重读**。
- **对策**：**重启 DSH**。⚠️ 重启前**别在 GUI 里操作工作区**，否则服务会用内存状态把文件覆盖回去。

### 6.3 临时目录默认不登记
- **原因**：跑测试会在 `%TEMP%` 下建一堆工作区，全登记会把你 GUI 灌满。
- **对策**：默认模式 `project` 会跳过临时目录。要连临时目录一起登记就设 `DSH_MCP_REGISTER_WORKSPACE=all`。

---

## 七、隐私与日志

### 7.1 默认完全静默
本服务默认**一个字节都不输出**。这不是洁癖：MCP 的 stdout 是协议通道（混东西进去会破坏报文），而 stderr 会进 Claude/Codex 的日志。

### 7.2 思考内容不落盘（有一个**刻意留下**的例外）
不写日志；状态文件只有元数据（id / cwd / 权限 / 计数）。只有 `dsh_read(include_reasoning=true)` 才会返回**当前正在跑那一轮**的实时思考，回合结束即丢弃。

**例外：异步完成哨兵。** 它必须把**正文**写进文件（否则调用方无法离线收活），但 `result.thinking` 会被**剥掉**并置 `thinking_omitted: true` —— 即使你请求了 `reasoning=full`，哨兵里也不会出现思考文本（有测试专门守着这一点），同一 run 在内存里仍能看到它。要刻意打破这条保证，设 `DSH_MCP_SENTINEL_INCLUDE_REASONING=1`。

### 7.3 `DSH_MCP_LOG_STDERR=1` 要谨慎
它会转发 DSH 子进程的原始 stderr，**其中可能包含思考内容**。只在本地排障时临时开。

---

## 八、故障速查

| 报错 | 含义 | 处理 |
|---|---|---|
| `no adapter registered for provider "xxx"` | profile 里没这个 provider | 检查 profile 补丁层的 `llm-pi-ai` |
| `no API key for provider route "deepseek-official"` | **经典坑**：没覆盖 `id: acp` 那一行 | 见 §1.2 |
| `a prompt is already in flight for this session` | 同一会话并发派活 | 用 `dsh_interject` 或 `dsh_interrupt` |
| `Invalid params: unknown session` | 拿旧 id 直接 prompt 而没先 resume | 本服务已自动处理；若出现说明流程被绕过 |
| `-32601 Method not found: session/setConfigOption` | ACP 方法是 snake_case | 正确名是 `session/set_config_option`（已修，勿回退成驼峰） |
| `工作区不存在或不是目录` | `dsh_start` 的 cwd 无效 | 先建目录，或用绝对路径 |
| `未知会话: xxx` | id 写错 / 属于别的 MCP 服务实例 | 用 `dsh_list` 取正确 id |
| `未知 run_id: xxx` | run 记录被挤出（>20 条）或服务重启过 | 用 `dsh_read` 读输出缓冲，或重新派活 |
| `DSH 进程未运行` | 进程被回收/崩了 | 直接再派活即可，会自动 resume |
| resume 失败 | 该会话在首次成功回合前进程就死了，可能从未落盘 | 该会话只能作为历史读；新建会话重来 |
| 你在 GUI 里打不开某会话 | 写锁被本服务持有 | 先 `dsh_release` |
| GUI 里新建工作区后本服务的登记消失 | 服务用内存状态覆盖了文件 | 重新 `--backfill`，并**先重启 DSH** 再动 GUI |
| 等哨兵的后台任务一直不返回 | 路径写错了（最常见是自己手改 Windows 路径） | 直接用工具返回里的 **`sentinel_file_posix`**，别手工转换；同时保留超时兜底 |
| 哨兵文件里没有 `thinking` 字段 | 这是**有意为之**（思考不落盘） | 看 `result.thinking_stats` 拿统计；要看内容用 `dsh_get(run_id)`（内存里还有） |

---

## 九、怎么问效果最好（给调用方 agent 的建议）

1. **给它目标，不要给命令**。DSH 是 agent：说"把这个模块的测试补上并跑通"，别说"执行 pytest"。它自己会选工具、分步骤、必要时派子代理。
2. **一个会话一件事**。别往一个会话里塞互不相关的任务，历史会互相污染且越来越贵。
3. **长任务拆成"派活 + 验收"**：`wait=false` → 干别的 → `dsh_get(run_id)`。
4. **要审查产出就用工作区变更**：返回值里的 `workspace_changed` / `diff_stat` 告诉你它动了哪些文件。
5. **要它先想清楚再动手**：让它先给方案、你确认后再执行（DSH 有计划模式）。
6. **省钱的三个旋钮**：`reasoning_effort` 调低、`reasoning` 保持 `hide`、及时 `dsh_release` 并开新会话。
7. **别在提示词里重复贴大段代码**——告诉它去看哪个文件更划算（DSH 自己有文件工具）。