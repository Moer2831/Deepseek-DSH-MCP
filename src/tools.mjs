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
} from './config.mjs';

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
          description: `权限档。默认 ${DEFAULT_PERMISSION}。read-only 适合分析不信任样本（如恶意软件）；workspace-write 越界操作会冒泡为待决审批。`,
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
      '向会话派一个任务。默认（wait=true）阻塞到回合结束再返回最终答复；' +
      '**长任务建议 wait=false**：立刻返回一个 run_id，你继续做别的事，稍后用 ' +
      'dsh_get(conversation_id, run_id) 验收结果，或 dsh_read 中途查看输出。' +
      '默认隐藏思考内容（只返回正文 + 思考统计）。' +
      '若会话正在忙，本工具会报错——改用 dsh_interject 插话，或用 dsh_interrupt 先打断。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        prompt: { type: 'string', description: '任务描述。可以引用工作区里的文件路径。' },
        wait: { type: 'boolean', description: 'true（默认）阻塞到回合结束；false 立即返回并后台执行。' },
        reasoning: {
          type: 'string',
          enum: REASONING_MODES,
          description: `思考内容展示档位。默认 ${DEFAULT_REASONING}（只返回正文，思考只给统计）。full 会占用大量上下文。`,
        },
        timeout_ms: { type: 'number', description: '阻塞等待上限，默认 30 分钟。' },
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
      include_closed: { type: 'boolean', description: '是否包含磁盘上未打开的会话，默认 true。' },
      only_running: { type: 'boolean', description: '只返回正在跑回合的会话，默认 false。' },
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
        timeout_ms: { type: 'number', description: '新回合的等待上限，默认 30 分钟。' },
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
    name: 'dsh_release',
    description:
      '释放会话占用的 DSH 进程（释放写锁，让用户能在自己的 DSH GUI 里打开同一个会话）。' +
      '会话本体留在磁盘上，之后仍可 resume；forget=true 才会从注册表里摘掉。',
    inputSchema: S(
      {
        conversation_id: CONV_ID,
        forget: { type: 'boolean', description: '同时从本服务的注册表里移除，默认 false。' },
      },
      ['conversation_id'],
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

      if (args.wait === false) {
        if (conv.busy) {
          throw new Error(
            '会话正在跑另一个回合，无法再排一个。可以：dsh_interject（插话）或 dsh_interrupt（打断）后重试。',
          );
        }
        const run = conv.createRun(args.prompt);
        conv.background = conv
          .prompt(args.prompt, { ...opts, run })
          .then((r) => {
            conv.lastResult = r;
            return r;
          })
          .catch((e) => {
            run.status = 'error';
            run.ended_at = Date.now();
            run.error = e.message;
            conv.lastResult = { error: e.message, stop_reason: 'error', run_id: run.run_id };
            return conv.lastResult;
          });
        return {
          structured: { conversation_id: conv.id, run_id: run.run_id, accepted: true, background: true },
          text:
            `已在后台开始执行（run_id=${run.run_id}）。你现在可以继续做别的事，稍后：\n` +
            `- dsh_get(conversation_id, run_id) 取最终结果（验收）\n` +
            `- dsh_status(conversation_id) 看是否还在跑\n` +
            `- dsh_read(conversation_id, cursor) 中途查看它当前吐出的内容`,
        };
      }

      const r = await conv.prompt(args.prompt, opts);
      conv.lastResult = r;
      return { structured: r, text: renderSendResult(r) };
    },

    async dsh_list(args) {
      let items = await hub.list({ cwd: args.cwd, includeClosed: args.include_closed !== false });
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
      return { structured: { count: items.length, running, conversations: items }, text };
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
      return { structured: r, text: `${head}\n\n${renderSendResult(r)}` };
    },

    async dsh_interrupt(args) {
      const conv = hub.get(args.conversation_id);
      const r = await conv.interrupt();
      return { structured: r, text: r.interrupted ? '已发送中断请求。' : `未中断：${r.reason}` };
    },

    async dsh_release(args) {
      const conv = hub.get(args.conversation_id);
      const r = await conv.close({ forget: args.forget === true });
      return {
        structured: { conversation_id: args.conversation_id, ...r },
        text: r.forgotten
          ? '已释放进程并从注册表移除。会话日志仍在磁盘上。'
          : '已释放 DSH 进程（写锁已让出，你可以在自己的 DSH GUI 里打开这个会话）。会话仍可 resume。',
      };
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