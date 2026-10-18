# Lowerbeam roadmap

Lowerbeam is the local AI workbench for small (8 GB) GPUs. It works with the official llama.cpp builds and never forks them.

This page shows what we're working on and roughly in what order. Releases come out weekly-ish on Sundays, and plans may change as we learn more. Nothing here is a promise or a date, only what's planned.

## 0.15 "First five minutes" (now)

- Lowerbeam finds llama.cpp on your machine, or offers to download the official build for you, with the download checked before it's installed.
- Get from downloading the AppImage to your first chat reply without opening a terminal.
- Clearer project pages: a contributing guide, issue and PR templates, and Discussions.

## 0.16 "Engine inside" (next)

- Move the chat and compaction logic into one shared engine, with no change to how chat works for you.
- A bigger, fairer test set for compaction, so results can be reported with honest ranges.

## 0.17 `lowerbeam serve`

- Run Lowerbeam as a local OpenAI-compatible endpoint that editors and scripts can use, with the same tuned settings as the app.
- Local only, protected by a key.
- Pick a model by name. If it won't fit on your card, you get a clear reason instead of a silent fallback.
- More of Lowerbeam available from the headless CLI, with the app as one client among several.

## 0.18 "Profiles v0"

- A shared, public database of GPU and model profiles: launch settings and speeds people have measured on real cards.
- When there's a match for your GPU and model, Lowerbeam uses it as a starting point, then confirms it with a quick run on your machine.
- Your own measured settings always win over the shared ones.
- Share your numbers through a pre-filled issue form. Nothing is sent automatically.

## Later

- **Windows support.** First a trial run to check what works, then a proper port. Running code from Coding mode stays off on Windows until it has a safe sandbox.
- **Voice.** Push-to-talk speech-to-text into the Coding mode prompt, running locally.
- **Compaction research.** Keep long chats useful on small cards by keeping facts rather than a vague summary, and publish the results with their limits.

## Not planned

- Bundling, forking or patching llama.cpp. Lowerbeam uses the official builds.
- Fine-tuning or training models.

## How to help

Found a bug, have an idea, or want to share how Lowerbeam runs on your GPU? Open an issue at https://github.com/giobuilds/lowerbeam/issues.
