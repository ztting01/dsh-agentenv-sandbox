# dsh-agentenv-sandbox

AgentENV execution-world bundle for DeepSeek Harness. It replaces the local filesystem and subprocess providers with the official Harness E2B adapters, backed by one AgentENV Firecracker microVM. Bash commands, file tools, persistent terminals, and provider-neutral LSP processes then share the same remote Linux world.

## Status

This is an MVP for DeepSeek Harness `0.1.0-rc.7`, the matching published E2B provider family `0.1.0-rc.7`, E2B SDK `2.29.1`, and AgentENV `0.1.0`. Its bundle composition has also been checked with a Harness `0.1.0-rc.8` source checkout. Run Harness inside WSL 2 or Linux. Native Windows execution is rejected because one Harness session cwd must be a valid path in both the host process and remote Linux world.

The bundle fails closed: it disables the local filesystem, local subprocess, and local shell-sandbox providers. AgentENV creation, setup, or workspace upload failure prevents the remote providers from loading; it never falls back to host execution.

## What stays on the host

The Harness process, model calls, Cordis services, session persistence, skills, UI, and SDK buffers remain on the host. The official Bash, file, PTY, and LSP consumers run their operating-system work through `ctx.fs` and `ctx.subprocess` inside AgentENV. A third-party plugin that directly imports Node.js `fs` or `child_process` can bypass these provider seams and is outside this guarantee.

## Prerequisites

- WSL 2 or Linux with Node.js 22.19+ or 24+
- DeepSeek Harness `0.1.0-rc.7`
- A running AgentENV server
- An AgentENV template containing Bash and the GNU utilities required by the official Harness E2B adapters

The included template provides Node.js 24, Bash, Git, ripgrep, Python, build tools, and the process utilities required by the official adapter:

```bash
aenv build ./sandbox/Dockerfile --tag dsh-agentenv-node24 --cpu 2 --memory 4096
```

Set the connection values in the shell that starts Harness:

```bash
export E2B_API_URL=http://127.0.0.1:8000
export E2B_SANDBOX_URL="$E2B_API_URL"
export E2B_API_KEY="$AENV_API_KEY"
export AENV_TEMPLATE_ID='<template-id-or-alias>'
```

## Install

Build once, then add the local bundle to a Harness profile:

```bash
npm install
npm run check
dsh plugin --profile web add /absolute/path/to/dsh-agentenv-sandbox
dsh --profile web --dump-config
```

Start Harness from the project directory you want uploaded:

```bash
cd /absolute/path/to/project
dsh --profile web
```

The default configuration uploads the project, including `.git`, to the same absolute POSIX path inside a fresh microVM. It excludes `node_modules`, Python virtual environments, caches, and `.dsh-agentenv`. Symbolic links abort startup by default so the remote workspace cannot silently differ from the host. Set `symlinkPolicy: skip` in a later profile patch only when omission is intentional.

## Configuration

Override the `agentenv-runtime` row in the profile's `cordis.patch.yml`. A later patch replaces the complete config, so restate every value you need.

| Key | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `E2B_API_URL` or `http://127.0.0.1:8000` | AgentENV control plane |
| `sandboxUrl` | `E2B_SANDBOX_URL` or `apiUrl` | AgentENV data plane |
| `apiKey` | `E2B_API_KEY`, then `AENV_API_KEY` | Host-only API credential |
| `template` | `AENV_TEMPLATE_ID` | Required template id or alias |
| `sandboxId` | omitted | Reconnect instead of create |
| `cwd` | Harness `process.cwd()` | Shared absolute remote cwd |
| `timeoutMs` | `3600000` | Requested sandbox lifetime |
| `secure` | `true` | Secure envd control traffic |
| `onDispose` | `kill` | `kill` or AgentENV `pause` |
| `uploadWorkspace` | `true` | Initial bounded host-to-sandbox upload |
| `uploadMaxFiles` | `50000` | Upload file-count bound |
| `uploadMaxBytes` | `512 MiB` | Aggregate upload bound |
| `uploadMaxFileBytes` | `64 MiB` | Per-file upload bound |
| `symlinkPolicy` | `error` | Abort or skip symbolic links |

To preserve a sandbox across Harness restarts, set `onDispose: pause`, then start with the recorded `sandboxId`. Automatic discovery and host write-back are intentionally not part of this MVP.

## Security model

Harness reports `danger-full-access` because its current confined modes resolve host paths and do not enforce remote filesystem paths. The access is full only inside the AgentENV microVM; the host workspace is not mounted. The API key stays in the host SDK connection and is not inserted into sandbox command environments by this plugin.

The initial upload is an explicit control-plane exception: the plugin reads the selected host workspace once and sends bounded regular-file content to AgentENV. After setup, model-facing file and process operations use the remote providers. There is no automatic write-back to the host.

## Live smoke test

After building the package and template, verify the runtime owner plus the official FS, command, and PTY providers without a model API key:

```bash
export AENV_TEMPLATE_ID=dsh-agentenv-node24
npm run smoke:agentenv
```

The script reads the existing `aenv auth` credential file inside the process, never prints its API key, creates a short-lived sandbox, verifies bidirectional visibility between `ctx.fs` and `ctx.subprocess`, verifies PTY output, proves there is no host write-back, and deletes the sandbox during teardown.

## Known limitations

- No automatic sandbox discovery, reconnect retry, snapshot UI, or incremental synchronization.
- No automatic download or merge of remote changes into the host workspace.
- Symbolic links cannot be reproduced by the E2B filesystem API used by this MVP.
- Harness `tool-fs-search` may still resolve its packaged host `rg` path in the current release. Use Bash with an `rg` binary installed in the AgentENV template until upstream makes search executable resolution provider-aware.
- In-process workflow/code runtimes and third-party plugins that bypass `ctx.fs` or `ctx.subprocess` remain host-side.
- The official E2B subprocess adapter retains SDK command transport buffers on the host and inherits its published PTY/process limitations.
- AgentENV 0.1.0 ships envd 0.5.15, while the official FS provider requests file metadata introduced in envd 0.6.2. The plugin retries only that explicitly unsupported metadata write without metadata. Ordinary metadata fingerprints still detect external changes, but identical-size writes inside an extremely coarse timestamp window have weaker stale-version detection until AgentENV upgrades envd.
