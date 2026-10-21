#!/usr/bin/env python3
"""Eval gate: keeps model-facing files (prompts, model settings) from changing without a fresh passing eval.

Stdlib only. Lives in <project>/evals/ (copy it there with: agent-brain-harness eval-init).

    python3 evals/eval_gate.py check          offline, never calls a model; exit 1 = red
    python3 evals/eval_gate.py run SUITE      run the suite's cases, write evals/results/SUITE.json
    python3 evals/eval_gate.py list           suites and the files each one covers

Layout (paths relative to the project root):
    evals/paths.json            {"suite": ["model-facing/file", ...]}   what each suite covers
    evals/<suite>/cases.jsonl   one case per line, taken from real failures
    evals/results/<suite>.json  written by `run`: score, hash of covered files + cases, calls used
    evals/spend.json            calls made today by `run` (the spend cap)
    evals/config.json           {"model_cmd": "...", "judge_cmd": "...", "daily_call_cap": 50, "min_score": 0.0}

A case: {"id": "...", "prompt": "...", "source": "where the real failure was seen",
         "checks": [{"type": "contains|not_contains|regex|max_chars", "value": ...}], "judge": "one rule, in words"}
Code checks decide first. The optional judge rule is asked of judge_cmd (stdin: rule + answer; stdout starts PASS or FAIL).
The gate is red when a covered file changed since the last run, a suite has no result, the score is 0 (or under min_score),
or the last run was cut off by the daily call cap (its score covers only some cases).
"""
import datetime
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVALS = ROOT / "evals"


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def suites():
    data = load(EVALS / "paths.json", {})
    return {k: v for k, v in data.items() if not k.startswith("_") and isinstance(v, list)}


def digest(suite, files):
    h = hashlib.sha256()
    for rel in sorted(files) + ["evals/%s/cases.jsonl" % suite]:
        p = ROOT / rel
        h.update(rel.encode("utf-8") + b"\0")
        h.update(p.read_bytes().replace(b"\r\n", b"\n") if p.is_file() else b"<missing>")
        h.update(b"\0")
    return h.hexdigest()


def check():
    cfg = load(EVALS / "config.json", {})
    problems = []
    sv = suites()
    if not sv:
        problems.append("evals/paths.json lists no suites")
    for suite, files in sorted(sv.items()):
        gone = [f for f in files if not (ROOT / f).is_file()]
        if gone:
            problems.append("%s: covered file missing: %s" % (suite, ", ".join(gone)))
            continue
        if not (EVALS / suite / "cases.jsonl").is_file():
            problems.append("%s: no cases (evals/%s/cases.jsonl)" % (suite, suite))
            continue
        res = load(EVALS / "results" / (suite + ".json"))
        if not res:
            problems.append("%s: never run. Run: python3 evals/eval_gate.py run %s" % (suite, suite))
        elif res.get("hash") != digest(suite, files):
            problems.append("%s: a covered file or its cases changed since the last run. Run: python3 evals/eval_gate.py run %s" % (suite, suite))
        elif res.get("complete") is False:
            problems.append("%s: the last run was cut off by daily_call_cap, so its score covers only some cases. Raise the cap or run again tomorrow" % suite)
        elif res.get("score", 0) <= 0 or res.get("score", 0) < cfg.get("min_score", 0):
            problems.append("%s: score %s is below the bar (0 is always red)" % (suite, res.get("score")))
    for p in problems:
        print("eval gate RED: " + p)
    if not problems:
        print("eval gate green: %d suite(s)" % len(sv))
    return 1 if problems else 0


def call(cmd, text):
    r = subprocess.run(cmd, shell=True, input=text, capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    if r.returncode != 0:
        raise RuntimeError("%s exited %d: %s" % (cmd, r.returncode, r.stderr.strip()[:200]))
    return r.stdout


def grade(case, answer, cfg, budget):
    for c in case.get("checks", []):
        t, v = c.get("type"), c.get("value")
        if t == "contains" and v not in answer:
            return False, "missing %r" % v
        if t == "not_contains" and v in answer:
            return False, "has %r" % v
        if t == "regex" and not re.search(v, answer):
            return False, "no match for /%s/" % v
        if t == "max_chars" and len(answer) > v:
            return False, "longer than %d" % v
    rule = case.get("judge")
    if rule:
        if not cfg.get("judge_cmd"):
            return False, "case has a judge rule but config has no judge_cmd"
        if not budget():
            return False, "call cap reached"
        verdict = call(cfg["judge_cmd"], "Rule: %s\n\nAnswer:\n%s\n\nReply PASS or FAIL on the first line." % (rule, answer))
        if not verdict.strip().upper().startswith("PASS"):
            return False, "judge: " + verdict.strip().splitlines()[0][:80] if verdict.strip() else "judge: empty"
    return True, ""


def run(suite):
    sv = suites()
    if suite not in sv:
        print("no suite %r in evals/paths.json" % suite)
        return 2
    cfg = load(EVALS / "config.json", {})
    if not cfg.get("model_cmd"):
        print("evals/config.json needs model_cmd (prompt on stdin, answer on stdout)")
        return 2
    cases = [json.loads(l) for l in (EVALS / suite / "cases.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    today = str(datetime.date.today())
    spend = load(EVALS / "spend.json", {})
    if spend.get("date") != today:
        spend = {"date": today, "calls": 0}
    cap = cfg.get("daily_call_cap")

    def budget():
        if cap is not None and spend["calls"] >= cap:
            return False
        spend["calls"] += 1
        return True

    passed, failures = 0, []
    try:
        for case in cases:
            if not budget():
                failures.append({"id": case.get("id"), "why": "call cap reached"})
                continue
            ok, why = grade(case, call(cfg["model_cmd"], case["prompt"]), cfg, budget)
            if ok:
                passed += 1
            else:
                failures.append({"id": case.get("id"), "why": why})
    finally:  # calls already made count against the cap even if a command crashed
        (EVALS / "spend.json").write_text(json.dumps(spend) + "\n", encoding="utf-8")
    cut = any("call cap" in f["why"] for f in failures)
    score = passed / len(cases) if cases else 0.0
    (EVALS / "results").mkdir(parents=True, exist_ok=True)
    (EVALS / "results" / (suite + ".json")).write_text(json.dumps(
        {"suite": suite, "score": round(score, 4), "passed": passed, "total": len(cases), "failures": failures,
         "complete": not cut, "hash": digest(suite, sv[suite]), "ran": datetime.datetime.now().isoformat(timespec="seconds")}, indent=2) + "\n",
        encoding="utf-8")
    print("%s: %d/%d passed, score %.2f; calls today %d" % (suite, passed, len(cases), score, spend["calls"]))
    for f in failures:
        print("  FAIL %s: %s" % (f["id"], f["why"]))
    return 0


def main(argv):
    if len(argv) >= 1 and argv[0] == "check":
        return check()
    if len(argv) == 2 and argv[0] == "run":
        return run(argv[1])
    if len(argv) == 1 and argv[0] == "list":
        for s, f in sorted(suites().items()):
            print("%s: %s" % (s, ", ".join(f)))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
