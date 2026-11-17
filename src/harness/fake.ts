import type { FileRead } from '../types.ts';
import { HarnessError, type Harness, type HarnessInput, type HarnessResult, type HarnessSession, type SessionInput } from './types.ts';

export type FakeAnswer = { finalText: string; reads: FileRead[] } | { error: string };

/** One message the fake received. `turn` is 1 for the first message of a session, 2 for its first follow-up, and so on. */
export interface FakeCall extends HarnessInput {
  turn: number;
}

/** A harness that answers from a function. For tests and dry runs; it never calls a model. */
export class FakeHarness implements Harness {
  readonly name = 'fake';
  readonly calls: FakeCall[] = [];
  readonly #answer: (input: FakeCall, call: number) => FakeAnswer | Promise<FakeAnswer>;

  constructor(answer: (input: FakeCall, call: number) => FakeAnswer | Promise<FakeAnswer>) {
    this.#answer = answer;
  }

  open(input: SessionInput): HarnessSession {
    let turn = 0;
    return {
      send: async (userMessage: string, timeoutMs: number): Promise<HarnessResult> => {
        const call: FakeCall = { ...input, userMessage, timeoutMs, turn: ++turn };
        this.calls.push(call);
        const a = await this.#answer(call, this.calls.length);
        if ('error' in a) throw new HarnessError(a.error);
        return { finalText: a.finalText, raw: a.finalText, durationMs: 1, reads: a.reads };
      },
      close: async () => undefined,
    };
  }
}
