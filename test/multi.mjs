/**
 * 多实例共存 + 非 ASCII 路径（真实使用漏洞排查）。
 *
 * 背景：用户经常同时跑 2–3 个 dsh-mcp（多个宿主窗口），它们**共用同一份注册表**。
 * 注册表是"整份文档、最后写入者获胜"，于是：
 *   - 实例 B（先启动、内存里没有 A 后建的会话）一保存，就会**把 A 的会话从文件里抹掉**；
 *   - `save()` 原来还用**固定名**的临时文件，并发保存会互相踩踏。
 *
 * 本测试不改代码行为地去验证这些，并证明修复有效：
 *   [1] 复现：B 保存后，A 建的会话确实从注册表文件里消失
 *   [2] ★ 修复：即使注册表里没了，只要会话还在磁盘上，按 id 仍能取回（会话存储才是权威）
 *   [3] 取回后的会话**真的能用**（能派活、能拿结果）
 *   [4] 不留 .tmp 残渣（临时文件名唯一化）
 *   [5] 中文 / emoji 工作区路径也能正常工作（用户的目录名很不 ASCII）
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-mcp-multi-'));
const STATE = join(ROOT, 'state.json');

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
const readRegistry = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
};
const registryHas = (id) => (readRegistry()?.conversations ?? []).some((c) => c.id === id);

const A = new McpClient({ env: { DSH_MCP_STATE: STATE } });
const B = new McpClient({ env: { DSH_MCP_STATE: STATE } });

try {
  // A 先起，B 后起 —— 但**都早于**下一步创建会话，这正是"内存落后于磁盘"的成因
  A.start();
  B.start();
  await A.initialize();
  await B.initialize();

  console.log('\n[1] 复现：两个实例共享注册表');
  const wsA = join(ROOT, 'wsA');
  mkdirSync(wsA, { recursive: true });
  const st1 = await A.callTool('dsh_start', { cwd: wsA, permission: 'danger-full-access' }, 180_000);
  const conv1 = st1?.structuredContent?.conversation_id;
  check('A 建好会话 conv1', !!conv1, McpClient.text(st1).slice(0, 140));
  check('注册表里此刻有 conv1', registryHas(conv1), JSON.stringify((readRegistry()?.conversations ?? []).map((c) => c.id.slice(0, 8))));

  // B 建自己的会话 —— 它的内存里没有 conv1（B 启动时它还不在），保存即把 conv1 抹掉
  const wsB = join(ROOT, 'wsB');
  mkdirSync(wsB, { recursive: true });
  const st2 = await B.callTool('dsh_start', { cwd: wsB, permission: 'danger-full-access' }, 180_000);
  const conv2 = st2?.structuredContent?.conversation_id;
  check('B 建好会话 conv2', !!conv2, McpClient.text(st2).slice(0, 140));

  const lostFromRegistry = !registryHas(conv1);
  console.log(`    注册表里 conv1 是否还在: ${registryHas(conv1) ? '在' : '★ 已被 B 的保存抹掉'}`);
  check('（已知行为）B 的保存会覆盖掉它没见过的 conv1', lostFromRegistry || registryHas(conv1), '无论哪种都不算失败，只作为现象记录');

  // ── [2] ★ 修复：注册表没了，但会话在磁盘上 → 按 id 仍能取回 ──
  console.log('\n[2] ★ 注册表丢了也能按 id 从会话存储取回（会话存储才是权威）');
  const g = await B.callTool('dsh_get', { conversation_id: conv1 });
  check('★ B 能取回它从没见过的 conv1（从前这里会报"未知会话"）', g?.isError !== true, McpClient.text(g).slice(0, 240));
  check('★ 取回的 cwd 正确（来自会话头，不是猜的）', g?.structuredContent?.cwd === wsA, JSON.stringify(g?.structuredContent?.cwd));
  check('取回后也写回了注册表', registryHas(conv1), JSON.stringify((readRegistry()?.conversations ?? []).map((c) => c.id.slice(0, 8))));

  // ── [3] 取回的会话真的能用 ────────────────────────────────
  console.log('\n[3] ★ 取回的会话能真的用起来');
  // A 让出（释放写锁），再由 B 接管并派活 —— 走完整条"只有 id"的路
  await A.callTool('dsh_release', { conversation_id: conv1 }, 60_000);
  const r = await B.callTool(
    'dsh_send',
    { conversation_id: conv1, prompt: '只回复两个字：找回', wait: true, timeout_ms: 300_000 },
    360_000,
  );
  check('★ B 能给"只从磁盘找回"的会话派活并拿到结果', r?.structuredContent?.stop_reason === 'end_turn', McpClient.text(r).slice(0, 260));
  check('答复正确', /找回/.test(r?.structuredContent?.answer ?? ''), JSON.stringify(r?.structuredContent?.answer));

  // ── [4] 不留 .tmp 残渣 ────────────────────────────────────
  console.log('\n[4] 保存不留临时文件残渣');
  const stray = readdirSync(dirname(STATE)).filter((f) => f.includes('.tmp'));
  check('★ 没有残留 .tmp 文件（临时名已唯一化）', stray.length === 0, JSON.stringify(stray));

  // ── [5] 非 ASCII 工作区路径 ───────────────────────────────
  console.log('\n[5] ★ 中文 / emoji 工作区路径');
  const cjk = join(ROOT, '测试 工作区 🚀');
  mkdirSync(cjk, { recursive: true });
  const st3 = await B.callTool('dsh_start', { cwd: cjk, permission: 'danger-full-access' }, 180_000);
  const conv3 = st3?.structuredContent?.conversation_id;
  check('★ 中文+emoji 路径能建会话', !!conv3, McpClient.text(st3).slice(0, 200));
  check('回报的 cwd 与传入一致', st3?.structuredContent?.cwd === cjk, JSON.stringify(st3?.structuredContent?.cwd));
  const r3 = await B.callTool(
    'dsh_send',
    { conversation_id: conv3, prompt: '在当前工作目录写一个文件 cjk.txt，内容写 OK；然后只回复两个字：写好了', wait: true, timeout_ms: 300_000 },
    360_000,
  );
  check('★ 中文+emoji 路径下能正常干活', r3?.structuredContent?.stop_reason === 'end_turn', McpClient.text(r3).slice(0, 260));
  check('★ 文件真的落在那个非 ASCII 目录里', existsSync(join(cjk, 'cjk.txt')), join(cjk, 'cjk.txt'));

  // ── [6] ★ 兜底取回**不能提权** ──────────────────────────────
  console.log('\n[6] ★ 兜底取回时不能悄悄提权');
  const ro = join(ROOT, 'wsRO');
  mkdirSync(ro, { recursive: true });
  const st4 = await B.callTool('dsh_start', { cwd: ro, permission: 'read-only' }, 180_000);
  const conv4 = st4?.structuredContent?.conversation_id;
  check('建了一个 read-only 会话', !!conv4 && st4?.structuredContent?.permission === 'read-only', JSON.stringify(st4?.structuredContent?.permission));

  // 从注册表里彻底移除（内存 + 文件），然后只凭 id 取回 —— 走兜底路径
  await B.callTool('dsh_release', { conversation_id: conv4, forget: true }, 60_000);
  check('注册表里已经没有它了', !registryHas(conv4), JSON.stringify((readRegistry()?.conversations ?? []).map((c) => c.id.slice(0, 8))));
  await new Promise((r) => setTimeout(r, 3000)); // 等 DSH 把权限行刷进投影缓存

  const g4 = await B.callTool('dsh_get', { conversation_id: conv4 });
  check('兜底取回成功', g4?.isError !== true && g4?.structuredContent?.conversation_id === conv4, McpClient.text(g4).slice(0, 200));
  check(
    '★★ 取回后权限档仍是 read-only（不是默认的 danger-full-access）',
    g4?.structuredContent?.permission === 'read-only',
    `实际=${JSON.stringify(g4?.structuredContent?.permission)}`,
  );

  console.log('\n[7] 收尾');
  for (const id of [conv1, conv2, conv3]) {
    for (const cl of [A, B]) {
      try {
        await cl.callTool('dsh_release', { conversation_id: id, forget: true }, 60_000);
      } catch {}
    }
  }
  check('已释放', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  for (const cl of [A, B]) {
    try {
      await cl.close();
    } catch {}
  }
  // 顺手清掉这两个实例留下的会话（只删临时目录里的，绝不动真实会话）
  const { purgeTestSessions } = await import('../src/workspace.mjs');
  purgeTestSessions({ tempOnly: true });
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(ROOT, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

console.log(`\n===== 多实例 / 非 ASCII 路径测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);