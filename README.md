<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<p align="center">
  <img src="assets/banner.gif" alt="dsh-plugin-debugging: letting a DSH agent inspect and fix its own runtime" width="600">
</p>

<div align="center">
  <p><strong>Let your DSH agent inspect and fix its own runtime</strong></p>
  <p><em>让 DSH agent 自检自修它身处的运行时</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="powered by dsh"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/npm/v/dsh-plugin-debugging.svg?style=flat" alt="npm"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/badge/SLSA-Build%20L2-green?logo=slsa&style=flat" alt="SLSA Build L2"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT License"></a>
    <!-- Whether the SLSA badge can be shown is governed by [docs/PUBLISHING.md](docs/PUBLISHING.md) (check the attestations endpoint for **a specific version**; do not claim it from memory). -->
  </p>

  <p>
    Per-version changes → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a>
  </p>

  <p>
    <strong><a href="README.md">English</a></strong> · <a href="README_zh.md">简体中文</a>
  </p>
</div>

---

You changed something and it didn't take effect? In DSH, that usually means one of three things:

- **Config**: re-read on every change, so edits apply immediately. This presumes `hmr` is mounted in `profile`; without `hmr`, every change degrades to restart-required.
- **Host code**: a process loads code once at startup, so edits need a restart.
- **Front-end assets**: the browser swaps assets by fingerprint, so edits need a hot reload or refresh.

This plugin lets the agent decide which case you're in, and what to do next.

## What it does

After installation, the agent gains a set of tools and a skill document. The skill loads on demand.

### Tools

**Read-only** — they change nothing on the host.

| Tool | Arguments | What it does | Web | Desktop |
|---|---|---|---|---|
| `dsh_list_instances` | `port` | List the DSH hosts running on this machine. A port counts as DSH only when an unauthenticated `GET /` returns the exact DSH body. "Could not probe" and "not DSH" are reported separately. | ✓ | ✓ |
| `dsh_check_auth` | `host`, `port` | Tell "not running" apart from "not authenticated". | ✓ | ✓ |
| `dsh_diagnose_plugin_load` | `package`, `port`, `dshHome` | Check whether a plugin actually loaded: `bundle` membership, mount form, `loader` tree, with observed evidence kept separate from inferred evidence. | ✓ | ✓ |
| `dsh_check_effect_mode` | **`change`**: `config` / `bundle-added` / `host-code` / `client-code`, `alreadyInDependencies`, `dshHome` | Tell whether a change takes effect live, needs a restart, or needs a hot reload. It probes the running `profile` instead of guessing. | ✓ | ✗ |
| `dsh_dump_config` | `profile`, `dshHome` | Show what a `profile` resolved to: the composed tree, plus the diagnostics that explain it. | ✓ | ✗ |
| `dsh_sign_cookie` | `host`, `port`, `maxAgeDays`, `dshHome` | Sign a browser-session `cookie` so a script or CLI client can reach your own DSH instance. | ✓ | ✓ |

**Changes state** — the first two swap code or end the host you are debugging.

| Tool | Arguments | What it does | Web | Desktop |
|---|---|---|---|---|
| `dsh_hot_reload` | exactly one of **`entryId`** / **`module`** / **`serverName`**, plus `dryRun` | Swap a mounted `entry` to the latest code on disk without restarting. Rolled back on failure. | ✓ | ✓ |
| `dsh_restart` | **`reason`**, `delayMs`, `dryRun`, `force` | Restart this host when a change truly requires it. **Off by default.** | ✓ | ✗ |

Rows follow the order you would use them, so the two tables split on a single line: whether they change anything. The last column is availability by carrier; reasons live under [Platform support](#platform-support).

**Three common traps:**

- **A `401` from `dsh_check_auth` does not mean the session expired.** A request carrying no `cookie` always gets `401`, so an `auth probe`'s `401` only proves the service is running and wants authentication. To tell "the session is still valid" apart from "the `authority` is wrong", you must open that `host:port` in a browser. An old `cookie` keeps working after a restart on the same port; only a changed port produces `401`.
- **`dsh_hot_reload` may leak.** Resources the framework does not track — a `timer` or `socket`, for example — leak silently after a swap.
- **`dsh_restart` has its own section below.**

### The skill document behind it

The skill document lives at [`skills/dsh-plugin-debugging/SKILL.md`](skills/dsh-plugin-debugging/SKILL.md) and carries the full reasoning behind install forms, credential acquisition, process identification, and isolated instances.

**The tools are accelerators; if a tool's output conflicts with the skill document, the skill document wins.**

## Install

**Install from the Plugins page:**

Open the **Plugins** page, click **Add plugin** in the upper-right corner, enter `dsh-plugin-debugging`, and install.

**Install from npm:**

```shell
dsh plugin --profile web add dsh-plugin-debugging
```

**Install from source:**

```shell
git clone https://github.com/dsh-plugin-lab/dsh-plugin-debugging.git
cd dsh-plugin-debugging
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"
```

**Notes:**

- **Do not skip `pnpm install`**: with a `link:` install, dependencies come from the repository itself; skipping it makes the plugin show up as not running and report `ERR_MODULE_NOT_FOUND`.
- **Restart to take effect**: restart `dsh --profile web` after installing.
- **`link:` and `dsh.bundle` are two separate things**: `link:` only decides whether editing source needs a reinstall; whether the `patch` layer applies depends on whether the package declares `dsh.bundle`.

**Requirements:**

Node `>= 20`, and a DSH version that satisfies the range in [package.json](package.json).

**Maintenance rules:**

The `profile`'s `dependency` and `bundle list` are managed by `dsh plugin add`; do not edit them by hand. Do not create packages under `$DSH_HOME`, and do not run a package manager inside a `profile` directory.

## Safety and boundaries

Except for `dsh_restart`, these tools **never restart a process, never rewrite a `profile`, and never write to host data**. Tests enforce this rule: as soon as any write targets a host-data path (`profiles` / `sessions` / `storages` / `logs` / `cache` / `attachments` / `backups` / `integrations` / `mcp` / `settings.yaml` / `.credentials.yaml` …), or uses `DSH_HOME` itself as the target, `pnpm run test` fails.

**The only write exception is this plugin's own namespace**, `$DSH_HOME/<package name>/`: only the first directory directly under `$DSH_HOME` must exactly match the package name; anything below that is unrestricted.

**What each one touches:**

- **Read-only, no requests**: `dsh_check_effect_mode`, `dsh_diagnose_plugin_load`, `dsh_dump_config`. They only read files the instance already has, and they produce no credentials.
- **Read-only, sends HTTP**: `dsh_check_auth` connects to the `host:port` you name; `dsh_list_instances` probes loopback ports only. Neither sends credentials.
- **Touches the running module tree only**: `dsh_hot_reload`, and kills no process.
- **Reads the local signing key**: `dsh_sign_cookie`, to sign a `cookie` for your own instance. It sends no request, and the `cookie` value is deliberately not returned.
- **Ends the host**: `dsh_restart`, the only irreversible action here.

### `dsh_restart`

`dsh_restart` is the only irreversible action: it ends the host you are debugging. It is off by default, and running it means passing three gates:

1. **Four checks**: whether it is in a restart loop, whether other sessions or jobs are busy, whether the `bundle` table is readable, and whether the launch command can be determined. `force` overrides only the "sessions busy" gate; the other three cannot be bypassed.
2. **A separate approval check**: the approval policy is read first, and you are asked only when the policy is `ask`. `never` means prompts are disabled, so asking under `never` would be refused; the policy must be read before deciding whether to ask.
3. **A separate check before writing `marker`**: this plugin's own namespace is outside the default file sandbox, so the write explicitly uses `danger-full-access`.

**All three results are written into the tool output.** `dryRun` runs every gate but writes nothing.

> [!IMPORTANT]
> **Only on Windows, and only when the host was started as a Web process.** In the Desktop app it refuses before writing anything: quit from the tray and start again.

**What happens after a restart:**

- The new host reads the `marker`, wakes every session listed in it, and leaves one note in each.
- That note is a recap, not a "please continue": when the restart was requested, how long the host was down, what became of the `marker`.
- The `reason` you typed appears only in the session you started the restart from; other sessions get the same recap without it.

## Platform support

**Port-based process identification** is designed to be cross-platform; only Windows has been measured on real hardware. Specifically:

- **When no usable command is found**: it reports "could not check", not "no listener". Those are opposite conclusions.
- **Weaker fallbacks**: they may find "someone is listening" without identifying the process; that is reported as unidentified, not as "no listener".

Everything else is platform-neutral. `dsh_restart` needs Windows **and** a host started as a Web process: in the Desktop app the host is a child of the Electron shell, and no plugin-facing channel can relaunch that shell. If you can try a real relaunch on Linux or macOS, tell us in [#44](https://github.com/dsh-plugin-lab/dsh-plugin-debugging/issues/44) — that gap is exactly what the issue is for.

## Configuration

### Fields

These fields configure this plugin in the `profile` composition. `enableRestart` also has a switch on this plugin's card on the **Plugins** page.

| Field | Default | Meaning |
|---|---|---|
| `enableRestart` | `false` | Whether `dsh_restart` is allowed to run. Takes effect immediately, with no host restart. |
| `dshHome` | `$DSH_HOME`, otherwise `<home>/.dsh` | Where the instance keeps `profiles`, logs, and credentials. |
| `profile` | `$DSH_PROFILE`, otherwise the default `profile` | Which `profile` the tools inspect. |
| `port` | `0` | Host port to probe; `0` means find the listening port automatically. |
| `timeoutMs` | `60000` | Timeout budget for quick work: reading a file, running one command, or one HTTP probe. |
| `schemaDumpTimeoutMs` | `240000` | Timeout budget for running `--dump-config-schema` (measured 10.2–15.7 s; 32 s under load). |

How those two budgets are derived, and why the transport layer has to expire before the host's tool deadline → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §5.1.

### Debugging another instance

**When you need it:** you are debugging one instance, but the evidence is on another — a second `profile`, or another `DSH_HOME`.

**Which tools take `dshHome`:** `dsh_dump_config`, `dsh_check_effect_mode`, `dsh_diagnose_plugin_load`, `dsh_sign_cookie`. Both path resolution and the spawned `dsh` subprocess use the `home` you pass in, and the output says which one was actually read (`dshHomeSource: tool-argument`). A value passed as an argument is never silently reported as the configured default.

**Which do not, and why:**

- `dsh_check_auth`: it answers about a `host:port`'s authentication state, and already has `host` / `port`.
- `dsh_list_instances`: it only does discovery, and all it can give is a `host:port`.
- `dsh_hot_reload`: it swaps modules in the **current process**'s memory, which cannot cross to another instance.
- `dsh_restart`: it kills the host it runs in, so there is no "other instance" it could be aimed at.

**One trap:** discovery tools can only give a `host:port`, and nothing maps that to a corresponding `DSH_HOME`; so you must supply `dshHome` yourself. Accordingly, `dsh_diagnose_plugin_load` splits its answer in two: disk evidence comes from the `home` you passed in, and the `loader` tree half reflects **the current process only**.

## License

[MIT](LICENSE).

## Contributing

Bugs and requests go to the repository Issues.

Maintainer's document map → [AGENTS.md](AGENTS.md).
