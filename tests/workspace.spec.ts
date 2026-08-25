import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import type { Sandbox } from 'e2b'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { uploadWorkspace } from '../src/workspace.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(posix.join(tmpdir(), 'dsh-agentenv-upload-'))
  roots.push(root)
  return root
}

function mockSandbox(write: ReturnType<typeof vi.fn>): Sandbox {
  return {
    files: { write },
  } as unknown as Sandbox
}

describe('uploadWorkspace', () => {
  it('uploads regular files, preserves .git, and omits default dependency caches', async () => {
    const root = await fixtureRoot()
    await mkdir(posix.join(root, 'src'))
    await mkdir(posix.join(root, '.git'))
    await mkdir(posix.join(root, 'node_modules'))
    await writeFile(posix.join(root, 'src', 'index.ts'), 'export const ok = true\n')
    await writeFile(posix.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(posix.join(root, 'node_modules', 'ignored.js'), 'ignored')

    const write = vi.fn().mockResolvedValue(undefined)
    const config = resolveConfig({ template: 'ubuntu-dev', localCwd: root }, {
      E2B_API_KEY: 'test-key',
    }, '/remote/project')
    const summary = await uploadWorkspace(mockSandbox(write), config)

    expect(summary).toEqual({ files: 2, bytes: 44, copiedSymlinks: 0, skippedSymlinks: 0 })
    const uploaded = write.mock.calls.flatMap(call => call[0] as Array<{ path: string, data: ArrayBuffer }>)
    expect(uploaded.map(entry => entry.path).sort()).toEqual([
      '/remote/project/.git/HEAD',
      '/remote/project/src/index.ts',
    ])
    expect(uploaded.some(entry => entry.path.includes('node_modules'))).toBe(false)
  })

  it('fails before remote writes when aggregate size exceeds its bound', async () => {
    const root = await fixtureRoot()
    await writeFile(posix.join(root, 'large.txt'), '12345')
    const write = vi.fn().mockResolvedValue(undefined)
    const config = resolveConfig({
      template: 'ubuntu-dev',
      localCwd: root,
      uploadMaxBytes: 4,
    }, { E2B_API_KEY: 'test-key' }, '/remote/project')

    await expect(uploadWorkspace(mockSandbox(write), config)).rejects.toThrow('aggregate byte limit')
    expect(write).not.toHaveBeenCalled()
  })

  it('copies an internal regular-file symbolic link by default', async () => {
    const root = await fixtureRoot()
    await writeFile(posix.join(root, 'target.txt'), 'target')
    await symlink('target.txt', posix.join(root, 'link.txt'))
    const write = vi.fn().mockResolvedValue(undefined)
    const config = resolveConfig({ template: 'ubuntu-dev', localCwd: root }, {
      E2B_API_KEY: 'test-key',
    }, '/remote/project')

    await expect(uploadWorkspace(mockSandbox(write), config)).resolves.toEqual({
      files: 2,
      bytes: 12,
      copiedSymlinks: 1,
      skippedSymlinks: 0,
    })
    const uploaded = write.mock.calls.flatMap(call => call[0] as Array<{ path: string, data: ArrayBuffer }>)
    const copied = uploaded.find(entry => entry.path === '/remote/project/link.txt')
    expect(Buffer.from(copied!.data).toString()).toBe('target')
  })

  it('copies an internal directory symbolic link and its files', async () => {
    const root = await fixtureRoot()
    await mkdir(posix.join(root, 'skills'))
    await mkdir(posix.join(root, '.claude'))
    await writeFile(posix.join(root, 'skills', 'one.md'), 'skill')
    await symlink('../skills', posix.join(root, '.claude', 'skills'))
    const write = vi.fn().mockResolvedValue(undefined)
    const config = resolveConfig({ template: 'ubuntu-dev', localCwd: root }, {
      E2B_API_KEY: 'test-key',
    }, '/remote/project')

    await expect(uploadWorkspace(mockSandbox(write), config)).resolves.toEqual({
      files: 2,
      bytes: 10,
      copiedSymlinks: 1,
      skippedSymlinks: 0,
    })
    const uploaded = write.mock.calls.flatMap(call => call[0] as Array<{ path: string }>)
    expect(uploaded.map(entry => entry.path).sort()).toEqual([
      '/remote/project/.claude/skills/one.md',
      '/remote/project/skills/one.md',
    ])
  })

  it('rejects directory symlink cycles', async () => {
    const root = await fixtureRoot()
    await mkdir(posix.join(root, 'dir'))
    await symlink('..', posix.join(root, 'dir', 'loop'))
    const write = vi.fn().mockResolvedValue(undefined)
    const config = resolveConfig({ template: 'ubuntu-dev', localCwd: root }, {
      E2B_API_KEY: 'test-key',
    }, '/remote/project')

    await expect(uploadWorkspace(mockSandbox(write), config)).rejects.toThrow(
      'symbolic link creates directory cycle: dir/loop',
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('still supports fail-closed symbolic-link handling', async () => {
    const root = await fixtureRoot()
    await writeFile(posix.join(root, 'target.txt'), 'target')
    await symlink('target.txt', posix.join(root, 'link.txt'))
    const write = vi.fn().mockResolvedValue(undefined)
    const config = resolveConfig({
      template: 'ubuntu-dev',
      localCwd: root,
      symlinkPolicy: 'error',
    }, { E2B_API_KEY: 'test-key' }, '/remote/project')

    await expect(uploadWorkspace(mockSandbox(write), config)).rejects.toThrow('symbolic link: link.txt')
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects symbolic links that leave the workspace', async () => {
    const root = await fixtureRoot()
    const outside = await fixtureRoot()
    await writeFile(posix.join(outside, 'secret.txt'), 'secret')
    await symlink(posix.join(outside, 'secret.txt'), posix.join(root, 'link.txt'))
    const write = vi.fn().mockResolvedValue(undefined)
    const config = resolveConfig({ template: 'ubuntu-dev', localCwd: root }, {
      E2B_API_KEY: 'test-key',
    }, '/remote/project')

    await expect(uploadWorkspace(mockSandbox(write), config)).rejects.toThrow('symbolic link leaves workspace: link.txt')
    expect(write).not.toHaveBeenCalled()
  })

  it('reports intentionally skipped symbolic links', async () => {
    const root = await fixtureRoot()
    await writeFile(posix.join(root, 'target.txt'), 'target')
    await symlink('target.txt', posix.join(root, 'link.txt'))
    const write = vi.fn().mockResolvedValue(undefined)
    const config = resolveConfig({
      template: 'ubuntu-dev',
      localCwd: root,
      symlinkPolicy: 'skip',
    }, { E2B_API_KEY: 'test-key' }, '/remote/project')

    await expect(uploadWorkspace(mockSandbox(write), config)).resolves.toEqual({
      files: 1,
      bytes: 6,
      copiedSymlinks: 0,
      skippedSymlinks: 1,
    })
  })
})
