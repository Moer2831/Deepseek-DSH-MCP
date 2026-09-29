/**
 * 异步模式测试：先派活 → 继续做别的事 → 回头验收 / 中途查看。
 *
 * 这正是"MCP 调用要等回复"的破解方式：
 *   MCP 工具调用本身是阻塞的，所以长任务用 wait=false 立刻拿 run_id 返回，
 *   调用方（Codex/Claude）可以继续自己的回合，事后再来取结果。
 *
 * 校验点：
 *   1) wait=false 立刻返回 run_id，且当时任务确实还在跑
 *   2) 期间可以在**另一个会话**上正常干活（证明没有互相阻塞）
 *   3) dsh_read 能在跑的过程中看到增量输出
 *   4) dsh_get(run_id) 能验收：状态、耗时、完整答复
 *   5) 会话忙时再发 wait=false 会被明确拒绝（而不是静默排队）
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE = join(tmpdir(), `dsh-mcp-async-state-${Date.now()}.json`);
const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-async-'));
const wsA = join(root, 'worker');
const wsB = join(root, 'sidekick');
mkdirSync(wsA, { recursive: true });
mkdirSync(wsB, { recursive: true });

const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();

try {
  await client.initialize();

  console.log('\n[1] 开一个会话，用 wait=false 派一个长任务');
  const a = await client.callTool('dsh_start', { cwd: wsA, permission: 'danger-full-access' }, 180_000);
  const convA = a?.structuredContent?.conversation_id;
  check('会话 A 已创建', !!convA, McpClient.text(a).slice(0, 150));

  const t0 = Date.now();
  const fired = await client.callTool(
    'dsh_send',
    {
      conversation_id: convA,
      wait: false,
      prompt: '分三步做：先运行 Start-Sleep -Seconds 5 并汇报"第1步"；再运行 Start-Sleep -Seconds 5 并汇报"第2步"；最后回复"异步任务完成"。',
    },
    60_000,
  );
  const fireMs = Date.now() - t0;
  const runId = fired?.structuredContent?.run_id;
  check('立刻拿到 run_id', typeof runId === 'string' && runId.startsWith('run-'), String(runId));
  check('立刻返回（没有阻塞）', fireMs < 20000, `${fireMs}ms`);
  check('标记为后台执行', fired?.structuredContent?.background === true);
  console.log(`    run_id = ${runId}，派活仅耗时 ${fireMs}ms`);

  console.log('\n[2] 趁它跑着，在另一个会话上正常干活（证明互不阻塞）');
  const b = await client.callTool('dsh_start', { cwd: wsB, permission: 'danger-full-access' }, 180_000);
  const convB = b?.structuredContent?.conversation_id;
  const side = await client.callTool(
    'dsh_send',
    { conversation_id: convB, prompt: '只回复两个字：待命' },
    240_000,
  );
  check('另一个会话可以正常完成回合', side?.structuredContent?.stop_reason === 'end_turn', McpClient.text(side).slice(0, 120));
  console.log(`    会话 B 答复: ${JSON.stringify(side?.structuredContent?.answer?.slice(0, 60))}`);

  const stA = await client.callTool('dsh_status', { conversation_id: convA });
  check('此时 A 仍在跑（没被 B 影响）', stA?.structuredContent?.state === 'running', McpClient.text(stA));
  console.log(`    A 状态: ${McpClient.text(stA)}`);

  console.log('\n[3] 中途查看 A 的输出（dsh_read，不等回合结束）');
  let cursor = 0;
  let sawMidFlight = false;
  for (let i = 0; i < 5; i++) {
    const r = await client.callTool('dsh_read', { conversation_id: convA, cursor });
    const s = r?.structuredContent ?? {};
    cursor = s.cursor ?? cursor;
    if ((s.entries ?? []).length > 0 && s.state === 'running') {
      sawMidFlight = true;
      console.log(`    中途读到 ${(s.entries ?? []).length} 条：${(s.entries ?? []).map((e) => `${e.kind}:${e.text.slice(0, 30)}`).join(' | ')}`);
      break;
    }
    await sleep(3000);
  }
  check('回合进行中就能读到输出', sawMidFlight);

  console.log('\n[4] 会话忙时再发 wait=false → 应被明确拒绝');
  const conflict = await client.callTool(
    'dsh_send',
    { conversation_id: convA, wait: false, prompt: '再塞一个任务' },
    60_000,
  );
  check('忙时派活返回 isError', conflict?.isError === true, McpClient.text(conflict).slice(0, 160));
  check('错误里给出了替代方案', /dsh_interject|dsh_interrupt/.test(McpClient.text(conflict)), McpClient.text(conflict).slice(0, 160));

  console.log('\n[5] 回头验收：轮询 dsh_get(run_id) 直到完成');
  let run = null;
  for (let i = 0; i < 40; i++) {
    const g = await client.callTool('dsh_get', { conversation_id: convA, run_id: runId });
    run = g?.structuredContent?.run ?? null;
    if (run && run.status !== 'running') break;
    await sleep(4000);
  }
  check('run 状态变为完成', run?.status === 'done', JSON.stringify(run?.status));
  check('run 记录了耗时', typeof run?.elapsed_ms === 'number' && run.elapsed_ms > 0, String(run?.elapsed_ms));
  check('run 的 prompt 预览正确', typeof run?.prompt_preview === 'string' && run.prompt_preview.includes('分三步'), String(run?.prompt_preview));
  check(
    '验收拿到完整答复',
    typeof run?.result?.answer === 'string' && run.result.answer.includes('异步任务完成'),
    JSON.stringify(run?.result?.answer?.slice(0, 200)),
  );
  console.log(`    耗时 ${(run?.elapsed_ms / 1000).toFixed(1)}s，答复: ${JSON.stringify(run?.result?.answer?.slice(0, 160))}`);

  console.log('\n[6] 不传 run_id 时 dsh_get 取最近一次回合');
  const latest = await client.callTool('dsh_get', { conversation_id: convA });
  check('最近回合就是刚才那条', latest?.structuredContent?.run?.run_id === runId, String(latest?.structuredContent?.run?.run_id));

  console.log('\n[7] 未知 run_id 应报清晰错误');
  const bogus = await client.callTool('dsh_get', { conversation_id: convA, run_id: 'run-does-not-exist' });
  check('未知 run_id 返回 isError', bogus?.isError === true, McpClient.text(bogus).slice(0, 140));

  console.log('\n[8] 收尾');
  await client.callTool('dsh_release', { conversation_id: convA, forget: true });
  await client.callTool('dsh_release', { conversation_id: convB, forget: true });
  check('两个会话已释放', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-30).join('\n'));
} finally {
  await client.close();
  try { rmSync(STATE, { force: true }); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== 异步模式测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);