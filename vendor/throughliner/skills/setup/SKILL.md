---
name: setup
description: Set up a project folder with the Throughliner method. Scaffolds SPEC.md, QUEUE.md, and LOG/ then interviews the user to populate them.
disable-model-invocation: true
user-invocable: true
---

# /setup

The user wants to bring this folder under the Throughliner method.

Read and follow the procedure at `${CLAUDE_PLUGIN_ROOT}/docs/setup.md`.

Before writing anything, create an empty `.throughliner-setup-active` file in
this session's scratchpad directory, and delete it when the run ends — including
on the paths that end early. It tells the safety check this is a setup run;
without it, the files setup exists to write are refused.
