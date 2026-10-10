# Structured compaction

A plan for replacing prose summaries with a typed, checkable record of a
conversation. Long-running work; the milestones are separable and each one is
useful on its own.

## Why

Lowerbeam compacts a conversation by asking the running model to summarise its
oldest turns and sending that summary in their place. It works, and it is the
right floor to build on, but it has three weaknesses that are structural rather
than incidental.

**It cannot be checked.** A prose summary that quietly invents a decision is
indistinguishable from one that does not, unless you read the original — which
is the thing compaction exists to avoid. Every later turn then builds on the
invention.

**Its quality is the summariser's quality.** Measured on a real conversation
from this repo (1,795 tokens of transcript):

| model | time | what it kept |
|---|---|---|
| Ornith-1.5-9B (GPU) | 22.7s | SDL3, the `static const char *story[]` array, the `gcc` command, the reason for the decision, the roadmap |
| Qwen3-0.6B (CPU) | 5.5s | "you want to code, care about story, and are stuck with SDL" |

The small model kept the gist and lost every specific — which is exactly what a
summary is *for*. But this measured prose generation, the hardest thing a small
model does. It says nothing about extraction, which is among the easiest.

**Prose does not compress well.** Free text spends tokens on connectives and
framing that carry nothing. A conversation's load-bearing content is a small
number of facts of a few known kinds.

## The idea

Compact into a **typed structure** rather than a paragraph, and treat the
transcript as having three layers, each handled by the cheapest thing that can
handle it.

**1. Mechanical.** Code fences, file paths, flags, commands, error strings,
numbers with units, identifiers. This layer is not English and needs no model:
it is extractable with tokenising and pattern matching, losslessly and in
microseconds. Most of what gets destroyed by paraphrasing lives here.

**2. Speech acts.** A technical conversation is made of a small, closed set of
moves: a constraint stated, a decision made with a reason, an option rejected
with a reason, an artifact produced, a question left open. Roughly six kinds.
This is what a model should extract — as slots, not sentences.

**3. Derivation.** The reasoning that got from a question to an answer. Large,
and mostly re-derivable. This is what should be dropped first.

### Why extraction beats prose for a small model

llama.cpp supports GBNF grammars, which constrain decoding so output *must*
match a given form. A 1B model asked to fill

```
{"decisions": [{"chose": …, "over": …, "because": …}], "constraints": […]}
```

under a grammar cannot emit anything else. It can still be wrong, but it cannot
ramble, drift out of format, or answer the conversation instead of summarising
it — three of the four failure modes seen from the 0.6B. A model that is poor at
writing notes may be adequate at filling a form, and that is the hypothesis
worth testing.

## Acceptable loss

The current implementation has no loss policy; it summarises the oldest turns
because they are oldest. A memory needs a stated one.

| kind | policy | why |
|---|---|---|
| Constraint (hardware, versions, "no Rust") | never evicted | silently violated later, and the whole thread derails |
| Decision + rationale | never evicted | the conversation's actual output |
| Rejected option + reason | never evicted | re-suggesting a rejected thing is the most irritating failure there is |
| Artifact (path, signature, flag, command) | kept while referenced | reused verbatim later; paraphrasing destroys it |
| Open question | kept until answered | otherwise the thread is silently abandoned |
| Derivation | evicted first, oldest first | recoverable by re-deriving |

Eviction ordered by **type and reference count**, not age. A fact mentioned in
three separate turns is load-bearing; one mentioned once, forty turns ago, and
never again, is not.

### Two rules that make the boundary concrete

**Specification survives, derivation compresses.** What the user asked for is
unrecoverable if lost; how it was worked out usually is not. Keeping user turns
verbatim (as the current implementation does) is the crude version of this rule
— a hedge against an untrusted summariser, not a principle. With a trustworthy
extractor, three related questions should collapse into one stated intent.

**Interfaces stay exact, bodies compress to intent.** The loss boundary in code
is not "code versus prose". A signature, filename, flag or compile command gets
reused word for word later, so paraphrasing it destroys it. A forty-line
function body is a derivation, and "prints each story line with a pause between
them" recovers it. Interfaces are syntactically identifiable, so this rule is
mechanically applicable.

## Verification

This is the part that makes it a project rather than a hope, and the property
free-form summarisation cannot have.

**Mechanical checks.** A structured record can be validated against the
transcript it came from: every file path, flag and identifier it cites must
appear in the source; every decision must reference a turn; every quoted command
must match one that was actually given. Anything unsupported is a hallucination,
caught without a human reading anything.

**An answerability harness.** Compact a real conversation, then ask questions
answerable only from the compacted form: *what did we decide about SDL and why*,
*what is the compile command*, *what did we rule out*. Score against the full
transcript. This turns "is a small model good enough" from an argument into a
number, and gives every later change something to be measured against.

The harness comes first. Without it, everything downstream is taste.

## Milestones

Each ends at something usable; none requires the next.

| # | Deliverable |
|---|---|
| **M0** | Corpus of real conversations + answerability harness. Score today's prose compaction as the baseline to beat. |
| **M1** | Mechanical extraction: paths, flags, commands, code interfaces, error strings. No model. Already a better record than prose for the things it covers. |
| **M2** | Schema-constrained extraction using the model already loaded. The first score tied the prose summary. A later draw beat it, and a chat now sends that record. |
| **M3** | Eviction policy: typed budget, reference counting, interface/body rule for code. |
| **M4** | Verification wired into the UI — show what was kept, flag anything unsupported by the transcript. |
| **M5** | Optional: a fine-tuned small extractor, judged against M0. Only worth doing if M2 shows the running model's extraction is the bottleneck. |

M0 and M1 are the ones that de-risk everything else. M5 is the one to resist
starting with.

## M0 baseline

The harness is `node tests/harness/compaction/run.mjs`. It runs today's
`summarise` and `projectConversation` on two real chats, at a 7,424-token
slot, which is what Ornith-1.5-9B gives a chat at `--parallel 4`. The server
is started at 16,384 so the summary request itself fits. The slot size is only
what the budgets see.

The corpus is `tests/harness/compaction/corpus/`. Reasoning, attached images
and fetched pages are left out. The questions live in `keys/`, and a unit test
checks that none of them is a substring of the corpus and that every spelling
sits in the turns a summary replaces. Two facts sit in the four turns the app
keeps verbatim at this window — which city they are in, and the clock time
they stated — so a summary is not asked to carry them, and they are not
scored.

A fact hits when the reply contains one of its spellings, ignoring case. A
paraphrase that drops the transcript's wording is a miss. Each question is
asked twice: **projected** is what the app would send (the summary, the user's
lines kept word for word, and the recent turns), and **summary** is the
paragraph alone. **Retained** is whether the paragraph itself contains the
spellings, whether or not the reply quoted them.

The daily Ornith launch sets `--reasoning-budget 1024`. The summary cap is 700
tokens. With thinking left on, that cap was spent in reasoning and the content
came back empty, including when the budget was 0: the turn finished for length
with no paragraph. The app then stores nothing. The scored run passes
`--reasoning off`, so the 700 tokens are the paragraph. One draw, Ornith-1.5-9B
Q4_K_M, llama.cpp 0.4.0-dev (build 10826), 9 Oct 2026:

| chat | projected | summary | retained |
|---|---|---|---|
| riverton-clock | 3/7 | 4/7 | 6/7 |
| sdl-story | 0/7 | 0/7 | 1/7 |
| total | 3/14 | 4/14 | 7/14 |

The Riverton paragraph kept six of the seven spellings (it lost `Time.now`) and
the replies quoted four. The SDL paragraph kept `700000` and retold the rest
in its own words: the pointer bug became "the pointer never advanced" and
"`line++` never executed", which misses `pointer never moves`, and the
decision to drop SDL became "using only `stdio`", which misses `don't need SDL`.
The opening line, the `gcc -o story engine.c` command and the names Roblox,
Godot and Unity are absent from that paragraph. The compile command is also
sitting in one of the four kept turns, and the reply to it was `unknown`.
The same happened to spellings the projection did contain: `700000` is in the
verbatim user lines and in the SDL paragraph, and `Claude` and `8th September
2026` are in the Riverton user lines, and those replies were `unknown` too.
That is the number later milestones have to beat.

The harness that produced the table started the server with `--reasoning off`.
With the daily launch (`--reasoning-budget 1024`), and with a budget of 0, the
summary cap was spent on reasoning and `summarise` stored nothing. `summarise`
now turns thinking off on that request. The harness was run again on 9 Oct
2026 with `--reasoning-budget 1024` and without `--reasoning off`. Both
summaries were written on the first attempt. The answer calls still think,
inside the 2,048-token reply cap.

| chat | projected | summary | retained |
|---|---|---|---|
| riverton-clock | 6/7 | 5/7 | 5/7 |
| sdl-story | 2/7 | 1/7 | 1/7 |
| total | 8/14 | 6/14 | 6/14 |

Riverton's replies quoted six spellings and missed `Time.now`. The paragraph
kept five: it also dropped `Claude`. SDL's projection quoted the compile
command and `700000`. The paragraph kept `700000`. The other SDL spellings
were paraphrased or absent, as in the baseline. The first table remains the
M0 number.

## M1

`extractMechanics` in `src/context/extract.ts` keeps the spellings a paragraph
paraphrases away: shell commands, file paths, host names, flags, includes,
macros, function signatures, the string literals a program prints, and
compiler errors. It is a scan of the text. It does not call a model. A chat
stores this scan beside the speech record.

A function body is not part of the record. The line `if (*line == ' ')` is how
the pointer bug was worked out, and the scan leaves it. The signature
`int main(void)` and the literal `You wake in a small, dark room.` stay.

Four of the fourteen M0 questions are this layer: the opening line, the
compile command, `700000`, and `Time.now`. On the turns a 7,424-token slot
summarises, the scan keeps all four. The prose paragraph in the M0 run kept
one of them, `700000`. The other ten questions are decisions and names — what
was set aside, which engines were listed, why the pointer stuck, who built the
program, which date was insisted on. Those spellings are not in this record.

## M2

`extractSpeech` in `src/context/speech.ts` asks the loaded model to fill a
JSON schema: constraints, decisions with reasons, rejected options with
reasons, artifacts, and open questions. The request uses the same
`OutputConstraint` as chat, which turns thinking off. The lists are capped at
twelve. Each string is asked for as a short contiguous span of the transcript.
The reply cap is 2,048 tokens. The prose cap of 700, and then 1,400, cut a
verbatim object off mid-string. The number to beat is the M0 retained column,
7/14.

`node tests/harness/compaction/speech.mjs` fills the form for the same two
chats and the same 7,424-token slot, and counts spellings in the form. It does
not ask the questions back. Combined is the form plus the M1 scan of the same
turns, which is the string a chat stores.

One draw, 9 Oct 2026, Ornith-1.5-9B, llama.cpp 0.4.0-dev build 10826,
`--reasoning-budget 1024`, temperature 0. The reply cap that day was 1,400,
and the instruction still allowed a paraphrase. The chat was scored under its
old id, `london-clock`. That draw was not re-run after the rename to
`riverton-clock`.

| chat | speech | speech plus the M1 scan |
|---|---|---|
| london-clock | 3/7 | 4/7 |
| sdl-story | 1/7 | 3/7 |
| total | 4/14 | 7/14 |

The form alone was behind the paragraph. Adding the mechanical scan tied the
paragraph and did not pass it. The SDL decisions described the pointer bug as
"the pointer never moved forward" and never wrote `pointer never moves` or
`don't need SDL`. One London constraint was the instruction's own definition of
a constraint, "a limit someone in the transcript stated". The prose summary
stayed.

The instruction was then changed to ask for a short span copied as it was
said, and the cap was raised to 2,048. One draw, 10 Oct 2026, same model,
same binary, same launch, same slot, temperature 0:

| chat | speech | speech plus the M1 scan |
|---|---|---|
| riverton-clock | 5/7 | 6/7 |
| sdl-story | 3/7 | 5/7 |
| total | 8/14 | 11/14 |

Speech alone is already past 7/14. With the scan it is 11/14. The misses are
`Claude` on the Riverton chat, `don't need SDL`, and the three engines
(Roblox, Godot, Unity) on the SDL chat. The pointer line and both buffering
spellings are in the form. The opening line, `700000` and `Time.now` come
from the scan. The compile command is inside an artifact,
`gcc -o story engine.c && ./story`. A chat now stores that combined string.
`summarise` remains for the M0 harness. A later compaction puts the stored
record back into the transcript and scans it again, then replaces it, so the
text does not grow by appending.

## What is already known

Measured while building the current implementation, and worth not rediscovering:

- A chat gets `--ctx-size ÷ --parallel`, not the whole context. Ornith-1.5-9B on
  an 8 GB card: 7,424 tokens per chat at `--parallel 4`, which is the slot the
  compaction budgets use. One slot is not a fixed 38,912. That figure had no
  date and is withdrawn. `--fit` follows free VRAM; the dated runs are under
  "Context with the projector on the CPU" below.
- A projector on the GPU is what cut the context to 4,096. On the CPU, or with
  no projector, `--fit` still sizes the context, and the two launches match.
  The 34,304 / 36,352 pair is explained under that same heading.
- Prior reasoning is never resent, so prompts stay small. In a 2,048-token
  window the measured prompts were 28–144 tokens while replies generated
  ~2,000 — **the window was consumed by one reply's thinking, not by history.**
  No compaction scheme addresses that; only a larger window does.
- The server reports exact token counts per request (`timings.prompt_n`,
  `predicted_n`). Accounting should always use these, never a
  characters-over-four estimate.
- Summarising 1,795 tokens with a 9B costs ~22s. Run in the background after a
  reply, that is free; run in front of the next question, it is a stall.

### Context with the projector on the CPU

The 34,304-token context with no projector, and the 36,352 with the projector
on the CPU, are llama.cpp `--fit` results from the #148 measurement, both with
34 of 34 layers on the RX 6600. The planner does not choose them. `planVram`
charges a projector only when that projector is on the GPU. `fitParams` runs
`llama fit-params --model` and passes no projector, so it cannot be the source
of a projector launch having the larger context.

`--no-mmproj-offload` adds the projector's estimate to the CPU fit target. For
this file the server logs `adding 1127.09 MiB to fit_params_target for device
CPU`. The GPU target stays put.

Re-run on 9 Oct 2026 with llama.cpp 0.4.0-dev build 10826 (`73a43d1f6`), back
to back, idle VRAM 1,705 MiB, `--fit on --flash-attn on`, f16 KV cache, the
same model file:

| launch | parallel | context | what fit kept |
|---|---|---|---|
| no projector | 4 | 16,384 total, 4,096 a slot | 31 layers |
| projector on the CPU | 4 | 16,384 total, 4,096 a slot | 31 layers |
| no projector | 1 | 13,568 | the whole model |
| projector on the CPU | 1 | 13,568 | the whole model |

At each slot count the two launches fitted the same context. The published
pair is 2,048 tokens apart, which is 64 MiB of this model's f16 KV. That is
the width of a small change in free memory between two separate `--fit` runs.
A launch with no projector does not come out behind.

Re-run on 10 Oct 2026, same binary and model, `--parallel 1` only, each
launch twice. Before every launch sysfs reported 1,840,234,496 bytes used
(1,755 MiB) and `llama serve --list-devices` reported 6,421 MiB free of
8,176. After each server stopped, sysfs was back at 1,840,234,496. The fit
itself logged 6,370 MiB of free device memory against a projection of 13,406.

| launch | run | free at launch | context |
|---|---|---|---|
| no projector | first | 6,421 MiB of 8,176 | 11,776 |
| no projector | second | 6,421 MiB of 8,176 | 11,776 |
| projector on the CPU | first | 6,421 MiB of 8,176 | 11,776 |
| projector on the CPU | second | 6,421 MiB of 8,176 | 11,776 |

Each log says the context was reduced from 262,144 to 11,776 and that the
whole model fit. The CPU-projector launches also logged `adding 1127.09 MiB
to fit_params_target for device CPU`. The 34,304 / 36,352 pair was not
reproduced, and neither was the 13,568 from the day before. The card had
about 50 MiB more in use than on 9 Oct (1,755 MiB against 1,705), and the
fitted context moved. Two repeats at the same free amount agreed. `--fit`
results depend on free VRAM. They are not a stable one-slot size.

The older note that a loaded `--mmproj` makes `--fit` stop searching and use
4,096 is the projector-on-GPU row from that same measurement: 4,096 tokens and
33 of 34 layers. With the projector on the CPU, `--fit` still searches. At
four slots the search reduced the context from 1,048,576 to 16,384 and then
kept 31 layers; 4,096 a slot is that result, and it happens to equal the
default.

### Constrained decoding, as shipped for chat

Chat can require a reply to match a JSON schema or a GBNF grammar (#107), and
`streamChat` takes the same `OutputConstraint`, so M2 has the plumbing. One
finding to carry into it: a thinking model starts its reply in a reasoning
block, and llama.cpp then files the constrained text under reasoning and
returns an empty reply. Measured on Ornith-1.5-9B: a yes/no grammar answered
"no" as reasoning and nothing as content. Constrained requests therefore turn
thinking off (`chat_template_kwargs.enable_thinking = false`); with it off the
same model answered "yes", and filled `{"name", "born"}` with
`"Ada Lovelace", 1815`. The M2 form uses that switch. The scores are in the M2 section above.

## Open questions

- **Does grammar-constrained extraction actually hold up at 1B?** The whole case
  for a small helper model rests on this and it is untested.
- **Does the schema survive contact with non-technical conversations?** Six
  speech acts fit a coding chat. A conversation about a novel may need
  different slots, or the schema may need to be per-conversation.
- **What does extraction cost?** It runs over every compacted turn rather than
  once over a blob; that may be more total tokens than prose summarising, not
  fewer.
- ~~**How is a stale record repaired?**~~ Answered in [Direction](direction.md):
  slots are facts (append-only, superseded by reference), state (overwritten)
  or transient (replaced every step). A reversed decision is a new fact that
  supersedes the old one, which stays, marked.
- ~~**Is a structured record worse as *prompt* material?**~~ Sidestepped in
  [Direction](direction.md): the stored form is structured and checkable, the
  prompt form is rendered from it by a template. The model never sees the
  record's shape unless a test shows it should.

## Beyond Lowerbeam

The schema, the eviction policy and the harness are model-agnostic and
app-agnostic. Anything that talks to a model with a finite context has this
problem, and most solve it with a prose summary and hope. If M0–M3 hold up, the
schema and the harness are worth publishing separately from the app — the
harness especially, since nobody can currently answer "is my compaction any
good" with a number.
