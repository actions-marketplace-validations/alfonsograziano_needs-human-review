import type { FileRead } from '../types.ts';
import { HarnessError, type Harness, type HarnessInput, type HarnessResult } from './types.ts';

export type FakeAnswer = { finalText: string; reads: FileRead[] } | { error: string };

/** A harness that answers from a function. For tests and dry runs; it never calls a model. */
export class FakeHarness implements Harness {
  readonly name = 'fake';
  readonly calls: HarnessInput[] = [];
  readonly #answer: (input: HarnessInput, call: number) => FakeAnswer | Promise<FakeAnswer>;

  constructor(answer: (input: HarnessInput, call: number) => FakeAnswer | Promise<FakeAnswer>) {
    this.#answer = answer;
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    this.calls.push(input);
    const a = await this.#answer(input, this.calls.length);
    if ('error' in a) throw new HarnessError(a.error);
    return { finalText: a.finalText, raw: a.finalText, durationMs: 1, reads: a.reads };
  }
}
