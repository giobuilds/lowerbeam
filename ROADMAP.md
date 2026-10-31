# Lowerbeam roadmap

Lowerbeam is the local AI workbench for small (8 GB) GPUs. It works with the official llama.cpp builds and never forks them.

This page shows what we're working on and roughly in what order. Releases come out weekly-ish on Sundays, and plans may change as we learn more. Nothing here is a promise or a date, only what's planned.

## 0.15 "First five minutes" (released 18 Oct)

- Lowerbeam finds llama.cpp on your machine, or offers to download the official build for you, with the download checked before it's installed.
- Get from downloading the AppImage to your first chat reply without opening a terminal.
- Clearer project pages: a contributing guide, issue and PR templates, and Discussions.

## 0.16 "Engine inside" (released 25 Oct)

- Chat compaction now runs through one shared engine, with no change to how chat works for you. It's the groundwork for `lowerbeam serve`.
- A bigger, fairer test set for compaction (10 chats, 62 questions) that reports a median and a range, so results come with honest ranges.
- **Model cleanup.** The Models tab lists every model already on disk with its size, when you last launched it and any duplicate copies, and deletes the ones you don't need, along with a vision projector paired with them.
- **Light theme.** The window follows your system's light or dark setting, or you can pick one in Settings. Dark is unchanged.

## 0.17 `lowerbeam serve` (next)

- Run Lowerbeam as a local OpenAI-compatible endpoint that editors and scripts can use, with the same tuned settings as the app.
- Local only, protected by a key.
- Pick a model by name. If it won't fit on your card, you get a clear reason instead of a silent fallback.
- More of Lowerbeam available from the headless CLI, with the app as one client among several.

## 0.18 "Profiles v0"

- A shared, public database of GPU and model profiles: launch settings and speeds people have measured on real cards.
- When there's a match for your GPU and model, Lowerbeam uses it as a starting point, then confirms it with a quick run on your machine.
- Your own measured settings always win over the shared ones.
- Share your numbers through a pre-filled issue form. Nothing is sent automatically.
- **GPU readout.** Live power, temperature and clock speed for AMD and NVIDIA cards, so you can see when a small card is throttling and why a run got slower.
- **Network badge and offline switch.** A badge shows when Lowerbeam is reaching the internet and why, and one switch turns all of it off. Running locally should be easy to check, not just a claim.

## 0.19 "Easier for everyone"

- **Accessibility pass.** Labels for screen readers, keyboard focus you can see, and checked contrast in both themes, so the app works for more people.
- **"Try the next quant up".** After a launch, if there's VRAM to spare, Lowerbeam suggests the next higher-quality version of the same model that would still fit. A free quality gain on a card where every gigabyte counts.

## Later

- **Windows support.** First a trial run to check what works, then a proper port. Running code from Coding mode stays off on Windows until it has a safe sandbox.
- **Voice.** Push-to-talk speech-to-text into the Coding mode prompt, running locally.
- **Compaction research.** Keep long chats useful on small cards by keeping facts rather than a vague summary, and publish the results with their limits.
- **Memory across chats.** Keep the important facts outside the context window so small models stop losing track. Built in this order, and each step has to beat plain compaction before the next one starts:
  1. **Task journal.** The goal, decisions, files changed, test results and next step, saved as records that survive compaction and restarts.
  2. **Project note and chat search.** A short note of key project facts at the start of each chat, plus one tool to search past chats and quote them exactly. Built on SQLite full-text search.
  3. **Smarter Coding mode search.** Reuse the existing search and mark entries as stale when a file's hash changes.
  4. **Context budget.** Fit relevant memory, code and recent messages into a fixed token budget, with links back to the source.
  5. **Through `lowerbeam serve`.** Let apps like Chevron use the same memory.

  Saved only after a chat ends, kept on your machine, and you can see, correct, turn off and delete everything. Secrets are never kept. Measured against compaction for task completion, repeated failures, tokens and speed, including a forced compaction partway through a task.

## Ideas

Worth doing, not yet scheduled. Tell us in Discussions if one matters to you.

- **Usage dashboard.** Tokens and speed per model over time, kept on your machine, so you can see which models are actually worth the space.
- **Answer arena.** Ask two models the same question, one after the other so they share one small card, and compare the answers blind.
- **Ask your documents.** Point Lowerbeam at a folder and chat about what's in it, reusing the search Coding mode already has. Needs the shared engine first.
- **Lessons from past runs.** Remember what worked and what failed in earlier tool runs and bring it up when relevant. Parked until the task journal proves itself, because a model recording its own lessons can repeat its own mistakes.

## Not planned

- Bundling, forking or patching llama.cpp. Lowerbeam uses the official builds.
- Fine-tuning or training models.
- A plugin system. MCP servers already let you add tools.

## How to help

Found a bug, have an idea, or want to share how Lowerbeam runs on your GPU? Open an issue at https://github.com/giobuilds/lowerbeam/issues.
