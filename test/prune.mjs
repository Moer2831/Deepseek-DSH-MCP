/**
 * 哨兵留存策略的边界测试（**不调用 LLM**，纯文件系统 + 启动路径）。
 *
 * 覆盖 src/hub.mjs 的 `pruneSentinels()`：
 *   [1] 启动时清掉超过 TTL 的哨兵与崩溃残留的 .tmp，**新哨兵必须保留**
 *   [2] 空目录会被一并清掉（不留空壳）
 *   [3] `DSH_MCP_SENTINEL_TTL_MS=0` 时**关闭清理**（哨兵永久保留）
 *   [4] 只清理哨兵目录，**绝不碰真实会话或 .state 里的其它东西**
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const { McpClient } = await import('./mcp-client.mjs');

/** 造一批哨兵：一个十年前的、一个刚写的、一个崩溃残留的 .tmp。 */
function seedRuns(root) {
  const runs = join(root, 'runs');
  const conv = 'conv-prune-test';
  const dir = join(runs, conv);
  mkdirSync(dir, { recursive: true });
  const old = join(dir, 'run-old-1.json');
  const fresh = join(dir, 'run-fresh-2.json');
  const tmp = join(dir, 'run-crashed-3.json.tmp.999.deadbeef');
  for (const f of [old, fresh, tmp]) writeFileSync(f, JSON.stringify({ status: 'done' }), 'utf8');
  const tenDaysAgo = Date.now() / 1000 - 10 * 24 * 3600;
  utimesSync(old, tenDaysAgo, tenDaysAgo);
  utimesSync(tmp, tenDaysAgo, tenDaysAgo);
  // 另一个"空壳"会话目录（只有目录没有文件）
  mkdirSync(join(runs, 'conv-empty-shell'), { recursive: true });
  return { runs, conv, dir, old, fresh, tmp };
}

/** 拉起一个 MCP 服务实例（它会做启动清理），随后关掉。 */
async function runStartup(env) {
  const c = new McpClient({ env }).start();
  await c.initialize();
  await c.close();
}

try {
  // ── [1][2] 默认 TTL：清旧、留新、清空壳 ──────────────────────
  console.log('\n[1] 默认 TTL（7 天）：清旧、留新');
  const rootA = mkdtempSync(join(tmpdir(), 'dsh-mcp-prune-a-'));
  const a = seedRuns(rootA);
  await runStartup({ DSH_MCP_STATE: join(rootA, 'state.json') });

  check('★ 十年旧的哨兵被清掉', !existsSync(a.old), a.old);
  check('★ 崩溃残留的 .tmp 被清掉', !existsSync(a.tmp), a.tmp);
  check('★ 刚写的哨兵**保留**', existsSync(a.fresh), a.fresh);
  check('会话目录还在（因为里面还有新哨兵）', existsSync(a.dir));
  console.log('\n[2] 空壳目录');
  check('★ 空的会话目录被清掉', !existsSync(join(a.runs, 'conv-empty-shell')));

  // ── [3] TTL=0 关闭清理 ──────────────────────────────────────
  console.log('\n[3] DSH_MCP_SENTINEL_TTL_MS=0 → 关闭清理');
  const rootB = mkdtempSync(join(tmpdir(), 'dsh-mcp-prune-b-'));
  const b = seedRuns(rootB);
  await runStartup({ DSH_MCP_STATE: join(rootB, 'state.json'), DSH_MCP_SENTINEL_TTL_MS: '0' });
  check('★ TTL=0 时旧哨兵保留', existsSync(b.old), b.old);
  check('TTL=0 时 .tmp 也保留（清理整个关闭）', existsSync(b.tmp), b.tmp);
  check('TTL=0 时空壳目录保留', existsSync(join(b.runs, 'conv-empty-shell')));

  // ── [4] 只动哨兵目录 ────────────────────────────────────────
  console.log('\n[4] 清理的范围边界');
  const rootC = mkdtempSync(join(tmpdir(), 'dsh-mcp-prune-c-'));
  const c = seedRuns(rootC);
  // 在 .state 里放一个"不该被动"的邻居文件
  const neighbor = join(rootC, 'conversations.json');
  writeFileSync(neighbor, JSON.stringify({ version: 1, conversations: [] }), 'utf8');
  const neighborOld = Date.now() / 1000 - 30 * 24 * 3600;
  utimesSync(neighbor, neighborOld, neighborOld);
  await runStartup({ DSH_MCP_STATE: neighbor });
  check('★ 同一目录下的会话注册表没被哨兵清理碰到', existsSync(neighbor), neighbor);
  check('哨兵清理照常发生', !existsSync(c.old), c.old);
  check('runs 目录里只剩新哨兵', readdirSync(c.dir).join(',') === 'run-fresh-2.json', readdirSync(c.dir).join(','));

  for (const r of [rootA, rootB, rootC]) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {}
  }
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
}

console.log(`\n===== 哨兵留存测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);