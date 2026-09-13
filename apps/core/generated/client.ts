// Generated from resources/openapi.json. Run npm run contract --workspace @daevox/core.
export type CoreError = { code: string; message: string; retryable: boolean; details: unknown };
export type ManagementError = { error: CoreError; request_id: string };
export type Instance = {
  id: string;
  model_set_id: string;
  preset_id: string;
  applied_preset_revision: string;
  build_id: string;
  started_at: string;
  ready_at: string | null;
  status: string;
};
export type Recovery = { id: string; pid?: number; reason: string; allowed_actions: Array<string> };
export type RuntimeSnapshot = {
  session_id: string;
  state: 'empty' | 'ready' | 'waiting' | 'unloading' | 'loading' | 'error' | 'recovery_required';
  active_instance: Instance | null;
  target: SwitchRequest | null;
  current_operation_id: string | null;
  current_build_id: string | null;
  last_selected_preset_id: string | null;
  inflight_requests: number;
  recovery: Array<Recovery>;
  revision: number;
  error?: CoreError | null;
};
export type Settings = { drain_timeout_ms: number; compiler_jobs: number; revision: string };
export type Progress = {
  bytes_done: number | null;
  bytes_total: number | null;
  bytes_per_second: number | null;
  percent: number | null;
  file_id: string | null;
};
export type Operation = {
  id: string;
  type:
    | 'build'
    | 'build_apply'
    | 'runtime_switch'
    | 'download'
    | 'build_delete'
    | 'model_set_delete'
    | 'recovery';
  status: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  resource_id: string | null;
  created_at: string;
  updated_at: string;
  progress: Progress | null;
  error: CoreError | null;
  allowed_actions: Array<string>;
  cancel_requested?: boolean;
  pause_requested?: boolean;
  queued_at?: number;
};
export type Accepted = { operation_id: string; model_set_id?: string };
export type Diagnostic = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line: number | null;
  key: string | null;
};
export type PresetSource = {
  id: string;
  name: string;
  revision: string;
  text: string;
  diagnostics: Array<Diagnostic>;
};
export type Preset = {
  id: string;
  source_file_id: string;
  model_set_id: string | null;
  saved_revision: string;
  applied_revision: string | null;
  can_launch: boolean;
  diagnostics: Array<Diagnostic>;
};
export type PresetCatalog = {
  files: Array<PresetSource>;
  presets: Array<Preset>;
  revision: string;
};
export type ModelFile = {
  id: string;
  path: string;
  role: 'weights' | 'shard' | 'projector';
  size_bytes: number | null;
  downloaded_bytes: number;
  availability: 'downloading' | 'available' | 'missing' | 'failed';
  local_path: string;
  url: string;
  shared?: boolean;
};
export type ModelSet = {
  id: string;
  repo_id: string;
  commit: string;
  files: Array<ModelFile>;
  availability: 'downloading' | 'available' | 'missing' | 'failed';
  download_operation_id: string | null;
  preset_ids: Array<string>;
};
export type ModelReferences = {
  model_set_id: string;
  revision: string;
  preset_ids: Array<string>;
  files: Array<{ file_id: string; shared_with: Array<string>; will_delete: boolean }>;
};
export type Build = {
  id: string;
  profile: 'cuda' | 'cpu';
  jobs: number;
  status: 'building' | 'ready' | 'failed' | 'cancelled' | 'interrupted';
  checks:
    | {
        router_health: boolean;
        devices: string;
        inference: 'not_checked' | 'passed' | 'failed';
        driver_version?: string | null;
        driver_compatibility?: 'passed' | 'failed';
        compatibility_error?: string | null;
      }
    | Array<unknown>;
  current: boolean;
  previous: boolean;
  commit?: string;
  fingerprint?: string;
  configuration?: {
    commit: string;
    profile: string;
    cmake: string;
    compiler: string;
    cache: string;
    devices: string;
  };
};
export type MetricValue = {
  value: number | null;
  unit: string;
  availability: 'available' | 'unsupported' | 'error';
  sampled_at: string;
  last_success_at: string | null;
  reason: string | null;
};
export type GpuSample = {
  id: string | null;
  uuid: string | null;
  pci: string | null;
  nvml_index: number;
  cuda_index: number | null;
  name: string | null;
  utilisation: MetricValue;
  vram_used: MetricValue;
  vram_total: MetricValue;
  temperature: MetricValue;
  power: MetricValue;
  fan: MetricValue;
};
export type RequestMetric = {
  request_id: string;
  instance_id: string;
  preset_id: string;
  applied_revision: string;
  build_id: string;
  ttft_ms: number | null;
  duration_ms: number;
  tokens_per_second: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  source: string;
  timestamp: string;
  status: 'succeeded' | 'failed' | 'cancelled';
};
export type InferenceMetrics = {
  succeeded: number;
  failed: number;
  cancelled: number;
  prompt_tokens: number;
  completion_tokens: number;
  last_request: RequestMetric | null;
};
export type ProcessMetric = {
  pid: number;
  role: 'core' | 'owned';
  cpu: MetricValue;
  ram: MetricValue;
  gpu_memory: Array<{ gpu_id: string | null; memory: MetricValue }>;
};
export type MetricSample = {
  session_id: string;
  timestamp: string;
  processes: Array<ProcessMetric>;
  inference: InferenceMetrics;
  cpu: {
    total: MetricValue;
    logical: Array<{ name: string; usage: MetricValue; frequency: MetricValue }>;
    temperatures: Array<{ name: string; temperature: MetricValue }>;
  };
  ram: { total: MetricValue; used: MetricValue; swap_total: MetricValue; swap_used: MetricValue };
  gpus: Array<GpuSample>;
  gpu_availability: 'available' | 'unsupported' | 'error';
};
export type LogEntry = {
  id: string;
  source: string;
  stream: string;
  timestamp: string;
  level: string | null;
  build_id: string | null;
  operation_id: string | null;
  instance_id: string | null;
  message: string;
  truncated: boolean;
  dropped_before: number;
};
export type Logs = {
  entries: Array<LogEntry>;
  segments: Array<{ id: string; size_bytes: number }>;
  cursor: string | null;
  gap: boolean;
};
export type EventSnapshot = {
  runtime: RuntimeSnapshot;
  settings: Settings;
  operations: Array<Operation>;
  catalog_revisions: { presets: string | null; builds: string; model_sets: string };
};
export type CatalogRevisions = { presets: string | null; builds: string; model_sets: string };
export type EventEnvelope =
  | { session_id: string; seq: number; type: 'snapshot'; timestamp: string; payload: EventSnapshot }
  | {
      session_id: string;
      seq: number;
      type: 'runtime.changed';
      timestamp: string;
      payload: RuntimeSnapshot;
    }
  | {
      session_id: string;
      seq: number;
      type: 'operation.changed';
      timestamp: string;
      payload: Array<Operation>;
    }
  | {
      session_id: string;
      seq: number;
      type: 'catalog.changed';
      timestamp: string;
      payload: Settings | CatalogRevisions;
    }
  | {
      session_id: string;
      seq: number;
      type: 'preset.changed';
      timestamp: string;
      payload: { revision: string | null };
    }
  | {
      session_id: string;
      seq: number;
      type: 'build.changed';
      timestamp: string;
      payload: { revision: string };
    }
  | {
      session_id: string;
      seq: number;
      type: 'metric.sample';
      timestamp: string;
      payload: MetricSample;
    }
  | { session_id: string; seq: number; type: 'log.append'; timestamp: string; payload: LogEntry }
  | {
      session_id: string;
      seq: number;
      type: 'gap';
      timestamp: string;
      payload: { reason: string };
    };
export type SwitchRequest = { preset_id: string | null; preset_revision?: string };
export type BuildRequest = { profile: 'cuda' | 'cpu'; jobs: number; clean?: boolean };
export type CreateSource = { name: string; text: string };
export type SaveSource = { text: string; base_revision: string; overwrite: boolean };
export type RevisionRequest = { revision: string };
export type DownloadRequest = {
  repo_id: string;
  commit: string;
  files: Array<{ path: string; role: 'weights' | 'shard' | 'projector' }>;
};
export type RestartFileRequest = { file_id: string };
export type HubModels = {
  models: Array<{ id: string; downloads?: number; likes?: number; tags?: Array<string> }>;
  cursor: string | null;
};
export type HubFiles = {
  repo_id: string;
  commit: string;
  files: Array<{
    path: string;
    role: 'weights' | 'shard' | 'projector';
    size_bytes: number | null;
  }>;
};
export class CoreApiError extends Error {
  constructor(
    public status: number,
    public body: ManagementError,
  ) {
    super(body.error.message);
  }
}
export class CoreClient {
  constructor(public baseUrl = '/core') {}
  private async request<T>(path: string, method: string, body?: unknown, key?: string): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'Idempotency-Key': key ?? crypto.randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const fallback: ManagementError = {
        error: {
          code: 'network_error',
          message: response.statusText,
          retryable: true,
          details: null,
        },
        request_id: '',
      };
      const error: ManagementError = await response.json().catch(() => fallback);
      throw new CoreApiError(response.status, error);
    }
    return (response.status === 204 ? null : await response.json()) as T;
  }

  health(): Promise<{ status: string }> {
    return this.request(`/health`, 'GET', undefined, undefined);
  }
  runtime(): Promise<RuntimeSnapshot> {
    return this.request(`/runtime`, 'GET', undefined, undefined);
  }
  settings(): Promise<Settings> {
    return this.request(`/settings`, 'GET', undefined, undefined);
  }
  saveSettings(body: Settings, key?: string): Promise<Settings> {
    return this.request(`/settings`, 'PUT', body, key);
  }
  presets(): Promise<PresetCatalog> {
    return this.request(`/presets`, 'GET', undefined, undefined);
  }
  createSource(body: CreateSource, key?: string): Promise<PresetSource> {
    return this.request(`/preset-files`, 'POST', body, key);
  }
  source(id: string): Promise<PresetSource> {
    return this.request(`/preset-files/${encodeURIComponent(id)}`, 'GET', undefined, undefined);
  }
  saveSource(id: string, body: SaveSource, key?: string): Promise<PresetSource> {
    return this.request(`/preset-files/${encodeURIComponent(id)}`, 'PUT', body, key);
  }
  deleteSource(id: string, body: RevisionRequest, key?: string): Promise<null> {
    return this.request(`/preset-files/${encodeURIComponent(id)}`, 'DELETE', body, key);
  }
  switchPreset(body: SwitchRequest, key?: string): Promise<Accepted> {
    return this.request(`/runtime/switch`, 'POST', body, key);
  }
  operations(
    query: { cursor?: string } = {},
  ): Promise<{ operations: Array<Operation>; cursor: string | null }> {
    return this.request(
      `/operations` +
        '?' +
        new URLSearchParams(
          Object.entries(query).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      'GET',
      undefined,
      undefined,
    );
  }
  operation(id: string): Promise<Operation> {
    return this.request(`/operations/${encodeURIComponent(id)}`, 'GET', undefined, undefined);
  }
  cancelOperation(id: string, key?: string): Promise<Accepted> {
    return this.request(`/operations/${encodeURIComponent(id)}/cancel`, 'POST', undefined, key);
  }
  forceOperation(id: string, key?: string): Promise<Accepted> {
    return this.request(`/operations/${encodeURIComponent(id)}/force`, 'POST', undefined, key);
  }
  builds(): Promise<{ builds: Array<Build> }> {
    return this.request(`/builds`, 'GET', undefined, undefined);
  }
  createBuild(body: BuildRequest, key?: string): Promise<Accepted> {
    return this.request(`/builds`, 'POST', body, key);
  }
  applyBuild(id: string, key?: string): Promise<Accepted> {
    return this.request(`/builds/${encodeURIComponent(id)}/apply`, 'POST', undefined, key);
  }
  deleteBuild(id: string, key?: string): Promise<Accepted> {
    return this.request(`/builds/${encodeURIComponent(id)}`, 'DELETE', undefined, key);
  }
  stopRecovery(id: string, key?: string): Promise<Accepted> {
    return this.request(`/recovery/${encodeURIComponent(id)}/stop`, 'POST', undefined, key);
  }
  hubModels(query: { q?: string; cursor?: string } = {}): Promise<HubModels> {
    return this.request(
      `/hub/models` +
        '?' +
        new URLSearchParams(
          Object.entries(query).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      'GET',
      undefined,
      undefined,
    );
  }
  hubFiles(query: { repo?: string; revision?: string } = {}): Promise<HubFiles> {
    return this.request(
      `/hub/files` +
        '?' +
        new URLSearchParams(
          Object.entries(query).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      'GET',
      undefined,
      undefined,
    );
  }
  modelSets(): Promise<{ model_sets: Array<ModelSet> }> {
    return this.request(`/model-sets`, 'GET', undefined, undefined);
  }
  modelReferences(id: string): Promise<ModelReferences> {
    return this.request(
      `/model-sets/${encodeURIComponent(id)}/references`,
      'GET',
      undefined,
      undefined,
    );
  }
  deleteModelSet(id: string, body: RevisionRequest, key?: string): Promise<Accepted> {
    return this.request(`/model-sets/${encodeURIComponent(id)}`, 'DELETE', body, key);
  }
  download(body: DownloadRequest, key?: string): Promise<Accepted> {
    return this.request(`/downloads`, 'POST', body, key);
  }
  pauseDownload(id: string, key?: string): Promise<Accepted> {
    return this.request(`/downloads/${encodeURIComponent(id)}/pause`, 'POST', undefined, key);
  }
  resumeDownload(id: string, key?: string): Promise<Accepted> {
    return this.request(`/downloads/${encodeURIComponent(id)}/resume`, 'POST', undefined, key);
  }
  cancelDownload(id: string, key?: string): Promise<Accepted> {
    return this.request(`/downloads/${encodeURIComponent(id)}/cancel`, 'POST', undefined, key);
  }
  restartFile(id: string, body: RestartFileRequest, key?: string): Promise<Accepted> {
    return this.request(`/downloads/${encodeURIComponent(id)}/restart-file`, 'POST', body, key);
  }
  metrics(query: { from?: string; to?: string } = {}): Promise<{ samples: Array<MetricSample> }> {
    return this.request(
      `/metrics` +
        '?' +
        new URLSearchParams(
          Object.entries(query).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      'GET',
      undefined,
      undefined,
    );
  }
  logs(query: { source?: string; query?: string; cursor?: string } = {}): Promise<Logs> {
    return this.request(
      `/logs` +
        '?' +
        new URLSearchParams(
          Object.entries(query).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      'GET',
      undefined,
      undefined,
    );
  }
  openapi(): Promise<unknown> {
    return this.request(`/openapi.json`, 'GET', undefined, undefined);
  }
}
