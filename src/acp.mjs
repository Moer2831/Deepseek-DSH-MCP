/**
 * 一个 DSH ACP 运行时进程的客户端封装。
 *
 * 协议：换行分隔 JSON-RPC 2.0 over stdio（与 `--profile acp` 的实现一致）。
 * 与 SDK profile 的关键差别：ACP 原生支持 session/resume、session/cancel、
 * session/close、session/list，以及 session/request_permission 客户端往返。
 *
 * 日志策略：子树进程的 stderr **默认既不转发也不落盘**，只在内存里保留有界的尾部若干行，
 * 供排障时一次性取出。原因是 DSH 的 stderr 可能夹带模型输出（含思考内容）。
 */

import { spawn } from 'node:child_process';
import { DSH_PROFILE, REQUEST_TIMEOUT_MS, resolveDshBin } from './config.mjs';

/** ACP 协议版本（@agentclientprotocol/sdk 的 v1）。 */
const PROTOCOL_VERSION = 1;

/** 内存里保留的 DSH stderr 行数上限（仅内存，不落盘、默认不打印）。 */
const STDERR_TAIL_LINES = 20;

const NOOP_LOG = { info: () => {}, debug: () => {}, dshStderr: () => {} };

export class AcpProcess {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #buf = '';
  #stderrTail = [];
  #stopping = false;
  #log = NOOP_LOG;
  #onPermissionRequest;
  #onNotification;

  /**
   * @param {object} opts
   * @param {string} opts.cwd      工作区（同时作为 OS 级 cwd 与 session cwd）
   * @param {string} opts.permission 权限档，映射到 DSH_PERMISSION_MODE
   * @param {object} [opts.log]    分级 logger（见 config.createLogger）
   * @param {(params:object)=>Promise<object>} [opts.onPermissionRequest]
   * @param {(params:object)=>void} [opts.onNotification]
   */
  constructor({ cwd, permission, log, onPermissionRequest, onNotification }) {
    this.cwd = cwd;
    this.permission = permission;
    if (log) this.#log = log;
    this.#onPermissionRequest = onPermissionRequest;
    this.#onNotification = onNotification;
    this.initialized = false;
  }

  get alive() {
    return this.#child !== null && this.#child.exitCode === null && !this.#stopping;
  }

  /** 子进程 PID（供写锁登记使用）；未启动或已退出时为 null。 */
  get pid() {
    return this.#child?.pid ?? null;
  }

  /** DSH stderr 的内存尾部（诊断用；默认不打印、不落盘）。 */
  get stderrTail() {
    return this.#stderrTail.join('\n');
  }

  /** 拉起进程。注意 ACP 没有"就绪"握手信号，spawn 后即可发请求。 */
  start() {
    if (this.#child) throw new Error('AcpProcess 已经启动过了');
    const bin = resolveDshBin();
    this.#child = spawn(process.execPath, [bin, '--profile', DSH_PROFILE], {
      cwd: this.cwd,
      env: { ...process.env, DSH_PERMISSION_MODE: this.permission },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.#child.stdout.on('data', (d) => this.#onData(d));
    this.#child.stderr.on('data', (d) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.#stderrTail.push(line.trim());
        if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
        // 只有显式开启 DSH_MCP_LOG_STDERR 才会把它打到 stderr
        this.#log.dshStderr(`[dsh stderr] ${line.trim()}`);
      }
    });
    this.#child.on('exit', (code) => {
      const err = new Error(`DSH 进程退出（code=${code}）`);
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.#pending.clear();
      this.#child = null;
      this.initialized = false;
      this.#log.debug(`[acp] 进程退出 code=${code}`);
    });
    this.#child.on('error', (e) => this.#log.info(`[acp] spawn 失败: ${e.message}`));
    return this;
  }

  #onData(chunk) {
    this.#buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.#log.debug('[acp] 收到非 JSON 行（已忽略）');
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        // ⚠️ 必须带上 error.data：ACP 把**非 RequestError 的异常**统一包成
        // {code:-32603, message:"Internal error", data:{...真实原因...}}。
        // 只取 message 的话，真实原因会被丢掉，只剩一句无用的 "Internal error"。
        const d = msg.error.data;
        let extra = '';
        if (d !== undefined && d !== null) {
          let s;
          try {
            s = typeof d === 'string' ? d : JSON.stringify(d);
          } catch {
            s = String(d);
          }
          if (s && s !== '{}') extra = ` | data=${s.length > 800 ? `${s.slice(0, 800)}…` : s}`;
        }
        const code = msg.error.code !== undefined ? `[${msg.error.code}] ` : '';
        p.reject(new Error(`${code}${msg.error.message ?? JSON.stringify(msg.error)}${extra}`));
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.#handleIncomingRequest(msg);
      return;
    }
    if (msg.method !== undefined) {
      try {
        this.#onNotification?.(msg.params ?? {}, msg.method);
      } catch (e) {
        this.#log.debug(`[acp] 通知处理异常: ${e.message}`);
      }
    }
  }

  async #handleIncomingRequest(msg) {
    let result = {};
    try {
      if (msg.method === 'session/request_permission') {
        result = (await this.#onPermissionRequest?.(msg.params ?? {})) ?? {
          outcome: { outcome: 'cancelled' },
        };
      } else {
        this.#log.debug(`[acp] 未处理的客户端请求: ${msg.method}`);
      }
    } catch (e) {
      this.#log.debug(`[acp] 处理 ${msg.method} 失败: ${e.message}`);
      result = { outcome: { outcome: 'cancelled' } };
    }
    this.#write({ jsonrpc: '2.0', id: msg.id, result });
  }

  #write(obj) {
    if (!this.#child?.stdin?.writable) return false;
    this.#child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  /**
   * 发一个请求并等结果。
   *
   * `timeoutMs <= 0` = **不设超时**。这是给"长回合"用的：等待与否应该由上层按
   * `wait` 语义决定，绝不该在这里把请求掐断 —— 本地放弃并不会让 agent 停下来，
   * 只会让我们丢掉结果、误判回合结束（进而让 reaper 杀掉正在干活的进程）。
   */
  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.alive) return Promise.reject(new Error('DSH 进程未运行'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.#pending.delete(id)) reject(new Error(`ACP 请求超时: ${method}`));
            }, timeoutMs)
          : null;
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** 发一个通知（无回包）。 */
  notify(method, params) {
    return this.#write({ jsonrpc: '2.0', method, params });
  }

  /** 进程创建后再绑定/更换回调（Hub 需要先建进程、再建会话对象，顺序上只能事后绑）。 */
  attachRoutes({ onNotification, onPermissionRequest } = {}) {
    if (onNotification) this.#onNotification = onNotification;
    if (onPermissionRequest) this.#onPermissionRequest = onPermissionRequest;
    return this;
  }

  /** 完成 ACP 握手（每个进程一次）。 */
  async initialize() {
    if (this.initialized) return this.#initResult;
    this.#initResult = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'dsh-mcp', version: '0.1.0' },
    });
    this.initialized = true;
    return this.#initResult;
  }
  #initResult = null;

  /** 优雅收尾：close 由调用方负责，这里只关 stdin（DSH 绑定 stdin EOF → 有界退出）。 */
  async stop({ graceMs = 3000, killWaitMs = 5000 } = {}) {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    try {
      child.stdin.end();
    } catch {}
    const waitExit = (ms) =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
        const t = setTimeout(() => resolve(false), ms);
        child.once('exit', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
    // 1) 先给它体面退出的机会（stdin EOF → DSH 有界退出）
    if (await waitExit(graceMs)) return;
    // 2) 超时则强杀，**并且等它真的退出**。
    //    ★ 旧实现 kill() 之后立刻 resolve —— 于是调用方会在"子进程还活着、还握着写锁"
    //      的时候继续往下走：删掉登记、再 spawn 新进程去 resume，就会撞上一个**无法归因的锁**
    //      （登记没了 → classifyHolder 判成 none → 连 dsh_takeover 都会拒绝）。
    //      这就是"异步派活 → 等 task → 回头再进就报有锁"的一个真实来源。
    try {
      child.kill();
    } catch {}
    await waitExit(killWaitMs);
  }
}