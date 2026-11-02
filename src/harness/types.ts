import type { FileRead } from '../types.ts';

export interface HarnessInput {
  /** Default or override, custom instructions, then the output contract. */
  systemPrompt: string;
  /** Short and fixed. Never the diff. */
  userMessage: string;
  /** Read-only repo at the head SHA, with the review folder inside. */
  workdir: string;
  /** Model in the harness's format, for example "opencode/deepseek-v4.1-flash". */
  model: string;
  timeoutMs: number;
}

export interface HarnessResult {
  /** The model's last message. */
  finalText: string;
  /** Full harness output, kept for the log. */
  raw: string;
  durationMs: number;
  /** Every file the agent opened, taken from the tool-call log, never from the model's words. */
  reads: FileRead[];
  costUsd?: number;
  tokens?: { input: number; output: number };
}

/** One run is one reviewer. The harness never needs to know about slices. */
export interface Harness {
  readonly name: string;
  run(input: HarnessInput): Promise<HarnessResult>;
}

export class HarnessError extends Error {
  readonly raw: string;
  constructor(message: string, raw = '') {
    super(message);
    this.name = 'HarnessError';
    this.raw = raw;
  }
}
