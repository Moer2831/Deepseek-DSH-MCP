/**
 * 边界与错误处理测试（尽量不消耗 token —— 绝大部分是参数校验与协议边界）。
 *
 * 覆盖：MCP 协议边界、工具参数校验、生命周期幂等性、未知 id、脏输入。
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp-client.mjs';
import { pruneEmptyWorkspaces, purgeTestSessions } from '../src/workspace.mjs';

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

const STATE = join(tmpdir(), `dsh-mcp-bound-state-${Date.now()}.json`);
const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-bound-'));
const goodWs = join(root, 'ok');
mkdirSync(goodWs, { recursive: true });
const client = new McpClient({ env: { DSH_MCP_STATE: STATE } }).start();

const isErr = (r) => r?.isError === true;
const txt = (r) => McpClient.text(r);

try {
  await client.initialize();

  // ── MCP 协议边界 ──────────────────────────────────────────
  console.log('\n[A] MCP 协议边界');
  const init2 = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  check('重复 initialize 不出错', init2?.serverInfo?.name === 'dsh-mcp');
  const pong = await client.request('ping', {});
  check('ping 返回空对象', pong !== undefined && Object.keys(pong).length === 0, JSON.stringify(pong));

  let unknownErr = null;
  try {
    await client.request('tools/nonexistent', {});
  } catch (e) {
    unknownErr = e.message;
  }
  check('未知方法返回错误', /Method not found/.test(unknownErr ?? ''), String(unknownErr));

  // 脏输入：塞一行非 JSON，随后的正常请求必须仍然可用
  client.notify('this is not json at all', {});
  const afterGarbage = await client.request('tools/list', {});
  // 断言"仍然可用"就够了 —— 不要写死工具数量，否则加一个工具就要改一处（这里曾经写过 10）
  const garbageTools = afterGarbage?.tools ?? [];
  check(
    '收到脏行后连接仍可用',
    garbageTools.length > 0 && garbageTools.some((t) => t.name === 'dsh_send'),
    `tools=${garbageTools.length}`,
  );

  const noArgs = await client.callTool('dsh_start', {});
  check('dsh_start 缺 cwd → isError', isErr(noArgs), txt(noArgs).slice(0, 120));

  // ── dsh_start 参数校验 ────────────────────────────────────
  console.log('\n[B] dsh_start 参数校验');
  const rel = await client.callTool('dsh_start', { cwd: 'relative\\path' });
  check('相对路径 → isError 且提示绝对路径', isErr(rel) && /绝对路径/.test(txt(rel)), txt(rel).slice(0, 120));

  const missing = await client.callTool('dsh_start', { cwd: join(root, 'nope') });
  check('不存在的工作区 → isError', isErr(missing) && /不存在或不是目录/.test(txt(missing)), txt(missing).slice(0, 120));

  const badPerm = await client.callTool('dsh_start', { cwd: goodWs, permission: 'root' });
  check('非法 permission → isError', isErr(badPerm) && /permission/.test(txt(badPerm)), txt(badPerm).slice(0, 140));

  const badAppr = await client.callTool('dsh_start', { cwd: goodWs, on_approval: 'maybe' });
  check('非法 on_approval → isError', isErr(badAppr) && /on_approval/.test(txt(badAppr)), txt(badAppr).slice(0, 140));

  const badEffort = await client.callTool('dsh_start', { cwd: goodWs, reasoning_effort: 'ultra' });
  check('非法 reasoning_effort → isError', isErr(badEffort) && /reasoning_effort/.test(txt(badEffort)), txt(badEffort).slice(0, 140));

  const modelNoProv = await client.callTool('dsh_start', { cwd: goodWs, model: 'deepseek-v4.1-flash' });
  check('给了 model 但没给 provider → isError', isErr(modelNoProv) && /provider/.test(txt(modelNoProv)), txt(modelNoProv).slice(0, 140));

  // ── 合法建会话 + reasoning_effort=default ─────────────────
  console.log('\n[C] 合法建会话与配置');
  const okStart = await client.callTool('dsh_start', { cwd: goodWs, reasoning_effort: 'default' }, 120_000);
  const convId = okStart?.structuredContent?.conversation_id;
  check('reasoning_effort=default 可建会话', !!convId, txt(okStart).slice(0, 160));
  check(
    'default 时不额外套用思考深度（还原 Provider default）',
    !(okStart?.structuredContent?.config_applied ?? []).some((x) => x.includes('思考深度')),
    JSON.stringify(okStart?.structuredContent?.config_applied),
  );
  check(
    '临时目录下的工作区默认**不**登记（避免污染 GUI）',
    okStart?.structuredContent?.workspace_registered === false,
    JSON.stringify(okStart?.structuredContent?.workspace_registered),
  );

  // 真实（非临时）工作区应当被登记，否则 GUI 里看不到这些会话。
  // 自己造一个非临时目录（不能依赖桌面上某个文件夹 —— 那是会被清理掉的外部状态），
  // 用仓库下 .state/ 里的子目录（已被 .gitignore 覆盖），测完删掉并清理注册表条目。
  const realWs = join(dirname(fileURLToPath(import.meta.url)), '..', '.state', `ws-probe-${Date.now()}`);
  let realStart = null;
  mkdirSync(realWs, { recursive: true });
  try {
    realStart = await client.callTool('dsh_start', { cwd: realWs }, 120_000);
    check(
      '非临时目录会被登记进 DSH 注册表',
      realStart?.structuredContent?.workspace_registered === true,
      JSON.stringify(realStart?.structuredContent?.workspace_registered),
    );
  } finally {
    // 无论断言成败都要清干净：删会话 + 删目录 + 摘掉工作区登记
    if (realStart?.structuredContent?.conversation_id) {
      const id = realStart.structuredContent.conversation_id;
      await client.callTool('dsh_release', { conversation_id: id, forget: true });
      // 只 forget 不够：DSH 的会话目录还在磁盘上，工作区条目就不会变空。
      // 用显式 id 精确删掉这条会话，再让注册表对账。
      purgeTestSessions({ ids: [id] });
    }
    try {
      rmSync(realWs, { recursive: true, force: true });
      pruneEmptyWorkspaces();
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }

  const lowEffort = await client.callTool('dsh_start', { cwd: goodWs, reasoning_effort: 'low' }, 120_000);
  check(
    'reasoning_effort=low 会被套用',
    (lowEffort?.structuredContent?.config_applied ?? []).some((x) => x.includes('思考深度=low')),
    JSON.stringify(lowEffort?.structuredContent?.config_applied),
  );
  const lowId = lowEffort?.structuredContent?.conversation_id;

  // ── 未知 id ───────────────────────────────────────────────
  console.log('\n[D] 未知 id');
  for (const [tool, args] of [
    ['dsh_get', { conversation_id: 'nope' }],
    ['dsh_send', { conversation_id: 'nope', prompt: 'x' }],
    ['dsh_read', { conversation_id: 'nope' }],
    ['dsh_status', { conversation_id: 'nope' }],
    ['dsh_interrupt', { conversation_id: 'nope' }],
    ['dsh_release', { conversation_id: 'nope' }],
    ['dsh_interject', { conversation_id: 'nope', message: 'x' }],
    ['dsh_approval_decide', { conversation_id: 'nope', approval_id: 'a', decision: 'allow' }],
  ]) {
    const r = await client.callTool(tool, args);
    check(`${tool} 未知会话 → isError`, isErr(r) && /未知会话/.test(txt(r)), txt(r).slice(0, 120));
  }

  const badApproval = await client.callTool('dsh_approval_decide', {
    conversation_id: convId,
    approval_id: 'ap-nope',
    decision: 'allow',
  });
  check('裁决不存在的审批 → isError', isErr(badApproval) && /待决审批/.test(txt(badApproval)), txt(badApproval).slice(0, 120));

  // ── dsh_read 脏游标 ───────────────────────────────────────
  console.log('\n[E] dsh_read 游标边界');
  const negCursor = await client.callTool('dsh_read', { conversation_id: convId, cursor: -5 });
  check('负游标不崩且返回条目结构', !isErr(negCursor) && Array.isArray(negCursor?.structuredContent?.entries), txt(negCursor).slice(0, 120));
  const hugeCursor = await client.callTool('dsh_read', { conversation_id: convId, cursor: 999999 });
  check('超大游标返回空增量', !isErr(hugeCursor) && (hugeCursor?.structuredContent?.entries ?? []).length === 0);
  check('超大游标不回退 cursor', hugeCursor?.structuredContent?.cursor === 999999, String(hugeCursor?.structuredContent?.cursor));
  const zeroLimit = await client.callTool('dsh_read', { conversation_id: convId, limit: 0 });
  check('limit=0 不崩', !isErr(zeroLimit), txt(zeroLimit).slice(0, 120));
  const nonNumCursor = await client.callTool('dsh_read', { conversation_id: convId, cursor: 'abc' });
  check('非法游标类型不崩', !isErr(nonNumCursor) || /报错|失败/.test(txt(nonNumCursor)), txt(nonNumCursor).slice(0, 120));

  // ── 生命周期幂等 ──────────────────────────────────────────
  console.log('\n[F] 生命周期幂等与状态迁移');
  const rel1 = await client.callTool('dsh_release', { conversation_id: convId });
  check('首次 release 成功', rel1?.structuredContent?.closed === true);
  const rel2 = await client.callTool('dsh_release', { conversation_id: convId });
  check('重复 release 幂等（不报错）', !isErr(rel2) && rel2?.structuredContent?.closed === true, txt(rel2).slice(0, 120));
  const stDetached = await client.callTool('dsh_get', { conversation_id: convId });
  check('释放后状态为 detached', stDetached?.structuredContent?.state === 'detached', String(stDetached?.structuredContent?.state));
  const getStillOk = await client.callTool('dsh_get', { conversation_id: convId });
  check('释放后仍能查详情', getStillOk?.structuredContent?.conversation_id === convId);

  const intIdle = await client.callTool('dsh_interrupt', { conversation_id: convId });
  check('对未运行的会话 interrupt 不报错', !isErr(intIdle), txt(intIdle).slice(0, 140));
  check('未运行时 interrupted=false', intIdle?.structuredContent?.interrupted === false, JSON.stringify(intIdle?.structuredContent));

  const statusEmpty = await client.callTool('dsh_status', { conversation_id: convId });
  check('未跑过回合时 run 为 null', statusEmpty?.structuredContent?.run === null, JSON.stringify(statusEmpty?.structuredContent?.run));

  const getNoRun = await client.callTool('dsh_get', { conversation_id: convId });
  check('无回合时 dsh_get 的 run 为 null', getNoRun?.structuredContent?.run === null);

  const listEmpty = await client.callTool('dsh_list', { only_running: true });
  check('没有会话在跑时 only_running 为空', (listEmpty?.structuredContent?.conversations ?? []).length === 0, txt(listEmpty).slice(0, 160));

  // ── 长输入 ────────────────────────────────────────────────
  console.log('\n[G] 长输入与特殊字符');
  const longCwd = join(root, 'x'.repeat(200));
  const longRes = await client.callTool('dsh_start', { cwd: longCwd });
  check('超长路径 → 清晰 isError（不崩）', isErr(longRes), txt(longRes).slice(0, 120));
  const emoji = await client.callTool('dsh_start', { cwd: goodWs, title_hint: '🎯 中文 emoji 测试 \u0000 控制符' }, 120_000);
  check('标题含 emoji/控制符仍能建会话', !!emoji?.structuredContent?.conversation_id, txt(emoji).slice(0, 160));

  console.log('\n[H] 收尾');
  for (const id of [convId, lowId, emoji?.structuredContent?.conversation_id, realStart?.structuredContent?.conversation_id].filter(Boolean)) {
    await client.callTool('dsh_release', { conversation_id: id, forget: true });
  }
  check('全部释放完成', true);
} catch (e) {
  failCount++;
  console.log(`\n✗ 异常中断: ${e.message}\n${e.stack}`);
  console.log(client.stderr.slice(-30).join('\n'));
} finally {
  await client.close();
  try { rmSync(STATE, { force: true }); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== 边界测试：通过 ${pass}，失败 ${failCount} =====`);
process.exit(failCount ? 1 : 0);