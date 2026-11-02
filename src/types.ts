export type Mode = 'shadow' | 'advisory' | 'autonomous';
export type Risk = 'low' | 'medium' | 'high';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'type-changed';

/** One file changed by the PR, as git sees it. */
export interface ChangedFile {
  path: string;
  /** Set for renamed and copied files. */
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export type GateId = 'fork' | 'skip-label' | 'self-protected' | 'protected-paths' | 'size';

export interface GateResult {
  id: GateId;
  status: 'pass' | 'fail' | 'off';
  detail: string;
  /** The files that made the gate fail. */
  files?: string[];
}

export interface AffectedCode {
  location: string;
  why: string;
}

/** The JSON object every reviewer must answer with. */
export interface Verdict {
  decision: 'safe' | 'needs_human';
  risk: Risk;
  confidence: number;
  summary: string;
  reasons: string[];
  risk_areas: string[];
  files_reviewed: string[];
  affected_code: AffectedCode[];
}

/** A line range a reviewer must have read. Lines are 1-based and inclusive. */
export interface ReadRequirement {
  path: string;
  fromLine?: number;
  toLine?: number;
  /** Number of lines in the file, used when the whole file must be read. */
  totalLines: number;
}

/** A file the agent opened, taken from the harness's tool-call log. */
export interface FileRead {
  path: string;
  fromLine?: number;
  toLine?: number;
}

export const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
