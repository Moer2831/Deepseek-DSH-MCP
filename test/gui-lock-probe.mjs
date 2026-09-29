/**
 * GUI 占锁探测器（手工诊断工具，**不在自动套件里**；需要人配合开一次 GUI）
 *
 * 用法: node test/gui-lock-probe.mjs [label]
 *
 * 原理：用**独立进程**尝试 `session/resume`。
 *   - 成功          → 写锁是空的（没人持有）
 *   - already owned → 有别的进程在写（若此时你正把它开在 web 里 → **GUI 占锁**）
 * 这是唯一能越过"我们自己的登记表"看到别的进程的办法（登记表只记录本服务自己拉起的子进程）。
 * 探测进程用完即退，退出即释放它自己拿到的锁，不会留下影响。
 *
 * 准备一个可用的测试会话（不碰真实会话）：
 *   用临时 DSH_MCP_STATE 起一个 MCP 实例 → dsh_start(cwd=桌面某文件夹) → 发一条短消息
 *   （**必须有内容**：空白会话在 GUI 里会被特殊处理）→ dsh_release → 得到会话 id 与 cwd，
 *   填到下面的 ID / CWD。然后把结论写进 README / USAGE-NOTES。
 *
 * 实测结论（2026-09，两个阶段，A/B）：
 *   ① 未在 GUI 打开        → 【空】（连测两次）
 *   ② 在 GUI 里点开它      → 【被占用】"already owned by an active write handle"，
 *                            且当时唯一的 MCP 服务没有任何子进程 → 持有者是 dsh web
 *   ③ 从它切走到别的会话   → **仍然【被占用】**（切走不释放！点开一次 = 整个 web 生命周期归 GUI）
 */

import { AcpProcess } from '../src/acp.mjs';

const ID = '28820ad0-fbd6-4eaf-8fc2-da9dd92dcf86';
const CWD = 'C:\\Users\\Administrator\\Desktop\\MCP锁实验';
const label = process.argv[2] ?? '探测';

const p = new AcpProcess({ cwd: CWD, permission: 'read-only' });
let held;
let detail;
try {
  p.start();
  await p.initialize();
  await p.request('session/resume', { sessionId: ID, cwd: CWD, mcpServers: [] }, 90_000);
  held = false;
  detail = 'resume 成功';
} catch (e) {
  held = true;
  detail = e.message.slice(0, 400);
} finally {
  await p.stop().catch(() => {});
}

console.log(`=== ${label} ===`);
console.log('  会话:', ID);
if (!held) {
  console.log('  写锁: 【空】 → 没有别的进程持有它');
} else {
  console.log('  写锁: 【被占用】 → 有别的进程正在写它');
  console.log('  错误:', detail);
}
process.exit(0);