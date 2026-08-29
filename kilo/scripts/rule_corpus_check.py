#!/usr/bin/env python3
"""Mechanical checks over a project's rule corpus and its rule-gate records.

Why this exists: the rule gate the method ships is judgment — at close, a
session whose work touched the project's rules records a disposition
(`Rule gate: <slug> — run, …` / `— not needed, <why>`; see the vendored
docs/next.md and docs/done-build.md). Upstream pairs that judgment with a
small script that re-checks the mechanical half against the project's own
records; upstream's copy is hardwired to their repo's paths, so this port
ships a layout-agnostic re-implementation of the same four checks:

  1. gate-line          every rule-authoring session's LOG entry carries a
                        `Rule gate:` line
  2. not-needed-growth  a "not needed" disposition is not contradicted by
                        rule text growing in the entry's own commit
  3. near-dup           no two rule segments say nearly the same thing
  4. retired-name       no live rule names a retired mechanism

A rule-authoring session is detected conservatively: the entry's
`**Files touched:**` line (or its `# <hash> — title` line) names a rules
file. Entries that merely mention a rules file in prose are not treated as
rule-authoring.

Contract:
  python3 rule_corpus_check.py <project_dir>
      [--rules PATH ...]      rules files; default: AGENTS.md / CLAUDE.md
                              present in <project_dir> (at least one required)
      [--log-dir DIR]         session records; default <project_dir>/LOG
      [--dup-threshold F]     near-duplicate similarity; default 0.85
      [--retired NAME ...]    extra retired-mechanism names beyond any
                              `## Retired` section in the rules files
      [--capture-queue PATH]  append findings to PATH's Unprocessed section
                              as work items (one per finding, stable slug;
                              re-runs do not duplicate)

Exit codes: 0 clean, 1 findings, 2 usage/setup error.

What a clean run proves and what it does not: a finding files a capture;
a clean run proves the checks ran, never that the rules are good. The
checks verify record-keeping consistency and corpus hygiene, not rule
quality — that stays with the judgment gate.
"""

import argparse
import difflib
import hashlib
import os
import re
import subprocess
import sys

GATE_RE = re.compile(r"^Rule gate:\s*(.+?)\s*$", re.M)
TOUCHED_RE = re.compile(r"^\*\*Files touched:\*\*\s*(.+?)\s*$", re.M)
BULLET_RE = re.compile(r"^ {0,3}[-*]\s+\S")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
RETIRED_HEADING_RE = re.compile(r"retired", re.I)
MIN_SEG_LEN = 40  # shorter segments are not rules worth comparing


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def normalize(text):
    return re.sub(r"\s+", " ", text).strip().lower()


# ---------------------------------------------------------------------------
# Rule corpus segmentation
# ---------------------------------------------------------------------------

def _bullet_spans(block_lines):
    """Top-level bullet spans (start, end) within a block's lines."""
    spans, i, n = [], 0, len(block_lines)
    while i < n:
        if BULLET_RE.match(block_lines[i]):
            j = i + 1
            while j < n and (
                not block_lines[j].strip()
                or block_lines[j].startswith((" ", "\t"))
            ):
                j += 1
            spans.append((i, j))
            i = j
        else:
            i += 1
    return spans


def segment_rules(text):
    """Split a rules file into rule segments.

    A top-level bullet (with its indented continuation) is one segment —
    rules normally live one-per-bullet, and near-duplicates are exactly two
    bullets that say nearly the same thing. A heading block with no bullets
    is one prose segment. Segments under a heading whose title contains
    "retired" are tombstones, not live rules.

    Returns (live, retired_names): live is a list of segment texts,
    retired_names the bullet items under retired headings.
    """
    live, retired = [], []
    lines = text.splitlines()
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        m = HEADING_RE.match(line)
        if m:
            is_retired = bool(RETIRED_HEADING_RE.search(m.group(2)))
            j = i + 1
            while j < n and not HEADING_RE.match(lines[j]):
                j += 1
            body = lines[i + 1:j]
            if is_retired:
                for s, e in _bullet_spans(body):
                    retired.append(body[s].split(None, 1)[1].strip())
            elif _bullet_spans(body):
                for s, e in _bullet_spans(body):
                    live.append("\n".join(body[s:e]))
            else:
                live.append("\n".join(lines[i:j]))
            i = j
            continue
        if BULLET_RE.match(line):
            j = i + 1
            while (
                j < n
                and not HEADING_RE.match(lines[j])
                and (not lines[j].strip() or lines[j].startswith((" ", "\t")))
            ):
                j += 1
            live.append("\n".join(lines[i:j]))
            i = j
            continue
        if line.strip():
            j = i + 1
            while (
                j < n
                and lines[j].strip()
                and not HEADING_RE.match(lines[j])
                and not BULLET_RE.match(lines[j])
            ):
                j += 1
            live.append("\n".join(lines[i:j]))
            i = j
            continue
        i += 1
    return live, retired


def check_near_dup(rules, threshold):
    """Near-duplicate rule segments, compared across the whole corpus —
    within a file as well as across files."""
    findings = []
    seen = []  # (rel_path, normalized_segment)
    for rel, text in rules:
        for seg in segment_rules(text)[0]:
            norm = normalize(seg)
            if len(norm) >= MIN_SEG_LEN:
                seen.append((rel, norm))
    for a in range(len(seen)):
        for b in range(a + 1, len(seen)):
            fa, ta = seen[a]
            fb, tb = seen[b]
            ratio = difflib.SequenceMatcher(None, ta, tb).ratio()
            if ratio >= threshold:
                findings.append(
                    f"[near-dup] {fa} vs {fb}: segments ~{ratio:.2f} similar "
                    f"({ta[:60]!r} / {tb[:60]!r})"
                )
    return findings


# ---------------------------------------------------------------------------
# Session records
# ---------------------------------------------------------------------------

def parse_entry(path):
    text = read(path)
    first = text.splitlines()[0] if text else ""
    tm = re.match(r"^#\s+(.+?)\s*$", first)
    hm = re.match(r"^#\s+([0-9a-f]{7,40})\b", text)
    touched_m = TOUCHED_RE.search(text)
    return {
        "file": path,
        "title": tm.group(1) if tm else "",
        "hash": hm.group(1) if hm else None,
        "text": text,
        "touched": touched_m.group(1) if touched_m else "",
    }


def gate_disposition(text):
    m = GATE_RE.search(text)
    if not m:
        return None
    val = m.group(1).lower()
    if "not needed" in val:
        return "not-needed"
    if "run" in val:
        return "run"
    return "other"


def check_gate_lines(records, rule_basenames):
    """Check 1: every rule-authoring session's record carries a gate line."""
    findings, authoring = [], []
    for e in records:
        if any(b in e["touched"] or b in e["title"] for b in rule_basenames):
            authoring.append(e)
            if GATE_RE.search(e["text"]) is None:
                findings.append(
                    f"[gate-line] {os.path.basename(e['file'])}: rule-authoring "
                    f"session (touched a rules file) with no `Rule gate:` line"
                )
    return findings, authoring


def git_added_lines(project, commit, rel_paths):
    """Lines added to rel_paths by commit, or None if unresolvable."""
    try:
        out = subprocess.run(
            ["git", "-C", project, "show", "--numstat", commit, "--"] + rel_paths,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (subprocess.CalledProcessError, OSError):
        return None
    added = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[0] not in ("-", ""):
            try:
                added += int(parts[0])
            except ValueError:
                pass
    return added


def check_not_needed_growth(records, project, rules):
    """Check 2: 'not needed' dispositions must not coincide with rule text
    growing in the entry's own commit (the `# <hash> —` title line)."""
    findings, notes = [], []
    for e in records:
        if gate_disposition(e["text"]) != "not-needed":
            continue
        if not e["hash"]:
            notes.append(
                f"(skipped not-needed-growth for {os.path.basename(e['file'])}: "
                f"entry title has no commit hash)"
            )
            continue
        added = git_added_lines(project, e["hash"], [r for r, _ in rules])
        if added is None:
            notes.append(
                f"(skipped not-needed-growth for {os.path.basename(e['file'])}: "
                f"commit {e['hash']} not resolvable)"
            )
            continue
        if added > 0:
            findings.append(
                f"[not-needed-growth] {os.path.basename(e['file'])}: disposition "
                f"is 'not needed' but commit {e['hash']} added {added} line(s) "
                f"to the rules file(s)"
            )
    return findings, notes


def check_retired(rules, extra_retired):
    """Check 4: no live rule names a retired mechanism. Names come from the
    --retired flags and from bullets under any 'Retired' heading."""
    names = [x.strip() for x in extra_retired if x.strip()]
    live_all = []
    for rel, text in rules:
        live, retired = segment_rules(text)
        names.extend(retired)
        live_all.extend((rel, normalize(seg)) for seg in live)
    findings = []
    for name in dict.fromkeys(n.lower() for n in names if len(n.strip()) >= 4):
        for rel, seg in live_all:
            if name in seg:
                findings.append(
                    f"[retired-name] {rel}: live rule names retired mechanism "
                    f"{name!r}"
                )
    return findings


# ---------------------------------------------------------------------------
# Capture filing
# ---------------------------------------------------------------------------

def file_captures(queue_path, findings):
    """Append findings to the queue's Unprocessed section as work items.
    Slugs are stable over the finding text, so a re-run never duplicates."""
    if not os.path.isfile(queue_path):
        return [f"(capture skipped: {queue_path} does not exist)"]
    text = read(queue_path)
    notes = []
    for f in findings:
        check = f.split("]", 1)[0].lstrip("[")
        slug = f"rule-check-{check}-{hashlib.sha1(f.encode()).hexdigest()[:8]}"
        if slug in text:
            notes.append(f"(capture skipped, already filed: {slug})")
            continue
        detail = f.split("] ", 1)[1]
        block = (
            f"#### Rule check: {check} [{slug}]\n"
            f"{detail}. File by rule_corpus_check.py (mechanical half of the "
            f"rule gate); fix the record or the rule, then re-run the check.\n"
        )
        m = re.search(r"(^## Unprocessed[^\n]*\n)(.*?)(?=^## |\Z)", text, re.M | re.S)
        if not m:
            notes.append(
                f"(capture skipped: no '## Unprocessed' section in {queue_path})"
            )
            break
        insert_at = m.end()
        prefix = text[:insert_at].rstrip("\n")
        text = prefix + "\n\n" + block + "\n" + text[insert_at:]
        notes.append(f"capture filed: {slug}")
    if any(n.startswith("capture filed") for n in notes):
        with open(queue_path, "w", encoding="utf-8") as fh:
            fh.write(text)
    return notes


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="mechanical checks over a project's rule corpus and "
        "rule-gate records (see the module docstring for the checks)",
    )
    ap.add_argument("project_dir")
    ap.add_argument("--rules", action="append", default=None,
                    help="rules file (repeatable); default AGENTS.md / "
                    "CLAUDE.md in the project dir")
    ap.add_argument("--log-dir", default=None,
                    help="session records dir; default <project>/LOG")
    ap.add_argument("--dup-threshold", type=float, default=0.85)
    ap.add_argument("--retired", action="append", default=[],
                    help="retired mechanism name (repeatable)")
    ap.add_argument("--capture-queue", default=None,
                    help="queue file whose Unprocessed section receives "
                    "findings as work items")
    args = ap.parse_args(argv)

    project = os.path.abspath(args.project_dir)
    if not os.path.isdir(project):
        print(f"error: not a directory: {project}", file=sys.stderr)
        return 2

    rules_args = args.rules or []
    if not rules_args:
        for cand in ("AGENTS.md", "CLAUDE.md"):
            p = os.path.join(project, cand)
            if os.path.isfile(p):
                rules_args.append(p)
    rules = []
    for r in rules_args:
        p = os.path.abspath(r)
        if not os.path.isfile(p):
            print(f"error: rules file not found: {p}", file=sys.stderr)
            return 2
        rules.append((os.path.relpath(p, project), read(p)))
    if not rules:
        print(
            "error: no rules file — pass --rules (looked for AGENTS.md / "
            f"CLAUDE.md in {project})",
            file=sys.stderr,
        )
        return 2
    rule_basenames = {os.path.basename(rel) for rel, _ in rules}

    log_dir = args.log_dir or os.path.join(project, "LOG")
    records = []
    if os.path.isdir(log_dir):
        for name in sorted(os.listdir(log_dir)):
            if name.endswith(".md") and name != "index.md":
                records.append(parse_entry(os.path.join(log_dir, name)))

    gate_f, authoring = check_gate_lines(records, rule_basenames)
    grow_f, grow_n = check_not_needed_growth(records, project, rules)
    findings = gate_f + grow_f
    findings += check_near_dup(rules, args.dup_threshold)
    findings += check_retired(rules, args.retired)
    notes = list(grow_n)

    if args.capture_queue and findings:
        notes += file_captures(os.path.abspath(args.capture_queue), findings)

    n_segs = sum(len(segment_rules(t)[0]) for _, t in rules)
    print(f"rule-corpus-check: {project}")
    print(f"  rules: {len(rules)} file(s), {n_segs} segment(s)")
    print(
        f"  records: {len(records)} LOG {'entry' if len(records) == 1 else 'entries'}, "
        f"{len(authoring)} rule-authoring"
    )
    print(f"  findings: {len(findings)}")
    for f in findings:
        print(f"  - {f}")
    for nt in notes:
        print(f"  {nt}")
    if not findings:
        print("  (a clean run proves the checks ran, never that the rules are good)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
