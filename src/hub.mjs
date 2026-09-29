/**
 * 会话（Conversation）与注册表（Hub）。
 *
 * 核心设计：**一个会话 = 一个 DSH ACP 进程**。
 * 进程只是"缓存"，不是"身份"——对话的身份是 DSH 的 sessionId，落盘在 DSH 的会话目录里。
 * 因此进程死掉/被回收/整体重启后，用 session/resume 就能接着聊（ACP 实测支持跨进程恢复）。
 *
 * 日志与持久化红线：
 *   - 会话状态文件只存元数据（id/cwd/权限/别名/计数），**不存任何对话内容**。
 *   - 思考内容不写日志；**默认也不落盘**。
 *     - 唯一的落盘例外是"异步完成哨兵"：它需要带上结果正文（answer）才能让调用方离线收活，
 *       所以正文会写进 `<RUNS_DIR>/...`。但思考内容默认会被**剥掉**
 *       （需 DSH_MCP_SENTINEL_INCLUDE_REASONING=1 才一并写入，那会打破本保证）。
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  statSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  APPROVAL_POLICIES,
  DEFAULT_PERMISSION,
  DEFAULT_REASONING_EFFORT,
  IDLE_TTL_MS,
  PERMISSION_TIERS,
  PROMPT_TIMEOUT_MS,
  REAP_INTERVAL_MS,
  REASONING_EFFORTS,
  RUNS_DIR,
  SENTINEL_INCLUDE_REASONING,
  SENTINEL_TTL_MS,
  STATE_FILE,
  defaultApprovalPolicy,
} from './config.mjs';
import { AcpProcess } from './acp.mjs';
import { readConversationMeta } from './titles.mjs';
import { registerWorkspace } from './workspace.mjs';
import {
  classifyHolder,
  describeLeaseConflict,
  heartbeat as lockHeartbeat,
  isLeaseError,
  killHolderChild,
  removeMarker,
  writeMarker,
} from './locks.mjs';

const now = () => Date.now();
const NOOP_LOG = { info: () => {}, debug: () => {}, dshStderr: () => {} };

/** 运行期输出环形缓冲的条目上限（仅内存，超出丢最旧的）。 */
const MAX_OUT_ENTRIES = 500;
/** 记录用户发话时的截断长度（避免一条把缓冲撑爆）。 */
const MAX_PROMPT_ECHO = 4000;
/** 保留的回合记录条数（run 结果含正文，所以只留最近若干条，仅内存）。 */
const MAX_RUNS = 20;
/** 回合记录里 prompt 预览的长度。 */
const MAX_RUN_PREVIEW = 200;

/** 按 ACP 权限应答的规范形状挑选项。 */
function pickOption(options, want) {
  const list = Array.isArray(options) ? options : [];
  const match = list.find((o) => typeof o?.kind === 'string' && o.kind.startsWith(want));
  return match?.optionId;
}

/**
 * 把会话级配置套到 ACP 会话上。
 *
 * 两件必须知道的事：
 *   1) ACP 的 `reasoning_effort` 默认值是**空串**（Provider default），不是最大档，
 *      所以要显式设。传 'default' 即还原成空串（不设置）。
 *   2) **新进程不会记住**这些选择，因此 session/new 之后、以及每次 resume 之后都要重套一遍。
 *
 * 失败不致命：记进 applied/failed 供上层展示，避免因为某个模型不支持某一项而整个建会话失败。
 */
async function applySessionConfig(proc, sessionId, cfg) {
  const applied = [];
  const failed = [];
  const set = async (configId, value, label) => {
    if (value === undefined || value === null || value === '') return;
    try {
      // 注意方法名是 ACP 的 snake_case：session/set_config_option
      // （写成 session/setConfigOption 会得到 -32601 Method not found，且很容易被忽略）
      await proc.request('session/set_config_option', { sessionId, configId, value }, 30_000);
      applied.push(label);
    } catch (e) {
      failed.push(`${label} 设置失败: ${e.message}`);
    }
  };
  const effort = cfg.reasoningEffort === 'default' ? '' : cfg.reasoningEffort;
  await set('reasoning_effort', effort, `思考深度=${effort}`);
  if (cfg.provider && cfg.model) {
    await set('model', JSON.stringify([cfg.provider, cfg.model]), `模型=${cfg.provider}/${cfg.model}`);
  }
  return { applied, failed };
}

/**
 * 哨兵文件里的 result 是否要剥离思考内容。
 * 默认剥离以维持"思考不落盘"的保证，并留下 thinking_omitted 标记，
 * 免得调用方以为字段是意外丢失的。
 */
function sanitizeResultForSentinel(result) {
  if (!result || typeof result !== 'object') return result ?? null;
  if (SENTINEL_INCLUDE_REASONING) return result;
  const { thinking, ...rest } = result;
  return thinking ? { ...rest, thinking_omitted: true } : rest;
}

export class Conversation {
  constructor(state, hub) {
    this.id = state.id;
    this.cwd = state.cwd;
    this.permission = state.permission ?? DEFAULT_PERMISSION;
    this.onApproval = state.onApproval ?? defaultApprovalPolicy(this.permission);
    this.createdAt = state.createdAt ?? now();
    this.lastUsedAt = state.lastUsedAt ?? now();
    this.turnCount = state.turnCount ?? 0;
    /** 建会话时给的提示词（仅在 DSH 还没生成原生标题前当兜底显示）。 */
    this.titleHint = state.titleHint ?? null;
    /** 会话级 ACP 配置（思考深度 / 模型）。新进程不记得，resume 后要重套。 */
    this.cfg = {
      reasoningEffort: state.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      provider: state.provider ?? null,
      model: state.model ?? null,
    };
    this.lastConfigApplied = null;
    /** 工作区登记结果（决定你的 DSH GUI 里能不能看到这个会话）。 */
    this.workspace = state.workspace ?? null;
    this.#hub = hub;

    this.proc = null;
    this.busy = false;
    this.pendingApprovals = new Map();
    /** 等待"当前回合结束"的回调队列，供插话排队使用。 */
    this.idleWaiters = [];

    /**
     * 运行期输出环形缓冲（**仅内存、有界、不落盘**），供"查看正在跑的会话输出"用。
     * 只记三类：用户发的话、agent 的正文、工具调用状态；**思考内容一律不进这里**。
     */
    this.out = [];
    this.outSeq = 0;
    this.turnOutChars = 0;
    this.currentTurn = 0;
    this.turnStartedAt = 0;
    this.currentTool = null;

    /**
     * 回合记录（run）：让"先派活、回头再验收"成为一等公民。
     * 每条含 {run_id, status, 时间, prompt 预览, result}——**仅内存**，只留最近 MAX_RUNS 条。
     */
    this.runs = [];
    this.runSeq = 0;
    /** 最近一次回合结果，仅内存（进程退出即消失），不落盘。 */
    this.lastResult = null;
  }

  #hub;

  /** 序列化进注册表的最小状态——**只有元数据，没有对话内容**。 */
  toState() {
    return {
      id: this.id,
      cwd: this.cwd,
      permission: this.permission,
      onApproval: this.onApproval,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      turnCount: this.turnCount,
      titleHint: this.titleHint,
      reasoningEffort: this.cfg.reasoningEffort,
      provider: this.cfg.provider,
      model: this.cfg.model,
      workspace: this.workspace,
    };
  }

  /** 合规的公开快照（含磁盘上的元信息）。 */
  snapshot() {
    const meta = readConversationMeta(this.id);
    const nativeTitle = meta?.title ?? null;
    return {
      conversation_id: this.id,
      /** 对话名来自 DSH 的 session/title 事件（自动生成）；未生成时用建会话提示兜底。 */
      title: nativeTitle ?? this.titleHint ?? null,
      cwd: this.cwd,
      permission: this.permission,
      on_approval: this.onApproval,
      alive: !!this.proc?.alive,
      busy: this.busy,
      /** running = 正在跑回合；idle = 进程活着但空闲；detached = 进程未打开（可 resume）。 */
      state: this.state(),
      current_tool: this.currentTool,
      out_chars: this.turnOutChars,
      running_ms: this.busy && this.turnStartedAt ? now() - this.turnStartedAt : 0,
      turns: this.turnCount,
      created_at: new Date(this.createdAt).toISOString(),
      last_used_at: new Date(this.lastUsedAt).toISOString(),
      model: meta?.model ?? null,
      reasoning_effort: this.cfg.reasoningEffort,
      model_config: this.cfg.provider ? `${this.cfg.provider}/${this.cfg.model}` : null,
      config_applied: this.lastConfigApplied?.applied ?? null,
      config_failed: this.lastConfigApplied?.failed?.length ? this.lastConfigApplied.failed : null,
      workspace_registered: this.workspace?.registered ?? null,
      usage: meta?.usage?.totals ?? null,
      context_pressure: meta?.pressure ?? null,
      pending_approvals: [...this.pendingApprovals.keys()],
      /** 不在本进程手里时，写锁在谁手上（none=多半是你自己的 GUI / stale-mcp=可抢占的孤儿 / live-mcp=另一个实例）。 */
      lock_holder: this.proc?.alive ? 'self' : classifyHolder(this.id).kind,
    };
  }

  // ── 进程生命周期 ────────────────────────────────────────────────

  /** 确保有一个可用的 DSH 进程；必要时新建并 resume 回该会话。 */
  async ensureAlive() {
    if (this.proc?.alive) return this.proc;
    const proc = new AcpProcess({
      cwd: this.cwd,
      permission: this.permission,
      log: this.#hub.log,
      onNotification: (params) => this.onUpdate(params),
      onPermissionRequest: (params) => this.onPermissionRequest(params),
    });
    proc.start();
    this.proc = proc;
    // ★ 登记**推迟到真正拿到写锁之后**（见下面 resume 成功处）。
    //   登记的含义是"我正持有这个会话的写锁"，不是"我拉起了一个进程"。
    //   若在这里就写，一次注定撞锁失败的 resume 会先把"谁持有"的线索覆盖掉、
    //   失败路径再把它删掉 —— 抢占逻辑就只能看到 none，无法判定持有者（真实 bug）。
    try {
      await proc.initialize();
      // 能走到这里说明本会话刚新建了一个 DSH 进程（Hub.create 之后进程一直活着，不会进这个分支），
      // 而会话本体已经存在于磁盘上，所以必须 resume 把它接回来。
      await proc.request('session/resume', {
        sessionId: this.id,
        cwd: this.cwd,
        mcpServers: [],
      });
      // 新进程不记得会话级配置（思考深度/模型），resume 后必须重套
      this.lastConfigApplied = await applySessionConfig(proc, this.id, this.cfg);
      for (const f of this.lastConfigApplied.failed) this.#hub.log.info(`[conv ${this.id}] ${f}`);
      // 锁到手了，这时才登记；从此别人能查到"锁在我们手上"
      writeMarker(this.id, { childPid: proc.pid, cwd: this.cwd });
      this.#hub.log.info(`[conv ${this.id}] 已 resume`);
      return proc;
    } catch (e) {
      // ★ 半死的进程必须作废：它 alive 但**没有加载这个会话**，一旦留在 this.proc 上，
      //   下次调用会走上面 `this.proc?.alive` 的快路径，把 session/prompt 发给一个
      //   不认识该会话的进程 —— 会话就永久卡死了（重派也不会自愈）。
      this.proc = null;
      try {
        proc.stop();
      } catch {
        /* 已经死了就无所谓 */
      }
      // 只删**自己的**登记（removeMarker 会校验 token）；别人的登记必须留着当线索
      removeMarker(this.id);
      // 写锁冲突是最常见也最需要"说人话"的失败：DSH 的 SessionAlreadyOwnedError 会被
      // ACP 包成 -32603 "Internal error"，只说这句调用方根本不知道该怎么办。
      if (isLeaseError(e.message)) {
        const holder = classifyHolder(this.id);
        const err = new Error(describeLeaseConflict(this.id, holder));
        err.code = 'session-writer-held';
        err.holder = holder;
        throw err;
      }
      throw new Error(`恢复会话失败（已作废该进程，下次调用会重建）：${e.message}`);
    }
  }

  /**
   * 抢占写锁。
   *
   * 为什么需要"杀进程"：DSH 的写锁是跨进程内核信号量，**没有 API 能从活着的持有者手里夺走**。
   * 所以抢锁 == 杀掉持有者，然后重新 resume。既然要杀，就必须先确认那是谁：
   *
   *   - `stale-mcp`（本服务自己实例的孤儿残留）→ **自动杀**，安全；
   *   - `live-mcp`（另一个活着的 dsh-mcp 实例）→ 默认拒绝，`force=true` 才杀；
   *   - `none`（没有登记，多半是你自己的 DSH GUI）→ **绝不杀**（会连你的界面和正在看的对话一起杀掉），只报告。
   */
  async takeover({ force = false } = {}) {
    const report = { conversation_id: this.id, ok: false, holder_kind: null, killed_pid: null, message: '' };

    if (this.proc?.alive) {
      report.ok = true;
      report.message = '本进程已经持有该会话，无需抢占。';
      return report;
    }

    // 1) 先走正常路径：原持有者可能早已释放
    try {
      await this.ensureAlive();
      report.ok = true;
      report.message = '无需抢占：正常 resume 就成功了（锁是空的，原持有者已释放）。';
      return report;
    } catch (e) {
      if (e.code !== 'session-writer-held') {
        report.message = `不是写锁问题，抢占帮不上忙：${e.message}`;
        return report;
      }
    }

    // 2) 分类处置
    const holder = classifyHolder(this.id);
    report.holder_kind = holder.kind;
    report.holder = holder.marker;

    if (holder.kind === 'none' || !holder.childAlive) {
      report.message =
        `抢占未执行：${holder.reason}\n` +
        '本服务**不会**杀非本服务拉起的进程（那可能是你的 DSH GUI，杀它会连你正在看的对话一起没）。\n' +
        '请在那个窗口里关掉该会话（或切走），然后重试。';
      return report;
    }
    if (holder.kind === 'live-mcp' && !force) {
      report.message =
        `抢占被拒绝：${holder.reason}\n` +
        '如果确认那边已经不用它了，重试时带 force=true 强行夺过来。';
      return report;
    }

    // 3) 杀 + 重试（内核在持有者进程退出时释放信号量）
    const kill = killHolderChild(holder.marker.child_pid);
    report.killed_pid = holder.marker.child_pid;
    report.kill = kill;
    if (!kill.killed) {
      report.message = `抢占失败：${kill.reason}`;
      return report;
    }
    removeMarker(this.id, { force: true });
    await new Promise((r) => setTimeout(r, 500)); // 给内核一点时间回收锁
    try {
      await this.ensureAlive();
      report.ok = true;
      report.message =
        `已抢占：杀掉持有者 PID ${holder.marker.child_pid}（${holder.reason}），并成功接管会话。` +
        `\n⚠️ 如果那个进程当时正在跑回合，那一轮的工作会中断（会话日志会记为 interrupted）。`;
    } catch (e) {
      report.message = `杀掉 PID ${holder.marker.child_pid} 之后仍无法接管：${e.message}`;
    }
    return report;
  }

  // ── 流式更新收集 ────────────────────────────────────────────────

  onUpdate(params) {
    const c = this.collector;
    if (!c) return;
    const u = params?.update;
    if (!u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        c.answer += u.content?.text ?? '';
        this.pushOut('text', u.content?.text ?? '');
        break;
      case 'agent_thought_chunk':
        // 思考内容只进这条回合的临时收集器（用于统计/可选返回），**不进环形缓冲**
        c.reasoning += u.content?.text ?? '';
        c.reasoningChunks += 1;
        if (c.reasoningStartedAt === 0) c.reasoningStartedAt = now();
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const id = u.toolCallId ?? 'unknown';
        const prev = c.tools.get(id) ?? {};
        const merged = {
          ...prev,
          id,
          title: u.title ?? prev.title,
          status: u.status ?? prev.status,
          kind: u.kind ?? prev.kind,
          name: u.name ?? prev.name,
          input: u.rawInput !== undefined ? u.rawInput : prev.input,
        };
        c.tools.set(id, merged);
        const label = merged.name ?? merged.title ?? id;
        this.currentTool = merged.status === 'completed' || merged.status === 'failed' ? null : label;
        const tag = merged.status ? ` [${merged.status}]` : '';
        if (u.title !== undefined || u.status !== undefined || u.name !== undefined) {
          this.pushOut('tool', `${label}${tag}`, { tool_call_id: id });
        }
        break;
      }
      case 'usage_update':
        c.usage = u;
        break;
      case 'plan':
      case 'plan_update':
        c.plan = u;
        break;
      default:
        c.otherUpdates.push(u.sessionUpdate);
    }
  }

  async onPermissionRequest(params) {
    const options = params?.options ?? [];
    const toolCall = params?.toolCall ?? {};
    const desc = String(toolCall.title ?? toolCall.name ?? toolCall.toolCallId ?? '未知操作');
    const allowId = pickOption(options, 'allow');
    const rejectId = pickOption(options, 'reject');

    if (this.onApproval === 'auto-allow') {
      this.#hub.log.info(`[conv ${this.id}] 审批放行: ${desc}`);
      return allowId
        ? { outcome: { outcome: 'selected', optionId: allowId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    if (this.onApproval === 'auto-deny') {
      this.#hub.log.info(`[conv ${this.id}] 审批拒绝: ${desc}`);
      return rejectId
        ? { outcome: { outcome: 'selected', optionId: rejectId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    const approvalId = `ap-${Math.random().toString(36).slice(2, 10)}`;
    this.#hub.log.info(`[conv ${this.id}] 审批待裁决: ${approvalId}`);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(approvalId)) {
          this.#hub.log.info(`[conv ${this.id}] 审批 ${approvalId} 超时，按拒绝处理`);
          resolve({ outcome: { outcome: 'cancelled' } });
        }
      }, this.#hub.approvalTimeoutMs);
      this.pendingApprovals.set(approvalId, {
        params: { tool: desc, options },
        allowId,
        rejectId,
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      });
    });
  }

  /** 调用方裁决一个待决审批。 */
  decideApproval(approvalId, decision) {
    const p = this.pendingApprovals.get(approvalId);
    if (!p) throw new Error(`没有待决审批: ${approvalId}`);
    this.pendingApprovals.delete(approvalId);
    const chosen = decision === 'allow' ? p.allowId : p.rejectId;
    p.resolve(chosen ? { outcome: { outcome: 'selected', optionId: chosen } } : { outcome: { outcome: 'cancelled' } });
    return { approval_id: approvalId, decision };
  }

  // ── 跑任务 ──────────────────────────────────────────────────────

  /** 发一个回合并等到结束。 */
  /**
   * 派一个回合。
   *
   * **超时语义（这里曾经把会话跑挂，改之前务必读完）**
   *
   *   - **ACP 请求本身不设超时**：超时只决定"我们等不等"，永远不掐断回合。
   *     旧实现给 ACP 请求设超时，一到期就本地放弃并把 `busy` 置 false —— 那是在
   *     **谎报回合结束**：结果丢了、token 照烧，而且 reaper 看到 `busy=false` 就会
   *     把一个**正在干活**的进程回收掉 → 回合变 `interrupted` → 该会话此后 resume 失败、
   *     永久卡死（真实事故）。
   *   - `wait=false`：压根不等，立即返回 `run_id`；回合真正结束时写哨兵通知调用方。
   *   - `wait=true` ：最多等 `timeoutMs`（`<=0` 表示一直等）。到期**不报错、不丢结果**，
   *     返回 `{still_running:true, run_id, sentinel_file}` —— 即把 wait=true 降级成 wait=false：
   *     回合继续跑，结束时照常写哨兵，调用方拿 `run_id` 事后验收。
   *
   * @returns 等到回合结束 → 完整 result；没等到（wait=false 或等超时）→ 收据对象
   */
  async prompt(text, { reasoning = 'hide', timeoutMs = PROMPT_TIMEOUT_MS, run, wait = true } = {}) {
    if (this.busy) {
      throw new Error(
        `会话 ${this.id} 正在跑另一个回合。可以：dsh_interject 插话（打断并改口 / 排队），或 dsh_interrupt 打断。`,
      );
    }
    const runRecord = run ?? this.createRun(text);
    runRecord.status = 'running';
    runRecord.started_at = now();
    const before = gitStatus(this.cwd);
    let proc;
    try {
      proc = await this.ensureAlive();
    } catch (e) {
      // 起不来（撞写锁 / 会话损坏）就别留一条永远 "running" 的幽灵记录。
      // 调用方这次拿到的是 isError、并没有 run_id，所以这里不写哨兵。
      runRecord.status = 'error';
      runRecord.ended_at = now();
      runRecord.error = e.message;
      runRecord.result = {
        conversation_id: this.id,
        run_id: runRecord.run_id,
        stop_reason: 'error',
        error: e.message,
        answer: '',
        elapsed_ms: 0,
      };
      throw e;
    }
    this.busy = true;
    this.currentTurn += 1;
    this.turnStartedAt = now();
    this.turnOutChars = 0;
    this.currentTool = null;
    this.pushOut('user', text.length > MAX_PROMPT_ECHO ? `${text.slice(0, MAX_PROMPT_ECHO)}…（已截断）` : text);
    this.pushOut('turn', `第 ${this.currentTurn} 轮开始`, { phase: 'start' });
    const c = {
      answer: '',
      reasoning: '',
      reasoningChunks: 0,
      reasoningStartedAt: 0,
      tools: new Map(),
      usage: null,
      plan: null,
      otherUpdates: [],
    };
    this.collector = c;
    const t0 = now();
    let settled = false;

    /** 回合真正结束时收尾。无论有没有人在等，都**只执行一次**。 */
    const finalize = (stopReason, failure) => {
      if (settled) return runRecord.result;
      settled = true;
      // ★ 收尾本身也必须防弹：它跑在 ACP 的异步回调里，一旦抛出去就是 unhandled
      //   rejection —— Node ≥15 会直接杀掉进程，连带丢掉所有会话的活进程；
      //   而且调用方会永远等不到哨兵。所以出错也要落一个"收尾异常"的哨兵。
      try {
        this.busy = false;
        this.collector = null;
        this.currentTool = null;
        this.pushOut('turn', `第 ${this.currentTurn} 轮结束（${stopReason ?? 'unknown'}）`, {
          phase: 'end',
          stop_reason: stopReason,
          error: failure ?? undefined,
        });
        this.turnCount += 1;
        this.lastUsedAt = now();
        this.#hub.save();
        // 唤醒所有"等本轮结束"的插话请求（busy 已置 false，它们可以安全地发下一轮）
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
        const after = gitStatus(this.cwd);
        const result = {
          conversation_id: this.id,
          run_id: runRecord.run_id,
          stop_reason: stopReason,
          error: failure,
          answer: c.answer,
          thinking: formatReasoning(c, reasoning),
          thinking_stats: {
            hidden: reasoning === 'hide' || reasoning === 'marker',
            chars: c.reasoning.length,
            chunks: c.reasoningChunks,
            ms: c.reasoningStartedAt ? now() - c.reasoningStartedAt : 0,
          },
          tools_used: [...c.tools.values()],
          usage: c.usage,
          workspace_changed: before !== after,
          diff_stat: after,
          elapsed_ms: now() - t0,
        };
        runRecord.ended_at = now();
        runRecord.elapsed_ms = result.elapsed_ms;
        runRecord.status = failure ? 'error' : stopReason === 'cancelled' ? 'cancelled' : 'done';
        runRecord.result = result;
        // ★ 无条件写哨兵：**一个回合 = 一个哨兵文件**，没有例外。
        //   之前只在"调用方没在原地等"时才写，于是插话那一轮没有哨兵 —— 调用方的
        //   等待逻辑（等文件出现）就永远空等，即使 run 早已 status=done（真实事故）。
        //   统一规则也消除了整类"有 run_id 却没有哨兵"的坑。
        this.#hub.writeRunSentinel(this.id, runRecord);
        return result;
      } catch (e) {
        this.#hub.log.info(`[conv ${this.id}] 回合收尾异常（已兜底）: ${e.message}`);
        this.busy = false;
        this.collector = null;
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
        const fallback = {
          conversation_id: this.id,
          run_id: runRecord.run_id,
          stop_reason: 'error',
          error: `回合收尾异常: ${e.message}`,
          answer: c.answer ?? '',
          thinking_stats: { hidden: true, chars: 0, chunks: 0, ms: 0 },
          tools_used: [...(c.tools?.values?.() ?? [])],
          workspace_changed: false,
          elapsed_ms: now() - t0,
        };
        runRecord.ended_at = now();
        runRecord.status = 'error';
        runRecord.error = fallback.error;
        runRecord.result = fallback;
        this.#hub.writeRunSentinel(this.id, runRecord);
        return fallback;
      }
    };

    /** 没等到结果时给调用方的收据（它靠 run_id + 哨兵文件事后验收）。 */
    const receipt = (waitedMs) => ({
      conversation_id: this.id,
      run_id: runRecord.run_id,
      status: 'running',
      still_running: true,
      accepted: true,
      background: true,
      sentinel_file: this.#hub.runSentinelPath(this.id, runRecord.run_id),
      waited_ms: waitedMs ?? 0,
    });

    // 关键：第三个参数传 0 = **不设超时**。回合只能由它自己结束，或由 session/cancel 结束。
    const acp = proc.request('session/prompt', { sessionId: this.id, prompt: [{ type: 'text', text }] }, 0);
    acp.then(
      (res) => {
        if (res?.usage) c.usage = c.usage ?? res.usage;
        finalize(res?.stopReason ?? null, null);
      },
      (e) => finalize('error', e.message),
    );

    if (!wait) return settled ? runRecord.result : receipt(0);
    if (timeoutMs <= 0) {
      await acp.then(
        () => {},
        () => {},
      );
      return runRecord.result;
    }
    const timedOut = await Promise.race([
      acp.then(
        () => false,
        () => false,
      ),
      new Promise((r) => setTimeout(() => r(true), timeoutMs)),
    ]);
    if (timedOut && !settled) return receipt(timeoutMs);
    return runRecord.result;
  }

  /** 中断当前回合（ACP 原生，走的就是用户手动停止那条路径）。 */
  async interrupt() {
    if (!this.proc?.alive) return { interrupted: false, reason: 'DSH 进程未运行' };
    this.proc.notify('session/cancel', { sessionId: this.id });
    if (!this.busy) {
      return { interrupted: false, reason: '当前没有进行中的回合（已发送 cancel，用于清空排队输入）' };
    }
    return { interrupted: true };
  }

  /** 运行状态：running（在跑回合）/ idle（进程活着但空闲）/ detached（进程未打开，可 resume）。 */
  state() {
    if (this.busy) return 'running';
    return this.proc?.alive ? 'idle' : 'detached';
  }

  /** 追加一条输出记录；同类相邻文本会合并，避免每个 token 一条。 */
  pushOut(kind, text, extra = {}) {
    const last = this.out[this.out.length - 1];
    if (last && last.kind === kind && last.turn === this.currentTurn && text) {
      last.text += text;
      last.at = now();
    } else {
      this.out.push({ seq: ++this.outSeq, kind, turn: this.currentTurn, text: text ?? '', at: now(), ...extra });
      if (this.out.length > MAX_OUT_ENTRIES) this.out.shift();
    }
    if (kind === 'text') this.turnOutChars += text?.length ?? 0;
  }

  /** 读输出：游标式增量。返回 seq > cursor 的条目 + 新游标。 */
  readOut({ cursor = 0, includeReasoning = false, limit = 200 } = {}) {
    const entries = this.out.filter((e) => e.seq > cursor).slice(0, limit);
    const next = entries.length ? entries[entries.length - 1].seq : cursor;
    const res = {
      conversation_id: this.id,
      state: this.state(),
      busy: this.busy,
      current_tool: this.currentTool,
      entries,
      cursor: next,
      has_more: this.out.some((e) => e.seq > next),
      /** 缓冲被环形覆盖时会为 true，表示你错过了中间一段。 */
      gap: entries.length > 0 && this.out.length > 0 && this.out[0].seq > cursor + 1,
    };
    // 思考内容只在显式要求时、且只针对"当前正在跑的回合"返回；不保留、不进缓冲
    if (includeReasoning && this.collector?.reasoning) {
      res.live_thinking = this.collector.reasoning;
    }
    return res;
  }

  /** 建一条回合记录。派活时先建，好让调用方立刻拿到 run_id（异步模式的关键）。 */
  createRun(text) {
    const run = {
      run_id: `run-${Date.now().toString(36)}-${++this.runSeq}`,
      conversation_id: this.id,
      prompt_preview: text.length > MAX_RUN_PREVIEW ? `${text.slice(0, MAX_RUN_PREVIEW)}…` : text,
      status: 'queued',
      started_at: null,
      ended_at: null,
      elapsed_ms: null,
      result: null,
    };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs.shift();
    // 防御性清残留：正常情况下该 run_id 从未用过，但确保等待方不会被历史哨兵误触发。
    this.#hub.clearRunSentinel(this.id, run.run_id);
    return run;
  }

  /** 取回合记录；不传 run_id 就是最近一条。 */
  getRun(runId) {
    if (runId) {
      const r = this.runs.find((x) => x.run_id === runId);
      if (!r) {
        throw new Error(`未知 run_id: ${runId}（回合记录只在内存、只留最近 ${MAX_RUNS} 条；也可用 dsh_read 读输出缓冲）`);
      }
      return r;
    }
    return this.runs.length ? this.runs[this.runs.length - 1] : null;
  }

  /** 等到当前回合结束（不忙则立即返回 true；超时返回 false）。 */
  async waitIdle(timeoutMs = 30 * 60 * 1000) {
    if (!this.busy) return true;
    return await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = this.idleWaiters.indexOf(done);
        if (i >= 0) this.idleWaiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      this.idleWaiters.push(done);
    });
  }

  /**
   * 插话。
   *
   * ACP 明确拒绝并发 prompt（`a prompt is already in flight for this session`），
   * 所以做不到"把消息塞进正在跑的回合里让模型即时改向"——DSH 的 agent 本身有 steering
   * 队列，但被 ACP 桥接层挡住了。这里提供的是它的实用等价物：
   *
   *   interject —— 打断当前回合，随即把新消息作为新回合发出（"停一下，听我说"）
   *   queue     —— 不打断，等当前回合自然结束后紧接着发出（"你先把这轮干完，然后…"）
   *
   * 之所以无竞态：dsh-acp 在让 prompt 请求返回**之前**就清空了 inflight 槽位，
   * 且只在 agent 完全 idle 后才 settle（lib/index.js:1003-1011）。
   */
  async interject(message, { mode = 'interject', reasoning = 'hide', timeoutMs = PROMPT_TIMEOUT_MS } = {}) {
    if (!this.busy) {
      const r = await this.prompt(message, { reasoning, timeoutMs });
      return { ...r, interjected: 'idle', waited_ms: 0 };
    }
    const t0 = now();
    if (mode === 'interject') {
      this.proc?.notify('session/cancel', { sessionId: this.id });
    }
    const idle = await this.waitIdle();
    const waited = now() - t0;
    if (!idle) throw new Error('等待当前回合结束超时，插话未发送');
    const r = await this.prompt(message, { reasoning, timeoutMs });
    return { ...r, interjected: mode, waited_ms: waited };
  }

  /** 关闭会话（进程收尾；会话本体留在磁盘上，可再次 resume）。 */
  async close({ forget = false } = {}) {
    const proc = this.proc;
    this.proc = null;
    if (proc?.alive) {
      try {
        await proc.request('session/close', { sessionId: this.id }, 10_000);
      } catch {}
      await proc.stop();
    }
    // 进程没了 → 写锁也释放了，登记必须跟着删（否则会把"孤儿持有者"误报给抢占逻辑）
    removeMarker(this.id);
    if (forget) this.#hub.remove(this.id);
    else this.#hub.save();
    return { closed: true, forgotten: forget };
  }
}

/** 收集当前工作区的 git 变更摘要（非 git 目录返回 null）。 */
export function gitStatus(cwd) {
  try {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 8000 });
    if (r.status !== 0 || !r.stdout) return null;
    const lines = r.stdout.split('\n').filter(Boolean);
    if (!lines.length) return null;
    return { changed_files: lines.length, entries: lines.slice(0, 40) };
  } catch {
    return null;
  }
}

/** 按档位渲染思考内容。 */
export function formatReasoning(c, mode) {
  if (mode === 'full') return c.reasoning;
  if (mode === 'summary') {
    const t = c.reasoning.trim();
    if (!t) return '';
    if (t.length <= 400) return t;
    return `${t.slice(0, 240)}\n…\n${t.slice(-120)}`;
  }
  if (mode === 'marker') {
    return c.reasoning ? `[思考已隐藏：${c.reasoning.length} 字]` : '';
  }
  return ''; // hide
}

// ── 注册表 ────────────────────────────────────────────────────────

export class Hub {
  constructor({ log } = {}) {
    this.conversations = new Map();
    this.log = log ?? NOOP_LOG;
    this.approvalTimeoutMs = Number(process.env.DSH_MCP_APPROVAL_TIMEOUT_MS ?? 5 * 60 * 1000);
    this.#reaper = null;
  }

  #reaper;

  load() {
    if (!existsSync(STATE_FILE)) return;
    try {
      const doc = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      for (const s of doc.conversations ?? []) {
        if (!s?.id || !s?.cwd) continue;
        this.conversations.set(s.id, new Conversation(s, this));
      }
      this.log.info(`[hub] 载入 ${this.conversations.size} 个会话`);
    } catch (e) {
      this.log.info(`[hub] 状态文件读取失败: ${e.message}`);
    }
  }

  save() {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      const doc = {
        version: 1,
        savedAt: new Date().toISOString(),
        conversations: [...this.conversations.values()].map((c) => c.toState()),
      };
      const tmp = `${STATE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      renameSync(tmp, STATE_FILE);
    } catch (e) {
      this.log.info(`[hub] 状态保存失败: ${e.message}`);
    }
  }

  // ── 异步完成哨兵 ────────────────────────────────────────────────
  //
  // 一个 run 终止（done/error/cancelled）时写一个独立小文件，让调用方能用
  // 文件系统等待完成（Bash run_in_background + `until [ -f ]`），无需轮询 MCP 工具。
  //
  // 并发正确性要点：
  //   - 路径按 conversation_id 分目录 → 不同会话即使同毫秒生成同名 run_id 也不串台；
  //     同一会话内 dsh_send 忙时直接拒绝、run 序号单调递增，故会话内 run_id 唯一。
  //   - tmp + rename 原子落地 → 文件一旦存在，内容必然完整（等待方不会读到半截）；
  //     每个 run 用自己带 pid/随机后缀的 tmp，绝不共用同一个 tmp（避免并发写互相覆盖）。
  //   - 闩锁语义 → 文件写一次并保留：即便 run 在等待方启动前就已完成，`[ -f ]` 立刻为真。
  //   - 文件内含最终 result → 收活可直接读文件，不依赖内存里的 run 记录
  //     （内存只留最近 MAX_RUNS 条，并发多 run 时旧记录会被挤掉；文件不受此限，还扛服务重启）。

  /** 某个 run 的完成哨兵文件路径。 */
  runSentinelPath(conversationId, runId) {
    return join(RUNS_DIR, conversationId, `${runId}.json`);
  }

  /** 写完成哨兵（原子）。失败只记日志，绝不影响主流程。 */
  writeRunSentinel(conversationId, run) {
    try {
      const file = this.runSentinelPath(conversationId, run.run_id);
      mkdirSync(dirname(file), { recursive: true });
      const payload = {
        conversation_id: conversationId,
        run_id: run.run_id,
        status: run.status ?? 'unknown',
        ended_at: run.ended_at ?? Date.now(),
        error: run.error ?? run.result?.error ?? null,
        result: sanitizeResultForSentinel(run.result ?? null),
      };
      const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      this.log.info(`[hub] 写完成哨兵失败: ${e.message}`);
    }
  }

  /**
   * 启动时清理过期哨兵（默认 7 天前）与崩溃残留的 .tmp 文件。
   *
   * 哨兵内含完整正文，不清理会无声堆积。设为 DSH_MCP_SENTINEL_TTL_MS=0 可关闭。
   * 只在服务启动时做一次，因此绝不会删掉"当前正在等待的"哨兵（那时它还不需要存在）。
   */
  pruneSentinels({ ttlMs = SENTINEL_TTL_MS } = {}) {
    if (!ttlMs || !existsSync(RUNS_DIR)) return { pruned: 0, dirs_removed: 0 };
    let pruned = 0;
    let dirsRemoved = 0;
    const cutoff = Date.now() - ttlMs;
    try {
      for (const entry of readdirSync(RUNS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(RUNS_DIR, entry.name);
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (!f.isFile()) continue;
          const fp = join(dir, f.name);
          try {
            if (statSync(fp).mtimeMs < cutoff) {
              rmSync(fp, { force: true });
              pruned++;
            }
          } catch {
            /* 单个文件失败就跳过 */
          }
        }
        try {
          if (readdirSync(dir).length === 0) {
            rmSync(dir, { recursive: true, force: true });
            dirsRemoved++;
          }
        } catch {
          /* 目录清理失败无所谓 */
        }
      }
    } catch (e) {
      this.log.info(`[hub] 清理哨兵失败: ${e.message}`);
    }
    return { pruned, dirs_removed: dirsRemoved };
  }

  /** 删除某个 run 的哨兵（起跑前防御性清残留；调用方消费后也可自行删）。 */
  clearRunSentinel(conversationId, runId) {
    try {
      rmSync(this.runSentinelPath(conversationId, runId), { force: true });
    } catch {
      /* 忽略：清理失败不影响任何主流程 */
    }
  }

  get(id) {
    let c = this.conversations.get(id);
    if (!c) {
      // 多实例常见情形：这个会话是**另一个 dsh-mcp 实例**刚建的，我们内存里的注册表还没有。
      // 先吸收一次磁盘状态再判定 —— 否则会把"别人的会话"误报成"未知会话"，用户一头雾水。
      this.adoptNewFromDisk();
      c = this.conversations.get(id);
    }
    if (!c) throw new Error(`未知会话: ${id}（用 dsh_list 查看可用会话）`);
    return c;
  }

  /**
   * 只吸收磁盘上"本进程还没有的"会话（多实例场景）。
   * **绝不覆盖**内存里已有的会话 —— 那会把活进程引用与回合状态一起丢掉。
   * @returns {number} 新吸收的数量
   */
  adoptNewFromDisk() {
    if (!existsSync(STATE_FILE)) return 0;
    let added = 0;
    try {
      const doc = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      for (const s of doc.conversations ?? []) {
        if (!s?.id || !s?.cwd) continue;
        if (this.conversations.has(s.id)) continue;
        this.conversations.set(s.id, new Conversation(s, this));
        added++;
      }
      if (added) this.log.info(`[hub] 从磁盘吸收了 ${added} 个别的实例新建的会话`);
    } catch (e) {
      this.log.info(`[hub] 吸收磁盘会话失败: ${e.message}`);
    }
    return added;
  }

  remove(id) {
    this.conversations.delete(id);
    this.save();
  }

  /** 新建一个会话：拉起进程 + ACP 初始化 + session/new。 */
  async create({ cwd, permission = DEFAULT_PERMISSION, onApproval, titleHint, reasoningEffort, provider, model } = {}) {
    if (!cwd) throw new Error('必须提供 cwd（工作区绝对路径）');
    if (!isAbsolute(cwd)) throw new Error(`cwd 必须是绝对路径: ${cwd}`);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`工作区不存在或不是目录: ${cwd}（请先创建它）`);
    }
    if (!PERMISSION_TIERS.includes(permission)) {
      throw new Error(`permission 必须是 ${PERMISSION_TIERS.join(' | ')} 之一`);
    }
    const policy = onApproval ?? defaultApprovalPolicy(permission);
    if (!APPROVAL_POLICIES.includes(policy)) {
      throw new Error(`on_approval 必须是 ${APPROVAL_POLICIES.join(' | ')} 之一`);
    }
    const effort = reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    if (!REASONING_EFFORTS.includes(effort)) {
      throw new Error(`reasoning_effort 必须是 ${REASONING_EFFORTS.join(' | ')} 之一`);
    }
    if (model && !provider) {
      throw new Error('指定 model 时必须同时给 provider（ACP 的模型标识是 [provider, model] 二元组）');
    }
    const proc = new AcpProcess({
      cwd,
      permission,
      log: this.log,
      onNotification: () => {},
      onPermissionRequest: () => ({ outcome: { outcome: 'cancelled' } }),
    });
    proc.start();
    try {
      await proc.initialize();
      const res = await proc.request('session/new', { cwd, mcpServers: [] });
      const conv = new Conversation(
        {
          id: res.sessionId,
          cwd,
          permission,
          onApproval: policy,
          titleHint,
          reasoningEffort: effort,
          provider: provider ?? null,
          model: model ?? null,
        },
        this,
      );
      conv.proc = proc;
      // ★ 新建会话的进程也要登记持有者 —— 走的是 Hub.create 这条独立路径，
      //   不登记的话 dsh_takeover 会把"本服务自己持有的会话"误判成 none 而拒绝抢占。
      writeMarker(res.sessionId, { childPid: proc.pid, cwd });
      proc.attachRoutes({
        onNotification: (params) => conv.onUpdate(params),
        onPermissionRequest: (params) => conv.onPermissionRequest(params),
      });
      // 套用会话级配置（思考深度默认 max；ACP 自己的默认是 Provider default）
      conv.lastConfigApplied = await applySessionConfig(proc, res.sessionId, conv.cfg);
      // 登记工作区，否则这些会话在你的 DSH GUI 里看不到。
      // ★ 必须容错：registerWorkspace 会写 workspace.json（磁盘满/被占时会抛），
      //   而它在 this.conversations.set 之前 —— 抛出去就会**丢掉这个会话并泄漏进程**。
      try {
        conv.workspace = registerWorkspace(cwd, res.sessionId);
      } catch (e) {
        conv.workspace = { registered: false, error: e.message };
        this.log.info(`[hub] 工作区登记失败（不影响会话可用）: ${e.message}`);
      }
      this.conversations.set(conv.id, conv);
      this.save();
      this.log.info(
        `[hub] 新建会话 ${conv.id}（cwd=${cwd}, 权限=${permission}, 思考深度=${effort}` +
          `${conv.workspace?.registered ? ', 工作区已登记' : `, 工作区登记失败: ${conv.workspace?.error}`}）`,
      );
      return conv;
    } catch (e) {
      await proc.stop().catch(() => {});
      throw e;
    }
  }

  /** 列出所有会话：本进程持有的 + DSH 磁盘上未打开的。 */
  async list({ cwd, includeClosed = true } = {}) {
    const out = new Map();
    for (const c of this.conversations.values()) {
      if (cwd && c.cwd !== cwd) continue;
      out.set(c.id, c.snapshot());
    }
    if (!includeClosed) return [...out.values()];

    const probeCwd = cwd ?? [...this.conversations.values()][0]?.cwd ?? process.cwd();
    let proc = null;
    try {
      proc = new AcpProcess({ cwd: probeCwd, permission: 'read-only' });
      proc.start();
      await proc.initialize();
      const res = await proc.request('session/list', cwd ? { cwd } : {});
      for (const s of res?.sessions ?? []) {
        if (out.has(s.sessionId)) continue;
        const meta = readConversationMeta(s.sessionId);
        out.set(s.sessionId, {
          conversation_id: s.sessionId,
          title: meta?.title ?? null,
          cwd: s.cwd,
          permission: null,
          alive: false,
          busy: false,
          /** 磁盘上有、但本服务当前没打开 → detached（可用 resume 复活）。 */
          state: 'detached',
          current_tool: null,
          out_chars: 0,
          running_ms: 0,
          turns: meta?.turns ?? null,
          usage: meta?.usage?.totals ?? null,
          context_pressure: meta?.pressure ?? null,
          model: meta?.model ?? null,
        });
      }
    } catch (e) {
      this.log.info(`[hub] session/list 探测失败: ${e.message}`);
    } finally {
      await proc?.stop().catch(() => {});
    }
    return [...out.values()];
  }

  /** 空闲回收：停掉闲置进程，会话本身保留（可 resume 复活）。 */
  startReaper() {
    if (this.#reaper) return;
    this.#reaper = setInterval(async () => {
      // ★ 整个回收周期必须自带防护：这里抛出的异常会变成 unhandled rejection，
      //   在 Node ≥15 上直接**杀掉进程** —— 而那会连带丢掉所有会话的活进程。
      try {
        const cutoff = now() - IDLE_TTL_MS;
        for (const c of this.conversations.values()) {
          if (c.busy || !c.proc?.alive) continue;
          // 还握着写锁的会话要续心跳：否则别的实例会把"活着但一时空闲"的我们
          // 误判成卡死，进而去抢占我们持有的会话。
          lockHeartbeat(c.id);
          if (c.lastUsedAt > cutoff) continue;
          this.log.info(`[hub] 空闲回收会话 ${c.id} 的进程（可 resume 复活）`);
          const proc = c.proc;
          c.proc = null;
          removeMarker(c.id);
          await proc.stop().catch(() => {});
        }
      } catch (e) {
        this.log.info(`[hub] 回收周期异常（已忽略，下个周期继续）: ${e.message}`);
      }
    }, REAP_INTERVAL_MS);
    this.#reaper.unref?.();
  }

  async shutdown() {
    if (this.#reaper) clearInterval(this.#reaper);
    this.#reaper = null;
    for (const c of this.conversations.values()) {
      const proc = c.proc;
      c.proc = null;
      await proc?.stop().catch(() => {});
      // 子进程停了，锁就释放了；登记也要删，否则下个实例会把我们看成"孤儿持有者"
      removeMarker(c.id);
    }
    this.save();
  }
}