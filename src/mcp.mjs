/**
 * MCP 服务端（stdio，换行分隔 JSON-RPC 2.0）。
 *
 * 只有 stdout 是协议通道，任何诊断一律走 stderr——这是硬要求，
 * 因为混进 stdout 的日志会直接破坏报文。日志默认静默（见 config.createLogger）。
 */

import { createHandlers, TOOL_DEFS } from './tools.mjs';

const SERVER_NAME = 'dsh-mcp';
const SERVER_VERSION = '0.1.0';
const FALLBACK_PROTOCOL = '2025-06-18';

const INSTRUCTIONS = `这个服务把 DeepSeek Harness (DSH) 当作一个**可长期共事的编码 agent** 来驱动。
DSH 自己有文件读写、shell、搜索、技能、子代理等全套工具；你给它**目标**，它自己决定怎么做。
本服务只暴露下面这些 dsh_* 工具。

【三个 id 的关系（务必分清）】
- conversation_id —— 长期会话。可反复派活，历史完整保留。进程只是缓存：被回收或崩溃后，
  下次派活会自动 resume 复活，对话不丢。适合"这个项目一直用这个会话"。
- run_id —— **一次派活**的记录。dsh_send 每次返回一个，用它验收那一次的结果。
- cursor —— dsh_read 的增量游标，用来观察某个会话当前吐出的内容。

【标准流程】
1. dsh_start(cwd, ...)                        建会话。cwd 必须是**已存在**的绝对路径。
2. dsh_send(conversation_id, prompt)          派活。默认阻塞到回合结束并返回答复。
   dsh_send(..., wait=false) → run_id         长任务用这个：立刻返回，你继续干别的。
3. 之后按需：
   dsh_status(conversation_id)                还在跑吗？跑到哪了？
   dsh_read(conversation_id, cursor)          中途看它当前吐出的内容（增量）
   dsh_get(conversation_id, run_id)           验收：取那一次派活的完整结果
4. dsh_interject / dsh_interrupt              跑偏了就插话改口 / 直接打断
5. dsh_release                                交还会话（释放写锁，之后仍可 resume）

【选择建议】
- 任务可能超过一两分钟 → **用 wait=false**。MCP 工具调用是阻塞的，傻等会把你自己卡住。
- 会话在忙时**不要**再 dsh_send：想改口用 dsh_interject，想停用 dsh_interrupt，
  想把话留到本轮结束后说用 dsh_interject(mode='queue')。
- 思考内容**默认隐藏**（只返回字数/耗时统计）。确实需要时传 reasoning='full'，但很占上下文。
- 权限档默认 danger-full-access（零摩擦）。分析不信任样本（恶意软件、来路不明 dump）时用
  read-only：沙箱只读 + 审批一律拒绝。
- 思考深度默认 max；想省钱可在 dsh_start 传 reasoning_effort 调低。
- 想并行：开多个会话，dsh_list(only_running=true) 看谁在跑，再轮流 dsh_read。

【不要做】
- 不要用 dsh_send 去"执行一条命令"。DSH 是 agent，请给它目标而不是命令；
  它自己会选工具、分步骤、必要时派子代理。
- 不要把 DSH 内部的工具名（read/pwsh/glob 等）当成本服务的工具——本服务只有 dsh_* 这些。
- 不要假设回合秒回。长任务请走 wait=false + 事后验收。`;

export function createMcpServer({ hub, toolDefs = TOOL_DEFS, handlers = createHandlers(hub), log }) {
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  let buffer = '';
  let initialized = false;

  const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params } = msg;

    // 通知（无 id）：不需要回包
    if (id === undefined) {
      if (method === 'notifications/initialized') initialized = true;
      return;
    }

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        ok(id, {
          protocolVersion: typeof requested === 'string' ? requested : FALLBACK_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'ping':
        ok(id, {});
        return;
      case 'tools/list':
        ok(id, {
          tools: toolDefs.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        const fn = handlers[name];
        if (!fn) {
          ok(id, { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true });
          return;
        }
        try {
          const out = await fn(args);
          const result = { content: [{ type: 'text', text: out.text ?? '' }] };
          if (out.structured !== undefined) result.structuredContent = out.structured;
          ok(id, result);
        } catch (e) {
          // 只记错误摘要，不记工具内容（可能含对话正文或思考）
          log?.debug(`[tools/call ${name}] 失败: ${e.message}`);
          ok(id, { content: [{ type: 'text', text: `工具执行失败: ${e.message}` }], isError: true });
        }
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  }

  function onData(chunk) {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log?.debug('[mcp] 收到非 JSON 行（已忽略）');
        continue;
      }
      Promise.resolve()
        .then(() => handle(msg))
        .catch((e) => {
          log?.debug(`[mcp] 处理 ${msg?.method} 异常: ${e.message}`);
          if (msg?.id !== undefined) fail(msg.id, -32603, `Internal error: ${e.message}`);
        });
    }
  }

  return {
    start() {
      process.stdin.on('data', onData);
      process.stdin.on('end', () => log?.debug('[mcp] stdin 结束'));
      return this;
    },
    get initialized() {
      return initialized;
    },
  };
}