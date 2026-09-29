/**
 * 集成测试：真实调用 LLM，验证端到端行为。
 *
 *   [1] 建会话并派一个极短任务（验证 prompt 通路 + 思考默认隐藏）
 *   [2] 释放进程 → 再派任务 → 触发 ACP session/resume
 *       并验证"记忆没丢"（这是 ACP 架构相对 SDK 协议的核心价值）
 *   [3] 中断一个正在跑的回合（验证 session/cancel 真的能停）
 *   [4] 中断后会话仍可正常继续（验证中断不会损坏会话）
 *
 * 会消耗少量 token。用 DSH_MCP_TEST_CWD 指定工作区，默认用临时目录。
 */

import { mkdtempSync, rmSync } from 'node:fs';
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

const STATE = join(tmpdir(), `dsh-mcp-int-state-${Date.now()}.json`);
const ws = process.env.DSH_MCP_TEST_CWD ?? mkdtempSync(join(tmpdir(), 'dsh-mcp-int-ws-'));
const ownWs = !process.env.DSH_MCP_TEST_CWD;

console.log(`工作区: ${ws}`);
const client = new McpClient({ env: { DSH_MCP_STATE: STATE, DSH_MCP_LOG: 'info' } }).start();
let convId = null;

try {
  await client.initialize();

  // ── [1] 建会话 + 极短任务 ─────────────────────────────────
  console.log('\n[1] 建会话并派任务（验证 prompt 通路）');
  const start = await client.callTool('dsh_start', { cwd: ws, permission: 'danger-full-access' }, 120_000);
  convId = start?.structuredContent?.conversation_id;
  check('建会话成功', !!convId);
  console.log(`    conversation_id = ${convId}`);

  const secret = '紫色河马';
  const r1 = await client.callTool(
    'dsh_send',
    { conversation_id: convId, prompt: `请记住这个暗号：${secret}。然后只回复两个字：收到`, timeout_ms: 180_000 },
    200_000,
  );
  const s1 = r1?.structuredContent ?? {};
  check('回合正常结束', s1.stop_reason && s1.stop_reason !== 'error', `stop=${s1.stop_reason} err=${s1.error}`);
  check('拿到了正文输出', typeof s1.answer === 'string' && s1.answer.trim().length > 0, JSON.stringify(s1.answer)?.slice(0, 200));
  check('默认隐藏思考：structured.thinking 为空', !s1.thinking || s1.thinking === '');
  check('提供了思考统计', !!s1.thinking_stats, JSON.stringify(s1.thinking_stats));
  check('返回里没有泄漏思考内容字段', !McpClient.text(r1).includes('--- 思考内容 ---'));
  console.log(`    答复: ${JSON.stringify(s1.answer?.slice(0, 120))}`);
  console.log(`    思考统计: ${JSON.stringify(s1.thinking_stats)}`);

  // ── [2] 释放 → 再派活 → resume + 记忆 ─────────────────────
  console.log('\n[2] 释放进程后继续对话（验证 ACP resume 与记忆）');
  await client.callTool('dsh_release', { conversation_id: convId });
  const afterRelease = await client.callTool('dsh_get', { conversation_id: convId });
  check('释放后进程未运行', afterRelease?.structuredContent?.alive === false);

  const r2 = await client.callTool(
    'dsh_send',
    { conversation_id: convId, prompt: '刚才我让你记的暗号是什么？只回复暗号本身，不要别的字。', timeout_ms: 180_000 },
    200_000,
  );
  const s2 = r2?.structuredContent ?? {};
  check('resume 后回合正常结束', s2.stop_reason && s2.stop_reason !== 'error', `stop=${s2.stop_reason} err=${s2.error}`);
  check(
    `resume 后仍记得暗号（"${secret}"）`,
    typeof s2.answer === 'string' && s2.answer.includes(secret),
    `实际答复: ${JSON.stringify(s2.answer?.slice(0, 200))}`,
  );
  const afterResume = await client.callTool('dsh_get', { conversation_id: convId });
  const serverLog = client.stderr.join('\n');
  check('开启 info 日志后能看到 resume 记录（同时验证日志分级可用）', serverLog.includes('已 resume'));

  // ── [3] 中断一个正在跑的回合 ──────────────────────────────
  console.log('\n[3] 中断正在跑的回合（验证 session/cancel）');
  const longPrompt =
    '请执行一个耗时任务：连续运行 5 次命令 Start-Sleep -Seconds 6（每次间隔即可，不要用一条命令串起来），' +
    '每次都汇报第几次，全部跑完后回复"全部完成"。';
  const bg = await client.callTool('dsh_send', { conversation_id: convId, prompt: longPrompt, wait: false }, 60_000);
  check('后台任务已接受', bg?.structuredContent?.background === true);

  await sleep(9000); // 让 DSH 真正开始干活
  const st = await client.callTool('dsh_status', { conversation_id: convId });
  console.log(`    中断前状态: ${McpClient.text(st)}`);
  check('中断前会话处于忙碌', st?.structuredContent?.busy === true, McpClient.text(st));

  const int = await client.callTool('dsh_interrupt', { conversation_id: convId });
  check('中断请求被接受', int?.structuredContent?.interrupted === true, McpClient.text(int));

  await sleep(6000);
  const st2 = await client.callTool('dsh_status', { conversation_id: convId });
  console.log(`    中断后状态: ${McpClient.text(st2)}`);
  check('中断后不再忙碌', st2?.structuredContent?.busy === false, McpClient.text(st2));

  const getAfterInt = await client.callTool('dsh_get', { conversation_id: convId });
  const last = getAfterInt?.structuredContent;
  console.log(`    待决审批: ${JSON.stringify(last?.pending_approvals)}`);

  // ── [4] 中断后会话仍健康 ──────────────────────────────────
  console.log('\n[4] 中断后会话仍可继续（验证中断不损坏会话）');
  const r4 = await client.callTool(
    'dsh_send',
    { conversation_id: convId, prompt: '只回复两个字：正常', timeout_ms: 180_000 },
    200_000,
  );
  const s4 = r4?.structuredContent ?? {};
  check('中断后新回合正常结束', s4.stop_reason && s4.stop_reason !== 'error', `stop=${s4.stop_reason} err=${s4.error}`);
  check('中断后仍能拿到正文', typeof s4.answer === 'string' && s4.answer.trim().length > 0, JSON.stringify(s4.answer?.slice(0, 120)));
  console.log(`    答复: ${JSON.stringify(s4.answer?.slice(0, 120))}`);

  // ── [5] 插话：打断并改口 ──────────────────────────────────
  console.log('\n[5] 插话 interject（打断当前回合并立刻改口）');
  const longPrompt2 =
    '请执行一个耗时任务：连续运行 4 次命令 Start-Sleep -Seconds 8，每次汇报第几次，全部跑完后回复"全部完成"。';
  const bg2 = await client.callTool(
    'dsh_send',
    { conversation_id: convId, prompt: longPrompt2, wait: false },
    60_000,
  );
  check('后台长任务已接受', bg2?.structuredContent?.background === true);
  await sleep(11000); // 让它跑到一半
  const stB = await client.callTool('dsh_status', { conversation_id: convId });
  check('插话前会话处于忙碌', stB?.structuredContent?.busy === true, McpClient.text(stB));

  const inj = await client.callTool(
    'dsh_interject',
    { conversation_id: convId, message: '停一下，别继续了。只回复两个字：改口', mode: 'interject' },
    300_000,
  );
  const si = inj?.structuredContent ?? {};
  check('interject 模式生效', si.interjected === 'interject', JSON.stringify(si.interjected));
  check('记录了打断收敛耗时', typeof si.waited_ms === 'number' && si.waited_ms > 0, String(si.waited_ms));
  check(
    '打断得快（没有等长任务自己跑完）',
    typeof si.waited_ms === 'number' && si.waited_ms < 25000,
    `waited=${si.waited_ms}ms，长任务本身需要 ~32s+`,
  );
  check('插话后的新回合正常结束', si.stop_reason && si.stop_reason !== 'error', `stop=${si.stop_reason} err=${si.error}`);
  check(
    'DSH 按新指令回应',
    typeof si.answer === 'string' && si.answer.includes('改口'),
    JSON.stringify(si.answer?.slice(0, 160)),
  );
  console.log(`    答复: ${JSON.stringify(si.answer?.slice(0, 160))}  waited=${si.waited_ms}ms`);

  // ── [6] 插话：排队（不打断） ──────────────────────────────
  console.log('\n[6] 插话 queue（不打断，等本轮跑完接着说）');
  const bg3 = await client.callTool(
    'dsh_send',
    { conversation_id: convId, prompt: '连续运行 3 次命令 Start-Sleep -Seconds 5，每次汇报第几次，全部跑完后回复"排队任务完成"。', wait: false },
    60_000,
  );
  check('第二个后台长任务已接受', bg3?.structuredContent?.background === true);
  await sleep(5000);
  const inj2 = await client.callTool(
    'dsh_interject',
    { conversation_id: convId, message: '刚才那件事做完之后，只回复三个字：接着说', mode: 'queue' },
    400_000,
  );
  const si2 = inj2?.structuredContent ?? {};
  check('queue 模式生效', si2.interjected === 'queue', JSON.stringify(si2.interjected));
  check('queue 确实等了上一轮', typeof si2.waited_ms === 'number' && si2.waited_ms > 1000, String(si2.waited_ms));
  check('queue 后的新回合正常结束', si2.stop_reason && si2.stop_reason !== 'error', `stop=${si2.stop_reason} err=${si2.error}`);
  check(
    'DSH 按新指令回应',
    typeof si2.answer === 'string' && si2.answer.includes('接着说'),
    JSON.stringify(si2.answer?.slice(0, 160)),
  );
  console.log(`    答复: ${JSON.stringify(si2.answer?.slice(0, 160))}  waited=${si2.waited_ms}ms`);

  // ── [7] 收尾 ──────────────────────────────────────────────
  console.log('\n[7] 列表与释放');
  const list = await client.callTool('dsh_list', { cwd: ws });
  check('列表中能找到该会话', (list?.structuredContent?.conversations ?? []).some((c) => c.conversation_id === convId));
  const getFinal = await client.callTool('dsh_get', { conversation_id: convId });
  check('最终仍能读到会话详情', getFinal?.structuredContent?.conversation_id === convId);
  console.log(`    最终轮数: ${getFinal?.structuredContent?.turns}`);
  await client.callTool('dsh_release', { conversation_id: convId, forget: true });
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log('--- 服务端最后 30 行日志 ---');
  console.log(client.stderr.slice(-30).join('\n'));
} finally {
  await client.close();
  try {
    rmSync(STATE, { force: true });
  } catch {}
  if (ownWs) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {}
  }
}

console.log(`\n===== 集成测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);