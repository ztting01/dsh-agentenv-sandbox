import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import E2BFileSystem from '@deepseek-ai/dsh-fs-e2b'
import E2BSubprocessRuntime from '@deepseek-ai/dsh-subprocess-e2b'
import AgentEnvRuntime from '../lib/index.js'

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function tomlString(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'm'))
  if (match?.[1] === undefined) throw new Error(`AgentENV credentials omit ${key}`)
  return JSON.parse(match[1])
}

async function loadCredentials() {
  const text = await readFile(posix.join(homedir(), '.config/aenv/credentials'), 'utf8')
  return {
    apiUrl: tomlString(text, 'url').replace(/\/$/, ''),
    apiKey: tomlString(text, 'api_key'),
  }
}

async function expectMissing(path) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`remote file unexpectedly appeared on host: ${path}`)
}

async function main() {
  const template = process.env.AENV_TEMPLATE_ID?.trim()
  if (!template) throw new Error('set AENV_TEMPLATE_ID before running the AgentENV smoke test')
  const credentials = await loadCredentials()
  const localRoot = await mkdtemp(posix.join(tmpdir(), 'dsh-agentenv-smoke-'))
  const remoteRoot = `/tmp/dsh-agentenv-smoke-${Date.now()}`
  await writeFile(posix.join(localRoot, 'host-seed.txt'), 'seeded-from-host\n')

  const ctx = new Context()
  let runtimeFiber
  let fsFiber
  let subprocessFiber
  let sandboxId
  try {
    runtimeFiber = await ctx.plugin(AgentEnvRuntime, {
      apiUrl: credentials.apiUrl,
      sandboxUrl: credentials.apiUrl,
      apiKey: credentials.apiKey,
      template,
      cwd: remoteRoot,
      localCwd: localRoot,
      timeoutMs: 180_000,
      secure: true,
      onDispose: 'kill',
      uploadWorkspace: true,
    })
    const sandbox = await ctx.e2b.getSandbox()
    sandboxId = sandbox.sandboxId
    fsFiber = await ctx.plugin(E2BFileSystem)
    subprocessFiber = await ctx.plugin(E2BSubprocessRuntime, { pollMs: 50 })

    const seed = await ctx.fs.resolve('host-seed.txt', { cwd: remoteRoot })
    check(await ctx.fs.readText(seed) === 'seeded-from-host\n', 'remote filesystem did not receive host seed')

    const remoteOnly = await ctx.fs.resolve('remote-only.txt', { cwd: remoteRoot })
    await ctx.fs.writeText(remoteOnly, 'written-through-ctx.fs\n')

    const command = ctx.subprocess.spawn({
      argv: ['/bin/bash', '-c', 'cat remote-only.txt; printf command-ok > from-command.txt'],
      cwd: remoteRoot,
      env: {},
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 1_000,
    })
    const commandOutcome = await command.done
    check(commandOutcome.exitCode === 0, `remote command exited ${commandOutcome.exitCode}`)
    check(command.collected.stdout?.readFrom(0).text === 'written-through-ctx.fs\n', 'remote command did not see ctx.fs write')
    const commandFile = await ctx.fs.resolve('from-command.txt', { cwd: remoteRoot })
    check(await ctx.fs.readText(commandFile) === 'command-ok', 'ctx.fs did not see remote command write')

    const terminal = await ctx.subprocess.spawnTerminal({
      argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
      cwd: remoteRoot,
      env: { TERM: 'dumb' },
      rows: 24,
      cols: 80,
      graceMs: 1_000,
    })
    let terminalOutput = ''
    terminal.output.on('data', chunk => {
      terminalOutput += chunk.toString('utf8')
    })
    await terminal.write("printf 'terminal-ok\\n'; exit\n")
    const terminalOutcome = await Promise.race([
      terminal.done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('terminal smoke timed out')), 20_000)),
    ])
    check(terminalOutcome.exitCode === 0, `remote terminal exited ${terminalOutcome.exitCode}`)
    check(terminalOutput.includes('terminal-ok'), 'remote terminal output marker missing')
    await terminal.terminate()

    await expectMissing(posix.join(localRoot, 'remote-only.txt'))
    process.stdout.write(`${JSON.stringify({
      sandboxId,
      workspaceUpload: true,
      filesystem: true,
      command: true,
      terminal: true,
      hostWriteBack: false,
    })}\n`)
  } finally {
    await subprocessFiber?.dispose()
    await fsFiber?.dispose()
    await runtimeFiber?.dispose()
    await rm(localRoot, { recursive: true, force: true })
  }
}

await main()
