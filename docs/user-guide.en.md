[中文](user-guide.md) | **English**

# ergo User Guide

How to install, use, configure and troubleshoot ergo (二狗 in Chinese). For what ergo is and why, see the [README](../README.en.md); to change the code or write plugins, see the [Developer Guide](developer-guide.en.md).

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
- **Disk**: a few hundred MB for the program; ~570 MB for the semantic-search embedding model; about 1 GB for speech recognition (both optional).

**Optional** (ergo works without them; the matching features stay off)

| Install | Gives you | See |
|---|---|---|
| Git for Windows | Agents can run bash commands (used a lot in tasks); install from source | [Install from source](install.en.md#install-from-source) |
| Speech recognition (install it in **Settings · Components**) | Push-to-talk, recognized locally | [8.1](#81-push-to-talk-local-speech-recognition) |
| Speech synthesis (installed under **Settings · Components**) | ergo answers with voice | [8.2](#82-voice-replies-local-speech-synthesis) |
| Chrome or Edge | Agents can search the web and read pages | [8.4](#84-web-search-and-reading-pages) |
| Tailscale, or a VPS | Use ergo from your phone or tablet away from home | [Section 6](#6-access-from-outside-phone-tablet) |
| Claude Code, signed in on this PC | Project and task owners can work through your own Claude Code subscription | [8.6](#86-claude-code) |
| DevEco Studio and a HarmonyOS phone | The native HarmonyOS app | [7.2](#72-harmonyos-app) |
| Android Studio and an Android phone | The native Android app | [7.3](#73-android-app) |

---

## 2. Install

How to install (one line, npm, from source) has its own document: [Install, update and uninstall](install.en.md).

---

## 3. First run

### 3.1 Setup wizard

It lives at `#/more/setup`, also the "Setup wizard" row at the top of the **More · Settings** list. Five steps: language / how to address you / the assistant's name → model key → capabilities (which plugins and components you want, including the embedding model for semantic search, which you can download right there; see below) → pair your phone by QR code → an explanation of the safety defaults; after the five steps there is one more screen about outside access, walking through the three options in [Section 6](#6-access-from-outside-phone-tablet). Every step can be postponed with "later"; when all are done it says you're set. You can come back to it from Settings at any time.

Until a model key is configured, the chat page shows a banner at the top (close it with the × on the right; this device remembers it, so it won't come back).

**The Capabilities step** lists plugins (memory, calendar, voice, browsing, Claude Code) and components (embedding model, speech recognition, speech synthesis), each with one line on what it does and how much it downloads:

- The embedding model and memory are ticked by default (memory is already on after a fresh install); voice isn't, tick it if you want it. If Claude Code is installed on this computer it's ticked too (the list says "install if detected").
- "Start" downloads or enables them in the background. You can go on to the next step, and downloads continue if you close the page. Progress and the reason for anything that failed show up here; failures can be retried or skipped and redone later in **Settings · Components**.
- Voice models need you to confirm the license before the download ([8.1](#81-push-to-talk-local-speech-recognition), [8.2](#82-voice-replies-local-speech-synthesis)); nothing is downloaded without it.
- Below that it shows what's installed now (components with versions).
- The **Start at boot** switch shows whether it's on and can turn it on or off (the same as `ergo svc install-autostart` and `ergo svc uninstall-autostart`). If the task points to a service manager elsewhere, or ergo runs from source, it only shows the state; run the commands yourself to change it. Which services start automatically is set in the service manager: open its page on this computer (by default <http://127.0.0.1:7420>) or run `ergo svc autostart <id> on|off`.

### 3.2 Doing it without the wizard

On this computer open <http://127.0.0.1:8810/>. Requests on the local port are trusted automatically, no pairing needed.

1. **More · Settings · Models**: click the connectivity test to confirm the key works.
2. **More · Settings · Roles & voices**: name your assistant; pick a visual style under **Appearance & style**.
3. **Say something**, e.g. "remind me to drink water in two minutes". A reminder card appears in the chat; when it is due, a banner shows at the top and an item lands in your inbox.

**Two safety settings are off for new installs** (the setup wizard's "Safety defaults" step tells you about them; they are also at the top of **More · Settings · Watch categories**. Tick them if you want it more careful, effective immediately):

- **Ask me before risky things** (off by default): when ticked, risky actions in conversations (reading or writing files outside the agent's workspace, sending things out…) first show an approval card and wait for you; tasks also ask before doing something their plan did not authorize. Unticked, most of these just happen and are logged; only the most sensitive ones (sending in your name, accounts and passwords, irreversible commits, deleting or changing files outside the workspace) still ask.
- **Stop tasks that go over budget** (off by default): when ticked and a task step exceeds its planned budget, the owner explains its progress first; at twice the budget it stops and waits for you, and you can add budget to continue. Unticked, usage is only recorded.

  How the budget works: the owner only estimates how many tool calls each step takes. Ergou works out the token budget when the step starts (estimated calls × what each recent call actually counted, plus a rough cost at the ledger's prices; custom models without a price show no cost). If earlier steps took far more or fewer calls than estimated, later steps scale with them (at most 5 times); they never shrink. Cached input counts as one tenth, so this number differs from the real tokens on the Usage page. The Usage page and the ledger are not affected.

  Once stopped, the owner can only declare the step done or send a plan change adding budget; if the work is finished, it can declare that itself. When you tap "Add budget and continue" or confirm a plan change adding budget, usage for that step counts again from that moment.

They are stored in the config file as `guard.conversationApprovals` and `tasks.thresholds.budgetControl`, written when the daemon first starts, and are ordinary settings after that.

---

## 4. Everyday use

The UI is designed phone-first and switches to multi-column layouts on wide screens. Main navigation: **Secretary, Tasks, Projects, Inbox, Browse, Calendar, More** (Usage, Memory and Settings are under More; on wide screens they sit in the side rail).

### 4.1 The secretary

The secretary is your personal assistant (you choose its name). It only understands you, relays messages and hands out work; it never touches your projects itself.

- Type or hold to talk; it can read long replies aloud.
- On a computer, Enter sends right away and Ctrl + Enter starts a new line; if you prefer Shift + Enter, change it under **More · Settings · Send and new line** (this device only). On phones and tablets Enter still starts a new line and you send with the button.
- Things that take one step (reminders, remembering something, a quick lookup) it does directly; anything that takes time becomes a task or project with a dedicated owner.
- Owners write to the secretary when they make progress; their letters fold into one line, and the secretary passes them on to you.
- Once an owner has its own role and voice (**More · Settings · Roles & voices**), its updates are read in that voice: the secretary opens, then the owner speaks, as one voice message. Long-press "Show text" to see who said what. This happens when a task with "Read out when done" finishes; when a task or project with spoken updates on sends an update (a project's switch is "Read updates aloud" on its page, off by default); and when you type or say a question about a task or project that has written to the secretary before (with nothing written yet there's nothing to pass on, so the secretary answers in its own voice). With the switch off and no question from you, updates stay as text. An owner with no voice of its own, the same voice as the secretary, or a deleted voice just means one message in the secretary's voice.
- Type `/` in the input box for slash commands (each with a description and argument hints).

### 4.2 Tasks: three kinds × three triggers

Click **New task** (or just tell the secretary):

| Kind | Good for | How it runs |
|---|---|---|
| Plain task | Download a video, look something up | A background agent just does it; the secretary tells you when it's done |
| Workflow | The same few steps every day | Steps are laid out in advance and authorized once; every run is checked step by step and pulled back if it drifts |
| Long-running task | Build a tool, write a research report | Runs in stages with acceptance at each stage; the plan can change mid-way |

Triggers: **once now**; **scheduled** (optionally "on my working days", with Chinese and Singaporean holidays and make-up days); **on an event** (another task finished, a new file arrived in a folder, the project's own service reported an event…). Write "every Monday at 8 am…" in the description and the schedule is set from it.

**Watching data without spending tokens: let a project's service report events.** If something has to watch comments, prices or logs all the time, the owner doesn't need to wake up on a schedule to look. Tell the project's owner "write a small service to watch this and wake you when something's off". It writes a small service that uses no model and adds two items to the operations plan: one puts the service online, the other says what to do when "a project service reports 'comment-anomaly'". Confirm once on the card and the service goes live. The owner sleeps and spends no tokens until the service finds something.

- The event name has to be in the operations plan you confirmed. A name that isn't there wakes nobody and costs nothing; to add one, the owner sends another card.
- In the project page's "Operations plan" section, the service and the item waiting for its event list the recent events: name, time, and whether it woke the owner. Events that woke nobody say why (not in the plan, task paused, too fast, data too large).
- Data from a service isn't something you said: it doesn't go into materials or memory and doesn't count as your authorization. The owner receives it marked as data, not instructions, so "ignore previous instructions" inside it is not obeyed.
- A burst is queued and merged into one batch, never run in parallel. Each service can report at most 30 times a minute and 8 KB per event (change with `eventSources.serviceReportsPerMinute` and `serviceDataMaxBytes`). Repeated failures still pause the task automatically until you deal with it.
- While ergo is stopped, services can't report and ergo doesn't queue for them. The service decides whether to report again later.
- These events can only be used in an operations plan, not in the New task dialog. Services you host by hand in the service manager, outside any project, get no credential.

Writing a service yourself: when it goes live its environment has `ERGO_NOTIFY_URL` and `ERGO_SERVICE_TOKEN`. Report like this (`data` is optional):

```python
urllib.request.urlopen(urllib.request.Request(os.environ["ERGO_NOTIFY_URL"], json.dumps({"event": "comment-anomaly", "data": {"count": 3}}).encode(), {"Authorization": "Bearer " + os.environ["ERGO_SERVICE_TOKEN"], "Content-Type": "application/json"}))
```

```js
await fetch(process.env.ERGO_NOTIFY_URL, { method: "POST", headers: { authorization: "Bearer " + process.env.ERGO_SERVICE_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ event: "comment-anomaly", data: { count: 3 } }) });
```

Or run the command: `ergo notify comment-anomaly --data "{\"count\":3}"`. Exit codes: 0 reported, 1 refused by ergo (the reason is on stderr), 2 wrong usage, 3 can't reach ergo. On a machine running a `git clone`, `ergo` isn't on `PATH`: run `npm run ergo -- notify comment-anomaly` in the ergo folder, or send the request directly. Right after installing, before you log in again, the service manager's `PATH` may not have it yet either. The request works with every kind of install, so prefer it in service code.

**Why you can hand off long tasks with confidence**:

- The owner first submits a **plan card**: the stages, what each delivers, how it is accepted, which tools it uses, and which operations are pre-approved (kind, scope, count, expiry). Confirming once is the authorization; you can untick or narrow any item.
- Each stage passes scripted checks and then an independent reviewer agent; off-plan actions are flagged and pulled back where possible.
- Changing the plan only pauses the affected stages; you confirm once on a plan-change card.
- If the daemon is killed or the PC restarts, work resumes where it stopped.

### 4.3 Projects

A project is something long-lived (a website, a tool) with a dossier (charter, spec, progress), a working directory and a fixed owner. Once you start a project, the owner speaks first, and it already has the paths and limits you gave your assistant, so you don't have to repeat them. The owner's work is queued as work orders, one at a time; after each work order a second model checks whether it strayed out of scope. When the first version is done, you decide: put it into use, keep building, or abandon and archive. Once a project goes live as a service, the supervisor hosts it and you can open its pages in ergo's built-in browser.

When the owner is writing a local service, it can reach this machine (`127.0.0.1`, `localhost`) to debug even with the network switch off; anything else stays blocked. On the put-in-use card, operations that need the running service to test are marked "Checked after it's up" and don't count as missing: Ergo checks them itself once the service is up. If a service fails to come up or goes down, the owner finishes its current work order before looking into it.

### 4.4 Inbox

Everything that needs your decision lands here: approvals, plan confirmations, requests for help, pairing requests, due reminders… Time-limited items come first. You can also act on them in the conversation where they appeared.

### 4.5 Three-level timeline zoom

Task, project and secretary conversations can be pinched (on a PC: hold Ctrl and scroll, or use the title-bar button): **conversation** shows everything, **key points** one line per item, **overview** the whole job as one colored bar. When zoomed out, markers for approvals, pull-backs, acceptance and watch-category hits stay pinned in the margin, with lines pointing to where things happened.

### 4.6 Tool-call details and spending

- Open any tool call in a conversation: what it did, which watch category it hit, how it was handled, whether it was within the authorization, and what it actually changed, in plain words.
- **More · Usage**: a token ledger records every model call against the task, stage and agent, with estimated cost.

### 4.7 Memory

ergo keeps a copy of everything you said on this PC (immutable, indexed by keyword and vector), and every night at 3 am the **memory curator** distills it into conclusions backed by evidence.

- This is a **plugin**, shown as **Memory Module · Subtext**, and it is marked **Experimental**: still being polished, so its behaviour and the data it stores may change. Everything stays on this computer; you can turn it off any time in Settings · Plugins (the data stays and comes back when you turn it on again), or delete things with the bulk delete in Memory · Materials, or remove the plugin there with "delete its data along with it" ticked.
- **More · Memory**: files (basic facts about you and your family), conclusions (each one opens to its evidence, support and counter-evidence, competing explanations and revision history), a question box, and raw materials.
- Confident conclusions are used by the secretary; uncertain ones become a casual question at a convenient moment.
- To make it remember something on purpose, just tell the secretary "remember this: …". It stores your own words (marked as manually remembered), so later searches find it and you can open the original line.
- Say "forget…" or "don't infer from this", or correct and delete in the memory page; a hard delete also scrubs every place that referenced it.
- To discuss or change your memory in depth, talk to the memory curator directly ("Chat with the memory curator" at the top of the memory page). It may also invite you to a "getting to know you" interview, one topic at a time; you can always decline.

### 4.8 Calendar, reminders, built-in browser

- **Calendar**: working days and holidays for two regions, manual marks, the day's reminders, scheduled tasks and each run; external calendars (phone calendar, Google Calendar…) can be connected through data-source plugins.
- **Reminders**: just tell the secretary; the reminder card lets you reschedule or cancel; due reminders show at the top of the page, or as system notifications in the phone app.
- **Browse**: a built-in browser that opens your project services' pages and renders attachments; tap the floating button with ergo's icon next to a web form's input box to have ergo fill it in. Long-press an image, video, link or text on a page (right-click with a mouse) and the system menu appears as usual, along with an ergo button beside it: tap to type or hold to talk, and say whatever you want done with it, such as "what is this", "translate this into English", "remember this picture", "download it to my phone" or "send it to the bookkeeping project". The button has no menu of actions; ergo does what you say. Words written on the page don't count as yours, and things like downloading only happen when you ask in that turn. The button won't appear on pages that block long-press or cover content with a transparent layer. Seeing what's in an image needs a model that can read images; without one, ergo tells you so.

### 4.9 Plugins

**More · Settings · Plugins** lists the installed plugins and lets you disable, enable or remove them (hot-pluggable, no restart). Built in: Reminders, Memory, Calendar, Voice, Built-in browser, Claude Code, plus the data-source plugins Data source - Google, Data source - Looki wearable camera and Data source - Phone. Disabling a plugin only hides its pages and tools; its data stays. When removing, you can choose to delete its data too.

---

## 5. Settings and config files

### 5.1 The settings page

**More · Settings** has four groups:

| Group | Contains |
|---|---|
| Identity | My name, personal files, roles & voices (assistant name and voice), language, appearance & style, voice |
| Abilities | Models, skills & MCP, plugins, components (large downloads on demand), Claude Code, browsing & form filling |
| Rules | Watch categories (which operations to tell you about and how to handle them), system prompts, workday rules |
| Data | Data sources, Authorized folders, delete materials, full tool-call content, backup, paired devices, checkup, About Ergo |

**Watch categories** are the heart of ergo's guard. Built-in ones include spending money, sending in your name, deleting or overwriting, irreversible commits, accounts and security, and leaving the project directory; you can add your own. Each has six possible handlings: just do it and log, do it and tell me, only if listed in the plan, ask me first, hand it to me, never.

**Authorized folders** (Settings · Data & devices · Authorized folders): folders on your computer, up to 20. Once authorized, every agent can read files in them without asking you, and they don't need to be written into a plan; this also works in the phone app's built-in browser: Ergo looks there first when finding photos and files, and when handing files to a web page's upload box. Three things to keep in mind:

- Only reading is opened up. Writing, deleting and overwriting keep the usual rules, and running scripts there or `cd`-ing in doesn't count as reading;
- What gets read is sent to your model provider, so don't authorize folders that hold keys or passwords. Secret files such as `.env` and private keys, and Ergo's own data and program directories, stay off limits even inside an authorized folder; a whole-directory search (`grep -r`) can't tell the secret files inside apart, though;
- Sessions run by Claude Code: the guard re-reads the list on every call, so the next call follows the new list; Claude Code's own read-only allowance catches up the next time its process starts. In the "don't ask (deny unless allowed)" permission mode, a newly authorized folder can't be read until then, and reading elsewhere through Bash never works in that mode.

No agent can change this list itself: add or remove folders on this page, or say so in a chat and press "Run" on the card.

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
| `voice.recognizer.mode` | How speech recognition connects: `spawn` (ergo starts Python), `lsm` (a recognition service hosted by the supervisor), `audiocpp` (the model with the id `asr` on the audio.cpp service). Written when you install the recognition model from the Components page, removed when you remove it | `spawn` |
| `voice.recognizer.python` | `python.exe` that has faster-whisper (only `spawn` uses it) | `python` on PATH |
| `voice.speech.url` / `voice.speech.model` | TTS service address and model | `http://127.0.0.1:8090` |
| `web.browserPath` | Chrome / Edge used for web access; auto-detected if omitted | — |
| `backup.time` / `backup.syncDir` / `backup.schedule` | Nightly backup time, extra copy to a sync folder, who schedules it (can be changed in **Settings · Backup**, effective right away) | 03:30 / none / `"internal"` |
| `memory.maxModelCalls` / `memory.enabled` | Model calls per nightly consolidation, whether this PC runs it | 200 / `true` |
| `media.maxUploadBytes` | Max size of one upload | 200 MB |
| `timeZone` | Time zone for the timestamps sent to the model (rarely needed) | system time zone |
| `plugins.disabled` | Disabled plugins (Settings · Plugins writes here) | empty |
| `publicAccess` | VPS public entry (only read by the deploy command, [Deployment and outside access](deployment.en.md#option-3-vps--ssh-reverse-tunnel--nginx-public)) | — |

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

**The page has five blocks, top to bottom**: **Provider** (DeepSeek or custom; the endpoint, model id and API style only unfold for custom) → **API key** (one row per provider, with the connection test at the bottom) → **Default model** (and thinking level) → **Agents** (what each one uses) → **Image understanding** (whether each model can see images). With a custom provider selected the later blocks collapse (see points 5 and 7 below).

**DeepSeek is the default**: DeepSeek V4.1 Flash with thinking level high, used by the secretary, maintainers, sub-agents, reviewers and scope review. Under **Settings · Models** you can change the default model, override it per agent, pick a thinking level per row, and say whether a model can see images.

**Switching to a custom (OpenAI-compatible) provider** (the "Provider" block at the top of **Settings · Models**, or the "Model key" step of the **setup wizard** — the same block in both places):

1. Pick "**Custom (OpenAI-compatible)**" as the provider.
2. **Endpoint URL**: include the `/v1` part, e.g. `https://api.openai.com/v1`. Model requests go under it (`/chat/completions` or `/responses`, see step 4), and listing models is `/models` under it.
3. **Model id**: type it if you know it; if not, hit "**Fetch list**": the daemon asks `GET {endpoint}/models` with your key and you pick from the dropdown (you can also hit "Type it instead"). If listing fails (wrong key, wrong URL, not supported by that service), the reason is shown verbatim and you can still type the id.
4. **API style**: `OpenAI chat completions` (`POST {endpoint}/chat/completions`, the default, and what most OpenAI-compatible services use) or `OpenAI responses` (`POST {endpoint}/responses`). Keep the default if unsure.
5. **API key**: the "API key" block further down the same page lists **one row per provider** — DeepSeek on one, Custom (OpenAI-compatible) on the other — each with its own input and "Save key" and a note saying whether it is configured and where the key comes from (the environment variable or the file; the value is never shown). **You don't have to make a provider current to change its key**: type into the custom row and save; it is written to `%USERPROFILE%\.ergo\secrets\custom-model-api-key.txt` (the DeepSeek row writes `deepseek-api-key.txt`), takes effect right away with no restart, and you can also place the file by hand as in [step 4](#2-install) (that environment variable is `CUSTOM_MODEL_API_KEY`). If you installed an older version and upgraded, add a `CUSTOM_MODEL_API_KEY` entry (`from: file`, `optional: true`, pointing at that file) to `ergo-daemon.yaml` in the supervisor as the example does; otherwise the key is gone after the daemon restarts (entering it on the page again also works).
6. Hit "**Test the current provider**" at the **bottom of the API key block** (the wizard has it in the same place): one very short request comes back as either connected (with time to first token) or the reason it failed. It tests whichever provider is **selected** in settings — with custom selected, that's the model id from step 3.

Things worth knowing:

- **"Fetch list" and "Test the current provider" save this block first**: the daemon takes the key of the provider selected in settings, so only after it is saved as "custom" does it have that key. A "Saved. Takes effect from the next new session" message confirms it.
- **One session sticks to one model**: changing the provider or the model applies from the next new session; the secretary's main session, a project maintainer's chat and scheduled tasks start a fresh session on the next round with a handoff summary (the chat notes "switched to X"); a running task never switches midway.
- **A custom provider has a single model**: with custom selected, "Default model" no longer repeats the model id — it just says "Uses the model filled in under the provider: X" — and the default thinking level, the whole Agents block and the Image understanding block collapse (a custom model doesn't think, there is only one model to choose, and ergo has no way to know whether that service accepts images). Switch back to DeepSeek and all of them return; the model ids those rows already had still apply.

**What does not follow the switch** (still DeepSeek-only after you move to a custom provider):

- **The nightly memory consolidation**: the memory keeper always uses DeepSeek (`DEEPSEEK_API_KEY` / `secrets\deepseek-api-key.txt`). Without a key that night's consolidation is skipped (no material is lost; it continues the next night once a key is in place).
- **Web search and page reading**: these go through DeepSeek's own search and page-fetch APIs, so they need a DeepSeek key too (searching with the browser directly and Tavily are unaffected; see [8.4](#84-web-search-and-reading-pages)).
- So **don't delete your DeepSeek key**: after switching to custom, saving a key on the custom row only touches the custom file and leaves DeepSeek's alone. To change the DeepSeek key, fill in and save the DeepSeek row of the "API key" block (no need to switch back first), or place the file by hand as in step 4.
- **The token price table is DeepSeek-only**: usage for a custom model is still recorded as it happens (input, output, cache), but priced at 0, so its cost under **More · Usage** is a rough estimate (it comes out as 0). Don't read it as a bill.

**A custom model's capabilities are registered as estimates** (you can't enter these in Settings):

- **Text only**: registered as text-only ("we don't know whether that service accepts images"), so pictures in a chat are not handed to it as images. With custom selected the whole Image understanding block collapses into one line ("Whether this provider accepts images is something Ergo doesn't know"); those switches come back with DeepSeek and only govern DeepSeek's models.
- **No thinking**: registered as not supporting thinking levels, so thinking levels have no effect on it — with custom selected they are not shown at all.
- **Context window 128k, at most 8192 tokens generated per call**: estimated from typical OpenAI-compatible services. A larger window just goes unused; a smaller one may be truncated or rejected by that service.

**Switching back to DeepSeek loses nothing**: the endpoint, model id and API style you filled in stay in the settings and the key stays in `custom-model-api-key.txt`, so choosing "Custom" again needs no re-typing.

---

## 6. Access from outside (phone, tablet)

How to reach home from a phone or tablet (Tailscale, self-hosted Headscale, VPS tunnel) has its own document: [Deployment and outside access](deployment.en.md).

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

### 7.3 Android app

The Android app is the same product as the HarmonyOS app: a native shell running the same web UI, with native recording, system notifications, file downloads, the built-in browser (floating button, form filling, handing over files) and the browse sidebar. It runs on Android 8 and later.

The app isn't in any app store; for now you build it and install it yourself:

1. Install [Android Studio](https://developer.android.com/studio) (it brings the Android SDK and a JDK). Enable developer options and USB debugging on the phone and connect it by USB.
2. Run `npm run build:android` in the ergo directory; you get `frontend\android\app\build\outputs\apk\debug\app-debug.apk`. The first build needs the network to fetch the build tools.
3. Install it with adb from the Android SDK:

   ```powershell
   adb devices
   adb -s <device id> install -r frontend\android\app\build\outputs\apk\debug\app-debug.apk
   ```

   You can also send the APK to the phone and open it there; Android will ask whether to allow installing apps from unknown sources.

4. The first time you open it, enter ergo's outside address ([Section 6](#6-access-from-outside-phone-tablet)), then pair as the page tells you.

After pairing, the app asks whether it may send notifications. Choose Allow if you want system notifications.

Good to know:

- **No notifications once the system kills the app.** Notifications are local ones the app sends itself: there's no Google push service and no always-running background service. If clearing recent apps or battery saving kills the app, you get notifications again after reopening it. To miss fewer, set ergo's battery usage to "Unrestricted" in system settings.
- **No phone data sources yet.** The first Android version doesn't read contacts, the phone calendar, photos or location; those items under Settings · Data sources only show an explanation.
- **Debug and release builds can't replace each other.** Their signatures differ, so uninstall first when switching, then pair again.

---

## 8. Optional features

### 8.1 Push-to-talk (local speech recognition)

**Install from the Components page (no Python needed)**: **Settings · Components** has a row "Speech recognition model Fun-ASR Nano", marked Recommended.

1. Click Install. A confirmation comes first: the model's name, its size (1.0 GB, shown as 996.9 MB in Windows), the license (FunASR Model License v1.1: **free to use, modify and share if you credit the source and authors and keep the model name; the text says it is for reference and learning only, with no warranty, and has no separate commercial clause, so judge commercial use yourself**) and a link to the full text. Your confirmation is remembered. ergo doesn't bundle this model: it downloads from Hugging Face (hf-mirror as a fallback) and is only installed if the size and checksum match.
2. It shares the program audio.cpp with speech synthesis (see [8.2](#82-voice-replies-local-speech-synthesis)). If that isn't installed yet it downloads first: about 853 MB with an NVIDIA GPU, about 31 MB without.
3. Then it connects by itself: the model joins the speech service's config, the service restarts, health is checked, it joins the start-at-boot list, and recognition switches to it (`voice.recognizer.mode: "audiocpp"` is written to the config) **without restarting ergo**. The model loads in a few seconds; see the status under **Settings · Voice**.
4. Removing the model removes that config entry too, back to the default.

It works without a GPU: a sentence takes a second or two on CPU. It uses about 2 GB of VRAM; with speech synthesis (about 7.3 GB) as well the card has to hold over 9 GB. Whichever doesn't fit fails to load, and the Components page and **Settings · Voice** say why.

A few things to know:

- This service only takes WAV. The web page converts recordings before uploading and the phone app records WAV anyway, so there's nothing to do. To retry recognition on recordings made before you switched, this computer needs ffmpeg on the PATH; without it that one recording says why it failed.
- It only knows Chinese, English, Japanese and auto (`voice.recognizer.language`); for anything else it decides by itself. This model doesn't support prompts (`initialPrompt` has no effect). Filler filtering and automatic retries work as usual.
- Recognized text has no segment timings (the model doesn't support them).

**Your own setup is never changed**: if the config sets `voice.recognizer.mode` to `lsm`, sets a Python path, or the `python` on your PATH has faster-whisper, the Components page says "You already have your own speech recognition; using it", it can't be installed from there, and the config file isn't touched. To use the one from here instead, remove your own first (edit the config, restart ergo). Your own audio.cpp on port 8090 isn't overwritten either; you can add a speech recognition model with the id `asr` to it (family `fun_asr_nano`, task `asr`) and set `voice.recognizer.mode` to `"audiocpp"`.

**Using faster-whisper (fallback)**: if you prefer it, set it up by hand as below. Both routes stay available.

1. Install Python (3.9+) and faster-whisper in it: `python -m pip install faster-whisper`. With an NVIDIA GPU and CUDA it runs large-v3 on the GPU; otherwise it falls back to the small model on CPU.
2. Put that Python's path in `ergo.json`: `{ "voice": { "recognizer": { "python": "D:\\apps\\python311\\python.exe" } } }`.
3. Restart `ergo-daemon`. The first recognition loads the model; see the status under **Settings · Voice**.

You can also let the supervisor host recognition as a separate service (`deploy\lsm\ergo-asr.example.yaml`, with `voice.recognizer.mode` set to `"lsm"`), so it restarts independently of ergo.

### 8.2 Voice replies (local speech synthesis)

ergo synthesizes speech with a local [audio.cpp](https://github.com/0xShug0/audio.cpp) service (a third-party open-source TTS server, optional) at `127.0.0.1:8090`, hosted by the supervisor. Choose the reference voice under **Settings · Roles & voices**.

**Install from the Components page**: **Settings · Components** has two rows, "Speech program audio.cpp" and "Speech model Fish S2 Pro", marked Recommended.

1. Click Install on the model row. A confirmation comes first: the model's name, its size (6.3 GB, shown as 5.88 GB in Windows), the license (Fish Audio Research License: **free for personal, non-commercial use; commercial use needs separate authorization from Fish Audio**) and a link to the full text. Nothing downloads until you agree, and it won't ask again. On the command line: `ergo components add tts --accept-license`.
2. The program downloads first: the CUDA build with an NVIDIA GPU (a program package and a runtime package, about 853 MB; needs NVIDIA driver 580 or newer, and older cards such as the GTX 10 series can't use it), or the CPU build without one (about 31 MB; it works, but it is very slow without a GPU). Both come from upstream (GitHub, Hugging Face); ergo does not bundle this model.
3. Then it connects by itself: it generates the config (local only, port 8090), registers with the supervisor, starts, checks health and joins the start-at-boot list. In the supervisor it is called `ergo-daemon--audiocpp`.
4. The program row shows the running state, version and port, and can start, stop and update. To uninstall, remove the model first, then the program; the registration and start-at-boot entry go with them.
5. If a step fails, the row says which step and why, this attempt's registration and generated config are removed, and the program and model stay, so Retry does not download them again. A release package without `audiocpp_server.exe`, or an incomplete CUDA runtime, is reported too.

**If the download fails or is too slow** (GitHub can be slow or blocked in some regions): the row lists the files still needed and their download links. Get them with your browser or a download tool, then click "Import from file…" and enter the file or folder path (on the command line, `ergo components import <file>`). Once they match the checksums they are installed. The CUDA build needs both packages.

Two things to note: ergo must have been started by the supervisor (`ergo start` does that) for this to connect; and the data directory's path must not contain non-English characters, because audio.cpp can't read it (move the data directory to a plain English path, then install).

**Your own setup is never overwritten**: if `voice.speech.url` in the config points elsewhere, something is already on port 8090, or port 8090 is already registered to another supervisor service, the Components page says "You already have your own speech service; using it", and it can't be installed from there. To switch to the one from here, remove your own first.

**Manual setup (fallback)**: download audio.cpp and a model yourself, write a `server.json`, register a service on port 8090 with the supervisor (with the id `audiocpp`, say), then put the service's model id in `voice.speech.model` in `ergo.json`. Other models or another port (`voice.speech.url`) go this way too.
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
- **Owners can submit what they've learned as a skill**: the owner of a project or task writes a skill in its own working folder or project records and submits it. A "Skill change" card lands in your to-dos with the name, description, who submitted it, which project or task, the file list and sizes, a prominent "It contains N scripts that agents using it may run" if there are any, and the full SKILL.md to expand. `.env` files, private keys and hidden folders stay out, and the card lists them. Only when you approve does it enter the library and join the submitter's toolkit, so its session can use it straight away; other projects add it to their own toolkit if they want it. Deny and nothing changes. If the source changes after submission, approving won't let it in and the card says it has to be submitted again. Owners can also request updates and removals, but only for single skills you imported or owners submitted, not ones that ship with the framework or belong to a collection; a copy of the old version stays in the skill area's `.history`. A removal card lists the projects and tasks using the skill. After removal the name stays in their toolkits and is skipped when sessions start, with no error, and a skill with the same name works again once it's back. The skill library page marks which skills owners submitted and who.
- **Settings · Data sources**: connect Google (calendar, Gmail, contacts), Looki and phone data. The page is a set of cards, one per data source and grouped by plugin, showing whether it's connected, the account, how many items have been fetched and the last sync. The last card is the shared import folder, where the matching plugin picks up files you drop in. Open a card to get its own full page (it fills the content area, has a back button and survives a refresh), in three parts:
  - **Status**: connection state, account, any problem, last sync, and "Sync now".
  - **Settings**: keys or addresses, the two usage switches, the schedule, sensitive content, the import folder, raw data (cleared by day) and disconnect. Gmail can connect several accounts: one row per account (full address, state, how many messages were imported, any problem). You can add another, switch one off (it's then neither searched nor imported) or disconnect just one (the confirmation asks whether to keep what it imported or delete it too); other accounts aren't affected. Entering the same address again changes its password, and the button at the bottom disconnects all of them. The account you already had becomes the first one after the upgrade, with nothing to re-enter. When you ask Ergo to look through mail it searches every account unless you name one, and says which account each result came from.
  - **Data**: **Fetched** is what has already reached Ergo (paged, newest first; items that became materials open the material detail). **Available now** asks the upstream on the spot (Google Calendar events for the next 30 days, the latest Gmail messages, Looki moments from the last 3 days). It's read-only: nothing is saved to Ergo, nothing reaches memory or a model, and the Gmail list shows only sender, subject and time until you open a message. With several Gmail accounts the list is grouped by account, and one that can't be reached doesn't affect the others. Sources delivered by the phone don't have this tab, because the computer can't query the phone.

### 8.6 Claude Code

If [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is installed and signed in on this PC, project and task owners can work through it (on your own subscription), with ergo's guard still checking every tool call; ergo can also take over your existing Claude Code sessions.

Its Agent SDK (`@anthropic-ai/claude-agent-sdk`) is under Anthropic's own license, not open source, so ergo treats it as an **optional dependency**: if it is missing, **Settings · Plugins** shows Claude Code as not installed and how to install it (run `npm install --no-save @anthropic-ai/claude-agent-sdk@<version>` in the ergo directory; the version is in `optionalDependencies` of `packages/daemon/package.json`), then click Enable. Nothing else is affected.

---

### 8.7 Component updates

**Settings · Components** has "Check for updates", and ergo also checks by itself every night (4:20 am, or after startup if the computer was off).

- **Where it checks and what it sends**: it only fetches one version list and its signature from ergo's release page (by default `https://github.com/catmaniii/ergo/releases/latest/download/components-manifest.json`; if you host releases yourself, your own address; the Components page shows the full address). It doesn't send your account, device or usage. The other side just sees an ordinary download.
- **Nothing is replaced automatically**: when there is a new version the row says "Update available", and the nightly check also leaves a note in your to-dos (once per version). It downloads, verifies and switches only after you click "Update"; the old version keeps working until then, and also if the download fails. If the license version changed, you confirm it again before the download.
- **If the release page doesn't have this list yet**: the Components page says there's no component update information for this version yet. Nothing is affected.
- **If the check fails**: one line on the Components page says why, and nothing else bothers you. Common reasons are not reaching GitHub, or a build without the release public key (a list whose signature can't be checked isn't trusted). Components then update along with ergo itself.

---

## 9. Backup and restore

**More · Settings · Backup** (`#/more/backup`) is one page for all of it, and it works from your phone too (the folder you choose is still on the computer ergo runs on). Changes made here take effect right away, no restart needed.

- Every night at 03:30 (you can change the time on this page) the daemon takes a consistent snapshot of the data directory into its `backups\`. This copy stays with the data directory and can't be moved separately. If the PC was off, it catches up on the next start.
- **Sync folder (an extra copy)**: use "Change…" to choose a folder or paste a path. Each snapshot is also copied there: a NAS, home storage, or a cloud-drive client's folder.
  - It's checked as you choose: a full path, not inside the data directory, and writable (a temporary file is really written). If it doesn't exist you're asked whether to create it. Anything unacceptable gets a clear reason and the config stays as it was.
  - Changing the folder: snapshots already in the old folder are neither moved nor deleted, and the next backup goes to the new one. A backup that's running still finishes in the old folder.
  - "Clear": asks you to confirm, then only the local copy is kept. Existing snapshots aren't deleted.
  - You can also edit `ergo.json` by hand: `{ "backup": { "syncDir": "D:\\NAS\\ergo-backup" } }`; hand edits need a daemon restart. The page only touches these `backup` keys and leaves everything else in the file byte for byte. If the file is broken (not valid JSON, say) it tells you what's wrong and doesn't overwrite it.
- **How many are kept**: 7 locally; 7 daily and 4 weekly in the sync folder. Older ones are deleted automatically.
- **Existing snapshots**: date and size for each place, or the reason they couldn't be read. The size is the total of the files in that snapshot; files that are the same across snapshots take up space only once.
- **Back up now**: "Back up now", or `ergo backup` (if you `git clone`d: `npm run backup` in the ergo directory). It works with the daemon running; the last line says whether it succeeded; log in `logs\backup.log` in the data directory.
- **Check**: the latest snapshots are checked every Sunday at 04:30. "Check the latest snapshots" runs that right away, in the same queue and under the same lock as backups, so the two never overlap. The result appears under the button, and a failure also leaves a notice.
- **Use your own scheduler**: set "Who schedules it" to "External timer" (or `"backup": { "schedule": "external" }` in the config) and the daemon stops backing up on its own; have your scheduler run `ergo backup --scheduled` (if you `git clone`d: `npm run backup -- --scheduled` in the ergo directory; the page shows the right command for this computer, ready to copy). You get a reminder if nobody backs up for two days. Switching back works the same way, no restart needed.
- **Restore**: ergo has to be stopped first, so there's no one-click restore on the web page. "How to restore" lists the commands for how ergo is installed on this computer, ready to copy. If the page won't open, use these:

  Installed with the one-line command (or npm):

  ```powershell
  ergo stop                             # stop ergo first
  ergo restore --list                   # list snapshots
  ergo restore 2026-10-15               # restore a day
  ergo restore 2026-10-15 --from sync   # local copy broken: restore from the sync folder
  ergo start                            # start it again
  ```

  If you `git clone`d (there's no `ergo` command):

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

  If your data directory isn't the default (you set `ERGO_DATA_DIR`), set that variable in the same window before using `ergo` too. What was there before is moved to `backups\pre-restore-<time>\`, keeping the latest 2. The restore command refuses to run while the daemon is running. The config is part of the snapshot too: after restoring, the sync folder and backup time are back to what they were that day, so take a look at **Settings · Backup**.

---

## 10. Update, stop, uninstall

How to update, roll back, stop and uninstall has its own document: [Install, update and uninstall](install.en.md#update).

---

## 11. Troubleshooting

**Run a checkup first**: **More · Settings · Data & devices → "Checkup"** (`#/more/doctor`) runs eight checks — ports, Node, pi, the service manager, the model key, components, disk, outside access — and gives the fact it found plus how to fix each one; "Run again" is in the top right. Everything it looks at is local: no network (other than probing ergo's own ports), no model calls, no settings changed.

The outside access check doesn't connect anywhere. It only looks at what this machine has on record: a tailnet or tunnel entry in the service manager, or a paired device that hasn't been revoked. Any one of those passes the check (for paired devices it says "N paired devices"). A setup the service manager doesn't know about, such as running `tailscale serve` by hand, passes once a phone is paired. With nothing on record it says "No outside access is registered in the service manager; if your phone already connects, you can ignore this", which doesn't mean outside access isn't set up.

**Logs**: the daemon's output is in `logs\ergo-daemon.out.log` under the supervisor's data directory, and live in the supervisor's web UI; ergo's own health: <http://127.0.0.1:8810/healthz>.

| Symptom | Likely cause | Fix |
|---|---|---|
| The daemon won't start; the first log line says "Windows only" or the Node version is wrong | Wrong OS or Node | Use Windows 10 / 11 and Node 22 (≥ 22.19); check that `<专用 Node 路径>` in the entry points to it |
| Won't start: port in use | 8810 / 8811 taken by another program (name and PID are in the log; if they can't be found, the log says someone holds the port but it can't tell who) | Close it, or change `ports` (and both 8810s in the entry) |
| Won't start: another instance uses the same data directory | One was started by hand, or an old one didn't exit | Stop it (supervisor web UI or Task Manager), then let the supervisor start ergo |
| The page shows 503 and says `npm run build:web` | The web UI isn't built | Run `npm run build:web` in the ergo directory |
| It says "no model configured" or every reply errors | Key missing or wrong, or out of credit | Enter a new key under **Settings · Models** (or check `secrets\deepseek-api-key.txt`, just the key), then run the connection test |
| Commands in tasks keep failing: Git Bash not found | Git for Windows missing, or WSL's `bash` comes first on PATH | Install Git for Windows; `where bash` should list `C:\Program Files\Git\bin\bash.exe` first |
| Push-to-talk does nothing / recognition unavailable | Recognition model not installed, speech service not running; with faster-whisper: Python path not set, faster-whisper missing, GPU unavailable | See the status in **Settings · Voice**; set up per [8.1](#81-push-to-talk-local-speech-recognition) |
| Voice replies are text only | TTS service not running, or `voice.speech.model` is still the placeholder | See [8.2](#82-voice-replies-local-speech-synthesis); the note in the chat says why |
| Memory search misses things with similar meaning | Embedding model not installed | Install under **Settings · Components**, or `npm run download-model` |
| The phone can't open ergo or stays on the pairing page | Outside access not set up, or the request expired / was rate-limited | Make sure 8811 is what's exposed; approve the request in **Inbox** on the PC within 5 minutes; after repeated failures wait 10 minutes |
| The phone says "this device has been revoked" | It was revoked under Paired devices | Tap "Request pairing" to apply again |
| The supervisor shows ergo yellow (degraded) | An enabled plugin failed to load | See `reasons` in `/healthz`, or the plugin's note in **Settings · Plugins** |
| Every backup says it wasn't copied to the sync folder | `backup.syncDir` is still the example placeholder, or the folder is missing | Pick another folder in **Settings · Backup**, or use "Clear" |
| Web tools say no browser was found | No Chrome / Edge, or installed somewhere unusual | Set its exe path in `web.browserPath` |
| Install or update won't go through: the antivirus says "unknown publisher", kills the process, or the installed files vanish later | Security software such as 360 blocks programs it does not recognise (`bin\ergo.exe` or the whole install folder) | Add `%LOCALAPPDATA%\Programs\ergo` to the security software's trusted list and install again; if the command still runs, use `bin\ergo.cmd` (the same command as `ergo.exe`); or install from npm (`npm i -g ergo-ai`, needs Node 22). Your data is in `%USERPROFILE%\.ergo`; reinstalling leaves it alone |
| `ergo update` says it could not switch, or `ergo version` still shows the old version | The `current` file names a version that is not installed properly under `versions\` (half copied, edited by hand) | Check what `%LOCALAPPDATA%\Programs\ergo\current` says, whether that folder exists under `versions\` and has `ergo.json` in it; if not, run `ergo update` again, or install again (your data is untouched) |

**Reporting a problem**: [open an issue](https://github.com/catmaniii/ergo/issues/new/choose) on GitHub and fill in the template: ergo version (**Settings · About Ergo**), Node version (`node -v`), pi version (`overrides` in the root `package.json`) and how you installed — the version, Node and pi are also on the checkup page at a glance. Please don't report security issues publicly; see [SECURITY.md](../SECURITY.md).

**"Ticket N" in code comments**: these are internal development record numbers. The tickets themselves are not public, which doesn't affect understanding the code.
