#!/usr/bin/env node
/**
 * dsh-mcp 入口：以 MCP stdio 服务端方式运行，用 DSH (ACP) 作为后端。
 *
 * 环境变量：
 *   DSH_BIN                     DSH CLI 入口（默认探测 npx 缓存位置）
 *   DSH_MCP_PROFILE             驱动用的 DSH profile（默认 dsh-mcp）
 *   DSH_MCP_STATE               会话注册表路径（默认 <仓库>/.state/conversations.json）
 *   DSH_MCP_PERMISSION          新建会话的默认权限档（默认 danger-full-access）
 *   DSH_MCP_IDLE_TTL_MS         空闲多久回收会话进程（默认 5 分钟）
 *   DSH_MCP_PROMPT_TIMEOUT_MS   wait=true 时的等待上限（默认 0 = 不设超时）
 *   DSH_MCP_LOCK_STALE_MS       写锁登记多久没心跳算"持有者失联"（默认 90 秒）
 *   DSH_MCP_LOG                 silent(默认) | info | debug —— 日志级别
 *   DSH_MCP_LOG_STDERR          1 才转发 DSH 子树进程的原始 stderr（可能含思考内容）
 */

import { createLogger } from '../src/config.mjs';
import { Hub } from '../src/hub.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { listOrphans, pruneDeadMarkers } from '../src/locks.mjs';

const log = createLogger();

const hub = new Hub({ log });
hub.load();
hub.startReaper();
// 启动时清一次过期哨兵（哨兵内含正文，长期不清理会无声堆积）
const prunedSentinels = hub.pruneSentinels();
if (prunedSentinels.pruned) {
  log.info(
    `[dsh-mcp] 启动清理：删除 ${prunedSentinels.pruned} 个过期哨兵、${prunedSentinels.dirs_removed} 个空目录`,
  );
}
// 写锁登记清理：删掉"MCP 已死 + 子进程也死了"的记录；**保留**子进程还活着的那些 ——
// 它们是"孤儿持有者"（上一代 MCP 崩了但子进程还握着锁），是 dsh_takeover 要抢占的目标。
const deadMarkers = pruneDeadMarkers();
const orphans = listOrphans();
if (deadMarkers.removed || orphans.length) {
  log.info(
    `[dsh-mcp] 写锁登记：清理 ${deadMarkers.removed} 条失效记录；发现 ${orphans.length} 个孤儿持有者` +
      (orphans.length ? `（会话 ${orphans.map((o) => o.conversation_id.slice(0, 8)).join(', ')} 可用 dsh_takeover 抢占）` : ''),
  );
}
if (orphans.length) log.info(`[dsh-mcp] 孤儿持有者会话: ${orphans.map((o) => o.conversation_id).join(', ')}`);

const server = createMcpServer({ hub, log });
server.start();

log.info(`[dsh-mcp] 已启动（注册表载入 ${hub.conversations.size} 个会话，日志级别 ${log.level}）`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`[dsh-mcp] 收到 ${signal}，正在收尾…`);
  try {
    await hub.shutdown();
  } catch (e) {
    log.info(`[dsh-mcp] 收尾异常: ${e.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.stdin.on('end', () => shutdown('stdin EOF'));