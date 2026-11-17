import type { FileRead } from '../types.ts';
import { agentEnv, relativePath, runProcess, timeoutMessage } from './process.ts';
import { HarnessError, type Harness, type HarnessResult, type HarnessSession, type SessionInput } from './types.ts';

export const AGENT_NAME = 'human-review';

/**
 * OpenCode config for one read-only reviewer. Every tool is denied, then only
 * read, grep and glob are allowed back (later rules win). MCP servers, skills,
 * plugins and integrations are denied by policy. OpenCode 2.2 treats the model
 * provider as an integration too, so the provider of `model` is allowed back.
 */
export function opencodeConfig(systemPrompt: string, model: string): Record<string, unknown> {
  const provider = model.split('/')[0] ?? '';
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
      { action: 'integration.use', resource: provider, effect: 'allow' },
    ],
  };
}

interface ToolPart {
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: unknown };
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

/** OpenCode reaches its models with these: its own key, a provider's, or a cloud's credentials (Bedrock, Vertex AI, Azure). */
const CREDENTIALS = /^(OPENCODE_[A-Z0-9_]+|[A-Z0-9_]+_API_KEY|[A-Z0-9_]+_BASE_URL|AWS_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|VERTEX_LOCATION|AZURE_[A-Z0-9_]+)$/;

export function harnessEnv(source: Record<string, string | undefined>): Record<string, string> {
  return agentEnv(source, CREDENTIALS);
}

/** Provider variables that do not follow the PROVIDER_API_KEY pattern. */
const KEY_VARIABLES: Record<string, string> = {
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  // A Bedrock API key. Without api-key, OpenCode uses AWS credentials from the job env.
  'amazon-bedrock': 'AWS_BEARER_TOKEN_BEDROCK',
};

/** The variable OpenCode reads the key from, for the provider in `model` (provider/model). */
export function keyVariable(model: string): string {
  const provider = model.split('/')[0] ?? '';
  return KEY_VARIABLES[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/**
 * The event log without what tools returned. Tool output is file content: it
 * stays on the runner. The record keeps which tools ran, on what, and the text.
 */
export function redactEvents(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => {
      if (!line.trim().startsWith('{')) return line;
      try {
        const e = JSON.parse(line) as { part?: { state?: Record<string, unknown> } };
        const state = e.part?.state;
        if (!state) return line;
        delete state.output;
        delete state.metadata;
        delete state.attachments;
        return JSON.stringify(e);
      } catch {
        return '[unparsed line removed]';
      }
    })
    .join('\n');
}

export interface ParsedEvents {
  finalText: string;
  /** The session the events belong to, needed to send a follow-up. */
  sessionId?: string;
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
  let sessionId: string | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let e: { type?: string; sessionID?: unknown; part?: Record<string, unknown>; error?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const part = e.part ?? {};
    if (sessionId === undefined && typeof e.sessionID === 'string' && SESSION_ID.test(e.sessionID)) sessionId = e.sessionID;
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
  return { finalText: (textByMessage.get(lastMessage) ?? []).join(''), ...(sessionId ? { sessionId } : {}), reads, costUsd, tokens, errors };
}

/** What a session ID may look like before it goes on the command line ("ses_..."). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_]*$/;

/** The arguments for one turn. A follow-up continues the session the first turn started. */
export function opencodeArgs(input: { model: string; userMessage: string; sessionId?: string }): string[] {
  return [
    'run',
    '--standalone',
    ...(input.sessionId ? ['--session', input.sessionId] : []),
    '--agent', AGENT_NAME,
    '--model', input.model,
    '--format', 'json',
    input.userMessage,
  ];
}

export class OpenCodeHarness implements Harness {
  readonly name = 'opencode';
  readonly #bin: string;
  readonly #apiKey: string | undefined;

  constructor(settings: { apiKey?: string } = {}, bin = process.env.OPENCODE_BIN || 'opencode') {
    this.#bin = bin;
    this.#apiKey = settings.apiKey || undefined;
  }

  open(input: SessionInput): HarnessSession {
    let sessionId: string | undefined;
    let turns = 0;
    return {
      send: async (userMessage: string, timeoutMs: number): Promise<HarnessResult> => {
        if (turns++ > 0 && !sessionId) throw new HarnessError('opencode reported no session ID, so the review cannot be continued');
        const result = await this.#turn(input, userMessage, timeoutMs, sessionId);
        sessionId ??= result.sessionId;
        return result.result;
      },
      // OpenCode keeps the session in its own data folder, which the CI runner throws away.
      close: async () => undefined,
    };
  }

  async #turn(input: SessionInput, userMessage: string, timeoutMs: number, sessionId: string | undefined): Promise<{ result: HarnessResult; sessionId?: string }> {
    const started = Date.now();
    const env = {
      ...harnessEnv(process.env),
      // The api-key input goes where the model's provider looks for it, over any value in the job env.
      ...(this.#apiKey ? { [keyVariable(input.model)]: this.#apiKey } : {}),
      // OpenCode takes its project root from PWD, not from the process cwd.
      PWD: input.workdir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(input.systemPrompt, input.model)),
      // The repo is untrusted. Its own opencode.json, .opencode/ agents and plugins must not load.
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    const args = opencodeArgs({ model: input.model, userMessage, ...(sessionId ? { sessionId } : {}) });

    const { code, stdout, stderr, timedOut } = await runProcess('opencode', this.#bin, args, { cwd: input.workdir, env, timeoutMs });
    const raw = redactEvents(stdout);
    if (timedOut) throw new HarnessError(timeoutMessage(timeoutMs), raw);
    const parsed = parseEvents(input.workdir, stdout);
    if (code !== 0) {
      const why = [...parsed.errors, stderr.trim().slice(-500)].filter((s) => s !== '').join('; ') || 'no error message';
      throw new HarnessError(`opencode exited with code ${code}: ${why}`, raw);
    }
    if (parsed.errors.length > 0) throw new HarnessError(`opencode reported an error: ${parsed.errors.join('; ')}`, raw);
    if (parsed.finalText.trim() === '') throw new HarnessError('the model gave no final answer', raw);
    return {
      result: {
        finalText: parsed.finalText,
        raw,
        durationMs: Date.now() - started,
        reads: parsed.reads,
        costUsd: parsed.costUsd,
        tokens: parsed.tokens,
      },
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    };
  }
}
