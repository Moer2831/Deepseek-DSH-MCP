/**
 * 「MCP 默认持锁」现场演示（后台常驻，手动停止）
 *
 * 目的：验证"本服务一直握着写锁"时的实际效果 ——
 *   ① 你在 web 里点开这条会话 → **GUI 那边应该看到「已被占用」**
 *   ② 而本服务**完全不受影响**：可以继续派活、接回
 *
 * 之所以要常驻：**持锁的是这个 MCP 实例拉起的 DSH 子进程** —— 本脚本一退，
 * 实例就没了、锁也就释放了，演示就不成立。所以这里跑成一个长期进程，
 * 每 8 秒把自己的状态打出来（这样"你点击之后发生了什么"有直接证据）。
 *
 * 收尾：Ctrl+C / kill 本进程 → 自动 release + 删除桌面演示文件夹。
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAME = process.argv[2] ?? 'MCP持锁演示';
const WS = `C:\\Users\\Administrator\\Desktop\\${NAME}`;
const FIRST_PROMPT = process.argv[3] ?? '只回复六个字：持锁演示就绪';
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-mcp-demo-'));
const { McpClient } = await import('./mcp-client.mjs');

// ★ 不设 DSH_MCP_IDLE_TTL_MS —— 用**默认值**（现在的默认就是 0 = 永不回收）
const client = new McpClient({ env: { DSH_MCP_STATE: join(ROOT, 'state.json') } }).start();
let conv = null;
let stopping = false;

const cleanup = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\n=== 收尾 ===');
  try {
    if (conv) await client.callTool('dsh_release', { conversation_id: conv, forget: true }, 60_000);
    console.log('  已 release 会话');
  } catch (e) {
    console.log('  release 失败:', e.message);
  }
  try {
    await client.close();
  } catch {}
  try {
    rmSync(WS, { recursive: true, force: true });
    console.log('  已删除桌面演示文件夹');
  } catch {}
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

try {
  await client.initialize();
  mkdirSync(WS, { recursive: true });

  console.log('=== 建立演示会话（默认配置：不回收 → 本服务会一直握着写锁）===');
  const st = await client.callTool('dsh_start', { cwd: WS, permission: 'danger-full-access' }, 180_000);
  conv = st?.structuredContent?.conversation_id;
  console.log('  会话 id :', conv);
  console.log('  工作区  :', WS, `（侧栏里叫「${NAME}」）`);

  const r = await client.callTool(
    'dsh_send',
    { conversation_id: conv, prompt: FIRST_PROMPT, wait: true, timeout_ms: 300_000 },
    360_000,
  );
  console.log('  首轮结果:', r?.structuredContent?.stop_reason, JSON.stringify(r?.structuredContent?.answer));

  const st2 = await client.callTool('dsh_status', { conversation_id: conv });
  console.log('  会话状态:', JSON.stringify({
    state: st2?.structuredContent?.state,
    alive: st2?.structuredContent?.alive,
    lock_holder: st2?.structuredContent?.lock_holder,
  }));

  console.log('');
  console.log('  ★★ 请你在 web 里刷新 → 侧栏找到工作区「' + NAME + '」→ 里面**只有这一条**会话。');
  console.log('     ① 点开它：预期**能正常看到内容**（GUI 退化为只读）');
  console.log('     ② 然后试着在里面**发一条消息**（比如「测试」）：预期**发不出去**');
  console.log('     ③ 把 GUI 上实际显示的提示告诉我');
  console.log('     我这边的日志每 8 秒打一次 —— 你操作前后可以直接对比：锁应该一直留在我们手里。');
  console.log('');

  let n = 0;
  setInterval(async () => {
    n++;
    try {
      const s = await client.callTool('dsh_status', { conversation_id: conv });
      const c = s?.structuredContent ?? {};
      const t = new Date().toLocaleTimeString('sv-SE');
      console.log(
        `  [${t}] #${n} state=${c.state} alive=${c.alive} lock_holder=${c.lock_holder}` +
          ` busy=${c.busy} lock_conflict=${c.lock_conflict ? c.lock_conflict.holder_kind : '无'}`,
      );
    } catch (e) {
      console.log(`  [#${n}] 状态查询失败: ${e.message.slice(0, 120)}`);
    }
  }, 8000);
} catch (e) {
  console.log('✗ 异常:', e.message);
  await cleanup();
}