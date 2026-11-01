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
   - **In use**: Codex says it's open, or it was active minutes ago. Close it there and click "Refresh", or tick "Take over a fork (the original stays as it is)".
   - **May be open**: can't tell. Codex doesn't say who has a session open, and a terminal sitting idle looks the same as a closed one. So the fork is ticked by default; untick it to take over directly once you're sure it's closed.
   - **Held**: another ergo task or project has it. Only a fork can be taken over.
3. For a task, write what it should do next. For a project you can leave this empty.
4. Click "Take over" or "Take over a fork".

The session starts with the backstory: the most recent stretch of the conversation in Codex, shown to you only, not counted as new input.

**Good to know**

- Codex sessions have no lock. If both sides write, the session splits and what one side said is lost. Don't open it in a terminal while ergo holds it.
- A fork is a new session; the original stays as it is.

## Hand back to the terminal, then take it back

**Where:** in the task details or the title bar of the project owner's chat, click ⚙ and find the "Runtime" block.

1. Click "Hand back to Codex". ergo stops writing to this session.
2. Run `codex resume` in a terminal and carry on.
3. When you're done, close it in the terminal, then click "Take back to ergo" in ⚙.

**Good to know**

- Before taking it back, ergo checks the status and recent activity. If it was touched after you handed it back and is still active within minutes, it refuses and says why. Try again a little later.
- A terminal left open without talking can't be detected. Make sure it's closed first, or the session will split when both sides write.
- After a rollback, ergo carries on in a forked session, so that's the one to pick in `codex resume`.

## Model, sandbox, thinking level

**Where:** ⚙ · Runtime. All default to "Follow Codex's own settings".

- **Model**: the list comes from Codex and is empty until the owner has started once. When the model changes, the old model writes a handoff summary and the new one continues in a new session.
- **Sandbox**: read-only, write in the working folder only, or no sandbox (the guard only).
- **Thinking level**: low, medium, high, very high.

The approval policy isn't a choice: ergo always uses the strictest, so calls go through the guard.

## What the guard covers

Every command, file change and MCP tool call goes through ergo's guard first; if it says no, it doesn't run. Arguments and results are recorded in ergo.

**These can't be stopped, only recorded afterwards:**

- Commands the hook missed and Codex treated as read-only: recorded after they ran. If the guard says no, the turn is interrupted.
- Codex's own image viewing, plan list, tool search, MCP resource reading and sleep: recorded afterwards.
- Image generation: done on the model service's side. Recorded afterwards; if the guard says no, the turn is interrupted.
- Sending subagents: recorded afterwards. Commands and file changes inside a subagent still go through the guard.

Codex's own web search is turned off, because it happens on the model service's side and can't be stopped. Owners that may use the internet use ergo's web search, which goes through the guard before each call. With the network switch off, they can't search.

When an approval is declined, Codex only knows it was declined, not why. When the hook stops a call, the reason gets through.

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
