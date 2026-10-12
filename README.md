<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<div align="center">
  <p><strong>Read-only debugging toolkit for a running DSH instance</strong></p>
  <p><em>给正在跑的 DSH 实例排障：只读</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="powered by dsh"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT License"></a>
    <!-- 首次发布到 npm 后补这两枚（现在挂上去只会显示 not found）：
         <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/npm/v/dsh-plugin-debugging.svg?style=flat" alt="npm"></a>
         <a href="https://www.npmjs.com/package/dsh-plugin-debugging"><img src="https://img.shields.io/badge/SLSA-Build%20L2-green?logo=slsa&style=flat" alt="SLSA Build L2"></a> -->
  </p>

  <p>
    Per-version changes → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a>
  </p>

  <p>
    <a href="README_zh.md">简体中文</a> · <strong><a href="README.md">English</a></strong>
  </p>
</div>

---

One sentence holds this plugin together: **an artifact is read at a particular moment, and that moment decides what you must do after changing it.** Config is re-read on every change; a process loads code once at startup; the browser swaps assets by fingerprint. When a change "doesn't work", the first question is which of those three you are looking at.

## Tools

Installing it gives the model four tools, plus one skill:

| Tool | In one line | Reach for it when |
|---|---|---|
| `dsh_check_effect_mode` | Which of the three readings your change falls under | A change had no effect and you don't know whether to reload or restart |
| `dsh_diagnose_plugin_load` | Whether a plugin is in `bundles`, how it is mounted, and what the Loader tree says | A plugin is installed but seems absent |
| `dsh_check_auth` | Connection refused (not running) versus 401 (running, not authenticated) | The page returns 401, or you can't tell whether the host is up |
| `dsh_dump_config` | The composed config tree and its diagnostics | You need to know what the composition actually resolved to |

`dsh-plugin-debugging` is the skill behind them: it carries the reasoning for every check, the three live-effect tiers, the installation forms, credential acquisition, process identification, and isolated instances. **The tools are accelerators; where one is ambiguous, the skill text wins.**

### `dsh_check_effect_mode` —— what a change needs

- `change` (**required**): `config` (config / patch / enablement / uninstall) · `bundle-added` (a newly installed bundle) · `host-code` (host-side code of an installed plugin) · `client-code` (client code / UI).
- `alreadyInDependencies`: only meaningful for `change: bundle-added`.

**Boundary**: it first probes whether the profile actually mounts `hmr`. Without `hmr`, `reload()` is a no-op, so any "takes effect live" verdict is downgraded to `restart-required`. It restarts nothing.

### `dsh_diagnose_plugin_load` —— whether a plugin loaded

- `package`: name to check, e.g. `dsh-zhihu-search` or `@scope/name`. Omit to list every bundle.
- `port`: host port to probe.

**Boundary**: it reports **observed** evidence (the `loader` tree is readable: `fiber.state`, and `fiber === undefined` for modules that failed at import) separately from **inferred** evidence (the three preconditions: `bundles` membership, install form, entry file). When the tree cannot be read, the output says `mode=inferred` explicitly. Processes are found **by port**, never by command-line substring.

### `dsh_check_auth` —— not running, or not authenticated

- `port`: host port to probe.
- `host`: hostname, default `127.0.0.1`.

**Boundary**: the authority is a literal `host:port` match, so `localhost` and `127.0.0.1` are not interchangeable. It reports whether the `client-connection` / `browser-session` entries **exist**; v1 extracts no keys and signs no cookies.

### `dsh_dump_config` —— what the composition resolved to

- `profile`: profile name; omit to use the plugin's configured profile.

**Boundary**: `--dump-config` always exits 0, so its exit code is not a gate; `--dump-config-schema` exits 1 when there are errors, and the known `preset-*` false positive is separated from errors that point at a row you changed.

## Read-only by design

- Reads files an instance already has; stores no credentials and produces none.
- Restarts nothing, rewrites no profile, writes nothing to `DSH_HOME`.
- Restart and hot-reload helpers are deliberately absent: they are the only actions that can kill the host you are debugging.

## Install

### Prerequisites

- **The supported DSH range is in [package.json](package.json)** (`engines.dsh`, and the same range on every `@deepseek-ai/dsh-*` peer) — the only source of truth; not copied here, because a copied range goes stale silently.
- Node `>= 20`.

### From npm

```shell
dsh plugin --profile web add dsh-plugin-debugging
```

Not on npm yet — this path starts working at the first release.

### From source

```shell
git clone https://github.com/dsh-plugin-lab/dsh-plugin-debugging.git
cd dsh-plugin-debugging
npm install && npm run build

dsh plugin --profile web add "$PWD"
```

⚠️ The `npm install` step is not optional: with a `link:` install the dependencies come from the repository itself, and skipping it makes the plugin show up as not running (`ERR_MODULE_NOT_FOUND`).

Restart `dsh --profile web` for the install to take effect.

## Platform support

Port-based process identification is **Windows-only** in v1. Elsewhere the lookup reports `probed: false` with the platform in the message — deliberately not "no listener", because "couldn't check" and "not running" are opposite conclusions. Everything else is platform-neutral.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME`, else `<home>/.dsh` | Where the instance keeps profiles, logs and credentials. |
| `profile` | `$DSH_PROFILE`, else the default profile | Which profile the tools inspect. |
| `port` | `0` | Host port to probe; `0` finds the listening port. |
| `timeoutMs` | `15000` | Ceiling for one spawned command or HTTP probe. |

There is no settings card: how a plugin is configured is described in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).

## Contributing

Bugs and requests go to the repository Issues.

Maintainer's document map → [AGENTS.md](AGENTS.md).
