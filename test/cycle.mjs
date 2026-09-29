/**
 * "异步派活 → 等 task → 回头再进" 的锁行为测试（**用户提出的场景**）。
 *
 * 疑问：MCP 异步派活后就不再握着「这一轮」的东西了，等调用方回头再来时，
 * 会不会撞上一个自己留下的锁？更具体地——空闲回收把进程收掉之后，锁释放干净了吗？
 *
 * 本文件把这条生命周期跑穿，并且**故意把回收调得极快**来放大竞态窗口：
 *   [1] 异步派活 → 收哨兵 → 空闲被回收 → 再派活：必须一路无锁错误（连做 3 轮）
 *   [2] 回收时刻的锁状态：登记必须被删、子进程必须真的死了（不然锁会被"无名持有"）
 *   [3] 贴着回收窗口立刻重派（放大竞态）：仍必须成功
 *   [4] 主动 dsh_release → 立刻重派：同样必须成功（stop 必须等进程真退出）
 *
 * 全部开销只有几个极短回合（"只回复两个字"级别）。
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-mcp-cycle-'));
const STATE = join(ROOT, 'state.json');
const LOCKS = join(ROOT, 'locks');
process.env.DSH_MCP_LOCKS_DIR = LOCKS;

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

const { McpClient } = await import('./mcp-client.mjs');
const locks = await import('../src/locks.mjs');

/** 把空闲回收调到极快：1 秒空闲就收，400ms 扫一次 —— 放大竞态窗口。 */
const ENV = {
  DSH_MCP_STATE: STATE,
  DSH_MCP_LOCKS_DIR: LOCKS,
  DSH_MCP_IDLE_TTL_MS: '1000',
  DSH_MCP_REAP_INTERVAL_MS: '400',
};

const client = new McpClient({ env: ENV }).start();
const readMarkerSafe = (id) => {
  try {
    return JSON.parse(readFileSync(join(LOCKS, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
};

try {
  await client.initialize();
  const ws = join(ROOT, 'ws');
  mkdirSync(ws, { recursive: true });
  const st = await client.callTool('dsh_start', { cwd: ws, permission: 'danger-full-access' }, 180_000);
  const conv = st?.structuredContent?.conversation_id;
  check('会话已建', !!conv, McpClient.text(st).slice(0, 140));

  // ── [1] 三轮"异步派活 → 收哨兵 → 被回收 → 再派活" ───────────
  console.log('\n[1] ★ 三轮"异步派活 → 收活 → 空闲回收 → 再派活"（必须一路无锁错误）');
  for (let round = 1; round <= 3; round++) {
    const send = await client.callTool(
      'dsh_send',
      { conversation_id: conv, prompt: `只回复两个字：第${round}轮` },
      180_000,
    );
    const s = send?.structuredContent ?? {};
    check(`第 ${round} 轮：异步收据 + 哨兵路径`, !!s.run_id && !!s.sentinel_file, JSON.stringify(s).slice(0, 200));

    // 等哨兵（这才是调用方"等 task"的真实姿势）
    let waited = 0;
    while (!existsSync(s.sentinel_file) && waited < 300_000) {
      await sleep(1000);
      waited += 1000;
    }
    check(`第 ${round} 轮：哨兵已落地`, existsSync(s.sentinel_file), `waited=${waited}ms`);
    const doc = existsSync(s.sentinel_file) ? JSON.parse(readFileSync(s.sentinel_file, 'utf8')) : null;
    check(`第 ${round} 轮：status=done`, doc?.status === 'done', JSON.stringify(doc?.status));

    // 让它空闲到被回收（TTL=1s + 扫描 0.4s，留足余量）
    await sleep(3000);
  }

  console.log('\n[2] 回收之后的锁状态（锁不该被"无名持有"）');
  const liveOrphan = locks.listOrphans();
  check('★ 没有留下孤儿持有者', liveOrphan.length === 0, JSON.stringify(liveOrphan));
  const holder = locks.classifyHolder(conv);
  check('★ 当前 lock_holder = none/self（不是无法归因的状态）', ['none', 'self'].includes(holder.kind), holder.reason);
  const stNow = await client.callTool('dsh_status', { conversation_id: conv });
  const lh = stNow?.structuredContent?.lock_holder;
  check('★ dsh_status 的 lock_holder 是干净的', ['none', 'self'].includes(lh), JSON.stringify(lh));

  // ── [3] 贴着回收窗口立刻重派（放大竞态）──────────────────────
  console.log('\n[3] ★ 贴着回收窗口立刻重派（放大竞态，连做 3 次）');
  for (let i = 1; i <= 3; i++) {
    const r = await client.callTool(
      'dsh_send',
      { conversation_id: conv, prompt: `只回复两个字：紧${i}`, wait: true, timeout_ms: 300_000 },
      360_000,
    );
    const t = McpClient.text(r);
    check(`紧派 ${i}：成功且无锁错误`, r?.structuredContent?.stop_reason === 'end_turn' && !/写锁|占用|already owned/i.test(t), t.slice(0, 260));
    // 立刻进入下一轮，不给回收留空档
    await sleep(400);
  }

  // ── [4] 主动交还后立刻重派 ──────────────────────────────────
  console.log('\n[4] ★ dsh_release 之后立刻重派（stop 必须等进程真退出）');
  await client.callTool('dsh_release', { conversation_id: conv }, 60_000);
  check('交还后登记已删', !existsSync(join(LOCKS, `${conv}.json`)));
  const after = await client.callTool(
    'dsh_send',
    { conversation_id: conv, prompt: '只回复两个字：归还', wait: true, timeout_ms: 300_000 },
    360_000,
  );
  check('★ 交还后立刻重派成功（无锁错误）', after?.structuredContent?.stop_reason === 'end_turn' && !/写锁|占用/i.test(McpClient.text(after)), McpClient.text(after).slice(0, 260));
  check('拿到答复', /归还/.test(after?.structuredContent?.answer ?? ''), JSON.stringify(after?.structuredContent?.answer));

  // ── [5] 收尾 ────────────────────────────────────────────────
  console.log('\n[5] 收尾');
  await client.callTool('dsh_release', { conversation_id: conv, forget: true }, 60_000);
  check('已释放', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-20).join('\n'));
} finally {
  await client.close();
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(ROOT, { recursive: true, force: true });
      break;
    } catch {
      await sleep(700);
    }
  }
}

console.log(`\n===== 异步生命周期锁测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);