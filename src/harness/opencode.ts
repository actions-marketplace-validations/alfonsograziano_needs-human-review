import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { FileRead } from '../types.ts';
import { HarnessError, type Harness, type HarnessInput, type HarnessResult } from './types.ts';

export const AGENT_NAME = 'risk-scorer';

/**
 * OpenCode config for one read-only reviewer. Every tool is denied, then only
 * read, grep and glob are allowed back (later rules win). MCP servers, skills,
 * plugins and integrations are denied by policy.
 */
export function opencodeConfig(systemPrompt: string): Record<string, unknown> {
  return {
    agents: {
      [AGENT_NAME]: {
        mode: 'primary',
        description: 'Read-only pull request risk reviewer',
        system: systemPrompt,
        steps: 80,
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'read', resource: '*', effect: 'allow' },
          { action: 'grep', resource: '*', effect: 'allow' },
          { action: 'glob', resource: '*', effect: 'allow' },
        ],
      },
    },
    policies: [
      { action: 'mcp.use', resource: '*', effect: 'deny' },
      { action: 'skill.use', resource: '*', effect: 'deny' },
      { action: 'plugin.use', resource: '*', effect: 'deny' },
      { action: 'integration.use', resource: '*', effect: 'deny' },
    ],
  };
}

interface ToolPart {
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: unknown };
}

function relativePath(workdir: string, p: string): string {
  if (!isAbsolute(p)) return p.replace(/^\.\//, '');
  for (const root of new Set([workdir, safeRealpath(workdir)])) {
    const rel = relative(root, p);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return p;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Reads the real line range from the tool's own output, for example "Read file a.ts, lines 1-2000". */
export function readFromToolPart(workdir: string, part: ToolPart): FileRead | undefined {
  if (part.tool !== 'read' || part.state?.status !== 'completed') return undefined;
  const input = part.state.input ?? {};
  const rawPath = (input.path ?? input.filePath) as string | undefined;
  if (typeof rawPath !== 'string') return undefined;
  const path = relativePath(workdir, rawPath);
  const output = typeof part.state.output === 'string' ? part.state.output : '';
  const m = /^Read file .*?, lines (\d+)-(\d+)/m.exec(output);
  if (m) return { path, fromLine: Number(m[1]), toLine: Number(m[2]) };
  if (/^Read file .*?, (empty|0 lines)/im.test(output)) return { path, fromLine: 1, toLine: 0 };
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  if (offset === undefined && limit === undefined) return { path };
  const from = offset ?? 1;
  return limit === undefined ? { path, fromLine: from } : { path, fromLine: from, toLine: from + limit - 1 };
}

export interface ParsedEvents {
  finalText: string;
  reads: FileRead[];
  costUsd: number;
  tokens: { input: number; output: number };
  errors: string[];
}

/** Parses `opencode run --format json` output: one JSON event per line. */
export function parseEvents(workdir: string, stdout: string): ParsedEvents {
  const reads: FileRead[] = [];
  const textByMessage = new Map<string, string[]>();
  let lastMessage = '';
  let costUsd = 0;
  const tokens = { input: 0, output: 0 };
  const errors: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let e: { type?: string; part?: Record<string, unknown>; error?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const part = e.part ?? {};
    if (e.type === 'tool_use') {
      const r = readFromToolPart(workdir, part as ToolPart);
      if (r) reads.push(r);
    } else if (e.type === 'text') {
      const id = String(part.messageID ?? '');
      textByMessage.set(id, [...(textByMessage.get(id) ?? []), String(part.text ?? '')]);
      lastMessage = id;
    } else if (e.type === 'step_finish') {
      costUsd += Number(part.cost ?? 0);
      const t = part.tokens as { input?: number; output?: number } | undefined;
      tokens.input += t?.input ?? 0;
      tokens.output += t?.output ?? 0;
    } else if (e.type === 'error') {
      errors.push(JSON.stringify(e.error ?? e).slice(0, 500));
    }
  }
  return { finalText: (textByMessage.get(lastMessage) ?? []).join(''), reads, costUsd, tokens, errors };
}

export class OpenCodeHarness implements Harness {
  readonly name = 'opencode';
  readonly #bin: string;

  constructor(bin = process.env.OPENCODE_BIN || 'opencode') {
    this.#bin = bin;
  }

  run(input: HarnessInput): Promise<HarnessResult> {
    const started = Date.now();
    const env = {
      ...process.env,
      // OpenCode takes its project root from PWD, not from the process cwd.
      PWD: input.workdir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(input.systemPrompt)),
      // The repo is untrusted. Its own opencode.json, .opencode/ agents and plugins must not load.
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    const args = ['run', '--standalone', '--agent', AGENT_NAME, '--model', input.model, '--format', 'json', input.userMessage];

    return new Promise((resolve, reject) => {
      const child = spawn(this.#bin, args, { cwd: input.workdir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, input.timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new HarnessError(`could not start opencode: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const raw = stdout;
        if (timedOut) return reject(new HarnessError(`timed out after ${Math.round(input.timeoutMs / 60_000)} minutes`, raw));
        const parsed = parseEvents(input.workdir, stdout);
        if (code !== 0) {
          const why = [...parsed.errors, stderr.trim().slice(-500)].filter((s) => s !== '').join('; ') || 'no error message';
          return reject(new HarnessError(`opencode exited with code ${code}: ${why}`, raw));
        }
        if (parsed.errors.length > 0) return reject(new HarnessError(`opencode reported an error: ${parsed.errors.join('; ')}`, raw));
        if (parsed.finalText.trim() === '') return reject(new HarnessError('the model gave no final answer', raw));
        resolve({
          finalText: parsed.finalText,
          raw,
          durationMs: Date.now() - started,
          reads: parsed.reads,
          costUsd: parsed.costUsd,
          tokens: parsed.tokens,
        });
      });
    });
  }
}
