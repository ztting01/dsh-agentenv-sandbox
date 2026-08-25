import { posix } from 'node:path'

/** Action taken for the owned sandbox when the Harness composition unloads. */
export type DisposeAction = 'kill' | 'pause'

/** Handling for symbolic links found during the initial workspace upload. */
export type SymlinkPolicy = 'copy-internal' | 'error' | 'skip'

/** User-facing AgentENV runtime configuration. */
export interface Config {
  /** AgentENV control-plane URL; defaults to E2B_API_URL or localhost:8000. */
  apiUrl?: string
  /** AgentENV sandbox data-plane URL; defaults to E2B_SANDBOX_URL or apiUrl. */
  sandboxUrl?: string
  /** AgentENV API key; defaults to E2B_API_KEY and then AENV_API_KEY. */
  apiKey?: string
  /** Existing AgentENV template id or alias. */
  template?: string
  /** Existing sandbox id to reconnect instead of creating a sandbox. */
  sandboxId?: string
  /** Absolute POSIX working directory shared by every remote provider. */
  cwd?: string
  /** Sandbox lifetime requested from AgentENV. */
  timeoutMs?: number
  /** Whether AgentENV should protect envd with a sandbox access token. */
  secure?: boolean
  /** Final disposition for a sandbox owned or reconnected by this plugin. */
  onDispose?: DisposeAction
  /** Upload the host working tree before publishing the sandbox handle. */
  uploadWorkspace?: boolean
  /** Local directory uploaded when uploadWorkspace is true. */
  localCwd?: string
  /** Top-level or nested relative path names omitted from upload. */
  uploadExcludes?: string[]
  /** Maximum number of regular files accepted by the uploader. */
  uploadMaxFiles?: number
  /** Maximum aggregate bytes accepted by the uploader. */
  uploadMaxBytes?: number
  /** Maximum bytes accepted for any one file. */
  uploadMaxFileBytes?: number
  /** Whether an internal file link is copied, or any link aborts/is omitted. */
  symlinkPolicy?: SymlinkPolicy
}

/** Fully defaulted and validated runtime configuration. */
export interface ResolvedConfig {
  apiUrl: string
  sandboxUrl: string
  apiKey: string
  template: string
  sandboxId?: string
  cwd: string
  timeoutMs: number
  secure: boolean
  onDispose: DisposeAction
  uploadWorkspace: boolean
  localCwd: string
  uploadExcludes: readonly string[]
  uploadMaxFiles: number
  uploadMaxBytes: number
  uploadMaxFileBytes: number
  symlinkPolicy: SymlinkPolicy
}

const DEFAULT_UPLOAD_EXCLUDES = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.dsh-agentenv',
]

function requireHttpUrl(value: string, name: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`dsh-agentenv-sandbox: ${name} must be an absolute HTTP URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-agentenv-sandbox: ${name} must use http or https`)
  }
  return value.replace(/\/$/, '')
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-agentenv-sandbox: ${name} must be a positive safe integer`)
  }
  return value
}

function requireNonBlank(value: string, name: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error(`dsh-agentenv-sandbox: ${name} must not be blank`)
  }
  return trimmed
}

/**
 * Resolve environment-backed defaults and reject unsafe or ambiguous values.
 * @param config - Parsed plugin configuration.
 * @param env - Host environment used only for connection and explicit defaults.
 * @param hostCwd - Harness process working directory.
 * @returns Immutable values consumed by the runtime owner.
 */
export function resolveConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  hostCwd: string = process.cwd(),
): ResolvedConfig {
  if (process.platform === 'win32') {
    throw new Error('dsh-agentenv-sandbox: run DeepSeek Harness inside WSL or Linux')
  }

  const apiUrl = requireHttpUrl(config.apiUrl ?? env.E2B_API_URL ?? 'http://127.0.0.1:8000', 'apiUrl')
  const sandboxUrl = requireHttpUrl(config.sandboxUrl ?? env.E2B_SANDBOX_URL ?? apiUrl, 'sandboxUrl')
  const apiKey = requireNonBlank(config.apiKey ?? env.E2B_API_KEY ?? env.AENV_API_KEY ?? '', 'apiKey')
  const template = requireNonBlank(config.template ?? env.AENV_TEMPLATE_ID ?? '', 'template')
  const cwd = config.cwd ?? hostCwd
  const localCwd = config.localCwd ?? hostCwd

  if (!posix.isAbsolute(cwd) || cwd.includes('\0')) {
    throw new Error(`dsh-agentenv-sandbox: cwd must be an absolute POSIX path: ${cwd}`)
  }
  if (!posix.isAbsolute(localCwd) || localCwd.includes('\0')) {
    throw new Error(`dsh-agentenv-sandbox: localCwd must be an absolute POSIX path: ${localCwd}`)
  }

  const sandboxId = config.sandboxId === undefined
    ? undefined
    : requireNonBlank(config.sandboxId, 'sandboxId')
  const uploadExcludes = config.uploadExcludes ?? DEFAULT_UPLOAD_EXCLUDES
  for (const entry of uploadExcludes) {
    if (entry.length === 0 || posix.isAbsolute(entry) || entry.split('/').includes('..')) {
      throw new Error(`dsh-agentenv-sandbox: invalid uploadExcludes entry: ${entry}`)
    }
  }

  return {
    apiUrl,
    sandboxUrl,
    apiKey,
    template,
    ...(sandboxId === undefined ? {} : { sandboxId }),
    cwd,
    timeoutMs: requirePositiveInteger(config.timeoutMs ?? 3_600_000, 'timeoutMs'),
    secure: config.secure ?? true,
    onDispose: config.onDispose ?? 'kill',
    uploadWorkspace: config.uploadWorkspace ?? true,
    localCwd,
    uploadExcludes: [...uploadExcludes],
    uploadMaxFiles: requirePositiveInteger(config.uploadMaxFiles ?? 50_000, 'uploadMaxFiles'),
    uploadMaxBytes: requirePositiveInteger(config.uploadMaxBytes ?? 536_870_912, 'uploadMaxBytes'),
    uploadMaxFileBytes: requirePositiveInteger(config.uploadMaxFileBytes ?? 67_108_864, 'uploadMaxFileBytes'),
    symlinkPolicy: config.symlinkPolicy ?? 'copy-internal',
  }
}
