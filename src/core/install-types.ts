/** M2 install contract. Pure types only — no dsh imports, no IO. */

export type ApplicationState = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';

export interface ChangeResultLike {
  changed: boolean;
  application: ApplicationState;
  stage: 'install' | 'enable' | 'remove';
  target: string;
  enabled?: boolean;
  error?: { code?: string; diagnostic?: string };
  warnings?: string[];
  packageResult?: { exitCode: number; output?: string; logPath?: string; kind?: string; timedOut?: boolean };
  pendingBuilds?: string[];
  bundle?: string;
}

export interface InstalledRow {
  id: string;
  moduleName?: string;
  enabled: boolean;
  fiberPhase?: 'active' | 'failed' | 'pending' | 'loading' | 'unloading' | null;
  meta?: { title?: string };
}

export interface InstalledBundle {
  name: string;
  enabled: boolean;
  rows?: { rowId: string; moduleName?: string }[];
}

/** The seam we need from the host. Everything optional degrades gracefully. */
export interface InstallSeam {
  kind: 'live' | 'fake';
  source: string;
  installBundle(spec: string, options?: { enabled?: boolean }): Promise<ChangeResultLike>;
  listPlugins?(): Promise<InstalledRow[]>;
  listBundles?(): Promise<InstalledBundle[]>;
  inspect?(spec: string): Promise<{ status: string; problem?: string; reason?: string }>;
}

export interface SeamProbe {
  available: boolean;
  source: string;
  checked: string[];
  methods: string[];
  note: string;
}

export type ConflictKind =
  | 'command'
  | 'tool'
  | 'slot'
  | 'package'
  | 'already-installed'
  | 'missing-member'
  | 'dsh-range';

export interface Conflict {
  kind: ConflictKind;
  key: string;
  members: string[];
  detail: string;
  severity: 'blocking' | 'warn';
  /** Concrete, copy-pasteable next action — never a stack trace. */
  fix: string;
}

export interface PlannedStep {
  member: string;
  spec: string;
  action: 'install' | 'skip-installed' | 'skip-excluded';
  reason?: string;
}

export interface InstallPlan {
  groupId: string;
  steps: PlannedStep[];
  conflicts: Conflict[];
  blocked: boolean;
}

export interface InstallStepResult {
  member: string;
  spec: string;
  status: 'installing' | 'done' | 'skipped' | 'failed';
  application?: ApplicationState;
  detail: string;
  nextSteps: string[];
}

export interface VerificationMember {
  member: string;
  present: boolean;
  active: boolean;
  enabled: boolean;
  detail: string;
  nextSteps: string[];
}

export interface VerificationReport {
  groupId: string;
  members: VerificationMember[];
  ok: boolean;
  summary: string;
}

export interface InstallReport {
  groupId: string;
  mode: 'live' | 'degraded';
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  summary: string;
  conflicts: Conflict[];
  steps: InstallStepResult[];
  verification: VerificationReport | null;
  nextSteps: string[];
}

export const APPLICATION_LABEL: Record<ApplicationState, string> = {
  applied: '已生效',
  'restart-required': '需重启后生效',
  overridden: '被更高优先级层覆盖',
  failed: '失败',
  cancelled: '已取消',
};
