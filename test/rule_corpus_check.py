#!/usr/bin/env python3
"""Regression tests for kilo/scripts/rule_corpus_check.py.

Run: python3 test/rule_corpus_check.py

The four checks are mechanical re-verification of the rule-gate judgment:
each test builds a throwaway git project whose records either satisfy or
contradict one check, then asserts the exit code and the finding text.
A clean project must exit 0 with zero findings; every contradiction must
produce exactly the finding it names.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "kilo", "scripts", "rule_corpus_check.py",
)

failures = []


def check(name, fn):
    try:
        fn()
        print(f"  ok  {name}")
    except AssertionError as e:
        failures.append(f"{name}: {e}")
        print(f"FAIL  {name}: {e}")
    except Exception as e:  # noqa: BLE001 - a crash in a test is a failure
        failures.append(f"{name}: crashed {type(e).__name__}: {e}")
        print(f"FAIL  {name}: crashed {type(e).__name__}: {e}")


def git(repo, *args):
    r = subprocess.run(
        ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t",
         "-c", "commit.gpgsign=false", *args],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {r.stderr}")
    return r.stdout


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def run_checker(project, *extra):
    return subprocess.run(
        [sys.executable, SCRIPT, project, *extra],
        capture_output=True, text=True,
    )


AGENTS_CLEAN = """# Project rules

## Tooling
- Always run the formatter before committing any change to the source tree.

## Testing
- Every fix must ship with a regression test that fails before the fix.

## Retired
- legacy-runner
"""

AGENTS_DIRTY = """# Project rules

## Tooling
- Always run the formatter before committing any change to the source tree.
- The legacy-runner is the default entrypoint for all project scripts.

## Testing
- Every fix must ship with a regression test that fails before the fix.
- Before closing a build, verify the observable by running it and quoting the output.
- Before closing a build, verify the observable by running it and quoting the output verbatim.

## Retired
- legacy-runner
"""


def make_dirty_project(root):
    p = os.path.join(root, "dirty")
    write(os.path.join(p, "README.md"), "# demo\n")
    write(os.path.join(p, "src.txt"), "code\n")
    git(p, "init", "-q")
    git(p, "add", "-A")
    git(p, "commit", "-qm", "c0: initial")
    c0 = git(p, "rev-parse", "--short", "HEAD").strip()

    write(os.path.join(p, "AGENTS.md"), AGENTS_CLEAN)
    git(p, "add", "-A")
    git(p, "commit", "-qm", "c1: add rules")
    c1 = git(p, "rev-parse", "--short", "HEAD").strip()

    write(os.path.join(p, "AGENTS.md"), AGENTS_CLEAN
          + "- Run the full suite, not just the touched test file, before closing.\n")
    git(p, "add", "-A")
    git(p, "commit", "-qm", "c2: grow rules")
    c2 = git(p, "rev-parse", "--short", "HEAD").strip()

    # Now the dirty corpus and the records that contradict it.
    write(os.path.join(p, "AGENTS.md"), AGENTS_DIRTY)
    write(os.path.join(p, "LOG", "2026-01-01-format.md"),
          f"""# {c1} — Tighten tooling rules

Re-seated the tooling section.

**Files touched:** AGENTS.md
Rule gate: format-tightening — run, kept the corpus lean
""")
    write(os.path.join(p, "LOG", "2026-01-02-prose.md"),
          f"""# {c2} — Housekeeping pass

Reworded the testing section.

**Files touched:** AGENTS.md
""")
    write(os.path.join(p, "LOG", "2026-01-03-build.md"),
          f"""# {c2} — Fix the parser

Fixed the off-by-one in the token loop.

**Files touched:** src.txt
Rule gate: none — not needed, build did not touch rules
""")
    write(os.path.join(p, "LOG", "2026-01-04-build2.md"),
          f"""# {c0} — Fix the logger

Rotated the log files.

**Files touched:** src.txt
Rule gate: none — not needed, no rule changes
""")
    write(os.path.join(p, "LOG", "2026-01-05-nohash.md"),
          """# Housekeeping without a hash

Tidied the testing section wording.

**Files touched:** AGENTS.md
Rule gate: none — not needed, cosmetic only
""")
    write(os.path.join(p, "LOG", "index.md"), "# LOG Index\n")
    write(os.path.join(p, "QUEUE.md"), "# Queue\n\n## Unprocessed\n\n## Processed\n")
    return p, c0, c1, c2


def make_clean_project(root):
    p = os.path.join(root, "clean")
    write(os.path.join(p, "README.md"), "# demo\n")
    git(p, "init", "-q")
    git(p, "add", "-A")
    git(p, "commit", "-qm", "c0: initial")
    c0 = git(p, "rev-parse", "--short", "HEAD").strip()

    write(os.path.join(p, "AGENTS.md"), AGENTS_CLEAN)
    git(p, "add", "-A")
    git(p, "commit", "-qm", "c1: add rules")
    c1 = git(p, "rev-parse", "--short", "HEAD").strip()

    write(os.path.join(p, "LOG", "2026-01-01-format.md"),
          f"""# {c1} — Tighten tooling rules

Re-seated the tooling section.

Rule gate: format-tightening — run, kept the corpus lean
""")
    write(os.path.join(p, "LOG", "2026-01-04-build2.md"),
          f"""# {c0} — Fix the logger

Rotated the log files.

**Files touched:** README.md
Rule gate: none — not needed, no rule changes
""")
    write(os.path.join(p, "LOG", "index.md"), "# LOG Index\n")
    return p


def test_clean_project_exits_zero():
    root = tempfile.mkdtemp(prefix="tl-rcc-clean-")
    try:
        p = make_clean_project(root)
        r = run_checker(p)
        assert r.returncode == 0, f"exit {r.returncode}, out:\n{r.stdout}\n{r.stderr}"
        assert "findings: 0" in r.stdout, r.stdout
        assert "never that the rules are good" in r.stdout, r.stdout
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_dirty_project_reports_all_four_checks():
    root = tempfile.mkdtemp(prefix="tl-rcc-dirty-")
    try:
        p, c0, c1, c2 = make_dirty_project(root)
        r = run_checker(p)
        assert r.returncode == 1, f"exit {r.returncode}, out:\n{r.stdout}\n{r.stderr}"
        # gate-line: the prose entry touched AGENTS.md with no gate line
        assert re.search(
            r"\[gate-line\] 2026-01-02-prose\.md", r.stdout
        ), r.stdout
        # and the gate-bearing entry must NOT be flagged
        assert "2026-01-01-format.md" not in re.findall(
            r"\[gate-line\] (\S+)", r.stdout
        ), r.stdout
        # not-needed-growth: the build entry claims 'not needed' on c2,
        # the commit that grew AGENTS.md
        assert re.search(
            rf"\[not-needed-growth\] 2026-01-03-build\.md.*{c2}", r.stdout
        ), r.stdout
        # the non-growing not-needed entry (c0) must not be flagged
        assert "2026-01-04-build2.md" not in re.findall(
            r"\[not-needed-growth\] (\S+)", r.stdout
        ), r.stdout
        # the hashless not-needed entry is a note, not a finding
        assert "skipped not-needed-growth" in r.stdout, r.stdout
        assert "2026-01-05-nohash.md" in r.stdout, r.stdout
        # near-dup: the two closing-verification bullets
        assert "[near-dup]" in r.stdout, r.stdout
        # retired-name: the live tooling bullet names legacy-runner
        assert re.search(r"\[retired-name\].*legacy-runner", r.stdout), r.stdout
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_clean_corpus_no_false_positives():
    """The clean project's two real rules must not trip near-dup, and its
    Retired bullet must not be treated as a live rule."""
    root = tempfile.mkdtemp(prefix="tl-rcc-fp-")
    try:
        p = make_clean_project(root)
        r = run_checker(p)
        assert "[near-dup]" not in r.stdout, r.stdout
        assert "[retired-name]" not in r.stdout, r.stdout
        assert "[gate-line]" not in r.stdout, r.stdout
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_capture_queue_files_and_dedupes():
    root = tempfile.mkdtemp(prefix="tl-rcc-cap-")
    try:
        p, _, _, _ = make_dirty_project(root)
        q = os.path.join(p, "QUEUE.md")
        r1 = run_checker(p, "--capture-queue", q)
        assert r1.returncode == 1, r1.stdout
        assert "capture filed:" in r1.stdout, r1.stdout
        text = open(q, encoding="utf-8").read()
        # items land inside Unprocessed, before Processed
        unprocessed = text.split("## Processed")[0]
        slugs = re.findall(r"\[rule-check-[a-z-]+-[0-9a-f]{8}\]", unprocessed)
        assert len(slugs) >= 4, f"expected >=4 captures, got {slugs}\n{text}"
        assert all(s in text for s in slugs)
        # re-run: stable slugs, no duplicates
        r2 = run_checker(p, "--capture-queue", q)
        assert "already filed" in r2.stdout, r2.stdout
        text2 = open(q, encoding="utf-8").read()
        for s in slugs:
            assert text2.count(s) == 1, f"slug duplicated: {s}"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_missing_rules_file_is_usage_error():
    root = tempfile.mkdtemp(prefix="tl-rcc-usage-")
    try:
        r = run_checker(root)
        assert r.returncode == 2, f"exit {r.returncode}: {r.stdout}{r.stderr}"
        assert "no rules file" in r.stderr, r.stderr
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_explicit_rules_flag():
    root = tempfile.mkdtemp(prefix="tl-rcc-explicit-")
    try:
        p = make_clean_project(root)
        # rename AGENTS.md so the default discovery misses it
        os.rename(os.path.join(p, "AGENTS.md"), os.path.join(p, "RULES.md"))
        r = run_checker(p, "--rules", os.path.join(p, "RULES.md"))
        assert r.returncode == 0, r.stdout
        assert "rules: 1 file(s)" in r.stdout, r.stdout
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    check("clean project exits zero", test_clean_project_exits_zero)
    check("dirty project reports all four checks", test_dirty_project_reports_all_four_checks)
    check("clean corpus has no false positives", test_clean_corpus_no_false_positives)
    check("capture queue files and dedupes", test_capture_queue_files_and_dedupes)
    check("missing rules file is a usage error", test_missing_rules_file_is_usage_error)
    check("explicit --rules flag works", test_explicit_rules_flag)
    print(f"\n{len(failures)} failure(s)" if failures else "\nall passed")
    sys.exit(1 if failures else 0)
