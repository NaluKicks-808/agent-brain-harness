# Eval gate kit

Copy into a project with `agent-brain-harness eval-init`. Then:

1. List every model-driven component and the files that steer it in `evals/paths.json` (one suite each).
2. Put real failures in `evals/<suite>/cases.jsonl`, one case per line. Code checks decide first; one judge rule is optional.
3. Set `model_cmd` (and `judge_cmd`) in `evals/config.json`. `daily_call_cap` is the spend cap, counted in model calls.
4. `python3 evals/eval_gate.py run <suite>`, then commit the result file with the change.
5. `python3 evals/eval_gate.py check` runs offline. The pre-push gate runs it when `evals/` exists. A score of 0, a stale result or a passed cap is red.

The files in `summarizer/` and `paths.json` are examples: replace them.
