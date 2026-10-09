# Security policy

Lowerbeam runs commands a model chooses, opens an API on your machine, reads
web pages for a model and updates itself. A flaw in any of that matters, so
there is a private way to report one.

## Supported versions

Only the latest release gets security fixes. Fixes ship as a new patch or
minor release, and the AppImage updates itself to it.

| Version | Supported |
| --- | --- |
| Latest release (see [Releases](https://github.com/giobuilds/lowerbeam/releases/latest)) | Yes |
| Anything older | No: update first |

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**
([direct link](https://github.com/giobuilds/lowerbeam/security/advisories/new)).
Please do not open a public issue for it.

Include what you can of:

- the Lowerbeam version (About), the distribution, and how it was installed
  (AppImage or RPM);
- the llama.cpp build, if the server is involved;
- the steps that show the problem, and what an attacker gains from it.

Lowerbeam is maintained by one person. A report is acknowledged within
seven days, with an assessment and, for a confirmed flaw, a plan for the
fix. You are credited in the advisory and the CHANGELOG unless you ask not
to be.

## In scope

- **Escaping the sandbox**: a command in run mode reaching outside its
  bubblewrap box, such as writing to the project, reading the home folder,
  or reaching the network when the grant says no.
- **Getting round the grant**: a coding run reading or writing outside its
  project and the folders it was granted, including through links, or
  reading a file the grant masks (credentials, `.env`, `.ssh`, …).
- **Untrusted content reaching the app**: a web page, a model's output, a
  project file or an MCP server invoking the app's IPC, running code in the
  main process or the renderer, or reaching the reading pane's privileges.
- **Fetching what should not be fetched (SSRF)**: a page fetch or search
  reaching localhost, the local network or other private addresses.
- **Local API authentication**: reaching the API without its key, the key
  leaking to other accounts on the machine, or the API listening on the
  network when that was not turned on.
- **Update integrity**: getting the app to install something that is not a
  Lowerbeam release. A download can be checked against the signed checksums
  in the README. The in-app updater checks the sha512 in the release's
  `latest-linux.yml`, which is published alongside the files it names.
- **The app's data**: settings, conversations, journals or workspace copies
  readable by other accounts on the machine.

## Out of scope

- A model doing what its grant allows: reading files in the project it was
  given, or proposing a bad change that you then apply. The grant, the
  review and the undo are the controls for that, not a promise about what a
  model will choose.
- A model following instructions it finds in a page or a project file,
  where the result stays inside its grant.
- Bugs in llama.cpp, Electron or bubblewrap themselves. Report those to
  them, though a way Lowerbeam uses them unsafely is in scope.
- Anything that needs an attacker who already runs code as your user or as
  root.
- MCP servers you add: they are programs you chose to run, with the access
  you give them.
- Windows and macOS, which are not supported.
