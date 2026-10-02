# Lowerbeam

[![CI](https://github.com/giobuilds/lowerbeam/actions/workflows/ci.yml/badge.svg)](https://github.com/giobuilds/lowerbeam/actions/workflows/ci.yml)

![Lowerbeam Banner](brand/banner.png)

A desktop control panel for [llama.cpp](https://github.com/ggml-org/llama.cpp).

llama.cpp ships a web UI, but it only appears *after* you have started a server
with the right flags — and the flags are the hard part. On an 8 GB card, `-ngl`,
`-c` and the KV cache type decide whether a model runs fast, runs slowly, or
fails to load. The built-in UI cannot change any of them.

Lowerbeam owns the server process instead: pick a model, see what will fit,
launch it, and chat — without touching a terminal.

*Low beam is the dipped headlight: the one you use close to home, lighting the
road ahead without dazzling anyone.*

## What it does

**Server** — launches llama.cpp on a free port and tracks it through an explicit
lifecycle, with a live log, GPU and VRAM readout, and crash messages that name a
likely cause. It adopts a server left running by a previous session rather than
starting a rival, and never leaks a child process. A binary check loads a model
and generates tokens, which catches a build that starts fine but cannot actually
run inference.

**Local API** — the server is an OpenAI-compatible API for other programs:
an editor, an agent, a script. Give it a fixed port so their settings keep
working across launches, and an API key; the app's own chat and coding send
it too. The local network is off unless you turn it on, and it needs a key.

**Models** — scans your disk and reads each GGUF header for architecture,
quantisation, layers, trained context and chat template. Before launching it
estimates VRAM, broken into weights, KV cache, compute and backend reserve. You
can drive that yourself or hand sizing to llama.cpp's own `--fit`. Settings that
worked for a model are remembered and reapplied next time.

**Chat** — streaming replies as markdown with syntax-highlighted code, persisted
conversations you can search and export as Markdown or JSON,
stop/regenerate/edit, per-conversation system prompt (with saved presets) and samplers,
and images for models that can read them. llama.cpp decodes one sequence per
slot, so several conversations can generate at once; switching away doesn't
interrupt a reply.

**Downloads** — search Hugging Face, see which quantisations fit your GPU *and
roughly how fast they will run* before downloading, then pull one with live
progress. Vision models bring their projector automatically.

**Web access** — the model can search and read pages when you switch the tools
on. Everything is built around context rather than bandwidth: one page of raw
HTML is about 14,000 tokens on this hardware, the same page as text about 1,300,
and its search extract about 380 — so the model is shown text, and only when an
extract was not enough. Older results are replaced by a one-line summary once
they have been used, which keeps a five-search conversation at about a fifth of
what it would otherwise cost. Each enabled tool adds roughly 50 tokens to every
message, so they are switched on individually and the running cost is shown.
The default search engine rate-limits after a few queries in a row; point
*File → Tools and MCP Servers* at a SearXNG instance you run to avoid that.

**Context** — a chat gets the server's context divided by the number of
concurrent chats, and when it runs out llama.cpp stops mid-sentence with no
explanation. Lowerbeam counts what the window holds from the server's own
figures — the cached prefix included, which is the part that is easy to miss
— shows it next to the chat, says so plainly when a reply was cut off,
and — unless you turn it off — summarises the oldest turns to make room before
it happens. Nothing is deleted: the transcript keeps everything, and only what
is sent to the model changes.

**Reading pane** — links from a search result open beside the chat rather than
in your browser or, as they used to, in the app window itself. The page runs in
its own web contents with no bridge to Lowerbeam, so a script on it cannot reach
the app: no IPC, no filesystem, no process spawning. Close it, or send it to
your real browser, from its header.

**Coding** — point the loaded model at a project folder and ask it questions
about the code. It gets three tools — list, search and read — and nothing
else: every path it asks for is resolved and checked against that folder, so
a link out of it, a `..`, or an instruction planted in a file to read
something elsewhere all fail the same way. Keys and `.env` files are left
out at any depth, and the home folder or `/` cannot be the project. Notes a
project keeps for coding agents — `AGENTS.md`, `CLAUDE.md`, `.cursorrules`
and the like — are read the same way and given with the task as facts about
the project, never as instructions that could widen what the run may do. Every request, every file read,
every refusal and the answer are written to a journal before the tab shows
them, so reloading mid-run rebuilds exactly what was there. Switch the run to
*edit in a copy* and it gets two more tools — `edit_file`, which must match a
passage exactly once, and `write_file`, which overwrites only with the hash
it was shown — against a copy of the project, never the project. The
Changes panel shows what it did as diffs; apply writes each file back only if
the project still holds what the copy started from, and anything you edited
meanwhile is left alone and named. Undo restores what was applied.

A third mode, *edit and run*, adds `run_command`, so the model can run the
tests on its change. Commands run in a bubblewrap box over the copy: the
system and toolchain read-only, the copy writable, a private `/tmp`, no
network, a time limit, and nothing left running when the command ends. The
mode is offered only where the box can be built; without bubblewrap or
unprivileged user namespaces the button says why, and the main process
refuses the run anyway. Before a run you can grant it more — folders outside
the project to read, the network, installs — and the run's header records
what was granted. An Evidence panel compares the last test run after the
last edit with the same command before any edit, and names any test file
the run changed. The box is a second layer, not a VM: the kernel is shared.

**MCP servers** — any program that speaks the Model Context Protocol over stdin
and stdout can supply more tools. Give Lowerbeam its command and it starts it,
lists what it offers, and adds those tools to the same list chat picks from —
the model cannot tell them apart from the built-in ones. Servers are stopped
when the app quits and restarted when it opens. A server gets only the basics
from Lowerbeam's environment — `PATH`, `HOME`, the locale, `TMPDIR`, `XDG_*` —
plus what you give it under *Environment*, so a token in your shell is not
handed to every server.

**Updates** — the AppImage checks GitHub releases at start and every six
hours, downloads a new version in the background, and installs it when you
restart; a banner says when one is waiting. An RPM is only told that a release
exists, since installing it belongs to your package manager. Checks can be
turned off in *About*.

**Tuning** — benchmarks launch settings with `llama bench` and applies the
fastest. Sampler settings aren't here on purpose: they don't change throughput.

## Requirements

- Node 20+ (developed on 24)
- llama.cpp — either the unified `llama` CLI or the standalone `llama-server`
- For *edit and run* only: bubblewrap (`bwrap`) and unprivileged user
  namespaces. Without them the other coding modes still work.

Lowerbeam finds both and prefers the unified CLI, since a stale distro build
often sits in `/usr/bin` beside a current one. Override with the binary dropdown
or `LLAMA_SERVER_PATH`. It looks in `~/.local/bin`, `~/bin`, `/usr/local/bin`,
`/usr/bin`, `/opt/llama.cpp/bin` and `~/llama.cpp/build/bin`.

The two shapes are not interchangeable: the unified CLI needs a `serve`
subcommand and takes `--flash-attn on|off|auto`, where the standalone binary
treats `--flash-attn` as a bare switch. Lowerbeam adapts per binary.

## Getting started

```bash
npm install
npm run dev        # renderer hot-reload
npm test           # unit suites
npm run dist       # AppImage + RPM in dist/
```

On Fedora the RPM target also needs `libxcrypt-compat`, because electron-builder
shells out to `fpm`, whose bundled ruby links against `libcrypt.so.1`. Without it
the AppImage still builds.

```bash
sudo dnf install libxcrypt-compat
```

## Releasing

Versions follow [semantic versioning](https://semver.org/), and the version
changes when there is a release, not in every pull request. Each pull request
adds a line to [CHANGELOG.md](CHANGELOG.md) under **Unreleased**, in the
section for its kind of change: Breaking, Added, Changed, Fixed or Security.

To release:

```bash
npm run release:suggest          # e.g. "patch: 0.9.25 → 0.9.26 (only Fixed entries)"
npm run release:prepare          # moves Unreleased under the new version, sets package.json
                                 # (or: npm run release:prepare -- minor)
```

Merge that as a "Release x.y.z" pull request, then tag the merge commit on
`main` with an annotated tag and push it:

```bash
git switch main && git pull
git tag -a v0.9.26 -m "Lowerbeam 0.9.26"
git push origin v0.9.26
```

The *Release* workflow refuses a tag that is lightweight, not on `main`'s own
history, not the version in `package.json`, or missing from the changelog. It
runs the same checks as CI, publishes `Lowerbeam.AppImage`, the RPM and
`latest-linux.yml` as a GitHub release, and writes its notes: the changelog
section, then the pull requests merged since the previous release. Running
AppImages find it within six hours and install it on their next restart. A
published tag is never moved or deleted; a broken release is followed by a new
one. The AppImage's name carries no version on purpose: an update replaces the
file in place, so a shortcut to it keeps working.

## About the estimates

VRAM: the KV cache figure is exact arithmetic and reproduces llama.cpp's own
reported size to the byte. Weights, compute and backend reserve are calibrated
against measured launches — within about 1% on the machines checked.

Speed: generation is memory-bandwidth-bound, so throughput is roughly bytes read
per token over bandwidth. Two things stop that being a division. A
mixture-of-experts model reads only its active experts, so a 30B model can behave
like a 3B one. And a model too large for VRAM is not unusable — llama.cpp can
keep attention on the GPU with experts in system RAM, so the estimate blends both
bandwidths.

Bandwidth is **measured, not assumed**: every benchmark and binary check
contributes a sample, and the Tuning tab has a calibration sweep. Until something
has been measured, no speed is claimed at all.

## Tests

```bash
npm test            # unit — needs nothing but a checkout
npm run test:all    # adds integration suites
```

CI runs the type check, the unit tier (bubblewrap included, so the sandbox
suites run), a build and an audit of the shipped dependencies on every push
to `main` and every pull request; see `.github/workflows/ci.yml`.

No framework: suites import the app's own modules, are bundled with esbuild and
run as scripts, and print what they checked. Unit suites cover argument
construction, the log buffer, the planner against recorded measurements,
calibration, profiles, migration and the full server lifecycle against a shim.
Integration suites need a real binary, a model on disk, or network access.

## Notes

`--no-webui` is deliberately never passed, so llama.cpp's own UI stays reachable
as an escape hatch. Tokens stream from the renderer straight to the server rather
than through IPC. Model output is sanitised before rendering. There are no native
npm dependencies, so there is no rebuild step to break on an Electron bump.

## Design notes

Five documents, meant to be read in this order:

- [Lowerbeam Coding Architecture](docs/Lowerbeam_Coding_Architecture.pdf) — a
  project-scoped coding agent runtime: permission broker, sandbox, durable
  jobs, reviewable changes.
- [Structured compaction](docs/structured-compaction.md) — replacing prose
  summaries with a typed, checkable record of a conversation.
- [Direction](docs/direction.md) — how the two fit: one schema, the journal as
  the record compaction is checked against, and the order to build it in.
- [Coding: the plan](docs/coding-plan.md) — what is actually committed to from
  the architecture, stage by stage, with the trial that picks the engine and
  the gates each stage has to pass.
- [Stage 0 results](docs/stage0-results.md) — the numbers behind each
  decision: read-only, write, recover and crossover tasks on local
  models, the memory a task needs against what a launch supplies, a held-out
  set for a fine-tune, and Pi and OpenCode run on the same tasks against the
  reference loop, which stays.

Beside them, [feature gaps](docs/lowerbeam-feature-gaps.md) compares
Lowerbeam with other local-model apps and coding harnesses: ten gaps ranked
by value against effort, each tracked as an issue, what is already rare among
them, and what is deliberately not built.

Stages 1 and 2 are built: the Coding tab, its journal, and edits in a copy
that you review and apply. Stage 3 is built in first form: *edit and run*
runs commands in a bubblewrap box with no network, offered only where the
box can be built. It has not yet been checked on a clean RPM install.
On Ornith-1.5-9B the reference loop passes 29 of 30 read-only tasks and
completes 22 of 30 write tasks with its round cap lifted to 40; the app keeps
a cap of 12 until the next matrix says whether the cap or folding older tool
results is what holds it back.

## Licence

MIT — see [LICENSE](LICENSE).
