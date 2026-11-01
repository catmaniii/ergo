[中文](developer-guide.md) | **English**

# ergo Developer Guide

For people who want to read, change or extend the code. Installing and using ergo is covered in the [User Guide](user-guide.en.md); how to submit changes is in [CONTRIBUTING](../CONTRIBUTING.md).

- **Terminology** follows [CONTEXT.md](../CONTEXT.md) (secretary, task, project, maintainer, guard, timeline…); code, UI and docs use the same words. (CONTEXT.md, the ADRs and code comments are in Chinese.)
- **Why things are the way they are** is recorded in the [architecture decision records](adr/) (ADRs), referenced by number below.
- **"Ticket N" in code comments** refers to internal development records that are not in the public repository; the comments themselves explain what and why.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Common commands](#2-common-commands)
3. [What's in the repository](#3-whats-in-the-repository)
4. [Architecture](#4-architecture)
5. [Plugins](#5-plugins)
6. [Web UI](#6-web-ui)
7. [Internationalization](#7-internationalization)
8. [Phone apps](#8-phone-apps)
9. [Coding conventions](#9-coding-conventions)
10. [Testing](#10-testing)
11. [Upgrading pi](#11-upgrading-pi)
12. [From ergou to ergo](#12-from-ergou-to-ergo)
13. [Docs, CHANGELOG, decision records](#13-docs-changelog-decision-records)

---

## 1. Prerequisites

- **Windows 10 / 11.** Job objects, directory junctions, Windows Sandbox and scheduled tasks exist only on Windows; tests relying on them are skipped elsewhere, and the daemon refuses to start elsewhere.
- **Node 22** (≥ 22.19). **The Node major version follows pi** ([ADR-0031](adr/0031-node-version-follows-pi.md)): whatever major version pi's CI and installer use is what ergo packages, runs and tests on; when pi upgrades we follow, otherwise we stay. Sources are TypeScript run directly via Node's type stripping; the daemon has no build step.
- **Git for Windows (Git Bash)**: pi's `bash` tool and a number of integration tests need it. `where bash` should list `C:\Program Files\Git\bin\bash.exe` first; if only `C:\Windows\System32\bash.exe` (the WSL stub) is found, prepend Git's bin to PATH: `$env:PATH = "C:\Program Files\Git\bin;" + $env:PATH`. Without Git Bash, bash-dependent tests are explicitly skipped or say so in their timeout error.
- **Dependency install scripts**: `allowScripts` in the root `package.json` marks the existing ones (esbuild, koffi, onnxruntime-node, protobufjs, @google/genai) as not run — their native files ship prebuilt. When adding a dependency with an install script, decide whether it must run and record it. npm 10 (bundled with Node 22) ignores this field and runs them anyway.
- **Don't start long-running services directly on a dev machine**: ergo's services are registered with and started by the supervisor (see the [User Guide](install.en.md#install-from-source)). Daemons and child processes started by tests belong to the tests and are torn down with them.

## 2. Common commands

From the repository root:

| What | Command |
|---|---|
| Install dependencies | `npm ci` |
| Run this after every change: the fast lane (all unit tests except the main slice and contract tests, plus web state / UI / build checks) | `npm run test:fast` (~2 minutes) |
| The main slice (real daemon and agent child processes) plus opening every page in a real browser | `npm run test:integration` (10+ minutes) |
| Everything (fast lane + main slice + pi contract tests) | `npm test` (~35 minutes; on Windows consider `$env:ERGO_TEST_WORKERS=2`) |
| pi contract tests (only when upgrading pi or changing `agent-host/`, `runtime/`, prompt assembly) | `npm run test:contract` |
| Supervisor tests (`node --test`, not vitest) | `npm run test:supervisor` |
| One package, one file, by name | `npm test -w @ergo/daemon`; `npx vitest run packages/daemon/test/agent-process.test.ts`; `npx vitest run --project daemon -t "<name>"` |
| Type check | `npm run typecheck` |
| Lint | `npm run lint` (oxlint, configured in `.oxlintrc.json`) |
| The full pre-merge set | `npm run check` (typecheck + lint + all tests + supervisor) |
| i18n check | `npm run i18n:check` ([Section 7](#7-internationalization)) |
| Build the web UI | `npm run build:web` (a single file, `packages/web/dist/index.html`) |
| Build the online demo | `npm run build:demo` (into `packages/web/dist-demo/`, [6.1](#61-where-pages-come-from-prototype-and-online-demo)) |
| Open the real page after deploying | `npm run smoke:page` (headless Chrome on `http://127.0.0.1:8810/`; `-- <url>` for another address) |
| Build the HarmonyOS app | `npm run build:harmony` ([Section 8](#8-phone-apps)) |
| Build the Android app | `npm run build:android` ([8.5](#85-android-app)) |
| Download the embedding model | `npm run download-model` |
| Back up now | `npm run backup` (installed builds have no `npm run`: `ergo backup`) |
| Restore from a snapshot | `node packages/daemon/src/restore.ts <date>` (installed builds: `ergo restore <date>`; stop the daemon first either way) |
| Deploy the VPS nginx site for the public entry | `npm run deploy:nginx` (`-- --print` only prints) |
| Check a project service's pages against the prefix convention | `npm run check:app-prefix -- <service url> --name <app name>` ([4.8](#48-proxying-local-service-pages)) |

## 3. What's in the repository

### 3.1 Packages and directories

```
packages/
  protocol/    @ergo/protocol    Protocol shared by daemon and frontends: frames, channel events, messages, cards (TypeBox); i18n runtime and language files
  daemon/      @ergo/daemon      The daemon: a steward that launches and manages agent child processes; event store, gateway, guard, tasks, plugin host
  web/         @ergo/web         Web UI: React 19 + Vite, hand-written CSS; a prototype with built-in sample data
  memory/      @ergo/memory      Memory engine: evidence, knowledge graph, reasoning graph, hybrid retrieval, nightly consolidation, a single write gate
  supervisor/  @ergo/supervisor  The service supervisor (command lsm): a separate small process hosting long-running services, autostart, watchdog, tunnels
frontend/
  harmony/     HarmonyOS app: a DevEco project; a native shell loading ergo's web UI
  android/     Android app: a Gradle project; a native shell loading ergo's web UI
config/        Config examples (ergo.example.json, watch-categories.example.json, mcp.example.json)
deploy/lsm/    Example supervisor entries (ergo-daemon, ergo-tunnel, ergo-asr)
docs/          User guide, developer guide, ADRs, memory system, research, guides
```

npm workspaces manage the packages. `frontend/` is not a workspace (the HarmonyOS project's ArkTS is not checked by the root tsc, oxlint or vitest; hvigor type-checks it when compiling).

### 3.2 Daemon modules (`packages/daemon/src/`)

| Directory / file | What it is |
|---|---|
| `main.ts`, `preflight.ts`, `stop.ts` | Entry: preflight checks (Windows only, Node version), then load the composition root; `stop.ts` is the supervisor's stop hook (verifies the pid file before ending the process) |
| `daemon.ts` | **Composition root**: reads config, opens the event store, creates the Job object, wires modules, installs plugins from the manifest, opens both ports; shutdown and failed startup share one reverse-order cleanup list |
| `config/` | Read-only config, the data directory layout (`dataDirLayout()`; modules get paths only from here), which env var holds which secret |
| `storage/` | A thin SQLite interface: all database access goes through it, so swapping drivers touches one file |
| `events/` | **Event store**: the event log is the single source of truth (`ergo.db`, WAL); derived views are projected from it |
| `gateway/`, `pairing/` | The two ports, HTTP API, WebSocket; device pairing and credentials |
| `guard/`, `guard-runtime/`, `approvals/`, `hand-over/` | **Guard**: a pure judging function (`judgeToolCall`); wiring into the runtime (live environment facts, approval cards, effect log, "hand it to me") |
| `agent-manager/`, `agent-host/`, `runtime/`, `process/` | Launching agent child processes (assembly, env, Job object, resource limits); host for the three maintainer kinds; the runtime layer (pi lives only in `runtime/agent-child/`); process utilities |
| `secretary/`, `maintainers/`, `conversation/` | The secretary (a resident child process), waking maintainers, conversations (derived views, input queues, rollback and branches) |
| `tasks/`, `sub-agents/`, `scheduled-jobs/`, `event-sources/`, `recovery/` | Tasks (plans, execution, stage acceptance, drift and thresholds, workflows), parallel sub-agents, scheduled and event triggers, recovery after being killed |
| `projects/`, `work-orders/`, `operations/`, `project-ops/`, `project-services/`, `scope-review/` | **The project system**: dossiers and standards, work-order dispatch, operations plans and APIs, project services (hosted by the supervisor), scope review. Outsiders may only import `projects/api.ts` |
| `cards/`, `inbox/`, `board/`, `activity/`, `ledger/` | Card types and the button loop, the inbox, the board as the secretary sees it, activity state, the token ledger |
| `plugins/`, `deletion/`, `data-sources/`, `components/` | Plugin host, deletion participant registry, data sources and the shared import folder, on-demand components and the downloader |
| `materials/`, `memory/`, `quick-actions/` | Materials store (verbatim copies, keyword and vector index), the memory plugin (nightly consolidation, memory curator, interviews), quick actions |
| `reminders/`, `calendar/`, `voice/`, `browsing/`, `claude-code/`, `google/`, `looki/`, `phone/` | Plugins (each has a `plugin.ts`; other modules only take things from its `api.ts`) |
| `scheduler/`, `workday/`, `backup/` | Scheduler with an injectable clock, internal jobs; the personal work calendar and holidays; backup, verification, restore |
| `web/`, `typed-shell/`, `skills/`, `mcp/`, `toolkit/`, `apps/` | Web tools, typed shell tools (git, builds…), skill library (`skills/change.ts`: the card for maintainers submitting skills, built like `mcp/change.ts`, with validation shared with imports in `library.ts`), MCP registry, toolkits, proxying local service pages |
| `prompts/`, `agent-settings/`, `model-settings/`, `assistant/`, `agent-roles/`, `i18n/` | System prompts (markdown files users can edit), each agent's ⚙ panel, model settings, the assistant's name, roles, i18n |
| `lsm/` | The supervisor link protocol (health and busy reports, graceful stop, owned services) |
| `deploy/`, `deploy-nginx.ts`, `restore.ts`, `run-backup.ts`, `download-model.ts` | Command-line tools: generate and deploy the nginx site, restore, back up, download models |

Web directories are listed in [6.1](#61-where-pages-come-from-prototype-and-online-demo).

## 4. Architecture

### 4.1 Two processes

| | The daemon (`packages/daemon`) | The supervisor (`packages/supervisor`) |
|---|---|---|
| Does | Everything ergo is | Hosts long-running services: launch, probe, restart when killed, logs, autostart list, public tunnels, tailnet entries |
| Lifecycle | Restarts the most (every merge, config change) | Small, stable, rarely restarted |
| Data | `~/.ergo` (`ERGO_DATA_DIR`) | `%LOCALAPPDATA%\ergo\supervisor` (`--data-dir` / `LSM_DATA_DIR`) |

The supervisor passes only an allowlist of env vars to the services it launches, not its own `--data-dir`, and no API reports that folder directly. The daemon's checkup reads the supervisor's registry, so when the supervisor isn't in its default location the ergo entry has to declare `LSM_DATA_DIR`. Entries written by `ergo start` include it; for hand-written ones see `deploy/lsm/ergo-daemon.example.yaml`.

They talk only over the **link protocol** (`packages/supervisor/docs/link-protocol.md`) and never import each other's code. After opening its ports the daemon connects out to the supervisor (if any of the four `LSM_*` env vars is missing it silently skips this, as in tests and manual runs), announces its capabilities, and its heartbeat reports health (`ok` / `degraded`) and **busy** (a task is executing, or any agent has a side-effecting call in flight), so "stop when idle" waits for that work. Services from projects that go live are registered over the protocol as the daemon's **owned services** and launched and hosted by the supervisor. ergo itself never starts long-running services.

### 4.2 The daemon is a steward; agents are child processes

- The daemon runs no models itself. The secretary, maintainers, sub-agents, reviewers and the memory curator are each a **child process** ([ADR-0002](adr/0002-one-process-per-agent.md)), launched by the agent manager into a Windows Job object (cleaned up together if the daemon exits), with only an allow-listed environment plus explicit injections; model keys go to the child over stdin, never via environment variables.
- Children run [pi](https://github.com/earendil-works/pi) ([ADR-0001](adr/0001-pi-coding-agent-sdk-as-runtime.md)). **pi appears only in `runtime/agent-child/`**; daemon and child speak ergo's own host protocol ([ADR-0004](adr/0004-agent-host-protocol-sdk-over-stdio.md)), and `test/pi-boundary.test.ts` guards the boundary. Claude Code is another runtime plugged in through the same host protocol.
- Every project and task has a fixed owner (maintainer) with its own context, toolkit and model ([ADR-0003](adr/0003-no-roles-toolkit-per-project.md)).

### 4.3 The event log is the single source of truth

- Domain state — approvals, tasks, plans, cards, inbox, ledger — consists of **events** appended to `db/ergo.db` (SQLite, WAL); UIs and modules read **derived views** projected from them. pi's session files are only the agent's context, not domain state.
- Frontends subscribe to **channels** over WebSocket (the secretary conversation, the board, the inbox, a maintainer's conversation…) and receive event streams; the frontend state layer is pure functions folding the stream into UI state (`packages/web/src/state/`).
- **Hard deletes** rewrite events rather than deleting rows: every event type that a delete might touch must register a rewriter, and deletes touching an unregistered type are refused entirely ([ADR-0008](adr/0008-purge-scope-and-session-rewrite.md)).
- The daemon is designed to be killed at any moment: on restart, work resumes by its rules, and side-effecting operations whose outcome is unknown go to the user to confirm rather than being silently redone (`recovery/`).

### 4.4 Gateway: two ports

Both ports listen only on `127.0.0.1`:

- **Local port** (default 8810), trusted automatically. Every HTTP request and WebSocket handshake checks that Host is `127.0.0.1:<port>` or `localhost:<port>` (against DNS rebinding) and that Origin, if present, is one of those (against cross-site requests); `Origin: null` is always rejected.
- **External port** (default 8811), the only target for tunnels, Tailscale and similar: it ignores source IP and Host and looks only at the device credential (cookie `__Host-ergo-device`). Without a valid credential only three things pass: the page itself (showing the pairing page), `/api/access`, and the pairing API; everything else gets 401. Endpoints added later are automatically behind this gate.
- `/healthz`: whether the secretary is running, the web UI is built, and enabled plugins loaded (a plugin that failed to load means `degraded`, still 200).
- `/fonts/`: fonts for the visual styles (credentials required on the external port too). The web UI makes no requests to external hosts at runtime.

### 4.5 Device pairing

- A new device `POST /api/pairing`s on the external port → a 6-digit code and an 8-hex-digit fingerprint (derived from a pairing cookie) → in one transaction a request event, a pairing request card and an inbox item → the user checks and approves locally (card button loop, first come first served) → the new device collects within 5 minutes → a 256-bit random credential is generated (only its hash is stored), and the raw value appears only in that one response.
- At most 5 requests per source per 10 minutes; pending requests expire after 5 minutes; a collected credential that is never used within 24 hours is voided (guarding against "ghost devices" whose response was lost); once used it lasts 365 days, extended on use.
- Requests that look automated (headless browsers, command-line tools, crawler user agents) are flagged on the card; the rules don't change.
- Revoking a device immediately closes its open WebSockets.

### 4.6 The guard

`judgeToolCall(input)` in `packages/daemon/src/guard/` is a **pure function**: it reads no files, runs no commands, looks at no clock or environment (`test/guard/judge-basics.test.ts` scans the source), and the same input always yields the same verdict. Its caller (`guard-runtime/`) gathers live environment facts (does the file exist, real paths, git state…) and passes them in.

- **Input**: the call; which agent (working directory, toolkit); data directory areas and protected areas; the task's plan (grants, task-specific watch categories, each stage's temporal rules); the effect log (successful calls only); global watch-category settings; environment facts.
- **Verdict**: which watch categories match, the strictest of six handlings (just do it and log / do it and tell me / only if in the plan / ask me first / hand it to me / never), whether it's within a grant, which temporal rules it violates; every reason is written in plain words and stored in the tool-call detail.
- **Three hard bottom lines** nobody can override: never write ergo's own config area, database area or program directory; never read the secrets area; never send something known to be a secret.
- Anything that cannot be judged (missing facts, arguments that can't be normalized…) is "ask me first".
- **Authorized folders** (`GuardInput.authorizedFolders`, re-read by the caller on every judgement): reading files inside doesn't count as leaving the project directory, and plan conformance doesn't count it as out of bounds either. Reading only, compared by real path; no real path means it doesn't count; the data directory, protected areas, secret files, running scripts, git, `cd` and bash paths written with `..` don't count ([ADR-0041](adr/0041-authorized-folders-read-only-in-guard.md), Chinese).
- **With the network switch off, reaching only this machine doesn't count as network**: curl sending only to `127.0.0.1`, `localhost` or `::1` (Ergo's own ports don't count as local); scripts using libraries that can stay local (`socket`, `urllib`, `http.server`, `fetch`) whose addresses are all local (`localOnly` in `guard-runtime/script-scan.ts`). Processes started by bash have those hosts in `NO_PROXY` (`process/child-env.ts`). Addresses coming from arguments or environment variables can't be seen: this layer is best effort anyway.
- Defaults follow "features first, security later" ([ADR-0026](adr/0026-features-first-security-later.md)); new installs tighten two of them (see the [User Guide](user-guide.en.md#32-doing-it-without-the-wizard)).

#### Temporal rules

Rules like "back up before deleting", "run tests before pushing", "never send anything out after reading a secret" use a format compatible with planguard and run on its engine unchanged ([ADR-0005](adr/0005-temporal-rules-planguard-engine.md)):

- Four shapes: `before` (A must have happened before B), `not_before` (A must not have happened before B), `check` (a condition must hold now), and no `require` (always forbidden).
- "Before" looks only at the effect log (blocked or failed calls don't count); within a task, the same task; outside tasks, the same agent and conversation segment. Calls split out of one bash command are ordered by what can really run first (in `a && b`, a is before b).
- On violation: `pull_back` sends the agent back to fix it itself (no user prompt; counts as a pull-back), `block` means never, `confirm` or nothing means ask me first.
- What rules can use (`$current`, `$prior`, `$facts`, `$agent`, `$task`, `$now`, plus the `path_within` extension) is documented at the top of `guard/rule-validation.ts`; field tables live next to the code that builds them (`rule-steps.ts`, `rule-env.ts`). A malformed rule is rejected when the plan is saved.

### 4.7 Deletion participant registry

Deleting a project, a task, a plugin's data (and deleting a person from personal files) all go through one registry (`deletion/participants.ts`). Deletion code only stops things, re-checks, commits and removes files; which events are rewritten and how is decided by **registered participants**:

- `deletionKind<S>(id)` defines a kind of deletion (`PROJECT_DELETION`, `TASK_DELETION`, `PLUGIN_DATA_DELETION`…) carrying what is being deleted; `participants.register(kind, { owner, join(subject, plan) })` registers and returns an undo function.
- Steps in order: `scope` (define the scope) → `claim` (replace whole events with a deleted marker, replace payloads, rewrite fields with registered rewriters; drop or rewrite whole cards; append events in the same transaction; work to do after commit) → `follow` (for participants that need to see which cards others claimed) → the registry collects cards and does field-level rewrites (**an event type without a registered rewriter throws here and the whole deletion is refused**) → `settle` (for participants that need the full rewrite list).
- **Adding a new event type that belongs to a project / task**: register a participant that claims it in the owning module and register its rewriter; deletion code needn't change. **A new module needing a new kind of deletion**: define a `deletionKind`, register participants, and call `participants.plan(kind, subject, context)`. See `test/deletion/participants.test.ts`.

### 4.8 Proxying local service pages

Project services run on `127.0.0.1:<port>`, which a phone can't reach. The daemon proxies by path: `/apps/<app name>/…` → `http://127.0.0.1:<port>/…` (`apps/`), and the built-in browser opens that address.

- **Only registered apps are proxied** (`AppRegistry.register({ name, target, title?, prefix? })`); it is not an open proxy: `target` must be a local address, host and port only. The kernel registers project services when they go live; plugins use `ctx.apps.register`.
- Authentication is the same as ergo's own pages: local port trusted, external port requires a device credential; ergo's own cookies (`__Host-ergo-*`) are never forwarded to services, and services cannot set them. Host, Origin, `Location` and `Set-Cookie` paths are rewritten, frame-blocking headers removed; streaming responses and WebSockets pass through.
- **Prefix convention** (for service authors): to the browser a service lives under `/apps/<app name>/`. By default (`prefix: "strip"`) the prefix is stripped, the service thinks it's at the root, and its pages must **use only relative URLs** (`fetch("api/items")`, not `/api/items` — a leading `/` hits ergo's own root). For absolute URLs read the `ERGO_BASE_PATH` env var or the `X-Forwarded-Prefix` header. Frameworks with their own base path (Vite `base`, Next `basePath`…) set it to `ERGO_BASE_PATH` and register with `prefix: "keep"`. Don't hard-code local addresses; don't use `__Host-` cookies in services. `npm run check:app-prefix` fetches the service's home page and lists URLs outside the prefix.
- **Known trade-off of same-origin proxying (not fixed)**: service pages run on ergo's origin, so their scripts can call ergo's API with the user's device credential (it's HttpOnly, so unreadable, but usable). Following "features first, security later", only services built by maintainers and approved by the user to go live are proxied; the plan is to move them to separate origins (own port or subdomain, own pairing or short-lived proxy tokens). See [SECURITY.md](../SECURITY.md).

### 4.9 The memory system

- **Materials**: the kernel's materials store collects the user's verbatim words (plus voice transcripts, avoidance signals…) from the event log, keeps immutable copies and builds keyword and vector indexes (`db/materials.db`). Agent voices don't count: when the secretary relays an owner's update as voice (`AgentVoiceRecord.parts`, ticket 354), the text stays on the voice object, the owner's part counts as the owner's words, and it never becomes a material or the secretary's own conclusion.
- **The memory plugin** (`memory/plugin.ts`): at 03:00 an internal job wakes the **memory curator** (an on-demand agent), which uses the `@ergo/memory` engine to turn new materials into evidence and consolidate it into the reasoning store `memory/subtext/rg.db` (conclusions, evidence chains, competing explanations, predictions, a question box), with at most `memory.maxModelCalls` model calls per night; all writes go through a single write gate ([ADR-0030](adr/0030-memory-keeper-maintains-reasoning-graph-through-write-gate.md)).
- The secretary gets a brief each time it wakes and a memory brief whenever the user's message touches relevant memories, and can "ask memory" on demand; deep discussion and edits are routed to the curator.
- Some `memory.*` switches in the config (e.g. per-context tags for emotion, finance, relationships, location) are placeholders for now: setting them does not change behavior; defaults live only in `config/config.ts`.
- Details: [memory system overview](memory-system.md), [memory engine architecture](memory-architecture.md), [vocabulary](memory-vocabulary.md), [ADR-0032](adr/0032-memory-reasoning-rules.md) (all in Chinese).

#### Degradation, acceptance and rollback

- **Degradation** (all four are tested): **no embedding model** — consolidation runs anyway, materials search falls back to keywords and says so; **consolidation model unavailable** (no key, failed requests) — the night is recorded as "skipped" (no key: no store built, nothing spent) or "failed" (reason in the record, plus an inbox item); no material is lost and the next night continues; **`rg.db` can't be opened or its version doesn't match** — no automatic migration, a "rebuild the reasoning store" notice is recorded, materials search keeps working, briefs are empty and "ask memory" answers "memory isn't ready yet"; **a crash mid-consolidation** — evidence and facts already written are kept, and the next night continues incrementally.
- **Switches**: `memory.enabled: false` only skips consolidation and store building (materials search and briefs keep working) — not the same as disabling the memory plugin; `memory.extractor: "rule"` extracts facts with rules (no model calls; a fallback only); `memory.nightlyTimeoutMinutes` caps each night's run (default 60).
- **Read-only acceptance**: `npm run memory:acceptance [-- --data-dir <dir>]` checks that `rg.db` opens with the right versions, shows the latest consolidation record, computes a brief and runs a search on a snapshot copy of the materials store. It changes nothing, never prints raw materials, and exits 1 if any check fails.
- **Offline consolidation** `npm run memory:build` (`--rebuild` to start over, `--max-model-calls <n>`) and **full re-judging** `npm run memory:rejudge` (re-evaluates all existing conclusions after the rules change; `--max-yuan` caps the spend, a snapshot is saved first, `--undo <report>` restores it): both require the daemon to be stopped and write only `memory/subtext/rg.db` (since 338 it lives in the memory plugin's own data directory, `dataDirLayout().rgDb`).
- **Rollback**: to just stop consolidation, disable "Memory" in Settings · Plugins (`rg.db` is kept, the materials store untouched); to rebuild the reasoning store from materials, stop the daemon → delete `memory/subtext/rg.db*` in the data directory (materials and verbatim copies stay; `rg.db` holds no raw text) → start the daemon → click "consolidate now" or wait for 03:00 (a first build may take several nights within the nightly budget) → confirm with `npm run memory:acceptance`.

#### The memory plugin interface (Subtext / 会意)

The memory system is a replaceable **plugin**, and only one runs at a time. The interface lives in `packages/protocol/src/memory-provider.ts` (types only); the host lives in `packages/daemon/src/memory/provider/host.ts`:

- **Core methods** every memory system needs: `info()`, `start()`/`stop()`, `observe()` (feed one piece of raw material), `remember()` (store verbatim what the user asked you to remember), `search()` (returns the unified `MemoryItem`, **always with sources**), `forget()` (by item / source / time range / all — this is what privacy deletion relies on), `health()`.
- **Optional capabilities** declared in `capabilities`; the host uses them to decide behaviour and UI: `brief` (per-turn brief; if absent the host builds a default one from `search`), `consolidate` (its own consolidation), `settings` (setting declarations the host renders), `tabs` (which tabs the memory page has), `tools` (extra tools), `subject`/`timeline`/`graph` (profile, timeline, relationship graph).
- **Host rules**: only one provider runs at a time (`activate` stops the old one first); each plugin owns `<data dir>/memory/<id>/` and the core only copies/restores/migrates that whole directory without parsing it; plugins may not talk to models or open ports themselves — they use the host's `llm()`/`embed()`; a mismatched `api` version is refused.
- **The built-in one is "Subtext" (会意, id `subtext`)**: conclusions, evidence chains, competing explanations and a prediction ledger (section 4.9). Its implementation is `packages/daemon/src/memory/provider/subtext.ts`; the engine is still `@ergo/memory`, and the store lives in its own data directory, `<data dir>/memory/subtext/rg.db` (moved from `db/rg.db` by 338). In the UI it is called **Memory Module · Subtext** and marked **Experimental** (`pages.memory.*` in `packages/web/src/plugins/memory/system.ts`; the navigation entry still says "Memory"), so a different memory system plugged in later changes those strings too.
- **Adding another memory system**: implement `MemoryProvider`, register a factory (with `api`/`id`/`name`/`capabilities`/`requirements`), set `memory.provider` to its id. The two fake providers under `packages/daemon/test/memory/provider/` are the smallest example (test-only; they prove that swapping is easy).

### 4.10 Data directory and config

- Modules get paths only from `dataDirLayout()` in `config/data-dir.ts`, never by joining strings themselves. The two databases in the db area (`ergo.db`, `materials.db`) go into the nightly snapshot (consistent copies via `VACUUM INTO`), and the reasoning store `memory/subtext/rg.db` lives in the plugin's own data directory and follows the whole directory into the snapshot; `secrets`, `tmp`, `backups`, `models`, `cache`, `components` and `imports` are excluded.
- Config is read-only and missing items take defaults; **each threshold's default is defined once, in its own module** (`tasks/thresholds.ts`, `reminders/thresholds.ts`, `scheduled-jobs/thresholds.ts`, `event-sources/thresholds.ts`…); config files only list what changes.
- Files are always written to a temporary file and then renamed, via `util/atomic-file.ts` ([Section 9](#9-coding-conventions)).

### 4.11 Model providers

Models are called on the daemon's computer; the web page only holds settings. Providers are a **registry table** (`MODEL_PROVIDERS` in `model-settings/providers.ts`) that drives the settings page, the connection test, where keys live and the default used when there is no settings file (why there is only DeepSeek plus one custom OpenAI-compatible provider is [ADR-0037](adr/0037-configurable-model-provider.md), in Chinese).

| Field | Meaning |
|---|---|
| `id` | The provider id in pi's model catalog, the first half of "provider/model id" (`modelKeyOf`), and the key in `credentials` |
| `label` | Name on the settings page. Translated ones are written as a getter (`get label() { return t("…") }`); never call `t()` at module top level |
| `keyEnv` | Which environment variable the daemon reads the key from (`modelCredentials` in `config/secrets.ts` reads by it, keyed by `id`) |
| `secretFile` | Which file in the data directory's secrets area the supervisor (LSM) injects the key from (relative to the data directory); a key entered on the web page is written to the same file |
| `defaultModelId` | Default model when there is no settings file. Empty for the custom provider — the model id is whatever the user typed, and nothing may use it as a default |

There are two entries today and **the first one is the default**: `deepseek` (`DEEPSEEK_API_KEY` / `secrets/deepseek-api-key.txt` / `deepseek-flash`) and `custom` (`CUSTOM_MODEL_API_KEY` / `secrets/custom-model-api-key.txt` / empty). `DEFAULT_MODEL_SETTINGS` is `MODEL_PROVIDERS[0]` plus thinking level `high`, and `providerOf(settings.provider) ?? MODEL_PROVIDERS[0]` appears all over `model-settings.ts`, so "the first entry is the default" must not be broken.

**Registering the custom provider in a child process.** pi's model catalog does not contain `custom`; without registration `getModel("custom", modelId)` is always `undefined` (the session won't start and the connection test says "not in the model catalog"). Registration happens in exactly one place:

- `customProviderConfig()` in `runtime/agent-child/custom-provider.ts` builds that `ProviderConfig` (`name` is `custom`, `baseUrl` trimmed of trailing slashes, `api` defaulting to `openai-completions`, and a single entry in `models`: the id the user typed). Model metadata cannot be entered by the user, so it is fixed by estimate: `input: ["text"]`, `reasoning: false`, `contextWindow: 128_000`, `maxTokens: 8192`, all `cost` fields 0 (the ledger still records real usage; costs for such a model are rough estimates on the usage page). Those two limits are defined only in `custom-provider.ts`.
- `registerCustomProvider(modelRuntime, custom)` is called from exactly four child-process entry points: `session.ts` (opening a session), `probe.ts` (model probing: catalog lookup and connection test), `recorded-generation.ts`, and `translate.ts` (translating slash-command descriptions). It **must run before `setRuntimeApiKey`** — only after registering does `getModel` know the model, and the key goes in through the following `setRuntimeApiKey` call into pi's in-memory credentials; the other order reports "no such provider".
- Metadata lives in those two functions only. Do not build a `ProviderConfig` anywhere else, and keep to the pi boundary (`pi-boundary.test.ts`: `@earendil-works/*` only under `runtime/agent-child/`).

**The assembly field `SessionAssembly.custom`** (`runtime/host-protocol.ts`): `{ baseUrl, modelId, api? }`, and it is **absent** (not an empty object) when the custom provider is not selected. It contains no key — the key stays in `credentials` (under `custom`) and reaches the child over stdin. The same block also appears in three other requests: `ModelProbeRequest`'s `{ type: "catalog", custom? }` and `{ type: "ping", custom? }`, and `TranslationRequest.custom`. The daemon has a single source for it: `ModelSettingsService.customProvider()` (only when `custom` is selected; a copy of `settings.custom`), handed to the agent manager by the composition root (`customProvider: () => modelSettings.customProvider()`). While `custom` is selected, **every agent's model id becomes `custom.modelId`** (thinking levels still come from each row), because the provider has a single model — that happens in `effectiveChoiceOf`; the ids in `default` and the per-agent overrides are only what is used after switching back to DeepSeek.

**The two endpoints.** Both live with the rest of the settings, and the key never enters a request body nor comes back in a response:

| Endpoint | Request | Response |
|---|---|---|
| `POST /api/model-settings/custom-models` | `{ baseUrl? }` (falls back to the one saved in settings) | `{ ok, models: [{ id, name?, ownedBy? }], error? }` |
| `POST /api/model-settings/test` | `{ modelId?, custom? }` (`custom` tests that copy — for trying before the page is saved; omitted means what is saved) | `{ ok, modelId, firstTokenMs?, totalMs, error? }` |

- Listing models is a single `GET {baseUrl}/models` from the daemon with `Authorization: Bearer <key>` (the key is **always the custom provider's**: even when DeepSeek is still the selected provider, the DeepSeek key is never sent to the address in the request), a 15-second timeout, at most `CUSTOM_MODELS_MAX` (500) entries; it accepts `{ data: [{ id, name?, owned_by? }] }` and also a bare array. **Failing to list is not an error**: it still returns 200 with `ok: false` and an `error` explaining why, with any key material stripped.
- The connection test keeps the existing route — a one-shot child process that registers the provider and sends a very short request; only one runs at a time and a second one gets 409 ("the previous one hasn't finished").
- The `custom` block in the settings file may stay while `provider` is not `custom` (switching back to DeepSeek does not clear it); if `POST /api/model-settings` omits `custom`, the saved one is kept. `checkModelCustom()` (`packages/protocol/src/model-settings.ts`) is the only place that validates it: the URL must be http(s), the model id may not be blank, trailing slashes are trimmed; `custom` selected without that block is treated as an unreadable settings file.

**To add another vendor preset, change this:**

1. Add a row to `MODEL_PROVIDERS` in `model-settings/providers.ts`: `id`, `label` (wrap in `t("modelSettings.provider.<id>")` if it should be translated, in both locale files), `keyEnv`, `secretFile`, `defaultModelId`.
2. Add an entry under `env:` in `deploy/lsm/ergo-daemon.example.yaml` — `{ name: <keyEnv>, from: file, path: <home>\.ergo\secrets\<file>, optional: true }` — otherwise the supervisor will not inject the key (a key entered on the web page works until the daemon restarts).
3. If pi's model catalog already has that vendor, nothing changes in the child process; if not, register it under `runtime/agent-child/` the way `custom-provider.ts` does (`ProviderConfig` may only be built in that layer).
4. The settings page, the key block, the connection test and model listing all read the table, so they need no changes; extend `test/model-custom-provider.test.ts` (the fake OpenAI-compatible service is `test/helpers/fake-openai.ts`, no network).

**What this layer deliberately does not cover**: the nightly memory consolidation (`memory/nightly-job.ts` builds `DeepSeekChat` from `DEEPSEEK_API_KEY`), web search and page reading (`web/deepseek.ts` is a DeepSeek-proprietary API), and the token price table (`packages/protocol/src/token-prices.ts` knows only DeepSeek). They stay DeepSeek-only even after switching to a custom provider — when touching them, take the key from the `deepseek` row's `keyEnv` / `secretFile` (or `deepseekKey()` in `config/secrets.ts`) instead of "the currently selected provider".

### 4.12 The install chain

After downloading, verifying and extracting, `install.ps1` writes `current` → fills `bin` → adds to PATH → runs `ergo svc install-autostart` (`ergo svc` passes through to lsm, with `LSM_DATA_DIR`) → runs `ergo onboard` (`ergo start` plus a line pointing at the wizard) → prints a summary. Only a failure before `current` is written fails the install (exit code 1, the version in use unchanged); each later step that fails is reported, the rest still runs, exit code 0. Switches: `-NoAutostart`, `-NoStart` (older name `-NoOnboard`); environment variables for `irm | iex`.

Three things bring ergo up at login, and they belong to different owners:

| | Where | Who writes it | On a version switch |
|---|---|---|---|
| Scheduled task `LocalServiceManager` | Hard-codes that version's `node.exe` and `lsm.mjs`, and `--data-dir` | The installer registers it by default (`supervisor/src/autostart.mjs`) | `syncAutostart` checks and re-registers |
| Autostart list `registry/autostart.yaml` | The supervisor's data directory | The first `ergo start` writes one with only `ergo-daemon` (`wx`: never touched once it exists); after that it belongs to the supervisor (web UI, `lsm autostart`) | Untouched |
| ergo's entry `registry/services/ergo-daemon.yaml` | The supervisor's data directory | Rewritten for the current version by every `ergo start` | Rewritten |

`syncAutostart` (`cli/service.ts`) only acts on installed copies, and is called from `ensureSvc` (`start`, `restart`) and `switchTo` (`update`, `rollback`): no task means nothing is created (the user removed it); a task pointing outside the install folder is left alone (the user's own supervisor; same rule as `ergo uninstall` and the installer); only a task pointing at another version in the install folder is re-registered; a failure is reported in one line. The `switchTo` process still runs on the old version (the launcher finds the version folder through `current`), so after switching, the entry, the supervisor and the task must all use the new version's context (`contextOfVersion`).

At login the supervisor decides "new login session" with `bootPlan`, comparing the previous `sessionEpoch` in its ledger: the first start has no record and counts as not a boot. So after a `-NoStart` install, restarting before ever running `ergo start` doesn't bring ergo up (there's no entry or list yet either); the User Guide says so.

Known and unsolved: a supervisor started by the autostart task wasn't started by `ergo` (`managerPid` in `install.json` doesn't match), so `switchTo` doesn't restart it; after an update that process runs the old version's code until the next login. It occupies the old version folder, which `pruneVersions` leaves for next time when it can't be deleted.

### 4.13 Components and long-running services (speech synthesis, speech recognition)

The component service (`components/service.ts`) only downloads, verifies, swaps in and deletes. Anything that must be connected after installing (a long-running service) goes through the `components/host.ts` interface; today's implementation is `audiocpp-host.ts` (ADR-0038, ADR-0039):

- **Manifest fields**: `license` (name, one sentence, link, `confirm`, `revision`, `attribution`), `recommended`, `slowWithoutGpu`; `service` (program component: its name in the supervisor, program file name, port, health check), `serve` (model component: which program loads it, the model id on the service, family, task, mode, model file). `extract.format` gained `zip` (`components/zip.ts`, no dependencies), and `extract.beside` puts a package's files next to a given program (the runtime next to the program, wherever it sits in its package).
- **The package layout is unverified**: after extracting and before swapping in, `service.program` is looked up by file name, and nothing is swapped in if it's missing; `variant.expects` lists files that should sit next to the program (with `*`), and missing ones go into `service.warning`, which warns but never blocks starting.
- **Failed downloads**: `ComponentView.manualDownload` lists the files still needed and their links (only when a download failed or is paused); once downloaded, they go through the existing `POST /api/component-import`.
- **Adding another model**: write one more component with `serve` and a `dependsOn` on the program; generating the config and restarting need no code. For speech synthesis the model id follows `voice.speech.model`.
- **The speech recognition model** (`serve.task` is `asr`, ticket 346): one more layer, `components/recognizer-link.ts`. Only once the service is connected (`connect` succeeded) does it write `audiocpp` to `voice.recognizer.mode` and have the voice plugin switch on the spot through `VoiceApi.useRecognizer`; removing the model removes that entry. If the user set up their own (`probes.provided("voice-recognizer")`: `lsm`, a hand-written `audiocpp`, a Python path in the config, or the default `python` really having faster-whisper), nothing is written and it can't be installed.
- **Connecting recognition**: `voice/recognizer-audiocpp.ts` implements `Recognizer`. It shares the state machine `createServiceRecognizer` with the LSM one (`recognizer-client.ts`); what differs sits behind `ServiceProtocol`. Switching needs no restart: everyone holds the one from `recognizer-switch.ts`; on a switch the old one closes and `warmup.recognizerChanged()` clears the backoff and warms the new one. The service only takes WAV: `VoiceModelsView.recognizerInput` tells the web page to convert first (`finishTake` in `app/voice-browser.ts`; push-to-talk, Debug and the floating button all share `VoiceRecorder`), and anything else that arrives goes through ffmpeg in `audio-convert.ts`. Interface details found by trying the real service are at the top of `recognizer-audiocpp.ts`.
- **Connecting**: `server.json` (under `components/audiocpp-service/`, not the program directory, which is replaced whole on update) → `services.put` → `start` / `restart` → wait for `GET /health` → `autostart`. A failed step rolls back, and the result goes into `ComponentView.service` (`idle` / `starting` / `running` / `stopped` / `failed`) rather than being thrown at the download queue.
- **"Ours" means `server.json` exists**: with it, we connected this service; without it, someone on the port, a config pointing elsewhere or a registration conflict all count as the user's own setup (`provided: voice-speech` asks `host.provided()`) and are never overwritten. The protocol can't touch services hand-written in the registry, and a stopped hand-written service only shows up as `port-conflict`, so clicking Install does a dry-run `put`.
- **License**: `ComponentActionBody.licenseAccepted`; without it the answer is 400. Confirmations are kept in `licenses.json` in the components area.
- **Web**: `POST /api/components/<id>` gained `start` and `stop`; `GET /api/components` calls `refresh()` first, which probes the port. In the prototype, `?demo-tts=missing|installing|running|stopped|failed|manual|download-failed|runtime-missing`, `?demo-asr=missing|installing|running|configured|external` and `?demo-gpu=none` show the states.
- **Update check** (`components/update-check.ts`, ticket 347, ADR-0042): `createUpdateChecker` fetches `components-manifest.json` and its signature from the release page, verifies them with the release public key and keeps them in the components area. `Components.checkUpdates()` puts entries newer than the shipped ones into `offered` (`release` greater than the shipped one, different version), and `view().updates` gives the address, the last result and the components with a new version. The `byId` entry in use stays as it is: what to download and show comes from `goalOf(c)`, and only a successful `commit` calls `adopt`, which also records the entry in `installed.json` (`entry`, `entryRelease`; used after a restart only if newer than the shipped one). The nightly job and the to-do reminder are `createComponentUpdateJob` (`component_update_available`, once per version, archived once replaced). API: `POST /api/components {"action":"check_updates"}`, answered when the check ends, 200 even if it failed. If the release page doesn't have the list yet (a 404 on the list itself), that's `updates.notPublished`, not a failed check. At release time `stageVersion` writes the version into the manifest's `release`, and `build/release.ts` puts the manifest and signature in the release folder. In the prototype, `?demo-updates=available|failed|not-published`.

Tests: `test/components/audiocpp-host.test.ts` (the real `lsm/link.ts` + the LSM stand-in + a fake download site + a fake speech service on a port the system picks), `test/voice/recognizer-audiocpp.test.ts` (a fake audio.cpp, `helpers/fake-audiocpp-asr.ts`, with errors written from what the real service does), `test/components/recognizer-link.test.ts` (existing setups checked byte for byte) and `test/main/components.test.ts` (the real daemon from install to a voice message); never touches 8090.

**The wizard's capabilities step** (`pages/more/CapabilitiesStep.tsx`, pure logic in `app/setup-capabilities.ts`) has no API of its own: components use `GET /api/components` and `POST /api/components/<id>`, plugins use `GET /api/plugins` and `POST /api/plugins/<name>`. What's ticked by default comes from the component's `wanted`, with no second list; among stopped plugins only memory is ticked (`DEFAULT_ON_PLUGINS`). In `SETUP_STEPS` the step replaced the old "components" one. It has no condition (`NO_CONDITION` in `setup-state.ts`): it counts as done only after the user has seen it. So the config's `setup.format` went up to 2: format 1 was written by earlier versions. The first startup after the upgrade evaluates it once with the old rule (the third step looks at the embedding model). If the wizard was finished then, the capabilities step counts as seen, so the banner doesn't return; if not, the step still has to be seen. Either way format 2 is written back, so this runs only once. New data directories are format 2 from the start. The start-at-boot switch is `lsm/autostart-switch.ts` (`GET / PUT /api/autostart`). It uses `runTaskCommand` in `cli/autostart.ts`, which like `runLsm` goes through `interceptTaskCommand` first; it only touches a task that belongs to this install, and a source run only shows the state. In the prototype, `?demo-bge=missing|failed`, `?demo-fail=<component id>`, `?demo-autostart=off|elsewhere|dev`. The end-to-end test `test/main/setup-capabilities.browser.test.ts` needs `npm run build:web` first.

### 4.14 Project services reporting events

When a project's own service finds something that matters, it reports an event that wakes the task in the operations plan waiting for it (ADR-0043, ticket 357).

- **API**: `POST /api/service-events` (local port only; `gateway.ts` refuses it on the external port right away, even with a device credential). Header `Authorization: Bearer <ERGO_SERVICE_TOKEN>`, body `{ "event": "<event name>", "data": <any JSON, optional> }` (`ServiceEventBody`). On success it returns 202 and `{ ok, event, runs: [{ taskId, runId, merged }] }` without waiting for the maintainer. Errors use the usual `{ code, message }`: 401 credential missing, wrong or revoked; 400 bad body; 404 nothing waits for this name (`message` lists the names you can report); 409 the waiting task is paused; 413 data too large; 429 over this service's rate limit; 403 external port.
- **Command**: `ergo notify <event name> [--data <JSON>]` (`cli/notify.ts`) reads `ERGO_NOTIFY_URL` and `ERGO_SERVICE_TOKEN`. Exit codes: 0 reported, 1 refused, 2 wrong usage (including missing environment variables), 3 can't connect. In development: `npm run ergo -- notify <event name>`. A `git clone` has no `ergo` command and the service manager's `PATH` is a snapshot from when it started, so the instructions tell service code to prefer the request.
- **Source**: `event-sources/service.ts` (`service` in the registry, one event `reported`, the name in the `name` filter, `planOnly`) only tracks who is waiting and hands the event over through `triggers.ts` → `ScheduledJobs.fire`; queue merging and auto-pause are reused. `DeliveringContext.deliver` is `emit` that also tells the source whether delivery worked.
- **Ops layer**: `project-services/service-events.ts` owns credentials (`secrets/service-tokens/<app name>.token`; only a digest stays in memory), the rate and size limits (`event-sources/thresholds.ts`, config `eventSources.serviceReportsPerMinute` and `serviceDataMaxBytes`), recent events (`event-sources/service-events.json`, `SERVICE_EVENTS_KEPT` per service, no data) and the maintainer's `recent_service_events`. `bringUp` in `project-services.ts` issues a credential if there is none and restarts a running service that got a new one; a withdrawing `service_desired` revokes it as soon as it is committed; deleting the project removes both. When a rollout is recorded as failed but the supervisor reports the service online (`heal`, ticket 363), and the user hasn't switched it off and the project is in use, the service is registered again in full and goes back to live (`service_rollout` with `heal`, no notice); one missing a credential or with a changed definition is restarted once. These services don't take the re-registration on connect (`resync` only covers live ones), so this is where they get their credential. When a start reports `already-running`, `health-check.ts` looks first: if the service really is running it isn't a failure.
- **Where the data goes**: only `JobRun.events` (rewritten when the project is deleted). `eventsBlock` in `scheduled-jobs/texts.ts` marks it as data, not instructions, when it is handed to the agent. No material source reads it, so it stays out of memory.
- **Instructions for maintainers**: the "woken by a service" passage in `prompts/project-maintainer.md` (the full recipe) and the means descriptions in `operations/builtin-means.ts` and `project-services/means.ts` (the fields). Change them together.
- **Notices when a service has trouble**: failed to go live, went down, recovered and failed prefix checks are all marked `chatOnly` (`MessageEventPayload`): they stay out of work order segments and wait for a chat segment once the maintainer is free (`accepts` in `work-orders/segments.ts`), so an alarm run isn't interrupted and `propose_operations` is actually there. The notice carries the service manager's reason and the health check address, and asks the maintainer to check for itself first.
- **Tests**: `test/main/grow-frictions.test.ts` (trouble notices don't interrupt an alarm), `test/main/service-events.test.ts` (fake LSM, faux maintainer), `test/main/service-events-real.test.ts` (real service manager, real child process, real command), `test/cli/notify.test.ts`, `test/build/stage.test.ts` (run from a version directory).

## 5. Plugins

The daemon is split into a **kernel** and **plugins** ([ADR-0027](adr/0027-plugin-host-kernel-and-agent-contributions.md)): the kernel (event log, task execution with the guard, host protocol, gateway…) is wired by hand in the composition root; plugins are installed from the manifest `plugins/manifest.ts` via the plugin host `plugins/host.ts`, and the composition root never names a plugin. A feature plugin = a daemon plugin + a web plugin of the same name, enabled and disabled together; users can hot-plug them under Settings · Plugins.

**To write a plugin, follow [docs/guides/plugin-development.md](guides/plugin-development.md)** (in Chinese): it starts from a minimal "notes" plugin and walks through the three parts (in the daemon, for the agents, on the web), dependencies and boundaries, data contracts and "delete with data", hot-plugging, i18n, testing and shipping; its code excerpts and names are checked against the code by `test/plugins/plugin-guide-doc.test.ts`. When an agent writes plugins, use the skill `.claude/skills/ergo-plugin/SKILL.md` (a checklist). Below is a reference for the host itself.

### 5.1 What a plugin can register

During setup a plugin receives a `PluginContext`; every `register` returns an undo function and is recorded under the plugin's name, and the host undoes them in reverse order when the plugin is disabled:

| Registration | Goes into | On undo |
|---|---|---|
| `cardTypes.register` | Card types (`cards/registry.ts`) | Only its own registration is removed |
| `purge.register` / `purge.registerQuotes` | Hard-delete rewriters and quotes | This registration is removed |
| `quickActions.register` | Quick actions | Only its own |
| `internalJobs.register` | Internal jobs (below) | Timer cancelled; a run in progress finishes and is recorded |
| `boardKinds.register` | Board kinds | The secretary's board no longer lists it |
| `eventSubscribers.register` | Event-trigger subscribers | Events no longer go to it |
| `apps.register` | The proxy registry ([4.8](#48-proxying-local-service-pages)) | 404 from then on; open pipes are closed |
| `register` on `agent.tools` / `agent.context` / `agent.hooks` / `agent.notes` | Tools for agents, per-turn context blocks, hooks, input notes | Agents assembled afterwards no longer get it; the resident secretary reassembles after its current message |
| `effect(execute)` | Timers, subscriptions and the like: run it and keep its undo | Its undo is called |
| `lifecycle({ start, stop })` | The plugin's own start / stop | `stop` is called (first) |
| `provide(key, value)` | A service the plugin provides | Removed; others get `undefined` |

Views and system-prompt fragments are declared in the definition. **Data contracts** (`contracts`: card types, rewriters, material sources, frontend requests, what to delete on removal) stay registered even when the plugin is disabled — events it wrote earlier must still be purgeable and still collectable as materials.

**Dependencies** are typed services (`serviceKey<T>(name)`): `needs` is required (the host orders installation by it; a plugin whose needs are unmet isn't installed, with the reason in the startup log and `/healthz`), `wants` is optional (fetch it live with `ctx.optional(key)`, don't store it). Kernel modules that need something from a plugin import only its `api.ts` (boundary tests enforce this).

**When disabled**: by config (`plugins.disabled`, effective after restart) or at runtime (disable / enable / remove in Settings · Plugins, effective immediately). All its registrations are undone and its views become dormant (tables kept but no longer updated; rebuilt from the event log when re-enabled); its past items in chats and the inbox show as one line "(plugin X is not enabled; this item can't be shown for now)"; calling its tools mid-turn returns "plugin X is not enabled". Removal can also hard-delete its data (as declared with `removal.declare`).

### 5.2 Plugin internal jobs

`ctx.internalJobs.register({ name, schedule, run })`: work the daemon does on a schedule, on its own scheduler rather than Windows scheduled tasks.

- `schedule` uses the same time rules as reminders (e.g. `{ kind: "daily", time: "03:00" }`), plus `{ kind: "every", minutes }` (counted from the end of the previous run).
- `run(trigger, signal)`: `trigger` says whether it's on time (`scheduled`) or catching up a missed run at startup (`catch_up`); `signal` fires when the daemon stops and the job should stop quickly (throwing `AbortError` counts as not run, so it catches up next start).
- A job's own errors only go to the log, and it is rescheduled as usual; to make an error visible, write it to the inbox yourself.
- The first time a job is seen it only records "from now on" without running; runs missed while stopped are caught up once at startup. Time always comes from the injected clock (tests advance a `ManualClock` instead of waiting).
- Register in `setup` with `ctx.effect(() => ctx.internalJobs.register(job))`; an in-flight run is not aborted by the undo, so the plugin should signal abort in `lifecycle.stop` and wait for it.

Data sources (`ctx.dataSources.register`, section 7 of the plugin guide) have two levels on the web: `#/more/data-sources` is a card overview (`pages/more/DataSourcesPage.tsx`, with no inputs or action buttons) and `#/more/data-sources/<id>` is a separate full-page detail (`pages/more/DataSourceDetail.tsx`: status, settings, data). The two tabs in the data block map to two optional source methods: `stored` (fetched data; sources that don't produce materials list their own, and the kernel lists the rest by `origin.dataSource`, the same result as `filter.dataSource` on `POST /api/materials/list`) and `live` (available now: asks the upstream, read-only, with no events, materials, memory or model involved). The endpoints are `POST /api/data-sources/<id>/stored` and `POST /api/data-sources/<id>/live`. On the external port they need a device credential like every other endpoint.

Gmail can connect several accounts (ticket 344, `google/gmail-accounts.ts`). In the secrets area, `values` in `secrets/data-sources/google-gmail.json` holds `accounts` (account ids, comma-separated) and `account.<id>.address`, `.password` and `.enabled` (`on` / `off`) for each account. The id is the first 10 hex digits of the hash of the lower-cased address, so the same address keeps its id if it's disconnected and added again; events record the id, which can't be turned back into the address. Each value has its own entry rather than one JSON blob, because the kernel replaces entries with `***` in error messages. Message numbers include the account (`<account id>.<mailbox>-<UIDVALIDITY>-<UID>`) since UIDs collide across accounts. Pages show the full address; logs and anything given to a model show a masked one (ticket 339). The kernel strips the full addresses in this entry from error messages, so the plugin writes masked ones there.

The old configuration (the `address` and `password` keys) becomes one account at startup: the kernel calls the data source's `migrate` when it starts (even with the plugin disabled, since it only touches the secrets area). It first writes a backup into the same entry (`backup.pre-344.address`, `.password`, `.at`; the secrets area never goes into the backup area), then the account and `legacy.account` (records imported earlier name no account and belong to it). Adding the id to `accounts` is what makes it count as done, and the old keys are deleted last. Each step is one atomic write, so a later startup finishes the job from wherever it stopped, and once done nothing happens. If it fails, the kernel logs one line and leaves the old keys alone, and `accountsIn` reads them as one account, so Gmail keeps working. Disconnecting the migrated account deletes the backup too.

To roll back to an older version: it only understands `address` and `password`. Stop the daemon, write the backup back to those two keys (it ignores the rest), then start the older version. Accounts added later aren't known to it, and the next upgrade migrates again:

```sh
node -e "const fs=require('fs'),f=process.argv[1],j=JSON.parse(fs.readFileSync(f,'utf8')),v=j.values;v.address=v['backup.pre-344.address'];v.password=v['backup.pre-344.password'];fs.writeFileSync(f,JSON.stringify(j,null,2))" <data dir>/secrets/data-sources/google-gmail.json
```

### 5.3 Web plugins

The web UI uses **typed slots** and plugins never import each other (`packages/web/src/plugins/`). The daemon pushes each plugin's status on the plugins channel and the web plugin host installs and stops web plugins accordingly.

| Slot | Where the core renders it | When the plugin is disabled |
|---|---|---|
| `pages` pages and routes | Inserted into the core navigation by `order`; the right-hand column when folded into More | Gone from navigation; a still-open address says "plugin X is not enabled" |
| `settingsSections` / `settingsPages` | Sections in the settings list, settings pages drawn by the plugin | Not shown |
| `chatItems` / `details` | Conversation items, detail panel content | Replaced by a one-line placeholder |
| `cards` | Cards (one component for chat, inbox, task details) | One-line placeholder |
| `boardEntries` | Board entries and menu items | Consecutive entries in a group collapse into one placeholder |
| `calendar` | Calendar legend, cell marks, a section in the day view | Not shown |
| `composerVoice` | The input box's voice mode | Typing only |
| `background` | Renders nothing, only runs hooks (e.g. autoplay) | Not run |
| `tabs` | Tabs in the main navigation (currently only "Browse") | Tab removed |

A plugin declares the places it owns (`owns`) in its definition and must register exactly those; plugins import only `plugins/api.ts` and the core, and the manifest `plugins/manifest.ts` is imported only by `App.tsx` (`test/plugins/boundary.test.ts`). In the prototype, `?demo-plugins-off=memory,reminders` shows what disabled plugins look like.

## 6. Web UI

### 6.1 Where pages come from: prototype and online demo

- **Served by the daemon**: after `npm run build:web`, the daemon serves `packages/web/dist/index.html` at `http://127.0.0.1:8810/` (Vite + `vite-plugin-singlefile`, all JS and CSS inlined; re-read on every request, so no daemon restart is needed). Open pages show "new version · refresh" within seconds.
- **Prototype**: opening the build output directly (`file://`) has no daemon, so everything uses the prototype's built-in sample data (`src/prototype/`: a fake connection and fake data with obviously made-up names and paths). UI review and the page test (`test/page-opens.test.ts`) open it this way. Add `?lang=en` for English.
- **Online demo**: `npm run build:demo` (`vite build --mode demo --outDir dist-demo`) builds another copy; the page recognizes the demo build via `import.meta.env.MODE` and always uses the prototype data (`src/app/prototype-mode.ts`). The whole `dist-demo/` goes to GitHub Pages (`.github/workflows/pages.yml`), so people can click around without installing anything or entering a key.

**Web directories**:

| Directory | What it is |
|---|---|
| `src/state/` | **Frontend state layer**: pure functions folding the event stream into UI state, no React or DOM (enforced by its own tsconfig) |
| `src/app/` | The state layer wired into React (`store.tsx`), connections (WebSocket and HTTP), pairing, routing, theme, language, recording and playback |
| `src/ui/` | Shared parts: the conversation component (shared by secretary and maintainers), cards, panes and popovers, main navigation, line icons (`icons.tsx`) |
| `src/pages/` | Pages |
| `src/plugins/` | Web plugin host, manifest, plugins |
| `src/visual-styles/` | Style list and tokens ([6.2](#62-visual-styles)) |
| `src/prototype/` | Fake connection and data, prototype only |
| `src/page-bridge/` | A standalone script injected into external pages in Browse (floating button, form filling; the long-press element button is in `element.ts`: it only listens to `contextmenu`, never blocks the system menu, and doesn't classify actions, so what the user says goes to the secretary's main conversation as is). A site's CSP can block `<style>`, `style` attributes and `data:` images: styles go through `adoptedStyleSheets` and `style.cssText`, images are decoded to bitmaps and drawn into a canvas |
| `src/styles/` | The Classic style's rules, using only `var(--token)` |
| `build/` | Build plugins (styles, version hash, build info for the About page), `smoke-page.ts` |

### 6.2 Visual styles

11 styles (Classic, Paper journal, Clean grid, Night cockpit, Soft candy, Glass glow, Blueprint, Sticker bento, Pixel cottage, Ink wash, Retro magazine), each with light and dark variants. **Styles only reskin**: page structure, features and navigation logic are shared; a style overrides only tokens and scoped rules ([ADR-0021](adr/0021-visual-styles-tokens-in-ts-fonts-from-gateway.md)).

- **A style = a set of tokens + rules scoped to that style.** Token names are in `TOKEN_NAMES` in `src/visual-styles/tokens.ts`; Classic defines them all in `classic/style.ts` and other styles only what differs; page CSS uses only `var(--token)` — no hard-coded colors, radii or shadows. Rules live in `<id>/style.css`, each starting with `:root[data-style="<id>"]` (`test/visual-styles/scope.test.ts` checks every one).
- Easy-to-confuse tokens: three fonts (`font-body`, `font-title`, `font-num`); the accent `primary` vs. solid fills `primary-fill`; borders `card-border` (bordered cards) vs. `panel-border` (panels); shadow colors written once with `light-dark()`.
- **ergo serves its own fonts**: a style's `fonts` names an npm fontsource package (its license must allow redistribution); the build copies it into `dist/fonts/<package>@<version>/` sliced by `unicode-range`, the daemon serves it under `/fonts/`, and it loads only when that style is selected. No external CDN at runtime.
- **Icons**: navigation, options and buttons use `<Icon name="…" />` from `src/ui/icons.tsx` (hand-drawn line SVGs in `currentColor`), not emoji.
- **Adding a style**: create `src/visual-styles/<id>/style.ts` (`{ id, name, blurb, tokens, fonts? }`) and `style.css`, add one line to `src/visual-styles/index.ts`; for fonts, `npm install -D --save-exact <fontsource package>@<version> -w @ergo/web`; run `npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts` (contrast, fonts and rule prefixes are checked automatically), then `npm run build:web` and look at light and dark. The style preview in Settings comes for free.

### 6.3 Conversation zoom and scrolling to the end

Secretary, task and project conversations share one component, `ZoomHistory` (viewport > sizer > content); the three zoom levels scale the sizer. Anything sticking out of the content (side annotations, arrows) is clipped by `overflow-y: clip` on `.zh-sizer`, so the scroll range equals the sizer's height; visible annotations hanging below the last item when zoomed out count as a "zoomed-out tail" (`zoomedOutTail` in `state/scroll-end.ts`). The rules for the "jump to latest" ↓ button are in the same file. jsdom doesn't lay out, so verify with real layout: open the build output in headless Chrome, scroll to the end with the wheel, and check that `.zh-viewport`'s `scrollHeight` equals `.zh-sizer`'s `offsetHeight` at each of the three levels.

### 6.4 Yielding the microphone

In voice mode ergo keeps the microphone warmed up for instant push-to-talk; but whenever **a text-entry element gets focus**, or the window loses system focus, all tracks stop immediately so the system keyboard's voice input isn't blocked ("microphone in use"). After focus returns it waits 0.5 s before warming up again; focus changes never interrupt a recording in progress. The rules live in one place in the state layer (`voiceMicCloseReason` / `voiceMicOpenReason` in `state/voice-mic.ts`, table-tested in `test/state/voice-mic.test.ts`), wired to the browser in `app/voice-browser.ts`. Recordings carry diagnostics (`capture`: backend, press-to-record latency, peak…), and silent recordings are not sent. The HarmonyOS app uses native recording and doesn't need to yield ([8.4](#84-native-recording)).

## 7. Internationalization

UI text and messages ergo generates for users (cards, notifications, receipts) go through `t()`; the secretary and maintainers answer in the selected language. System prompts and tool descriptions are for the model and stay in Chinese, with one line appended: "answer the user in <language>". **There is one global language** shared by all devices ([ADR-0029](adr/0029-i18n-runtime-in-protocol-one-active-language.md)).

- **The runtime** lives in the protocol package (`packages/protocol/src/i18n/`): `t(key, params?)` (`{name}` interpolation; missing sentences fall back to Chinese), plurals (with a numeric `count`, `_one` / `_other`…), `tParts` and the web's `<T k="…" params={…} />` (elements inside a sentence), `tTable` (constant tables written as keys, looked up on access), `followLocale` (an exported string constant that follows the language), `forModel` (run code with Chinese `t()` for the model-facing copy), `formatNumber` / `formatDate`.
- **Language files**: built-ins in `packages/protocol/locales/<code>/`, where the file name is the key's first segment (its region); users drop the same format into `~/.ergo/locales/`, which the daemon checks every 2 seconds, no restart needed.
- **Keys**: `<region>.<module or page>.<meaning>`, lowerCamelCase segments, naming the **meaning**, not the source text. Regions the web may use are listed in `WEB_NAMESPACES` in the protocol package; daemon keys start with the directory they live in. Both languages must use the same interpolation parameters.
- **Never call `t()` at module top level**, nor read `tTable` values there (the language may not be loaded yet): make it a function evaluated at render time. Memoized components and `useMemo`s that call `t()` must call `useLocale()` or depend on it.
- **Excluding Chinese meant for the model**: the annotation must be the first thing in the comment — `// @i18n-ignore model: reason` (this line), `// @i18n-ignore-next model`, `// @i18n-ignore-start model` … `// @i18n-ignore-end`, `// @i18n-ignore-file model: …` at the top of a file, `{/* @i18n-ignore fixed */}` in JSX. Valid reasons: `model`, `log`, `fixed`, `data`. Text written directly inside `log(…)` or `console.*(…)` needn't be annotated.
- **The hard-coded Chinese ratchet**: `packages/daemon/test/i18n/hardcoded.test.ts` counts hard-coded Chinese per region (comments, tests and prototype sample data don't count), and every region's baseline is 0 — all new user-facing text goes through `t()`.
- **Checking**: `npm run i18n:check` (missing, extra and mismatched-parameter sentences per language; unreadable files in `~/.ergo/locales`; exits 1 only if the built-in English is incomplete). User-facing steps for adding a language are in the [User Guide](user-guide.en.md#54-language); to make one built-in, put the translated directory into `packages/protocol/locales/<code>/` with file names matching `zh-CN`.

## 8. Phone apps

8.1 to 8.4 cover HarmonyOS; for Android see [8.5](#85-android-app).

`frontend/harmony/` is a DevEco project (stage model, `entry` module): a native shell whose ArkWeb loads the ergo address the user configured, serving the same web UI as the daemon (why the web UI isn't bundled into the app: [ADR-0022](adr/0022-harmony-app-native-shell-loads-daemon-page.md)). The native bridge `window.ergoNative` is exposed only to the configured origin's main frame; external pages in Browse never get it.

### 8.1 Build

```powershell
npm run build:harmony                       # WebView debugging off by default
npm run build:harmony -- --webview-debug    # WebView debugging on (install this build only while debugging)
```

- Uses DevEco Studio's bundled tools (`DEVECO_HOME`, or the default install location); the project has no ohpm dependencies and needs no network. Before building, the page bridge is bundled into `rawfile/page-bridge.js` and the built-in `harmony.json` texts into `rawfile/harmony-texts.json` (both generated, not committed).
- Output: the signed `frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap`; without local signing only an unsigned package in the same folder, and the script explains how to sign.
- Depends on a local DevEco install, so it's not part of `npm run check`.

### 8.2 Signing (once)

Signing material (certificates, profiles, keystore, encrypted passwords) stays local and never enters the repository: run `npm run build:harmony` once to generate the local `frontend/harmony/build-profile.json5` (ignored) → enable developer mode and USB debugging on the phone and connect it → open `frontend/harmony` in DevEco, File → Project Structure → Project → Signing Configs, sign in with a Huawei account, tick Automatically generate signature → build again. The repository holds only an unsigned template `build-profile.template.json5`; `frontend/test/harmony.test.ts` checks that no signing material is committed.

### 8.3 Install, launch, debug

```powershell
hdc list targets
hdc -t <device> install -r frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap
hdc -t <device> shell aa start -a EntryAbility -b com.catmaniii.ergo
hdc -t <device> hilog | findstr ErgoApp            # app and web page logs
```

To debug the page inside ArkWeb: install a `--webview-debug` build, `hdc -t <device> fport tcp:9222 localabstract:webview_devtools_remote_<app pid>`, then use Chrome's `chrome://inspect`. To reach the PC's daemon from the device via `http://127.0.0.1`, first `hdc rport tcp:<port> tcp:<port>`; note that forwarding the local port (8810) makes the daemon trust the app as local — only do this while debugging.

### 8.4 Native recording

Push-to-talk in the app uses HarmonyOS's AudioCapturer: entering voice mode creates the capturer and leaves it PREPARED (not capturing, not holding the microphone, not blocking the keyboard's voice input); pressing calls `start`, releasing calls `stop` (the next take just calls `start` again); going to the background or leaving voice mode calls `release`. The format is 16 kHz mono 16-bit PCM; the web side adds a WAV header and uploads it as usual. The source is `SOURCE_TYPE_MIC`: the only source that coexists with the keyboard's speech recognition (`VOICE_RECOGNITION`) in both directions on every system version. Implementation: `frontend/harmony/entry/src/main/ets/voice/NativeVoice.ets`; web side `packages/web/src/app/native-voice.ts` and `voice-native-recorder.ts`.

### 8.5 Android app

`frontend/android/` is a Gradle project: a Kotlin native shell with the system WebView, and the web UI isn't bundled here either. It has the same method table as HarmonyOS minus phone data sources (`phone*`); natively drawn parts take their values from HarmonyOS, gathered in `ui/ErgoTheme.kt`. See `frontend/android/README.md` for details.

```powershell
npm run build:android                       # debug build, WebView debugging off by default
npm run build:android -- --webview-debug    # WebView debugging on (install this build only while debugging)
npm run build:android -- --release          # release build; needs a local frontend/android/keystore.properties
```

It needs the Android SDK (`ANDROID_HOME`, or the default location) and JDK 17 or later, and the first build fetches the build plugin and AndroidX libraries from their official sources, so it isn't part of `npm run check`; the static checks in `frontend/test/android.test.ts` are. Before building, the page bridge is bundled into `assets/page-bridge.js` and the bundled languages are collected into `assets/harmony-texts.json` (both generated, not committed).

**On a real device**:

```powershell
adb devices
adb -s <device id> install -r frontend/android/app/build/outputs/apk/debug/app-debug.apk
adb -s <device id> shell am start -n com.catmaniii.ergo/.MainActivity
adb -s <device id> logcat -s ErgoApp               # app and web UI logs
```

To debug pages in the WebView, install the `--webview-debug` build and use Chrome's `chrome://inspect`. To reach a daemon on your PC from the device at `http://127.0.0.1`, first run `adb -s <device id> reverse tcp:<port> tcp:<port>`; as on HarmonyOS, forwarding the local port (8810) makes the daemon treat the app as local and trust it, so do this only while debugging.

**The native bridge's security design differs from HarmonyOS** ([ADR-0040](adr/0040-android-app-native-bridge-without-javascript-interface.md)): Android's `addJavascriptInterface` is visible to every page and frame in the WebView, so it can't be used. `ergoNative` goes through `addWebMessageListener` and `addDocumentStartJavaScript`, both registered only for the configured ergo origin, and each message is checked again for origin and main frame. The shim `assets/ergo-native-shim.js` serves the methods the web UI calls synchronously. The built-in browser is a separate WebView with only the page bridge, and every message carries a nonce issued by the app.

**Integration runs**: `frontend/android/e2e/` runs on an emulator against a temporary daemon. It isn't part of `npm run check`, every adb command carries a serial, and a serial not starting with `emulator-` is an error. `e2e/browser.ts` holds the proof that external pages can't reach `ergoNative`; run it when you change the native bridge or the page bridge.

**Native recording** uses `AudioRecord`: created without capturing when voice mode starts, `startRecording` on press, `stop` on release, `release` when the app goes to the background or leaves voice mode. The format matches HarmonyOS (16 kHz, mono, 16-bit PCM) and the web side is unchanged. The source is `MIC`.

**System notifications** are local ones with no FCM and no foreground service: they only go out while the process is alive, and nothing arrives after the system kills it. The other rules match HarmonyOS: ask for permission the first time, don't post while in the foreground, one notification per item, and tapping returns to the matching page.

## 9. Coding conventions

- **Type-stripping limits** (the daemon and protocol run `.ts` directly; the web is bundled by Vite but follows the same rules): relative imports carry the `.ts` extension; only erasable syntax (no `enum`, `namespace`, constructor parameter properties); type-only imports use `import type`. `erasableSyntaxOnly` and `verbatimModuleSyntax` in `tsconfig.base.json` enforce this.
- **The pi boundary**: `@earendil-works/*` may only be imported inside `packages/daemon/src/runtime/agent-child/`; nothing may re-export pi's exports; nothing outside `agent-child/` may import from it (`test/pi-boundary.test.ts`).
- **The project-system boundary**: outside the project-system directories, import only the entry `projects/api.ts` (the operations layer's is `project-ops/api.ts`); if you need something new, add a small caller-shaped interface to the entry (`test/projects/boundary.test.ts`). Same for plugins: the kernel imports only a plugin's `api.ts`.
- **Personal data and secrets never enter the repository**: the data directory comes from config, and tests always use temporary directories. Never read or print real data under the user's `.ergo`, `.ssh` and so on.
- **Write a temporary file, then rename — always through `util/atomic-file.ts`** (`writeFileAtomic`, `renameRetrying` and async variants): on Windows, renaming over a file another process has open fails (even if it's only reading), and these helpers retry; never `fs.renameSync` a freshly written temp file directly.
- **User-facing text goes through `t()`** ([Section 7](#7-internationalization)); model-facing text and logs are annotated `@i18n-ignore`.
- **Identifiers in English, comments in Chinese**; domain concepts use the words in `CONTEXT.md`. Exception: placeholder names in system-prompt files are Chinese (`{{拉回次数}}`, `{{#立项书已确认}}`, and the matching keys in code) — those files are shown to and edited by users, who type these names in the settings editor.
- **Each threshold's default is defined once, in its own module**; config only lists what changes.
- **Styles use only `var(--token)`**, never hard-coded colors, radii or shadows ([6.2](#62-visual-styles)).
- Dependencies are pinned to exact versions, and `package-lock.json` is committed with them.

## 10. Testing

### 10.1 Lanes

| Lane | Runs | When |
|---|---|---|
| `npm run test:fast` | Everything in the daemon except the main slice (`test/main`) and contract tests (`test/contract`), plus protocol, web state / UI / build checks, memory, and the HarmonyOS checks | After every change (~2 minutes) |
| `npm run test:integration` | The main slice (real daemon and agent child processes) plus `page-opens` (build once, open every page in real Chrome) | When touching the daemon's main paths, composition root or assembly, or before merging |
| `npm test` | Everything = fast lane + main slice + pi contract tests | Before a release (GitHub Actions runs it on tags) |

`npm run test:contract` (pi contract tests) launches a child process per test case and is only needed when upgrading pi or changing `agent-host/`, `runtime/` or prompt assembly. The supervisor's tests use `node --test`; run them with `npm run test:supervisor`. The two lanes' vitest configs are `vitest.fast.config.ts` and `vitest.integration.config.ts` at the root; the full run uses the root `vitest.config.ts`. When changing a package's `setupFiles` / `include`, update all of them.

### 10.2 Test harness

- **The maintainer speaks first after a kickoff**: in production, tapping "Start project" wakes the maintainer (`kickoffFromCard` in `projects.ts`); `startTestDaemon` keeps this off by default (`kickoffOpening`) so faux model scripts don't gain a turn. Tests that need it pass `true`.
- **Main slice** (`packages/daemon/test/main/`): `startTestDaemon(options)` starts a real daemon (temporary data directory, system-chosen free ports, **never 8810 or 8811**); the secretary, maintainers, reviewers and sub-agents talk to pi's faux provider following scripts, and child processes are really launched; `TestFrontend` plays the frontend over WebSocket and HTTP and waits for events per channel. Time is advanced with `ManualClock`, never waited out.
- **Guard slice** (`packages/daemon/test/guard/`): calls the judging function only, no processes; scenario files `scenarios/*.guard.json` run one by one.
- **pi contract tests** (`packages/daemon/test/contract/`): verify only the pi behavior ergo depends on.
- **Web**: the state layer is tested by replaying recorded event streams (`recordings/`, recorded live by the main slice: `ERGO_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/recordings.test.ts`); pages by `page-opens.test.ts`, which opens the prototype in real Chrome (skipped if there's no Chrome).
- **Plugins**: the fake kernel `startPluginKernel` in `test/helpers/plugin-kernel.ts` (see the plugin guide).
- **Secret-looking test samples** are assembled at runtime (`test/helpers/fake-secrets.ts`); the repository contains no strings that look like real keys.

### 10.3 No real data, no network

- Tests always use temporary directories and never touch `~/.ergo` or a running daemon.
- Every vitest project loads the root `vitest.setup-no-network.mjs`: **any request to a non-loopback address throws**. To test networking, use local fakes (fake TTS, fake MCP, a fake model catalog…). No test spends tokens.
- **The scheduled task `LocalServiceManager` has a fixed name, and a development machine has a real one**: tests swap it for a JSON file with `ERGO_AUTOSTART_TASK_FILE` (`cli/autostart.ts`; the installer honours it too). `ergo` starts lsm through one entry only, `runLsm`; under vitest without that variable, `install-autostart` and `uninstall-autostart` are refused there and lsm isn't started. `cli.test.ts` and `install-script.test.ts` compare the real task's full definition (read-only) when they finish. The installer's tests use a fake `ergo.cmd`.

### 10.4 Windows notes

- Parallelism: set `ERGO_TEST_WORKERS` to a number (default is half the cores); use 2 when several suites run at once.
- Advancing the clock past 03:00 wakes the memory curator in the background: `startTestDaemon` disables the memory plugin by default when given a `clock`; tests about memory pass `memoryPlugin: true`.
- Don't poll a file while the product is replacing it by rename (EPERM / ENOENT on Windows): wait for the product's "done" signal and then read.
- Timeouts may be relaxed for slowness; assertions are never weakened.

## 11. Upgrading pi

1. `npm view @earendil-works/pi-coding-agent dist-tags` for the latest stable version; read the Breaking Changes in each package's CHANGELOG.
2. Change all `@earendil-works/*` together, pinned to exact versions: `dependencies` in `packages/daemon/package.json` and `overrides` in the root `package.json` (add any new `@earendil-works/*` package the new pi depends on).
3. `npm install`, and confirm with `npm ls --all` that all earendil packages are the same version.
4. `npm run typecheck` → `npm run test:contract` → `npm test`. The only extension loaded into pi in the child is the generic bridge (`runtime/agent-child/bridge.ts`); check the CHANGELOG for changes to the events it uses and the APIs used by `agent-child/tool-order.ts`.
5. **Check pi's Node major version** ([ADR-0031](adr/0031-node-version-follows-pi.md)): look at `node-version` in pi's `.github/workflows/ci.yml` and `latest-v<major>.x` in its installer; if they changed, follow (`engines`, CI, installer) and run everything.

## 12. From ergou to ergo

ergo's early code name was the pinyin `ergou`; it has been unified to `ergo`: package names `@ergo/*`, env vars `ERGO_*`, the data directory `~/.ergo`, `config/ergo.json`, `db/ergo.db`, pairing cookies `__Host-ergo-*`, browser storage keys `ergo-*`, the HarmonyOS bridge `ergoNative`, and `ergo-daemon` / `ergo-tunnel` / `ergo-asr` in the supervisor. The HarmonyOS bundle name is `com.catmaniii.ergo` (decided 2026-10-30) - the bundle name cannot change once registered in AGC, so it has to be decided before that.

**Old names are still accepted during the transition**: reads accept both, preferring the new; writes use only the new. Old names are always derived from new ones with `oldNameOf` in the protocol package (`packages/protocol/src/old-names.ts`). There is compatibility code for the data directory (`ERGOU_DATA_DIR`, `~/.ergou`), other env vars, old file names inside the data directory, old pairing cookies, old browser keys and the HarmonyOS app's old names. To migrate an old data directory: `npm run migrate:ergo -- [--data-dir <old dir>] [--dry-run]` (stop the daemon first; it renames and leaves a directory junction behind; every step can be re-run).

## 13. Docs, CHANGELOG, decision records

- **When behavior changes, update the docs in the same commit**: user-visible changes go into the [User Guide](user-guide.en.md) (both languages); modules, protocols and conventions into this guide (both languages); plugins into the plugin guide (tests check its excerpts and names); new terms into [CONTEXT.md](../CONTEXT.md).
- **CHANGELOG**: one section per version, describing changes users can notice.
- **Decision records** (`docs/adr/`): write an ADR for decisions that are hard to reverse, surprising, or chosen among alternatives — next number, with context, decision and consequences.
- **Memory system** docs (`docs/memory-system.md`) are checked against the code (interface tables, tool tables, paths) by `packages/memory/test/architecture-doc.test.ts`.
- **Third-party licenses**: dependencies are mostly MIT / Apache-2.0 / BSD / ISC; sharp's bundled libvips is LGPL-3.0; fonts are SIL OFL 1.1 (their licenses are copied into `dist/fonts/` with the fonts); lightningcss is MPL-2.0 but is only used to build the web UI and is not in the release package. The full list is generated by the build scripts (`packages/daemon/build/`; `npm run release` from the repository root builds into `dist/release`) into the package root: `THIRD_PARTY_NOTICES.txt` (full texts) and `third-party-licenses.json` (name, version, license, origin). Claude Code's Agent SDK (`@anthropic-ai/claude-agent-sdk`) is under Anthropic's own license, is an optional dependency, and is not redistributed with the package.
