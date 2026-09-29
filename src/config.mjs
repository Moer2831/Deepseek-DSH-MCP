/**
 * 运行期配置与路径解析。
 *
 * 设计原则：所有外部依赖（DSH 安装位置、profile 名、状态文件位置）都能用环境变量覆盖，
 * 因为本服务是被 Codex/Claude 以未知环境拉起的。
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(HERE, '..');

/** 相对 DSH 包入口的固定尾巴。 */
const DSH_ENTRY = join('@deepseek-ai', 'dsh', 'lib', 'bin.js');

/**
 * 在 npx 缓存目录里按通配找 DSH 入口。
 * npx 的缓存目录名带一个随机 hash（`_npx/<hash>/`），写死会随环境失效，所以这里筛一遍。
 */
function findInNpxCache() {
  const roots = [
    join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'),
    join(homedir(), '.npm', '_npx'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(root, e.name, 'node_modules', DSH_ENTRY);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * 解析 DSH CLI 入口。按顺序尝试：
 *   1) DSH_BIN 环境变量（最可靠，推荐显式设置）
 *   2) npx 缓存里的通配搜索（`_npx/<hash>/node_modules/@deepseek-ai/dsh/lib/bin.js`）
 *   3) npm 全局安装目录
 *
 * 用 `node <bin.js>` 而不是 `dsh`/`dsh.cmd`/`dsh.ps1`：Windows 的 PowerShell 执行策略
 * 会拦住 `.ps1` shim，而直接跑入口文件在所有平台上都稳。
 */
export function resolveDshBin() {
  const explicit = process.env.DSH_BIN;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`DSH_BIN 指向的文件不存在: ${explicit}`);
    }
    return explicit;
  }
  const candidates = [
    findInNpxCache(),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', DSH_ENTRY),
    join('/usr', 'local', 'lib', 'node_modules', DSH_ENTRY),
    join('/usr', 'lib', 'node_modules', DSH_ENTRY),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    'DSH CLI 入口未找到。请设置环境变量 DSH_BIN 指向 @deepseek-ai/dsh/lib/bin.js\n' +
      '  例如: DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js',
  );
}

/** 用于驱动 DSH 的 profile（由 acp 模板派生，内置私有 provider 配置）。 */
export const DSH_PROFILE = process.env.DSH_MCP_PROFILE ?? 'dsh-mcp';

/** DSH 主目录；沿用默认值以便共享凭据与会话历史。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/** 会话注册表（跨 MCP 服务重启存活）。 */
export const STATE_FILE =
  process.env.DSH_MCP_STATE ?? join(PKG_ROOT, '.state', 'conversations.json');

/**
 * 异步派活"完成哨兵"文件的根目录。每个 run 终止时在这里写一个独立小文件，
 * 供调用方用文件系统等待完成（无需轮询 MCP 工具）。默认与状态文件同目录下的 runs/。
 * 路径实际为 <RUNS_DIR>/<conversation_id>/<run_id>.json —— 按会话分目录，
 * 杜绝不同会话在同一毫秒生成同名 run_id 时相撞（run_id 的序号是每会话独立计数的）。
 */
export const RUNS_DIR = process.env.DSH_MCP_RUNS_DIR ?? join(dirname(STATE_FILE), 'runs');

/**
 * 哨兵文件里是否带上**思考内容**。
 *
 * 默认 **不带** —— 本项目的红线是"思考内容不落盘、不写日志"。哨兵的用途是
 * "跑完了 + 拿结果"，正文（answer）与思考统计已足够；`result.thinking` 会被剥掉并
 * 标记 `thinking_omitted: true`，避免调用方以为字段丢了。
 *
 * 确实需要把思考一并落盘时，设 DSH_MCP_SENTINEL_INCLUDE_REASONING=1（会打破上面那条保证）。
 */
export const SENTINEL_INCLUDE_REASONING = process.env.DSH_MCP_SENTINEL_INCLUDE_REASONING === '1';

/**
 * 哨兵文件的保留时长（毫秒）。服务**启动时**清理超过此时长的哨兵与残留 tmp。
 * 默认 7 天；设为 0 关闭清理（哨兵将永久保留）。
 *
 * 为什么要清理：哨兵内含完整正文，长期不清理会无声地堆积占用磁盘。
 */
export const SENTINEL_TTL_MS = Number(
  process.env.DSH_MCP_SENTINEL_TTL_MS ?? 7 * 24 * 60 * 60 * 1000,
);

/**
 * 把 Windows 路径转成 Bash / MSYS 形式（`D:\a\b` → `/d/a/b`），非 Windows 原样返回。
 *
 * 存在的意义：调用方的后台等待任务通常跑在 Bash 里，而 sentinel_file 是 Windows 形式，
 * 手工转换（盘符小写 + 反斜杠改斜杠）很容易写错 —— 写错就会一直等到超时。
 */
export function toPosixPath(p) {
  if (process.platform !== 'win32' || typeof p !== 'string') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** 单条 prompt 的最长等待时间（毫秒）。DSH 干活可以很久，默认 30 分钟。 */
export const PROMPT_TIMEOUT_MS = Number(process.env.DSH_MCP_PROMPT_TIMEOUT_MS ?? 30 * 60 * 1000);

/** 普通 ACP 请求的超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = Number(process.env.DSH_MCP_REQUEST_TIMEOUT_MS ?? 60_000);

/** 会话空闲多久后回收其 DSH 进程（毫秒）。回收不等于丢弃——会话可用 resume 复活。 */
export const IDLE_TTL_MS = Number(process.env.DSH_MCP_IDLE_TTL_MS ?? 5 * 60 * 1000);

/** 后台回收扫描间隔（毫秒）。 */
export const REAP_INTERVAL_MS = Number(process.env.DSH_MCP_REAP_INTERVAL_MS ?? 30_000);

/** 权限档 → 该档下的默认审批策略。 */
export const PERMISSION_TIERS = ['read-only', 'workspace-write', 'danger-full-access'];
export const DEFAULT_PERMISSION = process.env.DSH_MCP_PERMISSION ?? 'danger-full-access';

/**
 * 审批处理策略：
 *   auto-allow —— 直接放行（适合 danger-full-access 之外的档位要跑通时）
 *   auto-deny  —— 一律拒绝（保持"真只读"）
 *   ask        —— 挂起为待决审批，交给调用方用 dsh_approval_decide 裁决
 */
export const APPROVAL_POLICIES = ['auto-allow', 'auto-deny', 'ask'];

/** 未显式指定时，按权限档推导审批策略：只读档一律拒绝，其余放行。 */
export function defaultApprovalPolicy(permission) {
  return permission === 'read-only' ? 'auto-deny' : 'auto-allow';
}

/** 思考内容展示档位。 */
export const REASONING_MODES = ['hide', 'marker', 'summary', 'full'];
export const DEFAULT_REASONING = 'hide';

/**
 * 会话的"思考深度"（ACP 的 reasoning_effort 配置项）。
 * ACP 默认值是空串（= Provider default），不是我们想要的；默认显式设成 max。
 */
export const REASONING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_REASONING_EFFORT = process.env.DSH_MCP_REASONING_EFFORT ?? 'max';

/**
 * 工作区登记模式：
 *   project（默认）—— 登记，但跳过系统临时目录（%TEMP% 那种"工作区"不该进 GUI）
 *   all           —— 全都登记（含临时目录，适合跑测试时观察）
 *   0             —— 完全关闭（关闭后 MCP 建的会话在你的 DSH GUI 里看不到）
 */
export const REGISTER_WORKSPACE = (() => {
  const v = process.env.DSH_MCP_REGISTER_WORKSPACE;
  if (v === '0' || v === 'false') return false;
  if (v === 'all') return 'all';
  return 'project';
})();

/**
 * 日志策略。
 *
 * 默认 **silent：一个字都不输出**。MCP 的 stdout 是协议通道，stdout 必须干净；
 * 而 stderr 也默认保持安静，原因有二：
 *   1) 本服务是被 Codex/Claude 拉起的，它的 stderr 会直接进对方的日志/终端；
 *   2) DSH 进程本身的 stderr 可能夹带模型输出（含**思考内容**），绝不能顺手转发。
 *
 * 因此：
 *   silent（默认）—— 什么都不打印
 *   info          —— 只打印本服务自己的生命周期事件，**绝不包含 DSH 的任何输出**
 *   debug         —— 追加更细的本服务事件；仍然不打印 DSH 的输出内容
 *   DSH_MCP_LOG_STDERR=1 才额外打印 DSH 的 stderr（**可能含思考内容**，默认关闭）
 *
 * 另外：任何情况下都不把思考内容写进日志或落盘。会话状态文件里只有元数据。
 */
export const LOG_LEVEL = String(process.env.DSH_MCP_LOG ?? 'silent').toLowerCase();
export const LOG_DSH_STDERR = process.env.DSH_MCP_LOG_STDERR === '1';

/** 造一个分级 logger。所有模块统一用它，避免散落的 console/process.stderr 调用。 */
export function createLogger(level = LOG_LEVEL) {
  const rank = { silent: 0, info: 1, debug: 2 }[level] ?? 0;
  const write = (m) => {
    try {
      process.stderr.write(`${m}\n`);
    } catch {
      /* stderr 不可写时静默忽略，绝不影响协议通道 */
    }
  };
  return {
    level,
    rank,
    info: (m) => rank >= 1 && write(m),
    debug: (m) => rank >= 2 && write(m),
    /** 仅当显式开启 DSH_MCP_LOG_STDERR 时才转发子树进程的原始输出。 */
    dshStderr: (m) => LOG_DSH_STDERR && write(m),
  };
}