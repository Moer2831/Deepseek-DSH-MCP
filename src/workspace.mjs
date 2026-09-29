/**
 * 把 MCP 创建的会话登记进 DSH 的工作区注册表。
 *
 * 为什么需要：DSH 的 GUI 是**按工作区分组**展示会话的，而 `workspace.json` 里只记
 * 已经被登记过的工作区。不登记的话，MCP 建出来的会话在磁盘上存在、却**在你的 DSH
 * GUI 里根本看不到**。
 *
 * 三个能力：
 *   registerWorkspace()      —— 建会话时登记单个工作区（默认跳过系统临时目录）
 *   backfillWorkspaces()     —— 回填：扫描磁盘上所有会话头，按 header.cwd 归组补登记
 *                                （用于修复本功能上线前创建的历史会话）
 *   pruneTempWorkspaces()    —— 清理：把临时目录那些工作区条目从注册表移除
 *
 * 风险说明：`workspace.json` 是单文件共享存储（原子写、后写覆盖）。本模块只在建会话
 * 或手动执行回填时做一次读-改-写，窗口很小；但仍与 GUI 存在理论上的覆盖可能。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { DSH_HOME, REGISTER_WORKSPACE } from './config.mjs';

const WORKSPACE_FILE = join(DSH_HOME, 'storages', 'workspace.json');
const SESSIONS_ROOT = join(DSH_HOME, 'sessions');

/** 路径比较用：Windows 下大小写不敏感，且忽略结尾分隔符。 */
const normPath = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();

/**
 * DSH 在 create 时把 `path` 存成 `fs.realpath` 的规范形式（见 workspace spec 注释），
 * 所以我们也必须存 realpath，否则同一个目录可能出现两条不等价的记录。
 */
export function canonicalPath(p) {
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    return p;
  }
}

/** 路径是否位于系统临时目录下（这类"工作区"不该出现在 GUI 里）。 */
export function isTempPath(p) {
  try {
    const t = normPath(tmpdir());
    return normPath(p).startsWith(t);
  } catch {
    return false;
  }
}

/**
 * 是否是"测试用桌面目录"。
 *
 * 覆盖两类命名（都是本仓库测试自己造的，绝不会碰到真实项目）：
 *   - `Desktop\dsh-mcp-test-A|B`（验收/工作区效果测试）
 *   - `Desktop\dsh-conc-A|B|C`（并发测试）
 */
export function isTestDesktopPath(p) {
  return /[\\/]Desktop[\\/](dsh-mcp-test-[AB]|dsh-conc-[ABC])([\\/]|$)/i.test(String(p ?? ''));
}

/**
 * 是否该登记这个工作区。
 * 模式（DSH_MCP_REGISTER_WORKSPACE）：project（默认，跳过系统临时目录）| all | 0（关闭）
 */
export function shouldRegister(cwd) {
  if (REGISTER_WORKSPACE === false) return false;
  if (REGISTER_WORKSPACE === 'all') return true;
  return !isTempPath(cwd);
}

function emptyDoc() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: null,
    },
    tables: { workspaces: {} },
  };
}

function readDoc() {
  let doc = emptyDoc();
  if (existsSync(WORKSPACE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') doc = parsed;
    } catch {
      /* 坏文件就用空结构重建，避免把 GUI 的注册表彻底写坏 */
    }
  }
  doc.global ??= emptyDoc().global;
  doc.global.workspaceIds ??= [];
  doc.global.archivedSessionIds ??= [];
  doc.global.pinnedSessionIds ??= [];
  doc.tables ??= { workspaces: {} };
  doc.tables.workspaces ??= {};
  return doc;
}

function writeDoc(doc) {
  mkdirSync(dirname(WORKSPACE_FILE), { recursive: true });
  const tmp = `${WORKSPACE_FILE}.dshmcp.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  renameSync(tmp, WORKSPACE_FILE);
}

/** 在已读入的 doc 里找到（或新建）某路径对应的工作区条目。 */
function ensureWorkspace(doc, cwd, nowIso) {
  const canon = canonicalPath(cwd);
  const target = normPath(canon);
  let wsId = Object.keys(doc.tables.workspaces).find(
    (k) => normPath(doc.tables.workspaces[k]?.path) === target,
  );
  let created = false;
  if (!wsId) {
    wsId = randomUUID();
    doc.tables.workspaces[wsId] = {
      path: canon, // 与 DSH 自身一致：存 realpath 规范形式
      title: basename(canon) || canon,
      sessionIds: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (!doc.global.workspaceIds.includes(wsId)) doc.global.workspaceIds.push(wsId);
    created = true;
  }
  const ws = doc.tables.workspaces[wsId];
  ws.sessionIds ??= [];
  return { wsId, ws, created };
}

/**
 * 登记单个工作区并把会话挂上去（建会话时调用）。
 * @returns {{registered:boolean, workspace_id?:string, workspace_created?:boolean, error?:string}}
 */
export function registerWorkspace(cwd, sessionId) {
  if (!shouldRegister(cwd)) {
    return {
      registered: false,
      error: `按登记模式跳过（${REGISTER_WORKSPACE}${isTempPath(cwd) ? '，且该路径在系统临时目录下' : ''}）`,
    };
  }
  try {
    const doc = readDoc();
    const nowIso = new Date().toISOString();
    const { wsId, ws, created } = ensureWorkspace(doc, cwd, nowIso);
    if (sessionId && !ws.sessionIds.includes(sessionId)) ws.sessionIds.push(sessionId);
    ws.updatedAt = nowIso;
    writeDoc(doc);
    return { registered: true, workspace_id: wsId, workspace_created: created };
  } catch (e) {
    return { registered: false, error: e.message };
  }
}

/** 读取一个会话头的第一个 zstd 帧（就是头行）。 */
function readHeader(file) {
  try {
    const text = zstdDecompressSync(readFileSync(file)).toString('utf8');
    return JSON.parse(text.split(/\r?\n/).find(Boolean));
  } catch {
    return null;
  }
}

/** 扫描磁盘上所有会话，按 header.cwd 归组。数据源是会话头，不是目录名（目录名有损）。 */
export function scanSessions() {
  const byCwd = new Map();
  if (!existsSync(SESSIONS_ROOT)) return byCwd;
  for (const bucket of readdirSync(SESSIONS_ROOT)) {
    const bucketPath = join(SESSIONS_ROOT, bucket);
    let dirs;
    try {
      dirs = readdirSync(bucketPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const header = readHeader(join(bucketPath, d.name, 'session.v4.jsonl.zstd'));
      if (!header?.cwd || !header?.id) continue;
      if (!byCwd.has(header.cwd)) byCwd.set(header.cwd, []);
      byCwd.get(header.cwd).push({
        id: header.id,
        origin: header.origin ?? null,
        parent: header.parentSession ?? null,
      });
    }
  }
  return byCwd;
}

/**
 * 按会话 id 在会话存储里找到它的头（跨所有分桶扫描）。
 *
 * 用于"注册表里没有、但会话其实在磁盘上"的场景：别的 dsh-mcp 实例建的、注册表被并发写覆盖丢的、
 * 或者根本是别的 profile / GUI 建的。**会话存储才是权威，注册表只是缓存。**
 *
 * 会对 id 做形状校验（只允许 UUID / `session-` 前缀那类字符），避免 `..` 之类逃出会话目录。
 */
export function findSessionHeader(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{4,80}$/.test(sessionId)) return null;
  if (!existsSync(SESSIONS_ROOT)) return null;
  for (const bucket of readdirSync(SESSIONS_ROOT)) {
    const f = join(SESSIONS_ROOT, bucket, sessionId, 'session.v4.jsonl.zstd');
    if (!existsSync(f)) continue;
    const header = readHeader(f);
    if (header?.id === sessionId) return header;
  }
  return null;
}

/**
 * 回填：按磁盘上的会话头把所有工作区补登记一遍。
 * 用于修复"本功能上线前创建的会话在 GUI 里看不到"。
 */
export function backfillWorkspaces({ includeTemp = false, dryRun = false, pruneMissing = true } = {}) {
  const byCwd = scanSessions();
  const doc = readDoc();
  const nowIso = new Date().toISOString();
  const stats = {
    workspaces_created: 0,
    workspaces_existing: 0,
    sessions_added: 0,
    sessions_scanned: 0,
    temp_skipped_sessions: 0,
    temp_skipped_workspaces: 0,
    /** 磁盘上已不存在、被从注册表摘掉的 sessionId 数量。 */
    sessions_pruned: 0,
  };

  /** 磁盘上真实存在的会话 id 全集。 */
  const live = new Set();
  for (const sessions of byCwd.values()) for (const s of sessions) live.add(s.id);

  for (const [cwd, sessions] of byCwd) {
    stats.sessions_scanned += sessions.length;
    if (!includeTemp && isTempPath(cwd)) {
      stats.temp_skipped_sessions += sessions.length;
      stats.temp_skipped_workspaces += 1;
      continue;
    }
    const { ws, created } = ensureWorkspace(doc, cwd, nowIso);
    created ? stats.workspaces_created++ : stats.workspaces_existing++;
    for (const s of sessions) {
      if (!ws.sessionIds.includes(s.id)) {
        ws.sessionIds.push(s.id);
        stats.sessions_added++;
      }
    }
    ws.updatedAt = nowIso;
  }

  // 对账：摘掉磁盘上已经不存在的会话（例如刚被清理掉的测试会话）
  if (pruneMissing) {
    for (const id of Object.keys(doc.tables.workspaces)) {
      const ws = doc.tables.workspaces[id];
      if (!Array.isArray(ws?.sessionIds)) continue;
      const kept = ws.sessionIds.filter((sid) => live.has(sid));
      stats.sessions_pruned += ws.sessionIds.length - kept.length;
      ws.sessionIds = kept;
    }
    doc.global.archivedSessionIds = (doc.global.archivedSessionIds ?? []).filter((sid) => live.has(sid));
    doc.global.pinnedSessionIds = (doc.global.pinnedSessionIds ?? []).filter((sid) => live.has(sid));
  }

  if (!dryRun) writeDoc(doc);
  return stats;
}

/**
 * 删除测试会话（**这是唯一会动磁盘会话文件的函数**，所以规则写得很死）。
 *
 * 只会删这几类，其余一律不碰：
 *   1) 会话头里的 cwd 位于系统临时目录下
 *   2) 会话头里的 cwd 匹配 Desktop\dsh-mcp-test-* —— 传 tempOnly 可关掉这一条
 *   3) ids 里显式指定的
 *
 * @param {object} opts
 * @param {boolean} [opts.tempOnly] 只删临时目录下的。自动清理（测试套件收尾）用这条，
 *   绝不动桌面或真实项目里的任何会话。
 * @param {boolean} [opts.idsOnly] **只删 ids 里点名的**，忽略上面两条规则。
 *   要精确删某几个会话时用这条（否则一条临时目录规则会把别的也一起带走 —— 真实踩过）。
 */
export function purgeTestSessions({ dryRun = false, ids = [], tempOnly = false, idsOnly = false } = {}) {
  const explicit = new Set(ids);
  const victims = [];
  if (existsSync(SESSIONS_ROOT)) {
    for (const bucket of readdirSync(SESSIONS_ROOT)) {
      const bucketPath = join(SESSIONS_ROOT, bucket);
      let dirs;
      try {
        dirs = readdirSync(bucketPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = join(bucketPath, d.name);
        const header = readHeader(join(dir, 'session.v4.jsonl.zstd'));
        if (!header?.id) continue;
        const cwd = header.cwd ?? '';
        const isTemp = isTempPath(cwd);
        const isTestDesktop = !tempOnly && /[\\/]Desktop[\\/]dsh-mcp-test-[AB]([\\/]|$)/i.test(cwd);
        const isExplicit = explicit.has(header.id);
        // idsOnly：只认点名，别的规则全部作废
        if (idsOnly ? !isExplicit : !isTemp && !isTestDesktop && !isExplicit) continue;
        victims.push({
          id: header.id,
          dir,
          cwd,
          reason: isExplicit ? '显式指定' : isTemp ? '临时目录' : '验收测试目录',
          origin: header.origin ?? null,
        });
      }
    }
  }
  if (!dryRun) {
    for (const v of victims) {
      try {
        rmSync(v.dir, { recursive: true, force: true });
      } catch (e) {
        v.error = e.message;
      }
    }
    // 清掉因删空而残留的空分桶目录（每个工作区一个桶，空桶会一直堆着）
    for (const bucket of readdirSync(SESSIONS_ROOT)) {
      const p = join(SESSIONS_ROOT, bucket);
      try {
        if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
      } catch {
        /* 桶被占用或权限问题就跳过 */
      }
    }
    // 删完之后把注册表里对应的 id 也摘掉
    backfillWorkspaces({ includeTemp: true });
  }
  return { count: victims.length, victims };
}

/** 清掉"没有会话且路径已不存在"的空工作区条目。 */
export function pruneEmptyWorkspaces({ dryRun = false } = {}) {
  const doc = readDoc();
  const removed = [];
  for (const id of Object.keys(doc.tables.workspaces)) {
    const ws = doc.tables.workspaces[id];
    const empty = (ws?.sessionIds?.length ?? 0) === 0;
    const gone = !existsSync(ws?.path ?? '');
    if (!empty || !gone) continue;
    removed.push({ id, path: ws.path });
    delete doc.tables.workspaces[id];
    doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== id);
    if (doc.global.defaultWorkspaceId === id) doc.global.defaultWorkspaceId = null;
  }
  if (!dryRun) writeDoc(doc);
  return { removed };
}

/**
 * 清理：把**测试用**的工作区条目从注册表移除（临时的 + 桌面上的测试目录，如 `Desktop\dsh-conc-*`）。
 *
 * 为什么需要它：测试会在桌面和临时目录里造工作区，跑完删掉文件夹，但**注册表条目会留下** ——
 * 于是每跑一次全量测试，你的 GUI 侧栏就多几个空壳 ✗（`pruneEmptyWorkspaces` 靠"无会话且路径不存在"
 * 启发式，实测不一定兜住）。这里按**路径模式**确定性清理，绝不碰真实项目目录。
 */
export function pruneTestWorkspaces({ dryRun = false } = {}) {
  const doc = readDoc();
  const removed = [];
  for (const id of Object.keys(doc.tables.workspaces)) {
    const ws = doc.tables.workspaces[id];
    const p = ws?.path ?? '';
    if (!p) continue;
    if (!isTempPath(p) && !isTestDesktopPath(p)) continue;
    removed.push({ id, path: p, sessions: ws?.sessionIds?.length ?? 0 });
    delete doc.tables.workspaces[id];
    doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== id);
    if (doc.global.defaultWorkspaceId === id) doc.global.defaultWorkspaceId = null;
  }
  if (!dryRun) writeDoc(doc);
  return { removed };
}

/** 清理：把系统临时目录下的工作区条目从注册表移除（**不动磁盘上的会话**）。 */
export function pruneTempWorkspaces({ dryRun = false } = {}) {
  const doc = readDoc();
  const removed = [];
  for (const id of Object.keys(doc.tables.workspaces)) {
    const ws = doc.tables.workspaces[id];
    if (!isTempPath(ws?.path)) continue;
    removed.push({ id, path: ws.path, sessions: ws.sessionIds?.length ?? 0 });
    delete doc.tables.workspaces[id];
    doc.global.workspaceIds = (doc.global.workspaceIds ?? []).filter((x) => x !== id);
    if (doc.global.defaultWorkspaceId === id) doc.global.defaultWorkspaceId = null;
  }
  if (!dryRun) writeDoc(doc);
  return { removed };
}

/** 列出当前注册表里的工作区。 */
export function listWorkspaces() {
  const doc = readDoc();
  return Object.entries(doc.tables.workspaces).map(([id, w]) => ({
    id,
    path: w.path,
    title: w.title,
    sessions: w.sessionIds?.length ?? 0,
    is_temp: isTempPath(w.path),
  }));
}

export { WORKSPACE_FILE, SESSIONS_ROOT };