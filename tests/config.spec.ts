import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('resolves AgentENV environment values and safe defaults', () => {
    const resolved = resolveConfig({}, {
      E2B_API_URL: 'http://127.0.0.1:8000/',
      E2B_SANDBOX_URL: 'http://127.0.0.1:8000/proxy/',
      E2B_API_KEY: 'test-key',
      AENV_TEMPLATE_ID: 'ubuntu-dev',
    }, '/workspace/project')

    expect(resolved).toMatchObject({
      apiUrl: 'http://127.0.0.1:8000',
      sandboxUrl: 'http://127.0.0.1:8000/proxy',
      apiKey: 'test-key',
      template: 'ubuntu-dev',
      cwd: '/workspace/project',
      localCwd: '/workspace/project',
      timeoutMs: 3_600_000,
      secure: true,
      onDispose: 'kill',
      uploadWorkspace: true,
      symlinkPolicy: 'error',
    })
    expect(resolved.uploadExcludes).toContain('node_modules')
    expect(resolved.uploadExcludes).not.toContain('.git')
  })

  it('rejects a missing template before opening a sandbox', () => {
    expect(() => resolveConfig({}, {
      E2B_API_KEY: 'test-key',
    }, '/workspace')).toThrow('template must not be blank')
  })

  it('rejects a relative execution-world cwd', () => {
    expect(() => resolveConfig({ cwd: 'relative' }, {
      E2B_API_KEY: 'test-key',
      AENV_TEMPLATE_ID: 'ubuntu-dev',
    }, '/workspace')).toThrow('cwd must be an absolute POSIX path')
  })

  it('rejects parent traversal in upload exclusions', () => {
    expect(() => resolveConfig({ uploadExcludes: ['../secret'] }, {
      E2B_API_KEY: 'test-key',
      AENV_TEMPLATE_ID: 'ubuntu-dev',
    }, '/workspace')).toThrow('invalid uploadExcludes entry')
  })

  it('does not expose the API key through connection-independent defaults', () => {
    const resolved = resolveConfig({
      apiKey: 'explicit-key',
      template: 'ubuntu-dev',
      uploadWorkspace: false,
    }, {}, '/workspace')

    expect(resolved.apiKey).toBe('explicit-key')
    expect(resolved.uploadWorkspace).toBe(false)
    expect(JSON.stringify({ ...resolved, apiKey: undefined })).not.toContain('explicit-key')
  })
})
