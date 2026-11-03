[中文](README.md) | **English**

# ergo (二狗)

> **Your memory, back to you. The more it knows you, the more at ease you feel.** A personal AI assistant that lives on your own computer and takes orders by voice from your phone.

**[Online demo](https://catmaniii.github.io/ergo/?lang=en)** (nothing to install, no key needed; the web prototype ships with made-up sample data) · [User guide](docs/user-guide/README.en.md) · [System architecture](docs/architecture/README.en.md) · [Changelog](CHANGELOG.md)

<p align="center"><img src="docs/user-guide/images/readme/classic-tasks-en.png" width="620" alt="Task board"> <img src="docs/user-guide/images/readme/classic-secretary-phone-en.png" width="178" alt="The secretary on a phone"><br><sub>The task board on a PC and the secretary on a phone. Every screenshot here comes from the online demo and shows made-up sample data.</sub></p>

> **Windows 10 / 11 only.** ergo relies on things only Windows has (Job objects, directory junctions, scheduled tasks) and won't start on other systems.

## The whole you stays with you

How much would an AI assistant have to know to really understand you? Your ID, passport and bank cards. Your medical report, payslip and mortgage. Your family's birthdays and where your kid goes to school. Things you said in anger, questions you searched at 2 am, plans you haven't told anyone.

Would you hand all of that to the cloud? But if you don't, how could it ever understand you? The more it knows you, the less at ease you feel.

So we built ergo: **everything about you is kept on your own computer, and only there.**

- It still calls large models and outside services, but each call carries only the small part this turn needs, and you decide who receives it.
- Models are swappable: use DeepSeek today, or point it at any OpenAI-compatible service.
- Claude Code and Codex sessions already on your PC can be taken over by ergo and handed back at any time (Codex support is experimental). For what works and what doesn't, see [Taking over Claude Code and Codex sessions](#taking-over-claude-code-and-codex-sessions) below.
- Whatever you swap, the memory that understands you best stays in your hands.

The English name ergo sounds like the Chinese name "二狗" (Ergou), and Latin *ergo* means "therefore" — reasoning from what you say to what you really want. ergo is built on [pi](https://github.com/earendil-works/pi) and can be seen as a single-user [OpenClaw](https://github.com/openclaw/openclaw) rebuilt around one person's needs.

## Five things ergo does

| | | |
|---|---|---|
| 1 | [**One secretary**](#1-one-secretary) | You talk only to it, and it runs several projects for you at once, all by voice if you like |
| 2 | [**Long-running tasks**](#2-long-running-tasks) | Hand off a big project without babysitting it, and understand it at a glance when you return |
| 3 | [**From project to operations**](#3-from-project-to-operations) | A finished project becomes a service that keeps running, one sentence away from the secretary |
| 4 | [**Memory**](#4-memory) | Infers the needs you haven't put into words |
| 5 | [**Built-in browser**](#5-built-in-browser) | Talk to a web page in the phone app (HarmonyOS, Android) and it does the work |

[The rest](#the-rest-is-there-too) is there too: scheduling and a calendar, a spending ledger, 11 visual styles, Chinese and English, phone, wide foldable and PC layouts, and everything is a plugin.

## Get started

On Windows 10 / 11, run one line in PowerShell (no admin rights; the package bundles Node):

```powershell
irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1 | iex
```

Then open <http://127.0.0.1:8810/> and follow the setup wizard; from now on ergo starts by itself when the PC restarts. Already installed? Update with `ergo update`.

Install options, source installs, updating, rolling back and uninstalling are in [Install, update and uninstall](docs/user-guide/install.en.md).

On your phone: open ergo in the phone's browser, or install the phone app (the built-in browser is only in the app). The apps aren't in any app store:

- **Android**: [download ergo-android-debug.apk](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-android-debug.apk) and tap it on your phone to install. See the [Android guide](docs/user-guide/mobile.en.md#android-app).
- **HarmonyOS**: you have to sign it with your own Huawei account before it installs on a phone, so this one is for developers who don't mind some setup. [Download the unsigned ergo-harmony-unsigned.hap](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-harmony-unsigned.hap), which installs directly only on the emulator. See the [HarmonyOS guide](docs/user-guide/mobile.en.md#harmonyos-app).

## One at a time

### 1. One secretary

You may have tried it: give one OpenClaw session several development jobs. It goes fine at first, then the contexts tangle together and it loses track itself.

In ergo, **you talk only to a secretary**. It doesn't do the work itself. It understands what you want, draws on your memory when needed, hands the work to the owner of each project and task, keeps an eye on progress, and sums it all up for you. Several projects run at once without crossing wires; you don't switch between sessions, you come back to one summary.

<p align="center"><img src="docs/user-guide/images/readme/classic-projects-en.png" width="760" alt="Projects page"><br><sub>Each project has its own dossier, working directory and owner.</sub></p>

The working agents aren't a fixed cast of PM, architect, developer and tester either: that means retelling the same context over and over, which burns tokens. Our idea is **assembling a team on demand**: each project and task gets the tools, skills and MCP servers this job needs; steps that can run in parallel get temporary sub-agents that disband when done. No crowd of permanent roles to keep around.

**All of it works by voice.** Out and about, hold the button on your phone and say "fix that login bug from yesterday and tell me when it's done"; the PC at home gets to work, and ergo reads you the result when it's finished. Each project's owner can have its own name and voice, so you know who's reporting with your eyes closed. Speech recognition and synthesis run locally and need extra components, see [Voice](docs/user-guide/voice.en.md); to reach home from your phone, see [On your phone](docs/user-guide/mobile.en.md).

#### Taking over Claude Code and Codex sessions

If Claude Code or Codex is installed on your PC, owners can also work through it, with your own sign-in and configuration. A session you left halfway in a terminal can be taken over by ergo to carry on, then handed back. Codex support is experimental.

**What works**

- It lists the sessions on this computer; pick one to carry on, in the session's original working folder.
- It becomes a plain task, or a project created right away; the most recent stretch of the earlier conversation shows at the top, for you only.
- A session still open elsewhere isn't taken over directly; you can take over a fork instead, and the original stays as it is.
- While ergo holds the session, only ergo writes to it. Every message and every tool call is recorded in ergo, and tool calls go through ergo's guard first.
- Hand it back to the terminal in ⚙ and take it back when you're done; before taking it back, ergo checks it's closed over there.
- A Claude Code session can also go to the official app, so you can keep talking on your phone when you're out, then take it back.
- ↶ rollback still works: a new session forks from before that message, and the original stays as a branch you can switch back to.
- It runs on your own quota: variables that would change billing are removed from its environment. Codex signed in with an API key is billed per use, and the usage page says so.

**What doesn't, or has limits**

- Claude Code sessions have no lock: if you open one in a terminal while ergo holds it, ergo can't tell, and if both sides write, what one side said is lost.
- ergo may not spot a Codex session still open in a terminal. Close the terminal first, or take over a fork.
- Rolling back, Claude Code restores only files changed with Write or Edit, not ones changed through Bash; Codex rolls back the conversation only, not files.
- While a session is in the official app, tool calls there don't go through ergo's guard; ergo just copies what happened about once a minute. Codex can't go to the official app.
- With Codex, a few kinds of calls skip the guard or are only known afterwards, such as tool search or a model insisting on web search. The guide lists them one by one.
- Codex's own web search and typing into a running terminal are always off: searches go through the service set up in ergo, and interactive programs that need someone at the keyboard don't work.
- Codex hasn't been through the full round in a real terminal yet: whether a session open there is recognized; taking over directly, handing back to the terminal, and taking it back.
- The secretary, subagents and reviewers are still pi; scope review and the branch summary on rollback still use the model you set up in ergo.

Details are in the [Claude Code guide](docs/user-guide/claude-code.en.md#what-it-can-and-cant-do) and the [Codex guide](docs/user-guide/codex.en.md#what-it-can-and-cant-do).

### 2. Long-running tasks

The hardest thing about long-running tasks is balancing safety against interruptions. Claude Code keeps asking you to confirm sensitive actions, until many people give up and turn on `--dangerously-skip-permissions`; auto mode can fail too. Either you're interrupted to death, or you bet nothing goes wrong.

ergo **runs long tasks the way you'd manage a project**:

- **Charter first**: goals and scope, the stages, the tools, the pre-approved operations are all on the charter and plan card. Work starts after you confirm once.
- **Then stages**: each stage has clear deliverables. It passes scripted checks and then an independent reviewer agent that can run commands and look at real results, instead of taking the worker's word for it.
- **Deterministic safety rules on guard**: rules hold the line, not the model's good intentions, for example "back up before deleting", "run tests before pushing", "never send anything out after reading a secret". Drift is pulled back automatically.
- **It only comes to you for real surprises**: plan changes pause only the affected stages; after a restart, work continues where it stopped, and operations whose outcome is unknown stop and ask rather than being silently redone.

> **From real use**: a real project's first version took 247 operations and only 7 clicks; it drifted 5 times and was pulled back automatically each time. For developers who vibe-code for hours, what you save is whole blocks of attention.

<p align="center"><img src="docs/user-guide/images/readme/classic-plan-en.png" width="760" alt="Plan card and stage graph"><br><sub>The stage graph on the left and the plan card on the right: what each stage does and what it may touch. Confirm once and work begins.</sub></p>

**Come back much later without reading dozens of pages of chat.** ergo shows the work in layers. Pinch (Ctrl + scroll on a PC): the key-points level shows one line per item, with sensitive operations and files sent out pinned in the margin; the overview shows the whole job as one colored bar; for details, expand back to the conversation level.

<table>
<tr>
<td align="center"><img src="docs/user-guide/images/readme/classic-zoom-keypoints-en.png" width="420" alt="Key-points level"><br><b>Key points</b><br><sub>Deletions and outgoing sends are marked in the margin</sub></td>
<td align="center"><img src="docs/user-guide/images/readme/classic-zoom-detail-en.png" width="420" alt="Conversation level"><br><b>Conversation</b><br><sub>Full content; every operation opens up</sub></td>
</tr>
</table>

**You decide what matters.** Watch categories (spending money, sending in your name, deleting or overwriting, irreversible commits, accounts and security, leaving the project directory… plus your own) × six handlings (just do it and log, do it and tell me, only if in the plan, ask me first, hand it to me, never). **Three hard bottom lines nobody can override**: never write ergo's own config, database or program directory; never read the secrets area; never send something known to be a secret.

<p align="center"><img src="docs/user-guide/images/readme/classic-watch-en.png" width="760" alt="Watch categories in Settings"><br><sub>Settings · Watch categories.</sub></p>

Everything that needs your decision is in the inbox, with system notifications in the phone app; a token ledger records each model call against its task, stage and agent.

### 3. From project to operations

Heavy AI users and geeks love hand-rolling tools. But building the tool is only the start: some need to be a website others can reach, some need to run on a schedule, some need to be callable by agents and models, and services have to work with each other. Background services pile up and you're managing them all yourself; manage them badly, and agents can't use what you built.

So ergo comes with a **service manager (Local Service Manager)** that looks after those background services in one place: start at boot, restart after a crash, start in dependency order, one web page showing all their status.

When a project is finished, you confirm once on a card and it goes into use:

- its services are hosted by the service manager and open right in ergo's built-in browser;
- the operations plan its owner wrote (a daily report at a set time, process new files arriving in a folder…) starts up as a whole, and runs from then on without asking item by item;
- its public interfaces are listed in an operations API list, in the same format as MCP tools. Say "log thirty-two yuan for lunch" and the secretary calls your ledger.

When a project goes live, that list also becomes a standard MCP server (stdio) automatically: no forwarding program to write, the project's own owner can use it right away, and owners of other projects and tasks can use it once it's in their toolkit. Change the list, pass the check, and the tools follow. For now it only serves ergo's own agents; setup for your own Claude Code or Cursor isn't done yet.

The more of these services you collect, the bigger the things one sentence can do.

### 4. Memory

Being capable isn't enough; it also has to understand you. This is the heart of ergo, and it's still experimental.

Here's an example. A friend invites you out for all of Saturday, meeting at nine. An ordinary assistant digs up something you once said, "I'm skipping this Saturday's party", concludes you dislike parties, and declines for you.

ergo remembers that sentence too, but it doesn't decline. It asks: **"That's a packed day. Want to go just for the afternoon?"**

How did it know? ergo infers needs **with a reasoning graph**: from the literal words you said to the real need you didn't say out loud, and when it isn't sure, it asks you.

- **Stand up several explanations first**: the same sentence might mean you dislike parties, you've been too tired lately, or you don't want your weekend disturbed. ergo doesn't rush to choose; it lets the evidence compete.
- **Score every piece of evidence**: evidence comes from what you say and do, six points for strong, three for weak. You also signed up for a tech meetup on Wednesday night, strong evidence against. "Dislikes parties" loses points and lands at the bottom, so that sentence never becomes a conclusion.
- **Less than a six-point lead means no conclusion**: so ergo doesn't decline for you. It asks.
- **Conclusions stack upward, each step tied to evidence**: if the premise is a guess, so is the conclusion. One "I'm not tired" from you withdraws that explanation, and the conclusions resting on it fall with it, while the evidence stays.

So it isn't that you dislike socializing; you just don't want your weekend disturbed. **Without your having to spell it out, ergo can infer the need you didn't say.** (This example uses synthetic data; the scoring comes from a real run of the engine.)

<p align="center"><img src="docs/user-guide/images/readme/classic-memory-en.png" width="760" alt="Conclusions on the memory page"><br><sub>The memory page: each conclusion opens to its evidence chain, supporting and contrary evidence, competing explanations and revision history.</sub></p>

- **Every word kept**: an immutable verbatim copy of everything you said, indexed by keyword and vector; conversations, project dossiers, task records, attachments and the spending ledger all live locally too.
- **Distilled nightly**: at 3 am the memory curator turns new material into evidence and consolidates it into conclusions.
- **You're in charge**: view, correct and delete in the memory page; say "forget…" or "don't infer from this" and it complies; a hard delete also scrubs everything that referenced it. Sensitive categories such as health are recorded but not used for inference by default.
- **Getting-to-know-you interviews**: the memory curator may invite you to talk through one topic at a time (decline any time) and fills in your personal files from it.
- **Safety**: **secrets live in a separate area no agent can read**; a consistent snapshot every night, optionally copied to a NAS or a cloud-drive sync folder.

Design details are in [the memory system](docs/architecture/memory-system.md) (in Chinese).

### 5. Built-in browser

The ergo phone app (HarmonyOS, Android) has a built-in browser that understands speech and operates web pages for you.

Open a page and tap a text box or a photo upload area; a small ergo button appears beside it. Hold it and say "paste in the photos I took in Hangzhou over the weekend": it finds them in the folders you registered, shows you the list, and hands them to the upload box. Or with a form to fill in, it pulls your name, address and company from memory and fills them one box at a time.

Web pages used to make you click through everything. Now you just say what you want, and your memory and local data are right there. Web apps built with ergo work the same way when opened in this browser.

This is only in the phone app. On Android, [download the APK](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-android-debug.apk) and install it ([guide](docs/user-guide/mobile.en.md#android-app)). On HarmonyOS you sign it with your own Huawei account: [download the unsigned HAP](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-harmony-unsigned.hap) ([guide](docs/user-guide/mobile.en.md#harmonyos-app)).

### The rest is there too

**Everyday chores run themselves**:

| Kind | Good for | How it runs |
|---|---|---|
| Plain task | Download a video, look something up | A background agent just does it; the secretary tells you when it's done |
| Workflow | The same few steps every day | Steps laid out in advance and authorized once; every run is checked step by step and pulled back if it drifts |
| Long-running task | Build a tool, write a research report | Runs in stages with acceptance at each stage; the plan can change mid-way |

Three triggers: once now; scheduled (optionally "on my working days", with Chinese and Singaporean holidays and make-up days); on an event (another task finished, a new file arrived in a folder). Write "every Monday at 8 am…" when starting a task and the schedule is set from it; results can be read aloud to you automatically.

**Everything is a plugin**: the daemon is split into a kernel and plugins. **Reminders, memory, calendar, voice, built-in browser, Claude Code, Codex, Google (calendar, contacts), Looki and phone** are all plugins that you can disable, enable or remove under **Settings · Plugins** without restarting; disabling only hides pages and tools, the data stays. Want a new ability later? Write another plugin, following the [plugin guide](docs/architecture/plugin-development.md) (in Chinese), which starts from a minimal "notes" plugin.

**Your way**:

- **11 visual styles**: Classic, Paper journal, Clean grid, Night cockpit, Soft candy, Glass glow, Blueprint, Sticker bento, Pixel cottage, Ink wash, Retro magazine — each in light and dark.
- **Your names, your voices**: ergo ships with a default voice, Xiaoman, and you can import a recording to switch to one you choose. The assistant's name, system prompts, models, skills and MCP servers are all configurable.
- **Chinese and English** built in; add other languages by dropping language files into the data directory, no code changes.
- **Phone, wide foldable and PC**: designed phone-first, with multi-column layouts on wide screens; there are also native HarmonyOS and Android apps.

<p align="center"><img src="docs/user-guide/images/readme/styles-gallery.png" width="860" alt="Style previews under Settings · Appearance & style"><br><sub>Settings · Appearance & style: all 11 styles, each shown light (left) and dark (right).</sub></p>

## Our vision

We salute the idea behind [OpenClaw](https://github.com/openclaw/openclaw): take memory out of the hands of big companies and give it back to users. ergo carries that idea forward by staying open source and protecting your ownership of your personal agent's memory data.

Both the computing power and the memory should be yours.

Large models still live elsewhere today, so we're handing back everything except the model first. When home computing power is ready, bring the model home too, and the whole of ergo will be under your own roof.

## Documentation

- **To use ergo:** see the [user guide](docs/user-guide/README.en.md). What ergo is, how to install it and how to use each feature.
- **Phone apps:** [Android APK](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-android-debug.apk) ([guide](docs/user-guide/mobile.en.md#android-app)), [HarmonyOS HAP](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-harmony-unsigned.hap) (you sign it yourself; [guide](docs/user-guide/mobile.en.md#harmonyos-app)).
- **To see how it's built:** see [System architecture](docs/architecture/README.en.md). Architecture, the memory system, deployment and decision records.

For developers: [Development](docs/architecture/development.en.md), the [plugin guide](docs/architecture/plugin-development.md) (in Chinese), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).

## Contributing

Questions, docs, bug fixes, plugins and new languages are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © ergo contributors. Third-party license lists ship with the package.

## Third-party models

Speech synthesis uses [Fish S2 Pro](https://huggingface.co/fishaudio/s2-pro) by default, under the [Fish Audio Research License](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md): free for personal, non-commercial use; commercial use needs separate authorization from Fish Audio. The model isn't in the package. You accept the license and then download it.

**Built with Fish Audio.**
