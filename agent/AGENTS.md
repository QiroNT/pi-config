## Running Commands

Installed tools: rg fd fzf ast-grep jq yq hyperfine. Use them, not traditional unix tools.

## Host Bash

When using `host_bash`, format nontrivial commands as readable multiline scripts with one operation or pipeline stage per line.

If some build tools are missing, or if project build fails unrelated to code changes, switch to building in `host_bash`.

If building on the host fails, stop immediately and ask the user how they intend to build the project.

The host machine can run programs that are not installed. If a command is not available, retry with a comma prefix like `, nvcc`. Never fallback to alternatives. This is not available in the VM.

## Coding Style

Split blocks of code into logical units separated by a blank line. A unit should have a single purpose.

## Writing

Before sending a reply, draft and red pen:

- Check: no preamble, no recap, no closing pleasantries.
- Check for missing prepositions.
- Keep the reply brief, but not short
  - Structure the reply as a set of short, crisp paragraphs.
  - If a result depends on analysis, put the analysis in Appendix sections.
  - Prefer writing with headings only, which can be expanded when asked.
