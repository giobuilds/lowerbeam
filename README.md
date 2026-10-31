# Lowerbeam

[![CI](https://github.com/giobuilds/lowerbeam/actions/workflows/ci.yml/badge.svg)](https://github.com/giobuilds/lowerbeam/actions/workflows/ci.yml)

![Lowerbeam Banner](brand/banner.png)

**The local AI workbench for small GPUs.**

Lowerbeam helps you get the most out of local models on an 8 GB card. It sets up the official [llama.cpp](https://github.com/ggml-org/llama.cpp) for you, or uses the one you already have, and gives you one desktop app to pick a model that fits, launch it well, and actually use it.

- **Fits your card.** VRAM and speed estimates before you download, tuned launch settings, and clear reasons when something won't fit.
- **Ready in five minutes.** It finds llama.cpp, or downloads and verifies the official build. No terminal needed.
- **Chat, tools and coding.** Chat with compaction for long conversations, web tools, MCP servers, and a sandboxed coding mode that only ever edits a copy of your project.
- **Yours.** Everything runs locally, with no telemetry.

Lowerbeam uses the official llama.cpp builds and never forks or bundles them. It runs on Linux (x86_64) today. The window follows the system's light or dark setting, or the one chosen under Appearance on the settings page (File → Settings).

[Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Discussions](https://github.com/giobuilds/lowerbeam/discussions)

---

## Install

Download `Lowerbeam.AppImage` from [Releases](https://github.com/giobuilds/lowerbeam/releases), mark it executable, and run it:

```bash
chmod +x Lowerbeam.AppImage
./Lowerbeam.AppImage
```

Or install the RPM on Fedora and its relatives. On first run, if no llama.cpp is found, Lowerbeam offers to download the official Vulkan build (about 30 MB) or the CPU build into its own data folder. That build needs glibc 2.34 or newer. You can point it at a build of your own instead. Checking for a newer official build is off until you turn it on. It then runs once a day and waits for you to click Install. ROCm, CUDA, SYCL and OpenVINO builds are not downloaded; use one you installed yourself.

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
quantisation, layers, trained context and chat template. The Models tab lists
what is already on disk, with its size, when it was last launched and any
duplicate copies, and can delete a model you no longer need, including its vision projector. Before launching it
estimates VRAM, broken into weights, KV cache, compute and backend reserve. You
can drive that yourself or hand sizing to llama.cpp's own `--fit`. Settings that
worked for a model are remembered and reapplied next time.

**Chat** — streaming replies as markdown with syntax-highlighted code, persisted
conversations you can search and export as Markdown or JSON,
stop/regenerate/edit, per-conversation system prompt (with saved presets) and samplers,
replies constrained to a JSON schema or a GBNF grammar,
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
about the code. It gets list, search and read: every path it asks for is
resolved and checked against that folder, so
a link out of it, a `..`, or an instruction planted in a file to read
something elsewhere all fail the same way. Keys and `.env` files are left
out at any depth, and the home folder or `/` cannot be the project. Notes a
project keeps for coding agents — `AGENTS.md`, `CLAUDE.md`, `.cursorrules`
and the like — are read the same way and given with the task as facts about
the project, never as instructions that could widen what the run may do.
A run that calls the same tool and gets the same result is told so once,
and stopped the third time. The same error three times in a row, or the
same stretch of text, stops the run as well.

`edit_file` still requires one match. A trailing space, or a curly quote
where the file has a straight one, can match, and the result says which.
A change in relative indentation does not.

Coding mode can put a short ranked list of the files and names most
connected to the task in front of the run, and offer `repo_map` to ask
for it again, within a token budget. Both are off unless that run is
asked. The map is built on this machine with tree-sitter, and it only
includes files the run is allowed to read.

With a CPU embedding model marked on the router, a run also gets `find`:
the same path and line excerpts as search, ranked by that model, and only
from the project. The embedding model stays on the CPU and is not offered
for chat. Every request, every file read,
every refusal and the answer are written to a journal before the tab shows
them, so reloading mid-run rebuilds exactly what was there. Switch the run to
*edit in a copy* and it gets two more tools — `edit_file`, which must match a
passage exactly once, and `write_file`, which overwrites only with the hash
it was shown — against a copy of the project, never the project. The
Changes panel shows what it did as diffs; apply writes each file back only if
the project still holds what the copy started from, and anything you edited
meanwhile is left alone and named. Undo restores what was applied.

A model whose chat template has no tool calling can still run: set
`toolFormat` to `text` on its capability record. The tools are described
in the prompt, and the reply is constrained to one fenced tool call or a
final answer. Absent, or `native`, is the chat template's own tool
calling, which is what a measured model uses. Nothing switches a model
over by itself.

A coding run can compact into a snapshot instead of a prose note: the goal,
the constraints and the next step, checked against the journal, and refused
when it would not be any smaller. Chat keeps its prose summary. The snapshot
is off unless Coding mode is asked to use it.

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

The same run can be started without the window. Quit the app first.
`lowerbeam run --project DIR --task TEXT` uses the model you last launched
there (or a server that launch left running), prints the run as it happens,
and stops the model when it exits. The default mode is inspect. `--mode edit`
and `--mode run` work on a copy and leave it unapplied; open the Coding tab
to apply it. From a source checkout, after `npm run build`, the same command
is `npx electron . run --task TEXT`.

`lowerbeam serve` starts that same saved launch and leaves it running as the
local API, until Ctrl+C. `--model NAME` picks a launch by its saved name.
The port and key are the ones under Local API. A model whose saved settings
will not fit on this card is refused before it is loaded.

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

**Linux on x86_64 only.** Releases are an AppImage and an RPM for x86_64.
Windows and macOS are not supported: run mode's sandbox is bubblewrap,
and there is no validated equivalent for them yet. ARM builds are not made.

| | Needed | Tested |
|---|---|---|
| Distribution | Any x86_64 Linux the AppImage runs on; the RPM is for Fedora and its relatives | Fedora 44 Workstation (kernel 7.2, glibc 2.43), September–October 2026. CI builds and runs the suites on Ubuntu (GitHub's `ubuntu-latest`) |
| glibc | 2.25 or later: the newest symbol version the Electron 44 binary asks for | 2.43 |
| llama.cpp | The unified `llama` CLI or the standalone `llama-server`, from a build recent enough for `--jinja` and `/props` (the router needs `--models-preset`), or let Lowerbeam download the official build (needs glibc 2.34+) | `llama` 0.4.0-dev, build 10826 (commit 73a43d1f6) |
| GPU backend | Whatever your llama.cpp build was compiled for — Vulkan, ROCm, CUDA, or none. Lowerbeam does not ship llama.cpp; it drives the one you have | Vulkan (RADV) on an AMD Radeon RX 6600, 8 GB. ROCm, CUDA and CPU-only builds are expected to work and have not been tested here |
| Memory | Enough for the model you launch: the Server tab says what fits before launching | 8 GB VRAM and 32 GB RAM: a 9B at Q4_K_M with 16k context fully on the GPU, or a 30B-A3B with its experts in RAM |
| Node | 22.12 or later, to build from source or to run project tests in run mode | 24 |

**For *edit and run* only**: bubblewrap (`bwrap`) and unprivileged user
namespaces. Without them the other coding modes still work, and the app says
which part is missing.

- Fedora, Arch and Debian allow unprivileged user namespaces by default;
  install bubblewrap (`sudo dnf install bubblewrap`, `sudo pacman -S bubblewrap`,
  `sudo apt install bubblewrap`).
- **Ubuntu 23.10 and later** keep them on but have AppArmor refuse them to
  programs without a profile, so bubblewrap fails to start. The app detects
  this and says so. To allow it for the whole system (what CI does):

  ```bash
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  # to keep it after a reboot:
  echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-userns.conf
  ```

  That loosens a protection for every program, so weigh it. Narrower is an
  AppArmor profile that grants `userns` to `/usr/bin/bwrap` alone.
- Commands get Node from the one on your `PATH`, lent to the box read-only;
  without one they run with the system's tools only.

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
runs the same checks as CI, builds `Lowerbeam.AppImage`, the RPM and
`latest-linux.yml`, and signs `SHA256SUMS` over the three of them before it
creates the GitHub release. The notes are the changelog section, then the
pull requests merged since the previous release. Running AppImages find it
within six hours and install it on their next restart. A published tag is
never moved or deleted; a broken release is followed by a new one. The
AppImage's name carries no version on purpose: an update replaces the file
in place, so a shortcut to it keeps working.

The signing key is not in the repository. Its public half is
[release-signing-key.asc](release-signing-key.asc). The private half and its
passphrase are the Actions secrets `GPG_PRIVATE_KEY` and `GPG_PASSPHRASE`;
without them the workflow stops before creating the release.

## Checking a download

`SHA256SUMS.asc` is a detached signature by this key:

```
CB72 2EF2 60C3 0897 756B  9229 CAC0 53DD 7A01 8445
```

The app's updater does not check that signature. It checks the AppImage
against the sha512 inside `latest-linux.yml`, and that file comes from the
same GitHub release. To check a download yourself, from a directory holding
the files you downloaded and a copy of the public key:

```bash
gpg --import release-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
```

`--ignore-missing` checks only the files in that directory. A line in
`SHA256SUMS` for a file you did not download is skipped, so checking the
AppImage on its own does not fail for want of the RPM or `latest-linux.yml`.

`gpg --verify` prints the fingerprint above when the signature is good. It
also warns that the key is not certified, which means you have not signed it
yourself; compare the fingerprint with this page.

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
suites run) and a build on Node 22.12 and 24, on every push to `main`, every
pull request and weekly. It also audits the dependencies, Electron included
although it is a devDependency (`npm run audit:deps`; see `scripts/audit.mjs`
for what blocks); see `.github/workflows/ci.yml`.

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

Stages 1 and 2 are built: the Coding tab, its journal, and edits in a copy
that you review and apply. Stage 3 is built in first form: *edit and run*
runs commands in a bubblewrap box with no network, offered only where the
box can be built. It has not yet been checked on a clean RPM install.
On Ornith-1.5-9B the reference loop passes 29 of 30 read-only tasks and
completes 22 of 30 write tasks with its round cap lifted to 40; the app keeps
a cap of 12 until the next matrix says whether the cap or folding older tool
results is what holds it back.

## Privacy

No telemetry, analytics or account. [PRIVACY.md](PRIVACY.md) lists every
connection the app makes (update checks, Hugging Face when you use the Models
tab, web search and pages only when a chat's web tools are on, MCP servers you
add), how to turn each off, and everything it stores and how to delete it.

## Security

To report a vulnerability, use GitHub's private reporting — the
repository's **Security** tab, **Report a vulnerability** — rather than a
public issue. [SECURITY.md](SECURITY.md) says which versions get fixes, what
is in scope and how long a reply takes.

## Licence

MIT — see [LICENSE](LICENSE).
