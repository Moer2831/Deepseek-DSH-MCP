/**
 * 会话元信息读取。
 *
 * ACP 的 session/list 只返回 {sessionId, cwd}，不含标题；而 DSH 的会话标题是以
 * `session/title` 事件记录在会话日志里的。投影缓存（session_projcache）把它们折叠成
 * 每会话一个纯 JSON 文件，读取不需要解开多帧 zstd 日志，所以这里是首选读取路径。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DSH_HOME } from './config.mjs';

function projCachePath(sessionId) {
  return join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
}

/**
 * 读取一个会话的投影缓存。
 * @param {string} sessionId
 * @returns {{title?:string,lastPromptAt?:number,usage?:object,pressure?:object,model?:object,sandboxMode?:string}|null}
 */
export function readConversationMeta(sessionId) {
  const p = projCachePath(sessionId);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    const rows = doc?.record?.rows ?? {};
    const val = (k) => rows[k]?.val;
    const model = val('modelSelection');
    return {
      title: typeof val('title') === 'string' ? val('title') : undefined,
      lastPromptAt: val('sessionListMetadata')?.lastPromptAt,
      usage: val('tokenUsage'),
      pressure: val('contextPressure'),
      model: model?.lastUsed,
      sandboxMode: val('sandboxMode'),
      /** 会话自己的权限记录：`{preset, sandbox, approval, seeded}`。接管会话时必须尊重它。 */
      permissions: val('permissions'),
      turns: val('sessionStats')?.turns,
    };
  } catch {
    return null;
  }
}

/** 把 token 用量压成一行人类可读文本。 */
export function formatUsage(usage) {
  const t = usage?.totals;
  if (!t) return null;
  const parts = [];
  if (t.uncachedInputTokens) parts.push(`in=${t.uncachedInputTokens}`);
  if (t.cacheReadTokens) parts.push(`cache=${t.cacheReadTokens}`);
  if (t.outputTokens) parts.push(`out=${t.outputTokens}`);
  return parts.join(' ') || null;
}