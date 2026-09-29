/**
 * ★ 权限档真的生效了吗（**安全属性，必须钉住**）。
 *
 * 背景（实测踩到的无声提权）：profile 里若写了 `defaultPreset: danger-full-access`，
 * `dsh-permission-presets` 会在"**会话创建时**把它应用到 sandbox 模式与审批策略"，
 * 从而盖掉 dsh-base 从 `DSH_PERMISSION_MODE` 推导出的模式 —— 于是
 * `dsh_start(permission:'read-only')` 会返回 "read-only"，而会话**实际是完全权限**。
 *
 * 本测试不看我们的返回值（那正是会说谎的地方），而是读**会话自己记录的事实**：
 *   会话日志头 → 找到 sessionId → 投影缓存 `permissions.preset` / `sandboxMode`
 * 三种档位各建一个会话，逐一核对"记录里的事实"与"我们声称的档位"一致。
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-mcp-perm-'));
const { McpClient } = await import('./mcp-client.mjs');
const { DSH_HOME } = await import('../src/config.mjs');
const client = new McpClient({ env: { DSH_MCP_STATE: join(ROOT, 'state.json') } }).start();

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

/** 读会话自己的记录（投影缓存）——这是"事实"，不是我们的返回值。 */
function recorded(id) {
  const p = join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    const rows = JSON.parse(readFileSync(p, 'utf8'))?.record?.rows ?? {};
    return {
      preset: rows.permissions?.val?.preset ?? null,
      sandbox: rows.permissions?.val?.sandbox ?? null,
      approval: rows.permissions?.val?.approval ?? null,
      sandboxMode: rows.sandboxMode?.val ?? null,
    };
  } catch {
    return null;
  }
}

/** 轮询等待投影缓存反映出期望档位（DSH 会稍后才刷盘）。 */
async function waitRecorded(id, expect, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = recorded(id);
    if (r?.preset === expect) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return recorded(id);
}

const convs = [];
try {
  await client.initialize();

  for (const tier of ['read-only', 'workspace-write', 'danger-full-access']) {
    console.log(`\n[${tier}] 声称的档位 vs 会话记录的事实`);
    const ws = join(ROOT, `ws-${tier}`);
    mkdirSync(ws, { recursive: true });
    const st = await client.callTool('dsh_start', { cwd: ws, permission: tier }, 180_000);
    const id = st?.structuredContent?.conversation_id;
    check(`建会话返回 ${tier}`, st?.structuredContent?.permission === tier, JSON.stringify(st?.structuredContent?.permission));
    convs.push(id);

    const r = await waitRecorded(id, tier);
    check(
      `★★ 会话**记录**的 preset 也是 ${tier}（不是被 profile 钉死的其它档）`,
      r?.preset === tier,
      `实际记录: ${JSON.stringify(r)}`,
    );
    check(
      `会话记录的 sandboxMode 与 ${tier} 一致`,
      r?.sandboxMode === tier,
      `sandboxMode=${JSON.stringify(r?.sandboxMode)}`,
    );
  }

  // 复核：三个档位之间确实互不相同（避免"都通过"是因为都返回同一个值）
  console.log('\n[交叉核对] 三档的记录值必须互不相同');
  const seen = convs.map((id) => recorded(id)?.preset);
  check('★ 三档记录值互不相同', new Set(seen).size === 3, JSON.stringify(seen));

  console.log('\n[收尾]');
  for (const id of convs) {
    try {
      await client.callTool('dsh_release', { conversation_id: id, forget: true }, 60_000);
    } catch {}
  }
  check('已释放', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  await client.close();
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

console.log(`\n===== 权限档有效性测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);