/**
 * 测试入口：先跑冒烟（不花 token），再跑集成（会调用真实 LLM）。
 * 用法：npm test          只跑冒烟
 *       npm test -- --all 冒烟 + 集成
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const all = process.argv.includes('--all');

function run(script) {
  return new Promise((resolve) => {
    console.log(`\n${'█'.repeat(70)}\n█ ${script}\n${'█'.repeat(70)}`);
    const child = spawn(process.execPath, [join(HERE, script)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let code = await run('smoke.mjs');
if (code === 0) {
  // 哨兵留存是纯文件系统 + 启动路径，不花 token —— 归到"冒烟一档"，每次必跑
  code = await run('prune.mjs');
}
if (code === 0 && all) {
  code = await run('boundary.mjs');
}
if (code === 0 && all) {
  code = await run('integration.mjs');
}
if (code === 0 && all) {
  code = await run('async.mjs');
}
if (code === 0 && all) {
  code = await run('sentinel.mjs');
}
if (code === 0 && all) {
  code = await run('timeout.mjs');
}
if (code === 0 && all) {
  code = await run('lock.mjs');
}
if (code === 0 && all) {
  code = await run('multi.mjs');
}
if (code === 0 && all) {
  code = await run('list.mjs');
}
if (code === 0 && all) {
  code = await run('permission.mjs');
}
if (code === 0 && all) {
  code = await run('cycle.mjs');
}
if (code === 0 && all) {
  code = await run('concurrency.mjs');
}
if (code === 0 && all) {
  code = await run('capability.mjs');
}
if (code === 0 && all) {
  code = await run('workspace-effect.mjs');
}
if (code === 0 && all) {
  code = await run('reasoning-check.mjs');
}
// 收尾清理：只清临时目录里的测试残留（真实项目会话与仓库 .state/ 不动）。
// 无论前面成败都跑，否则失败的运行会把垃圾留在磁盘上。
await run('cleanup.mjs');

console.log(`\n总结果: ${code === 0 ? '通过 ✅' : '失败 ❌'}`);
process.exit(code);