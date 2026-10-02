# Direction

How [Lowerbeam Coding Architecture](Lowerbeam_Coding_Architecture.pdf) and
[Structured compaction](structured-compaction.md) fit together, and what
Lowerbeam becomes if both are built. Read those first; this document only says
where they meet, where each fixes the other, and in what order to do the work.

## One product, not two features

The coding architecture closes by saying Lowerbeam's value is making a local
model's **access, changes, resource use and evidence** understandable. The
compaction plan supplies the noun that list is missing: **memory**.

Together: a harness where you can see what the model can reach, what it
changed, what it remembers, and what it verified — and where every one of those
is checkable against a record rather than asserted by the model. That is a
coherent product, and a different one from a llama-server front end.

## Where the two documents meet

### They describe the same schema from two directions

The coding architecture (§7) says to compact before exhaustion and preserve
*goal, constraints, changed files, verification status, unresolved errors, next
action*. The compaction plan proposes *constraint, decision + reason, rejected
option + reason, artifact, open question*, with derivations dropped first.

Side by side these are one schema seen from two angles — one oriented to task
state, one to conversation memory. Merged:

| slot | kind | source |
|---|---|---|
| goal | fact | coding |
| constraint | fact | both |
| decision + reason | fact | compaction |
| rejected option + reason | fact | compaction |
| artifact (path, signature, flag, command) | referenced | both |
| changed files | state | coding |
| verification status | state | coding |
| unresolved error | state | coding |
| open question | state | compaction |
| next action | transient | coding |
| derivation | evictable | compaction |

A coding run's "structured current-state summary" is a compaction record with
a task-specific extension. Neither feature needs its own memory system.

### The journal is the transcript compaction needed

The compaction plan's central claim is that a structured record can be checked
against its source: every path, flag and decision must appear in the
transcript. In chat, the transcript is a JSON file of messages. The coding
architecture proposes something better suited — an append-only event journal
with sequence numbers, where every tool call, result, exit code and diff is
written before its side effect.

That journal is the source of truth, and the compaction record is a **derived,
verifiable projection of the journal up to a sequence number.** The
`throughMessageId` anchor in the current implementation becomes a journal
offset; "checkpoint" and "compaction" turn out to be the same object. Restart
recovery follows: last checkpoint plus the events since.

### In a coding run, most of the mechanical layer is already structured

The compaction plan's cheapest win is that paths, commands, error strings and
signatures can be extracted with no model. In a coding run they arrive
structured: a read tool returns a path and a range, a command tool returns an
exit code and output, a patch tool returns a diff. The coding architecture's
rule — keep complete output as local artifacts, return bounded excerpts to the
model — is the compaction plan's "artifacts kept while referenced".

So compaction in a coding run is mostly **reference management**: which
artifacts stay inline and which go by reference. Only the model's own turns
need speech-act extraction, and in an agent loop those are short. This is far
cheaper than the ~22s a 9B needs to summarise 1,800 tokens of chat.

## Where each fixes the other

### Store structured, render prose

The compaction plan's most dangerous open question was whether a structured
record is *worse* as prompt material than the prose it replaces, since models
are trained on prose. The coding architecture's approach implies the answer:
the **stored** form is structured and checkable; the **prompt** form is
rendered from it by a deterministic template; and anything consequential is
re-read from the current file rather than trusted from memory.

This removes the risk from the compaction plan. The record's shape is chosen
for verification and eviction; the model never sees JSON unless a test shows
it should.

### Facts, state, transient

The compaction plan said "decisions are never evicted" but had no answer for a
decision reversed twenty turns later. The coding architecture's slots make the
repair policy obvious, and it is the `kind` column above:

- **Facts** — goal, constraints, decisions, rejections — are append-only.
  A reversal is a new fact that supersedes the old one by reference; the old
  one stays, marked superseded, so "why did we stop doing X" remains
  answerable.
- **State** — changed files, verification status, unresolved errors, open
  questions — is overwritten. The latest test run *replaces* the previous
  verification status rather than sitting beside it.
- **Transient** — next action — is replaced every step and never persisted
  beyond the checkpoint that carries it.
- **Evictable** — derivations, tool output beyond its excerpt — goes first,
  oldest first, by reference count.

### One harness, three task families

The compaction plan's M0 is an answerability harness. The coding architecture's
§9 is a 20–30 task evaluation listing "context compaction" as a
model-compatibility check. These are the same investment. Build one harness
with three families:

1. **Answerability** over compacted chats — can the model answer questions
   only the compacted form could support?
2. **Task completion** in coding runs — the coding architecture's families:
   task quality, authority, file integrity, lifecycle, model compatibility.
3. **The crossover** — a coding task long enough to *force* compaction, then
   check the agent still knows its goal, constraints and changed files, and
   that its verification status matches the journal.

The third family tests both documents at once and is the most valuable single
evaluation either proposes.

## What this means for the architecture

The coding architecture puts context construction in the agent worker and the
journal in the main process, and keeps the agent loop out of React. Compaction
*is* context construction, so it belongs in the worker.

Today it lives in `chatStore`, in the renderer. The architecture document
inspected version 0.4.1, before compaction existed; the renderer owns *more* of
the loop now, not less, so the refactor it recommends is larger than it
assumed. The direction is:

- **A context engine module shared by chat and coding** — owning projection,
  eviction, extraction and rendering, reading from a journal, writing
  checkpoints. `src/context` or a package of its own, since the compaction plan
  wants it reusable outside Lowerbeam.
- **The renderer holds a view of it**, the way the coding architecture says a
  renderer coding store should hold a projection of backend state rather than
  a second engine.
- **Chat adopts the journal after coding does.** Conversation files become a
  journal plus checkpoints; the transcript on screen is a rendering of the
  journal, as it already is in spirit.

One boundary to be firm about. The architecture's preferred engine, Pi core,
has its own context-transformation facilities. If the adapter lets the engine
own context, structured compaction becomes engine-specific and the "useful to
other projects" goal is lost. **Lowerbeam owns context construction and hands
the engine a finished working set.** The compaction plan is a reason to hold
that line, not just a preference.

## Sequence

The coding architecture has Stages 0–4; the compaction plan has M0–M5. They
interleave rather than queue. The stages themselves — tasks, gates, non-goals —
are in [Coding: the plan](coding-plan.md); this table only says what lands
together.

| stage | coding architecture | compaction plan | why here |
|---|---|---|---|
| 0 | engine contract, threat model, sandbox probe | **M0** harness, families 1 and 2 | the harness has to exist before the engine is chosen, or the choice is reputation |
| 1 | read-only project intelligence, job lifecycle, journal | **M1** mechanical layer; context engine module | tool results first need bounding here, and read-only is safe |
| 2 | isolated workspaces, preconditioned patches, Changes view | **M2** schema + grammar-constrained extraction; **M3** facts/state/transient policy | *changed files* and *verification status* become real slots with real diffs to check against |
| 3 | sandboxed execution, cancellation, recovery | **M4** verification wired into the UI; family 3 of the harness | recovery is where a checkpoint that lies is most expensive |
| 4 | evidence-led expansion | **M5** small extractor, only if M2 shows the running model is the bottleneck | last, and only with a number that says it is needed |

Chat's compaction is migrated onto the context engine at Stage 1 and gains the
schema at Stage 2, so the everyday chat experience improves on the same
timeline without a separate project.

## What stays true from the architecture document

Two of its observations are still accurate after the work since 0.4.1 and are
worth carrying forward as constraints:

- The generic IPC wrapper did not validate the sender; only the reader
  handlers did. Since 0.9.19 every handler, and the context menu's
  listener, serves only the app's own page in its own window as the top
  frame (`src/main/sender.ts`, #76).
- MCP servers started with the host's environment; since 0.9.20 they get
  only `PATH`, `HOME`, the locale, `TMPDIR` and `XDG_*`, plus what their
  config names (#77). They still expose every discovered tool. That is
  acceptable for chat and not for a coding run, which should select servers
  and tools per grant.

Both were Stage 1 work. What remains of the second, choosing servers and
tools per grant, comes with MCP in coding runs, which do not use it yet.
