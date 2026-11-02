import { readConfig, type Config } from '../src/inputs.ts';
import type { ChangedFile } from '../src/types.ts';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...readConfig({}), ...overrides };
}

export function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'modified', additions: 1, deletions: 1, binary: false, ...overrides };
}
