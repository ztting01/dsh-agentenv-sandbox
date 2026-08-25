# dsh-agentenv-sandbox

AgentENV execution-world bundle for DeepSeek Harness. It replaces the local filesystem and subprocess providers with the official Harness E2B adapters, backed by one AgentENV Firecracker microVM. Bash commands, file tools, persistent terminals, and provider-neutral LSP processes then share the same remote Linux world.

## Status

This is an MVP for DeepSeek Harness `0.1.0-rc.7`, the matching published E2B provider family `0.1.0-rc.7`, E2B SDK `2.29.1`, and AgentENV `0.1.0`. Its bundle composition has also been checked with a Harness `0.1.0-rc.8` source checkout. Run Harness inside WSL 2 or Linux. Native Windows execution is rejected because one Harness session cwd must be a valid path in both the host process and remote Linux world.

The bundle fails closed: it disables the local filesystem, local subprocess, and local shell-sandbox providers. AgentENV creation, setup, or workspace upload failure prevents the remote providers from loading; it never falls back to host execution.

## What stays on the host

The Harness process, model calls, Cordis services, session persistence, skills, UI, and SDK buffers remain on the host. The official Bash, file, PTY, and LSP consumers run their operating-system work through `ctx.fs` and `ctx.subprocess` inside AgentENV. A third-party plugin that directly imports Node.js `fs` or `child_process` can bypass these provider seams and is outside this guarantee.

## Prerequisites

- WSL 2 or Linux with Node.js 22.19+ or 24+. Native Windows execution is not supported.
- DeepSeek Harness `0.1.0-rc.7`, either installed as the `dsh` command or available as a source checkout.
- AgentENV installed, authenticated, and running. This plugin does not install or start AgentENV.
- An AgentENV template built before the first Harness launch. This plugin creates sandboxes from an existing template; it does not build the template automatically.

In short, deploy AgentENV and DeepSeek Harness first, then build the template once, install this plugin into a Harness profile, and start Harness from the project directory.

These are separate products and are not bundled with this plugin. Install them from their official documentation before continuing:

- [AgentENV v0.1.0 source and deployment documentation](https://github.com/kvcache-ai/AgentENV/tree/v0.1.0)
- [DeepSeek Harness official quick start and source installation](https://deepseek.com/harness/en/)

## First-time setup

### 1. Verify AgentENV and DeepSeek Harness

Confirm that the AgentENV CLI is available and that its server is running:

```bash
command -v aenv
curl -f http://127.0.0.1:8000/health
```

Confirm either that the installed Harness CLI is available:

```bash
command -v dsh
dsh --version
```

or identify the Node.js binary and Harness source entry point you will use:

```bash
/path/to/node /path/to/deepseek-harness/apps/cli/lib/bin.js --version
```

AgentENV authentication and server deployment are prerequisites supplied by AgentENV itself. Follow the AgentENV installation instructions for your platform before continuing. The plugin only connects to the resulting AgentENV API.

### 2. Build the AgentENV template once

The template is the reusable base image from which AgentENV creates a fresh sandbox. It is not a running sandbox. This repository includes [`sandbox/Dockerfile`](./sandbox/Dockerfile), which installs Node.js 24, Bash, Git, ripgrep, Python, build tools, and the process utilities required by the official Harness E2B adapters.

Run the following from the root of this repository after AgentENV is installed, authenticated, and running:

```bash
aenv build ./sandbox/Dockerfile \
  --tag dsh-agentenv-node24 \
  --cpu 2 \
  --memory 4096
```

This command uses the AgentENV `0.1.0` CLI syntax tested by this plugin. Check the documentation matching your AgentENV release before substituting a newer server or CLI, because template build flags can change between releases.

The command registers `dsh-agentenv-node24` as the template alias in AgentENV. You normally run it only once. Rebuild the template when you change the Dockerfile, upgrade its tools, or deploy a new AgentENV server that does not already contain this template.

If you installed only the release tarball and do not have a source checkout, extract it to access the included Dockerfile:

```bash
mkdir dsh-agentenv-template
tar -xzf dsh-agentenv-sandbox-0.1.4.tgz -C dsh-agentenv-template
cd dsh-agentenv-template/package
aenv build ./sandbox/Dockerfile --tag dsh-agentenv-node24 --cpu 2 --memory 4096
```

### 3. Configure the AgentENV connection

Set these values in every shell that starts Harness, or add them to the shell startup/configuration used to launch Harness:

```bash
export AENV_API_KEY='<agentenv-api-key>'
export E2B_API_URL=http://127.0.0.1:8000
export E2B_SANDBOX_URL="$E2B_API_URL"
export E2B_API_KEY="$AENV_API_KEY"
export AENV_TEMPLATE_ID=dsh-agentenv-node24
```

| Variable | Value | Meaning |
| --- | --- | --- |
| `AENV_API_KEY` | The secret API key generated by the AgentENV server | Host-side AgentENV credential. Keep it secret and do not commit it. |
| `E2B_API_URL` | AgentENV control-plane URL, for example `http://127.0.0.1:8000` | The E2B-compatible API endpoint used to create, connect, renew, pause, and delete sandboxes. |
| `E2B_SANDBOX_URL` | AgentENV sandbox data-plane URL; it is normally the same as `E2B_API_URL` for a local deployment | The endpoint used for sandbox command, filesystem, and terminal traffic. |
| `E2B_API_KEY` | The same secret value as `AENV_API_KEY` | The credential name expected by the E2B SDK used inside this plugin. |
| `AENV_TEMPLATE_ID` | An existing AgentENV template ID or alias, such as `dsh-agentenv-node24` | Selects the template from which the plugin creates the Harness sandbox. |

Use the API key generated by your AgentENV deployment. Running `aenv auth` configures the CLI, but the shell that starts Harness must also provide the key through `AENV_API_KEY` or `E2B_API_KEY`; the plugin does not read the CLI credential file. For a remote AgentENV deployment, replace the localhost URLs and template alias with the values supplied by that deployment. The `aenv` CLI is useful for setup and administration, but the plugin runtime talks to the AgentENV API through the E2B SDK and does not invoke `aenv` for each command.

## Install

### 4. Install the plugin into a Harness profile

Download the release tarball and add it to a Harness profile:

```bash
curl -LO https://github.com/ztting01/dsh-agentenv-sandbox/releases/download/v0.1.4/dsh-agentenv-sandbox-0.1.4.tgz
dsh plugin --profile web add "$PWD/dsh-agentenv-sandbox-0.1.4.tgz"
dsh --profile web --dump-config
```

If you run Harness from a source checkout instead of an installed `dsh` command, replace `dsh` with:

```bash
/path/to/node /path/to/deepseek-harness/apps/cli/lib/bin.js
```

For plugin development, build once and install the local directory instead:

```bash
npm install
npm run check
dsh plugin --profile web add /absolute/path/to/dsh-agentenv-sandbox
dsh --profile web --dump-config
```

### 5. Start Harness from the project directory

Start Harness from the project directory you want uploaded:

```bash
cd /absolute/path/to/project
dsh --profile web
```

#### Required workspace-path invariant

The workspace selected for the conversation in the Web client **must have exactly the same absolute path** as the directory from which the DSH process was started:

```text
DSH process.cwd()
  = Web client conversation workspace path
  = AgentENV sandbox cwd
```

The workspace display name is irrelevant; the absolute path is what must match. For example, after starting DSH with:

```bash
cd /home/user/project-a
dsh --profile web
```

select `/home/user/project-a` as the conversation workspace in the Web client and then create or open a conversation belonging to that workspace. Do not select `/home/user/project-b`, even if both workspaces are visible in the sidebar. Restarting DSH does not delete saved conversations or change the workspace recorded by an existing conversation.

This MVP owns one sandbox and one fixed cwd per DSH process. Switching the Web client to a different workspace does not recreate the sandbox or upload the newly selected directory. A mismatch commonly fails with an error such as:

```text
Error: [invalid_argument] cwd '/different/workspace' does not exist
```

To use several workspaces concurrently, start one DSH process per workspace on a different Web port, and use the matching workspace in each client page:

```bash
cd /home/user/project-a
dsh --profile web --port 3080 --no-open

cd /home/user/project-b
dsh --profile web --port 3081 --no-open
```

The default configuration uploads the project, including `.git`, to the same absolute POSIX path inside a fresh microVM. It excludes `node_modules`, Python virtual environments, caches, and `.dsh-agentenv`. Symbolic links to files or directories inside the workspace are uploaded as regular copies. Links that are dangling, point outside the workspace, create directory cycles, resolve to unsupported file types, or target excluded paths abort startup. Set `symlinkPolicy: error` for strict rejection or `skip` only when omission is intentional.

After a successful initial upload, the plugin writes a non-secret completion summary to `.dsh-e2b/workspace-upload.json` inside the microVM. Its presence means the bounded scan and every upload batch completed; it is also useful for startup diagnostics.

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
| `timeoutMs` | `3600000` | Rolling sandbox lease, renewed while Harness runs |
| `secure` | `true` | Secure envd control traffic |
| `onDispose` | `kill` | `kill` or AgentENV `pause` |
| `uploadWorkspace` | `true` | Initial bounded host-to-sandbox upload |
| `uploadMaxFiles` | `50000` | Upload file-count bound |
| `uploadMaxBytes` | `512 MiB` | Aggregate upload bound |
| `uploadMaxFileBytes` | `256 MiB` | Per-file upload bound |
| `symlinkPolicy` | `copy-internal` | Copy safe internal file/directory links, or use `error`/`skip` |

To preserve a sandbox across Harness restarts, set `onDispose: pause`, then start with the recorded `sandboxId`. Automatic discovery and host write-back are intentionally not part of this MVP.

## Security model

Harness reports `danger-full-access` because its current confined modes resolve host paths and do not enforce remote filesystem paths. The access is full only inside the AgentENV microVM; the host workspace is not mounted. The bundle disables `permission-presets` because that service requires a host-confined Bash executor with a mutable `sandboxMode`; AgentENV is instead a fixed isolation boundary. The approval policy remains `never`, and the Web permission selector is intentionally unavailable. The API key stays in the host SDK connection and is not inserted into sandbox command environments by this plugin.

The initial upload is an explicit control-plane exception: the plugin reads the selected host workspace once and sends bounded regular-file content to AgentENV. After setup, model-facing file and process operations use the remote providers. There is no automatic write-back to the host.

## Live smoke test

After building the package and template, verify the runtime owner plus the official FS, command, and PTY providers without a model API key:

```bash
export AENV_TEMPLATE_ID=dsh-agentenv-node24
npm run smoke:agentenv
```

The script reads the existing `aenv auth` credential file inside the process, never prints its API key, creates a short-lived sandbox, verifies bidirectional visibility between `ctx.fs` and `ctx.subprocess`, verifies PTY output, proves there is no host write-back, and deletes the sandbox during teardown.

## Known limitations

- One DSH process owns one AgentENV sandbox with one fixed cwd. Web-client workspace switching is unsupported unless the selected workspace path is identical to the directory from which DSH was started.
- No automatic sandbox discovery, reconnect retry, snapshot UI, or incremental synchronization.
- No automatic download or merge of remote changes into the host workspace.
- Symbolic links cannot be reproduced by the E2B filesystem API used by this MVP.
- Harness `tool-fs-search` may still resolve its packaged host `rg` path in the current release. Use Bash with an `rg` binary installed in the AgentENV template until upstream makes search executable resolution provider-aware.
- In-process workflow/code runtimes and third-party plugins that bypass `ctx.fs` or `ctx.subprocess` remain host-side.
- The official E2B subprocess adapter retains SDK command transport buffers on the host and inherits its published PTY/process limitations.
- AgentENV 0.1.0 ships envd 0.5.15, while the official FS provider requests file metadata introduced in envd 0.6.2. The plugin retries only that explicitly unsupported metadata write without metadata. Ordinary metadata fingerprints still detect external changes, but identical-size writes inside an extremely coarse timestamp window have weaker stale-version detection until AgentENV upgrades envd.
