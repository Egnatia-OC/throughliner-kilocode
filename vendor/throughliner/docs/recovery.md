---
name: recovery
docset: current
note: >
  Reference for recovering a project after a large rollback. Consulted on
  demand — not a sequence to run. Loaded when the user asks to undo a lot of
  work at once, or when a session opens into the aftermath of one.
---

# After a big rollback

Sometimes the right move is to put a project back to how it was days or weeks
ago — a change went wrong, a document grew unmanageable, a direction turned out
to be a mistake. Rolling back is the easy half. This is about the half that
surprises people: **what a rollback does to a project afterwards.**

Read this when a large rollback is being planned, or when a session opens into
the aftermath of one. It is reference, not a checklist to work through.

## The thing that costs the most and announces itself least

**The queue will keep asking for work that is already done.**

A rollback restores the files. It cannot restore the *correspondence* between
the queue and reality. Work that shipped before the rollback point stays shipped
in the code — but the queue items describing it come back, because they were
removed when that work was built.

So the sessions after a rollback are handed work that is already finished, and
they are handed it as ordinary ready work, with nothing marking it. Every
instance is caught by accident, if at all — in one real case, seven times in a
single session, each time only because someone happened to look at the file
before building it.

**What to do:** before building anything in the first sessions after a rollback,
check the LOG for the item's slug. If the work shipped, remove the item and say
so instead of rebuilding it. Treat this as the default suspicion for the whole recovery
period, not a one-off check.

## Restore first, diagnose second

Bring back immediately everything that could not possibly have caused the
problem. Test files, research notes, records, tooling — anything unrelated to the
thing being rolled back.

The instinct is to restore carefully, item by item, once things have settled.
What that produces is a pile of obviously-safe files sitting needlessly missing
for a day or more while attention is elsewhere. Recovering a single file from
history is one command; leaving it out costs a session that needed it.

## Check what depended on you

If anything outside this project was built against it — another project, a
companion tool, a published format — **the rollback may have broken it, and it
will not tell you.**

This is the one genuinely time-critical item here. Everything else can be sorted
out at leisure; a downstream dependency finds out by breaking, usually in someone
else's session.

## A rollback undoes deletions too

Rolling back is not only "recent work disappears". Every *removal* since the
rollback point also inverts: a setting that was retired comes back, a file that
was deliberately deleted returns, an entry taken out of a config reappears.

Nothing watches for this, because attention naturally goes to what is missing
rather than to what has reappeared. When checking the state afterwards, read the
changes in both directions.

## Know whether the target was *good* or merely *available*

There is a difference between "this is the state we want" and "this was the best
state available". If the rollback target is only the second, the rollback is step
one of two, and the second step needs saying out loud at the time — otherwise the
project reads as fixed when it is merely smaller.

In the case this guidance came from, a document was rolled back to its lowest
recorded size, which was still several times the size that actually works. The
rollback bought room. It did not buy health.

## The LOG index is the recovery instrument

The one-line-per-session index is what makes a large recovery tractable. It lets
you decide which entries to open without reading the changes themselves — the
difference between reading a couple of dozen one-line summaries and reading
sixty-five sets of changes.

Two cautions that both came from real errors:

- **Shipped work and unshipped work need opposite routes.** A work item's text is
  consumed when it is built, so **shipped work survives only in its LOG entry**.
  Unbuilt work is the reverse: it lives in the queue and has no LOG entry at all.
  Looking for one in the wrong place finds nothing and reads as "it wasn't there".
- **Check dates against the history rather than trusting the index's own.** An index entry is written by hand and can
  be wrong. One dated a change two days earlier than the history actually shows,
  and a second project repeated the error in good faith because it read the index
  rather than the history. Where a date matters, check the history.

## One mechanical trap worth knowing

Restoring an old state by clearing the file list and checking the old one back
out **leaves orphaned files on disk**. Files that existed only in the newer state
stay behind as untracked files after the list is rewritten.

They have to be deleted explicitly — and the ones renamed between the two states
don't show up in the deletion list at all. They appear as renames, so a sweep
that only reads deletions misses them and the restored state silently doesn't
match.

## Verify with checks that can fail

A rollback that "looks right" is not verified. Use checks with a definite answer:

```
compare the restored state against the target   ->  must show no difference
measure whatever prompted the rollback          ->  must show the expected number
    (a file's size, a count, a setting's value)
confirm the running tool matches the files      ->  compare content stamps
run the thing that was broken                   ->  confirm it now behaves
```

The last one matters most and is skipped most: a restored file is not a restored
*behaviour*. If a tool loads these files, it has to be reloaded and then actually
observed doing the right thing — otherwise the verification only proves the files
changed on disk.
