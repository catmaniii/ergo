[中文](codex.md) | **English**

# Codex

If Codex is installed on this computer, task and project owners can work through it, with your own Codex configuration and login. ergo still records its tool calls, and still stops risky ones or asks you. A few things can't be stopped; they're listed below.

Codex sessions you already have going in a terminal can be handed to ergo to carry on, then handed back.

Only task and project owners can use Codex. The secretary can't.

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

1. Codex sessions on this computer are listed, each with title, working folder, branch and last activity. Sessions ergo started aren't listed.
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
- **Sandbox**: read-only, write in the working folder only, or no sandbox (the guard only).
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
- For PowerShell commands, the guard only recognizes paths that are written out: `Remove-Item .\x.json` and `Remove-Item D:\x.json` are judged by path. `Remove-Item x.json`, with only a file name, doesn't show which file it touches, so it's judged only by the folder it runs in. In ergo's config, database or program folders, that means it asks you when conversation approvals are on, and goes through when they're off. The secrets area isn't affected: commands running there are always refused.
- Interactive programs that need someone at the keyboard don't work here. Typing into a running terminal skips the guard, so ergo always turns that feature off when it starts Codex, and it can't be turned on.
- When the hook fails and the call is declined at the approval step, Codex only knows it was declined. The reason is in ergo's record. When the hook stops a call, the reason gets through.
- Codex doesn't report a result for some calls (reading the goal, for example), so the record shows an empty result.

## What it costs

- Signed in with a ChatGPT account: subscription quota. The usage page says it's on subscription quota, not charged per use.
- Signed in with an API key: billed per use, real money. The usage page says there's no unit price here and to go by the provider's bill; not being in the cost total doesn't mean free.
- `OPENAI_API_KEY`, `CODEX_API_KEY` and similar variables are removed from the environment given to Codex, so billing can't quietly change.
- When the quota runs out, the turn fails and the task goes to "Waiting for you" saying so. Send another message once the quota is back.

## Roll back

Once a conversation is zoomed out, the ↶ on the left of a bar works as usual. Codex forks a new session from before that message and carries on; the original stays as a branch you can switch back to.

**Only the conversation rolls back, not files:** files it changed stay as they are, and the confirmation dialog says so. It can only go back to before a message, not to the start of a stage or step. Conversation from before a takeover can't be rolled back past.

## Good to know

- It can call ergo's tools (submit plan, report progress, send attachments, web search, MCP in the toolkit), each going through the guard.
- Skills in the toolkit are copied for it; the originals stay untouched. Typing `/` in the input box lists ergo's commands and skills; slash commands from the Codex terminal don't work here.
- ergo doesn't read your `~/.codex`, and doesn't write to it or to project configuration.
- Toolkit changes don't apply on the spot: once this turn is done, it restarts with the new toolkit.
- Handing over to Codex's official app isn't available. The secretary, subagents and reviewers are still pi.

## See also

- [Claude Code](claude-code.en.md): the other runtime of this kind.
- [Skills, MCP and plugins](skills-mcp-plugins.en.md): what to put in a toolkit.
- [Settings · Watch categories](settings.en.md): which actions should ask you.
