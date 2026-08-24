import { describe, expect, it, vi } from 'vitest'
import type { Sandbox } from 'e2b'
import { withAgentEnvCompatibility } from '../src/compat.js'

function sandboxWithWrite(write: ReturnType<typeof vi.fn>): Sandbox {
  return {
    sandboxId: 'sandbox-1',
    files: { write },
  } as unknown as Sandbox
}

describe('withAgentEnvCompatibility', () => {
  it('retries an envd metadata rejection without metadata', async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error('File metadata requires envd 0.6.2 or later.'))
      .mockResolvedValueOnce(undefined)
    const sandbox = withAgentEnvCompatibility(sandboxWithWrite(write))

    await sandbox.files.write('/workspace/file.txt', 'content', {
      metadata: { timestamp: '123' },
      user: 'root',
    })

    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(1, '/workspace/file.txt', 'content', {
      metadata: { timestamp: '123' },
      user: 'root',
    })
    expect(write).toHaveBeenNthCalledWith(2, '/workspace/file.txt', 'content', {
      user: 'root',
    })
  })

  it('does not hide unrelated write failures', async () => {
    const failure = new Error('permission denied')
    const write = vi.fn().mockRejectedValue(failure)
    const sandbox = withAgentEnvCompatibility(sandboxWithWrite(write))

    await expect(sandbox.files.write('/workspace/file.txt', 'content', {
      metadata: { timestamp: '123' },
    })).rejects.toBe(failure)
    expect(write).toHaveBeenCalledOnce()
  })

  it('does not retry the metadata error when no metadata was requested', async () => {
    const failure = new Error('File metadata requires envd 0.6.2 or later.')
    const write = vi.fn().mockRejectedValue(failure)
    const sandbox = withAgentEnvCompatibility(sandboxWithWrite(write))

    await expect(sandbox.files.write('/workspace/file.txt', 'content'))
      .rejects.toBe(failure)
    expect(write).toHaveBeenCalledOnce()
  })
})
