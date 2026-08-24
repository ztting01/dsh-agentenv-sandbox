import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Sandbox as SandboxType } from 'e2b'
import { FileType } from 'e2b'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  pause: vi.fn(),
}))

vi.mock('e2b', async (importOriginal) => {
  const actual = await importOriginal<typeof import('e2b')>()
  class FakeSandbox {
    static create(...args: unknown[]): unknown {
      return sdk.create(...args)
    }

    static connect(...args: unknown[]): unknown {
      return sdk.connect(...args)
    }

    static pause(...args: unknown[]): unknown {
      return sdk.pause(...args)
    }
  }
  return { ...actual, Sandbox: FakeSandbox }
})

import AgentEnvRuntime from '../src/index.js'

function fakeSandbox(id = 'sandbox-1'): {
  sandbox: SandboxType
  makeDir: ReturnType<typeof vi.fn>
  getInfo: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
} {
  const makeDir = vi.fn().mockResolvedValue(true)
  const getInfo = vi.fn().mockResolvedValue({ type: FileType.DIR })
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  const kill = vi.fn().mockResolvedValue(undefined)
  const sandbox = {
    sandboxId: id,
    files: { makeDir, getInfo },
    commands: { run },
    kill,
  } as unknown as SandboxType
  return { sandbox, makeDir, getInfo, run, kill }
}

beforeEach(() => {
  sdk.create.mockReset()
  sdk.connect.mockReset()
  sdk.pause.mockReset()
})

describe('AgentEnvRuntime', () => {
  it('creates one template-backed sandbox and kills it after provider disposal', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(AgentEnvRuntime, {
      apiUrl: 'http://127.0.0.1:8000',
      sandboxUrl: 'http://127.0.0.1:8000',
      apiKey: 'test-key',
      template: 'ubuntu-dev',
      cwd: '/workspace/project',
      localCwd: '/workspace/project',
      timeoutMs: 60_000,
      uploadWorkspace: false,
    })

    const service = ctx.e2b
    const sandbox = await service.getSandbox()
    expect(sandbox.sandboxId).toBe(fixture.sandbox.sandboxId)
    await expect(sandbox.files.getInfo('/workspace/project')).resolves.toEqual({
      type: FileType.DIR,
    })
    expect(sdk.create).toHaveBeenCalledWith('ubuntu-dev', {
      apiUrl: 'http://127.0.0.1:8000',
      sandboxUrl: 'http://127.0.0.1:8000',
      apiKey: 'test-key',
      timeoutMs: 60_000,
      secure: true,
      metadata: {
        owner: 'deepseek-harness',
        plugin: 'dsh-agentenv-sandbox',
      },
    })
    expect(fixture.makeDir).toHaveBeenNthCalledWith(1, '/workspace/project')
    expect(fixture.makeDir).toHaveBeenNthCalledWith(2, '/workspace/project/.dsh-e2b')
    expect(ctx.e2b.runtimeRoot).toBe('/workspace/project/.dsh-e2b')

    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
    await expect(service.getSandbox()).rejects.toThrow('disposing')
  })

  it('reconnects an existing sandbox and pauses it on disposal', async () => {
    const fixture = fakeSandbox('existing')
    sdk.connect.mockResolvedValue(fixture.sandbox)
    sdk.pause.mockResolvedValue(undefined)
    const ctx = new Context()
    const fiber = await ctx.plugin(AgentEnvRuntime, {
      apiKey: 'test-key',
      apiUrl: 'http://127.0.0.1:8000',
      sandboxUrl: 'http://127.0.0.1:8000',
      template: 'ubuntu-dev',
      sandboxId: 'existing',
      cwd: '/workspace',
      localCwd: '/workspace',
      timeoutMs: 90_000,
      uploadWorkspace: false,
      onDispose: 'pause',
    })
    await ctx.e2b.getSandbox()

    expect(sdk.connect).toHaveBeenCalledWith('existing', {
      apiKey: 'test-key',
      apiUrl: 'http://127.0.0.1:8000',
      sandboxUrl: 'http://127.0.0.1:8000',
      timeoutMs: 90_000,
    })
    expect(sdk.create).not.toHaveBeenCalled()

    await fiber.dispose()
    expect(sdk.pause).toHaveBeenCalledWith('existing', {
      apiKey: 'test-key',
      apiUrl: 'http://127.0.0.1:8000',
      sandboxUrl: 'http://127.0.0.1:8000',
    })
    expect(fixture.kill).not.toHaveBeenCalled()
  })

  it('kills the sandbox and withholds the service handle when setup fails', async () => {
    const fixture = fakeSandbox()
    fixture.run.mockRejectedValueOnce(new Error('chmod failed'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(AgentEnvRuntime, {
      apiKey: 'test-key',
      template: 'ubuntu-dev',
      cwd: '/workspace',
      localCwd: '/workspace',
      uploadWorkspace: false,
    })

    await expect(ctx.e2b.getSandbox()).rejects.toThrow('chmod failed')
    expect(fixture.kill).toHaveBeenCalledOnce()
    await fiber.dispose()
  })
})
