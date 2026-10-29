# Tickets (tickets/)

> **What goes here**: the implementation tickets cut from the spec during building, one file per ticket, in the same format as Ergo's own tickets. Each ticket delivers one thin slice end to end and states its acceptance criteria and dependencies.
> **When to update**: cut the tickets once the spec is written and building starts; while working on a ticket, update its Status, tick its acceptance criteria and note trade-offs under Comments; add tickets when the scope grows, and mark dropped ones wontfix.
> Project standard v1 · Development (not checked; track ticket progress in the progress notes)

File name: `<number>-<short-name>.md`, numbered from `01`, with tickets that others depend on numbered first.

Each ticket looks like this:

~~~
# 01 — <What this ticket does>

Status: ready-for-agent
Blocked by: none

## What to build

## Acceptance criteria

- [ ] 

## Comments
~~~

Status values: needs-triage (the maintainer should take a look), needs-info (waiting for more information), ready-for-agent (clear enough to hand to a sub-agent), ready-for-human (needs a person), done (finished, all acceptance criteria ticked), wontfix (not doing it).
Blocked by lists the numbers of the tickets it depends on (comma-separated), or "none". Work in waves by dependency: one sub-agent per ticket, merged only when the tests pass.
