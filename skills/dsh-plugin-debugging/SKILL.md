---
name: dsh-plugin-debugging
description: Debugging a DSH plugin against a running DSH instance. Use when a change did not take effect, when unsure whether to reload/restart, when the page returns 401, or when setting up an isolated instance.
author: zlZayn
metadata:
  source:
    repo: https://github.com/dsh-plugin-lab/dsh-plugin-debugging
    path: skills/dsh-plugin-debugging
---

# DSH plugin troubleshooting

Scope: **troubleshooting**. This skill covers "my change did not take effect", "do I need a restart", 401, isolation, and credentials. **Writing a plugin is out of scope.**

The one principle: **an artifact is read at a particular moment, and that moment decides what you must do after changing it.** When a verdict is unclear, first ask: when is this artifact read?

**Tool availability, arguments and output belong to each tool's own description.** This skill states only *when* a capability is the right one. Never infer from this text whether a tool is currently enabled — if a tool refuses, its own output says why.

## When each artifact is read

| What you changed | Takes effect | Why |
| --- | --- | --- |
| Config / patch / enabled state / uninstall | **live** | the loader re-reads on every change and rebuilds only the rows that differ |
| A newly installed bundle | **live**; but **restart** once the package is already in `dependencies` | a brand-new install goes through `reload()`; an existing dependency only changing selection reports `restart-required` |
| A plugin's host-side code, or its dependencies | **restart required** | a process loads modules once at startup; dependency changes alter the module graph |
| Client code / UI | swapped by HMR; otherwise build and refresh | the browser side loads independently of the host's module cache |

**"Live" presumes HMR is mounted.** `reload()` is a no-op without the `hmr` service, and every change then degrades to `restart-required`. Confirm `hmr` is in the profile before judging. **It has exactly two sources of truth: the profile file and the composed tree that `dsh_dump_config` prints.** What you must **not** use is a plugin-status listing: whatever the session exposes, it can only tell you whether the row is there, never that the row is disabled — and the rows whose enablement depends on context are exactly the ones that matter. **Never read HMR off a listing.**

The difference is not "which is more trouble" but **who reads that artifact**: the loader re-reads config every time, a process loads code once at startup, and the browser swaps assets by fingerprint.

**Corollary.** For "a code change had no effect" the default answer is a restart. For "a config change had no effect" the default answer is that the config is wrong, or that it sits where a higher layer replaced the whole row — config is supposed to be live.

## The decision procedure

**Establish the mode first.** If your tool list contains `cordis_inspect_list`, you have self-inspection and can use *Reading the load state*. If it does not, skip that section and use only the external checks below.

Ask in order, and stop at the first hit:

1. **Change had no effect?** Classify it against *When each artifact is read*: client, host-side, config, or a **newly installed bundle** — the one row with two outcomes. That row turns on *is the package already in the profile's `dependencies`?*, which is what `dsh_check_effect_mode`'s `alreadyInDependencies` answers; the profile's `package.json` is where it shows. **Do not reinstall first** — reinstalling changes only the install form, never when the artifact is read.
2. **Did the plugin load?** With an inspection tool, self-inspect. Otherwise check three things externally: the bundle list, the install form, and the process. **All three prove preconditions only, never that loading succeeded.** A failed startup writes full diagnostics to `$DSH_HOME/logs/startup-*.log` — and that file survives across restarts, so compare it against the current process's start time before treating it as evidence.
3. **401?** Separate "connection refused" (not started) from "401" (running, not authenticated). Then separate "a browser page carrying a cookie" from "a probe carrying no credentials" — only the first can be explained by a port change.
4. **Reinstall, restart, or isolate?** See *Install form*, *When each artifact is read*, and *Isolated instance*. To act on the verdict, see *Acting on the verdict*.
5. **Need to reach the page but have no token or cookie?** See *Credentials*. This is not the same as 401 — you may simply never have visited it.

## Facts

### Composition

- A bundle is an **npm package that declares `dsh.bundle`**. It contributes a patch layer; it is not the plugin itself.
- A profile's bundle list is ordered. Load order is: each bundle patch in list order, then the profile patch, then the home patch, then any command-line patch.
- **A later layer wins row by row, and a patch replaces the whole config row — it does not deep-merge.**
- So "installed but not active" has two causes here: **the package never entered the bundle list** (the layer never activated), or **its config row was replaced wholesale by a later layer**. A third cause is in *Install form*.
- Why whole-row replacement: it keeps every layer's result predictable and revertible. The cost is that overriding one field means rewriting the row.

### Install form

- `dsh plugin add ./<local dir>` gives a **link**: edits to the repository take effect immediately, with no reinstall.
- `dsh plugin add <registry package>` gives a **copied snapshot**: editing the source does not touch the installed copy, so it needs a reinstall.
- The two forms coexisting is **normal**. The source decides which one you have.
- An add step installs dependencies and appends the package name to the profile's bundle list.
- Why a link needs no reinstall: a link is only an entry pointing at the repository, so the repository's artifacts are the artifacts being read. There is no copy in between.

**The third cause: does the package declare `dsh.bundle`?**

- **The criterion is the declaration, and it is independent of link versus copy.** Declared: the package contributes a patch layer and is **applied automatically**, links included. Not declared: it is an ordinary dependency that **contributes no layer**, the add step warns that it declares no bundle, and you must write the entry yourself.
- **Link versus copy decides only whether editing the source needs a reinstall**, never whether the patch applies. Do not merge the two questions.
- A profile patch's rows are often **not mounts** — the row comes from the bundle layer — but **config-only overrides**. That is what the composition dump's "patched by" annotation marks.
- **Upstream constraints**: do not hand-write a profile's dependency or bundle lists (the add step manages them), do not create packages under `$DSH_HOME`, and do not run a package manager inside a profile directory.

### Authentication

- A valid token exchange is **303 plus Set-Cookie, then 200** — not a direct 200. **A 303 is success.**
- The cookie is signed by the **persistent signing key** in the credentials file, and is **bound to an authority**, host and port together.
- **Its lifetime is fixed and does not slide.** The exchange is the only place a cookie is ever set; authenticated requests only verify a signature. So "the same port survives a restart" is bounded by that lifetime, and never refreshed by use.
- Therefore an **old tab holding a valid cookie keeps working after a restart on the same port**. **Changing the port** is what makes it 401. A stale launch token fails after a restart, also 401. Connection refused means not started.
- ⚠️ **401 on its own does not mean the port changed.** A request carrying no cookie gets 401 **always**. An auth probe is exactly that kind of request — it reads no value and signs no cookie — so its 401 proves only that the service is up and wants authentication. It **cannot** answer "is my session still valid" or "is this the right authority". Only **opening that authority in a browser** separates those two.
- "The token is never on disk" is **imprecise**. Precisely: the **launch token is not on disk; the signing key is**. That distinction is the entire reason *Credentials* works.

### Credentials

**First choice**: read the browser-session secret out of `$DSH_HOME/.credentials.yaml` — the `client-connection/browser-session` record — and sign the cookie yourself. No logs, no terminal. **Fall back** to having the user copy a value out of the terminal or the address bar.

The cookie is `dsh-auth-<base64url(sha256("<host>:<port>"))>` whose value is `v1.<base64url(body)>.<base64url(HMAC-SHA256(secret, body))>`, with `body` the JSON `{"version":1,"authority":"<host>:<port>","issuedAt":ms,"expiresAt":ms}`. Sign the **body string itself**, not a re-serialized JSON, and keep the authority byte-identical to the real `Host` header — `localhost` and `127.0.0.1` are not interchangeable. Anything that signs for you will not hand the value back, so this is what you give a human or a local script.

**Do not scan process memory.** For **the main instance it is essentially useless**: the main process holds the current session record, historical tokens included, which pollutes the verdict. It is clean only for an isolated instance.

**Two dead ends — do not retry them.** Reading process environment variables: the token is an in-process object, and the environment holds only a URL that does **not** contain it. Reading the launching terminal: a pseudoconsole has no traditional console buffer, and UI automation sees only the visible region.

**Why the first choice works**: cookie verification depends only on the signing key and the authority, never on the launch token. The token is the way in the first time, not a long-lived credential. **Boundary**: a separate home means separate credentials, and therefore a separate cookie secret.

### Process and port

Identify by port. That is the only accurate way. Do not filter by a command-line substring such as a script file name: it also matches derived shell subprocesses.

### Isolated instance

The instance must be given a template profile, otherwise the new home has no profile to start and reports that the profile does not exist. Only a separate home truly isolates: data, credentials and cookie secret all become separate.

The template is commonly the web profile. **The legal values are whatever the error enumerates** — a wrong one prints the list — so do not hardcode it.

### Reading the load state

**Fiber-level state is queryable; it is just not in the config listing.** Two counter-intuitive points decide the verdict:

- ⚠️ **A client failure looks like "no page, retry", but it is evidence the page is online.** It appears only after a handler throws, and the message it carries is the real cause. "There is no online page" is a *different* message. Separating "there is no page" from "the page is there and the plugin's code threw" is exactly the distinction this work needs.
- ⚠️ **An entry that fails at import time has no fiber at all.** The host files it as a failed import, so a check that only looks for an apply failure misses it entirely.

The config listing's own status is readable at runtime, but **its "inactive" value mixes three meanings — disabled, never imported, and disposed — and it never reports a failure**, so it cannot answer whether something crashed.

To actually settle it:

- **At startup there is hard evidence.** A missing required plugin fails startup outright and writes full diagnostics to a startup log file under the home's logs directory — **written only when startup fails**, not a running log — and prints the path to the terminal. ⚠️ **That file stays on disk across restarts**, so it may not belong to the current process. Compare it against the current process's start time. The answer has three values: it belongs to this start; it predates this start, so it is a leftover and **not** evidence of a failure now; or the comparison cannot be made, in which case it is neither. **Only the first supports a conclusion about this start.**
- **At runtime**, check whether the registration surface the plugin should have — its tools, slots and services — is missing, and look back at whether the startup report already named it.
- **A config mistake**: call `dsh_dump_config` — it runs the schema check and reports the diagnostics it attaches. It covers both composition-time errors, which are dropped wholesale rather than partially applied, and schema-layer problems. **A non-zero exit code means there is an error.**
- **Just the composed tree, without the huge JSON**: the plain composition dump does **no schema validation**, and **its exit code is always 0 — never use it as a gate**.

## Acting on the verdict

**Judging and acting are separate.** The sections above only produce verdicts, and the diagnostic tools are read-only. Three tools change state or hand out a credential. For each, this section answers only *when* it is the right one and what it costs.

**`dsh_hot_reload` — swap a plugin's own code without restarting the host.**

- **When**: you just changed a plugin's **host-side code**, and the model above puts that tier at "restart required". This brings the restart forward without touching the process.
- **Preview before you commit**: it accepts a dry run that reports without swapping anything.
- **A failed swap is rolled back**, and it reports whether the running tree was touched at all.
- **What it cannot manage**: anything the framework does not track — the tool's own boundary paragraph names the kinds — leaks silently when the entry is swapped, so a swapped entry can leave a live timer or socket behind.

**`dsh_sign_cookie` — give a script or CLI client credentials.**

- **When**: an auth probe returned 401, and the next step is not a browser tab.
- It is the only tool here that reads the signing key, and **the cookie value deliberately never enters its return value**. It reports that signing succeeded, which authority the cookie is bound to, and the cookie's name.
- **The cookie name is not a secret** and can be used as it is. The authority and lifetime mechanics are in *Authentication*.

**`dsh_restart` — restart the host and bring the previous sessions back.**

- **When**: a change is classified as restart-required, meaning a config change with no HMR mounted — or you changed something read only at host **startup**, which a hot swap cannot replace.
- **It is the only tool here that ends the host process, and it is irreversible**: in-flight conversations, listening ports, all gone. It therefore passes four deterministic gates — restart-loop breaker, other sessions or jobs in flight, an unreadable bundle table, an undeterminable launch command — **before** the approval gate. Forcing the restart overrides only the "sessions in flight" gate; the other three cannot be bypassed.
- **Two independent gates must both pass**: the approval policy, and the file sandbox. Writing the restart state needs full access and is refused with a reason otherwise. **A dry run is safe** — it runs the gates and writes nothing.
- **Sessions are brought back automatically.** The new host reads the restart marker, wakes each listed session, and delivers one notice: facts plus a pointer, never "please continue". So it **really does run a turn**.
- ⚠️ **The notice's reason goes only to the session that requested the restart.** Sessions that were merely interrupted receive the same facts — when it was requested, how long it took, what became of the marker — **without the reason**. It is a note the user left for themselves, not an announcement. So you cannot read someone else's reason, and you should not relay the one you receive.
- **It cannot cross instances.** It changes this process's lifetime. To work on another instance, discover it first: the discovery tool's result is an authority, host and port only, and **nothing maps an authority to a home**, so any tool that needs a home must be given one by the caller.
- ⚠️ **A real relaunch is Windows-only.** Elsewhere it refuses structurally **before writing anything**, so it will not "try it" on another platform. Do not read that refusal as a bypassable error.
- Whether a restart is warranted at all is decided in *When each artifact is read*. Credentials and the 401 split are in *Authentication*.

## Command reference

Placeholders: `<port>`, `<profile>`, `<plugin-repo>`, `<home>`, `<package name>`, `<template>`. The diagnostic and acting tools above cover everything else here.

```powershell
# Install / list — no tool covers this.
dsh plugin --profile <profile> add <plugin-repo>       # local dir -> link
dsh plugin --profile <profile> add <registry package>  # registry -> copied snapshot

# Isolated instance — no tool covers this.
# Omitting the template reports that the profile does not exist.
$env:DSH_HOME = "<separate dir>"
dsh --profile <new profile> --from-default-profile <template> --port <free port> --no-open

# Identify the process holding a port — the only accurate way, and the fallback
# when no inspection tool is available in this session.
Get-NetTCPConnection -LocalPort <port> -State Listen
```

## Boundaries

**In scope**: load timing and effect verdicts, install form and patch-layer ownership, load-state queries, authentication and credentials, processes and ports, isolated instances, and the write-side, derived and acting tools once a verdict is reached.

**Out of scope**: how to write plugin code, which extension point to choose, what a template looks like, how to edit a preset, and which packages are installable. Find the corresponding material elsewhere.

One overlap at the boundary: *Install form* discusses patch rows only to answer "why is this row on this layer". The full patch dialect is elsewhere.
