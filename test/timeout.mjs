/**
 * 超时语义与"说谎"回归测试。
 *
 * 背景（真实事故）：旧实现在 `wait=false` 时也套了 prompt 超时，且超时只本地 reject、
 * 同时把 busy 置 false —— 等于**谎报回合结束**：结果丢了、token 照烧、reaper 还会因此
 * 杀掉正在干活的进程（回合变 interrupted，会话此后 resume 失败而永久卡死）。
 *
 * 本文件守住新语义：
 *   [1] ★ wait=false 完全不受 timeout_ms 影响（关键回归：以前 2s 就会把长任务判死）
 *   [2] ★ wait=true 等超时 → B 方案：不报错、不取消，返回收据；busy 保持 true（不说谎）；
 *       哨兵随后照常落地，结果拿得到
 *   [3] timeout_ms=0 = 一直等，正常拿完整结果
 *   [4] 忙时再派活 → 给我们自己的清晰错误（绝不是 "Internal error"）
 *   [5] ★ resume 失败 → 清晰错误 + **作废进程**（alive=false），重派会重建而非永久卡死
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from './mcp-client.mjs';
import { purgeTestSessions } from '../src/workspace.mjs';

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

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-mcp-timeout-'));
const STATE = join(ROOT, 'state.json');
const ws = (n) => {
  const d = join(ROOT, n);
  mkdirSync(d, { recursive: true });
  return d;
};

/**
 * 约 12 秒的多步任务：只要**明显长于**我们故意设的小超时（2s / 5s）即可，
 * 不必真等很久 —— 测试要证明的是"小超时不会杀死任务"，不是"等它超时"。
 */
const LONG = '请依次运行 2 次命令 Start-Sleep -Seconds 5，每次跑完汇报第几次，全部跑完回复"完成"。';

async function waitForFile(file, deadlineMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (existsSync(file)) return Date.now() - t0;
    await sleep(1000);
  }
  return -1;
}
const readSentinel = (f) => JSON.parse(readFileSync(f, 'utf8'));

const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();
const convs = [];

try {
  await client.initialize();
  const a = await client.callTool('dsh_start', { cwd: ws('A'), permission: 'danger-full-access' }, 180_000);
  const convA = a?.structuredContent?.conversation_id;
  convs.push(convA);
  check('会话 A 已建', !!convA, McpClient.text(a).slice(0, 140));

  // ── [1] ★ wait=false 不受 timeout_ms 影响 ────────────────────
  console.log('\n[1] ★ wait=false 完全不受 timeout_ms 影响（旧实现 2s 就会判死）');
  const t1 = Date.now();
  const bg = await client.callTool(
    'dsh_send',
    { conversation_id: convA, prompt: LONG, wait: false, timeout_ms: 2000 },
    120_000,
  );
  const took1 = Date.now() - t1;
  const bgS = bg?.structuredContent ?? {};
  check('立即返回收据（未阻塞）', took1 < 60_000, `用了 ${took1}ms`);
  check('不是错误', bg?.isError !== true, McpClient.text(bg).slice(0, 200));
  check('拿到 run_id 与哨兵路径', !!bgS.run_id && !!bgS.sentinel_file, JSON.stringify(bgS));
  check('哨兵此刻尚未落地', !existsSync(bgS.sentinel_file));
  console.log(`    调用耗时 ${took1}ms（含冷启动 resume）`);

  // 立刻检查：回合确实在跑（busy 是真的）
  const st1 = await client.callTool('dsh_status', { conversation_id: convA });
  check('回合确实在跑', st1?.structuredContent?.state === 'running', McpClient.text(st1).slice(0, 160));

  // ── [4] 忙时再派活 → 清晰错误 ────────────────────────────────
  console.log('\n[4] 忙时再派活 → 给我们自己的清晰错误');
  const busy = await client.callTool('dsh_send', { conversation_id: convA, prompt: '再来一个' }, 60_000);
  const busyText = McpClient.text(busy);
  check('被拒绝', busy?.isError === true, busyText.slice(0, 200));
  check('★ 错误不是 "Internal error"', !/Internal error/i.test(busyText), busyText.slice(0, 200));
  check('给出了可行出路', /dsh_interject|dsh_interrupt/.test(busyText), busyText.slice(0, 240));

  // ── [1 续] 哨兵在远超 2s 之后才落地，且是成功 ────────────────
  console.log('\n[1 续] 哨兵远晚于 timeout_ms 才落地 —— 且必须是成功，不是超时失败');
  const waited1 = await waitForFile(bgS.sentinel_file, 300_000);
  check('哨兵最终落地', waited1 >= 0, `waited=${waited1}ms`);
  check('★ 落地时间远超 timeout_ms=2000', waited1 > 2500, `waited=${waited1}ms`);
  const doc1 = existsSync(bgS.sentinel_file) ? readSentinel(bgS.sentinel_file) : null;
  check('★ status=done（旧实现这里会是 error/超时）', doc1?.status === 'done', JSON.stringify(doc1?.status));
  check('拿到了真实正文', typeof doc1?.result?.answer === 'string' && doc1.result.answer.length > 0, JSON.stringify(doc1?.result?.answer?.slice(0, 80)));
  check('stop_reason=end_turn', doc1?.result?.stop_reason === 'end_turn', String(doc1?.result?.stop_reason));
  console.log(`    哨兵在 ${(waited1 / 1000).toFixed(1)}s 后落地，status=${doc1?.status}`);

  // ── [2] ★ wait=true 等超时 → B 方案 ─────────────────────────
  console.log('\n[2] ★ wait=true 等超时 → 收据（不报错、不取消、busy 不说谎）');
  const t2 = Date.now();
  const waitRes = await client.callTool(
    'dsh_send',
    { conversation_id: convA, prompt: LONG, wait: true, timeout_ms: 5000 },
    180_000,
  );
  const took2 = Date.now() - t2;
  const wS = waitRes?.structuredContent ?? {};
  check('按 timeout_ms 返回（约 5s）', took2 >= 4800 && took2 < 60_000, `用了 ${took2}ms`);
  check('★ 不是错误', waitRes?.isError !== true, McpClient.text(waitRes).slice(0, 240));
  check('★ 返回 still_running 收据', wS.still_running === true, JSON.stringify(wS).slice(0, 240));
  check('收据含 run_id / sentinel_file / posix 路径', !!wS.run_id && !!wS.sentinel_file && !!wS.sentinel_file_posix, JSON.stringify(wS).slice(0, 240));
  check('文案说明回合未被取消', /没有被取消/.test(McpClient.text(waitRes)), McpClient.text(waitRes).slice(0, 200));

  const st2 = await client.callTool('dsh_status', { conversation_id: convA });
  check('★ busy 保持 true（不再谎报空闲）', st2?.structuredContent?.state === 'running', McpClient.text(st2).slice(0, 200));
  const g2 = await client.callTool('dsh_get', { conversation_id: convA, run_id: wS.run_id });
  check('★ run 记录状态是 running（不是 error）', g2?.structuredContent?.run?.status === 'running', JSON.stringify(g2?.structuredContent?.run?.status));

  const waited2 = await waitForFile(wS.sentinel_file, 300_000);
  check('降级为后台后哨兵照常落地', waited2 >= 0, `waited=${waited2}ms`);
  const doc2 = existsSync(wS.sentinel_file) ? readSentinel(wS.sentinel_file) : null;
  check('★ 降级后仍拿到成功结果', doc2?.status === 'done' && (doc2?.result?.answer?.length ?? 0) > 0, `${doc2?.status} ans=${doc2?.result?.answer?.length}`);
  const st2b = await client.callTool('dsh_status', { conversation_id: convA });
  check('回合真结束后回到 idle', st2b?.structuredContent?.state === 'idle', McpClient.text(st2b).slice(0, 160));

  // ── [3] timeout_ms=0 = 一直等 ───────────────────────────────
  console.log('\n[3] timeout_ms=0 → 一直等，拿完整结果');
  const r3 = await client.callTool(
    'dsh_send',
    { conversation_id: convA, prompt: '只回复两个字：好的', wait: true, timeout_ms: 0 },
    300_000,
  );
  check('返回完整结果而非收据', r3?.structuredContent?.still_running !== true, JSON.stringify(r3?.structuredContent ?? {}).slice(0, 200));
  check('stop_reason=end_turn', r3?.structuredContent?.stop_reason === 'end_turn', String(r3?.structuredContent?.stop_reason));
  check('有正文', (r3?.structuredContent?.answer?.length ?? 0) > 0, JSON.stringify(r3?.structuredContent?.answer));

  // ── [5] ★ resume 失败 → 作废进程，不永久卡死 ─────────────────
  console.log('\n[5] ★ resume 失败 → 清晰错误 + 作废进程（重派会重建，不会永久卡死）');
  const b = await client.callTool('dsh_start', { cwd: ws('B'), permission: 'danger-full-access' }, 180_000);
  const convB = b?.structuredContent?.conversation_id;
  convs.push(convB);
  await client.callTool('dsh_send', { conversation_id: convB, prompt: '只回复：在', wait: true, timeout_ms: 0 }, 300_000);
  await client.callTool('dsh_release', { conversation_id: convB });
  // 把这条会话从磁盘上删掉，再派活 → resume 必然失败
  purgeTestSessions({ ids: [convB] });
  check('会话文件已删除（构造 resume 失败）', true);

  const bad1 = await client.callTool('dsh_send', { conversation_id: convB, prompt: '随便', wait: false }, 180_000);
  const bad1Text = McpClient.text(bad1);
  check('★ 报的是"恢复会话失败"而非笼统错误', /恢复会话失败/.test(bad1Text), bad1Text.slice(0, 300));
  check('★ 明确告知已作废进程', /作废/.test(bad1Text), bad1Text.slice(0, 300));
  const stB = await client.callTool('dsh_status', { conversation_id: convB });
  check('★ 进程已被作废（alive=false），不会留下半死进程', stB?.structuredContent?.alive === false, McpClient.text(stB).slice(0, 200));

  const bad2 = await client.callTool('dsh_send', { conversation_id: convB, prompt: '随便', wait: false }, 180_000);
  check('★ 重派会重新尝试（仍是清晰错误，没有永久卡死）', /恢复会话失败/.test(McpClient.text(bad2)), McpClient.text(bad2).slice(0, 240));
  const stB2 = await client.callTool('dsh_status', { conversation_id: convB });
  check('重派后依然不留半死进程', stB2?.structuredContent?.alive === false, McpClient.text(stB2).slice(0, 200));

  console.log('\n[6] 收尾');
  for (const id of convs) await client.callTool('dsh_release', { conversation_id: id, forget: true });
  check('已释放', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-30).join('\n'));
} finally {
  await client.close();
  purgeTestSessions({ tempOnly: true });
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
}

console.log(`\n===== 超时语义测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);