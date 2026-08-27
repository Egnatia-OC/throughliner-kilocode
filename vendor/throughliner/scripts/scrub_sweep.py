#!/usr/bin/env python3
"""On-demand sweep for other people's private information in project docs.

Why this exists: a project's docs get committed, and a commit is permanent even
if the text is deleted later. The rule that actually protects people is not
writing their details down in the first place — but a rule only protects what
comes after it. This finds what is already there.

It found a real one: a third party named in committed log entries of a public
repository, readable by anyone for about six weeks. Nobody had scrubbed badly —
the text read as unremarkable when it was written, because at the time neither
person was thinking about a third party at all. A grep found every instance in
seconds. That is the trade this script makes: mechanical search is exhaustive in
a way a judgment pass can't match, so use it for coverage and use the write-time
rule for prevention.

Usage:
    python scrub_sweep.py [--name "A Name"] [--name "Another"] [path]

    --name   a name (or any string) you already know to look for. Repeatable.
             Every occurrence is reported — this is the exhaustive half.
    path     the project root to sweep. Defaults to the current directory.

With no --name, the script runs only the proper-noun pass.

Two passes, and they answer different questions:

  1. KNOWN STRINGS — every occurrence of each --name, with file and line.
     Complete by construction. If you know the name, this finds all of it.
  2. UNEXPLAINED PROPER NOUNS — capitalised words in the project's own docs
     that look like personal names and aren't part of the project's own
     vocabulary. This pass CANNOT be complete and does not try to be: it
     surfaces candidates for a human to look at. Expect false positives; that
     is the correct bias for a privacy check.

The script only reads. It never edits, and it never decides what is sensitive.
And note plainly, wherever the result is reported: **removing text from a file
does not remove it from git history.** If something has already been committed,
that's a separate decision for the user — rewrite history, scrub forward only,
or make the repository private.
"""

import argparse
import os
import re
import subprocess
import sys

# Files worth sweeping: the project's own prose. Code and data are excluded —
# not because they can't leak, but because the proper-noun pass produces
# unusable noise there, and the known-string pass covers everything anyway.
PROSE_SUFFIXES = (".md", ".txt")

# Directories never worth walking.
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}

# A candidate personal name: two capitalised words in a row, or a single
# capitalised word following an obvious personal-context cue. Deliberately
# loose — a privacy check should over-report.
TWO_CAP_WORDS = re.compile(r"\b([A-Z][a-z]{2,}\s+[A-Z][a-z]{2,})\b")

# Cues that a nearby capitalised word is probably a person.
PERSON_CUES = re.compile(
    r"\b(?:my|his|her|their|the)\s+(?:ex|wife|husband|partner|mother|father|"
    r"sister|brother|daughter|son|neighbour|neighbor|landlord|boss|colleague|"
    r"lawyer|solicitor|doctor|therapist|client)\b",
    re.IGNORECASE,
)

# Words that look like names but are this method's own vocabulary, or ordinary
# document furniture. Extend freely — a false positive here only costs one
# extra line of human review, while a missing entry costs noise.
VOCABULARY = {
    "Claude Code", "Throughliner", "Active Build", "Red flag",
    "Working mode", "Repo visibility", "Task Manager", "Git Bash",
    "Pull Request", "Log Entry", "Session Start", "Claude Opus",
    "Claude Sonnet", "Claude Haiku", "Files touched", "Queue changes",
    "Work processed", "Approval outcomes", "Plugin Root", "Project Root",
    "Windows Powershell", "Github Actions", "Model Context",
}


def tracked_files(root):
    """Prefer git's list of tracked files; fall back to a plain walk.

    Tracked-only matters: an untracked scratch file has not been published, and
    the whole point of the sweep is what a reader of the repository can see.
    """
    try:
        out = subprocess.run(
            ["git", "-C", root, "ls-files"],
            capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
        paths = [os.path.join(root, p) for p in out.splitlines() if p.strip()]
        if paths:
            return paths
    except (OSError, subprocess.CalledProcessError):
        pass

    paths = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            paths.append(os.path.join(dirpath, name))
    return paths


def read_lines(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        return []


def sweep_known(paths, names, root):
    """Pass 1: every occurrence of every known string. Complete."""
    hits = []
    lowered = [(n, n.lower()) for n in names if n.strip()]
    for path in paths:
        for i, line in enumerate(read_lines(path), 1):
            low = line.lower()
            for original, needle in lowered:
                if needle in low:
                    hits.append((os.path.relpath(path, root), i, original, line.strip()))
    return hits


# A capitalised pair whose FIRST word is one of these is almost always a
# sentence starting with an ordinary word, not a name ("Because Opus wants…").
# Filtering them cuts the bulk of the noise without narrowing the real catch:
# a personal name is very rarely one of these words.
SENTENCE_STARTERS = {
    "after", "all", "also", "and", "any", "as", "at", "because", "before",
    "both", "but", "by", "can", "could", "did", "does", "each", "even",
    "every", "for", "from", "had", "has", "have", "how", "if", "in", "into",
    "is", "it", "its", "may", "might", "must", "no", "not", "now", "of",
    "on", "once", "one", "only", "or", "other", "our", "over", "run", "see",
    "should", "since", "so", "some", "still", "such", "than", "that", "the",
    "their", "then", "there", "these", "they", "this", "those", "to", "two",
    "under", "until", "use", "used", "very", "was", "what", "when", "where",
    "which", "while", "who", "why", "will", "with", "would", "you", "your",
}


def sweep_proper_nouns(paths, root):
    """Pass 2: capitalised candidates for a human to judge. Not complete."""
    candidates = {}
    for path in paths:
        if not path.endswith(PROSE_SUFFIXES):
            continue
        rel = os.path.relpath(path, root)
        for i, line in enumerate(read_lines(path), 1):
            stripped = line.strip()
            # Skip lines that are obviously structure, links or code.
            if stripped.startswith(("#", "```", "|", "http", "- [")):
                continue
            found = set(TWO_CAP_WORDS.findall(stripped))
            if PERSON_CUES.search(stripped):
                found.add("(personal-relationship wording on this line)")
            for name in found:
                if name in VOCABULARY:
                    continue
                if name.split()[0].lower() in SENTENCE_STARTERS:
                    continue
                candidates.setdefault(name, []).append((rel, i))
    return candidates


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--name", action="append", default=[],
                        help="A known name or string to find. Repeatable.")
    parser.add_argument("path", nargs="?", default=".",
                        help="Project root to sweep (default: current directory).")
    args = parser.parse_args()

    root = os.path.abspath(args.path)
    paths = tracked_files(root)
    print(f"Swept {len(paths)} tracked files under {root}\n")

    if args.name:
        hits = sweep_known(paths, args.name, root)
        print("=== Known strings ===")
        if not hits:
            print("None of the given names appear in any tracked file.\n")
        else:
            for rel, line_no, name, text in hits:
                print(f"{rel}:{line_no}  [{name}]  {text[:120]}")
            print(f"\n{len(hits)} occurrence(s). This pass is exhaustive — "
                  "if the name is there, it is listed above.\n")
    else:
        print("=== Known strings ===")
        print("No --name given, so this pass was skipped. It is the reliable "
              "half: if you know a name to look for, pass it.\n")

    candidates = sweep_proper_nouns(paths, root)
    print("=== Possible names, for a human to look at ===")
    if not candidates:
        print("Nothing surfaced.")
    else:
        for name in sorted(candidates):
            spots = candidates[name]
            where = ", ".join(f"{rel}:{n}" for rel, n in spots[:4])
            more = f" (+{len(spots) - 4} more)" if len(spots) > 4 else ""
            print(f"{name}  ->  {where}{more}")
        print(f"\n{len(candidates)} candidate(s). This pass is NOT exhaustive "
              "and will over-report; that is the right bias here. Read the "
              "list, ignore the obvious non-names.")

    print("\nIMPORTANT: deleting text from a file does not remove it from git "
          "history. Anything already committed to a public repository has been "
          "readable, and stays readable in the history. If that applies here, "
          "it is a decision for the project's owner — rewrite the history, "
          "scrub forward only, or make the repository private.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
