<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

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
    <!-- SLSA 徽章的**真实性判据**（别凭印象挂）：对**具体版本**查
         https://registry.npmjs.org/-/npm/v1/attestations/dsh-plugin-debugging@<版本> —— 200 才算有 provenance。
         实测：`0.1.0`（手动发）→ 404，**那一版不该挂**；`0.2.0`（由 release.yml 发）→ 200。 -->
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

- **Classify what a change needs** — live, restart, or hot reload, probed against the running profile rather than guessed.
- **Check whether a plugin loaded** — bundle membership, mount form, and the Loader tree, separating observed from inferred evidence.
- **Tell "not running" from "not authenticated"** — connection refused and 401 get opposite advice, so they must not be the same answer.
- **Show what a profile resolved to** — the composed tree plus the diagnostics that explain it.
- **Swap one mounted entry to the code on disk** — in place, no restart, rolled back on failure.
- **Sign a browser-session cookie** — so a script or CLI client can authenticate against your own instance.
- **List the DSH hosts running on this machine** — a port is only claimed as DSH when the unauthenticated `GET /` returns the exact DSH body; "could not probe" is reported separately from "not DSH".

The skill behind them carries the installation forms, credential acquisition, process identification, and isolated instances.
**The tools are accelerators; where one is ambiguous, the skill text wins.**

**Pointing at another instance.** The file-based tools (`dsh_dump_config`, `dsh_check_effect_mode`, `dsh_diagnose_plugin_load`, `dsh_sign_cookie`) take a `dshHome` argument, so you can read a second instance's disk evidence without restarting anything. Path resolution *and* the spawned `dsh` subprocess both use that home, and the output says which one it read (`dshHomeSource: tool-argument`) — the value is never silently reported as the configured default. Discovery tools can only hand you an authority (`host:port`); nothing maps an authority to a `dshHome`, so you supply the path. Two tools deliberately do **not** take it: `dsh_check_auth` answers about an authority (it already has `host`/`port`), and `dsh_hot_reload` swaps modules in **this** process's memory — that cannot cross into another instance. `dsh_diagnose_plugin_load` splits its answer accordingly: disk evidence belongs to the home you passed, while the Loader-tree half is **this process only**.

## Install

```shell
dsh plugin --profile web add dsh-plugin-debugging
```

From source:

```shell
git clone https://github.com/dsh-plugin-lab/dsh-plugin-debugging.git
cd dsh-plugin-debugging
npm install && npm run build
dsh plugin --profile web add "$PWD"
```

⚠️ The `npm install` step is not optional: with a `link:` install the dependencies come from the repository itself, and skipping it makes the plugin show up as not running (`ERR_MODULE_NOT_FOUND`).

Restart `dsh --profile web` for the install to take effect.

Requirements: Node `>= 20`, and a DSH range that satisfies [package.json](package.json) — the only source of truth for the supported range.

## Safety and boundaries

- The diagnostics tools read files an instance already has, and produce no credentials.
- They restart nothing and rewrite no profile. They write nothing to `DSH_HOME` — **machine-checked**: the moment a write targets host data (`profiles` / `sessions` / `storages` / `logs` / `cache` / `attachments` / `backups` / `integrations` / `mcp` / `settings.yaml` / `.credentials.yaml` …) or takes `DSH_HOME` as its target, `npm test` fails. The **one** exception is this plugin's own namespace, `$DSH_HOME/<package name>/` — exactly that one top-level segment; anything below it is free.
- `dsh_hot_reload` touches only the **running module tree**; it writes no profile, writes nothing to `DSH_HOME`, and kills no process.
- `dsh_sign_cookie` reads your local signing key to sign a cookie for your own instance. It sends no request and writes nothing; the cookie value is deliberately **not** returned.
- A restart helper is deliberately absent: it is the only action that can kill the host you are debugging.

## Platform support

Port-based process identification covers Windows, Linux and macOS.
When no usable command is found it reports that it could not check — deliberately not "no listener", because those are opposite conclusions.
The two weaker fallbacks may name a listener without naming its process; that stays reported as unidentified rather than as an empty list.
Everything else is platform-neutral.

## Configuration

There is no settings card: these fields belong to the plugin's config in the profile composition.

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME`, else `<home>/.dsh` | Where the instance keeps profiles, logs and credentials. |
| `profile` | `$DSH_PROFILE`, else the default profile | Which profile the tools inspect. |
| `port` | `0` | Host port to probe; `0` finds the listening port. |
| `timeoutMs` | `15000` | Tool budget for a quick workload: a file read, one spawned command, or one HTTP probe. |
| `schemaDumpTimeoutMs` | `60000` | Tool budget for the one tool that runs `--dump-config-schema` (measured 10.2–15.7 s; 32 s under load). |

Inside a tool, each spawned command or HTTP probe is given 2 s less than its tool budget: the transport layer must time out before the host's tool deadline, otherwise the model receives a bare `TimeoutError` with no error kind and cannot tell whether retrying is useful.

## License

[MIT](LICENSE).

## Contributing

Bugs and requests go to the repository Issues.

Maintainer's document map → [AGENTS.md](AGENTS.md).