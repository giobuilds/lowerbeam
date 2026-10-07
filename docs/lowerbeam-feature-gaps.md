# Lowerbeam: feature gaps against local-model apps and coding harnesses

Checked against `main` at `7aee4f5` (2 Oct 2026 19:01 BST; PR #92 added auto-update since the last check). Every gap below was confirmed by searching `src/`. "Planned" means the project's own docs already commit to it.

## Top 10, ranked by value against effort

| # | Feature | Effort | Why it matters | Evidence it is missing | Status |
|---|---|---|---|---|---|
| 1 | **MoE expert offload control** (`--cpu-moe` / `--n-cpu-moe` as a launch option, counted by the planner) | S | On 8 GB this is the difference between a 30B-A3B being unusable and usable. LM Studio and KoboldCpp have a toggle | `launchConfigSchema` has no such field (`shared/schema.ts:8-22`). Speed estimates already recommend it (`speed.ts:198-204`) and the capability record was measured with it (`capability.ts:145`), but users have to type it into extra args | New, small |
| 2 | **"Measure this model"**: run a short harness subset in the app and write a local capability entry | M | The capability record is hard-coded to five file hashes from the developer's machine (`shared/capability.ts:95-215`), so every user's own model shows as "unmeasured". This is Lowerbeam's unique selling point, and it is invisible to everyone else | Harness exists only under `tests/harness/`. No IPC or UI to run it | **Done** (#103): bundled corpus, Measure action, indicative local entries |
| 3 | **Stable local API**: fixed port option, optional `--api-key`, a `/v1` URL to copy, LAN access opt-in only and with a key | S | Lets Chevron, Continue, Aider and others use the model Lowerbeam manages. Ollama (11434), LM Studio, Jan and KoboldCpp all offer this | `pickFreePort()` on every launch (`supervisor.ts:129`). No `--api-key` in `buildArgs` (`:445-485`). The UI shows the port but it changes every launch (`App.tsx:199`) | New |
| 4 | **Model swapping through llama-server router mode** (`--models-dir`, `--models-max 1`) | M | Switch chat, coding and small CPU helper models without a manual relaunch, the way Ollama and LM Studio load on demand | `buildArgs` always passes `--model` (`supervisor.ts:451`). `coding-plan.md` still says "Only one model at a time", which llama.cpp's router mode has since made outdated | **Done** (#105): router launch, per-request model, worst-case VRAM plan |
| 5 | **`AGENTS.md` and project rules, read as facts** | S | Aider conventions, Cline/OpenCode rules and Goose hints all exist because models do better with them | No `AGENTS.md` handling in `src`. `coding-plan.md` defers it "until Stage 2 and then only as facts", and Stage 2 has shipped | **Planned**, overdue |
| 6 | **Structured output**: JSON schema / GBNF in chat, then compaction M2 | M | Reliable tool arguments and extraction on small models. Ollama and LM Studio expose it, and llama-server supports it | No `grammar`, `json_schema` or `response_format` anywhere in `src` | **Planned** (structured-compaction M2) |
| 7 | **Chat search, export (Markdown/JSON) and system-prompt presets** | S | Everyday basics that every competitor has | `ChatSidebar.tsx` has no search. `ChatSettings.tsx` has a per-chat prompt only, with no presets | New |
| 8 | **Git-aware apply**: show branch and dirty state, apply as a commit or onto a branch, optionally use a worktree as the workspace | M | Aider's auto-commits and Cline's checkpoints make undo cheap. It fits the existing review model | Git is used only for `ls-files` (`workspace.ts` `listAll`) | **Done** (#109) except the worktree: branch and state shown, apply as a commit or on a new branch, undo by a revert commit. A worktree workspace would need the repository's `.git` lent to the box, where a run could plant hooks that run outside it |
| 9 | **KV slot save and restore** (`--slot-save-path`, `/slots/{id}?action=save`) per chat or project | M | Re-filling a long prompt is slow on small GPUs, and restoring a saved slot is context-frugal | No slot save code in `src` | **Done** (#110): saved on leaving a chat of 2k+ tokens, restored into a free slot on return, 4 GB cap; measured per model and build, since a hybrid model (Qwen3.5 family) gains nothing from a restore on build 10826 |
| 10 | **Speculative decoding**, including n-gram/lookup modes that cost no VRAM, with the draft model in the VRAM plan | M | LM Studio and KoboldCpp offer it. The planner integration is what would set Lowerbeam apart | Only a failure regex mentions a draft model (`supervisor.ts:36`). No `--model-draft` | New |

Worth doing later:
- A headless CLI (`lowerbeam run --project --task`) over `CodingSupervisor`.
- Confirmation for MCP tool calls in chat.
- A project-only embedding index served by a small CPU model through router mode. This should not become document RAG.

## Already there, and rare among competitors

- **VRAM planning before launch.** The KV figure reproduces llama.cpp's own byte for byte, and downloads come with fit and speed estimates for each quant, based on measured bandwidth.
- **A binary health check** that catches broken ROCm or CUDA builds, crash messages that name a cause, and adopting a server left running.
- **A per-model capability record** keyed by file hash, enforced in the main process.
- **Grant, copy, Changes and Apply with conflict detection.** Undo is now atomic, and a bubblewrap run mode includes an Evidence panel (failures before against failures after).
- **A journal-backed coding run** that survives a renderer reload, plus a measured harness that includes poison and canary authority tests.
- **Exact context accounting** (`cache_n + prompt_n + predicted_n`), folding, and checkpoints projected from the journal.
- **An isolated reading pane**, an SSRF guard on page fetches, and an environment allowlist for MCP servers.
- **AppImage self-update.** Already shipped, so dropped from the candidates. A tests-run loop also exists already (run mode).

## Deliberately do not build

- **Voice** (whisper.cpp), role-play and character features (KoboldCpp, text-generation-webui), and LoRA training UIs. They are off-direction, and the fine-tune plan uses rented GPU time.
- **Windows or macOS** until there is a validated sandbox backend for each. The plan lists "Linux only" as a non-goal.
- **Cloud models or any silent fallback** to one.
- **Per-call approval buttons in coding runs.** The plan chooses visible grant terms instead. Approval only makes sense for chat MCP tools.
- **Open WebUI-style knowledge bases and document RAG.** They cost context and sit outside the project-scoped direction.
- **Multi-agent setups or a plugin marketplace.** The plan rules out a second agent until the harness names a failure that needs one.
- **LAN serving by default.** Offer it only as an opt-in, with a key.
