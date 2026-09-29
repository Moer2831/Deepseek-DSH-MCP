/**
 * 异步完成哨兵测试。
 *
 * 哨兵是本项目把"跑完通知"落到文件系统的那一环，语义微妙，必须有覆盖：
 *   [1] wait=false 返回 sentinel_file（含 Bash 形式路径），且此刻文件**尚不存在**
 *   [2] 用文件系统等待（模拟调用方的后台任务）→ 回合结束后文件出现
 *   [3] 文件内容正确：原子可解析、status=done、含最终结果
 *   [4] ★ 隐私：即使请求了 reasoning=full，哨兵里也**不含思考内容**
 *        （同一 run 在内存里（dsh_get）仍能看到思考 —— 保证只作用于落盘）
 *   [5] 闩锁语义：文件写一次就一直在，晚来的等待方立刻为真
 *   [6] 同一会话的第二个 run 用不同路径，且旧文件不被覆盖
 *   [7] 多会话并发不串台：两个会话各自一个哨兵，路径与内容都不混淆
 *   [8] 非正常终止也落哨兵：打断（cancelled）同样写出，等待方不会永久挂住
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-mcp-sentinel-'));
const STATE = join(ROOT, 'state.json');
const RUNS_DIR = join(ROOT, 'runs');
const ws = (n) => {
  const d = join(ROOT, n);
  mkdirSync(d, { recursive: true });
  return d;
};

/** 模拟调用方的后台等待任务：轮询文件出现，返回耗时（超时返回 -1）。 */
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

try {
  await client.initialize();

  // ── [1] 派活拿哨兵路径，此刻文件不应存在 ────────────────────
  console.log('\n[1] wait=false 返回哨兵路径（文件此时尚不存在）');
  const a = await client.callTool('dsh_start', { cwd: ws('A'), permission: 'danger-full-access' }, 180_000);
  const convA = a?.structuredContent?.conversation_id;
  check('会话 A 已建', !!convA, McpClient.text(a).slice(0, 140));

  // 这题会逼出真实思考内容，用来验证 [4] 的隐私剥离
  const puzzle =
    '请一步步推理再回答：笼子里有鸡和兔共 35 个头、94 只脚，各几只？先写推理过程，最后一行只写答案。';
  const fireA = await client.callTool(
    'dsh_send',
    { conversation_id: convA, prompt: puzzle, wait: false, reasoning: 'full' },
    60_000,
  );
  const sA = fireA?.structuredContent ?? {};
  check('返回 run_id', typeof sA.run_id === 'string' && sA.run_id.startsWith('run-'), String(sA.run_id));
  check('返回 sentinel_file', typeof sA.sentinel_file === 'string' && sA.sentinel_file.endsWith('.json'), String(sA.sentinel_file));
  check(
    'sentinel_file 落在 RUNS_DIR 下、按会话分目录',
    sA.sentinel_file === join(RUNS_DIR, convA, `${sA.run_id}.json`),
    `${sA.sentinel_file}  vs  ${join(RUNS_DIR, convA, `${sA.run_id}.json`)}`,
  );
  check('提供了 Bash 形式路径 sentinel_file_posix', typeof sA.sentinel_file_posix === 'string' && !sA.sentinel_file_posix.includes('\\'), String(sA.sentinel_file_posix));
  check('★ 此刻哨兵文件还不存在', !existsSync(sA.sentinel_file), sA.sentinel_file);

  // ── [2] 用文件系统等待完成 ──────────────────────────────────
  console.log('\n[2] 用文件系统等待（模拟调用方后台任务）');
  const waited = await waitForFile(sA.sentinel_file, 300_000);
  check('哨兵在超时前出现', waited >= 0, `waited=${waited}ms`);
  console.log(`    文件在 ${(waited / 1000).toFixed(1)}s 后出现`);

  // ── [3] 内容正确 ────────────────────────────────────────────
  console.log('\n[3] 哨兵内容');
  let doc = null;
  try {
    doc = readSentinel(sA.sentinel_file);
    check('原子可解析为合法 JSON', true);
  } catch (e) {
    check('原子可解析为合法 JSON', false, e.message);
  }
  check('conversation_id 正确', doc?.conversation_id === convA, String(doc?.conversation_id));
  check('run_id 正确', doc?.run_id === sA.run_id, String(doc?.run_id));
  check('status=done', doc?.status === 'done', String(doc?.status));
  check('含最终正文', typeof doc?.result?.answer === 'string' && doc.result.answer.length > 0, JSON.stringify(doc?.result?.answer?.slice(0, 120)));
  check('含思考统计', !!doc?.result?.thinking_stats, JSON.stringify(doc?.result?.thinking_stats));

  // ── [4] ★ 隐私：哨兵不含思考内容 ────────────────────────────
  console.log('\n[4] ★ 隐私：请求了 reasoning=full，但哨兵里不含思考内容');
  const sentinelRaw = readFileSync(sA.sentinel_file, 'utf8');
  check('哨兵里没有 thinking 字段', doc?.result?.thinking === undefined, JSON.stringify(doc?.result?.thinking)?.slice(0, 120));
  check('标记了 thinking_omitted', doc?.result?.thinking_omitted === true, JSON.stringify(doc?.result?.thinking_omitted));
  check('哨兵原文里找不到被剥离的思考串', !/thinking":"[^"]{40,}/.test(sentinelRaw), sentinelRaw.slice(0, 200));
  console.log(`    内存里的思考统计: ${JSON.stringify(doc?.result?.thinking_stats)}`);

  // 同一 run 在内存里仍能看到思考（保证只作用于落盘）
  const g = await client.callTool('dsh_get', { conversation_id: convA, run_id: sA.run_id });
  const memThinking = g?.structuredContent?.run?.result?.thinking;
  check(
    '★ 同一 run 在内存（dsh_get）里仍能看到思考内容',
    typeof memThinking === 'string' && memThinking.length > 0,
    `len=${memThinking?.length}`,
  );
  console.log(`    内存里的思考长度: ${memThinking?.length}`);

  // ── [5] 闩锁语义 ────────────────────────────────────────────
  console.log('\n[5] 闩锁：晚到的等待方立刻看到文件');
  const lateWaited = await waitForFile(sA.sentinel_file, 3000);
  check('晚到的等待方立即为真（<2s）', lateWaited >= 0 && lateWaited < 2000, `${lateWaited}ms`);
  check('重复读取内容一致', JSON.stringify(readSentinel(sA.sentinel_file)) === JSON.stringify(doc));

  // ── [6] 同一会话第二个 run 用不同路径 ───────────────────────
  console.log('\n[6] 同一会话的下一个 run');
  const fireB = await client.callTool('dsh_send', { conversation_id: convA, prompt: '只回复两个字：好的', wait: false }, 60_000);
  const sB = fireB?.structuredContent ?? {};
  check('第二个 run 的 run_id 不同', sB.run_id !== sA.run_id, `${sA.run_id} vs ${sB.run_id}`);
  check('第二个 run 的哨兵路径不同', sB.sentinel_file !== sA.sentinel_file);
  await waitForFile(sB.sentinel_file, 300_000);
  check('第二个哨兵也已落地', existsSync(sB.sentinel_file));
  check('第一个哨兵没有被覆盖（闩锁保留）', existsSync(sA.sentinel_file) && readSentinel(sA.sentinel_file).run_id === sA.run_id);

  // ── [7] 多会话并发不串台 ────────────────────────────────────
  console.log('\n[7] 多会话并发：两个会话各写各的哨兵');
  const c = await client.callTool('dsh_start', { cwd: ws('C'), permission: 'danger-full-access' }, 180_000);
  const convC = c?.structuredContent?.conversation_id;
  const [fireC1, fireC2] = await Promise.all([
    client.callTool('dsh_send', { conversation_id: convA, prompt: '只回复：甲', wait: false }, 60_000),
    client.callTool('dsh_send', { conversation_id: convC, prompt: '只回复：乙', wait: false }, 60_000),
  ]);
  const r1 = fireC1?.structuredContent ?? {};
  const r2 = fireC2?.structuredContent ?? {};
  check('两个会话的哨兵目录不同', r1.sentinel_file !== r2.sentinel_file);
  check('路径分别以各自 conversation_id 为目录名', r1.sentinel_file.includes(convA) && r2.sentinel_file.includes(convC));
  await Promise.all([waitForFile(r1.sentinel_file, 300_000), waitForFile(r2.sentinel_file, 300_000)]);
  const d1 = existsSync(r1.sentinel_file) ? readSentinel(r1.sentinel_file) : null;
  const d2 = existsSync(r2.sentinel_file) ? readSentinel(r2.sentinel_file) : null;
  check('两个哨兵都已落地', !!d1 && !!d2);
  check('内容没有串台（各自 conversation_id 正确）', d1?.conversation_id === convA && d2?.conversation_id === convC);
  check(
    '各自正文互不包含对方的标记',
    (d1?.result?.answer ?? '').includes('甲') && !(d1?.result?.answer ?? '').includes('乙') &&
      (d2?.result?.answer ?? '').includes('乙') && !(d2?.result?.answer ?? '').includes('甲'),
    `A=${JSON.stringify(d1?.result?.answer?.slice(0, 60))} C=${JSON.stringify(d2?.result?.answer?.slice(0, 60))}`,
  );

  // ── [8] 非正常终止也落哨兵 ──────────────────────────────────
  console.log('\n[8] 打断（cancelled）同样落哨兵，等待方不会永久挂住');
  const fireD = await client.callTool(
    'dsh_send',
    {
      conversation_id: convA,
      wait: false,
      prompt: '连续运行 6 次命令 Start-Sleep -Seconds 6，每次都汇报第几次，全部跑完回复"完成"。',
    },
    60_000,
  );
  const sD = fireD?.structuredContent ?? {};
  await sleep(9000);
  const stBefore = await client.callTool('dsh_status', { conversation_id: convA });
  check('打断前确实在跑', stBefore?.structuredContent?.state === 'running', McpClient.text(stBefore));
  check('打断前哨兵尚未落地', !existsSync(sD.sentinel_file));
  const intRes = await client.callTool('dsh_interrupt', { conversation_id: convA });
  check('中断请求被接受', intRes?.structuredContent?.interrupted === true, McpClient.text(intRes));
  const waitedD = await waitForFile(sD.sentinel_file, 120_000);
  check('打断后哨兵仍然落地了', waitedD >= 0, `waited=${waitedD}ms`);
  const dD = existsSync(sD.sentinel_file) ? readSentinel(sD.sentinel_file) : null;
  check('status 记录了非正常终止', ['cancelled', 'error'].includes(dD?.status), String(dD?.status));
  console.log(`    终止 status = ${dD?.status}`);

  // ── 目录整洁性 ──────────────────────────────────────────────
  console.log('\n[9] 哨兵目录结构');
  const convDirs = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR) : [];
  check('按会话分目录', convDirs.includes(convA) && convDirs.includes(convC), JSON.stringify(convDirs));
  const tmpLeft = convDirs.flatMap((d) => readdirSync(join(RUNS_DIR, d)).filter((f) => f.includes('.tmp.')));
  check('没有残留的 .tmp 文件', tmpLeft.length === 0, JSON.stringify(tmpLeft));

  console.log('\n[10] 收尾');
  for (const id of [convA, convC]) await client.callTool('dsh_release', { conversation_id: id, forget: true });
  check('会话已释放', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-30).join('\n'));
} finally {
  await client.close();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
}

console.log(`\n===== 哨兵测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);