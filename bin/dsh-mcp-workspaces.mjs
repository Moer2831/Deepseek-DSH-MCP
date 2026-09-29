#!/usr/bin/env node
/**
 * 工作区注册表维护 + 测试会话清理。
 *
 * 背景：DSH 的 GUI 按工作区分组显示会话，归属完全由 `workspace.json` 里各工作区的
 * `sessionIds` 决定；不登记就落到"未分组"。
 * ⚠️ 正在运行的 DSH 服务把注册表缓存在内存里——**改完文件需要重启 DSH 才会生效**，
 *    而且在重启前若在 GUI 里操作工作区，服务可能用内存状态把文件覆盖回去。
 *
 * 用法：
 *   node bin/dsh-mcp-workspaces.mjs --list
 *   node bin/dsh-mcp-workspaces.mjs --backfill [--include-temp] [--dry-run]
 *   node bin/dsh-mcp-workspaces.mjs --prune-temp [--dry-run]
 *   node bin/dsh-mcp-workspaces.mjs --prune-empty [--dry-run]
 *   node bin/dsh-mcp-workspaces.mjs --purge-test-sessions [--dry-run] [--ids=a,b]
 *
 * 只有 --purge-test-sessions 会动磁盘上的会话文件，且规则很死：只删
 * "cwd 在系统临时目录下" 或 "cwd 在 Desktop\dsh-mcp-test-*" 的会话，外加 --ids 显式指定的。
 */

import {
  backfillWorkspaces,
  listWorkspaces,
  pruneEmptyWorkspaces,
  pruneTempWorkspaces,
  purgeTestSessions,
  WORKSPACE_FILE,
  SESSIONS_ROOT,
} from '../src/workspace.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};
const dryRun = has('--dry-run');
const flag = dryRun ? '[预演] ' : '';

console.log(`注册表:   ${WORKSPACE_FILE}`);
console.log(`会话目录: ${SESSIONS_ROOT}`);
console.log(`模式:     ${dryRun ? '预演（不改任何东西）' : '实际执行'}\n`);

const ids = (val('--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// ── 清理测试会话（唯一会删文件的动作） ──────────────────────
if (has('--purge-test-sessions')) {
  const res = purgeTestSessions({ dryRun, ids });
  console.log(`${flag}清理测试会话：${res.count} 个`);
  for (const v of res.victims) {
    console.log(`  - ${v.id}  [${v.reason}]${v.origin ? ` origin=${v.origin}` : ''}  cwd=${v.cwd}`);
    if (v.error) console.log(`      ⚠️ 删除失败: ${v.error}`);
  }
  if (!res.count) console.log('  （没有命中任何会话）');
  if (!dryRun) console.log('  已同步从工作区注册表摘除这些会话 id');
  console.log('');
}

// ── 回填 ────────────────────────────────────────────────────
if (has('--backfill')) {
  const stats = backfillWorkspaces({ includeTemp: has('--include-temp'), dryRun });
  console.log(`${flag}回填：`);
  console.log(`  扫描到会话            ${stats.sessions_scanned}`);
  console.log(`  新建工作区            ${stats.workspaces_created}`);
  console.log(`  已存在工作区          ${stats.workspaces_existing}`);
  console.log(`  新挂到工作区下的会话  ${stats.sessions_added}`);
  console.log(`  摘除已消失的会话 id   ${stats.sessions_pruned}`);
  if (stats.temp_skipped_workspaces) {
    console.log(`  跳过临时目录工作区    ${stats.temp_skipped_workspaces}（含 ${stats.temp_skipped_sessions} 个会话）`);
  }
  console.log('');
}

// ── 清理临时工作区 ──────────────────────────────────────────
if (has('--prune-temp')) {
  const res = pruneTempWorkspaces({ dryRun });
  console.log(`${flag}清理临时工作区条目：${res.removed.length} 个`);
  for (const r of res.removed) console.log(`  - ${r.path}（含 ${r.sessions} 个会话条目）`);
  console.log('');
}

// ── 清理空工作区 ────────────────────────────────────────────
if (has('--prune-empty')) {
  const res = pruneEmptyWorkspaces({ dryRun });
  console.log(`${flag}清理"无会话且路径已不存在"的工作区：${res.removed.length} 个`);
  for (const r of res.removed) console.log(`  - ${r.path}`);
  console.log('');
}

// ── 列表（或什么都不传时默认） ──────────────────────────────
if (has('--list') || argv.length === 0 || argv.every((a) => a === '--dry-run')) {
  const list = listWorkspaces();
  const temp = list.filter((w) => w.is_temp);
  console.log(`共 ${list.length} 个工作区（临时目录 ${temp.length} 个）——**这是文件里的内容**：`);
  for (const w of list.sort((a, b) => Number(a.is_temp) - Number(b.is_temp))) {
    console.log(`  ${w.is_temp ? '[临时]' : '      '} ${w.path}   会话 ${w.sessions} 个`);
  }
}

if (has('--backfill') || has('--prune-temp') || has('--prune-empty') || has('--purge-test-sessions')) {
  console.log('提示：DSH 服务把注册表缓存在内存里 —— **需要重启 DSH** 才会读到这里的结果。');
}