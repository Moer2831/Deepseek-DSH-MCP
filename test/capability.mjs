/**
 * 能力测试：多开三个会话并发干活 —— 写代码 / 跑脚本 / 自行派子代理。
 *
 * 与前面的测试不同，这里验证的是**真实产出**，而不只是"回合没报错"：
 *   - 写代码：工作区里真的出现了脚本文件
 *   - 跑脚本：答复里出现了脚本的真实输出（如斐波那契数列）
 *   - 派子代理：磁盘上出现了 origin=subagent / 带 parentSession 的子会话
 *
 * 会消耗一定 token（三个 agent 各自多步作业）。
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { McpClient } from './mcp-client.mjs';

let pass = 0;
let failCount = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const STATE = join(tmpdir(), `dsh-mcp-cap-state-${Date.now()}.json`);
const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-cap-'));
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
const SESSIONS_ROOT = join(DSH_HOME, 'sessions');

/** 复刻 DSH 的 projectKey 规则：分隔符变 '-'，两侧包 '--'。 */
function projectKey(cwd) {
  const readable = cwd.replace(/[\\/:]+/g, '-').replace(/^-+/, '').slice(0, 251);
  return `--${readable || 'root'}--`;
}

/** 读会话头的第一个 zstd 帧（就是头行）。 */
function readSessionHeader(dir) {
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    if (!existsSync(file)) return null;
    const text = zstdDecompressSync(readFileSync(file)).toString('utf8');
    const first = text.split(/\r?\n/).find(Boolean);
    return JSON.parse(first);
  } catch {
    return null;
  }
}

/** 列出某工作区桶下的所有会话头。 */
function sessionsIn(cwd) {
  const bucket = join(SESSIONS_ROOT, projectKey(cwd));
  if (!existsSync(bucket)) return [];
  return readdirSync(bucket)
    .map((name) => ({ name, header: readSessionHeader(join(bucket, name)) }))
    .filter((x) => x.header);
}

const JOBS = [
  {
    key: 'C1-写代码+跑脚本',
    ws: join(root, 'coder'),
    prompt:
      '请严格按步骤做，最后简短汇报（100 字内）：\n' +
      '1. 在当前工作目录写一个文件 fib.py：这是一个 Python 脚本，打印前 10 个斐波那契数（用空格分隔）。\n' +
      '2. 用 pwsh 运行 `python fib.py`。\n' +
      '3. 把脚本的真实输出原样贴出来。',
  },
  {
    key: 'C2-写脚本+跑脚本',
    ws: join(root, 'scripter'),
    prompt:
      '请严格按步骤做，最后简短汇报（100 字内）：\n' +
      '1. 在当前工作目录写一个 PowerShell 脚本 check.ps1，功能是统计当前目录下的文件数量并打印，再打印一行 DONE。\n' +
      '2. 用 pwsh 运行这个脚本。\n' +
      '3. 把脚本的真实输出原样贴出来。',
  },
  {
    key: 'C3-自行派子代理',
    ws: join(root, 'delegator'),
    prompt:
      '请严格按步骤做，最后简短汇报（100 字内）：\n' +
      '1. 用 pwsh 在当前目录创建两个文本文件：a.txt 内容写 alpha，b.txt 内容写 beta。\n' +
      '2. 然后**必须使用 subagent 工具**派一个子代理，让子代理去读取这两个文件并总结它们的内容。\n' +
      '3. 把子代理返回的结论汇总给我。',
  },
];

const results = [];

const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();
try {
  await client.initialize();

  console.log('\n[1] 并发开三个会话并派活（写代码 / 跑脚本 / 派子代理）');
  const started = [];
  for (const j of JOBS) {
    mkdirSync(j.ws, { recursive: true });
    const start = await client.callTool('dsh_start', { cwd: j.ws, permission: 'danger-full-access' }, 180_000);
    const id = start?.structuredContent?.conversation_id;
    check(`${j.key}: 会话已建`, !!id, McpClient.text(start).slice(0, 140));
    check(`${j.key}: 思考深度=max`, start?.structuredContent?.reasoning_effort === 'max');
    started.push({ ...j, id });
  }

  // 三个会话并发跑（每个都是多步 agent 作业，给足时间）
  const startedAt = Date.now();
  const sends = await Promise.all(
    started.map((j) =>
      client
        .callTool('dsh_send', { conversation_id: j.id, wait: true, prompt: j.prompt, timeout_ms: 900_000 }, 960_000)
        .then((r) => ({ j, r }))
        .catch((e) => ({ j, r: null, err: e.message })),
    ),
  );

  for (const { j, r, err } of sends) {
    const s = r?.structuredContent ?? {};
    const tools = [...new Set((s.tools_used ?? []).map((t) => t.name ?? t.title).filter(Boolean))];
    results.push({ ...j, s, tools, err });
    console.log(`\n── ${j.key} ──`);
    console.log(`  stop=${s.stop_reason} 耗时=${((s.elapsed_ms ?? 0) / 1000).toFixed(1)}s`);
    console.log(`  用到工具: ${tools.join(', ') || '(无)'}`);
    console.log(`  答复: ${JSON.stringify((s.answer ?? '').slice(0, 300))}`);
    check(`${j.key}: 回合正常结束`, s.stop_reason === 'end_turn', `stop=${s.stop_reason} err=${s.error ?? err ?? ''}`);
  }

  // ── 写代码 + 跑脚本的产物验证 ─────────────────────────────
  console.log('\n[2] 验证真实产出：文件是否落盘、脚本是否真跑了');
  const fibPath = join(root, 'coder', 'fib.py');
  check('C1: fib.py 真的写出来了', existsSync(fibPath), fibPath);
  if (existsSync(fibPath)) {
    const content = readFileSync(fibPath, 'utf8');
    check('C1: fib.py 内容像 Python 脚本', /def |fib|print/i.test(content), content.slice(0, 120));
  }
  const c1 = results.find((r) => r.key.includes('C1'));
  check(
    'C1: 答复里出现了真实运行输出（斐波那契数列）',
    // 不锁死起始值：从 0,1 或 1,1 开始都算合法
    /(0[\s,]+1[\s,]+1[\s,]+2[\s,]+3[\s,]+5)|(1[\s,]+1[\s,]+2[\s,]+3[\s,]+5[\s,]+8)/.test(c1?.s?.answer ?? ''),
    JSON.stringify(c1?.s?.answer?.slice(0, 200)),
  );
  check('C1: 用过 pwsh（真的执行了）', (c1?.tools ?? []).some((t) => /pwsh|bash|shell/i.test(t)), (c1?.tools ?? []).join(','));
  check('C1: 用过写文件类工具', (c1?.tools ?? []).some((t) => /write|edit|create|fs/i.test(t)), (c1?.tools ?? []).join(','));

  const psPath = join(root, 'scripter', 'check.ps1');
  check('C2: check.ps1 真的写出来了', existsSync(psPath), psPath);
  const c2 = results.find((r) => r.key.includes('C2'));
  check('C2: 答复里出现了脚本的真实输出（DONE）', /DONE/.test(c2?.s?.answer ?? ''), JSON.stringify(c2?.s?.answer?.slice(0, 200)));
  check('C2: 用过 pwsh', (c2?.tools ?? []).some((t) => /pwsh|bash|shell/i.test(t)), (c2?.tools ?? []).join(','));

  // ── 子代理验证：磁盘上是否出现子会话 ──────────────────────
  console.log('\n[3] 验证子代理：磁盘上是否出现 origin=subagent 的子会话');
  const c3 = results.find((r) => r.key.includes('C3'));
  check('C3: 用过 subagent 工具', (c3?.tools ?? []).some((t) => /subagent/i.test(t)), (c3?.tools ?? []).join(','));
  check('C3: 创建了 a.txt/b.txt', existsSync(join(root, 'delegator', 'a.txt')) || existsSync(join(root, 'delegator', 'b.txt')));

  const delegatorSessions = sessionsIn(join(root, 'delegator'));
  const children = delegatorSessions.filter(
    (x) => x.header.origin === 'subagent' || x.header.parentSession !== undefined,
  );
  console.log(`    delegator 工作区共 ${delegatorSessions.length} 个会话，其中子会话 ${children.length} 个`);
  for (const ch of delegatorSessions) {
    console.log(
      `      ${ch.name}  origin=${ch.header.origin ?? '-'}  parent=${ch.header.parentSession ?? '-'}  depth=${ch.header.delegationDepth ?? '-'}`,
    );
  }
  check('C3: 磁盘上确实产生了子会话（origin=subagent）', children.length >= 1, `children=${children.length}`);
  check(
    'C3: 子会话挂在 C3 会话之下（parentSession 指向它）',
    children.some((ch) => ch.header.parentSession === c3?.id),
    JSON.stringify(children.map((ch) => ch.header.parentSession)),
  );

  console.log('\n[4] 收尾');
  for (const r of results) await client.callTool('dsh_release', { conversation_id: r.id, forget: true });
  check('全部释放', true);
  console.log(`    总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-30).join('\n'));
} finally {
  await client.close();
  try { rmSync(STATE, { force: true }); } catch {}
  if (!process.env.DSH_MCP_KEEP_WS) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  } else {
    console.log(`工作区保留在: ${root}`);
  }
}

console.log(`\n===== 能力测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);