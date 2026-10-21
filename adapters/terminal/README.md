# Any command-line LLM (aider, ollama, llm, others)

Add an entry under `apps` in `.harness/harness.json`. Placeholders you can use in the argument list:
`{kickoff}` (one-line start prompt), `{boot}` (path to BOOT.md), `{python}`, `{root}`, `{workspace}`.

Examples (check each tool's own `--help`; these are sketches, not tested):
```json
"aider":  {"interactive": ["aider", "--message", "{kickoff}"], "headless": ["aider", "--yes", "--message", "{kickoff}"], "stdin": false},
"llm":    {"headless": ["llm"], "stdin": true},
"ollama": {"headless": ["ollama", "run", "llama3"], "stdin": true}
```

- `"stdin": true` sends BOOT.md on standard input. `false` appends the kickoff line as the last argument.
- A tool that only chats and cannot run commands needs a human courier: use `"interactive": "print"` and see `adapters/chat/`.
- Then: `harness launch manager --app aider`.
