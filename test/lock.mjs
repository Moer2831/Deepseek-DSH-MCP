/**
 * 写锁（SessionWriteLease）与抢占测试。
 *
 * 背景：DSH 的会话写锁是**跨进程内核信号量**，持有者活着就永不过期，**没有 API 能直接夺走** ——
 * 所以"抢锁"唯一的手段是杀掉持有者进程。既然要杀，就必须先判定那是谁，否则可能把用户
 * 自己的 DSH GUI（连同他正在看的对话）一起杀掉。
 *
 * 本文件覆盖：
 *   [1] 判定逻辑（单元）：锁错误识别、四类持有者分类、孤儿列举、失效登记清理
 *   [2] ★ 端到端：两个真实 MCP 实例抢同一个会话 → 清晰的"被占用"报错（不再是 Internal error）
 *       → dsh_takeover 对"另一个活着的实例"默认拒绝 → force=true 才夺过来
 *   [3] ★ 插话那一轮现在也有哨兵（修复"等待方空等"的回归）
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-mcp-lock-'));
const LOCKS = join(ROOT, 'locks');
const STATE = join(ROOT, 'state.json');
// 必须在 import locks.mjs 之前设好（模块顶层会读 env）——所以用动态 import
process.env.DSH_MCP_LOCKS_DIR = LOCKS;
process.env.DSH_MCP_LOCK_STALE_MS = '90000';

let pass = 0;
let failCount = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { McpClient } = await import('./mcp-client.mjs');
const locks = await import('../src/locks.mjs');

const writeRawMarker = (id, obj) => {
  mkdirSync(LOCKS, { recursive: true });
  writeFileSync(join(LOCKS, `${id}.json`), JSON.stringify(obj, null, 2), 'utf8');
};

try {
  // ── [1] 判定逻辑 ─────────────────────────────────────────────
  console.log('\n[1] 判定逻辑（单元）');

  check('识别 DSH 原文的锁错误', locks.isLeaseError('session "x" is already owned by an active write handle'));
  check('识别 ACP 包装后的形态', locks.isLeaseError('[-32603] Internal error | data={"details":"SessionAlreadyOwnedError"}'));
  check('识别 GUI 侧的中文提示', locks.isLeaseError('当前会话已被占用，可能是其他正在运行的 DSH 导致的'));
  check('不误判普通错误', !locks.isLeaseError('恢复会话失败：DSH 进程退出（code=1）'));

  const alive = process.ppid; // 一个确定活着、且不是自己的 PID
  check('拿到一个外部存活 PID 用于构造场景', locks.isPidAlive(alive));

  // 没有登记 → none
  check('无登记 → none', locks.classifyHolder('c-none').kind === 'none');

  // 自己写的登记 → self
  locks.writeMarker('c-self', { childPid: alive, cwd: ROOT });
  const selfC = locks.classifyHolder('c-self');
  check('自己写的登记 → self', selfC.kind === 'self', selfC.reason);

  // 别人的、心跳新鲜 → live-mcp
  writeRawMarker('c-live', {
    conversation_id: 'c-live',
    mcp_pid: alive,
    mcp_token: 'other-instance',
    child_pid: alive,
    heartbeat_at: Date.now(),
  });
  const liveC = locks.classifyHolder('c-live');
  check('别的实例 + 心跳新鲜 → live-mcp', liveC.kind === 'live-mcp', liveC.reason);

  // 别人的、心跳过期 → stale-mcp（活着但卡死）
  writeRawMarker('c-stale-hb', {
    conversation_id: 'c-stale-hb',
    mcp_pid: alive,
    mcp_token: 'other-instance',
    child_pid: alive,
    heartbeat_at: Date.now() - 10 * 60 * 1000,
  });
  check('心跳过期 → stale-mcp（可安全抢占）', locks.classifyHolder('c-stale-hb').kind === 'stale-mcp');

  // 别人的 MCP 已死、子进程还活着 → stale-mcp（正是"MCP 崩了留下孤儿"的真实场景）
  writeRawMarker('c-orphan', {
    conversation_id: 'c-orphan',
    mcp_pid: 999999,
    mcp_token: 'dead-instance',
    child_pid: alive,
    heartbeat_at: Date.now(),
  });
  const orphanC = locks.classifyHolder('c-orphan');
  check('MCP 已死 + 子进程活着 → stale-mcp', orphanC.kind === 'stale-mcp', orphanC.reason);
  check('判定理由点名了孤儿', /孤儿|退出/.test(orphanC.reason), orphanC.reason);

  // 子进程也死了 → 视为锁已释放
  writeRawMarker('c-dead', {
    conversation_id: 'c-dead',
    mcp_pid: 999999,
    mcp_token: 'dead-instance',
    child_pid: 999999,
    heartbeat_at: Date.now() - 10 * 60 * 1000,
  });
  check('子进程也已退出 → none（锁已释放）', locks.classifyHolder('c-dead').kind === 'none');

  const orphans = locks.listOrphans();
  const orphanIds = orphans.map((o) => o.conversation_id);
  check('孤儿列表包含 c-orphan 与 c-stale-hb', orphanIds.includes('c-orphan') && orphanIds.includes('c-stale-hb'), JSON.stringify(orphanIds));
  check('孤儿列表不含 self / live', !orphanIds.includes('c-self') && !orphanIds.includes('c-live'), JSON.stringify(orphanIds));

  const pruned = locks.pruneDeadMarkers();
  check('清理掉"登记在但都死了"的记录', pruned.removed >= 1, JSON.stringify(pruned));
  check('清理后 c-dead 的登记没了', !existsSync(join(LOCKS, 'c-dead.json')));
  check('★ 保留 still-alive 的孤儿登记（抢占要用）', existsSync(join(LOCKS, 'c-orphan.json')));

  const none = locks.classifyHolder('c-none');
  const msgNone = locks.describeLeaseConflict('c-none', none);
  check('对 GUI/未知持有者的说明明确写着"不会杀"', /不会.*杀|绝不杀|不会\*\*杀/.test(msgNone), msgNone.slice(0, 300));
  const msgOrphan = locks.describeLeaseConflict('c-orphan', orphanC);
  check('对孤儿持有者的说明指引用 dsh_takeover', /dsh_takeover/.test(msgOrphan), msgOrphan.slice(0, 300));

  // 清掉单元测试造的登记，避免影响后面的端到端
  rmSync(LOCKS, { recursive: true, force: true });

  // ── [2] 端到端：两个 MCP 实例抢同一个会话 ────────────────────
  console.log('\n[2] ★ 端到端：真·写锁冲突 → 清晰报错 → 抢占');
  const A = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();
  const B = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();
  await A.initialize();
  await B.initialize();

  const ws = join(ROOT, 'ws');
  mkdirSync(ws, { recursive: true });
  const st = await A.callTool('dsh_start', { cwd: ws, permission: 'danger-full-access' }, 180_000);
  const conv = st?.structuredContent?.conversation_id;
  check('实例 A 建好会话', !!conv, McpClient.text(st).slice(0, 160));

  // A 跑一个短回合 → 会话落盘，且 A 的 DSH 子进程持续握着写锁
  const r1 = await A.callTool('dsh_send', { conversation_id: conv, prompt: '只回复两个字：待命', wait: true, timeout_ms: 300_000 }, 360_000);
  check('实例 A 的回合正常结束', r1?.structuredContent?.stop_reason === 'end_turn', McpClient.text(r1).slice(0, 200));

  // B 是另一个实例（同一份注册表）→ 去 resume 同一个会话 → 必然撞锁
  const r2 = await B.callTool('dsh_send', { conversation_id: conv, prompt: '你好', wait: false }, 180_000);
  const t2 = McpClient.text(r2);
  check('★ B 被拒绝', r2?.isError === true || r2?.structuredContent?.still_running !== true, t2.slice(0, 240));
  check('★ 报错是"写锁被占用"，不再是笼统的 Internal error', /写锁|占用|already owned/i.test(t2), t2.slice(0, 300));
  check('★ 报错给出可执行出路', /dsh_takeover|dsh_release/.test(t2), t2.slice(0, 300));
  console.log('    B 看到的报错：\n      ' + t2.split('\n').slice(0, 4).join('\n      '));

  const stB = await B.callTool('dsh_status', { conversation_id: conv });
  check(
    '★ dsh_status 报出写锁在谁手上',
    ['live-mcp', 'stale-mcp'].includes(stB?.structuredContent?.lock_holder),
    JSON.stringify(stB?.structuredContent?.lock_holder),
  );

  // 默认拒绝抢"另一个活着的实例"
  const tk1 = await B.callTool('dsh_takeover', { conversation_id: conv }, 180_000);
  check('抢占对 live-mcp 默认被拒', tk1?.structuredContent?.ok === false, JSON.stringify(tk1?.structuredContent ?? {}).slice(0, 300));
  check('拒绝文案说明可用 force', /force/i.test(McpClient.text(tk1)), McpClient.text(tk1).slice(0, 300));

  // force 才夺过来
  const tk2 = await B.callTool('dsh_takeover', { conversation_id: conv, force: true }, 240_000);
  check('★ force 抢占成功', tk2?.structuredContent?.ok === true, JSON.stringify(tk2?.structuredContent ?? {}).slice(0, 400));
  check('★ 杀掉的是 A 的子进程 PID', typeof tk2?.structuredContent?.killed_pid === 'number', JSON.stringify(tk2?.structuredContent?.killed_pid));
  console.log(`    抢到的 PID: ${tk2?.structuredContent?.killed_pid}`);

  // B 现在能用了
  const r3 = await B.callTool('dsh_send', { conversation_id: conv, prompt: '只回复两个字：接管', wait: true, timeout_ms: 300_000 }, 360_000);
  check('★ 抢占后 B 能正常派活', r3?.structuredContent?.stop_reason === 'end_turn', McpClient.text(r3).slice(0, 240));
  check('B 拿到的正是接管后的答复', /接管/.test(r3?.structuredContent?.answer ?? ''), JSON.stringify(r3?.structuredContent?.answer));

  // ── [3] 插话那一轮也要有哨兵（回归）────────────────────────
  console.log('\n[3] ★ 插话那一轮现在也写哨兵（修掉"等待方空等"）');
  const bg = await B.callTool('dsh_send', { conversation_id: conv, prompt: '分两步：先运行 Start-Sleep -Seconds 3 并汇报"一步"，再回复"两步完"。' }, 180_000);
  check('后台派活拿到哨兵路径', !!bg?.structuredContent?.sentinel_file, JSON.stringify(bg?.structuredContent ?? {}).slice(0, 200));

  const ij = await B.callTool('dsh_interject', { conversation_id: conv, mode: 'queue', message: '补充一句：最后再回复"插话收到"。' }, 600_000);
  const ijS = ij?.structuredContent ?? {};
  check('★ dsh_interject 返回了 sentinel_file', !!ijS.sentinel_file, JSON.stringify(ijS).slice(0, 300));
  check('★ 插话那一轮的哨兵文件真的落盘了（旧实现这里永远为空等）', !!ijS.sentinel_file && existsSync(ijS.sentinel_file), String(ijS.sentinel_file));
  if (ijS.sentinel_file && existsSync(ijS.sentinel_file)) {
    const doc = JSON.parse(readFileSync(ijS.sentinel_file, 'utf8'));
    check('哨兵内容 status=done', doc.status === 'done', JSON.stringify(doc.status));
    check('哨兵里带正文', (doc.result?.answer ?? '').length > 0, JSON.stringify(doc.result?.answer?.slice(0, 80)));
    check('哨兵里没有思考内容（隐私默认）', doc.result?.thinking === undefined, JSON.stringify(doc.result?.thinking)?.slice(0, 120));
  }
  const bgSent = bg?.structuredContent?.sentinel_file;
  if (bgSent) {
    // 后台那一轮的哨兵也应已落地（插话会等它跑完）
    check('后台那一轮的哨兵也落地了', existsSync(bgSent), bgSent);
  }

  // ── [4] 抢占与状态的边界 ─────────────────────────────────────
  console.log('\n[4] 抢占与状态的边界情况');

  const stSelf = await B.callTool('dsh_status', { conversation_id: conv });
  check('B 持有期间 lock_holder=self', stSelf?.structuredContent?.lock_holder === 'self', JSON.stringify(stSelf?.structuredContent?.lock_holder));

  const tkSelf = await B.callTool('dsh_takeover', { conversation_id: conv }, 120_000);
  check('对"自己已持有"的会话抢占 → 直接说无需抢占', tkSelf?.structuredContent?.ok === true && /已经持有/.test(tkSelf?.structuredContent?.message ?? ''), JSON.stringify(tkSelf?.structuredContent ?? {}).slice(0, 240));

  const tkUnknown = await B.callTool('dsh_takeover', { conversation_id: 'no-such-conversation' }, 60_000);
  check('抢占一个不存在的会话 → 清晰 isError', tkUnknown?.isError === true && /未知会话/.test(McpClient.text(tkUnknown)), McpClient.text(tkUnknown).slice(0, 160));

  // 交还（不 forget）→ 进程停掉、写锁释放、登记必须被删
  const rel = await B.callTool('dsh_release', { conversation_id: conv }, 60_000);
  check('交还会话成功', rel?.structuredContent?.closed === true || rel?.structuredContent?.released === true || !rel?.isError, McpClient.text(rel).slice(0, 160));
  const markerFile = join(LOCKS, `${conv}.json`);
  check('★ 交还后持有者登记被删掉（否则会被误报成孤儿）', !existsSync(markerFile), markerFile);

  const stAfter = await B.callTool('dsh_status', { conversation_id: conv });
  check('交还后 lock_holder 回到 none', stAfter?.structuredContent?.lock_holder === 'none', JSON.stringify(stAfter?.structuredContent?.lock_holder));

  const tkFree = await B.callTool('dsh_takeover', { conversation_id: conv }, 240_000);
  check('★ 锁空着时抢占 = 正常 resume（不杀任何东西）', tkFree?.structuredContent?.ok === true && tkFree?.structuredContent?.killed_pid === null, JSON.stringify(tkFree?.structuredContent ?? {}).slice(0, 260));
  check('且说明里讲清了"无需抢占"', /无需抢占/.test(tkFree?.structuredContent?.message ?? ''), String(tkFree?.structuredContent?.message).slice(0, 200));

  const listB = await B.callTool('dsh_list', {});
  check('dsh_list 报出 orphan_holders 字段', Array.isArray(listB?.structuredContent?.orphan_holders), JSON.stringify(listB?.structuredContent?.orphan_holders));
  check('（此刻没有孤儿持有者）', (listB?.structuredContent?.orphan_holders ?? []).length === 0, JSON.stringify(listB?.structuredContent?.orphan_holders));

  // ── [5] 哨兵不变量：**每一个回合都有哨兵** ────────────────────
  console.log('\n[5] ★ 哨兵不变量（一个回合 = 一个哨兵）');

  // (a) wait=true 的内联回合也要写 —— 旧实现只有"调用方没原地等"才写
  const inline = await B.callTool('dsh_send', { conversation_id: conv, prompt: '只回复：内联', wait: true, timeout_ms: 300_000 }, 360_000);
  const inlineRun = inline?.structuredContent?.run_id;
  check('内联回合返回 run_id', typeof inlineRun === 'string', JSON.stringify(inlineRun));
  const inlineSent = join(ROOT, 'runs', conv, `${inlineRun}.json`);
  check('★ 内联（wait=true）回合的哨兵也落盘了', existsSync(inlineSent), inlineSent);

  // (b) 会话空闲时插话（走 interject 的 'idle' 分支）也要写
  await sleep(500);
  const ijIdle = await B.callTool('dsh_interject', { conversation_id: conv, mode: 'queue', message: '只回复：空闲插话' }, 360_000);
  const idleS = ijIdle?.structuredContent ?? {};
  check('空闲插话返回 sentinel_file', !!idleS.sentinel_file, JSON.stringify(idleS).slice(0, 240));
  check('★ 空闲插话那一轮的哨兵也落盘了', !!idleS.sentinel_file && existsSync(idleS.sentinel_file), String(idleS.sentinel_file));

  // ── [6] 登记模块的边界（单元）─────────────────────────────────
  console.log('\n[6] 登记模块的边界（单元）');
  rmSync(LOCKS, { recursive: true, force: true });
  check('目录不存在时 listOrphans() 返回空数组', locks.listOrphans().length === 0);
  check('目录不存在时 pruneDeadMarkers() 不报错', locks.pruneDeadMarkers().removed === 0);

  mkdirSync(LOCKS, { recursive: true });
  writeFileSync(join(LOCKS, 'broken.json'), '{ not valid json', 'utf8');
  check('登记文件损坏 → classifyHolder 当成无登记', locks.classifyHolder('broken').kind === 'none');
  const prunedBroken = locks.pruneDeadMarkers();
  check('损坏的登记会被清掉', prunedBroken.removed >= 1, JSON.stringify(prunedBroken));
  check('清理后文件没了', !existsSync(join(LOCKS, 'broken.json')));

  // ★ 回归：writeMarker 绝不覆盖"别人还活着的"登记（实现期真实踩到的 bug）
  const alivePid = process.ppid;
  writeRawMarker('c-guard', {
    conversation_id: 'c-guard',
    mcp_pid: alivePid,
    mcp_token: 'other-live-instance',
    child_pid: alivePid,
    heartbeat_at: Date.now(),
  });
  const wrote = locks.writeMarker('c-guard', { childPid: alivePid, cwd: ROOT });
  const afterGuard = JSON.parse(readFileSync(join(LOCKS, 'c-guard.json'), 'utf8'));
  check('★★ writeMarker 拒绝覆盖活着的外来登记', wrote === false, JSON.stringify(wrote));
  check('★★ 外来登记的 token 原样保留（抢占要靠它判"谁持有"）', afterGuard.mcp_token === 'other-live-instance', afterGuard.mcp_token);

  // 但过期的外来登记应该可以被我们接管（覆盖）
  writeRawMarker('c-stale-ok', {
    conversation_id: 'c-stale-ok',
    mcp_pid: 999999,
    mcp_token: 'dead-instance',
    child_pid: 999999,
    heartbeat_at: Date.now() - 10 * 60 * 1000,
  });
  const wroteStale = locks.writeMarker('c-stale-ok', { childPid: alivePid, cwd: ROOT });
  const afterStale = JSON.parse(readFileSync(join(LOCKS, 'c-stale-ok.json'), 'utf8'));
  check('过期的外来登记可以被接管（覆盖）', wroteStale === true, JSON.stringify(wroteStale));
  check('覆盖后 token 是我们自己的', afterStale.mcp_token === locks.MCP_TOKEN, afterStale.mcp_token);

  // ── [8] 两条真实边界：崩溃 vs 卡死 ────────────────────────────
  console.log('\n[8a] 崩溃：杀掉 MCP → 子进程跟着退出 → 锁**自动释放**（不会留孤儿）');
  const STATE2 = join(ROOT, 'state2.json');
  const A2 = new McpClient({ env: { DSH_MCP_STATE: STATE2 } }).start();
  await A2.initialize();
  const ws2 = join(ROOT, 'ws2');
  mkdirSync(ws2, { recursive: true });
  const st2 = await A2.callTool('dsh_start', { cwd: ws2, permission: 'danger-full-access' }, 180_000);
  const conv2 = st2?.structuredContent?.conversation_id;
  check('新实例 A2 建好会话', !!conv2, McpClient.text(st2).slice(0, 140));
  await A2.callTool('dsh_send', { conversation_id: conv2, prompt: '只回复：边界', wait: true, timeout_ms: 300_000 }, 360_000);

  const m2 = JSON.parse(readFileSync(join(LOCKS, `${conv2}.json`), 'utf8'));
  const holderPid = m2.child_pid;
  check('登记里有子进程 PID', typeof holderPid === 'number', JSON.stringify(m2));

  // 只杀 MCP 服务进程本身（不动进程树）
  const a2pid = A2.pid;
  process.kill(a2pid, 'SIGKILL');
  await sleep(2500);
  check('MCP 服务进程已被强杀', !locks.isPidAlive(a2pid), String(a2pid));
  // ★ 关键事实：子进程的 stdio 是连着父进程的管道，父进程一死管道关闭、子进程见 EOF 自杀。
  //   所以**崩溃不会留下握着锁的孤儿** —— 这是好消息，也解释了为什么"重启 MCP"总能拿回锁。
  check('★ 子进程随父进程一起退出（锁已自动释放）', !locks.isPidAlive(holderPid), String(holderPid));
  check('登记被判为"锁已释放"（none）', locks.classifyHolder(conv2).kind === 'none', locks.classifyHolder(conv2).reason);

  const B2 = new McpClient({ env: { DSH_MCP_STATE: STATE2 } }).start();
  await B2.initialize();
  const r2b = await B2.callTool('dsh_send', { conversation_id: conv2, prompt: '只回复：接管崩溃会话', wait: true, timeout_ms: 300_000 }, 360_000);
  check('★ 新的 MCP 实例无需抢占即可直接接管', r2b?.structuredContent?.stop_reason === 'end_turn', McpClient.text(r2b).slice(0, 240));
  check('拿到的是新实例的答复', /接管崩溃会话/.test(r2b?.structuredContent?.answer ?? ''), JSON.stringify(r2b?.structuredContent?.answer));

  // ── [8b] 卡死：持有者活着但失联（心跳过期）→ stale-mcp → **无 force 自动抢占** ──
  console.log('\n[8b] ★ 卡死：持有者活着但心跳过期 → 判为 stale-mcp → 无 force 自动抢占');
  // 让 B2 持有 conv2（它刚刚 resume 过），记下它的子进程
  const m3 = JSON.parse(readFileSync(join(LOCKS, `${conv2}.json`), 'utf8'));
  const wedgedPid = m3.child_pid;
  check('B2 登记了新的子进程', typeof wedgedPid === 'number' && wedgedPid !== holderPid, JSON.stringify(m3));

  // 制造"持有者 MCP 失联"：登记里 MCP 进程**仍在**（用一个确定活着的外部 PID），
  // 但心跳是十分钟前的 —— 这正是"活着但卡死"的形态。进程本身不动。
  writeRawMarker(conv2, {
    conversation_id: conv2,
    mcp_pid: process.ppid,
    mcp_token: 'wedged-instance',
    child_pid: wedgedPid,
    cwd: ws2,
    heartbeat_at: Date.now() - 10 * 60 * 1000,
  });
  const holder3 = locks.classifyHolder(conv2);
  check('★ 判定为 stale-mcp（失联的持有者）', holder3.kind === 'stale-mcp', holder3.reason);
  check('判定理由点名"心跳已过期"', /心跳.*过期|卡死/.test(holder3.reason), holder3.reason);

  // 第三个实例（同一注册表）撞锁 → 报错必须是"孤儿/可安全抢占"
  const C = new McpClient({ env: { DSH_MCP_STATE: STATE2 } }).start();
  await C.initialize();
  const rC = await C.callTool('dsh_send', { conversation_id: conv2, prompt: '你好', wait: false }, 180_000);
  const tC = McpClient.text(rC);
  check('★ C 撞锁并指出可安全抢占', /写锁|占用/.test(tC) && /dsh_takeover/.test(tC), tC.slice(0, 300));
  check('★ 且明确说"无需 force"', /无需 force|即可|直接/.test(tC), tC.slice(0, 300));

  const tkC = await C.callTool('dsh_takeover', { conversation_id: conv2 }, 240_000);
  const tkCs = tkC?.structuredContent ?? {};
  check('★★ 无 force 抢占成功（失联持有者可自动接管）', tkCs.ok === true, JSON.stringify(tkCs).slice(0, 400));
  check('★★ 杀掉的正是那个失联持有者的 PID', tkCs.killed_pid === wedgedPid, `${tkCs.killed_pid} vs ${wedgedPid}`);
  check('失联持有者的子进程确实死了', !locks.isPidAlive(wedgedPid), String(wedgedPid));

  const rCc = await C.callTool('dsh_send', { conversation_id: conv2, prompt: '只回复：接管卡死', wait: true, timeout_ms: 300_000 }, 360_000);
  check('★★ 抢占后 C 能正常派活', rCc?.structuredContent?.stop_reason === 'end_turn', McpClient.text(rCc).slice(0, 240));
  check('拿到的是接管后的答复', /接管卡死/.test(rCc?.structuredContent?.answer ?? ''), JSON.stringify(rCc?.structuredContent?.answer));

  // 收尾：B2 的子进程已被 C 杀掉，两边都释放
  for (const cl of [B2, C]) {
    try {
      await cl.callTool('dsh_release', { conversation_id: conv2, forget: true }, 60_000);
    } catch {}
    await cl.close();
  }

  console.log('\n[9] 收尾');
  for (const c of [A, B]) {
    try {
      await c.callTool('dsh_release', { conversation_id: conv, forget: true }, 60_000);
    } catch {}
    await c.close();
  }
  check('两个实例都已关闭', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
} finally {
  // 清理要够皮实：临时目录可能是某个还没退干净的 DSH 子进程的 cwd，rmSync 会 EPERM。
  // 清不掉不影响测试结论（系统临时目录会被系统回收）。
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(ROOT, { recursive: true, force: true });
      break;
    } catch {
      await sleep(700);
    }
  }
}

console.log(`\n===== 写锁与抢占测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);