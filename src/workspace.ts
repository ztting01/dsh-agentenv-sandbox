import { lstat, opendir, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Sandbox } from 'e2b'
import type { ResolvedConfig } from './config.js'

/** Summary of one bounded initial workspace upload. */
export interface UploadSummary {
  files: number
  bytes: number
  skippedSymlinks: number
}

interface UploadEntry {
  localPath: string
  remotePath: string
  size: number
}

function isExcluded(relativePath: string, excludes: readonly string[]): boolean {
  const components = relativePath.split('/')
  return excludes.some((entry) => {
    const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '')
    if (normalized.includes('/')) {
      return relativePath === normalized || relativePath.startsWith(`${normalized}/`)
    }
    return components.includes(normalized)
  })
}

async function collectEntries(config: ResolvedConfig): Promise<{
  entries: UploadEntry[]
  bytes: number
  skippedSymlinks: number
}> {
  const entries: UploadEntry[] = []
  let bytes = 0
  let skippedSymlinks = 0

  async function visit(localDirectory: string, relativeDirectory: string): Promise<void> {
    const directory = await opendir(localDirectory)
    for await (const dirent of directory) {
      const relativePath = relativeDirectory.length === 0
        ? dirent.name
        : posix.join(relativeDirectory, dirent.name)
      if (isExcluded(relativePath, config.uploadExcludes)) continue

      const localPath = posix.join(localDirectory, dirent.name)
      if (dirent.isSymbolicLink()) {
        if (config.symlinkPolicy === 'error') {
          throw new Error(`dsh-agentenv-sandbox: workspace contains symbolic link: ${relativePath}`)
        }
        skippedSymlinks += 1
        continue
      }
      if (dirent.isDirectory()) {
        await visit(localPath, relativePath)
        continue
      }
      if (!dirent.isFile()) continue

      const info = await lstat(localPath)
      if (!info.isFile()) continue
      const size = info.size
      if (size > config.uploadMaxFileBytes) {
        throw new Error(`dsh-agentenv-sandbox: upload file exceeds limit: ${relativePath}`)
      }
      bytes += size
      if (bytes > config.uploadMaxBytes) {
        throw new Error('dsh-agentenv-sandbox: workspace upload exceeds aggregate byte limit')
      }
      entries.push({
        localPath,
        remotePath: posix.join(config.cwd, relativePath),
        size,
      })
      if (entries.length > config.uploadMaxFiles) {
        throw new Error('dsh-agentenv-sandbox: workspace upload exceeds file-count limit')
      }
    }
  }

  await visit(config.localCwd, '')
  return { entries, bytes, skippedSymlinks }
}

/**
 * Upload a bounded host workspace through the E2B filesystem API.
 * @param sandbox - Newly created or explicitly reconnected AgentENV sandbox.
 * @param config - Resolved workspace roots and safety bounds.
 * @returns Counts for diagnostics and integration assertions.
 */
export async function uploadWorkspace(
  sandbox: Sandbox,
  config: ResolvedConfig,
): Promise<UploadSummary> {
  const collected = await collectEntries(config)
  const batchSize = 32

  for (let offset = 0; offset < collected.entries.length; offset += batchSize) {
    const batch = collected.entries.slice(offset, offset + batchSize)
    const files = await Promise.all(batch.map(async entry => {
      const content = await readFile(entry.localPath)
      if (content.byteLength !== entry.size) {
        throw new Error(`dsh-agentenv-sandbox: workspace file changed during upload: ${entry.localPath}`)
      }
      return {
        path: entry.remotePath,
        data: Uint8Array.from(content).buffer,
      }
    }))
    await sandbox.files.write(files)
  }

  return {
    files: collected.entries.length,
    bytes: collected.bytes,
    skippedSymlinks: collected.skippedSymlinks,
  }
}
