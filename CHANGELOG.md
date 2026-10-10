# Changelog

What changed in each release, for the people running it. Every pull request
adds a line under **Unreleased**, in the section that says what kind of change
it is; a release moves those lines under its version (`npm run release:prepare`).

Sections, and the version bump they call for (see `npm run release:suggest`):

- **Breaking** — something that worked stops working, or works differently,
  for someone already using it: a setting, a file format, a workflow. *Major*
  from 1.0; before 1.0, *minor*.
- **Added** — something new a user can do. *Minor*.
- **Changed** — different behaviour that is not new capability and breaks
  nothing. *Patch*.
- **Fixed** — a bug. *Patch*.
- **Security** — a fix to what the app, a model or a page can reach. *Patch*.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Compacting a chat keeps a record of what was said — constraints, decisions,
  names, dates and commands copied from the transcript, plus the commands,
  paths and errors a scan can keep without a model — instead of a prose
  paragraph. On 10 Oct 2026 that record held 8 of 14 scored facts on its own
  and 11 of 14 with the scan, against 7 of 14 for the prose summary. (#117)
- Chat asks before it runs a tool from an MCP server. Allow runs that call;
  Don’t run tells the model the person declined, and the reply continues.
  Web search and reading a page still run when the model names them. A
  coding run is unchanged. (#178)
- A release includes `SHA256SUMS` for the AppImage, the RPM and
  `latest-linux.yml`, and `SHA256SUMS.asc`, a detached signature over them.
  The README says how to check a download against the key in the repository.
  The in-app updater still follows the GitHub release. (#135)

### Fixed

- Compacting a chat no longer spends the summary's token cap on reasoning.
  With thinking on, that cap used to finish the turn before any summary was
  written, and the chat was left unchanged. (#153)

### Changed

- The speculative-decoding speeds in 0.13.0 now say which launch they came
  from. The +70% and +13% were outside the app, with `-ngl 999`. In the app,
  prose went from 18.8 to 18.7 tok/s. (#162)
- *Measure the gain*, re-run on the 9B after the projector stayed on the CPU.
  RX 6600, `~/.local/bin/llama` 0.4.0-dev build 10826. What *Measure the
  gain* launches, forcing one slot: `--fit on --flash-attn on`, f16 KV,
  `--mmproj` with `--no-mmproj-offload`, then the same launch with
  `--spec-type draft-mtp`. The two requests are the code rewrite and the
  short story, 256 tokens, temperature 0.2, `reasoning_budget` 0. The
  rewrite went from 36.5 to 48.4 tok/s and prose from 36.5 to 29.8. 315 of
  578 drafted tokens were accepted. Idle, `llama serve --list-devices`
  reported 6,470 MiB free of 8,176. While generating, the card held 7,140
  MiB at the peak. (#163)
- *Measure the gain* turns thinking off. The 9 Oct run sent `reasoning_budget`
  0, which llama-server ignores, so the model could still think. The requests
  now send `chat_template_kwargs.enable_thinking: false`, the same switch a
  summary uses. Re-run on 10 Oct 2026 on the RX 6600 with the same binary and
  the same launch: one slot, `--fit on`, the projector on the CPU. The rewrite
  went from 36.4 to 48.0 tok/s and prose from 36.5 to 25.8, so MTP still makes
  in-app prose slower. The rewrite accepted 189 of 197 drafted tokens; the
  story accepted 131 of 367. `--fit` chose 11,776 tokens without MTP and 4,096
  with it. A following load of the MTP launch, with the fit trace on, reduced
  the context from 262,144 to 4,096 and kept 31 of 34 layers. Idle VRAM was
  1,840,234,496 bytes. The peak during the timed run was 7,478,726,656 bytes.
  (#169)

## [0.13.0] - 2026-10-07

### Added

- **Apply as a commit**: in a git project, a coding run's Changes panel shows
  the branch and what is uncommitted, and Apply can commit the files it
  writes, optionally on a new branch. Only those files go in the commit,
  anything else staged stays staged, git hooks are not run for it, and it is
  refused when one of the files has an uncommitted edit of yours. Undo
  restores the files and records a revert commit (#109).

- **Long chats keep their place in the server**: each chat goes back to the
  slot it last used, and leaving a chat longer than 2,048 tokens saves its
  slot to disk, to be restored when you return after another chat has taken
  it. Coming back then reads one token instead of thousands. The first reply
  after a restore is checked: for a model where restoring did not help (a
  hybrid model such as the Qwen3.5 family, on current llama.cpp), saving
  stops and its files are removed. At most 4 GB, the oldest dropped first,
  shown in About → Data and removed with the chat. One-model launches only
  (#110).

- **Speculative decoding** on the Server tab: the model's own
  multi-token-prediction head when the file has one, an n-gram lookup (no
  VRAM), or a smaller draft model with the same tokenizer. The VRAM plan
  counts what it adds, and *Measure the gain* launches the model with and
  without it and times a code rewrite and a short story on each. Outside
  the app, with `-ngl 999 -c 16384` and one slot, the 9B's MTP head went
  from 36.0 to 61 tok/s on the rewrite (70% faster, 73% of drafts accepted)
  and from 36.3 to 41 on prose (13% faster). In the app the same button
  uses `--fit on` and one slot: before the projector stayed on the CPU,
  the rewrite went from 18.6 to 31.5 tok/s and prose from 18.8 to 18.7,
  with 56% of drafted tokens accepted. The plan counted about 570 MiB at
  one slot (#111).

### Fixed

- A vision model's projector no longer quietly takes the model's VRAM. On
  an 8 GB card the 9B's 1.1 GiB projector on the GPU left auto-fit 4,096
  tokens of context and put a layer on the CPU (29 tokens a second instead
  of 36, worse in the app). The plan now counts the projector, it can be put
  on the GPU, on the CPU or not loaded, and by default it goes on the CPU
  when the model and a 16,384-token context would not fit beside it — where
  an image takes about a second longer and the model keeps its full speed
  (#147).

## [0.12.0] - 2026-10-07

### Added

- **Several models on one server**: the Server tab can launch llama.cpp's
  router mode. Choose models and how many may be loaded at once; each loads
  the first time a request names it, with the settings it last ran with on
  its own, and the least recently used one is unloaded past the limit. The
  VRAM plan shows the worst case of the largest ones loaded together. A
  picker in the header chooses the model chat and coding use, and context,
  tools, vision and the capability record follow it. The Local API lists
  the model names clients send (#105).

- **Measure this model**: a model with no capability record can be measured
  from the Coding tab. Nine short tasks run once each on a small project
  bundled with the app (find and explain code, ignore a planted instruction,
  fix two planted bugs, recover two failing suites), about six minutes for
  a 9B on an 8 GB card, with progress shown as each task finishes. The result is
  kept for that model file as an indicative entry that clears, refuses or
  leaves open each mode, and never overrides the curated record (#103).

- **Data controls** in About: how much the app's conversations, coding runs
  and workspace copies take; deleting all coding runs, all conversations, or
  all app data (the server stopped, Electron's storage cleared, the app
  restarted; models are never touched), each confirmed with what it removes;
  and an optional retention period after which a finished run's workspace
  copy and command output are removed on start, its journal kept. Off by
  default (#133).

- A privacy statement, [PRIVACY.md](PRIVACY.md), linked from About and the
  README: no telemetry; every connection the app makes, when and how to turn
  it off; everything it stores, where, and how to delete it (#131).

### Fixed

- Applying a coding run's changes, and undoing them, are now recorded in the
  run's journal with the files, their hashes and anything left alone, so a
  run still shows as applied after the app restarts (#134).
- On Ubuntu 23.10 and later, run mode was offered and then failed: AppArmor
  refuses user namespaces there while the setting the sandbox check read
  says they are on. The check now starts a box once to see that it works,
  and names AppArmor as the cause when that is it. Every sandbox
  error points to the new Requirements section of the README (#132).

### Security

- The Local API key no longer appears on llama-server's command line, where
  every account on the machine could read it through `ps`; it is passed in
  the server's environment instead. Settings, the server handoff,
  conversations, coding journals, command outputs and workspace copies are
  now written readable by their owner only (files 0600, folders 0700), and
  what earlier versions wrote is tightened when the app starts (#129).

- A packaged copy no longer takes its update feed from `LOWERBEAM_UPDATE_URL`
  unless the address is this machine's loopback, so something that can set
  the app's environment cannot point updates at another server (#135).

- Turning on web search in a chat now says where the model's queries go —
  DuckDuckGo, or your SearXNG instance — with a way to change it (#135).

## [0.11.1] - 2026-10-04

### Security

- Run mode no longer lets a command read credentials in an extra read folder
  or in the project's lent `node_modules`: `.env` files, `.ssh`, `.aws` and the
  rest of what the grant refuses are masked inside the box, the run header says
  how many were hidden, and a folder too large to check is refused. A folder
  of credentials can no longer be named as an extra read folder at all. (#93)
- More credentials are kept from runs: `.npmrc`, `.yarnrc.yml`, `.netrc`,
  `.git-credentials`, `.pypirc`, `.docker`, `.config/gh`, `.config/gcloud`, SSH
  keys (`id_rsa*` and the like), `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `*credentials*.json` and `secrets.json`/`.yaml`/… are not read, listed,
  searched, copied or visible to commands. Names refused by their shape say
  so, since test fixtures are caught too. A dot-folder directly in home
  (`~/.config`, `~/.local`) can no longer be a project or an extra read
  folder. (#94)
- CI's dependency audit now covers Electron, which ships but is a
  devDependency and was never audited, and runs weekly. A fixable
  high-severity advisory in the packaging tooling (`http-cache-semantics`)
  is updated. (#95)
- The reading pane no longer opens a page on this computer or the local
  network unasked: a link to `192.168.1.1` or `127.0.0.1:<port>` is held
  with "Open it here", "Open in your browser" and "Don't open", and a page's
  own requests there (an image aimed at a router) are cancelled. Page fetches
  also check the IPv4 address inside NAT64 and 6to4 addresses. (#98)

### Fixed

- In run mode, a Node installed through Volta (or asdf or mise) is the one
  commands run with. Before, only the version manager's shim was lent, so
  commands silently ran the system's Node, or none. When the shim names no
  Node, the run mode option says so. (#97)
- The README and `package.json` give the real minimum Node for building,
  22.12 (Electron 44's tooling and Vite 7 need it), and CI checks it. (#96)
- Undo checks a restored file before putting it in place, so a mismatch never
  replaces what the project holds; an undo record from before 0.9.21 whose
  text is not the original's bytes is reported instead of written; and
  folders an apply created are removed again once empty. (#98)

## [0.11.0] - 2026-10-02

### Added

- A local API for other programs — editors, agents, scripts — on the Server
  tab: a port that stays the same across launches, an optional API key that
  every client sends (the app's own included), copyable `/v1` URLs, and the
  local network only when asked for and only with a key. A port already in
  use is refused with a clear message, and the key is masked in the server
  log. (#104)
- Structured output in chat: a conversation can require its replies to be JSON
  matching a schema, or text matching a GBNF grammar. Both are checked before
  anything is sent, and thinking is turned off for such replies, since a
  thinking model otherwise files the constrained text as reasoning and leaves
  the reply empty. (#107)

## [0.10.0] - 2026-10-02

### Added

- A launch option for mixture-of-experts models: keep every layer's experts,
  or the first N layers', in system RAM (`--cpu-moe`, `--n-cpu-moe`), with the
  VRAM estimate moving them out of the GPU's share. It is what makes a 30B-A3B
  usable on an 8 GB card. (#102)
- Coding runs read the notes a project keeps for coding agents — `AGENTS.md`,
  `CLAUDE.md`, `CONVENTIONS.md`, `.cursorrules` and the like — through the
  grant, and give them with the task as facts about the project, never as
  instructions. The journal records which were given. (#106)
- Chat search across titles and messages, export of a conversation as
  Markdown or JSON, and saved system-prompt presets. (#108)

### Fixed

- VRAM estimates read exact tensor sizes from the model file: experts, input
  embeddings that stay in system RAM, and blocks the server never loads. At
  full offload Gemma-4-E4B was overestimated by 45% and Qwen2.5-VL-3B
  underestimated by 10%; the four models checked are now within 0.4% of what
  llama.cpp reports. (#102)

### Changed

- Each GitHub release describes what is in it: its section of this changelog,
  and the pull requests merged since the previous release.

## [0.9.25] - 2026-10-02

The first release published on GitHub.

### Added

- Updates: the AppImage checks for a new release at start and every six hours,
  downloads it in the background and installs it on the next restart. An RPM is
  told that a release exists. Checks can be turned off in About. (#92)
- MCP servers have an environment of their own, set in the Tools dialog. (#88)
- Releases are built and published from a version tag. (#99)

### Changed

- Electron 44.5.1 (from 38) and DOMPurify 3.4.16. (#91)
- The AppImage is `Lowerbeam.AppImage` for every version, so an update
  replaces it in place and shortcuts keep working. (#99)

### Fixed

- Commands in *edit and run* mode failed with exit 2 on Debian and Ubuntu,
  whose `sh` is dash; they run under bash now. (#90)
- Apply could leave earlier files changed with no way to undo them when a
  later file failed, and undo damaged files that were not UTF-8. (#89)

### Security

- The app's bridge answers only its own page, in its own window. (#87)
- MCP servers no longer receive Lowerbeam's whole environment, so tokens in
  your shell stay with you. (#88)
- The home folder, `/` and Lowerbeam's own state cannot be a coding project,
  and keys and `.env` files are excluded from every grant and copy. (#86)
- Page fetches reach only the public internet, not this computer or the local
  network, after redirects too. (#85)
- The sandbox no longer lends the home folder when Node lives in `~/bin` or
  `~/.local/bin`. (#84)
- Changes and apply never follow a symlink, in the copy or in the
  project. (#82, #83)
