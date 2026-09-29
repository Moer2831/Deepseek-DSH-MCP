/**
 * 工作区是否"真有效"的实测（与 GUI 显示无关）。
 *
 * 设计：
 *   1) 桌面建两个文件夹，用 MCP 各开一个会话（cwd 指向该文件夹）
 *   2) 派活时**不给任何路径**，逼 agent 使用自己的工作目录：
 *        a. 打印自己当前工作目录的绝对路径（第一重证据：它以为自己在哪）
 *        b. 在当前工作目录下写一个文件（第二重证据：文件实际落在哪）
 *   3) 读回磁盘核对，并确认文件**没有**漏到别处（服务器 cwd / 家目录 / 临时目录 / 另一个工作区）
 *
 * 用唯一文件名，这样"搜索候选目录"这个检查才有意义。
 */

import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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

const DESKTOP = join(homedir(), 'Desktop');
const STAMP = Date.now().toString(36);
const JOBS = [
  { key: 'A', dir: join(DESKTOP, 'dsh-mcp-test-A'), file: `probe-a-${STAMP}.txt`, marker: `MARKER-A-${STAMP}` },
  { key: 'B', dir: join(DESKTOP, 'dsh-mcp-test-B'), file: `probe-b-${STAMP}.txt`, marker: `MARKER-B-${STAMP}` },
];
const STATE = join(tmpdir(), `dsh-mcp-wseff-state-${STAMP}.json`);

const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();
const convs = [];

try {
  await client.initialize();

  console.log('\n[1] 桌面建两个文件夹，各开一个会话');
  for (const j of JOBS) {
    mkdirSync(j.dir, { recursive: true });
    const start = await client.callTool('dsh_start', { cwd: j.dir, permission: 'danger-full-access' }, 180_000);
    const id = start?.structuredContent?.conversation_id;
    convs.push({ ...j, id });
    check(`会话 ${j.key} 已建，cwd=${j.dir}`, !!id && start?.structuredContent?.cwd === j.dir, McpClient.text(start).slice(0, 160));
  }

  console.log('\n[2] 派活：不给路径，让它用自己的工作目录');
  const sends = await Promise.all(
    convs.map((j) =>
      client
        .callTool(
          'dsh_send',
          {
            conversation_id: j.id,
            prompt:
              '请做两件事，**不要向我询问任何路径**：\n' +
              '1. 运行一条命令，打印你**当前工作目录**的绝对路径，并把输出原样贴出来。\n' +
              `2. 就在你**当前工作目录**下创建文件 ${j.file}，内容写成一行：${j.marker}\n` +
              '最后用三行内汇报。',
            timeout_ms: 600_000,
          },
          660_000,
        )
        .then((r) => ({ j, s: r?.structuredContent ?? {} }))
        .catch((e) => ({ j, s: { error: e.message, stop_reason: 'error' } })),
    ),
  );

  for (const { j, s } of sends) {
    console.log(`\n── 会话 ${j.key} ──`);
    console.log(`  stop=${s.stop_reason} 工具=${[...new Set((s.tools_used ?? []).map((t) => t.name ?? t.title))].join(', ')}`);
    console.log(`  答复: ${JSON.stringify((s.answer ?? '').slice(0, 300))}`);
    check(`会话 ${j.key} 回合正常结束`, s.stop_reason === 'end_turn', `stop=${s.stop_reason} err=${s.error ?? ''}`);
  }

  console.log('\n[3] 第一重证据：agent 自报的当前工作目录');
  for (const { j, s } of sends) {
    const ans = s.answer ?? '';
    const norm = (x) => x.replace(/[\\/]+/g, '\\').toLowerCase();
    check(
      `会话 ${j.key} 自报的当前目录就是它的工作区`,
      norm(ans).includes(norm(j.dir)),
      `期望包含 ${j.dir}；实际答复: ${JSON.stringify(ans.slice(0, 260))}`,
    );
  }

  console.log('\n[4] 第二重证据：文件是否真的落在该工作区');
  for (const j of convs) {
    const p = join(j.dir, j.file);
    const ok = existsSync(p);
    check(`文件确实出现在 ${j.dir}`, ok, p);
    if (ok) {
      const content = readFileSync(p, 'utf8');
      check(`会话 ${j.key} 文件内容正确`, content.includes(j.marker), JSON.stringify(content.slice(0, 120)));
    }
  }

  console.log('\n[5] 反向检查：每个会话的文件只应出现在自己的工作区');
  // 注意：不能笼统地"在另一个工作区里找两个文件"——B 的文件本来就该在 B 里。
  // 正确做法是：对每个会话的文件，检查所有「不属于它的」目录。
  const foreignDirs = (j) => [
    { label: 'MCP 服务自己的工作目录', dir: process.cwd() },
    { label: '用户家目录', dir: homedir() },
    { label: '系统临时目录', dir: tmpdir() },
    { label: '另一个工作区', dir: JOBS.find((o) => o.key !== j.key).dir },
  ];
  for (const j of convs) {
    for (const cand of foreignDirs(j)) {
      check(
        `会话 ${j.key} 的文件未泄漏到「${cand.label}」`,
        !existsSync(join(cand.dir, j.file)),
        join(cand.dir, j.file),
      );
    }
  }

  console.log('\n[6] 交叉检查：两个会话没有互相写错目录');
  check('A 的文件不在 B 的工作区', !existsSync(join(JOBS[1].dir, JOBS[0].file)));
  check('B 的文件不在 A 的工作区', !existsSync(join(JOBS[0].dir, JOBS[1].file)));

  console.log('\n[7] dsh_get 回报的 cwd 与预期一致');
  for (const j of convs) {
    const g = await client.callTool('dsh_get', { conversation_id: j.id });
    check(`会话 ${j.key} dsh_get.cwd 正确`, g?.structuredContent?.cwd === j.dir, String(g?.structuredContent?.cwd));
    check(
      `会话 ${j.key} 工作区登记状态 = ${g?.structuredContent?.workspace_registered}`,
      typeof g?.structuredContent?.workspace_registered === 'boolean',
    );
  }

  console.log('\n[8] 收尾（保留文件作为证据，只释放会话进程）');
  for (const j of convs) await client.callTool('dsh_release', { conversation_id: j.id });
  console.log(`    证据文件保留在:`);
  for (const j of convs) console.log(`      ${join(j.dir, j.file)}`);
  console.log(`    清理命令: node bin/dsh-mcp-workspaces.mjs --purge-test-sessions`);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-30).join('\n'));
} finally {
  await client.close();
  try { rmSync(STATE, { force: true }); } catch {}
}

console.log(`\n===== 工作区有效性测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);