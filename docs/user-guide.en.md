[中文](user-guide.md) | **English**

# ergo User Guide

How to install, use, configure and troubleshoot ergo (二狗 in Chinese). For what ergo is and why, see the [README](../README.en.md); to change the code or write plugins, see the [Developer Guide](developer-guide.en.md).

> One-line install, the `ergo` command and the web setup wizard all work now. The public download address isn't open yet (no Release has been published), so the commands in 2.1 and 2.2 work only after the release. Until then, use [Install from source](#23-install-from-source-works-today); it does the same thing.

> The interface is Chinese-first and fully translated into English (**Settings · 语言 / Language**). Menu names below are given in English, as they appear with English selected.

## Contents

1. [Before you install](#1-before-you-install)
2. [Install](#2-install)
3. [First run](#3-first-run)
4. [Everyday use](#4-everyday-use)
5. [Settings and config files](#5-settings-and-config-files)
6. [Access from outside (phone, tablet)](#6-access-from-outside-phone-tablet)
7. [On your phone](#7-on-your-phone)
8. [Optional features](#8-optional-features)
9. [Backup and restore](#9-backup-and-restore)
10. [Update, stop, uninstall](#10-update-stop-uninstall)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Before you install

**ergo runs as two processes**, both on your own computer:

| Process | What it is | Default address |
|---|---|---|
| The ergo daemon (`ergo-daemon`) | ergo itself: manages agents, stores your data, serves the web UI | Local port `http://127.0.0.1:8810/`; external port 8811 (only for tunnels / Tailscale) |
| The service supervisor (`packages/supervisor`, command `lsm`) | A small, stable watchdog: starts at login, launches ergo, restarts it if killed, shows logs | `http://127.0.0.1:7420/` |

ergo never starts long-running services itself; the supervisor hosts them. They are separate because ergo is the process that restarts most often and cannot supervise itself.

**Requirements**

- **Windows 10 / 11 only.** ergo relies on Windows-only features (Job objects, directory junctions, Windows Sandbox, scheduled tasks). On other systems the daemon says so and exits.
- **Node.js 22** (≥ 22.19). ergo's Node major version follows its agent core [pi](https://github.com/earendil-works/pi) ([ADR-0031](adr/0031-node-version-follows-pi.md)); CI runs only this version. The one-line installer bundles Node for you.
- **An LLM API key**: currently [DeepSeek](https://platform.deepseek.com/) (you can also switch to another vendor's OpenAI-compatible provider; see [5.5](#55-models)). Without one ergo still starts and you can look around; it will tell you to configure a model when you talk to it.
- **Disk**: a few hundred MB for the program; ~570 MB for the semantic-search embedding model; 1–2 GB for speech recognition (both optional).

**Optional** (ergo works without them; the matching features stay off)

| Install | Gives you | See |
|---|---|---|
| Git for Windows | Agents can run bash commands (used a lot in tasks); install from source | [2.3](#23-install-from-source-works-today) |
| Python + faster-whisper, ideally an NVIDIA GPU | Push-to-talk, recognized locally | [8.1](#81-push-to-talk-local-speech-recognition) |
| The audio.cpp TTS service | ergo answers with voice | [8.2](#82-voice-replies-local-speech-synthesis) |
| Chrome or Edge | Agents can search the web and read pages | [8.4](#84-web-search-and-reading-pages) |
| Tailscale, or a VPS | Use ergo from your phone or tablet away from home | [Section 6](#6-access-from-outside-phone-tablet) |
| Claude Code, signed in on this PC | Project and task owners can work through your own Claude Code subscription | [8.6](#86-claude-code) |
| DevEco Studio and a HarmonyOS phone | The native HarmonyOS app | [7.2](#72-harmonyos-app) |

---

## 2. Install

### 2.1 One-line install (recommended)

In PowerShell:

```powershell
irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1 | iex
```

It finds the latest version (whichever of GitHub Releases and npmmirror answers faster) → downloads the prebuilt package (with Node; no `npm`, no build) → verifies the signature and each file's sha256 → extracts it to `%LOCALAPPDATA%\Programs\ergo\versions\<version>`, writing `current` (a one-line text file naming the one in use) → adds `bin` to your user PATH (no admin rights) → starts ergo. Then open <http://127.0.0.1:8810/> in a browser and follow the wizard (see [Section 3](#3-first-run)). Your data lives in `%USERPROFILE%\.ergo`, separate from the program; upgrades and reinstalls never touch it.

`irm … | iex` cannot pass parameters; to pass one, fetch the script and run it:

```powershell
& ([scriptblock]::Create((irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1))) -FromSource
```

The options: `-FromSource` (skip the package, fetch the source package and build it; `-Ref <tag or branch>` picks the version), `-NodeVersion <version>` (only allow a tested Node), `-UseSystemNode` (use the Node already on the machine instead of the bundled one), `-Mirror cn` (force npmmirror, faster in mainland China), `-NoPath` (don't change PATH), `-NoOnboard` (don't start ergo after installing).

### 2.2 Install with npm (if you already have Node 22)

```powershell
npm i -g ergo-ai
ergo start
```

The command is still called `ergo`. The npm packages ship together with the Release, so this section doesn't work until the release is out; afterwards open <http://127.0.0.1:8810/> and follow the wizard.

### 2.3 Install from source (works today)

These example paths are used below; substitute your own:

| Example path | What it is |
|---|---|
| `D:\apps\node22\node.exe` | A copy of Node.js dedicated to ergo |
| `D:\apps\ergo` | ergo's code (the supervisor lives in its `packages\supervisor`) |
| `%LOCALAPPDATA%\ergo\supervisor` | The supervisor's data directory (service list, ledger, logs, its own secrets) |
| `%USERPROFILE%\.ergo` | ergo's data directory (created on first start) |

**Step 1: Node and Git**

- Install [Git for Windows](https://git-scm.com/).
- Download the Node 22 Windows zip from [nodejs.org](https://nodejs.org/) and unpack it to a fixed folder (e.g. `D:\apps\node22\`). Keep **a dedicated copy** for ergo, so PATH changes or other programs' upgrades never affect it. Make sure the `node` / `npm` you use below is this one (`node -v` should print v22.x).

**Step 2: get the code, install dependencies, build the web UI**

```powershell
cd D:\apps
git clone https://github.com/catmaniii/ergo.git
cd ergo
npm ci                  # install exactly what package-lock.json says
npm run build:web       # build the web UI into packages\web\dist\index.html
```

- Use a normal checkout, not a git worktree.
- The daemon runs its TypeScript sources directly (Node's type stripping); only the web UI needs a build.

**Step 3: start the supervisor**

```powershell
cd D:\apps\ergo\packages\supervisor
$data = "$env:LOCALAPPDATA\ergo\supervisor"
New-Item -ItemType Directory -Force $data | Out-Null
Copy-Item -Recurse examples\registry "$data\registry"
notepad "$data\registry\manager.yaml"    # set projectRoots to the folder where you keep code
node bin\lsm.mjs validate               # validates the registry only; touches no process
node bin\lsm.mjs install-autostart      # start the supervisor in the background at Windows login (no window)
Start-ScheduledTask -TaskName LocalServiceManager   # start it now (or sign out and back in)
```

Open <http://127.0.0.1:7420/>; if you see the supervisor's page, it is running. Below, `lsm` means running `node bin\lsm.mjs` inside `D:\apps\ergo\packages\supervisor`. More (profiles, a password for its web UI, the sentinel…) is in its [README](../packages/supervisor/README.md) (Chinese).

> With the one-line install, `ergo start / stop / status / logs` manage ergo itself and `ergo svc <subcommand>` passes through to the supervisor (`ergo svc status` = `lsm status`).

**Step 4: put your API key in place**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ergo\secrets" | Out-Null
Set-Content -NoNewline -Encoding ascii "$env:USERPROFILE\.ergo\secrets\deepseek-api-key.txt" "sk-your-key"
```

- The file holds only the key. The supervisor reads it and hands it to the daemon; no agent can read the `secrets` area of the data directory.
- **Never put the key in the repository** or in the supervisor's registry.
- You can skip the command line: once ergo's web page is open, enter the key in the **setup wizard**'s "Model Key" step, or under **Settings · Models**, and click "Save key". It is written to the same file (`secrets\deepseek-api-key.txt`, with the folder and file created at the tightest permissions), and the next new session can use it — no restart needed; change it in the same place later. Putting the file in place by hand remains the fallback, for when the page won't open or you want a different data directory.
- To use another vendor's model (a custom OpenAI-compatible provider), its key lives in `secrets\custom-model-api-key.txt` and the environment variable is `CUSTOM_MODEL_API_KEY`; how to fill it in is in [5.5](#55-models).

**Step 5: register the daemon with the supervisor**

1. Copy the example entry:

   ```powershell
   copy D:\apps\ergo\deploy\lsm\ergo-daemon.example.yaml "$env:LOCALAPPDATA\ergo\supervisor\registry\services\ergo-daemon.yaml"
   ```

2. Open the copy in a text editor and replace the three placeholders; no `<…>` should remain:

   | Placeholder | Replace with | Example |
   |---|---|---|
   | `<仓库路径>` (repository path) | ergo's code directory | `D:\apps\ergo` |
   | `<专用 Node 路径>` (dedicated Node path) | `node.exe` of the Node from step 1 | `D:\apps\node22\node.exe` |
   | `<用户主目录>` (home directory) | your user directory (the data directory is `.ergo` under it) | `C:\Users\you` |

   Also: without a TTS service, delete the `dependsOn:` block (a soft dependency; removing it does not affect startup); if you changed the local port ([5.2](#52-config-file-ergojson)), change both `8810`s in the entry; leave the commented-out `exposure:` block at the end alone for now ([6.3](#63-option-3-vps--ssh-reverse-tunnel--nginx-public)).

3. Validate, start, enable autostart:

   ```powershell
   cd D:\apps\ergo\packages\supervisor
   node bin\lsm.mjs validate               # reports exactly which field is wrong
   node bin\lsm.mjs reload                 # make the running supervisor re-read the registry
   node bin\lsm.mjs start ergo-daemon
   node bin\lsm.mjs status                 # wait for ergo-daemon to be RUNNING, tier linked
   node bin\lsm.mjs autostart ergo-daemon on
   ```

- Once linked, the daemon reports its own health and whether it is busy: while a task is executing it shows "busy", and "stop when idle" waits for it.
- The daemon's output is in `logs\ergo-daemon.out.log` under the supervisor's data directory, and live in the supervisor's web UI.
- If it is killed or crashes, the supervisor restarts it with backoff; work in progress resumes by its rules, and any operation that may or may not have completed is handed to you to confirm instead of being silently redone.

---

## 3. First run

### 3.1 Setup wizard

It lives at `#/more/setup`, also the "Setup wizard" row at the top of the **More · Settings** list. Five steps: language / how to address you / the assistant's name → model key → components (the embedding model for semantic search; you can download it right there) → pair your phone by QR code → an explanation of the safety defaults; after the five steps there is one more screen about outside access, walking through the three options in [Section 6](#6-access-from-outside-phone-tablet). Every step can be postponed with "later"; when all are done it says you're set. You can come back to it from Settings at any time.

Until a model key is configured, the chat page shows a banner at the top (close it with the × on the right; this device remembers it, so it won't come back).

### 3.2 Doing it without the wizard

On this computer open <http://127.0.0.1:8810/>. Requests on the local port are trusted automatically, no pairing needed.

1. **More · Settings · Models**: click the connectivity test to confirm the key works.
2. **More · Settings · Roles & voices**: name your assistant; pick a visual style under **Appearance & style**.
3. **Say something**, e.g. "remind me to drink water in two minutes". A reminder card appears in the chat; when it is due, a banner shows at the top and an item lands in your inbox.

**Two safety settings are on for new installs** (top of **More · Settings · Watch categories**; you can turn them off, effective immediately):

- **Ask me before risky things** (on): in conversations, risky actions (reading or writing files outside the agent's workspace, sending things out…) first show an approval card and wait for you; tasks also ask before doing something their plan did not authorize. With it off, most of these just happen and are logged; only the most sensitive ones (sending in your name, accounts and passwords, irreversible commits, deleting or changing files outside the workspace) still ask.
- **Stop tasks that go over budget** (on): when a task step exceeds its planned budget, the owner explains its progress first; at twice the budget it stops and waits for you, and you can add budget to continue. With it off, usage is only recorded.

They are stored in the config file as `guard.conversationApprovals` and `tasks.thresholds.budgetControl`, written when the daemon first starts, and are ordinary settings after that.

---

## 4. Everyday use

The UI is designed phone-first and switches to multi-column layouts on wide screens. Main navigation: **Secretary, Tasks, Projects, Inbox, Browse, Calendar, More** (Usage, Memory and Settings are under More; on wide screens they sit in the side rail).

### 4.1 The secretary

The secretary is your personal assistant (you choose its name). It only understands you, relays messages and hands out work; it never touches your projects itself.

- Type or hold to talk; it can read long replies aloud.
- Things that take one step (reminders, remembering something, a quick lookup) it does directly; anything that takes time becomes a task or project with a dedicated owner.
- Owners write to the secretary when they make progress; their letters fold into one line, and the secretary passes them on to you.
- Type `/` in the input box for slash commands (each with a description and argument hints).

### 4.2 Tasks: three kinds × three triggers

Click **New task** (or just tell the secretary):

| Kind | Good for | How it runs |
|---|---|---|
| Plain task | Download a video, look something up | A background agent just does it; the secretary tells you when it's done |
| Workflow | The same few steps every day | Steps are laid out in advance and authorized once; every run is checked step by step and pulled back if it drifts |
| Long-running task | Build a tool, write a research report | Runs in stages with acceptance at each stage; the plan can change mid-way |

Triggers: **once now**; **scheduled** (optionally "on my working days", with Chinese and Singaporean holidays and make-up days); **on an event** (another task finished, a new file arrived in a folder…). Write "every Monday at 8 am…" in the description and the schedule is set from it.

**Why you can hand off long tasks with confidence**:

- The owner first submits a **plan card**: the stages, what each delivers, how it is accepted, which tools it uses, and which operations are pre-approved (kind, scope, count, expiry). Confirming once is the authorization; you can untick or narrow any item.
- Each stage passes scripted checks and then an independent reviewer agent; off-plan actions are flagged and pulled back where possible.
- Changing the plan only pauses the affected stages; you confirm once on a plan-change card.
- If the daemon is killed or the PC restarts, work resumes where it stopped.

### 4.3 Projects

A project is something long-lived (a website, a tool) with a dossier (charter, spec, progress), a working directory and a fixed owner. The owner's work is queued as work orders, one at a time; after each work order a second model checks whether it strayed out of scope. When the first version is done, you decide: put it into use, keep building, or abandon and archive. Once a project goes live as a service, the supervisor hosts it and you can open its pages in ergo's built-in browser.

### 4.4 Inbox

Everything that needs your decision lands here: approvals, plan confirmations, requests for help, pairing requests, due reminders… Time-limited items come first. You can also act on them in the conversation where they appeared.

### 4.5 Three-level timeline zoom

Task, project and secretary conversations can be pinched (on a PC: hold Ctrl and scroll, or use the title-bar button): **conversation** shows everything, **key points** one line per item, **overview** the whole job as one colored bar. When zoomed out, markers for approvals, pull-backs, acceptance and watch-category hits stay pinned in the margin, with lines pointing to where things happened.

### 4.6 Tool-call details and spending

- Open any tool call in a conversation: what it did, which watch category it hit, how it was handled, whether it was within the authorization, and what it actually changed, in plain words.
- **More · Usage**: a token ledger records every model call against the task, stage and agent, with estimated cost.

### 4.7 Memory

ergo keeps a copy of everything you said on this PC (immutable, indexed by keyword and vector), and every night at 3 am the **memory curator** distills it into conclusions backed by evidence.

- **More · Memory**: files (basic facts about you and your family), conclusions (each one opens to its evidence, support and counter-evidence, competing explanations and revision history), a question box, and raw materials.
- Confident conclusions are used by the secretary; uncertain ones become a casual question at a convenient moment.
- To make it remember something on purpose, just tell the secretary "remember this: …". It stores your own words (marked as manually remembered), so later searches find it and you can open the original line.
- Say "forget…" or "don't infer from this", or correct and delete in the memory page; a hard delete also scrubs every place that referenced it.
- To discuss or change your memory in depth, talk to the memory curator directly ("Chat with the memory curator" at the top of the memory page). It may also invite you to a "getting to know you" interview, one topic at a time; you can always decline.

### 4.8 Calendar, reminders, built-in browser

- **Calendar**: working days and holidays for two regions, manual marks, the day's reminders, scheduled tasks and each run; external calendars (phone calendar, Google Calendar…) can be connected through data-source plugins.
- **Reminders**: just tell the secretary; the reminder card lets you reschedule or cancel; due reminders show at the top of the page, or as system notifications on HarmonyOS phones.
- **Browse**: a built-in browser that opens your project services' pages and renders attachments; tap the floating button on a web form's input box to have ergo fill it in.

### 4.9 Plugins

**More · Settings · Plugins** lists the installed plugins and lets you disable, enable or remove them (hot-pluggable, no restart). Built in: Reminders, Memory, Calendar, Voice, Built-in browser, Claude Code, Google, Looki, Phone. Disabling a plugin only hides its pages and tools; its data stays. When removing, you can choose to delete its data too.

---

## 5. Settings and config files

### 5.1 The settings page

**More · Settings** has four groups:

| Group | Contains |
|---|---|
| Identity | My name, personal files, roles & voices (assistant name and voice), language, appearance & style, voice |
| Abilities | Models, skills & MCP, plugins, components (large downloads on demand), Claude Code, browsing & form filling |
| Rules | Watch categories (which operations to tell you about and how to handle them), system prompts, workday rules |
| Data | Data sources, delete materials, full tool-call content, backup, paired devices, checkup, About Ergo |

**Watch categories** are the heart of ergo's guard. Built-in ones include spending money, sending in your name, deleting or overwriting, irreversible commits, accounts and security, and leaving the project directory; you can add your own. Each has six possible handlings: just do it and log, do it and tell me, only if listed in the plan, ask me first, hand it to me, never.

### 5.2 Config file `ergo.json`

The config file is optional; without it everything uses defaults. To change something, copy `config\ergo.example.json` from the repository to `%USERPROFILE%\.ergo\config\ergo.json` and keep only what you change (`<…>` are placeholders: replace them or delete the line). Restart the daemon afterwards (items you can change on the settings page take effect immediately). Common items:

| Item | Controls | Default |
|---|---|---|
| `ports.local` / `ports.external` | Local and external ports (both listen on 127.0.0.1 only) | 8810 / 8811 |
| `guard.conversationApprovals` | Ask before risky things in conversations (`"on"` / `"off"`) | `"on"` for new installs |
| `tasks.maxRunning` | How many tasks may execute at once | 3 |
| `tasks.thresholds` | Pull-backs before stopping, stall timeout, budget multiples… | see the example |
| `agents.maxLive` | Maximum live agent child processes | 8 |
| `approvals.waitMinutes` | How long a call waits for your "ask me first" decision | 5 |
| `voice.recognizer.python` | `python.exe` that has faster-whisper | `python` on PATH |
| `voice.speech.url` / `voice.speech.model` | TTS service address and model | `http://127.0.0.1:8090` |
| `web.browserPath` | Chrome / Edge used for web access; auto-detected if omitted | — |
| `backup.time` / `backup.syncDir` / `backup.schedule` | Nightly backup time, extra copy to a sync folder, who schedules it | 03:30 / none / `"internal"` |
| `memory.maxModelCalls` / `memory.enabled` | Model calls per nightly consolidation, whether this PC runs it | 200 / `true` |
| `media.maxUploadBytes` | Max size of one upload | 200 MB |
| `timeZone` | Time zone for the timestamps sent to the model (rarely needed) | system time zone |
| `plugins.disabled` | Disabled plugins (Settings · Plugins writes here) | empty |
| `publicAccess` | VPS public entry (only read by the deploy command, [6.3](#63-option-3-vps--ssh-reverse-tunnel--nginx-public)) | — |

### 5.3 The data directory

By default `%USERPROFILE%\.ergo` (override with the `ERGO_DATA_DIR` environment variable). Each kind of data has its place:

| Directory | Holds |
|---|---|
| `config\` | Config: `ergo.json`, model settings, watch categories, language, system prompts, MCP registry, work calendar |
| `db\` | The event log `ergo.db` (the single source of truth), the materials store `materials.db` (called `memory.db` in older versions; the first start renames it) |
| `memory\subtext\` | Subtext's (the memory plugin's) own data: the reasoning store `rg.db` (older versions kept it in `db\`; the first start moves it here) |
| `secrets\` | Secrets (no agent can read them; a key entered in the web UI is written here; the supervisor reads them at start and hands them to the daemon) |
| `materials\` | Verbatim copies, media, attachments |
| `sessions\`, `projects\` | Agent sessions; project dossiers and working directories |
| `models\`, `components\` | Embedding model, on-demand components (not backed up; can be re-downloaded) |
| `locales\` | Language files you add yourself ([5.4](#54-language)) |
| `backups\` | Nightly snapshots |
| `logs\`, `tmp\`, `cache\` | Logs, temporary files, caches |

**The repository holds only the framework**: personal data such as memory, conversations, dossiers and secrets never goes into it.

### 5.4 Language

ergo ships with Chinese and English: switch under **More · Settings · 语言 / Language**. All devices switch together, and the secretary and owners answer in that language. Existing chats keep their original language.

To add a language or change a translation, no code changes are needed: copy `packages\protocol\locales\en` from the repository to `%USERPROFILE%\.ergo\locales\<language code>\` (e.g. `fr`), edit `_meta.json` (`nativeName` is the language's own name, `modelName` tells the model which language to use, `intlLocale` is the locale for dates and numbers), then translate the text after the colon in each `.json` (keep `{name}`-style placeholders; `_one` / `_other` are plural forms). Within two seconds the language appears in Settings; untranslated sentences fall back to Chinese. To change just a few sentences, drop a `.json` with only those keys into `locales\<language code>\`. Broken files are listed in Settings · Language with what's wrong; you can also run `npm run i18n:check` in the repository root.

### 5.5 Models

Models are called on the server (the computer running the daemon); the web page only holds the settings. They live in `config\model-settings.json` in the data directory (a protected area no agent can write), and every device sees the same settings.

**DeepSeek is the default**: DeepSeek V4.1 Flash with thinking level high, used by the secretary, maintainers, sub-agents, reviewers and scope review. Under **Settings · Models** you can change the default model, override it per agent, pick a thinking level per row, and say whether a model can see images.

**Switching to a custom (OpenAI-compatible) provider** (the "Provider" block at the top of **Settings · Models**, or the "Model key" step of the **setup wizard** — the same block in both places):

1. Pick "**Custom (OpenAI-compatible)**" as the provider.
2. **Endpoint URL**: include the `/v1` part, e.g. `https://api.openai.com/v1`. Model requests go under it (`/chat/completions` or `/responses`, see step 4), and listing models is `/models` under it.
3. **Model id**: type it if you know it; if not, hit "**Fetch list**": the daemon asks `GET {endpoint}/models` with your key and you pick from the dropdown (you can also hit "Type it instead"). If listing fails (wrong key, wrong URL, not supported by that service), the reason is shown verbatim and you can still type the id.
4. **API style**: `OpenAI chat completions` (`POST {endpoint}/chat/completions`, the default, and what most OpenAI-compatible services use) or `OpenAI responses` (`POST {endpoint}/responses`). Keep the default if unsure.
5. **API key**: the "API key" block further down the same page; click "Save key". It is written to `%USERPROFILE%\.ergo\secrets\custom-model-api-key.txt` (DeepSeek's is `deepseek-api-key.txt`), takes effect right away with no restart, and you can also place the file by hand as in [step 4](#2-install) (that environment variable is `CUSTOM_MODEL_API_KEY`). **Do this after the custom provider is selected and the endpoint and model id are saved**: "Save key" writes the file of whichever provider is selected, so a key entered while DeepSeek is selected goes into DeepSeek's file. If you installed an older version and upgraded, add a `CUSTOM_MODEL_API_KEY` entry (`from: file`, `optional: true`, pointing at that file) to `ergo-daemon.yaml` in the supervisor as the example does; otherwise the key is gone after the daemon restarts (entering it on the page again also works).
6. Hit "**Connection test**": one very short request comes back as either connected (with time to first token) or the reason it failed. For a custom provider it tests the model id from step 3.

Things worth knowing:

- **"Fetch list" and "Connection test" save this block first**: the daemon takes the key of the provider selected in settings, so only after it is saved as "custom" does it have that key. A "Saved. Takes effect from the next new session" message confirms it.
- **One session sticks to one model**: changing the provider or the model applies from the next new session; the secretary's main session, a project maintainer's chat and scheduled tasks start a fresh session on the next round with a handoff summary (the chat notes "switched to X"); a running task never switches midway.
- **A custom provider has a single model**: the "Default model" row shows it, and every agent's model uses it too (thinking levels still come from each row). Switching back to DeepSeek restores the model ids those rows already had.

**What does not follow the switch** (still DeepSeek-only after you move to a custom provider):

- **The nightly memory consolidation**: the memory keeper always uses DeepSeek (`DEEPSEEK_API_KEY` / `secrets\deepseek-api-key.txt`). Without a key that night's consolidation is skipped (no material is lost; it continues the next night once a key is in place).
- **Web search and page reading**: these go through DeepSeek's own search and page-fetch APIs, so they need a DeepSeek key too (searching with the browser directly and Tavily are unaffected; see [8.4](#84-web-search-and-reading-pages)).
- So **don't delete your DeepSeek key**: after switching to custom, "Save key" on the page writes the custom file and leaves DeepSeek's alone. To change the DeepSeek key, switch back to DeepSeek and save it there, or place the file by hand as in step 4.
- **The token price table is DeepSeek-only**: usage for a custom model is still recorded as it happens (input, output, cache), but priced at 0, so its cost under **More · Usage** is a rough estimate (it comes out as 0). Don't read it as a bill.

**A custom model's capabilities are registered as estimates** (you can't enter these in Settings):

- **Text only**: registered as text-only ("we don't know whether that service accepts images"), so pictures in a chat are not handed to it as images (its "Image understanding" row under Settings · Models shows "can't see images" per the model catalog by default; that switch is generic, so if you know your service does take images you can turn it on — it may still reject the request).
- **No thinking**: registered as not supporting thinking levels, so the thinking level on its row has no effect.
- **Context window 128k, at most 8192 tokens generated per call**: estimated from typical OpenAI-compatible services. A larger window just goes unused; a smaller one may be truncated or rejected by that service.

**Switching back to DeepSeek loses nothing**: the endpoint, model id and API style you filled in stay in the settings and the key stays in `custom-model-api-key.txt`, so choosing "Custom" again needs no re-typing.

---

## 6. Access from outside (phone, tablet)

By default ergo is only used on this PC (`http://127.0.0.1:8810/`). There are three ways to use it from a phone or tablet; **the first is recommended**.

> **Hard rule**: all three must connect only to ergo's **external port 8811**, where every request needs a device credential and new devices must be approved on your PC. **Never expose the local port 8810 through Tailscale Serve, a tunnel or a reverse proxy**: requests from the local port are trusted automatically, so exposing it lets your whole tailnet (or the whole internet) in without authentication.

Whichever you use, a new device first sees the pairing page with a device name, a 6-digit code and an 8-character fingerprint → a pairing request card appears in ergo's **Inbox** on your PC; approve it after checking they match → back on the phone, tap "Enter ergo". Manage devices later under **More · Settings · Paired devices** (extend, revoke, delete). Pending requests expire after 5 minutes; one source can request at most 5 times per 10 minutes.

| | Option 1: Tailscale (recommended) | Option 2: self-hosted Headscale (advanced) | Option 3: VPS + tunnel + nginx (public) |
|---|---|---|---|
| Needs | Tailscale on PC and phone, same account | A VPS running Headscale | A VPS and a domain certificate |
| Who can open it | Only devices in your tailnet | Only devices in your tailnet | Any browser (pairing is the only gate) |
| HTTPS certificate | Provided by Tailscale | certbot on the VPS | certbot on the VPS |
| Difficulty | Easiest | Medium | Hardest |
| Notes | Sign-in uses a Google / Microsoft / GitHub… account; relays are abroad and may be slow in mainland China | You can run your own relay, fast in China | Exposed to the internet; strangers can see the pairing page |

### 6.1 Option 1: Tailscale (recommended)

The outside-access screen in the setup wizard introduces these three options; connecting Tailscale is three manual steps:

1. Install [Tailscale](https://tailscale.com/download/windows) on the PC and sign in; enable MagicDNS and HTTPS certificates in the Tailscale admin console.
2. Have Tailscale serve local port **8811** over HTTPS to your tailnet (8811 only):

   ```powershell
   tailscale serve --bg --https=443 http://127.0.0.1:8811
   ```

3. Install Tailscale on the phone, sign in to **the same account**, open `https://<pc-machine-name>.<your-tailnet>.ts.net/` and pair as above.

### 6.2 Option 2: self-hosted Headscale (advanced)

For people who want to own the control server, or need speed inside China. On a Debian / Ubuntu VPS, one command installs [Headscale](https://github.com/juanfont/headscale) (optionally with your own DERP relay):

```powershell
lsm vps setup headscale --host root@<VPS IP>    # inside packages\supervisor; then lsm vps status shows whether it works
```

The Tailscale clients on the PC and phone both log into your own Headscale; the supervisor's **tailnet entry** then gives ergo an HTTPS address reachable only inside your tailnet (certbot on the VPS issues a real certificate, Headscale's DNS records point the name back to your PC, and a local gateway terminates TLS and forwards to 8811):

```powershell
node bin\lsm.mjs tailnet ergo-daemon on <name>
```

What each step does is in [vps.md](../packages/supervisor/docs/vps.md) and under "Optional features · tailnet entry" in the supervisor's [README](../packages/supervisor/README.md). **The VPS side has not been tried on a real Debian machine yet** (only the PC side has been run, on Windows), so follow the docs step by step the first time.

### 6.3 Option 3: VPS + ssh reverse tunnel + nginx (public)

Path: `https://ergo.<VPS IP>.sslip.io` → nginx on the VPS (HTTPS) → `127.0.0.1:18811` on the VPS → ssh reverse tunnel (`ergo-tunnel`) → the daemon's external port 8811 on your PC. ergo never connects to the VPS itself.

One command sets this up: `lsm vps setup tunnel --host root@<VPS IP>` (inside `packages\supervisor`); `lsm vps status` shows whether it works. If the VPS already has sites, `lsm vps site add` / `site remove` / `certs` / `scan` handle certificates and sites — see [vps-https.md](../packages/supervisor/docs/vps-https.md). **The VPS side has not been tried on a real Debian machine yet.**

If you would rather not use that command, you do each step below yourself.

1. **Config**: fill in `publicAccess` in `ergo.json` (see `config\ergo.example.json`): the VPS public IP, ssh user, absolute path to the ssh private key; `nginx.listen` (`443 ssl` if nginx listens on 443 directly; if a SNI-based front door sits in front, the local port it forwards to, e.g. `127.0.0.1:8443 ssl`); `nginx.certificateDir` (where the existing certificate lives).
2. **Certificate**: with your existing Let's Encrypt setup on the VPS, add `ergo.<VPS IP>.sslip.io` to the certificate.
3. **Preview** the nginx config: `npm run deploy:nginx -- --print` (prints only; does not connect).
4. **Deploy**: `npm run deploy:nginx`. It ssh-es to the VPS, writes the site config, reloads only if `nginx -t` passes, and restores the previous config otherwise.
5. **Register the tunnel**: copy `deploy\lsm\ergo-tunnel.example.yaml` to `registry\services\ergo-tunnel.yaml` in the supervisor's data directory and fill in the placeholders (repository path, ssh key path, VPS user, VPS address); in `ergo-daemon.yaml` uncomment the `exposure:` block at the end and fill in the VPS address. Then:

   ```powershell
   node bin\lsm.mjs validate
   node bin\lsm.mjs reload
   node bin\lsm.mjs start ergo-tunnel
   node bin\lsm.mjs autostart ergo-tunnel on
   ```

6. Open `https://ergo.<VPS IP>.sslip.io/` on the phone and pair.

Behind a SNI front door without `proxy_protocol`, nginx sees every client as 127.0.0.1: the pairing card says the source cannot be identified, and pairing rate limits become global (still safe, but if strangers spam requests your own pairing waits 10 minutes too). For per-client limits, enable `proxy_protocol` on the front door and set `nginx.clientAddress` to `$proxy_protocol_addr`; this affects every site behind that front door, so it is your call.

---

## 7. On your phone

### 7.1 Browser

Once outside access is set up and the phone is paired ([Section 6](#6-access-from-outside-phone-tablet)), opening that address in the phone browser gives you all of ergo; you can add it to the home screen. After a server update, open pages show "new version, tap to refresh" within seconds.

### 7.2 HarmonyOS app

The HarmonyOS app is a native shell running the same web UI, plus native recording (instant push-to-talk without holding the microphone), system notifications and file downloads. For now you build and sign it yourself:

1. Install [DevEco Studio](https://developer.huawei.com/consumer/en/deveco-studio/); enable developer mode and USB debugging on the phone and connect it by USB.
2. Run `npm run build:harmony` once in the ergo directory; it generates your local `frontend\harmony\build-profile.json5` (not committed).
3. Open `frontend\harmony` in DevEco Studio, File → Project Structure → Project → Signing Configs, sign in with a Huawei account and tick Automatically generate signature. The signing material stays in your local `.ohos\config\`, never in the repository.
4. Run `npm run build:harmony` again to get `frontend\harmony\entry\build\default\outputs\default\entry-default-signed.hap`.
5. Install it with DevEco's hdc (`<DevEco>\sdk\default\openharmony\toolchains\hdc.exe`):

   ```powershell
   hdc list targets
   hdc -t <device> install -r frontend\harmony\entry\build\default\outputs\default\entry-default-signed.hap
   hdc -t <device> shell aa start -a EntryAbility -b com.catmaniii.ergo
   ```

6. On first launch enter ergo's external address ([Section 6](#6-access-from-outside-phone-tablet)) and pair as prompted.

The app's final bundle name is `com.catmaniii.ergo` (decided 2026-10-30; `app.json5` in the project already uses it). Click Signing Configs -> "Automatically generate signature" once more in DevEco and the build from then on carries that name - put it after `-b` in step 5.

---

## 8. Optional features

### 8.1 Push-to-talk (local speech recognition)

1. Install Python (3.9+) and faster-whisper in it: `python -m pip install faster-whisper`. With an NVIDIA GPU and CUDA it runs large-v3 on the GPU; otherwise it falls back to the small model on CPU.
2. Put that Python's path in `ergo.json`: `{ "voice": { "recognizer": { "python": "D:\\apps\\python311\\python.exe" } } }`.
3. Restart `ergo-daemon`. The first recognition loads the model; see the status under **Settings · Voice**.

You can also let the supervisor host recognition as a separate service (`deploy\lsm\ergo-asr.example.yaml`, with `voice.recognizer.mode` set to `"lsm"`), so it restarts independently of ergo.

Neither voice piece (the Python part for recognition, audio.cpp for synthesis) has a one-click install yet; set them up by hand as above and in [8.2](#82-voice-replies-local-speech-synthesis). They will move into **Settings · Components** later.

### 8.2 Voice replies (local speech synthesis)

- ergo synthesizes speech with a local [audio.cpp](https://github.com/0xShug0/audio.cpp) service (a third-party open-source TTS server, optional), also hosted by the supervisor under the id `audiocpp` at `127.0.0.1:8090`.
- Put the service's model id in `voice.speech.model` in `ergo.json`; choose the reference voice under **Settings · Roles & voices**.
- **A default reference voice ("Xiaoman") comes with the program**, so you hear a voice as soon as it's set up — no need to record and import your own first. On the first start, if the data directory's voices area has no reference voice at all, ergo installs it and makes it the one in use. It behaves like any voice you import: you can switch to another one, or delete it. Once deleted it isn't installed again by itself — to have a voice again, import your own recording (the built-in one is synthetic, not anyone's real voice: generated with FireRedTTS3, no human recording, 8.5 s).
- Without it, voice replies fall back to text, with a note in the chat.

### 8.3 Embedding model for semantic search

Click "Install" under **Settings · Components**, or in the ergo directory:

```powershell
npm run download-model      # quantized bge-m3, ~570 MB, into the data directory's models area; re-run to resume
```

It picks the fastest of Hugging Face, hf-mirror and ModelScope and uses the system proxy. Without the model, keyword search still works.

### 8.4 Web search and reading pages

Agents use a local Chrome or Edge, found automatically. If none is found or you want a specific one, set its exe path in `web.browserPath` in `ergo.json`.

### 8.5 Skills, MCP and data sources

- **Settings · Skills & MCP**: import skills and register MCP servers (credentials are read from environment variables you set in the supervisor's `ergo-daemon` entry), then add them to project or task toolkits.
- **Settings · Data sources**: connect Google (calendar, contacts), Looki and phone data; a shared import folder lets the matching plugin pick up files you drop in.

### 8.6 Claude Code

If [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is installed and signed in on this PC, project and task owners can work through it (on your own subscription), with ergo's guard still checking every tool call; ergo can also take over your existing Claude Code sessions.

Its Agent SDK (`@anthropic-ai/claude-agent-sdk`) is under Anthropic's own license, not open source, so ergo treats it as an **optional dependency**: if it is missing, **Settings · Plugins** shows Claude Code as not installed and how to install it (run `npm install --no-save @anthropic-ai/claude-agent-sdk@<version>` in the ergo directory; the version is in `optionalDependencies` of `packages/daemon/package.json`), then click Enable. Nothing else is affected.

---

## 9. Backup and restore

- Every night at 03:30 the daemon takes a consistent snapshot of the data directory into its `backups\`. If the PC was off, it catches up on the next start.
- Set `backup.syncDir` in `ergo.json` to also copy each snapshot into a sync folder (a NAS, home storage, or a cloud-drive client's folder): `{ "backup": { "syncDir": "D:\\NAS\\ergo-backup" } }`.
- **Back up now**: **Settings · Backup** → "Back up now", or `npm run backup` in the ergo directory (works with the daemon running; the last line says whether it succeeded; log in `logs\backup.log` in the data directory).
- **Use your own scheduler**: set `"backup": { "schedule": "external" }` and the daemon stops backing up on its own; have your scheduler run `npm run backup -- --scheduled`. You get a reminder if nobody backs up for two days.
- **Restore**:

  ```powershell
  # in packages\supervisor: stop the daemon first
  node bin\lsm.mjs stop ergo-daemon
  # in the ergo directory: the data directory must match the supervisor entry
  $env:ERGO_DATA_DIR = "$env:USERPROFILE\.ergo"
  D:\apps\node22\node.exe packages\daemon\src\restore.ts --list                   # list snapshots
  D:\apps\node22\node.exe packages\daemon\src\restore.ts 2026-10-15               # restore a day
  D:\apps\node22\node.exe packages\daemon\src\restore.ts 2026-10-15 --from sync   # local copy broken: restore from the sync folder
  # back in packages\supervisor: start it again
  node bin\lsm.mjs start ergo-daemon
  ```

  What was there before is moved to `backups\pre-restore-<time>\`, keeping the latest 2. The restore command refuses to run while the daemon is running.

---

## 10. Update, stop, uninstall

**One-line installs**: `ergo update` (installs the new version side by side and switches when ergo is idle, keeping the previous one), `ergo rollback` (back to the previous version), `ergo uninstall` (removes PATH entries, the supervisor registration and autostart, and asks whether to delete your data). Which version is in use is decided by `current` (a one-line text file) in the install directory; `ergo version` shows what is running.

**Source installs**:

```powershell
cd D:\apps\ergo
git pull
npm ci                  # when dependencies changed
npm run build:web
cd packages\supervisor
node bin\lsm.mjs restart ergo-daemon --when-idle   # restart after current work finishes
```

- If only the web UI changed, no daemon restart is needed; open pages (including a HarmonyOS app left open) prompt to refresh within seconds.
- See [CHANGELOG](../CHANGELOG.md) for what changed in each version.

**Stop**:

```powershell
node bin\lsm.mjs autostart ergo-daemon off
node bin\lsm.mjs stop ergo-daemon --when-idle
```

Remove the supervisor's own autostart with `node bin\lsm.mjs uninstall-autostart`. Your data is in `%USERPROFILE%\.ergo` and the supervisor's in `%LOCALAPPDATA%\ergo\supervisor`; deleting them is up to you.

---

## 11. Troubleshooting

**Run a checkup first**: **More · Settings · Data & devices → "Checkup"** (`#/more/doctor`) runs eight checks — ports, Node, pi, the service manager, the model key, components, disk, outside access — and gives the fact it found plus how to fix each one; "Run again" is in the top right. Everything it looks at is local: no network (other than probing ergo's own ports), no model calls, no settings changed.

**Logs**: the daemon's output is in `logs\ergo-daemon.out.log` under the supervisor's data directory, and live in the supervisor's web UI; ergo's own health: <http://127.0.0.1:8810/healthz>.

| Symptom | Likely cause | Fix |
|---|---|---|
| The daemon won't start; the first log line says "Windows only" or the Node version is wrong | Wrong OS or Node | Use Windows 10 / 11 and Node 22 (≥ 22.19); check that `<专用 Node 路径>` in the entry points to it |
| Won't start: port in use | 8810 / 8811 taken by another program (name and PID are in the log) | Close it, or change `ports` (and both 8810s in the entry) |
| Won't start: another instance uses the same data directory | One was started by hand, or an old one didn't exit | Stop it (supervisor web UI or Task Manager), then let the supervisor start ergo |
| The page shows 503 and says `npm run build:web` | The web UI isn't built | Run `npm run build:web` in the ergo directory |
| It says "no model configured" or every reply errors | Key missing or wrong, or out of credit | Enter a new key under **Settings · Models** (or check `secrets\deepseek-api-key.txt`, just the key), then run the connection test |
| Commands in tasks keep failing: Git Bash not found | Git for Windows missing, or WSL's `bash` comes first on PATH | Install Git for Windows; `where bash` should list `C:\Program Files\Git\bin\bash.exe` first |
| Push-to-talk does nothing / recognition unavailable | Python path not set, faster-whisper missing, GPU unavailable | See the status in **Settings · Voice**; set up per [8.1](#81-push-to-talk-local-speech-recognition) |
| Voice replies are text only | TTS service not running, or `voice.speech.model` is still the placeholder | See [8.2](#82-voice-replies-local-speech-synthesis); the note in the chat says why |
| Memory search misses things with similar meaning | Embedding model not installed | Install under **Settings · Components**, or `npm run download-model` |
| The phone can't open ergo or stays on the pairing page | Outside access not set up, or the request expired / was rate-limited | Make sure 8811 is what's exposed; approve the request in **Inbox** on the PC within 5 minutes; after repeated failures wait 10 minutes |
| The phone says "this device has been revoked" | It was revoked under Paired devices | Tap "Request pairing" to apply again |
| The supervisor shows ergo yellow (degraded) | An enabled plugin failed to load | See `reasons` in `/healthz`, or the plugin's note in **Settings · Plugins** |
| Every backup says it wasn't copied to the sync folder | `backup.syncDir` is still the example placeholder, or the folder is missing | Set a real absolute path, or remove the item |
| Web tools say no browser was found | No Chrome / Edge, or installed somewhere unusual | Set its exe path in `web.browserPath` |
| Install or update won't go through: the antivirus says "unknown publisher", kills the process, or the installed files vanish later | Security software such as 360 blocks programs it does not recognise (`bin\ergo.exe` or the whole install folder) | Add `%LOCALAPPDATA%\Programs\ergo` to the security software's trusted list and install again; if the command still runs, use `bin\ergo.cmd` (the same command as `ergo.exe`); or install from npm (`npm i -g ergo-ai`, needs Node 22). Your data is in `%USERPROFILE%\.ergo`; reinstalling leaves it alone |
| `ergo update` says it could not switch, or `ergo version` still shows the old version | The `current` file names a version that is not installed properly under `versions\` (half copied, edited by hand) | Check what `%LOCALAPPDATA%\Programs\ergo\current` says, whether that folder exists under `versions\` and has `ergo.json` in it; if not, run `ergo update` again, or install again (your data is untouched) |

**Reporting a problem**: [open an issue](https://github.com/catmaniii/ergo/issues/new/choose) on GitHub and fill in the template: ergo version (**Settings · About Ergo**), Node version (`node -v`), pi version (`overrides` in the root `package.json`) and how you installed — the version, Node and pi are also on the checkup page at a glance. Please don't report security issues publicly; see [SECURITY.md](../SECURITY.md).

**"Ticket N" in code comments**: these are internal development record numbers. The tickets themselves are not public, which doesn't affect understanding the code.
