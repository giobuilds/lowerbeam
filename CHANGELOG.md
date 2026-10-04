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
