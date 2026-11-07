[中文](roles-and-permissions.md) | **English**

# Roles and permissions

> **The code is the source of truth. If you change the implementation, update this page too.** Every row names its source: a file plus a function or constant. Paths without a package name are under `packages/daemon/src/`; other packages are written in full. When this page and the code disagree, trust the code and come back to fix this page. Anything not checked is marked "not verified".

"Roles" here means the kinds of agent in ergo: what each one can do, and why. It is not the "role" in Settings · Roles & voices (a name plus a voice). ergo also doesn't give owners job roles like "engineer" or "researcher": an owner can do what its toolkit allows ([ADR-0003](architecture/adr/0003-no-roles-toolkit-per-project.md), in Chinese). Terms follow [CONTEXT.md](../CONTEXT.md) (in Chinese).

## The kinds of agent

| Agent | Who it is | Code |
|---|---|---|
| Secretary | The default place you talk to. Always running, one long main conversation | `secretary/secretary.ts` `startSecretary`; the kernel's tools for it are in `secretary/tool-list.ts` `secretaryToolList` |
| Project owner | One per project (`pm-<n>`). Chat, drafting a plan, executing, doing a change sent by another task, a plain task inside the project, and a scheduled run are each a segment | `projects/maintainers.ts` `assemble`, through `agent-host/assembly.ts` `assemble` |
| Task owner | One for each task outside a project (`tm-<n>`). The owner of a task across several projects uses a fixed toolkit. Scheduled jobs registered in older versions keep running on the job's own owner (`jm-<n>`), assembled as a "run" | `maintainers/maintainers.ts` `taskToolkit`; `agent-host/assembly.ts` `fixedSetup`, `jobRunSetup`; `scheduled-jobs/maintainers.ts` `createJobMaintainers` |
| Sub-agent | Proposed by an owner, started once you agree, gone when done | `sub-agents/assembly.ts` `subAgentAssembly` |
| Reviewer | Judges a stage's deliverables on its own during acceptance; a new process and session each time | `tasks/review.ts` `createReviewer` |
| Memory keeper | Looks after the reasoning graph and tidies it every night at 03:00; you can talk to it on the memory page | `memory/curator.ts` `startMemoryCurator`; its tools are in `memory/curator-tools.ts` `curatorTools` |

Two things that aren't agents: scope review is a separate model call with no tools (`scope-review/scope-review.ts` `createScopeReview`); quick actions are run by the runtime directly, with no agent started (`quick-actions/quick-actions.ts` `createQuickActionService`).

Project and task owners can run on Claude Code or Codex. The assembly is the same place, and the guard still judges the runtime's own tools (`guard/judge.ts` `isRuntimeOwnTool`). The tool lists on this page were checked on pi; how each tool reaches the agent on Claude Code or Codex is **not verified**. See the [Claude Code guide](user-guide/claude-code.en.md#what-it-can-and-cant-do) and the [Codex guide](user-guide/codex.en.md#what-it-can-and-cant-do).

## Three rules

### 1. Having the voice tool doesn't mean speaking up on its own

Every agent that talks to you has the "send voice" tool, `send_voice`. It only goes through in these turns; any other time the tool returns a reason and sends nothing:

- the messages handled this turn include something you said directly (not relayed by the secretary), or you sent a voice message;
- the secretary handling a "read out" notice: a task with **Read out when done** has finished, or a project with **Read updates aloud** has sent an update.

Turns caused by a task working in the background, a scheduled or event-triggered run, or any other runtime notice can't send voice. Which agents have the tool, and the details, are in the [voice section](#voice-when-it-can-speak-and-when-it-cant) below.

Code: `voice/send-voice.ts` `createSendVoice`; `secretary/notice-tags.ts` `isAutoAnnounceNotice`.

### 2. Only people set the boundaries

Only you can change where an agent may reach and what it may use. At most an agent proposes it on a card, and it counts once you click:

- Adding to a toolkit (turning on bash, adding an MCP, turning on network access, turning on "message the secretary", turning on "send attachments") needs your approval; removing things and adding or removing skills don't. Code: `packages/protocol/src/toolkit.ts` `toolkitExpansions`; `toolkit/toolkit.ts` `createToolkitService`.
- Authorized folders: the secretary can only propose; the card always waits for you to click **Run**. Code: `folders/authorize-folders.ts` `authorizeFoldersAction`.
- Folder grants are written only by the runtime; agents have no tool for them. You add them in Settings · Folder grants, in each agent's ⚙, or with **Always allow** on an approval card. Code: `folders/folder-grants.ts` `openFolderGrants`; [ADR-0049](architecture/adr/0049-per-agent-folder-grants.md) (in Chinese).
- Built-in watch categories can only be made stricter. Code: `guard/watch-categories.ts` `builtinDisposition`, `editWatchCategorySettings`.
- Operations plans, going live, scheduled tasks, putting a skill into the library and registering an MCP all only make a card (see the tables below).
- Protected areas (config, secrets, database, skills, ergo's program folder, the service manager's registry and run state) can't be written by anyone, and the secrets areas (including the service manager's `.secrets`) can't even be read. Code: `guard/judge.ts` `protectedAreasOf`, `pathRule`.
- Stopping ergo or killing the service manager only goes through the service manager tools, and no one can go around them: running the service manager's command line (`lsm`), ergo stop/restart/update/rollback/uninstall and `svc`, and non-query requests to the service manager's port are hard refusals; killing ergo's own processes, the service manager or a lifeline service (ergo's public tunnel, the tailnet gateway) is Never, killing other processes asks first, and kills whose targets the guard can't pin down (variables, piped input, kill commands inside commands it can't split) ask even with chat approvals off. Code: `guard/judge.ts` `supervisorRule`, `killProcessRule`; `guard/shell/programs.ts` `opsScript`; `lsm/guard-facts.ts` `supervisorGuardFacts`.

### 3. Isolation buys freedom

An agent that sees less and reaches less gets more leeway:

- With conversation approvals off (the default; the switch is **Ask me before risky things**), anything that would "Ask me first" just runs and is logged for every agent except the secretary; categories are still marked and recorded. Calls that touch a bottom line but can't be judged, and temporal rules a task really breaks, still ask. The secretary can read all of your memory, so writing or deleting outside its scratch area, sending out, accounts and security, irreversible commits, and deleting or overwriting still need your approval. Code: `guard/judge.ts` `letTaskAgentThrough`, `relaxSecretaryAsks`, `SECRETARY_ASKS`; `config/config.ts` `DEFAULT_GUARD_CONFIG`; [ADR-0026](architecture/adr/0026-features-first-security-later.md) (in Chinese).
- Little checking in its own place: writing, editing and deleting in the secretary's scratch area fall into no watch category; an owner reading and writing in its project records and working directory isn't "outside", and deleting or rewriting the task's or project's own temporary files isn't "deleting or overwriting". Code: `guard/judge.ts` `JudgeContext`; `guard/own-temp.ts` `ownTempTest`.
- Sub-agents and reviewers don't inherit folder grants. If one needs another folder, put it in its instructions and let the owner do it. Code: `guard-runtime/guard-runtime.ts` `folderGrantsNow`; [ADR-0049](architecture/adr/0049-per-agent-folder-grants.md) (in Chinese).

Only the "Ask me first" level is relaxed. Hard refusals, "Never", "Hand it to me", protected areas and secrets don't change. Code: `guard/judge.ts` `judgeToolCall`.

## Capability tables

"Same" means the same as the cell to its left. The handling (just do it, ask me first and so on) follows your [watch categories](user-guide/settings.en.md#watch-categories); these tables only say which category a thing falls into.

### Files

| Capability | Secretary | Project owner | Task owner | Sub-agent | Reviewer | Memory keeper | Code |
|---|---|---|---|---|---|---|---|
| Its own place | Scratch area: read, write, delete | Project records and working directory: read, write, delete | Working directory: read, write, delete. Read only while drafting a plan; the owner of a task across several projects has no pi file tools | The owner's place; project records read only | File tools read only; with bash it can run commands in the working directory | No file tools | `guard/paths.ts` `agentScope`; `agent-host/assembly.ts` `EXECUTION_PI_TOOLS`, `PLANNING_PI_TOOLS`, `CHAT_PI_TOOLS`, `fixedSetup`; `sub-agents/assembly.ts` `subAgentAssembly`; `tasks/review.ts` `REVIEWER_PI_TOOLS`; `memory/curator.ts` `startMemoryCurator` |
| Reading elsewhere | Reading the project records area isn't outside; elsewhere falls into "Outside the project folders" | Falls into "Outside the project folders" | Same | Same | Same | — | `guard/judge.ts` `JudgeContext`, `pathRule` |
| Writing or deleting elsewhere | Asks (even with conversation approvals off; with them on, file tools are refused outright) | File tools: hard refusal; bash: falls into "Outside the project folders" | Same | Same | bash: falls into "Outside the project folders" | — | `guard/judge.ts` `pathRule`, `relaxSecretaryAsks` |
| Authorized folders | Reads without asking | Reads without asking | Reads without asking | Reads without asking | Reads without asking | — | `guard-runtime/guard-runtime.ts` `authorizedNow`; `guard/judge.ts` `pathRule`; [ADR-0041](architecture/adr/0041-authorized-folders-read-only-in-guard.md) (in Chinese) |
| Folder grants list | One | One per project, shared by all segments | One per task | None | None | None | `guard-runtime/guard-runtime.ts` `folderGrantsNow`; `daemon.ts` `folderGrantHolders` |
| Protected areas | Never written; the secrets area isn't even read | Same | Same | Same | Same | Same | `guard/judge.ts` `protectedAreasOf`, `pathRule` |
| Stopping ergo, killing the service manager | Only through the service manager tools: its command line and non-query requests to its port are hard refusals, killing their processes is Never | Same | Same | Same | Same | Same | `guard/judge.ts` `supervisorRule`, `killProcessRule` |
| Files with secret-like names in a registered folder | Reading, writing and deleting are all refused | Same | Same | No list | No list | No list | `guard/judge.ts` `grantVerdict`, `folderGrantOutside` |

- A sub-agent's working directory can be a git worktree its owner made for it. Writing project records is always refused; a working directory that sits inside the project records can be written as usual. Code: `guard/judge.ts` `pathRule`; `sub-agents/tools.ts` `proposeParallelTool`.
- When the task's toolkit has bash on, the reviewer can run commands (look at changes, run tests and builds), but gets no commit or merge. Code: `tasks/review.ts` `REVIEWER_SHELL_EXCLUDED`.
- How the secretary's writes outside its scratch area are handled follows the conversation approvals switch: with it on, writing with file tools is a hard refusal (the fence); with it off, it asks. Code: `guard/judge.ts` `pathRule`.
- The kinds of access registered in the folder grants list (read, write and delete separately) don't count as outside, and file-tool writes are no longer refused. Code: `guard/judge.ts` `folderGrantOutside`.
- Whether a job's own owner (`jm-<n>`) has a folder grants list is **not verified**: it's decided by `daemon.ts` `folderGrantHolders`, which checks whether it owns some task.

### Network and talking

| Capability | Secretary | Project owner | Task owner | Sub-agent | Reviewer | Memory keeper | Code |
|---|---|---|---|---|---|---|---|
| Network access | On | Per toolkit; on while drafting a plan and before the charter is confirmed | Per toolkit; on while drafting a plan, for plain tasks, and for tasks across several projects | Same as its owner | Off | Off | `secretary/secretary.ts` `SECRETARY_NETWORK`; `agent-host/assembly.ts` `PLANNING_TOOLKIT`; `tasks/plain.ts` `plainToolkit`; `maintainers/multi-project.ts` `MULTI_PROJECT_TOOLKIT`; `sub-agents/assembly.ts` `subAgentAssembly`; `tasks/review.ts` `createReviewer`; `memory/curator.ts` `startMemoryCurator` |
| Web search, reading pages | Yes | Yes | Yes | Yes | No | No | `conversation/session-tools.ts` `conversationTools`; `sub-agents/sub-agents.ts` `assemble` |
| Sending voice | Yes | Yes | Yes | No | No | Yes | `conversation/session-tools.ts` `conversationTools`; `memory/curator.ts` `startMemoryCurator`; `voice/send-voice.ts` `createSendVoice` |
| Relaying in someone else's voice | Yes, only for senders recorded on the notice | No | No | No | No | No | `voice/send-voice.ts` `createSendVoice`, `relaySenders` |
| Answering by voice when you send voice | Yes | Yes | Yes; a job's own owner (`jm-<n>`) doesn't | No | No | Yes | `agent-host/host.ts` `MAINTAINER_SESSIONS`; `conversation/session-tools.ts` `sessionVoice` |
| Reaching you | Talks in the main conversation | Talks in its own dialog; messages the secretary; asks whoever sent the work order | Talks in its own dialog; messages the secretary; when stuck, goes to "waiting for you" | Can message the secretary only if its owner can; results go back to the owner | Can message the secretary only when the task's toolkit has it on; the verdict goes back to the runtime | Talks in its own conversation | `agent-host/assembly.ts` `letterTools`; `sub-agents/sub-agents.ts` `letterFor`; `tasks/review.ts` `createReviewer`; `tasks/execution-tools.ts` `executionTools`; `work-orders/tool-names.ts` `WORK_ORDER_TOOL` |
| Passing word to another agent | Relays what you said (a quick action; a card first if you didn't spell it out); passes your words to the memory keeper | Writes to the secretary; on a work order from another task, asks the sender and returns a receipt | Writes to the secretary; the owner of a task across several projects sends work orders and answers project owners | Can write to the secretary only if its owner can | Can write to the secretary only when the toolkit has it on | No | `secretary/relay.ts` `relayActions`; `memory/curator-link.ts` `askCuratorTool`; `secretary/letters.ts` `SecretaryLetters`; `work-orders/tool-names.ts` `WORK_ORDER_TOOL`, `MULTI_PROJECT_TOOL` |

- With network access off, network tools and commands are hard refused; the tools are still in the list. Code: `guard/judge.ts` `networkRule`.
- "Message the secretary" (`tell_secretary`) and "send attachments" (`send_attachment`) are two toolkit switches, on unless written as off. Code: `packages/protocol/src/toolkit.ts` `canTellSecretary`, `canSendAttachment`.

### Tasks and projects

| Capability | Secretary | Project owner | Task owner | Sub-agent | Reviewer | Memory keeper | Code |
|---|---|---|---|---|---|---|---|
| Creating tasks | Workflows and long-running tasks only when you spell it out this turn; decides on its own to hand off plain tasks; otherwise only a suggestion card | After the charter is confirmed, creates tasks inside the project from its chat: workflows and long-running tasks only when you spell it out, otherwise at most one suggestion card | No | No | No | No | `tasks/secretary-tools.ts` `taskTools`; `tasks/internal-tools.ts` `internalTaskTools`; `projects/maintainers.ts` `assemble` |
| Scheduling | Creates, changes and cancels simple reminders directly; scheduled tasks only as a card, not for projects | Writes it into the operations plan | No | No | No | No | `reminders/plugin.ts` `remindersPlugin`; `tasks/schedule-tool.ts` `scheduleTaskTool`; `operations/tool-names.ts` `PROPOSE_OPERATIONS_TOOL` |
| Operations plan | Can't change it; relays to the project owner | Drafts it on a card; one confirmation and it takes effect | No | No | No | No | `projects/maintainers.ts` `assemble`; [ADR-0028](architecture/adr/0028-operations-plan-one-confirmation-authorizes.md) (in Chinese) |
| Going live | Only a confirmation card | Only a confirmation card | No | No | No | No | `projects/tool-names.ts` `PROPOSE_GO_LIVE_TOOL` |
| Starting sub-agents | No | Proposes while executing a long-running task; started only once you agree | Same | No | No | No | `agent-host/assembly.ts` `executionSetup`; `sub-agents/tools.ts` `proposeParallelTool`; `sub-agents/assembly.ts` `MAINTAINER_ONLY_TOOLS` |
| Project operations | Calls operations of projects in use, no card | Its own project's auto-made MCP is in its toolkit automatically | Another project's auto-made MCP only if added to the toolkit | No | No | No | `project-ops/tool.ts` `createProjectOps`; `projects/maintainers.ts` `segmentToolkit`; [ADR-0045](architecture/adr/0045-project-ops-auto-mcp.md) (in Chinese) |
| Project services | Gives the entry; starts and stops (does it when you say so, no card) | Checks the events the service reported recently | No | No | No | No | `project-services/secretary-tool.ts` `openServiceTool`, `switchServicesTool`; `project-services/tool-names.ts` `RECENT_SERVICE_EVENTS_TOOL` |

- Whether you "spelled it out" is judged by the runtime from your own words this turn, not by the secretary. Code: `tasks/launch-intent.ts` `launchIntent`, `launchRefusal`; `tasks/launch-tools.ts` `launchTool`.
- When the secretary starts something that names only one project, it becomes that project's internal task, done by the project owner; the secretary doesn't see the details. Code: `tasks/secretary-tools.ts` `taskTools`.
- A project owner doing a change sent by another task, or executing a workflow, has no tools for starting sub-agents or adding and removing skills. Code: `agent-host/assembly.ts` `executionSetup`.

### Tools, skills and config

| Capability | Secretary | Project owner | Task owner | Sub-agent | Reviewer | Memory keeper | Code |
|---|---|---|---|---|---|---|---|
| MCP | Calls registered MCPs, no card, the guard judges as usual | Tools of the MCPs listed in its toolkit; registering, changing or removing one makes a card | Same while executing a long-running task; scheduled runs have the toolkit's MCP tools; none while drafting a plan or for plain tasks | No | No | No | `mcp/call.ts` `createMcpCallService`; `agent-host/assembly.ts` `toolkitParts`, `planningSetup`; `tasks/plain.ts` `plainToolkit`; `sub-agents/sub-agents.ts` `assemble` |
| Writing skills | Can only add, on a card | Add, change, remove, on a card; adds and removes skills in its toolkit | Same while executing a long-running task | No | No | No | `skills/change.ts` `createSkillChangeService`; `toolkit/toolkit.ts` `createToolkitService`; `sub-agents/assembly.ts` `MAINTAINER_ONLY_TOOLS` |
| Using skills | The ones ticked in settings (agent-browser and yt-dlp by default) | Its toolkit's; none while drafting a plan | Its toolkit's, none while drafting a plan; plain tasks use the secretary's | No | No | No | `skills/secretary-skills.ts` `DEFAULT_SECRETARY_SKILLS`; `agent-host/assembly.ts` `toolkitParts`; `maintainers/maintainers.ts` `taskToolkit`; `sub-agents/sub-agents.ts` `launch` |
| Adding to the toolkit | Has no toolkit | A "toolkit change" card from its chat; inside a task, a plan change | A plan change | No | No | No | `toolkit/toolkit.ts` `createToolkitService`; `tasks/execution-tools.ts` `executionTools` |
| Changing config | Can't write it; can propose a few things as quick actions, and authorized folders and the work calendar always wait for your click | Can't write it | Can't write it | Can't write it | Can't write it | Can't write it | `guard/judge.ts` `protectedAreasOf`; `folders/authorize-folders.ts` `authorizeFoldersAction`; `workday/quick-action.ts` `workdayCalendarAction` |

- The skills area is a protected area that no one writes directly; the runtime writes it after you confirm the card. Code: `guard/judge.ts` `protectedAreasOf`; `skills/change.ts` `createSkillChangeService`.
- Sub-agents are started with no skill folders, and pi loads only what it's given. Code: `sub-agents/sub-agents.ts` `launch`; `runtime/agent-child/session.ts` `noSkills`.

### Memory, calendar, browser, data sources

| Capability | Secretary | Project owner | Task owner | Sub-agent | Reviewer | Memory keeper | Code |
|---|---|---|---|---|---|---|---|
| Memory | Searches and reads materials, asks memory, asks the memory keeper, notes a line, saves outside info; a memory brief when something relevant exists | No memory tools | No memory tools | No | No | Tidies up, looks at conclusions, records your verdicts, forgets, stops inferring from a material, reads the question box, interviews | `memory/plugin.ts` `memoryPlugin`; `memory/curator-tools.ts` `CURATOR_TOOL_NAMES` |
| Calendar | Simple reminders; scheduled task cards; a card for changing the work calendar | No | No | No | No | No | `reminders/plugin.ts` `remindersPlugin`; `workday/quick-action.ts` `workdayCalendarAction`; `calendar/plugin.ts` `calendarPlugin` |
| Querying data sources on demand | For sources that are connected with on-demand queries on | No | No | No | No | No | `data-sources/service.ts` `createDataSources` |
| Built-in browser | Page tools, usable only in a turn sent from the browse sidebar or the floating button (including the one that appears when you long-press a page element) | No | No | No | No | No | `browsing/plugin.ts` `browsingPlugin`; `browsing/secretary-tools.ts` `browsingTools`, `browsingTurnOf` |

- The memory, reminders and browsing plugins give their tools only to the secretary; when a plugin is off, its tools are gone. Code: `memory/plugin.ts` `memoryPlugin`; `reminders/plugin.ts` `remindersPlugin`; `browsing/plugin.ts` `browsingPlugin`.
- The memory scope of tasks and projects is only a placeholder for now; owners can't read memory. Code: `tasks/tasks.ts` `briefText`.
- The calendar plugin gives agents no tools, and nothing writes to an outside calendar. Google Calendar is a data source, and on-demand queries are read only. Code: `calendar/plugin.ts` `calendarPlugin`; `google/calendar-source.ts` `googleCalendarSource`.
- Among the page tools, buttons like submit or run are clicked only with a confirmation that you said so this turn; anything labelled pay, delete or publish is never clicked. Code: `browsing/secretary-tools.ts` `browsingTools`.

## Tools each agent gets

Listed for the pi runtime with all plugins on. pi's built-in tools are `read`, `write`, `edit`, `ls`, `grep`, `find` and `bash`. The typed bash tools are `git_status_diff`, `git_commit`, `git_merge`, `git_push`, `create_remote_repo`, `run_tests`, `install_deps` and `start_build`; they exist only when the toolkit has bash on, and with network access off the ones that need the network (`git_push`, `create_remote_repo`, `install_deps`) are left out. The secretary has `bash` but no typed bash tools.

Code: `guard/tool-registry.ts` `TOOL`; `typed-shell/index.ts` `createTypedShell`; `secretary/secretary.ts` `SECRETARY_PI_TOOLS`.

### Secretary

With all plugins on and no data source connected, in the order the model sees them:

<!-- secretary-tools: same as the list asserted in packages/daemon/test/main/reminders.test.ts -->
```text
read write edit ls grep find bash read_attachment send_attachment create_reminder update_reminder cancel_reminder archive_reminder search_materials read_material ask_memory ask_curator mark_woven_question remember_memory ingest_material mcp_call propose_quick_action read_personal_file start_workflow create_task delegate_task suggest_task ask_questions write_task_brief schedule_task suggest_project view_board check_health read_project_records open_service switch_project_services project_ops propose_go_live propose_skill list_inbox show_card lsm_status lsm_logs lsm_control lsm_force lsm_entries lsm_restart_self browse_read_page browse_fill find_files view_files browse_attach_files browse_open browse_snapshot browse_click browse_element_content browse_element_download web_search web_fetch spoken_summary send_voice
```

- The reminders plugin gives `create_reminder` through `archive_reminder`, the memory plugin `search_materials` through `ingest_material`, the browsing plugin `browse_read_page` through `browse_element_download`, and the voice plugin `spoken_summary` and `send_voice`. When a plugin is off, its stretch is gone.
- With data sources connected and on-demand queries on, there are also `query_looki`, `query_google_calendar`, `search_gmail` and `read_gmail`.

Code: `secretary/secretary.ts` `startSecretary`; `secretary/tool-list.ts` `secretaryToolList`; `data-sources/service.ts` `createDataSources`.

### Project owner

| Segment | Tools |
|---|---|
| Chat, before the charter is confirmed | `read` `write` `edit` `ls` `grep` `find` `submit_charter` `write_segment_summary` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| Chat, after the charter is confirmed | The above, plus `propose_charter_change` `propose_standard_change` `propose_operations` `propose_go_live` `check_ops` `recent_service_events` `start_workflow` `create_task` `suggest_task` `write_task_brief` `adjust_skills` `request_toolkit_change` `request_mcp_change` `request_skill_change`, and the toolkit's MCP tools |
| Work order for drafting a plan | `read` `ls` `grep` `find` `submit_plan` (`propose_plan` for workflows) `write_progress` `ask_clarification` `write_segment_summary` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| Work order for executing a long-running task | The task owner's set for executing a long-running task, plus `ask_clarification` `write_segment_summary`; after the charter is confirmed also `propose_charter_change` `propose_standard_change` `propose_operations` `propose_go_live` `check_ops` `recent_service_events` |
| Work order for executing a workflow | `read` `write` `edit` `ls` `grep` `find` `report_step` `wait_for_user` `fail_task` `propose_plan` (always refused during execution) `write_progress` `ask_clarification` `write_segment_summary` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| A change sent by another task | `read` `write` `edit` `ls` `grep` `find` `submit_receipt` `ask_clarification` `write_segment_summary`; after the charter is confirmed also `propose_charter_change` `propose_standard_change` `propose_operations` `propose_go_live` `check_ops` `recent_service_events` `request_mcp_change` `request_skill_change`; plus the ones every segment has, `web_search` through `send_attachment`. No tools for moving stages, starting sub-agents, or `adjust_skills` |
| Plain task inside the project | `read` `write` `edit` `ls` `grep` `find` `write_segment_summary` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment`, and the toolkit's MCP tools |
| Scheduled run | For a plain task: the plain-task set plus `fail_job_run`. For a workflow: the same plus `report_step` and `propose_plan` (always refused), with the toolkit being the overlap of the authorized plan's and the project's |

When the toolkit has bash on, every segment also gets `bash` and the typed bash tools. When the toolkit has "message the secretary" or "send attachments" off, `tell_secretary` or `send_attachment` is left out.

Code: `projects/maintainers.ts` `assemble`, `segmentToolkit`; `agent-host/assembly.ts` `chatSetup`, `planningSetup`, `executionSetup`, `plainTaskSetup`, `jobRunSetup`; `tasks/workflow-tools.ts` `workflowExecutionTools`; `scheduled-jobs/jobs.ts` `runAssembly`.

### Task owner

| Segment | Tools |
|---|---|
| Drafting a plan | `read` `ls` `grep` `find` `submit_plan` (`propose_plan` for workflows) `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| Executing a long-running task | `read` `write` `edit` `ls` `grep` `find` `start_stage` `complete_stage` `report_progress` `wait_for_user` `propose_plan_change` `revise_plan` `mark_infeasible` `fail_task` `propose_parallel` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` `adjust_skills` `request_mcp_change` `request_skill_change`, and the toolkit's MCP tools |
| Executing a workflow | `read` `write` `edit` `ls` `grep` `find` `report_step` `wait_for_user` `fail_task` `propose_plan` (always refused during execution) `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment`, and the toolkit's MCP tools. No starting sub-agents, no adding or removing skills |
| Plain task | `read` `write` `edit` `ls` `grep` `find` `bash`, the typed bash tools, `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| Scheduled run | For a plain task: the plain-task set plus `fail_job_run`. For a workflow: the toolkit follows the authorized plan; reading and writing, the ones every segment has, plus `report_step` `fail_job_run` `propose_plan` (always refused) |
| Task across several projects | `read_project_records` `dispatch_work_order` `summarize_receipts`; plus `submit_plan` while drafting, and while executing the stage tools plus `answer_work_order` `forward_to_user`; `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment`. No pi built-in tools |

While executing, a toolkit with bash on also gives `bash` and the typed bash tools.

Code: `maintainers/maintainers.ts` `taskToolkit`; `agent-host/assembly.ts` `executionSetup`, `fixedSetup`; `tasks/workflow-tools.ts` `workflowExecutionTools`; `scheduled-jobs/jobs.ts` `runAssembly`; `work-orders/tool-names.ts` `MULTI_PROJECT_TOOL`.

### Sub-agent

Its owner's current pi built-in tools; of the typed bash tools, `web_search`, `web_fetch` and `tell_secretary`, the ones its owner also has. No MCP, no skills, no `spoken_summary` or `send_voice`, and nothing for moving the task forward, drafting a plan, proposing parallel work, `send_attachment` or `request_skill_change`.

Code: `sub-agents/sub-agents.ts` `assemble`; `sub-agents/assembly.ts` `subAgentAssembly`, `MAINTAINER_ONLY_TOOLS`.

### Reviewer

`read` `ls` `grep` `find` `submit_review`. With bash on in the task's toolkit, also `bash` `git_status_diff` `run_tests` `start_build`; with "message the secretary" on in the task's toolkit, also `tell_secretary`.

Code: `tasks/review.ts` `createReviewer`, `REVIEWER_PI_TOOLS`, `REVIEWER_SHELL_EXCLUDED`.

### Memory keeper

`run_memory_consolidation` `inspect_memory` `review_memory_claim` `forget_material` `no_infer_material` `memory_questions` `search_materials` `read_material` `begin_interview` `finish_interview` `forget_interview_answers` `propose_personal_file`; with the voice plugin running, also `spoken_summary` `send_voice`. No pi built-in tools, no network.

Code: `memory/curator-tools.ts` `CURATOR_TOOL_NAMES`; `memory/curator.ts` `startMemoryCurator`.

## Voice: when it can speak and when it can't

Each `send_voice` call looks at what message this turn is handling, not at which agent is calling:

| This turn | Does it go through? |
|---|---|
| You type to the secretary | Yes |
| You type in a project owner's, task owner's or the memory keeper's conversation; also when it reaches a busy owner as an interjection | Yes |
| You sent a voice message | This turn is answered by voice anyway; the tool says it's already being synthesized |
| Something the secretary relayed (to an owner, or to the memory keeper) | Not in that turn: you aren't in that conversation |
| A task with **Read out when done** finishes, or a project with **Read updates aloud** sends an update | Yes, in the turn where the secretary handles that notice |
| Other runtime notices: a task finishing with the switch off, an approval granted, a status change | No |
| A task working in the background, a scheduled or event-triggered run | No |
| No reference voice yet | Nothing is sent; Inbox prompts you to import one |
| Code, tables, links or other things that can't be read aloud, or too long | Nothing is sent; the reason comes back |

Code: `voice/send-voice.ts` `createSendVoice`, `SEND_VOICE_WAIT_MS`; `secretary/notice-tags.ts` `isAutoAnnounceNotice`, `AUTO_ANNOUNCE_TAG`.

- **Who has the tool**: the secretary, every segment of project and task owners, and the memory keeper, all only while the voice plugin is running. Sub-agents and reviewers don't. Code: `conversation/session-tools.ts` `conversationTools`; `sub-agents/sub-agents.ts` `assemble`; `tasks/review.ts` `createReviewer`.
- **Relaying in someone else's voice**: only the secretary's conversation can pass `relay`. It only relays senders recorded on a notice; when the sender has no voice of its own, it becomes one message in the secretary's voice. Code: `voice/send-voice.ts` `createSendVoice`, `relaySenders`.
- **Who turns the switches on**: you, in the task details or the project records; the secretary only through a quick action when you spelled it out this turn. Tasks and jobs inside a project don't notify the secretary when done, so they have no read-out. Code: `tasks/task-control.ts` `taskRunActions`, `projectAnnounceAction`; `secretary/task-done.ts` `startTaskDoneNotices`.
- How to use it: [ergo answering by voice](user-guide/voice.en.md#ergo-answering-by-voice).

## How to change these tables

When you add a tool for an agent, change these places together:

1. **Which agent gets it**:
   - the secretary's kernel tools: `secretary/tool-list.ts` `secretaryToolList`; the order is the order the model sees;
   - a plugin's: registered as an agent contribution, saying who it's for (`agent-host/contributions.ts` `ContributionScope`);
   - an owner's: the function for that kind of session in `agent-host/assembly.ts`; for project owners also `projects/maintainers.ts` `assemble`;
   - the memory keeper's: `memory/curator-tools.ts`, with the name added to `CURATOR_TOOL_NAMES`;
   - the reviewer's: `tasks/review.ts` `createReviewer`.
2. **Should sub-agents have it**: a sub-agent's candidates are only the typed bash tools, web search and page reading, and messaging the secretary (`sub-agents/sub-agents.ts` `assemble`). Owner-only tools (moving the task forward, making cards for you, writing into a library) go into `sub-agents/assembly.ts` `MAINTAINER_ONLY_TOOLS`.
3. **The guard's registration**: a tool run on the agent's behalf declares `readOnlyOrIdempotent` and `nature` in its definition (`agent-manager/host-tools.ts` `defineHostTool`); built-in ones (pi's, typed bash, network) are in `guard/tool-registry.ts` `BUILTIN_TOOL_REGISTRY` with category tags, read or write for path arguments, and whether they use the network.
4. **Tests**: the secretary's full list is asserted one by one, order included, in `packages/daemon/test/main/reminders.test.ts` and `packages/daemon/test/main/tasks.test.ts`; the task owner's list while drafting a plan is in `packages/daemon/test/main/tasks.test.ts`. `packages/daemon/test/roles-doc.test.ts` checks that the sources and tool names on this page still exist in the code, that the secretary's list matches the one reminders.test.ts asserts, and that the Chinese and English pages cite the same sources.
5. **Both language versions of this page**: the row in the capability tables, and the "Tools each agent gets" section.

When you change the guard's rules (a new hard refusal, a protected area, a watch category, the scope of conversation approvals), update the "Files" table and the "Three rules".

## Not verified

- For owners running on Claude Code or Codex: how each tool reaches the agent, and how the list differs from pi's.
- Whether a job's own owner (`jm-<n>`) has a folder grants list.
- Where the on-demand data source tools sit in the secretary's tool order.
