/**
 * 测试套件收尾清理（也可单独运行）。
 *
 * 只清理**临时目录**里的测试残留：测试会话、临时工作区登记、空分桶、以及崩溃遗留的临时工作区目录。
 *
 * 明确**不碰**：
 *   - 真实项目目录里的会话（例如 Desktop\SF6HACK）—— 那是你的活数据
 *   - 仓库 `.state/`（真实使用 MCP 时的会话注册表与哨兵文件）
 *   - 桌面 `dsh-mcp-test-*` —— 要删它得显式跑
 *     `node bin/dsh-mcp-workspaces.mjs --purge-test-sessions`
 *
 * 用法：node test/cleanup.mjs [--dry-run]
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listWorkspaces,
  pruneEmptyWorkspaces,
  pruneTempWorkspaces,
  purgeTestSessions,
} from '../src/workspace.mjs';

const dryRun = process.argv.includes('--dry-run');
const flag = dryRun ? '[预演] ' : '';
const log = (s) => console.log(s);

log(`${flag}测试收尾清理（只针对临时目录；不动真实项目与 .state/）\n`);

// 1) 临时目录里的测试会话
const purged = purgeTestSessions({ dryRun, tempOnly: true });
log(`  测试会话：删除 ${purged.count} 个`);
for (const v of purged.victims.slice(0, 10)) log(`    - ${v.id}  cwd=${v.cwd}`);
if (purged.victims.length > 10) log(`    …还有 ${purged.victims.length - 10} 个`);

// 2) 临时目录的工作区登记
const tempWs = pruneTempWorkspaces({ dryRun });
log(`  临时工作区登记：删除 ${tempWs.removed.length} 个`);

// 3) 空工作区（无会话且路径已不存在）
const emptyWs = pruneEmptyWorkspaces({ dryRun });
log(`  空工作区：删除 ${emptyWs.removed.length} 个`);

// 4) 崩溃遗留的临时工作区目录（各测试用 mkdtempSync 造在系统临时目录下，正常路径会自删）
let dirsRemoved = 0;
try {
  for (const e of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    // 只认本项目测试的命名前缀，避免误伤别人的临时目录
    if (!/^dsh-mcp-(smoke|bound|int|async|sentinel|conc|cap|reason|acp|cfgopt|ws)/.test(e.name)) continue;
    const p = join(tmpdir(), e.name);
    if (!dryRun) rmSync(p, { recursive: true, force: true });
    dirsRemoved++;
  }
} catch {
  /* 临时目录不可读就算了 */
}
log(`  遗留临时工作区目录：删除 ${dirsRemoved} 个`);

// 5) 事后核对
if (!dryRun) {
  const list = listWorkspaces();
  const temp = list.filter((w) => w.is_temp);
  log(`\n  清理后注册表：共 ${list.length} 个工作区，其中临时目录 ${temp.length} 个`);
  if (temp.length) for (const w of temp) log(`    [临时] ${w.path}`);
  log('  （真实项目里的会话与仓库 .state/ 一律未动）');
}