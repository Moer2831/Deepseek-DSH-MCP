/**
 * 工具定义与实现。
 *
 * 抽象单位是"会话 + 任务"，不是"命令"——不把 DSH 自己的文件/命令工具 1:1 代理出去，
 * 因为调用方 agent 已经有那些工具了。
 */

import {
  APPROVAL_POLICIES,
  DEFAULT_PERMISSION,
  DEFAULT_REASONING,
  DEFAULT_REASONING_EFFORT,
  PERMISSION_TIERS,
  REASONING_EFFORTS,
  REASONING_MODES,
  toPosixPath,
} from './config.mjs';
import { listOrphans } from './locks.mjs';

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const CONV_ID = {
  type: 'string',
  description: '会话 id，来自 dsh_start 或 dsh_list。',
};

/** 工具清单（JSON Schema）。 */
export const TOOL_DEFS = [
  {
    name: 'dsh_start',
    description:
      '新建一个 DSH 会话（一个可长期共事的编码 agent）。会话活在磁盘上，进程只是缓存；' +
      '进程被回收或崩溃后会自动用 ACP session/resume 复活，对话不丢。' +
      '返回 conversation_id 与对话标题。建好后用 dsh_send 派活。',
    inputSchema: S(
      {
        cwd: { type: 'string', description: '工作区绝对路径。决定 agent 的工作目录、AGENTS.md/技能的发现范围、以及沙箱可写根。' },
        permission: {
          type: 'string',
          enum: PERMISSION_TIERS,
          description:
            `权限档。默认 ${DEFAULT_PERMISSION}。read-only 适合分析不信任样本（如恶意软件）；workspace-write 越界操作会冒泡为待决审批。` +
            '**档位在创建时定下**：DSH 设计上"resume 的会话保留它自己记录的权限"，所以事后改这个参数不会改变已有会话，要换档需新建。' +
            '（本档位是**真实生效**的 —— 由启动时传入的 env 决定，并有 test/permission.mjs 对着会话自己的记录逐档核验。）',
        },
        on_approval: {
          type: 'string',
          enum: APPROVAL_POLICIES,
          description: '审批处理策略。默认按权限档推导：read-only → auto-deny，其余 → auto-allow。ask 会把审批挂起，需用 dsh_approval_decide 裁决。',
        },
        title_hint: { type: 'string', description: '可选的标题提示（DSH 的标题由首条消息自动生成，这里只是兜底显示）。' },
        reasoning_effort: {
          type: 'string',
          enum: REASONING_EFFORTS,
          description: `思考深度，默认 ${DEFAULT_REASONING_EFFORT}。注意 ACP 自身的默认是"Provider default"（不设），本服务会显式设成 max。想省钱可调低。`,
        },
        provider: { type: 'string', description: '模型提供方名（如 deepseek-official）。留空用 profile 默认。' },
        model: { type: 'string', description: '模型名（如 deepseek-flash）。指定时必须同时给 provider。' },
      },
      ['cwd'],
    ),
  },
  {
    name: 'dsh_send',
    description:
      '向会话派一个任务。**默认不阻塞（wait=false）**：立即返回 run_id + sentinel_file，' +
      '回合在后台跑，跑完自动通知你 —— 你继续做别的事，也永远不用担心任务被"超时"打断。' +
      '想原地等结果就显式传 wait=true（可配 timeout_ms；到期只会转后台，不会取消回合）。' +
      '【超时不会毁掉任务】wait=true 到达 timeout_ms 仍没跑完时，本工具**不会报错、也不会取消回合**，' +
      '而是自动降级为后台：返回 run_id + sentinel_file，回合继续跑完，结果稍后由哨兵文件通知。' +
      '（timeout_ms=0 表示一直等。）所以任何时候你都能拿到结果，不用怕"超时了白干"。' +
      '等待模式与后台模式都在回合结束时原子落地一个含最终结果的小文件——' +
      '**推荐用后台任务（Bash run_in_background + `until [ -f sentinel_file ]`）等它，跑完自动通知你，无需轮询**；' +
      '文件出现后读它即得结果，或用 dsh_get(conversation_id, run_id) 验收，dsh_read 可中途看输出。' +
      '默认隐藏思考内容（只返回正文 + 思考统计）。' +
      '若会话正在忙，本工具会报错——改用 dsh_interject 插话，或用 dsh_interrupt 先打断。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        prompt: { type: 'string', description: '任务描述。可以引用工作区里的文件路径。' },
        wait: {
          type: 'boolean',
          description:
            '**默认 false**：立即返回 run_id + sentinel_file，回合在后台跑，跑完由哨兵文件通知（推荐用法）。true = 原地阻塞到回合结束再返回完整结果。',
        },
        reasoning: {
          type: 'string',
          enum: REASONING_MODES,
          description: `思考内容展示档位。默认 ${DEFAULT_REASONING}（只返回正文，思考只给统计）。full 会占用大量上下文。`,
        },
        timeout_ms: {
          type: 'number',
          description:
            '仅 wait=true 时的**等待**上限（毫秒），默认 30 分钟；0 = 一直等。到期不会取消回合，只会转成后台并给你 run_id。',
        },
      },
      ['conversation_id', 'prompt'],
    ),
  },
  {
    name: 'dsh_list',
    description:
      '列出会话及其运行状态，用来掌控多个会话实例。' +
      'state: running（正在跑回合）/ idle（进程活着但空闲）/ detached（进程没开，可 resume 复活）。' +
      'running 的会话会带上已跑时长、当前正在执行的工具、本轮已产出字数。' +
      '数据来自两路合并：本服务持有的 + DSH 磁盘上尚未打开的（DSH 的 session/list 会排除已打开的会话）。' +
      '想只看正在跑的，传 only_running=true；想看某个会话当前吐出的内容，接着用 dsh_read。',
    inputSchema: S({
      cwd: { type: 'string', description: '只看某个工作区下的会话。' },
      include_closed: {
        type: 'boolean',
        description:
          '是否包含磁盘上未打开的会话（含别的实例 / GUI 建的），默认 true。**代价：要 spawn 一个 DSH 进程去探测磁盘，实测约 1 秒**（结果缓存 10 秒）。只列本服务已打开的会话就传 false，毫秒级。',
      },
      only_running: {
        type: 'boolean',
        description: '只返回正在跑回合的会话，默认 false。**此模式自动跳过磁盘探测，毫秒级**（正在跑的会话必然在内存里）。',
      },
    }),
  },
  {
    name: 'dsh_read',
    description:
      '读会话的运行期输出（**游标式增量**）——用它可以看到"正在跑的会话"当前吐出了什么，' +
      '不必等回合结束。典型用法：dsh_list(only_running) 找到在跑的会话 → 反复 dsh_read 并回传上次的 cursor，' +
      '就能像切换窗口一样轮流观察多个会话。' +
      '输出缓冲**只在内存里且有界**（环形，满则丢最旧），服务/进程退出即消失；' +
      '**思考内容不进缓冲**——只有 include_reasoning=true 时才会附带"当前正在跑那一轮"的实时思考。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        cursor: { type: 'number', description: '上次返回的 cursor；首次不传或传 0。' },
        include_reasoning: { type: 'boolean', description: '附带当前回合的实时思考内容，默认 false。' },
        limit: { type: 'number', description: '单次最多返回多少条，默认 200。' },
      },
      ['conversation_id'],
    ),
  },
  {
    name: 'dsh_get',
    description:
      '查看单个会话的详情；带 run_id 时**取那一次派活的最终结果**（异步模式的验收入口）。' +
      '不传 run_id 则取最近一次回合。返回：标题、工作区、权限档、状态、轮数、token 用量、' +
      '上下文压力、待决审批，以及该回合的完整结果（正文/工具/用量/错误）。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        run_id: { type: 'string', description: 'dsh_send 返回的 run_id；不传则取最近一次回合。' },
      },
      ['conversation_id'],
    ),
  },
  {
    name: 'dsh_interject',
    description:
      '插话：会话正在跑某个回合时往里补一句话。两种模式——' +
      'interject（默认）打断当前回合并立刻改口；queue 不打断，等本轮自然结束后紧接着说。' +
      '会话空闲时等同于一次普通 dsh_send。' +
      '说明：ACP 明确拒绝并发 prompt，所以做不到"让模型在同一个回合里即时改向"；' +
      'interject 是它的实用等价物（取消 + 立刻开新回合，历史完整保留）。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        message: { type: 'string', description: '要插进去说的话。' },
        mode: {
          type: 'string',
          enum: ['interject', 'queue'],
          description: 'interject（默认）= 打断并改口；queue = 等本轮跑完接着说。',
        },
        reasoning: {
          type: 'string',
          enum: REASONING_MODES,
          description: `思考内容展示档位，默认 ${DEFAULT_REASONING}。`,
        },
        timeout_ms: { type: 'number', description: '新回合的**等待**上限（毫秒），默认 30 分钟；0 = 一直等。到期转后台，不取消回合。' },
      },
      ['conversation_id', 'message'],
    ),
  },
  {
    name: 'dsh_interrupt',
    description:
      '中断会话当前正在进行的回合（ACP 原生 session/cancel，走的就是用户手动按停止那条路径）。' +
      '会话本身保持完好，可以立刻继续派新任务。',
    inputSchema: S({ conversation_id: CONV_ID }, ['conversation_id']),
  },
  {
    name: 'dsh_takeover',
    description:
      '**抢占会话的写锁**（DSH 的写锁是跨进程内核信号量，持有者活着就不过期，没有 API 能直接夺走——' +
      '唯一手段是杀掉持有者进程，所以本工具会先判定持有者是谁）：' +
      '① 若锁其实空着，正常 resume 即可，不会杀任何东西；' +
      '② 若持有者是**本服务自己留下的孤儿进程**（MCP 崩了/重启了，子进程还活着握着锁）→ **自动杀掉并接管**，安全；' +
      '③ 若持有者是**另一个活着的 dsh-mcp 实例** → 默认拒绝，传 force=true 才夺；' +
      '④ 若持有者无法识别（**多半是你自己的 DSH GUI 正开着这个会话**）→ **绝不杀**（那会连你的界面和正在看的对话一起杀掉），' +
      '只报告，请你在那个窗口里关掉该会话后重试。' +
      '注意：杀掉正在跑回合的持有者会中断那一轮（会话日志记为 interrupted），会话本体不受损。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        force: {
          type: 'boolean',
          description: '仅用于"另一个活着的 dsh-mcp 实例持有"这一种情况；对 GUI/未知持有者无效（永远不杀）。',
        },
      },
      ['conversation_id'],
    ),
  },
  {
    name: 'dsh_release',
    description:
      '释放会话占用的 DSH 进程（释放写锁，让用户能在自己的 DSH GUI 里打开同一个会话）。' +
      '会话本体留在磁盘上，之后仍可 resume；forget=true 才会从注册表里摘掉。' +
      '★ 用完了想一次性腾内存就传 all=true（默认"永不回收"下每个会话约 120MB，全放掉即立刻归零，之后随时 resume）。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        forget: { type: 'boolean', description: '同时从本服务的注册表里移除，默认 false。' },
        all: {
          type: 'boolean',
          description: '忽略 conversation_id，释放**所有**活着的会话进程（腾内存用）。默认 false。',
        },
      },
      [],
    ),
  },
  {
    name: 'dsh_approval_decide',
    description:
      '裁决一个待决审批（仅当会话的 on_approval=ask 时会出现）。用于把 DSH 的越权/提权请求交给调用方决定，' +
      '既不一律放行也不一律拒绝。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        approval_id: { type: 'string', description: '来自 dsh_get 的 pending_approvals。' },
        decision: { type: 'string', enum: ['allow', 'deny'], description: '放行或拒绝。' },
      },
      ['conversation_id', 'approval_id', 'decision'],
    ),
  },
  {
    name: 'dsh_status',
    description: '轻量状态查询：会话是否活着、是否在忙、待决审批数、最近一次回合的结果。',
    inputSchema: S({ conversation_id: CONV_ID }, ['conversation_id']),
  },
];

/** 把结构化结果渲染成给模型看的文本。 */
function renderSendResult(r) {
  const lines = [];
  if (r.answer?.trim()) lines.push(r.answer.trim());
  else lines.push('(DSH 本次没有产生正文输出)');

  if (r.thinking && r.thinking.trim()) {
    lines.push('');
    lines.push('--- 思考内容 ---');
    lines.push(r.thinking.trim());
  }

  const meta = [];
  meta.push(`stop=${r.stop_reason}`);
  if (typeof r.elapsed_ms === 'number') meta.push(`耗时=${(r.elapsed_ms / 1000).toFixed(1)}s`);
  if (r.thinking_stats?.chars) {
    meta.push(
      r.thinking_stats.hidden
        ? `思考已隐藏(${r.thinking_stats.chars}字/${(r.thinking_stats.ms / 1000).toFixed(1)}s)`
        : `思考=${r.thinking_stats.chars}字`,
    );
  }
  const tools = (r.tools_used ?? []).map((t) => t.name ?? t.title).filter(Boolean);
  if (tools.length) meta.push(`工具=[${[...new Set(tools)].join(', ')}]`);
  if (r.workspace_changed) meta.push(`工作区有改动(${r.diff_stat?.changed_files ?? '?'} 个文件)`);
  lines.push('');
  lines.push(`[${meta.join(' · ')}]`);

  if (r.error) {
    lines.push('');
    lines.push(`⚠️ 回合失败: ${r.error}`);
  }
  return lines.join('\n');
}

/** 工具处理器表。 */
/**
 * 后台收据的渲染：wait=false 直接走这里；wait=true 等超时会自动降级到这里。
 * 关键语义：**回合没有被取消**，只是我们不再原地等 —— 结果稍后由哨兵文件通知。
 */
function backgroundReceipt(hub, conv, res) {
  const sentinel = res.sentinel_file ?? hub.runSentinelPath(conv.id, res.run_id);
  const sentinelPosix = toPosixPath(sentinel);
  const waited = res.waited_ms
    ? `已等待 ${(res.waited_ms / 1000).toFixed(0)}s 仍未结束，改为后台继续（**回合没有被取消**）。`
    : '已在后台执行（**回合没有被取消**）。';
  return {
    structured: {
      conversation_id: conv.id,
      run_id: res.run_id,
      accepted: true,
      background: true,
      still_running: true,
      sentinel_file: sentinel,
      /** Bash/MSYS 形式（D:\a\b → /d/a/b）；非 Windows 等于 sentinel_file。 */
      sentinel_file_posix: sentinelPosix,
    },
    text:
      `${waited}（run_id=${res.run_id}）\n\n` +
      `【跑完自动通知，无需轮询】完成时（成功/失败/被取消）会原子写出这个文件（含最终结果，但**不含思考内容**）：\n` +
      `  ${sentinel}\n` +
      `直接用下面这个 Bash 形式路径，**不要手工转换**（写错会一直等到超时）：\n` +
      `  ${sentinelPosix}\n` +
      `推荐用后台任务等它出现，文件一到就会唤醒你：\n` +
      `  Bash(run_in_background): sent="${sentinelPosix}"; \\\n` +
      `    dl=$(( $(date +%s)+2100 )); until [ -f "$sent" ]; do [ $(date +%s) -ge $dl ] && { echo TIMEOUT; exit 1; }; sleep 2; done; echo DONE\n` +
      `文件出现后：直接读它拿结果（推荐——不受内存窗口限制、还扛服务重启），或 dsh_get(conversation_id, run_id) 验收。\n` +
      `消费完可以 rm 掉它。其它随时可用：dsh_status（是否在跑）、dsh_read（增量看输出）。` +
      (res.waited_ms
        ? `\n\n下次想立刻返回就传 wait=false；想等更久就调大 timeout_ms（**0 = 一直等**）。`
        : ''),
  };
}

export function createHandlers(hub) {
  return {
    async dsh_start(args) {
      const conv = await hub.create({
        cwd: args.cwd,
        permission: args.permission ?? DEFAULT_PERMISSION,
        onApproval: args.on_approval,
        titleHint: args.title_hint,
        reasoningEffort: args.reasoning_effort,
        provider: args.provider,
        model: args.model,
      });
      if (args.title_hint) conv.titleHint = args.title_hint;
      const snap = conv.snapshot();
      const lines = [
        '已创建会话。',
        `conversation_id: ${snap.conversation_id}`,
        `工作区: ${snap.cwd}`,
        `权限档: ${snap.permission}（审批策略 ${snap.on_approval}）`,
        `思考深度: ${snap.reasoning_effort}`,
        `对话名: ${snap.title ?? '(DSH 尚未生成，发出第一条消息后自动生成)'}`,
        `工作区登记: ${snap.workspace_registered ? '已写入 DSH 工作区注册表（GUI 里能看到）' : '未登记'}`,
      ];
      if (snap.config_failed?.length) lines.push(`⚠️ 配置未完全套用: ${snap.config_failed.join('; ')}`);
      return { structured: snap, text: lines.join('\n') };
    },

    async dsh_send(args) {
      const conv = hub.get(args.conversation_id);
      const opts = { reasoning: args.reasoning ?? DEFAULT_REASONING };
      if (args.timeout_ms) opts.timeoutMs = args.timeout_ms;

      // ── 默认路径：后台派活（wait !== true）──────────
      // 默认不阻塞：立即给收据 + 哨兵路径，回合结束时自动通知。想原地等就显式传 wait=true。
      if (args.wait !== true) {
        if (conv.busy) {
          throw new Error(
            '会话正在跑另一个回合，无法再排一个。可以：dsh_interject（插话）或 dsh_interrupt（打断）后重试。',
          );
        }
        const run = conv.createRun(args.prompt);
        // prompt() 自己负责收尾与写哨兵（sentinel: true）。这里 await 是为了
        // **同步暴露 resume/启动失败** —— 否则调用方会拿到一个 accepted 但注定失败的收据。
        // 冷启动时这一步要几秒（要拉进程 + resume），热会话是瞬时。
        const res = await conv.prompt(args.prompt, { ...opts, run, wait: false });
        conv.lastResult = res;
        return res.still_running ? backgroundReceipt(hub, conv, res) : { structured: res, text: renderSendResult(res) };
      }

      // ── 等待模式：等到就返回结果；等超时则自动降级为后台（不报错、不丢结果）──
      const r = await conv.prompt(args.prompt, opts);
      conv.lastResult = r;
      if (r?.still_running) return backgroundReceipt(hub, conv, r);
      return { structured: r, text: renderSendResult(r) };
    },

    async dsh_list(args) {
      let items = await hub.list({
        cwd: args.cwd,
        // only_running 只关心"正在跑"的会话，而那些必然在本服务内存里 ——
        // 磁盘探测（要 spawn 一个 DSH 进程，实测约 1 秒）对它是纯浪费，且语义等价。
        includeClosed: args.only_running === true ? false : args.include_closed !== false,
      });
      if (args.only_running === true) items = items.filter((c) => c.state === 'running');
      const running = items.filter((c) => c.state === 'running').length;
      const describe = (c) => {
        const bits = [`${c.title ?? '(无标题)'}`, `id=${c.conversation_id}`];
        if (c.state === 'running') {
          const extra = [
            `已跑${((c.running_ms ?? 0) / 1000).toFixed(0)}s`,
            c.current_tool ? `工具=${c.current_tool}` : null,
            c.out_chars ? `本轮输出=${c.out_chars}字` : null,
          ].filter(Boolean);
          bits.push(`🔵进行中(${extra.join(', ')})`);
        } else if (c.state === 'idle') {
          bits.push('🟢空闲');
        } else {
          bits.push('⚪未打开(可 resume)');
        }
        bits.push(`cwd=${c.cwd}`);
        if (c.permission) bits.push(`权限=${c.permission}`);
        if (c.turns != null) bits.push(`轮数=${c.turns}`);
        return `- ${bits.join(' | ')}`;
      };
      const text = items.length
        ? `${items.length} 个会话（其中 ${running} 个正在跑）：\n${items.map(describe).join('\n')}`
        : '(没有会话)';
      // 孤儿锁持有者：上一代 MCP 崩了但它的 DSH 子进程还活着握着写锁 —— 不主动报出来，
      // 用户只会在下一次撞上"被占用"时才发现。这里顺手提示，并给出可执行的动作。
      const orphans = listOrphans();
      const orphanNote = orphans.length
        ? `\n\n⚠️ 发现 ${orphans.length} 个**孤儿锁持有者**（MCP 已退出、子进程还握着写锁）：\n` +
          orphans.map((o) => `- 会话 ${o.conversation_id}（子进程 PID ${o.child_pid}，已失联 ${o.age_ms === null ? '未知' : Math.round(o.age_ms / 1000) + 's'}）`).join('\n') +
          '\n→ 用 dsh_takeover 抢占即可（这些是本服务自己的残留，抢占是安全的）。'
        : '';
      return {
        structured: { count: items.length, running, conversations: items, orphan_holders: orphans },
        text: text + orphanNote,
      };
    },

    async dsh_read(args) {
      const conv = hub.get(args.conversation_id);
      const r = conv.readOut({
        cursor: args.cursor ?? 0,
        includeReasoning: args.include_reasoning === true,
        limit: args.limit ?? 200,
      });
      const render = (e) => {
        if (e.kind === 'user') return `[我] ${e.text}`;
        if (e.kind === 'text') return `[DSH] ${e.text}`;
        if (e.kind === 'tool') return `[工具] ${e.text}`;
        if (e.kind === 'turn') return `[轮次] ${e.text}`;
        return `[${e.kind}] ${e.text}`;
      };
      const flags = [
        `状态=${r.state}`,
        r.current_tool ? `正在执行=${r.current_tool}` : null,
        `cursor=${r.cursor}`,
        r.gap ? '⚠️缓冲已覆盖中间一段，去重不保证' : null,
        r.has_more ? '还有更多（继续用新 cursor 拉）' : null,
      ].filter(Boolean);
      const body = r.entries.length ? r.entries.map(render).join('\n') : '(游标之后没有新输出)';
      const think = r.live_thinking ? `\n--- 当前回合实时思考 ---\n${r.live_thinking}` : '';
      return { structured: r, text: `${flags.join(' | ')}\n\n${body}${think}` };
    },

    async dsh_get(args) {
      const conv = hub.get(args.conversation_id);
      const snap = conv.snapshot();
      let run = null;
      const meta = [];
      meta.push(`对话名: ${snap.title ?? '(尚未生成)'}（DSH 自动生成）`);
      meta.push(`工作区: ${snap.cwd}`);
      meta.push(`状态: ${snap.busy ? '忙' : snap.alive ? '空闲(进程活着)' : '未打开(可用 resume 复活)'}`);
      meta.push(`权限档: ${snap.permission} / 审批 ${snap.on_approval}`);
      meta.push(`轮数: ${snap.turns}`);
      if (snap.model) meta.push(`模型: ${snap.model.provider}/${snap.model.model}${snap.model.reasoningEffort ? ` (${snap.model.reasoningEffort})` : ''}`);
      if (snap.usage) meta.push(`token: in=${snap.usage.uncachedInputTokens ?? 0} out=${snap.usage.outputTokens ?? 0} cache=${snap.usage.cacheReadTokens ?? 0}`);
      if (snap.context_pressure) meta.push(`上下文压力: ${snap.context_pressure.pressureTokens}/${snap.context_pressure.contextWindow}`);
      if (snap.pending_approvals?.length) meta.push(`待决审批: ${snap.pending_approvals.join(', ')}`);
      run = args.run_id ? conv.getRun(args.run_id) : conv.getRun();
      if (run) {
        meta.push('');
        meta.push(
          `回合 ${run.run_id}: 状态=${run.status}` +
            (run.elapsed_ms != null ? ` 耗时=${(run.elapsed_ms / 1000).toFixed(1)}s` : '') +
            (run.status === 'running' ? '（还在跑，可继续用 dsh_read 看输出）' : ''),
        );
        meta.push(`  指令: ${run.prompt_preview}`);
        if (run.result?.answer) {
          meta.push('  最终答复:');
          meta.push(run.result.answer);
        }
        if (run.result?.thinking_stats?.chars) {
          meta.push(`  （思考 ${run.result.thinking_stats.chars} 字已隐藏）`);
        }
        if (run.result?.error) meta.push(`  ⚠️ 失败: ${run.result.error}`);
      }
      const runView = run
        ? {
            run_id: run.run_id,
            status: run.status,
            started_at: run.started_at ? new Date(run.started_at).toISOString() : null,
            ended_at: run.ended_at ? new Date(run.ended_at).toISOString() : null,
            elapsed_ms: run.elapsed_ms,
            prompt_preview: run.prompt_preview,
            result: run.result,
          }
        : null;
      return { structured: { ...snap, run: runView }, text: meta.join('\n') };
    },

    async dsh_interject(args) {
      const conv = hub.get(args.conversation_id);
      const opts = { mode: args.mode ?? 'interject', reasoning: args.reasoning ?? DEFAULT_REASONING };
      if (args.timeout_ms) opts.timeoutMs = args.timeout_ms;
      const r = await conv.interject(args.message, opts);
      conv.lastResult = r;
      const head =
        r.interjected === 'idle'
          ? '会话当时空闲，已按普通回合执行。'
          : r.interjected === 'queue'
            ? `已排队：等了 ${(r.waited_ms / 1000).toFixed(1)}s 让上一轮跑完，然后说了这句。`
            : `已打断上一轮，改口说了这句（上一轮耗时 ${(r.waited_ms / 1000).toFixed(1)}s 处被打断）。`;
      // 插话这一轮同样会写哨兵（"一个回合 = 一个哨兵"），把路径一并交回，
      // 调用方就能用同一套"等文件出现"的逻辑收活 —— 之前这里没有哨兵，等待方会空等。
      const sentinel = r?.run_id ? hub.runSentinelPath(conv.id, r.run_id) : null;
      return {
        structured: sentinel ? { ...r, sentinel_file: sentinel, sentinel_file_posix: toPosixPath(sentinel) } : r,
        text:
          `${head}\n\n${renderSendResult(r)}` +
          (sentinel
            ? `\n\n完成通知文件（本轮结束时原子写出，含最终结果）：\n  ${sentinel}\n  ${toPosixPath(sentinel)}`
            : ''),
      };
    },

    async dsh_interrupt(args) {
      const conv = hub.get(args.conversation_id);
      const r = await conv.interrupt();
      return { structured: r, text: r.interrupted ? '已发送中断请求。' : `未中断：${r.reason}` };
    },

    async dsh_release(args) {
      // ★ all=true：一次性放掉所有活着的会话进程（腾内存）。
      //   无损：会话日志都在磁盘上，之后照样 resume。
      if (args.all === true) {
        const r = await hub.releaseAll();
        return {
          structured: { released: r.released, conversations: r.conversations },
          text:
            `已释放 ${r.released} 个会话进程（写锁全部让出，内存立刻回收）。` +
            `\n会话日志都在磁盘上，之后派活会自动 resume；其中一个都没在跑时 released=0。`,
        };
      }
      const conv = hub.get(args.conversation_id);
      const r = await conv.close({ forget: args.forget === true });
      return {
        structured: { conversation_id: args.conversation_id, ...r },
        text: r.forgotten
          ? '已释放进程并从注册表移除。会话日志仍在磁盘上。'
          : '已释放 DSH 进程（写锁已让出，你可以在自己的 DSH GUI 里打开这个会话）。会话仍可 resume。',
      };
    },

    async dsh_takeover(args) {
      const conv = hub.get(args.conversation_id);
      const r = await conv.takeover({ force: args.force === true });
      return { structured: r, text: `${r.ok ? '✅' : '❌'} ${r.message}` };
    },

    async dsh_approval_decide(args) {
      const conv = hub.get(args.conversation_id);
      const r = conv.decideApproval(args.approval_id, args.decision);
      return { structured: r, text: `审批 ${r.approval_id} 已裁决为 ${r.decision}。` };
    },

    async dsh_status(args) {
      const conv = hub.get(args.conversation_id);
      const snap = conv.snapshot();
      const run = conv.getRun();
      const bits = [`状态=${snap.state}`, `轮数=${snap.turns}`];
      if (snap.state === 'running') {
        bits.push(`已跑=${((snap.running_ms ?? 0) / 1000).toFixed(1)}s`);
        if (snap.current_tool) bits.push(`当前工具=${snap.current_tool}`);
        bits.push(`本轮输出=${snap.out_chars ?? 0}字`);
      }
      if (run) bits.push(`最近回合=${run.run_id}(${run.status})`);
      bits.push(`待决审批=${snap.pending_approvals.length}`);
      // 写锁在谁手上：区分"自己握着"和"被别人占着"，后者直接给出可执行动作
      if (snap.lock_holder && snap.lock_holder !== 'self') {
        const hint =
          snap.lock_holder === 'stale-mcp'
            ? '（本服务残留的孤儿，可 dsh_takeover 抢占）'
            : snap.lock_holder === 'live-mcp'
              ? '（另一个活着的 dsh-mcp 实例在用；要夺需 dsh_takeover(force=true)）'
              : '（多半是你自己的 DSH GUI 正开着它；本服务不会去杀它）';
        bits.push(`写锁=${snap.lock_holder}${hint}`);
      }
      // ★ 撞过锁就把"谁占用 + 怎么解"讲清楚。实测：GUI 点开一次就会长期持有写锁
      //   （切走、等十几分钟都不释放），所以这条信息必须持久可见，而不是一闪而过的报错。
      if (snap.lock_conflict) {
        const lc = snap.lock_conflict;
        const ago = Math.round((Date.now() - lc.at) / 1000);
        bits.push(`⚠️ 最近一次撞锁：${ago}s 前，持有者=${lc.holder_kind}`);
        bits.push(`   判定：${lc.reason}`);
        bits.push(`   怎么办：${lc.hint}`);
      }
      return {
        structured: {
          conversation_id: snap.conversation_id,
          state: snap.state,
          alive: snap.alive,
          busy: snap.busy,
          current_tool: snap.current_tool,
          out_chars: snap.out_chars,
          running_ms: snap.running_ms,
          pending_approvals: snap.pending_approvals,
          turns: snap.turns,
          lock_holder: snap.lock_holder,
          lock_conflict: snap.lock_conflict,
          run: run
            ? {
                run_id: run.run_id,
                status: run.status,
                elapsed_ms: run.elapsed_ms,
                stop_reason: run.result?.stop_reason ?? null,
                error: run.result?.error ?? run.error ?? null,
              }
            : null,
        },
        text: bits.join(' | '),
      };
    },
  };
}