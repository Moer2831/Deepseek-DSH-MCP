/**
 * 极简 MCP 客户端（测试用）：拉起 dsh-mcp 服务端，走 stdio 换行分隔 JSON-RPC。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PKG_ROOT } from '../src/config.mjs';

export class McpClient {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #buf = '';
  stderr = [];

  constructor({ env = {} } = {}) {
    this.env = env;
  }

  start() {
    this.#child = spawn(process.execPath, [join(PKG_ROOT, 'bin', 'dsh-mcp.mjs')], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.on('data', (d) => this.#onData(d));
    this.#child.stderr.on('data', (d) => {
      for (const l of d.toString('utf8').split(/\r?\n/)) {
        if (l.trim()) {
          this.stderr.push(l.trim());
          if (process.env.DSH_MCP_TEST_VERBOSE) process.stderr.write(`  [server] ${l.trim()}\n`);
        }
      }
    });
    this.#child.on('exit', (code) => {
      for (const [, p] of this.#pending) p.reject(new Error(`服务端退出 code=${code}`));
      this.#pending.clear();
    });
    return this;
  }

  #onData(chunk) {
    this.#buf += chunk.toString('utf8');
    let i;
    while ((i = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new Error(`服务端输出了非 JSON 内容: ${line.slice(0, 300)}`);
      }
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) continue;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 120_000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`请求超时: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-test', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    return r;
  }

  async listTools() {
    return (await this.request('tools/list', {})).tools;
  }

  async callTool(name, args, timeoutMs) {
    return await this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  /** 取工具结果里的纯文本。 */
  static text(result) {
    return (result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  async close() {
    try {
      this.#child.stdin.end();
    } catch {}
    await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          this.#child?.kill();
        } catch {}
        r();
      }, 6000);
      this.#child?.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  }
}