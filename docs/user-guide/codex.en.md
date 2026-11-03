[中文](codex.md) | **English**

# Codex

If Codex is installed on this computer, task and project owners can work through it, with your own Codex configuration and login. ergo still records its tool calls, and still stops risky ones or asks you. A few things can't be stopped; they're listed below.

Codex sessions you already have going in a terminal can be handed to ergo to carry on, then handed back.

Only task and project owners can use Codex. The secretary can't.

Codex support is experimental. What it can and can't do is gathered in [the last section](#what-it-can-and-cant-do).

## Before you start

1. Install Codex: `npm i -g @openai/codex`. Version 0.166.0 or newer is needed.
2. Sign in: run `codex login` in a terminal. ergo doesn't look at your login; it uses Codex's own.
3. Open **Settings · Abilities · Plugins** and find Codex. "Running" means you're done. If it says "Not installed", the line below says what's missing; install it, then click "Enable".

After that, the "Runtime" row in the new task and new project dialogs has a **Codex** option.

**Good to know**

- If it isn't installed, everything else keeps working. When other runtimes can be picked, Codex shows greyed out in "Runtime"; click it to see how to install.
- If it isn't signed in, the turn ends with an error telling you to run `codex login`. Sign in, then send another message to carry on.
- When the plugin is disabled, owners using Codex don't start. Running tasks go to "Waiting for you" and carry on once it's enabled.

## New task or project with Codex

Same as [Claude Code](claude-code.en.md):

1. Click "+ New task" or "+ New project" and write what needs doing.
2. Click **Codex** under "Runtime". "Take over a Codex session…" and "Which folder" appear below.
3. Under "Which folder", start a new subfolder of the default folder or use an existing one. Set the default folder in **Settings · Abilities · Codex**.
4. Click the button at the bottom. The card is labeled "Codex".

## Take over an existing session

**What this is:** you're halfway through something with Codex in a terminal and want ergo to carry on. The working folder and the conversation so far stay as they were.

**Where:** in the new task or new project dialog, pick Codex under "Runtime", then click "Take over a Codex session…".

1. Codex sessions on this computer are listed, each with title, working folder, branch and last activity. Sessions ergo started aren't listed, and neither are `codex exec` runs (by default Codex only lists sessions from the terminal and VS Code).
2. Pick a session and check its label:
   - **In use**: it was active minutes ago. Close it there, wait a moment and click "Refresh", or tick "Take over a fork (the original stays as it is)".
   - **May be open**: the list can't tell. So the fork is ticked by default; untick it to take over directly once you're sure it's closed. If it's actually still open, Codex refuses and ergo says to close it first.
   - **Held**: another ergo task or project has it. Only a fork can be taken over.
3. For a task, write what it should do next. For a project you can leave this empty.
4. Click "Take over" or "Take over a fork".

The session starts with the backstory: the most recent stretch of the conversation in Codex, shown to you only, not counted as new input.

**Good to know**

- Codex doesn't let two processes write to a session at once: ergo can't take over a session another program has open, and other programs can't open one ergo holds. An open session can still be forked. Whether Codex's terminal interface behaves the same hasn't been tested yet, so don't open the session in a terminal while ergo holds it.
- A fork is a new session; the original stays as it is.

## Hand back to the terminal, then take it back

**Where:** in the task details or the title bar of the project owner's chat, click ⚙ and find the "Runtime" block.

1. Click "Hand back to Codex". ergo stops writing to this session.
2. Run `codex resume` in a terminal and carry on.
3. When you're done, close it in the terminal, then click "Take back to ergo" in ⚙.

**Good to know**

- Before taking it back, ergo checks: it refuses if another program still has the session open, or if the session was touched after you handed it back and was active within the last few minutes, and says why. Try again a little later.
- Make sure the terminal is closed first: whether a terminal interface left open without talking can be detected hasn't been tested yet.
- After a rollback, ergo carries on in a forked session, so that's the one to pick in `codex resume`.

## Model, sandbox, thinking level

**Where:** ⚙ · Runtime. All default to "Follow Codex's own settings".

- **Model**: the list comes from Codex and is empty until the owner has started once. When the model changes, the old model writes a handoff summary and the new one continues in a new session.
  - **When the current model can't be used:** for example, your account doesn't support the model in Codex's settings. The first turn fails without using quota, and the task goes to "Waiting for you" with the reason. Pick another model in ⚙ and send another message. The old model can't write a handoff summary, so ergo starts a new session and puts the earlier record in its context. You have to pick for each task; to avoid that, change Codex's own settings (`model` in `config.toml`).
  - **Forked takeovers and rollbacks:** they keep the model the session was using and don't fall back to the one in Codex's settings.
- **Sandbox**: writes in the working folder only by default. You can also pick read-only, no sandbox (the guard only), or Codex's own settings. Codex's own settings can mean read-only (we ran into this), and then its file writes are refused and the model tells you so.
- **Thinking level**: low, medium, high, very high.

The approval policy isn't a choice: ergo always uses the strictest, so calls go through the guard.

## What the guard covers

These are results from testing against real Codex 0.166.

Commands (read-only ones like `dir` and `git status` too), file changes, MCP tool calls, image viewing, sending subagents, and all of these inside a subagent go through ergo's guard first. If it says no, the call doesn't run and Codex gets the reason. Arguments and results are recorded in ergo. Some models write their tool calls inside a piece of code; each call in there goes through the guard the same way.

**These don't go through the guard, and ergo doesn't record them:**

- Tool search (`tool_search`): it only reads tool descriptions.
- That piece of code itself and waiting for its result (`exec`, `wait`): it can't reach files or the network, except through the calls above.

**These are only known afterwards:**

- Web search: Codex's own stays off, isn't in its tool list, and can't be turned on. Owners that may use the internet use ergo's web search, which goes through the guard before each call; the cost is that searches go through the service set up in ergo, which needs the internet tools and a working provider. If a model searches anyway, it's recorded afterwards, and the turn is interrupted if the guard says no.
- A command you set to always run in Codex, when the guard's hook also fails: known only after it ran. When only the hook fails, Codex still asks for approval, and ergo can stop the call at that step.
- A command you set to always run in Codex, when the model runs it in another folder: it has already run. If the guard says no, the turn can only be interrupted, and what it read may already have reached the model.
- Image generation: not tested yet.

**Other limits:**

- A model can run a command in another folder. ergo judges it again against the real folder, and the record gets one more call showing that folder. If the guard says no, the command doesn't run and the reason is in the record. When the folder is the owner's working folder, there's no extra call.
- The guard knows PowerShell's file commands: deleting (`Remove-Item`, `del`), writing (`Set-Content`, `Add-Content`, `Out-File`, `New-Item`), moving and copying (`Move-Item`, `Rename-Item`, `Copy-Item`), reading (`Get-Content`, `Get-ChildItem`, `Test-Path`, `Select-String`) and their common aliases. They're judged the same as `rm` and `cat`. A bare file name (`Remove-Item x.json`) counts as a path in the folder the command runs in, so writing or deleting in ergo's config, database or program folders, and reading in the secrets area, are always refused, even with conversation approvals off.
- When the guard can't tell which file a command touches, because the path has `$env:` or a variable in it, or the files come through the pipeline (`Get-ChildItem x | Remove-Item`): writes and deletes always ask you first. Reads ask when conversation approvals are on and go through when they're off, unless the command spells out the secrets area, which is still refused.
- Some forms can't be split apart: script blocks (`% { … }`), `if (…) { … }`, `Invoke-Expression`, and expressions in parentheses (`Remove-Item (Join-Path a b)`). These count as unknown writes, so they ask when conversation approvals are on and go through when they're off. Models often write `if (Test-Path a.txt) { … }`, so with approvals on, even read-only checks often bring up a card. If the command spells out ergo's config, database, program or secrets folders, or runs inside one of them, it still asks or is refused. The guard can't see paths that are built up, such as added strings or variables inside a script block.
- Interactive programs that need someone at the keyboard don't work here. Typing into a running terminal skips the guard, so ergo always turns that feature off when it starts Codex, and it can't be turned on.
- When the hook fails and the call is declined at the approval step, Codex only knows it was declined. The reason is in ergo's record. When the hook stops a call, the reason gets through.
- Codex doesn't report a result for some calls (reading the goal, for example), so the record shows an empty result.

## What it costs

- Signed in with a ChatGPT account: subscription quota. The usage page says it's on subscription quota, not charged per use.
- Signed in with an API key: billed per use, real money. The usage page says there's no unit price here and to go by the provider's bill; not being in the cost total doesn't mean free.
- `OPENAI_API_KEY`, `CODEX_API_KEY` and similar variables are removed from the environment given to Codex, so billing can't quietly change.
- When the quota runs out, the turn fails and the task goes to "Waiting for you" saying so. Send another message once the quota is back.
- One model call is roughly 13,000+ tokens, mostly the system prompt and tool descriptions (measured: 13,651 for a one-line hello). Later calls mostly hit the cache.
- **Waiting for your approval costs little, but not nothing (cards only appear with conversation approvals on):** the default model runs commands inside a block of code. While a command waits on an approval card, it may check for the result a few times, and each check is a model call of roughly 10,000 to 20,000 tokens, mostly cached. ergo's system prompt tells it not to keep checking. Measured with a card left unclicked: 1 to 2 checks in three minutes (without that line in the prompt, 13 checks in two minutes).
  - **It doesn't matter much how long you take:** after 5 minutes (`approvals.waitMinutes` in the config) the call is suspended. The model spends 2 more calls saying so, the turn ends, the task counts as done for now, and no more quota is used. Approve whenever you like: the task goes back to running and the model runs the same command again with no second card, for about 2 more calls. That's about 6 model calls per card. If you deny, the model gets the reason you wrote.
  - **This isn't a hard guarantee:** it depends on the model following the prompt, and we have two samples. If it doesn't, each card costs at most what fits in those 5 minutes, about 30 calls at the rate without the prompt.

## Roll back

Once a conversation is zoomed out, the ↶ on the left of a bar works as usual. Codex forks a new session from before that message and carries on; the original stays as a branch you can switch back to.

**Only the conversation rolls back, not files:** files it changed stay as they are, and the confirmation dialog says so. It can only go back to before a message, not to the start of a stage or step. Conversation from before a takeover can't be rolled back past.

## Good to know

- It can call ergo's tools (submit plan, report progress, send attachments, web search, MCP in the toolkit), each going through the guard.
- Skills in the toolkit are copied for it; the originals stay untouched. Typing `/` in the input box lists ergo's commands and skills; slash commands from the Codex terminal don't work here.
- ergo doesn't read your `~/.codex`, and doesn't write to it or to project configuration.
- Toolkit changes don't apply on the spot: once this turn is done, it restarts with the new toolkit.
- Handing over to Codex's official app isn't available. The secretary, subagents and reviewers are still pi.

## What it can and can't do

The scope of taking over and handing back, all in one place. For the guard in detail see [What the guard covers](#what-the-guard-covers); for quota see [What it costs](#what-it-costs).

**What it can do**

- **Which sessions**: Codex sessions from the terminal and VS Code on this computer, up to 100. `codex exec` runs and sessions ergo started itself aren't listed.
- **Where it carries on**: in the session's original working folder. If that folder is gone, or is inside ergo's data or program folder, the session can't be taken over.
- **What it becomes**: same as Claude Code, a plain task or a project created directly.
- **How far the conversation got**: Codex carries on with the session's own context. At the top of the session ergo lists the most recent stretch, for you only: it doesn't count as new input and isn't saved as memory material.
- **Open sessions**: Codex doesn't let two programs write to a session at once. ergo can't take over a session another program has open, and other programs can't open one ergo holds. An open session can still be taken over as a fork; the original stays as it is.
- **Model**: forked takeovers and rollbacks keep the model the session was using, and don't fall back to the one in Codex's settings.
- **Who records**: while ergo holds the session, only ergo writes to it. Commands, file changes, MCP calls, image viewing, sending subagents, and all of these inside a subagent go through the guard first; arguments and results are recorded in ergo, and usage goes into the ledger.
- **Handing back and taking back**: hand it back in ⚙, carry on in a terminal with `codex resume`, and take it back when you're done. Before taking it back, ergo checks no other program has it open and it hasn't been active in the few minutes since you handed it back.
- **Rolling back**: a new session forks from before that message and carries on; the original stays as a branch you can switch back to.
- **Whose quota**: signed in with a ChatGPT account, your subscription quota; signed in with an API key, billed per use, and the usage page says so. `OPENAI_API_KEY`, `CODEX_API_KEY` and similar variables are removed from the environment it gets.
- **Your configuration**: Codex's own configuration and login. ergo doesn't read `~/.codex`, and doesn't write to it or to project configuration.

**What it can't do, or does with limits**

- **Experimental**: ergo connects through a program interface Codex itself marks as experimental, checked against 0.166. If a Codex update changes it, ergo has to catch up.
- **A session open in a terminal may not be spotted**: the list only guesses from recent activity. Sessions active in the last 5 minutes are labeled **In use**, older ones **May be open**, with the fork ticked by default. Close the terminal first, or take over a fork.
- **Only taken-over sessions can be handed back**: sessions ergo started have no **Hand back to Codex**.
- **No handing back mid-turn**: wait for the turn to finish, or stop it first.
- **Switching to pi cuts the link**: once a taken-over owner is switched to pi in ⚙, it no longer carries on the original session and can't hand it back.
- **Skips the guard, and ergo doesn't record it**: tool search (`tool_search`); the piece of code the model writes itself, and waiting for its result (`exec`, `wait`).
- **Only known afterwards**: a model insisting on web search; a command you set to always run in Codex, when the guard's hook also fails or the command runs in another folder. If the guard says no, the turn can only be interrupted.
- **PowerShell forms the guard can't split apart**: script blocks, `if`, `Invoke-Expression` and expressions in parentheses count as unknown writes. Paths that are built up can't be seen.
- **Always off**: Codex's own web search, so searches go through the service set up in ergo; typing into a running terminal, so interactive programs that need someone at the keyboard don't work. The approval policy is also always the strictest.
- **Rollback is conversation only**: files it changed stay as they are. It can only go back to before a message, not to the start of a stage or step, and not past the conversation from before the takeover. After a rollback, ergo carries on in the forked session, so that's the one to pick in `codex resume` after handing back.
- **After a model change**: if a taken-over session's model is changed in ergo, ergo carries on in a newly started session from then on, while what you get back in the terminal is still the original one.
- **Other things it can't do**: go to Codex's official app; use slash commands from the Codex terminal here; switch toolkits on the spot (it restarts with the new toolkit once the turn is done).
- **Waiting for your approval still costs a little**: it may check for the result a few times. A prompt keeps this down; it isn't a hard guarantee.
- **Still on ergo's own model**: scope review and the branch summary when rolling back.
- **Who can use it**: only task and project owners. The secretary, subagents and reviewers are still pi.

**Not yet fully checked in a real terminal**

- Whether Codex keeps ergo out while its terminal interface has the session open. With `codex exec` or another program holding it, testing showed it does.
- The full round of taking over a session used in a terminal directly (not a fork), handing it back, carrying on in the terminal with `codex resume`, and taking it back to ergo. The way these steps work has been run through with sessions opened by `codex exec`.
- Whether image generation and the extra tools a ChatGPT account brings (apps, plugins) go through the guard.
- The real errors Codex gives when the quota runs out or the login expires. For now ergo handles them the way they were simulated: the task goes to "Waiting for you" with the reason.

## See also

- [Claude Code](claude-code.en.md): the other runtime of this kind.
- [Skills, MCP and plugins](skills-mcp-plugins.en.md): what to put in a toolkit.
- [Settings · Watch categories](settings.en.md): which actions should ask you.
