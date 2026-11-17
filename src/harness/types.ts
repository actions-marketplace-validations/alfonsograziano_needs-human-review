import type { FileRead } from '../types.ts';

export interface SessionInput {
  /** Default or override, custom instructions, then the output contract. */
  systemPrompt: string;
  /** Read-only repo at the head SHA, with the review folder inside. */
  workdir: string;
  /** Model in the harness's format, for example "opencode/deepseek-v4.1-flash". */
  model: string;
}

export interface HarnessInput extends SessionInput {
  /** Short and fixed. Never the diff. */
  userMessage: string;
  timeoutMs: number;
}

/** What one turn of the conversation returned. */
export interface HarnessResult {
  /** The model's last message. */
  finalText: string;
  /** Full harness output, kept for the log. */
  raw: string;
  durationMs: number;
  /** Every file the agent opened in this turn, taken from the tool-call log, never from the model's words. */
  reads: FileRead[];
  costUsd?: number;
  tokens?: { input: number; output: number };
}

/**
 * One reviewer's conversation. The first `send` starts it; each later `send`
 * continues the same conversation, so the agent keeps what it already read.
 * `close` removes whatever the session kept on disk.
 */
export interface HarnessSession {
  send(userMessage: string, timeoutMs: number): Promise<HarnessResult>;
  close(): Promise<void>;
}

/** One session is one reviewer. The harness never needs to know about slices. */
export interface Harness {
  readonly name: string;
  open(input: SessionInput): HarnessSession;
}

/** One reviewer, one message: open, send, close. */
export async function runOnce(harness: Harness, input: HarnessInput): Promise<HarnessResult> {
  const session = harness.open(input);
  try {
    return await session.send(input.userMessage, input.timeoutMs);
  } finally {
    await session.close();
  }
}

export class HarnessError extends Error {
  readonly raw: string;
  constructor(message: string, raw = '') {
    super(message);
    this.name = 'HarnessError';
    this.raw = raw;
  }
}
