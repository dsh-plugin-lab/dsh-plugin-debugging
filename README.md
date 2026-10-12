<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<div align="center">
  <p><em>Troubleshoot a running DSH instance: whether a change needs a reload or a restart, whether a plugin actually loaded, 401 versus connection-refused, and what the composed config really contains.</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="powered by dsh"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT license"></a>
  </p>

  <p>
    Changelog → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a> (one Release per npm version)
  </p>
</div>

English | [中文](README_zh.md)

---

## What it provides

A skill plus four read-only tools, for the question **"I changed something and it didn't take effect"**.

The underlying model is one sentence: *an artifact is read at a particular moment, and that moment decides what you must do after changing it.* Config is re-read by the loader on every change; a process loads code once at startup; the browser swaps assets by fingerprint.

| Tool | Answers |
|---|---|
| `dsh_check_effect_mode` | Given what you changed, does it take effect live, require a restart, or go through HMR? |
| `dsh_diagnose_plugin_load` | Is the plugin in `bundles`, how is it mounted (link or copy), does its entry exist, and is there a startup log naming it? |
| `dsh_check_auth` | Connection refused (not running) versus 401 (running, not authenticated), plus the authority and port actually in use. |
| `dsh_dump_config` | The composed config tree and `x-cordis.diagnostics`, with the exit-code semantics that decide whether an error is real. |

It also ships a skill (`dsh-plugin-debugging`) carrying the full troubleshooting knowledge — the "why" behind each check, the three live-effect tiers, the installation forms, credential acquisition, process identification, and isolated instances. The tools are accelerators for it; where they are ambiguous, the skill text wins.

The skill is registered **into the active agent's own scope**, so a same-name copy you keep in a user-level skills directory does not shadow it. (Project-level skills still win, deliberately: a project's own rules should outrank any plugin.)

**v1 is read-only on purpose.** Nothing here restarts a process, rewrites a profile, or writes to `DSH_HOME`. Restart and hot-reload helpers are deliberately deferred: they are the only actions that can kill the host you are debugging, and their approval, cooldown, and failure-recovery semantics need to be settled first.

## Platform support

**v1 identifies processes by port on Windows only.** On other platforms the port lookup reports
`probed: false` with the platform in the message — deliberately *not* "no listener", because
"couldn't check" and "not running" are opposite conclusions. Everything else (config composition,
bundle/installation form, startup logs, authentication probing, config dumps) is platform-neutral.

## Install

```shell
dsh plugin --profile <profile> add dsh-plugin-debugging
```

## Host compatibility

The supported host range is declared in `package.json` — `engines.dsh`, plus the same range on every `@deepseek-ai/dsh-*` peer. **The values are not repeated here on purpose**: they drift, and a document that copies them goes stale silently. Read them from the manifest.

Two properties of that gate are worth knowing, because both fail quietly:

- The compatibility check reads **`peerDependencies`**, with `includePrerelease` enabled. `engines.dsh` currently has no reader at all, so declaring only `engines` enforces nothing.
- When a profile-level bundle fails the check, the error is caught and the bundle is skipped — the process starts normally and the plugin is simply absent. `dsh plugin add` fails loudly instead.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME`, else `<home>/.dsh` | Where the instance keeps profiles, logs and credentials. |
| `profile` | `$DSH_PROFILE`, else `web` | Which profile the tools inspect. Note the CLI consumes `--profile` itself, so it is never visible to a plugin; the environment is the only source. |
| `port` | `0` (infer) | Host port to probe. `0` means "find the listening port". |
| `timeoutMs` | `15000` | Ceiling for a spawned command or an HTTP probe. |

No credentials are stored: the plugin reads the files an instance already has and produces none of its own.

## Development

```shell
npm ci
npm run check          # typecheck + build + test
npm run check:release  # release-state invariants
```

Design notes live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); decisions and their reasons in [.agents/notes/](.agents/notes/); maintenance rules in [AGENTS.md](AGENTS.md). Release procedure: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License

[MIT](LICENSE)
