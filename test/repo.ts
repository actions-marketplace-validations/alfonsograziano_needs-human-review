import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '../src/workspace.ts';

/** A throwaway git repo for tests. */
export async function tempRepo(): Promise<{ dir: string; write: (path: string, text: string) => Promise<void>; commit: (msg: string) => Promise<string>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ars-test-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  return {
    dir,
    write: async (path, text) => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    },
    commit: async (msg) => {
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-q', '-m', msg]);
      return (await git(dir, ['rev-parse', 'HEAD'])).trim();
    },
    cleanup: async () => {
      await git(dir, ['status']).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
