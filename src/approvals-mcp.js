// src/approvals-mcp.js
// Minimal stdio MCP server exposing ONE tool: permission_prompt. Claude Code (headless)
// calls it for every non-allowlisted action (--permission-prompt-tool). We drop a request
// file for the daemon (which owns Telegram), poll for the operator's answer file, and
// return allow/deny. Timeout returns deny-with-PENDING — deny-by-silence, never approve.
// Hand-rolled JSON-RPC over newline-delimited stdio: zero dependencies, ~none of the SDK's
// surface is needed for a single tool.
import readline from 'node:readline';
import { writeRequest, readAnswer } from './approvals.js';
import { ORCH_DIR, APPROVAL_WAIT_MS } from './config.js';

const TOOL = {
  name: 'permission_prompt',
  description: 'Relays a permission request to the operator via Telegram and waits for Allow/Deny.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' } },
  },
};

export async function decidePermission(args, { stateDir, waitMs = APPROVAL_WAIT_MS, pollMs = 500, worker, now = () => Date.now() } = {}) {
  const req = writeRequest(stateDir, { toolName: args?.tool_name, input: args?.input, worker, now });
  const deadline = now() + waitMs;
  for (;;) {
    const ans = readAnswer(stateDir, req.id);
    if (ans) {
      return ans.allow
        ? { behavior: 'allow', updatedInput: req.input }
        : { behavior: 'deny', message: 'The operator DENIED this action. Do not retry it.' };
    }
    if (now() >= deadline) {
      return {
        behavior: 'deny',
        message: 'No operator response yet — treat this as PENDING approval: do NOT retry the ' +
                 'action this turn, continue all other work, and list it as "awaiting your OK" ' +
                 'in your reply. If approved later you will receive a new message saying so.',
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function handleMessage(msg, opts) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'approvals', version: '1.0.0' },
    } };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [TOOL] } };
  if (method === 'tools/call' && params?.name === 'permission_prompt') {
    const decision = await decidePermission(params.arguments || {}, opts);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } };
  }
  if (id === undefined) return null; // notification — no response
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } };
}

// Entry point when spawned by claude via --mcp-config (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const res = await handleMessage(msg, { stateDir: ORCH_DIR, worker: process.env.WORKER_NAME }).catch((e) => (
      { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e.message) } }));
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}
