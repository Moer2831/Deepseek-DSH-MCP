/**
 * 会话写锁的"持有者登记" + 安全抢占。
 *
 * ## 为什么需要这个模块
 *
 * DSH 的写锁 `SessionWriteLease` 是**跨进程的 Windows 命名内核信号量**
 * （`Local\dsh-session-lock-<sha256>`），语义是"持有者活着就永不过期"。
 * **没有 API 能从活的持有者手里把锁夺走** —— 所以"抢锁"唯一的手段是
 * **杀掉持有者进程**。既然要杀，就必须先知道那是谁，否则可能把用户自己的
 * DSH GUI（连同他正在看的对话）一起杀掉。
 *
 * 于是我们只登记**自己拉起的** DSH 子进程：一个会话一个文件
 *   `<状态文件同目录>/locks/<conversation_id>.json`
 *     { conversation_id, mcp_pid, mcp_token, child_pid, cwd, spawned_at, heartbeat_at }
 *
 * ## 三类持有者，三种处置
 *
 * | 分类 | 判据 | 处置 |
 * |---|---|---|
 * | `none` | 没有登记文件 | 直接尝试；失败则报"未知持有者（多半是你的 DSH GUI）"，**绝不杀** |
 * | `self` | mcp_pid/token 都是自己 | 正常路径，无需抢占 |
 * | `stale-mcp` | 登记在，但 mcp_pid 已死**或**心跳过期 | **可安全杀掉**：那是我们自己实例的孤儿残留 |
 * | `live-mcp` | 登记在且心跳新鲜 | 默认拒绝（另一个宿主可能在用），`force` 才杀 |
 *
 * `mcp_token` 是每个 MCP 进程启动时生成的随机串，用来防 PID 复用误判；
 * `heartbeat_at` 由 reaper 周期刷新，保证"活着但卡死"的实例最终会被判为过期。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATE_FILE, REAP_INTERVAL_MS } from './config.mjs';

/** 每个 MCP 进程一个身份串（防 PID 复用误判）。 */
export const MCP_TOKEN = randomUUID();

/** 心跳超过这个时长就认为那个 MCP 实例已经死了或卡死了。 */
export const STALE_MS = Number(process.env.DSH_MCP_LOCK_STALE_MS ?? 3 * REAP_INTERVAL_MS);

export const LOCKS_DIR = process.env.DSH_MCP_LOCKS_DIR ?? join(dirname(STATE_FILE), 'locks');

/** 某个会话的持有者登记文件路径。 */
export const markerPath = (conversationId) => join(LOCKS_DIR, `${conversationId}.json`);

/** 判断 PID 是否还活着（同用户下可靠；EPERM 表示存在但无权限，也算活着）。 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写（tmp + rename），避免读到半截。 */
function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** 登记"我这个 MCP 进程为这个会话拉起了哪个 DSH 子进程"。 */
export function writeMarker(conversationId, { childPid, cwd }) {
  const p = markerPath(conversationId);
  const prev = readJson(p);
  // ★ 绝不覆盖"别人**还活着**的"登记。
  //   理由：这次 spawn 十有八九正要因撞锁而失败，失败后我们还要靠这条记录判断
  //   "锁在谁手上"。一旦被自己的登记盖掉、又在失败路径里删掉，线索就没了 ——
  //   于是抢占逻辑会把持有者误判成 none（真实 bug：两个实例互相抓瞎）。
  if (prev && prev.mcp_token !== MCP_TOKEN) {
    const holderLive =
      isPidAlive(prev.child_pid) &&
      isPidAlive(prev.mcp_pid) &&
      typeof prev.heartbeat_at === 'number' &&
      Date.now() - prev.heartbeat_at <= STALE_MS;
    if (holderLive) return false;
  }
  const now = Date.now();
  writeJson(p, {
    conversation_id: conversationId,
    mcp_pid: process.pid,
    mcp_token: MCP_TOKEN,
    child_pid: childPid ?? null,
    cwd: cwd ?? null,
    spawned_at: prev?.spawned_at ?? now,
    heartbeat_at: now,
  });
  return true;
}

/** 刷新心跳（reaper 周期调用）。 */
export function heartbeat(conversationId) {
  const p = markerPath(conversationId);
  const m = readJson(p);
  if (!m) return;
  // 只刷新自己的登记：别人的登记不该由我们续命，否则过期判定就失效了
  if (m.mcp_token !== MCP_TOKEN) return;
  m.heartbeat_at = Date.now();
  writeJson(p, m);
}

/** 删掉登记（进程收尾 / 会话关闭时）。只删自己的。 */
export function removeMarker(conversationId, { force = false } = {}) {
  const p = markerPath(conversationId);
  const m = readJson(p);
  if (m && !force && m.mcp_token !== MCP_TOKEN) return false;
  try {
    rmSync(p, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readMarker(conversationId) {
  return readJson(markerPath(conversationId));
}

/**
 * 判定当前持有者属于哪一类。
 * @returns {{kind:'none'|'self'|'stale-mcp'|'live-mcp', marker:object|null, childAlive:boolean, mcpAlive:boolean, ageMs:number|null, reason:string}}
 */
export function classifyHolder(conversationId) {
  const marker = readMarker(conversationId);
  if (!marker) {
    return {
      kind: 'none',
      marker: null,
      childAlive: false,
      mcpAlive: false,
      ageMs: null,
      reason: '没有登记文件：持有者不是本 MCP 拉起的进程（多半是你自己的 DSH GUI）',
    };
  }
  const childAlive = isPidAlive(marker.child_pid);
  const mcpAlive = isPidAlive(marker.mcp_pid);
  const ageMs = typeof marker.heartbeat_at === 'number' ? Date.now() - marker.heartbeat_at : null;
  const isSelf = marker.mcp_pid === process.pid && marker.mcp_token === MCP_TOKEN;

  if (!childAlive) {
    return { kind: 'none', marker, childAlive, mcpAlive, ageMs, reason: '登记还在，但它记录的 DSH 子进程已经退出（锁已释放）' };
  }
  if (isSelf) {
    return { kind: 'self', marker, childAlive, mcpAlive, ageMs, reason: '是本进程自己拉起的子进程' };
  }
  const stale = !mcpAlive || (ageMs !== null && ageMs > STALE_MS);
  if (stale) {
    return {
      kind: 'stale-mcp',
      marker,
      childAlive,
      mcpAlive,
      ageMs,
      reason: mcpAlive
        ? `持有者 MCP 进程（PID ${marker.mcp_pid}）还在，但心跳已过期 ${Math.round(ageMs / 1000)}s（判定为卡死）`
        : `持有者 MCP 进程（PID ${marker.mcp_pid}）已经退出，留下孤儿子进程 PID ${marker.child_pid}`,
    };
  }
  return {
    kind: 'live-mcp',
    marker,
    childAlive,
    mcpAlive,
    ageMs,
    reason: `另一个**活着**的 dsh-mcp 实例（PID ${marker.mcp_pid}）正持有它，心跳 ${Math.round(ageMs / 1000)}s 前`,
  };
}

/**
 * 杀掉一个 DSH 子进程。**只允许对 classification 判定为 `stale-mcp` / `live-mcp(force)`
 * 的、由本 MCP 登记过的进程调用** —— 调用方负责先做分类。
 */
export function killHolderChild(pid) {
  if (!pid || !isPidAlive(pid)) return { killed: false, reason: '进程已经不在了' };
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {
    return { killed: false, reason: `杀不掉: ${e.message}` };
  }
  return { killed: true, reason: `已向 PID ${pid} 发送 SIGKILL` };
}

/**
 * 启动清理：删掉"MCP 已死 + 子进程也死了"的登记文件。
 * 注意**不删**那些子进程还活着的登记 —— 那正是后面抢占要用的线索。
 */
export function pruneDeadMarkers() {
  if (!existsSync(LOCKS_DIR)) return { removed: 0, orphans: 0 };
  let removed = 0;
  let orphans = 0;
  for (const f of readdirSync(LOCKS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const p = join(LOCKS_DIR, f);
    const m = readJson(p);
    if (!m) {
      rmSync(p, { force: true });
      removed++;
      continue;
    }
    const childAlive = isPidAlive(m.child_pid);
    const mcpAlive = isPidAlive(m.mcp_pid);
    const age = typeof m.heartbeat_at === 'number' ? Date.now() - m.heartbeat_at : Infinity;
    const stale = !mcpAlive || age > STALE_MS;
    if (!childAlive && stale) {
      rmSync(p, { force: true });
      removed++;
    } else if (childAlive && stale) {
      orphans++;
    }
  }
  return { removed, orphans };
}

/** 列出所有"孤儿持有者"（MCP 已死/卡死，但子进程还活着握着锁）—— 可安全抢占的目标。 */
export function listOrphans() {
  if (!existsSync(LOCKS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(LOCKS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const m = readJson(join(LOCKS_DIR, f));
    if (!m) continue;
    if (!isPidAlive(m.child_pid)) continue;
    const mcpAlive = isPidAlive(m.mcp_pid);
    const age = typeof m.heartbeat_at === 'number' ? Date.now() - m.heartbeat_at : Infinity;
    if (!mcpAlive || age > STALE_MS) {
      out.push({ conversation_id: m.conversation_id, child_pid: m.child_pid, mcp_pid: m.mcp_pid, age_ms: age === Infinity ? null : age });
    }
  }
  return out;
}

/** 判断一个错误是不是"写锁被占用"。DSH 的原文 + ACP 包装后的形态都要认。 */
export function isLeaseError(message) {
  const s = String(message ?? '');
  return (
    /already owned/i.test(s) ||
    /active write handle/i.test(s) ||
    /writer-held/i.test(s) ||
    /SessionAlreadyOwned/.test(s) ||
    /已被占用/.test(s)
  );
}

/** 把锁错误翻译成调用方能照做的中文说明。 */
export function describeLeaseConflict(conversationId, holder) {
  const lines = [
    `会话 ${conversationId} 的写锁被别的 DSH 进程占用，本服务无法接管。`,
    `判定：${holder.reason}`,
  ];
  if (holder.kind === 'stale-mcp') {
    lines.push('→ 这是本服务自己留下的孤儿进程，可以安全抢占：调用 dsh_takeover 即可（无需 force）。');
  } else if (holder.kind === 'live-mcp') {
    lines.push('→ 另一个活着的 dsh-mcp 实例正在用它（可能是你另一个宿主窗口）。');
    lines.push('  建议：在那边用 dsh_release 交还；确实要夺过来再调 dsh_takeover(force=true)。');
  } else {
    lines.push('→ 持有者不是本服务拉起的进程，**多半是你自己的 DSH GUI 正开着这个会话**。');
    lines.push('  本服务**不会**去杀它（那会连你的界面和正在看的对话一起杀掉）。');
    lines.push('  请在那个窗口里关掉该会话（或切走），然后重试。');
  }
  return lines.join('\n');
}