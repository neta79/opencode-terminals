# opencode-terminals

A skill that gives **OpenCode v2 agents awareness of their own embedded terminal
sessions** and instructions for cooperating with the user in a shared terminal.

The agent can read the same terminal tab you see, run commands there, and leave
the session open for you to continue. Work stays in the tab's existing
environment: its working directory, shell variables, virtualenv, SSH connection,
container shell, and running processes. A separate shell-tool invocation would
not inherit that state.

## What it does

- Lists, creates, reads, and closes terminal tabs belonging to the current
  OpenCode conversation.
- Runs shell commands or sends exact input to interactive applications.
- Reads the screen before acting, so the agent can continue work in the host,
  container, or shell you already have open.
- Distinguishes OpenCode's shared terminals from your own terminal application
  or sessions elsewhere, which the agent cannot see.
- Teaches the agent to take turns with you, preserve unfinished input, and
  verify results rather than assume a successful send means a finished command.

This repository contains a skill and a small Node.js helper, not an MCP server
or an OpenCode plugin. The helper uses the OpenCode CLI for authenticated API
requests and a WebSocket connection for terminal input.

## Requirements

- OpenCode **v2** with embedded terminal support and the `opencode` CLI available.
- Node.js with built-in WebSocket support.
- An agent allowed to use the skill and shell tool.

Verified with **OpenCode v2.1.2** and **Node.js v24.18.0**. No npm packages or
build step are required. The helper uses experimental terminal APIs; other
OpenCode versions may require adjustments.

## Installation

Clone the repository into OpenCode's global compatibility skill directory,
using `terminals` as the directory name:

```sh
mkdir -p "$HOME/.agents/skills"
git clone https://dev.tai.it/gogs/agronchi/opencode-terminals.git \
  "$HOME/.agents/skills/terminals"
```

OpenCode discovers skills under `~/.agents/skills`. The skill ID is `terminals`.
The helper is resolved relative to the skill's base directory, so other
OpenCode skill locations work without editing `SKILL.md`.

## Usage

Mention `@terminals` to load the skill explicitly, or ask the agent to work in
the conversation's terminal. For example:

> Open a new terminal in this conversation.

> Read what I typed in our shared terminal.

> Run the tests in the same terminal. I've left it at an empty shell prompt.

> Continue in the container shell I already have open in the terminal.

The agent should inspect the existing tabs before choosing one and ask if the
target remains ambiguous. If no terminal exists and the task needs one, it can
create a shared tab.

### Helper commands

The agent uses the bundled helper from within an OpenCode session, where
`OPENCODE_SESSION_ID` identifies the current conversation:

```sh
# Use the base directory supplied when the skill is loaded.
SKILL_DIR="/absolute/path/to/skill"
SCRIPT="$SKILL_DIR/scripts/terminals.mjs"

node "$SCRIPT" list
node "$SCRIPT" create --cwd "/path/to/project" --title "Shared work"

# Set PTY_ID to an ID returned by list or create.
node "$SCRIPT" read --id "$PTY_ID"
node "$SCRIPT" read --id "$PTY_ID" --all
node "$SCRIPT" run --id "$PTY_ID" --command 'pwd'
node "$SCRIPT" run --id "$PTY_ID" --command 'make test' --rc
node "$SCRIPT" send --id "$PTY_ID" --text 'literal input'

# Only when terminating the terminal and its processes is intended.
node "$SCRIPT" close --id "$PTY_ID"
```

Output is JSON. `run` appends Enter; `send` sends exactly the supplied text.
The helper refuses terminals outside the current conversation. For a known
standalone or remote OpenCode server, pass `--server URL` on every invocation
using the existing CLI authentication environment.

## Shared control and limitations

- **Take turns.** Sending input takes controller ownership. The helper
  disconnects afterward, but the user may need to reclaim input through the
  terminal UI. Reading does not take control.
- **Keep the user's work intact.** The skill instructs the agent not to clear
  the screen, discard unfinished input, interrupt a process, or close a terminal
  without authorization. Input guards help, but do not make concurrent typing
  safe.
- **Quiet output is not completion.** `idle` only means output stopped changing
  briefly. The agent must inspect the result. Opt-in `--rc` appends an exit-code
  marker for non-interactive shell commands; a missing marker means the exit
  code is unknown.
- **Reads are snapshots, not a complete transcript.** `--all` returns the whole
  retained buffer, not output that has already been lost.
- **A timeout is not proof of failure.** Input may already have executed. Read
  the terminal before retrying a command.
- **Renaming existing tabs is unsupported** by the verified API. An initial
  title can be set on creation, though the shell may overwrite it.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`SKILL.md`](SKILL.md) | Agent instructions, workflows, and safety rules. |
| [`scripts/terminals.mjs`](scripts/terminals.mjs) | Dependency-free terminal helper. |
| [`scripts/terminals.test.mjs`](scripts/terminals.test.mjs) | Helper tests. |
| [`references/protocol.md`](references/protocol.md) | Verified API protocol and troubleshooting notes. |
| [`evals/evals.json`](evals/evals.json) | Behavioral evaluation prompts and expected agent actions. |

Run the helper tests from the repository root:

```sh
node --test scripts/terminals.test.mjs
```
