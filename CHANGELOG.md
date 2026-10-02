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
