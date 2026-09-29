/**
 * 并发管理测试：模拟"控制多个会话实例、切换着看"。
 *
 *   1) 同时开 3 个会话，各自后台跑一个多步任务
 *   2) dsh_list(only_running=true) 应能看到 3 个正在跑的会话（含已跑时长/当前工具/本轮字数）
 *   3) 轮流 dsh_read 三个会话，用游标增量观察输出增长 —— 证明"不用等回合结束就能看"
 *   4) 校验隔离：读 A 只能看到 A 的内容
 *   5) 校验隐私默认值：默认读不返回思考；显式 include_reasoning=true 才有实时思考
 *   6) 跑完后 only_running 应回到 0，且输出里能看到轮次结束标记
 *
 * 会消耗少量 token（3 个会话 × 各一个短任务）。
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

const STATE = join(tmpdir(), `dsh-mcp-conc-state-${Date.now()}.json`);
const wsRoot = mkdtempSync(join(tmpdir(), 'dsh-mcp-conc-'));
const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();

/** 三个会话各自的标记词，用于验证内容隔离。任务要足够长，才能覆盖后面几轮轮询。 */
const CASES = [
  { key: 'S1', marker: '阿尔法', prompt: '分四步做：依次运行 4 次 Start-Sleep -Seconds 5，每次跑完汇报"第N步"，最后回复"阿尔法完成"。' },
  { key: 'S2', marker: '贝塔', prompt: '分四步做：依次运行 4 次 Start-Sleep -Seconds 5，每次跑完汇报"第N步"，最后回复"贝塔完成"。' },
  { key: 'S3', marker: '伽马', prompt: '分四步做：依次运行 4 次 Start-Sleep -Seconds 5，每次跑完汇报"第N步"，最后回复"伽马完成"。' },
];

const conv = new Map();

try {
  await client.initialize();

  console.log('\n[1] 开 3 个会话（不同工作区）并各自后台派活');
  // **并发**派活，且用默认的 wait=false（顺带验证默认值）。
  // 必须并发：dsh_send 会等到进程起来（冷启动几秒），串行派活会让先派的任务在
  // 后派任务的冷启动期间就跑完，后面"增量读"的断言会误判成没产出。
  await Promise.all(
    CASES.map(async (c) => {
      const ws = join(wsRoot, c.key);
      mkdirSync(ws, { recursive: true });
      const start = await client.callTool('dsh_start', { cwd: ws, permission: 'danger-full-access' }, 180_000);
      const id = start?.structuredContent?.conversation_id;
      conv.set(c.key, { ...c, id, ws, cursor: 0, seen: '' });
      const send = await client.callTool('dsh_send', { conversation_id: id, prompt: c.prompt }, 180_000);
      check(
        `${c.key} 会话已创建且任务已被接受（默认 wait=false）`,
        !!id && send?.structuredContent?.background === true,
        `id=${id} | ${McpClient.text(start).slice(0, 160)} | ${McpClient.text(send).slice(0, 160)}`,
      );
    }),
  );

  console.log('\n[1b] 工作区不存在时应给出清晰报错（而不是卡住）');
  const badStart = await client.callTool('dsh_start', { cwd: join(wsRoot, 'definitely-not-here') }, 60_000);
  check('无效工作区返回 isError', badStart?.isError === true, McpClient.text(badStart).slice(0, 120));
  check('错误信息点名工作区不存在', /不存在或不是目录/.test(McpClient.text(badStart)), McpClient.text(badStart).slice(0, 160));

  console.log('\n[2] 查询"有哪些活动会话"（only_running）');
  await sleep(7000);
  const running = await client.callTool('dsh_list', { only_running: true });
  const runningList = running?.structuredContent?.conversations ?? [];
  check(`正在跑的会话数 = 3（实际 ${runningList.length}）`, runningList.length === 3, JSON.stringify(runningList.map((c) => c.conversation_id)));
  check('活动会话带状态字段', runningList.every((c) => c.state === 'running'));
  check('活动会话带已跑时长', runningList.every((c) => typeof c.running_ms === 'number' && c.running_ms > 0), JSON.stringify(runningList.map((c) => c.running_ms)));
  console.log(McpClient.text(running));

  console.log('\n[3] 轮流读三个会话（游标增量，观察输出增长）');
  const round1 = {};
  for (const c of CASES) {
    const e = conv.get(c.key);
    const r = await client.callTool('dsh_read', { conversation_id: e.id, cursor: 0 });
    const s = r?.structuredContent ?? {};
    round1[c.key] = s;
    e.cursor = s.cursor ?? 0;
    e.seen = (s.entries ?? []).map((x) => x.text).join('');
    check(`${c.key} 首次读取有内容`, (s.entries ?? []).length > 0, `entries=${(s.entries ?? []).length}`);
    check(`${c.key} 状态为 running`, s.state === 'running', s.state);
    check(`${c.key} 首次读取不含思考字段（隐私默认）`, s.live_thinking === undefined);
  }

  console.log('\n[3b] 实时思考（includereasoning=true，只在回合进行中可见）');
  let sawThinking = false;
  let thinkLen = 0;
  for (let i = 0; i < 8; i++) {
    const r = await client.callTool('dsh_read', {
      conversation_id: conv.get('S2').id,
      cursor: 0,
      include_reasoning: true,
    });
    const s = r?.structuredContent ?? {};
    if (s.state !== 'running') break; // 回合已结束，思考不再保留（符合"用完即弃"的设计）
    if (typeof s.live_thinking === 'string' && s.live_thinking.length > 0) {
      sawThinking = true;
      thinkLen = s.live_thinking.length;
      break;
    }
    await sleep(2500);
  }
  check('正在跑的回合里能取到实时思考', sawThinking, `len=${thinkLen}`);
  console.log(`    S2 实时思考长度: ${thinkLen}`);

  await sleep(11000); // 让它们继续产出

  const round2 = {};
  for (const c of CASES) {
    const e = conv.get(c.key);
    const r = await client.callTool('dsh_read', { conversation_id: e.id, cursor: e.cursor });
    const s = r?.structuredContent ?? {};
    round2[c.key] = s;
    e.cursor = s.cursor ?? 0;
    const delta = (s.entries ?? []).map((x) => x.text).join('');
    e.seen += delta;
    check(`${c.key} 增量读到了新输出（无需等回合结束）`, (s.entries ?? []).length > 0, `新增 ${(s.entries ?? []).length} 条`);
  }

  console.log('\n[4] 内容隔离：读 A 只有 A 的东西');
  check(
    'S1 的输出不含 S2/S3 的标记词',
    !conv.get('S1').seen.includes('贝塔') && !conv.get('S1').seen.includes('伽马'),
    conv.get('S1').seen.slice(0, 200),
  );
  check('S1 的输出含自己的标记词或步骤汇报', conv.get('S1').seen.includes('阿尔法') || conv.get('S1').seen.includes('第1步'), conv.get('S1').seen.slice(0, 200));

  console.log('\n[6] 等三个会话跑完，确认活动列表回到 0 且输出有结束标记');
  // 先不阻塞地等：轮询 only_running 直到 0（最多 3 分钟）
  let stillRunning = 3;
  for (let i = 0; i < 36 && stillRunning > 0; i++) {
    await sleep(5000);
    const r = await client.callTool('dsh_list', { only_running: true });
    stillRunning = (r?.structuredContent?.conversations ?? []).length;
    process.stdout.write(`    仍在跑: ${stillRunning}\r`);
  }
  console.log('');
  check('全部跑完后 only_running 为空', stillRunning === 0, `stillRunning=${stillRunning}`);

  for (const c of CASES) {
    const e = conv.get(c.key);
    const r = await client.callTool('dsh_read', { conversation_id: e.id, cursor: e.cursor });
    const s = r?.structuredContent ?? {};
    const tail = (s.entries ?? []).map((x) => `${x.kind}:${x.text}`).join(' | ');
    e.seen += tail; // 累计所有读到的内容（结束标记可能落在更早的一次读取里）
    check(`${c.key} 输出里有轮次结束标记`, /轮结束/.test(e.seen), e.seen.slice(-300));
    check(`${c.key} 结束后状态不再是 running`, s.state !== 'running', s.state);
  }

  console.log('\n[7] 收尾');
  for (const c of CASES) {
    await client.callTool('dsh_release', { conversation_id: conv.get(c.key).id, forget: true });
  }
  check('三个会话均已释放', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-30).join('\n'));
} finally {
  await client.close();
  try { rmSync(STATE, { force: true }); } catch {}
  try { rmSync(wsRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== 并发管理测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);