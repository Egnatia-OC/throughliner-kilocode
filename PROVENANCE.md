# Provenance

This repository is a port of [FlintcraftTech/throughliner](https://github.com/FlintcraftTech/throughliner)
(the "Throughliner" workflow plugin, originally built for Claude Code) to the
Kilo Code (the kilo CLI and VS Code extension) coding harness.

## Vendored content

`vendor/throughliner/` is a **byte-identical** copy of the upstream plugin at
pinned commit `743aa63166ce4875305c7d97041a1b462b0fdc2c` (v1.21.1):

- `skills/` — the five method skills (setup, plan, next, rescan, done)
- `hooks/` — the four Python hooks (session_start, pre_tool_use, post_tool_use, stop)
- `docs/` — the procedure docs the skills read
- `output-styles/` — the brevity output style
- `scripts/` — helper scripts the method uses
- `templates/` — scaffold templates

The invariant: **no vendored file is ever modified**. Every port change lives
outside `vendor/` and is an explicit diff. Verify any time with:

```
cd vendor/throughliner && sha256sum -c ../MANIFEST.sha256
```

## Update policy

Upstream moves; this port is a snapshot re-derived from a pinned commit
(snapshot-and-re-derive, per the upstream Codex-port post-mortem). To
update: re-clone upstream at the new HEAD, bump the pinned SHA in
`tools/vendor.sh`, re-run it, and re-run the port's test suite.

## License

The vendored content is under the upstream LICENSE (see `LICENSE`); the
port's own additions carry the same license.
