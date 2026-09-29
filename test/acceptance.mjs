/**
 * 最终验收测试。
 *
 * 场景：桌面两个文件夹，每个文件夹跑两个会话（共 4 个），每个会话调用 IDA MCP
 *       做一次**只读**的简短分析。
 *
 * 验收点（逐会话）：
 *   1) 回合正常结束、有正文输出
 *   2) 确实调用了 IDA 工具（mcp__ida__*）
 *   3) 没有调用任何写入类 IDA 工具（只读约束）
 *   4) 默认隐藏思考（structured.thinking 为空，但有思考统计）
 *   5) 会话标题已生成（DSH 的标题子系统）
 *
 * 用法：
 *   node test/acceptance.mjs            # 完整验收（4 个会话）
 *   DSH_E2E_MODE=preflight node ...     # 预检（1 个会话，先确认只读档下 IDA 通路可用）
 */

import { mkdirSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from './mcp-client.mjs';

const MODE = process.env.DSH_E2E_MODE ?? 'full';
const DESKTOP = join(homedir(), 'Desktop');
const FOLDER_A = join(DESKTOP, 'dsh-mcp-test-A');
const FOLDER_B = join(DESKTOP, 'dsh-mcp-test-B');
const STATE = join(tmpdir(), `dsh-mcp-e2e-state-${Date.now()}.json`);

/** 写入类 IDA 工具：只读分析里一律不该出现。 */
const IDA_WRITE_TOOLS = [
  'patch', 'put_int', 'patch_asm', 'rename', 'define_func', 'define_code', 'undefine',
  'set_comments', 'append_comments', 'declare_type', 'declare_stack', 'delete_stack',
  'set_type', 'type_apply_batch', 'infer_types', 'enum_upsert', 'idb_save',
];

/** 只读约束的统一前缀（拼进 prompt）。 */
const READONLY_RULES = `
硬性要求：
- 这是**只读**分析：绝对不要调用任何会修改 IDA 数据库的工具（patch / put_int / patch_asm / rename / define_func / define_code / undefine / set_comments / append_comments / declare_type / declare_stack / delete_stack / set_type / type_apply_batch / infer_types / enum_upsert / idb_save）。
- 每个 IDA 工具都必须带 instance_id 参数；先用 mcp__ida__instance_list 拿到它。
- 如果某个工具报错，换一个只读工具继续，不要卡住。
- 汇报控制在 150 字以内，不要贴大段原始输出。`;

const TASKS = [
  {
    key: 'A1',
    folder: FOLDER_A,
    what: '概况侦察（survey_binary）',
    prompt: `用 IDA 工具做一次简短的只读概况侦察：
1. mcp__ida__instance_list 取 instance_id
2. mcp__ida__survey_binary 看这个二进制的概况
然后用不超过 150 字汇报：架构、位数、函数大致数量、以及你的总体印象。
${READONLY_RULES}`,
  },
  {
    key: 'A2',
    folder: FOLDER_A,
    what: '函数表（list_funcs）',
    prompt: `用 IDA 工具做一次简短的只读函数表侦察：
1. mcp__ida__instance_list 取 instance_id
2. mcp__ida__list_funcs（限制返回 15 条左右即可）看看都有哪些函数
然后用不超过 150 字汇报：函数命名风格、能看出的模块特征。
${READONLY_RULES}`,
  },
  {
    key: 'B1',
    folder: FOLDER_B,
    what: '导入表（imports）',
    prompt: `用 IDA 工具做一次简短的只读导入表侦察：
1. mcp__ida__instance_list 取 instance_id
2. mcp__ida__imports（限制 20 条左右即可）看导入了哪些 API
然后用不超过 150 字汇报：主要依赖哪些系统库、能推断出的程序类型。
${READONLY_RULES}`,
  },
  {
    key: 'B2',
    folder: FOLDER_B,
    what: '健康检查与资源（cache_status / server_health）',
    prompt: `用 IDA 工具做一次简短的只读状态检查：
1. mcp__ida__instance_list 取 instance_id
2. mcp__ida__server_health 与 mcp__ida__cache_status 看看 IDA 会话与静态缓存是否就绪
然后用不超过 150 字汇报：IDA 实例是否健康、缓存状态如何。
${READONLY_RULES}`,
  },
];

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function looksLikeIdaTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__ida__');
}
function idaWriteToolUsed(names) {
  return names.filter((n) => looksLikeIdaTool(n) && IDA_WRITE_TOOLS.includes(n.replace('mcp__ida__', '')));
}

async function runSession(client, t) {
  const rec = { key: t.key, folder: t.folder, what: t.what, checks: [], problems: [] };
  const say = (ok, label, detail = '') => {
    rec.checks.push({ ok, label, detail });
    if (!ok) rec.problems.push(`${label}${detail ? ` :: ${detail}` : ''}`);
  };

  const t0 = Date.now();
  try {
    const start = await client.callTool('dsh_start', { cwd: t.folder, permission: 'read-only' }, 180_000);
    const s = start?.structuredContent ?? {};
    rec.conversation_id = s.conversation_id;
    say(s.permission === 'read-only', '权限档为 read-only', s.permission);
    say(s.on_approval === 'auto-deny', '只读档审批策略为 auto-deny', s.on_approval);

    const send = await client.callTool(
      'dsh_send',
      { conversation_id: rec.conversation_id, wait: true, prompt: t.prompt, timeout_ms: 600_000 },
      660_000,
    );
    const r = send?.structuredContent ?? {};
    rec.stop_reason = r.stop_reason;
    rec.error = r.error ?? null;
    rec.answer = r.answer ?? '';
    rec.thinking_stats = r.thinking_stats;
    const tools = (r.tools_used ?? []).map((x) => x.name ?? x.title).filter(Boolean);
    rec.tools = [...new Set(tools)];
    rec.idaTools = rec.tools.filter(looksLikeIdaTool);

    say(r.stop_reason && r.stop_reason !== 'error', '回合正常结束', `stop=${r.stop_reason} err=${r.error ?? ''}`);
    say((r.answer ?? '').trim().length > 0, '有正文输出', `len=${(r.answer ?? '').length}`);
    say(rec.idaTools.length > 0, '调用了 IDA 工具', `tools=${rec.tools.join(', ')}`);
    const bad = idaWriteToolUsed(rec.tools);
    say(bad.length === 0, '未使用任何写入类 IDA 工具', bad.length ? `违规=${bad.join(', ')}` : '');
    say(!r.thinking || r.thinking === '', '默认隐藏思考内容', JSON.stringify(r.thinking ?? ''));
    say(!!r.thinking_stats, '提供了思考统计', JSON.stringify(r.thinking_stats));

    await sleep(1500); // 等投影缓存刷新（每 5 秒或每 200 事件写一次）
    const get = await client.callTool('dsh_get', { conversation_id: rec.conversation_id });
    rec.title = get?.structuredContent?.title ?? null;
    rec.turns = get?.structuredContent?.turns ?? null;
    say(!!rec.title, '会话标题已生成', String(rec.title));
  } catch (e) {
    rec.error = e.message;
    say(false, '会话执行异常', e.message);
  }
  rec.ms = Date.now() - t0;
  return rec;
}

// ── 主流程 ────────────────────────────────────────────────────────

for (const d of [FOLDER_A, FOLDER_B]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const tasks = MODE === 'preflight' ? [TASKS[0]] : TASKS;
console.log(`模式: ${MODE}    会话数: ${tasks.length}`);
console.log(`文件夹: ${FOLDER_A}\n        ${FOLDER_B}`);
console.log(`状态文件: ${STATE}\n`);

const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();
try {
  await client.initialize();
  const tools = await client.listTools();
  console.log(`MCP 工具数: ${tools.length}`);

  // 按文件夹分组：同一文件夹内的两个会话**并发**跑（顺带验证并发独立性）
  const byFolder = new Map();
  for (const t of tasks) {
    if (!byFolder.has(t.folder)) byFolder.set(t.folder, []);
    byFolder.get(t.folder).push(t);
  }

  for (const [folder, list] of byFolder) {
    console.log(`\n${'='.repeat(70)}\n文件夹: ${folder}  （${list.length} 个会话并发）\n${'='.repeat(70)}`);
    const batch = await Promise.all(list.map((t) => runSession(client, t)));
    results.push(...batch);
    for (const r of batch) {
      console.log(`\n── 会话 ${r.key}：${r.what} ──`);
      console.log(`  conversation_id: ${r.conversation_id ?? '(未创建)'}`);
      console.log(`  标题: ${r.title ?? '(无)'}    轮数: ${r.turns ?? '?'}    耗时: ${(r.ms / 1000).toFixed(1)}s`);
      console.log(`  stop=${r.stop_reason}  思考统计=${JSON.stringify(r.thinking_stats)}`);
      console.log(`  用到的工具: ${r.tools?.join(', ') || '(无)'}`);
      console.log(`  答复:\n${(r.answer ?? '').split('\n').map((l) => '    ' + l).join('\n')}`);
      for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
    }
  }
} catch (e) {
  console.log(`\n致命错误: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-40).join('\n'));
  results.push({ key: 'FATAL', problems: [e.message] });
} finally {
  await client.close();
}

// ── 汇总 ──────────────────────────────────────────────────────────

const totalChecks = results.reduce((n, r) => n + (r.checks?.length ?? 0), 0);
const failedChecks = results.reduce((n, r) => n + (r.checks?.filter((c) => !c.ok).length ?? 0), 0);

console.log(`\n${'='.repeat(70)}`);
console.log('验收汇总');
console.log('='.repeat(70));
console.log(`会话数: ${results.length}`);
console.log(`检查项: ${totalChecks}，失败: ${failedChecks}`);
for (const r of results) {
  const bad = r.checks?.filter((c) => !c.ok) ?? [];
  console.log(`  ${bad.length === 0 ? '✓ 通过' : '✗ 失败'}  会话 ${r.key} (${r.what ?? ''})  工具数=${(r.tools ?? []).length} IDA工具=${(r.idaTools ?? []).length}`);
  for (const b of bad) console.log(`        - ${b.label}${b.detail ? ` :: ${b.detail}` : ''}`);
}
console.log(`\n结论: ${failedChecks === 0 && results.length === (MODE === 'preflight' ? 1 : 4) ? '全部通过 ✅' : '存在失败 ❌'}`);
process.exit(failedChecks === 0 ? 0 : 1);