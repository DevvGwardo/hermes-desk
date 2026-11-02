/** Version 7 binds a new renderer build to sealed inputs, not native qualification. */
export interface SourceBaseline {
  root: string
  dev: number
  ino: number
  gitDev: number
  gitIno: number
  head: string
  statusDigest: string
  dirtyEntries: number
  kind: 'head' | 'working-tree'
  dirtyExcluded: boolean
}

export interface SourcePreparationRecord {
  operationId: string
  ownerPid: number
  source: SourceBaseline
  workspace: { id: string; token: string; dev: number | null; ino: number | null }
  manifestDigest: string | null
  fileCount: number | null
  error: string | null
}

export interface ChangeAttempt {
  id: string
  state: 'requested' | 'preparing' | 'prepared' | 'implementing' | 'implemented' | 'checking' | 'checked' | 'failed' | 'cancelled'
  epoch: number
  requestedAt: string
  cancelledAt: string | null
  statusAt: string
  preparation: SourcePreparationRecord | null
  execution: ExecutionRecord | null
  validation: ValidationRecord | null
}

export interface ValidationRecord {
  operationId: string
  ownerPid: number
  scope: 'renderer-only'
  stage: 'checking' | 'building' | 'checked' | 'failed'
  sourceDigest: string
  toolchainDigest: string
  checksPassed: boolean
  artifact: {
    id: string; token: string; dev: number; ino: number; digest: string; sourceDigest: string; toolchainDigest: string
    fileCount: number; scope: 'renderer-only'; activationEligible: false
  } | null
  preview: {
    id: string; ownerPid: number; state: 'opening' | 'open' | 'closed' | 'interrupted'; artifactDigest: string
    rendererReady: boolean; behaviorVerified: false; error: string | null
  } | null
  error: string | null
  authority: {
    operationId: string; ownerPid: number; scope: 'main-preload-test-doubles'; stage: 'running' | 'passed' | 'failed'
    sourceDigest: string; rendererDigest: string; definitionDigest: string
    observationDigest: string | null; checks: number | null
    nativeBehaviorVerified: false; fullAppQualified: false; error: string | null
  } | null
  seal: {
    operationId: string; ownerPid: number; scope: 'full-app-inputs'; stage: 'sealing' | 'sealed' | 'failed'
    sourceDigest: string; rendererDigest: string; toolchainDigest: string; dependencyDigest: string
    fullAppQualified: false; error: string | null
    artifact: {
      id: string; token: string; dev: number; ino: number; digest: string; provenanceDigest: string
      entries: number; bytes: number; activationEligible: false
    } | null
  } | null
  boundBuild: {
    operationId: string; ownerPid: number; scope: 'sealed-graph-renderer'; stage: 'checking' | 'passed' | 'failed'
    inputDigest: string; sourceDigest: string; dependencyDigest: string; toolchainDigest: string
    fullAppQualified: false; error: string | null
    artifact: {
      id: string; token: string; dev: number; ino: number; rendererDigest: string; boundDigest: string
      fileCount: number; activationEligible: false
    } | null
  } | null
}

export interface ExecutionRecord {
  operationId: string
  ownerPid: number
  stage: 'running' | 'applying' | 'implemented' | 'failed'
  port: number
  model: string
  files: string[]
  inputDigest: string
  calls: number
  outputDigest: string | null
  error: string | null
}

export interface ImplementationInput {
  port: number
  model: string
  files: string[]
}

export interface ChangeRecord {
  id: string
  request: string
  acceptanceCriteria: string
  createdAt: string
  updatedAt: string
  cancellationEpoch: number
  attempts: ChangeAttempt[]
}

export interface ChangeSnapshot {
  revision: number
  changes: ChangeRecord[]
}

export type ChangeResult = ({ ok: true } & ChangeSnapshot) | {
  ok: false
  code: 'invalid' | 'stale' | 'storage' | 'unavailable' | 'uncertain' | 'limit' | 'ownership'
  error: string
}

export interface ChangeBridge {
  list(): Promise<ChangeResult>
  create(revision: number, input: { request: string; acceptanceCriteria: string }): Promise<ChangeResult>
  cancel(revision: number, id: string, attemptId: string): Promise<ChangeResult>
  reopen(revision: number, id: string, attemptId: string): Promise<ChangeResult>
  selectRepository(): Promise<{ ok: true; selection: RepositorySelection | null } | Extract<ChangeResult, { ok: false }>>
  prepare(revision: number, id: string, attemptId: string, decision: { selectionId: string; baseline: 'head' | 'working-tree' }): Promise<ChangeResult>
  review(id: string, attemptId: string): Promise<WorkspaceReview | Extract<ChangeResult, { ok: false }>>
  implement(revision: number, id: string, attemptId: string, input: ImplementationInput): Promise<ChangeResult>
  validate(revision: number, id: string, attemptId: string): Promise<ChangeResult>
  preview(revision: number, id: string, attemptId: string): Promise<ChangeResult>
  authority(revision: number, id: string, attemptId: string): Promise<ChangeResult>
  seal(revision: number, id: string, attemptId: string): Promise<ChangeResult>
  boundBuild(revision: number, id: string, attemptId: string): Promise<ChangeResult>
  nativeInputs(revision: number, id: string, attemptId: string): Promise<NativeInputsResult>
  deliveryStatus?(id: string, attemptId: string): Promise<DeliveryResult>
  qualify?(revision: number, id: string, attemptId: string): Promise<DeliveryResult>
  deliveryReview?(revision: number, id: string, attemptId: string): Promise<DeliveryResult>
  approve?(revision: number, id: string, attemptId: string, versionId: string, reviewDigest: string): Promise<DeliveryResult>
  selectActivationTarget?(revision: number, id: string, attemptId: string, versionId: string): Promise<DeliveryResult>
  activate?(revision: number, id: string, attemptId: string, versionId: string): Promise<DeliveryResult>
}

export interface DeliveryRecord {
  versionId: string; changeId: string; attemptId: string; epoch: number; journalRevision: number
  stage: 'qualifying' | 'qualified' | 'failed' | 'approved' | 'rejected' | 'activating' | 'accepted' | 'rolled-back' | 'cancelled'
  scope: 'frontend-only-v1'; createdAt: string; updatedAt: string; ownerPid: number
  qualification: { artifactDigest: string; rendererDigest: string; sourceDigest: string; hostDigest: string; observationDigest: string
    hostIdentity: { codeDigest: string; version: string; origin: { kind: 'directory' | 'asar'; path: string; archiveSha256: string | null } }
    runtime: { relativePath: string; sha256: string; pid: number } } | null
  reviewDigest: string | null
  approval: { id: string; artifactDigest: string; reviewDigest: string; expiresAt: string } | null
  target: { root: string; dev: number; ino: number; identityDigest: string } | null
  outcome: { state: string; nonce: string; artifactDigest: string; reason: string } | null
  error: string | null
}
export interface DeliveryReview {
  versionId: string; artifactDigest: string; reviewDigest: string; checks: string[]; healthScope: string
  changeId?: string; attemptId?: string; request?: string; acceptanceCriteria?: string; baseline?: SourceBaseline
  storageScope: string; catalogScope: string
  changes: Array<{ path: string; beforeSha256: string | null; afterSha256: string | null; diff: string | null }>
}
export type DeliveryResult = {
  ok: true; records: DeliveryRecord[]; review?: DeliveryReview
  authorityAvailable?: boolean; historicalReadOnly?: boolean
} | Extract<ChangeResult, { ok: false }>

export type NativeInputsResult = { ok: true; nativeInputs: {
  scope: 'lexical-native-inputs'; inputDigest: string; sourceDigest: string; boundDigest: string
  missing: string[]; missingTotal: number; literalRequires: number; nonliteralRequires: number; scannedFiles: number; skippedFiles: number
  inspectionComplete: false; nativeExecuted: false; fullAppQualified: false; activationEligible: false
} } | Extract<ChangeResult, { ok: false }>

export interface RepositorySelection {
  id: string
  root: string
  head: string
  dirtyEntries: number
  workingTree?: {
    digest: string; fileCount: number; bytes: number
    changes: Array<{ path: string; status: string; beforeSha256: string | null; afterSha256: string | null; binary: boolean; diff: string | null }>
  }
}

export interface WorkspaceReview {
  ok: true
  workspaceId: string
  baselineHead: string
  files: Array<{ path: string; status: 'unchanged' | 'added' | 'modified' | 'deleted';
    beforeSha256: string | null; afterSha256: string | null; binary: boolean; truncated: boolean; diff: string | null; editable?: boolean }>
}
