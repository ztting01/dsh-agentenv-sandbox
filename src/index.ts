/**
 * AgentENV sandbox lifecycle owner for DeepSeek Harness remote providers.
 * @module dsh-agentenv-sandbox
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileType, Sandbox, SandboxNotFoundError } from 'e2b'
import type { Config, ResolvedConfig } from './config.js'
import { resolveConfig } from './config.js'
import { withAgentEnvCompatibility } from './compat.js'
import { uploadWorkspace } from './workspace.js'

export type { Config, DisposeAction, ResolvedConfig, SymlinkPolicy } from './config.js'
export { resolveConfig } from './config.js'
export { withAgentEnvCompatibility } from './compat.js'
export type { UploadSummary } from './workspace.js'
export { uploadWorkspace } from './workspace.js'

function quoteShellArg(value: string): string {
  return `'${value.replaceAll('\'', "'\"'\"'")}'`
}

function controlEnvs(): Record<string, string> {
  return { HOME: `/.dsh-agentenv-control-${randomUUID()}` }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    e2b: AgentEnvRuntime
  }
}

/**
 * Owns one AgentENV sandbox shared by the official E2B filesystem and subprocess providers.
 */
export class AgentEnvRuntime extends Service {
  static Config: z<Config> = z.object({
    apiUrl: z.string(),
    sandboxUrl: z.string(),
    apiKey: z.string(),
    template: z.string(),
    sandboxId: z.string(),
    cwd: z.string(),
    timeoutMs: z.number(),
    secure: z.boolean(),
    onDispose: z.union(['kill', 'pause'] as const),
    uploadWorkspace: z.boolean(),
    localCwd: z.string(),
    // Schemastery arrays otherwise materialize missing values as [], which
    // would silently disable resolveConfig's dependency/cache exclusions.
    uploadExcludes: z.array(z.string()).default(undefined as unknown as string[]),
    uploadMaxFiles: z.number(),
    uploadMaxBytes: z.number(),
    uploadMaxFileBytes: z.number(),
    symlinkPolicy: z.union(['copy-internal', 'error', 'skip'] as const),
  })

  /** Remote directory used as the process and filesystem working directory. */
  readonly cwd: string
  /** Private remote directory reserved for official E2B provider state. */
  readonly runtimeRoot: string

  private readonly config: ResolvedConfig
  private readonly ready: Promise<Sandbox>
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'e2b')
    this.config = resolveConfig(config)
    this.cwd = this.config.cwd
    this.runtimeRoot = posix.join(this.cwd, '.dsh-e2b')
    this.ready = this.open()
    void this.ready.catch(() => {})

    ctx.effect(() => async () => {
      this.disposed = true
      let sandbox: Sandbox
      try {
        sandbox = await this.ready
      } catch (_sandboxSetupFailure) {
        return
      }
      await this.disposeSandbox(sandbox)
    }, 'AgentENV sandbox teardown')
  }

  /**
   * Return the single ready sandbox handle shared by all remote adapters.
   * @returns AgentENV sandbox after directory preparation and optional upload.
   */
  async getSandbox(): Promise<Sandbox> {
    if (this.disposed) throw new Error('dsh-agentenv-sandbox: runtime is disposing')
    const sandbox = await this.ready
    if (this.disposed) throw new Error('dsh-agentenv-sandbox: runtime is disposing')
    return sandbox
  }

  private connectionOptions(): {
    apiKey: string
    apiUrl: string
    sandboxUrl: string
  } {
    return {
      apiKey: this.config.apiKey,
      apiUrl: this.config.apiUrl,
      sandboxUrl: this.config.sandboxUrl,
    }
  }

  private async open(): Promise<Sandbox> {
    const rawSandbox = this.config.sandboxId === undefined
      ? await Sandbox.create(this.config.template, {
          ...this.connectionOptions(),
          timeoutMs: this.config.timeoutMs,
          secure: this.config.secure,
          metadata: {
            owner: 'deepseek-harness',
            plugin: 'dsh-agentenv-sandbox',
          },
        })
      : await Sandbox.connect(this.config.sandboxId, {
          ...this.connectionOptions(),
          timeoutMs: this.config.timeoutMs,
        })
    const sandbox = withAgentEnvCompatibility(rawSandbox)

    try {
      await sandbox.files.makeDir(this.cwd)
      await sandbox.files.makeDir(this.runtimeRoot)
      const runtimeRoot = await sandbox.files.getInfo(this.runtimeRoot)
      if (runtimeRoot.type !== FileType.DIR || runtimeRoot.symlinkTarget !== undefined) {
        throw new Error(`dsh-agentenv-sandbox: runtime root must be a real directory: ${this.runtimeRoot}`)
      }
      await sandbox.commands.run(
        `chmod 700 -- ${quoteShellArg(this.runtimeRoot)}`,
        { envs: controlEnvs() },
      )
      if (this.config.uploadWorkspace) {
        const summary = await uploadWorkspace(sandbox, this.config)
        await sandbox.files.write(
          posix.join(this.runtimeRoot, 'workspace-upload.json'),
          `${JSON.stringify({ schemaVersion: 1, ...summary })}\n`,
        )
      }
      return sandbox
    } catch (error: unknown) {
      try {
        await sandbox.kill()
      } catch (_sandboxSetupRollbackFailure) {
        // AgentENV timeout remains the final cleanup bound after rollback failure.
      }
      throw error
    }
  }

  private async disposeSandbox(sandbox: Sandbox): Promise<void> {
    try {
      if (this.config.onDispose === 'pause') {
        await Sandbox.pause(sandbox.sandboxId, this.connectionOptions())
      } else {
        await sandbox.kill()
      }
    } catch (error: unknown) {
      if (!(error instanceof SandboxNotFoundError)) throw error
    }
  }
}

export default AgentEnvRuntime
