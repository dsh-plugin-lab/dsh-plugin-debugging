<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<p align="center">
  <img src="assets/banner.jpg" alt="dsh-plugin-debugging: letting a DSH agent inspect and fix its own runtime" width="600">
</p>

<div align="center">
  <p><strong>Let your DSH agent inspect and fix its own runtime</strong></p>
  <p><em>让 DSH Agent 自检自修它身处的运行时</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="powered by dsh"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/npm/v/dsh-plugin-debugging.svg?style=flat" alt="npm"></a>
    <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/badge/SLSA-Build%20L2-green?logo=slsa&style=flat" alt="SLSA Build L2"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT License"></a>
    <!-- SLSA 徽章能不能挂，判据见 [docs/PUBLISHING.md](docs/PUBLISHING.md)（对**具体版本**查 attestations 端点；别凭印象挂）。 -->
  </p>

  <p>
    Per-version changes → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a>
  </p>

  <p>
    <a href="README_zh.md">简体中文</a> · <strong><a href="README.md">English</a></strong>
  </p>
</div>

---

An artifact is read at a particular moment, and that moment decides what you must do after changing it.
Config is re-read on every change; a process loads code once at startup; the browser swaps assets by fingerprint.
When a change "doesn't work", the first question is which of those three you are looking at.

## What it does

Installing it gives the model the tools to answer that question, and one skill carrying the reasoning behind them.

### Tools

| Tool | Required | Optional | What it does |
|---|---|---|---|
| `dsh_check_effect_mode` | `change`: `config` / `bundle-added` / `host-code` / `client-code` | `alreadyInDependencies`, `dshHome` | Classify what a change needs — live, restart, or hot reload, probed against the running profile rather than guessed. |
| `dsh_diagnose_plugin_load` | — | `package`, `port`, `dshHome` | Check whether a plugin loaded — bundle membership, mount form, and the Loader tree, separating observed from inferred evidence. |
| `dsh_list_instances` | — | `port` | List the DSH hosts running on this machine — a port is claimed as DSH only when the unauthenticated `GET /` returns the exact DSH body; "could not probe" is reported separately from "not DSH". |
| `dsh_check_auth` | — | `host`, `port` | Tell "not running" from "not authenticated" — connection refused and 401 get opposite advice, so they must not be the same answer. |
| `dsh_dump_config` | — | `profile`, `dshHome` | Show what a profile resolved to — the composed tree plus the diagnostics that explain it. |
| `dsh_hot_reload` | one of `entryId`, `module`, `serverName` | `dryRun` | Swap one mounted entry to the code on disk — in place, no restart, rolled back on failure. |
| `dsh_sign_cookie` | — | `host`, `port`, `maxAgeDays`, `dshHome` | Sign a browser-session cookie — so a script or CLI client can authenticate against your own instance. |
| `dsh_restart` | `reason` | `delayMs`, `dryRun`, `force` | Restart this host when a change needs it. **Off by default.** |

### The skill behind them

It carries the installation forms, credential acquisition, process identification, and isolated instances.
**The tools are accelerators; where one is ambiguous, the skill text wins.**

## Install

```shell
dsh plugin --profile web add dsh-plugin-debugging
```

From source:

```shell
git clone https://github.com/dsh-plugin-lab/dsh-plugin-debugging.git
cd dsh-plugin-debugging
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"
```

⚠️ The `pnpm install` step is not optional: with a `link:` install the dependencies come from the repository itself, and skipping it makes the plugin show up as not running (`ERR_MODULE_NOT_FOUND`).

Restart `dsh --profile web` for the install to take effect.

Requirements: Node `>= 20`, and a DSH range that satisfies [package.json](package.json) — the only source of truth for the supported range.

## Safety and boundaries

### What they touch

- Five tools only read (`dsh_check_effect_mode`, `dsh_diagnose_plugin_load`, `dsh_list_instances`, `dsh_check_auth`, `dsh_dump_config`). They work on files an instance already has, and produce no credentials.
- Two tools make HTTP requests: `dsh_check_auth` connects to the authority you name, and `dsh_list_instances` probes **loopback** ports only. Neither sends credentials.
- Nothing here restarts a process or rewrites a profile, and nothing writes to host data — **machine-checked**: the moment a write targets host data (`profiles` / `sessions` / `storages` / `logs` / `cache` / `attachments` / `backups` / `integrations` / `mcp` / `settings.yaml` / `.credentials.yaml` …) or takes `DSH_HOME` as its target, `pnpm run test` fails. The **one** exception is this plugin's own namespace, `$DSH_HOME/<package name>/` — exactly that one top-level segment; anything below it is free.
- `dsh_hot_reload` touches only the **running module tree**, and kills no process.
- `dsh_sign_cookie` reads your local signing key to sign a cookie for your own instance. It sends no request; the cookie value is deliberately **not** returned.

### `dsh_restart`

- It is the one **irreversible** action: it exits the host you are debugging.
- It is gated by four deterministic gates: restart loop, other busy sessions and jobs, an unparseable composition, an undeterminable launch command.
- Then by a fifth, separate gate — the **approval policy**, read first and only asked about when it is `ask`. `never` means prompts are off, so asking there would be refused by construction; that is why the policy is read before deciding whether to prompt.
- Writing the marker needs a second, independent gate: this plugin's own namespace is outside the default file sandbox, so the write is made with `danger-full-access`.
- Both gates are reported in the output.

## Platform support

Port-based process identification covers Windows, Linux and macOS.
When no usable command is found it reports that it could not check — deliberately not "no listener", because those are opposite conclusions.
The two weaker fallbacks may name a listener without naming its process; that stays reported as unidentified rather than as an empty list.
Everything else is platform-neutral, with **one exception**: `dsh_restart` can only **relaunch** on Windows, where the task-scheduler route has been measured. Elsewhere it refuses before it writes anything — it will not write a marker and then discover it cannot bring the host back.

## Configuration

### Fields

These fields live in the plugin's config in the profile composition. One of them, `enableRestart`, also has a switch on this plugin's page under **Plugins**.

| Field | Default | Meaning |
|---|---|---|
| `enableRestart` | `false` | Whether `dsh_restart` is allowed to run. Takes effect immediately, with no host restart. |
| `dshHome` | `$DSH_HOME`, else `<home>/.dsh` | Where the instance keeps profiles, logs and credentials. |
| `profile` | `$DSH_PROFILE`, else the default profile | Which profile the tools inspect. |
| `port` | `0` | Host port to probe; `0` finds the listening port. |
| `timeoutMs` | `60000` | Tool budget for a quick workload: a file read, one spawned command, or one HTTP probe. |
| `schemaDumpTimeoutMs` | `240000` | Tool budget for the one tool that runs `--dump-config-schema` (measured 10.2–15.7 s; 32 s under load). |

### Budgets

Inside a tool, each spawned command or HTTP probe is given 2 s less than its tool budget: the transport layer must time out before the host's tool deadline, otherwise the model receives a bare `TimeoutError` with no error kind and cannot tell whether retrying is useful.

### Another instance

**When you need it.** You are debugging one instance, but the evidence is on another — a second profile, or another `DSH_HOME`.

**Which tools take `dshHome`.** `dsh_dump_config`, `dsh_check_effect_mode`, `dsh_diagnose_plugin_load`, `dsh_sign_cookie`. Path resolution *and* the spawned `dsh` subprocess both use that home, and the output says which one it read (`dshHomeSource: tool-argument`) — the value is never silently reported as the configured default.

**Which do not, and why.**

- `dsh_check_auth` — it answers about an authority, and already has `host`/`port`.
- `dsh_list_instances` — pure discovery; all it can hand you is an authority.
- `dsh_hot_reload` — it swaps modules in **this** process's memory, which cannot cross into another instance.
- `dsh_restart` — the sharper case: it kills the host it runs in, so there is no "other instance" it could be aimed at.

**One trap.** Discovery tools can only hand you an authority (`host:port`); nothing maps an authority to a `dshHome`, so you supply the path yourself. `dsh_diagnose_plugin_load` splits its answer accordingly: disk evidence belongs to the home you passed, while the Loader-tree half is **this process only**.

## License

[MIT](LICENSE).

## Contributing

Bugs and requests go to the repository Issues.

Maintainer's document map → [AGENTS.md](AGENTS.md).