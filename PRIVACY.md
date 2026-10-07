# Privacy

Lowerbeam runs models on your computer. It has **no telemetry, no analytics,
no crash reporting and no account**. Nothing about you or your use of it is
sent to the project or to anyone else.

What does leave the machine is listed below, each item with what triggers it,
what is sent, and how to turn it off. What stays on disk is listed after that.

## What goes over the network

| Connection | When | What is sent | How to stop it |
| --- | --- | --- | --- |
| **GitHub releases** (`github.com`, `api.github.com`, `objects.githubusercontent.com`) | 15 seconds after start, then every 6 hours, in a packaged build. An AppImage then downloads the release; an RPM is only told about it | A request for the latest release's `latest-linux.yml`, and the AppImage when there is a newer one. GitHub sees your IP address and a generic `electron-builder` user agent | About → Updates → untick *Check GitHub for new versions*. A development build never checks |
| **Hugging Face** (`huggingface.co`) | Only when you use the Models tab: browsing a repository, estimating what fits before downloading, downloading | The repository and file names you browse; a byte-range request for the start of a GGUF file (its header) for the fit estimate; then the file itself. No token or account is sent | Don't use the Models tab; models already on disk are found without it |
| **Web search** (`html.duckduckgo.com`, or a SearXNG instance you set) | Only when web tools are enabled for a chat and the model calls the search tool | The query the model wrote. DuckDuckGo is the default; with a SearXNG URL set, queries go there instead | Keep web tools off in the chat's tool settings (they are off by default), or set your own SearXNG instance |
| **Pages the model fetches** | Only when web tools are enabled and the model calls the page tool | A request for that URL. Local and private addresses are refused | Keep web tools off |
| **The reading pane and links** | When you open a link in the reading pane or in your browser | Whatever that site receives from a browser visit. The reading pane is a separate, unprivileged browser view | Don't open links |
| **MCP servers you add** | When you enable one | Whatever that server does: they are third-party programs, run with the environment and arguments you give them, and may reach any service | Don't add or enable them; each is off until you turn it on |
| **The Local API** | While a model is running | Nothing is sent. Programs on this computer can reach the server on the port shown, with the API key if you set one. Other machines can only if you turn on *Also listen on the local network*, which requires a key | Leave the network option off (the default) |

Your models, chats, prompts and projects are never uploaded anywhere by the
app. Inference happens in the llama.cpp server on your machine.

## What is stored, and where

Everything is in one folder, `~/.config/Lowerbeam/` (Electron's *userData*;
About → Data shows the exact path). The folder is readable by your account
only: files are created 0600 and folders 0700, and anything older is
tightened when the app starts.

| Path | What it holds | How to delete it |
| --- | --- | --- |
| `settings.json` | Your settings: model folders, MCP server configurations (including any environment values you gave them), the SearXNG URL, prompt presets, download history, update and retention choices, and the **Local API key in plain text** | About → Data → *Delete all app data* |
| `profiles.json` | The launch settings that last worked for each model, keyed by file name and size | *Delete all app data*, or *Forget* on a model's profile |
| `server.json` | While a server runs: its process id, port, launch settings and API key, so a restart can reattach to it. Removed when it stops | Stops with the server |
| `router-presets.ini`, `router-cache/` | The router's per-model launch settings, and an empty folder it is pointed at | *Delete all app data* |
| `conversations/` | Every chat: your messages and attached images, the model's replies and reasoning, and its tool calls with their arguments, short summaries and sources. A tool's full result (a fetched page, search results) is kept only until the model has answered from it | The delete button beside a chat in the list, or About → Data → *Delete all conversations* |
| `coding/<run>.jsonl` | Each coding run's journal: the task, every tool call with its arguments (paths, searches, the text of each edit), short summaries of results, commands run, and the answer | About → Data → *Delete all coding runs* |
| `coding/<run>.words.jsonl` | The model's own reasoning and prose for each round of a run | *Delete all coding runs* |
| `coding/<run>.cmd-N.txt` | The full output of each command a run executed, which can include your project's source | *Delete all coding runs*, or a retention period |
| `coding/workspaces/<run>/` | A full copy of the project an edit or run-mode run worked in, with its changes and the undo record | *Discard* on the run, *Delete all coding runs*, or a retention period |
| `coding/measure/` | Journals and answers from *Measure this model* (on the app's own small sample project, not yours) | *Delete all coding runs* |
| `coding/local-capability.json`, `coding/model-hashes.json` | Results of measuring a model, and the SHA-256 of model files so they are hashed once | *Delete all app data* |
| Electron's own folders (`Local Storage`, `Cache`, `Cookies`, …) | Browser storage for the app's window and the reading pane: the pane's width, and cookies and cache from pages opened in it | *Delete all app data* clears them |

**Retention.** Nothing is deleted automatically unless you choose to. About →
Data → *Keep runs' workspace copies and command output* can be set to 7, 14,
30 or 90 days; after that a run keeps its journal and loses its workspace copy
and command outputs.

**Outside that folder.** Models you download go to the Hugging Face cache
(`~/.cache/huggingface/hub`, or `$HF_HOME/hub`) and are your files: the app
never deletes them. When you apply a coding run's changes, they are written
into your project, and the undo record stays with the run's workspace copy.
Temporary copies for measurements and sandboxed commands are made under the
system's temporary folder and removed when they finish.

## Changes to this statement

A pull request that adds a network connection or a new kind of stored data
updates this file in the same change, and the CHANGELOG says so.
