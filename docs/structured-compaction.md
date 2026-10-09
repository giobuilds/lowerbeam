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
| **M2** | Schema + GBNF-constrained extraction using the model already loaded. Replaces the prose summary. |
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
keeps verbatim at this window — the user saying they are in London, and the
clock time they stated — so a summary is not asked to carry them, and they
are not scored.

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
| london-clock | 3/7 | 4/7 | 6/7 |
| sdl-story | 0/7 | 0/7 | 1/7 |
| total | 3/14 | 4/14 | 7/14 |

The London paragraph kept six of the seven spellings (it lost `Time.now`) and
the replies quoted four. The SDL paragraph kept `700000` and retold the rest
in its own words: the pointer bug became "the pointer never advanced" and
"`line++` never executed", which misses `pointer never moves`, and the
decision to drop SDL became "using only `stdio`", which misses `don't need SDL`.
The opening line, the `gcc -o story engine.c` command and the names Roblox,
Godot and Unity are absent from that paragraph. The compile command is also
sitting in one of the four kept turns, and the reply to it was `unknown`.
The same happened to spellings the projection did contain: `700000` is in the
verbatim user lines and in the SDL paragraph, and `Claude` and `8th September
2026` are in the London user lines, and those replies were `unknown` too.
That is the number later milestones have to beat.

## What is already known

Measured while building the current implementation, and worth not rediscovering:

- A chat gets `--ctx-size ÷ --parallel`, not the whole context. Ornith-1.5-9B on
  an 8 GB card: 7,424 tokens per chat at `--parallel 4`, 38,912 at `--parallel 1`.
- With `--mmproj` loaded, `--fit` stops sizing the context and falls back to the
  default 4,096 regardless of slot count.
- Prior reasoning is never resent, so prompts stay small. In a 2,048-token
  window the measured prompts were 28–144 tokens while replies generated
  ~2,000 — **the window was consumed by one reply's thinking, not by history.**
  No compaction scheme addresses that; only a larger window does.
- The server reports exact token counts per request (`timings.prompt_n`,
  `predicted_n`). Accounting should always use these, never a
  characters-over-four estimate.
- Summarising 1,795 tokens with a 9B costs ~22s. Run in the background after a
  reply, that is free; run in front of the next question, it is a stall.

### Constrained decoding, as shipped for chat

Chat can require a reply to match a JSON schema or a GBNF grammar (#107), and
`streamChat` takes the same `OutputConstraint`, so M2 has the plumbing. One
finding to carry into it: a thinking model starts its reply in a reasoning
block, and llama.cpp then files the constrained text under reasoning and
returns an empty reply. Measured on Ornith-1.5-9B: a yes/no grammar answered
"no" as reasoning and nothing as content. Constrained requests therefore turn
thinking off (`chat_template_kwargs.enable_thinking = false`); with it off the
same model answered "yes", and filled `{"name", "born"}` with
`"Ada Lovelace", 1815`. M2 itself waits for M0 (#117).

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
