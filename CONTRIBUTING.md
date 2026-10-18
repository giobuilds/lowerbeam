# Contributing to Lowerbeam

Thanks for taking an interest in Lowerbeam, the local AI workbench for small
(8 GB) GPUs. Help of every size is welcome, from a single speed measurement to
a pull request.

## Ways to help

- **Report a bug.** Open an issue and include:
  - your Lowerbeam version (shown in About) and how you installed it
    (AppImage, RPM or from source);
  - your distribution;
  - your GPU and how much VRAM it has;
  - your llama.cpp build (the official download, or your own build and its
    backend: Vulkan, ROCm, CUDA or CPU);
  - the model and its quantisation;
  - the steps to reproduce it, what you expected and what happened instead;
  - the server log, if the problem involves the server.
- **Share a measurement.** Real speed and VRAM figures from GPUs and models we
  have not tested are especially valuable, because Lowerbeam's estimates are
  calibrated against measured launches. Open an issue with your GPU and VRAM,
  the model and quant, the context size, your launch settings, the tokens per
  second you got and your Lowerbeam version.
- **Improve the docs.** If something in the README was unclear or wrong for
  you, a fix is a great first pull request.
- **Write code.** For anything bigger than a small fix, please open an issue
  first so we can agree on the approach before you spend time on it.

## Questions

Please ask questions in
[GitHub Discussions](https://github.com/giobuilds/lowerbeam/discussions)
rather than opening an issue. Issues are for bugs, measurements and agreed
work.

## What Lowerbeam will not do

Lowerbeam drives the llama.cpp you have, or the official release it downloads
for you. It does not fork llama.cpp, patch it or bundle it into the app, and
pull requests that do are not accepted. Fine-tuning and training models are
also out of scope. Bugs in llama.cpp itself belong in
[its own tracker](https://github.com/ggml-org/llama.cpp/issues).

Only Linux on x86_64 is supported for now. See [ROADMAP.md](ROADMAP.md) for
what is planned.

## Running from source

You need Linux on x86_64 and Node.js 22.12 or newer. The repository's
`.nvmrc` pins Node 24, which is what Lowerbeam is developed on, so with nvm
you can run `nvm use`.

```bash
git clone https://github.com/giobuilds/lowerbeam.git
cd lowerbeam
npm install
npm run dev        # starts the app with renderer hot reload
```

You do not need a GPU or a model to work on most of the app, but you will
need a llama.cpp build to try the server. Lowerbeam can download the official
one for you on first run.

The *edit and run* coding mode and its tests need bubblewrap. The
Requirements section of the [README](README.md) explains how to install it
and what Ubuntu needs.

To build the packages, run `npm run dist`, which writes the AppImage and RPM
to `dist/`. On Fedora the RPM also needs `sudo dnf install libxcrypt-compat`.

### Where things live

| Path | What it holds |
| --- | --- |
| `src/main/` | The Electron main process: the llama.cpp server lifecycle, models, downloads, updates and the IPC handlers (`ipc.ts`) |
| `src/main/coding/` | Coding runs: the workspace copy, the journal and the bubblewrap sandbox |
| `src/agent/` | The coding run's loop, tools and grant |
| `src/context/` | Context management and compaction |
| `src/preload/` | The bridge between the window and the main process |
| `src/renderer/` | The React interface |
| `src/shared/` | Types, IPC channel names and schemas used on both sides |
| `tests/unit/`, `tests/integration/` | Test suites |
| `scripts/` | Release, checksum and audit scripts |

## Before you open a pull request

Run these from the repository root. CI runs the same checks on Node 22.12 and
Node 24 for every pull request.

```bash
npm run typecheck   # TypeScript, for the main process and the renderer
npm test            # unit suites, which need nothing but a checkout
npm run build       # type check, then a production build
```

`npm test -- planner` runs only the suites whose name contains `planner`.
`npm run test:all` adds the integration suites, which need a real llama.cpp
binary, a model on disk or network access. Run those if your change touches
the server, downloads or the web tools. There is no separate lint step; the
type check is the gate.

The tests use no framework. Each suite in `tests/unit/` is a `.test.ts` file
that imports the app's own modules and uses `node:assert`, so the existing
suites are the best guide to writing a new one.

## Pull request guidelines

- **Keep it small and focused.** One fix or feature per pull request is far
  easier to review than several mixed together.
- **Link the issue** it addresses, if there is one.
- **Add a test for a fix.** Ideally the test fails without your change and
  passes with it.
- **Add a CHANGELOG entry.** Add one line under `## [Unreleased]` in
  [CHANGELOG.md](CHANGELOG.md), in the section for your kind of change:
  Breaking, Added, Changed, Fixed or Security. Write it for the people using
  the app, saying what they will notice rather than how the code changed.
- **Leave the version alone.** Do not change `version` in `package.json`.
  The version only changes when a release is cut, with
  `npm run release:prepare`, which moves the Unreleased entries under the new
  version.
- **Respect the security boundaries.** The window and anything it shows are
  treated as untrusted. IPC handlers in `src/main/ipc.ts` are registered
  through a wrapper that refuses any request not from the app's own page, and
  input from the window is checked with the schemas in
  `src/shared/schema.ts`. New handlers should do the same. A coding run
  only reads inside its project and its grant, and edits only a copy of the
  project, never the project itself. Changes that weaken any of this need a very good reason and a
  conversation in an issue first. [SECURITY.md](SECURITY.md) lists what is in
  scope.
- **Do not add telemetry.** Lowerbeam has none. If your change makes a new
  network connection, update [PRIVACY.md](PRIVACY.md) in the same pull
  request.

### Commit messages

Write the subject as one short sentence in the imperative that says what the
change does, ending with a full stop. If it relates to an issue, put the
number at the end:

```
Let a slow official llama.cpp download finish. (#194)
```

### Using AI tools

AI-assisted contributions are welcome. You are responsible for every line you
submit, however it was written, so please read, run and understand the code
before you open the pull request, and be ready to explain it in review.

## Reporting a security issue

Please do not open a public issue for a vulnerability. Report it privately
through the repository's **Security** tab, under **Report a vulnerability**.
[SECURITY.md](SECURITY.md) explains what to include and what to expect.

## Licence

Lowerbeam is released under the [MIT Licence](LICENSE). By contributing, you
agree that your contribution is licensed under the same terms.
