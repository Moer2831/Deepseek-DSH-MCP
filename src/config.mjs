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
    join(homedir(), '.dsh', 'profiles', 'node_modules', DSH_ENTRY),
    join(homedir(), '.dsh', 'node_modules', DSH_ENTRY),
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

/**
 * `wait=true` 时的**等待**上限（毫秒）。**默认 0 = 不设超时（一直等）**。
 *
 * 为什么不给默认值：只有调用方知道任务要多久，我们凭空发明一个"30 分钟"只会误伤长任务。
 * 而且现在超时**不再破坏任何东西**（到期只是降级为后台：回合继续跑、结果照常由哨兵送达），
 * 所以"等多久"纯粹是调用方的偏好，不该由我们替他决定。
 * 需要全局兜底时设 DSH_MCP_PROMPT_TIMEOUT_MS。
 *
 * 另注：`dsh_send` **默认 `wait=false`**，压根不走等待路径，这个值通常用不上。
 */
export const PROMPT_TIMEOUT_MS = numEnv('DSH_MCP_PROMPT_TIMEOUT_MS', 0);

/** 普通 ACP 请求的超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = numEnv('DSH_MCP_REQUEST_TIMEOUT_MS', 60_000);

/**
 * 会话空闲多久后回收其 DSH 进程（毫秒）。
 *
 * ★★ **默认 `0` = 永不回收**（MCP 一直握着写锁，GUI 抢不走）。
 *   为什么默认如此：空闲回收是写锁**唯一**会变空的时刻，而锁一空，用户在 web 里点开那条
 *   会话就会让 `dsh web` **永久**持有它（实测：切走 ✗ 等待 ✗ 归档 ✗ 都不释放），
 *   本服务之后每一次 resume 都失败 —— 这正是"任务跑完后接不回去"的成因。
 *   不回收时（实测）：**你在 GUI 里点开那条会话是"只读打开"** —— 你照样能看到内容 ✓，
 *   而写锁留在本服务手里 ✓（用独立实例探测确认过：持有者是本服务的 PID、心跳新鲜）。
 *   也就是"**你看得见，我们写得动**"，两边都不受影响。
 *   代价：每个会话常驻一个 DSH 进程（例如 10 个会话约 1~3 GB）。
 *   想省内存就设成毫秒数（如 `300000` = 5 分钟），但那就回到了"锁可能被 GUI 抢走"的世界。
 *   （无论哪种模式，锁心跳都会一直续 —— 否则别的实例会误判我们卡死并抢占。）
 */
/**
 * 读一个数值型环境变量。**空串/纯空白一律当作"未设置"→ 用默认值**。
 *
 * 为什么必须这样：`.env` 与各种配置界面很容易产出空串（`DSH_MCP_MAX_LIVE=`），
 * 而 `Number('')` 是 **0** —— 于是"我什么都没设"会被读成"我要 0"，
 * 而 0 在这些开关里往往是个**有含义的极值**（0 = 不限 / 永不回收）✗。
 * 这类"看起来没配、行为却变了"的坑最难查，所以统一在这里挡掉。
 */
export function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const rawIdle = numEnv('DSH_MCP_IDLE_TTL_MS', 0);
/** ★ `<= 0` 或非法值一律当作"永不回收"。
 *  否则 `-1` 会被算成 `cutoff = now + 1` → **立刻回收**（谁会想到负数=马上收 ✗），
 *  `NaN` 更糟：比较永远为假，行为取决于具体分支。宁可把"奇怪的输入"统一压到安全侧。 */
export const IDLE_TTL_MS = Number.isFinite(rawIdle) && rawIdle > 0 ? rawIdle : 0;

/** 后台回收扫描间隔（毫秒）。**下限 200 毫秒**：0/负数会变成空转的紧循环 ✗（还会把心跳刷爆）。
 *  下限留得比较低，是为了让测试能把间隔调小去观察心跳与回收时序。 */
const rawReap = numEnv('DSH_MCP_REAP_INTERVAL_MS', 30_000);
export const REAP_INTERVAL_MS = Number.isFinite(rawReap) && rawReap >= 200 ? rawReap : 30_000;

/**
 * 最多同时保活多少个会话进程（`0` = 不限）。
 *
 * 为什么需要它：`IDLE_TTL_MS=0`（永不回收）能保证"GUI 抢不走写锁"，但代价是
 * **每个用过的会话永久占一个 DSH 子进程** —— 实测约 120MB/个（线性），10 个就 ~1.2GB ✗。
 * 超过上限时**回收最久没用过的那个**（busy 的绝不回收）：
 *   - 保活窗口内的会话：写锁在手，GUI 抢不走 ✓
 *   - 窗口外的：进程回收、内存释放 ✓（下次派活自动 resume，无损 ✓）
 * 即"**内存有界，锁尽量在手**"。
 *
 * **默认 8**（≈1GB）：让"内存有界"成为默认行为，而不是要用户先发现再配 ✗。
 * 被回收是无损的（会话日志在磁盘上 ✓），代价只是那个会话的写锁会空出来、
 * 且下次派活要 cold start。想做更多并行就调大；机器大也可以设 0（不限）。
 */
const rawMaxLive = numEnv('DSH_MCP_MAX_LIVE', 8);
export const MAX_LIVE = Number.isFinite(rawMaxLive) && rawMaxLive > 0 ? Math.floor(rawMaxLive) : 0;

/**
 * `dsh_list` 的"磁盘探测"结果缓存多久（毫秒）。
 *
 * 为什么要缓存：列会话时要 spawn 一个 DSH 进程做 `session/list`（**实测约 1 秒**），
 * 连着调几次就反复拉进程。缓存 10 秒既省掉这些开销，也不至于让"别的实例刚建的会话"久等。
 * 想看实时结果可传 `include_closed=false`（只列本服务已打开的，毫秒级）。
 */
export const LIST_PROBE_TTL_MS = numEnv('DSH_MCP_LIST_PROBE_TTL_MS', 10_000);

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