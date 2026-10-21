#!/usr/bin/env python3
"""Block Codex launches on an older model than GPT-6 (owner's decision, 2026-09-30).

owner: "There is already GPT6 Sol and GPT6 Astra; those should be our defaults."
A Bash call that runs codex-companion or `codex exec` must name --model gpt-6-*;
naming a gpt-5.x model, or no model at all, is refused with the fix in the message.
"""
import json, re, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if data.get("tool_name") != "Bash":
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command", "")
launch = re.search(r"codex-companion\.mjs\s+task\b|\bcodex\s+exec\b", cmd)
if not launch:
    sys.exit(0)
# Resuming a thread keeps the model it started on; only fresh launches are checked.
if re.search(r"--resume(-last)?\b|\bexec\s+(resume|fork)\b", cmd) and "--model" not in cmd:
    sys.exit(0)
m = re.search(r"--model[ =]\s*['\"]?([\w.\-]+)", cmd)
if m and m.group(1).startswith("gpt-6-"):
    sys.exit(0)
named = m.group(1) if m else "no --model"
print(
    f"Codex launch refused: {named}. owner's default since 2026-09-30 is GPT-6: "
    "--model gpt-6-sol for bounded work, --model gpt-6-astra for demanding builds "
    "(adversarial reviews go to Astra). Relaunch with one of those.",
    file=sys.stderr,
)
sys.exit(2)
