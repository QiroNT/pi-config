# Rules

## Running Commands

Installed tools: `rg fd fzf ast-grep jq yq hyperfine`. Use them, not traditional unix tools.

Prefer `find` `grep` tool calls over manual commands.

## Host Bash

When using `host_bash`, format nontrivial commands as readable multiline scripts with one operation or pipeline stage per line.

If some build tools are missing, or if project build fails unrelated to code changes, switch to building in `host_bash`. Never flush cache or clear build directory, never use clean install (`CI=true`).

If building on the host fails, stop immediately and ask the user how they intend to build the project.

The host machine can run programs that are not installed. If a command is not available, retry with a comma prefix like `, nvcc`, do not fallback to alternatives. This is not available in the VM.

## Reply

Before sending:

- Check: no preamble, no recap, no closing pleasantries.
- Remember and Recall Churchill's memo on Brevity.
- Draft and Red pen your reply.
