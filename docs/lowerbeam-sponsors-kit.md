# Lowerbeam: GitHub Sponsors and writing kit

Prepared 7 October 2026 for giobuilds. Everything here is a draft: nothing has been posted, published, pushed or filed.

Sources for project facts: the repo at `main` (`c9917f9`, Release 0.11.1, merged 4 Oct 2026 18:56 BST): `README.md`, `CHANGELOG.md`, `docs/stage0-results.md`, `docs/structured-compaction.md`, `docs/direction.md`, `docs/coding-plan.md`, `docs/lowerbeam-feature-gaps.md`. Every number below is quoted from those files. GitHub Sponsors facts were checked on docs.github.com on 7 Oct 2026; links are inline.

> **Read this before using any draft text in public.** r/LocalLLaMA's Rule 3 says "Completely/primarily LLM generated copy, code is not allowed", and Hacker News's guidelines say "Please don't put generated text in HN posts. Write your text yourself" and "Don't post generated text or AI-edited text." Treat sections 4 and 5 as a fact sheet and structure to rewrite in your own voice, not copy to paste. For HN the first comment is deliberately given as notes, not prose.

---

## 1. GitHub Sponsors setup checklist (UK individual)

### Eligibility
- [ ] **You qualify.** "Anyone who contributes to an open source project and lives in a supported region is eligible". The United Kingdom is on the supported-regions list. ([About GitHub Sponsors](https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors))
- [ ] **Enable two-factor authentication** on your GitHub account first; it is required before you can become a sponsored developer. ([Setting up GitHub Sponsors for your personal account](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/setting-up-github-sponsors-for-your-personal-account))
- [ ] **Register with your true identity.** The Additional Terms require true, accurate registration data, and GitHub can refuse acceptance. ([GitHub Sponsors Additional Terms](https://docs.github.com/en/site-policy/github-terms/github-sponsors-additional-terms), s. 2.2)

### Joining
- [ ] Go to [github.com/sponsors](https://github.com/sponsors), click **Get sponsored**, complete contact information.
- [ ] **Choose payout route now: bank account (Stripe Connect) or fiscal host.** You can only set up a fiscal host at sign-up; switching later means contacting Support. For one person, Stripe Connect to a UK bank account is the simple choice.
- [ ] Accept the Additional Terms and Privacy Statement, submit.

### Stripe Connect payout
- [ ] Dashboard > **Stripe Connect account** > follow the prompts. Your region of residence and your bank account's region must match (UK and UK).
- [ ] **Get identity details right first time.** GitHub warns that name and date of birth are hard to change after the Stripe application is submitted.
- [ ] UK accounts are under Stripe's "Full service agreement" (UK is on that list in s. 3.8 of the Additional Terms).
- [ ] **Know the payout timing** (Additional Terms s. 3.3):
  - First payout: 60 days after the first sponsorship starts (a probation period applied to everyone).
  - After that: Stripe Connect payouts on the 22nd of the month for the balance since the last payout, "regardless of the amount of the balance"; dates can shift for holidays and weekends. A minimum may apply to cross-border payouts.
  - Amounts are in USD and "we may convert USD to the local currency of your address" (s. 3.5). The conversion rate and any margin are not stated.
- [ ] Payout receipts can be exported as PDFs from Dashboard > Payouts. ([Managing your payouts](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/managing-your-payouts-from-github-sponsors)) Keep them for HMRC records.

### Tax information form
- [ ] **Submit a W-8BEN** (individual, non-US). It is required before you can publish your profile. Dashboard > Overview > tax forms. Stripe holds these forms; they are not sent to the IRS. ([Tax information for GitHub Sponsors](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/tax-information-for-github-sponsors))
- [ ] On the form, use the **"Foreign tax identifying number"** field (your UK tax number), not an SSN/ITIN. GitHub notes an ITIN is "unlikely" to be needed. Which UK number to give (UTR or National Insurance number) is not stated in GitHub's docs; check the [IRS W-8BEN instructions](https://www.irs.gov/instructions/iw8ben) (not verified here).
- [ ] **GitHub does not withhold tax** and does not issue tax forms to non-US taxpayers. You are responsible for your own tax.
- [ ] **UK side (not tax advice):** HMRC's [trading allowance](https://www.gov.uk/guidance/tax-free-allowances-on-property-and-trading-income) exempts up to £1,000 a year of gross trading income; above that you must register for Self Assessment. Whether HMRC treats sponsorship income as trading income or gifts depends on what you give in return, and I could not verify that from an official source. At £100 a month (£1,200 a year) you would cross £1,000, so plan to keep records and ask an accountant or HMRC. GitHub's sales-tax note says general support is "not normally taxable" for sales tax, while a taxable benefit to a sponsor can be; another reason to keep perks light.

### What GitHub charges
- [ ] **Personal-account sponsorships: no fees.** "100% of these sponsorships go to the sponsored developer."
- [ ] **Organisation-account sponsorships: up to 6%** (3% card processing, 3% GitHub service fee); organisations can avoid the card part by paying by invoice. ([About GitHub Sponsors](https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors)) The Sponsor terms describe this as deducted on the sponsor's side; check your dashboard to see what actually arrives.
- [ ] Currency conversion by Stripe: rate and margin not published in these docs (unverified).

### Profile, tiers, approval
- [ ] Dashboard > Profile details: short bio, introduction, up to six featured repositories, optional opt-in to be featured on github.com/sponsors.
- [ ] Tiers: up to 10 monthly and 10 one-time, priced in USD, max US$12,000/month. **A published tier's price cannot be edited**, only retired and replaced, so set prices carefully. A tier can grant access to a private repository, and can show a welcome message.
- [ ] Optional: set a sponsorship goal ([About GitHub Sponsors for open source contributors](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/about-github-sponsors-for-open-source-contributors)).
- [ ] Dashboard > **Request approval**. "It may take a few days"; the profile goes live automatically once approved.
- [ ] Only then add `FUNDING.yml` and the README section (section 3), so the button never points at a profile that is not live.

---

## 2. Sponsors profile text

### Short bio (one line)
> UK-based developer building Lowerbeam, a Linux harness for running local models and coding agents on small GPUs.

### Introduction
> I build [Lowerbeam](https://github.com/giobuilds/lowerbeam), an MIT-licensed desktop app for llama.cpp that is becoming a harness for local models on small GPUs, the 8 GB kind most people actually own.
>
> It owns the llama-server process, plans VRAM before launch (the KV cache figure matches llama.cpp to the byte; the rest is calibrated to within about 1% on the machines I have checked), estimates fit and speed from measured memory bandwidth before you download a model, keeps context frugal, and runs a coding mode where the model reads through a checked boundary, edits a copy you review, and runs tests in a bubblewrap box with no network.
>
> Most of the work is measurement. The Stage 0 results document records every matrix I have run on an RX 6600, including the ones that turned out to be invalid. Sponsorship pays for time to keep doing that: more models, more task families, and honest write-ups of what does and does not work on small cards.
>
> Lowerbeam stays MIT and free. Sponsoring does not buy features or support guarantees; it says "keep going".

### Monthly tiers (USD)

| Tier | Price | What you get |
|---|---|---|
| **Low beam** | $3 / month | My thanks, and your name in the README's Sponsors list if you want it there (opt-in). |
| **Lab notes** | $7 / month | The above, plus access to a private `lowerbeam-notes` repository where I post rough notes on experiments before they are written up: matrices in progress, dead ends, numbers that may not survive replication. Posted when there is something to say, not on a schedule. |
| **Pick the next measurement** | $15 / month | Everything above, plus a vote when I choose which model profiles or quantisations to run through the harness next. I post a shortlist in the notes repo; sponsors at this tier pick. |
| **Main beam** | $40 / month | Everything above, plus your name or your company's name with a link in the README's Sponsors section, and a thank-you in release notes. |

Suggested one-time tiers: **$5** and **$25** ("a coffee" / "a matrix's worth of electricity"), both with an opt-in name in the README.

Welcome message for the $7+ tiers (shown after payment):
> Thank you. You now have read access to giobuilds/lowerbeam-notes. Notes appear when an experiment has something to report; watch the repo for releases or new files. If you would rather not be listed in the README, reply and say so.

Why these perks: each one is either a list entry or something produced anyway (notes from experiments already being run, a shortlist already being made). None promises response times, calls or private builds. If a perk starts to feel like a job, retire the tier.

### Roughly how many sponsors reach £100 a month
Mid-market rate on 7 Oct 2026 was about £1 = $1.325 (xe.com), so £100 is about **$133**. Allow for Stripe's conversion and aim for about **$140 a month**.

| Mix | Monthly USD | Approx. GBP before conversion costs |
|---|---|---|
| 45 sponsors at $3 | $135 | £102 |
| 20 sponsors at $7 | $140 | £106 |
| 8 at $3, 5 at $7, 3 at $15, 1 at $40 (17 sponsors) | $144 | £109 |

Realistically that is **roughly 15 to 25 sponsors**, more if most choose $3. Exchange-rate moves of a few per cent shift these numbers.

---

## 3. FUNDING.yml and README section

### `.github/FUNDING.yml`
```yaml
github: giobuilds
```
Syntax per [Displaying a sponsor button in your repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository). It must be on the default branch, and the Sponsor button also needs **Settings > General > Features > Sponsorships** ticked. Add it after the profile is approved. Per the repo's own process, this change would need a CHANGELOG line under Unreleased only if you count it as user-facing; it probably is not.

### README section (suggested place: after "Licence", or after "Design notes")
```markdown
## Support Lowerbeam

Lowerbeam is MIT licensed and will stay free. Most of the work on it is
measurement: running local models through the same tasks, on an 8 GB card,
and writing down what happened, including the runs that went wrong (see
[Stage 0 results](docs/stage0-results.md)).

If it is useful to you, [sponsoring me on GitHub](https://github.com/sponsors/giobuilds)
pays for time to keep doing that. Reports of how it behaves on your own
hardware help just as much: open an issue with your GPU, model and what
the planner said.

### Sponsors

Thank you to everyone listed here. (Names appear with permission.)
```

---

## 4. Long-form post draft

Word count about 1,300. Plain British English, no em dashes. Rewrite in your own voice before publishing (see the note at the top), particularly if you later submit it to HN.

---

# What running a coding agent on an 8 GB GPU actually takes

I have an AMD RX 6600. It has 8,176 MiB of VRAM, and about 720 MiB of that is in use before I load anything. For the last few months I have been building Lowerbeam, a Linux desktop app that started as a control panel for llama.cpp and is turning into a harness for running local models, coding agents included, on cards like this one. This post is what I measured along the way, including what still does not work.

## Measure first, then check the measurement

Before writing much of the coding mode I built a test harness. It has read-only tasks (find or explain code), write tasks (fix a planted bug, rename across files), and recover tasks, where the model must run a failing test suite to learn what is wrong. Every run gets a fresh copy of the repository, and some tasks plant an instruction to read a canary file outside the project.

The first matrix of 90 runs looked plausible. Then I checked which files each run had read. 21 of the 90 had opened the file that defines the tasks, expected answers included, because the harness had been committed before the matrix ran. The smallest model's quickest wins on one task were it reading the answer key. Later I found the results document itself was in the corpus too: one run's first search hit was the sentence describing the bug it had been sent to find. The lesson: the harness is code too, and "every run passed" deserves the same suspicion as "every run failed".

## The model that works is the middle one

Three models on the clean read-only run, ten tasks, three runs each:

- Ornith-1.5-9B (Q4_K_M, dense): 29 of 30, median 34 seconds.
- Qwen3-Coder-30B-A3B (TQ1_0, experts in system RAM): 18 of 30, median 70 seconds.
- Gemma-4-E4B (Q6_K_P): 10 of 30, and only 2 of 18 on the "locate" tasks.

The bigger models fail for different reasons. The 30B mixture-of-experts model is fine for chat with its experts in system RAM, but an agent loop calls the model many times per task and paging experts back in costs it each time. On write tasks in a small window, 8 of its 12 runs were killed at the six-minute budget. A one-bit quantisation of a dense 27B fits on the GPU and is quick, but it passed none of the same 12 tasks and never made an edit. On this card a larger model was either too slow or too damaged, and the 9B was the only one of the three that could actually work.

On write tasks the 9B is less impressive. With the loop's round cap at 12 it completed 18 of 30 small-fix and cross-file runs. With the cap lifted to 40 it completed 22 of 30, at the cost of one unwanted change and a slower median run.

## Where the memory goes

The 9B's weights are 5.8 GB and its compute buffers a few hundred megabytes. The KV cache is the part your launch flags decide, and where things go wrong. Launch with a context of 0 and llama.cpp uses the trained length, 262,144 tokens for this model. On my card that meant the cache spilled, prompt speed fell from 467 tokens a second to 66, and the driver gave up.

Lowerbeam plans this before launch. The KV cache figure is plain arithmetic and reproduces llama.cpp's own reported size to the byte. Weights, compute and backend reserve are calibrated against measured launches and land within about 1% on the machines I have checked. Getting there meant being wrong first. The 9B is a hybrid: only one block in four is full attention, and the rest keep a fixed state that does not grow with context. My planner first counted a cache in every block and estimated 2.1 GiB at 16,384 tokens. The right figure is 512 MiB. Measured on the card, VRAM rises by 33 KB per token of context against the 32 KB the model file predicts, and speed does not move between 4,096 and 65,536 tokens: about 550 tokens a second for prompts and 36 for generation, because nothing spills.

The useful finding is how little context coding needs. Across every 9B run, no task needed more than 16,384 tokens, and that costs about half a gigabyte. The app now shows that figure under the context field.

## Context is the real budget

On a small card you pay for every token twice: in memory, and in prompt time on every round.

Web pages are the clearest example. One page of raw HTML is about 14,000 tokens on this setup. The same page as text is about 1,300, and a search extract about 380. The model gets the extract first, and the text only when the extract was not enough. Each enabled tool adds roughly 50 tokens to every message, so tools are switched on one at a time and the running cost is shown.

Code is the hard case. A read returns up to 200 lines, which is 2,000 to 3,000 tokens of TypeScript, so a 6,144-token window cannot hold two files at once whatever the policy. In tests with a deliberately small window, older tool results are folded first, and then the conversation is compacted into notes computed from the run's journal: files read, searches, changes, commands and their exit codes. No model writes them, so every claim can be checked. Across 120 small-window runs, the record held every time. Task completion did not: it swung between 0 and 6 of 12 per matrix in nine of ten matrices, and none of my changes to context handling moved it outside that.

## What does not work yet

In the small-window write tests, about four runs in ten never edit anything. The model reads the file with the bug on screen and keeps reading. When the bug is a wrong constant, such as a threshold of 6 where 0.6 was meant, the 9B does not see it as wrong, and no prompt sentence I tried changed that. One thing did help: a single reminder, generated from the record, for a run that has used half its rounds without an edit. Those runs went from passing 18% of the time to 62%. That is only 13 runs, and the matrix totals did not replicate, so it is promising rather than settled.

Other limits worth saying plainly: the task set was written by one person on one codebase, a twelve-run matrix cannot detect a change worth one or two runs, Lowerbeam is Linux only, and the run mode's bubblewrap sandbox is a second layer, not a VM. The kernel is shared.

## The tool boundary matters more than the loop

I also ran two existing engines, Pi and OpenCode, on the same tasks with the same model. Both completed three more write runs than my loop, which is inside its own run-to-run spread. But given a symlink inside the project pointing at the canary, Pi read it in all three runs and OpenCode in two of three, because its boundary checks the path as written rather than where the link goes. Running Pi's loop on Lowerbeam's tools instead took leaks from 5 of 9 to none. The tools made the difference, which is why Lowerbeam keeps ownership of its tool broker and, for now, its own loop.

## If you want to try it

Lowerbeam is MIT licensed, with an AppImage and an RPM for Linux: https://github.com/giobuilds/lowerbeam. The full numbers, mistakes included, are in `docs/stage0-results.md`. I would especially like to hear how the planner does on other cards. And if it is useful to you and you would like to help me keep measuring, there is a GitHub Sponsors page at https://github.com/sponsors/giobuilds.

---

### Fact sheet behind the post (for checking your rewrite)

| Claim | Source |
|---|---|
| RX 6600, 8,176 MiB, ~720 MiB in use before launch | stage0-results.md, "Memory" |
| 21 of 90 runs read `tasks.ts` | "The first matrix was invalid" |
| Results doc in corpus; first hit on line 176 | "Addendum: this document was in the corpus" |
| 29/30, 18/30, 10/30; medians 34s, 70s; Gemma locate 2/18 | "Results" summary table |
| 30B: 8 of 12 killed at budget; 27B IQ1_S 0/12, never edited, tool calls as text | "The same family on a larger model" |
| 18/30 at cap 12, 22/30 at cap 40, 1 unwanted change, app keeps 12 | "The reference with its round cap lifted"; README |
| 5.8 GB weights; context 0 = 262,144; 467 to 66 t/s | "Memory" |
| KV to the byte; others within about 1% | README "About the estimates" (0.10.0 changelog: four models within 0.4%) |
| 2.1 GiB vs 512 MiB; 33 KB vs 32 KB/token; ~550 / 36 t/s | "Memory" |
| No task over 16,384; about half a gigabyte | "Memory" |
| 14,000 / 1,300 / 380 tokens; ~50 tokens per tool | README "Web access" |
| 200 lines = 2,000 to 3,000 tokens; two fill 6,144 | "Folding was aimed at the wrong thing" |
| Record held in 120 runs; 0 to 6 of 12 spread | "Crossover family" |
| ~4 in 10 never edit; 18% to 62% on 13 runs | "What the family can and cannot resolve"; "Told once that nothing has changed" |
| Engines +3 write runs; Pi symlink 3/3, OpenCode 2/3; Pi on Lowerbeam tools 5/9 to 0 | "Engine comparison"; "Pi's loop on Lowerbeam's tools" |

---

## 5. r/LocalLLaMA post and Show HN

### r/LocalLLaMA norms (checked 7 Oct 2026)
The sidebar rules, as quoted by a rules index read on 5 Oct 2026 ([threadfox.vip/rules/localllama](https://threadfox.vip/rules/localllama); Reddit itself blocked my fetch):
- **Rule 4, Limit Self-Promotion:** "The 1/10th rule is a good guideline: self-promotion should not be more than 10% of your content. Affiliation must be disclosed: No engagement farming, No 'I found this..'". A moderator has said this counts posts and comments.
- **Rule 3, Low Effort:** "Completely/primarily LLM generated copy, code is not allowed" (exception: non-native speakers using an LLM to translate, with disclosure).
- **Minimum karma requirements** were added in a recent rules update ([mod post](https://www.reddit.com/r/LocalLLaMA/comments/1su3ao4/rlocalllama_rule_updates/)); the exact thresholds are not public in what I could read. One user reported needing to "minimally engage for 5 comments to make a post". Posts from low-karma accounts may be removed by AutoModerator silently.

**Advice:**
1. Spend a week or two commenting usefully (VRAM questions on 8 GB cards are a natural fit; answer with numbers, no links) so your account clears the karma bar and the 1-in-10 ratio.
2. Post as a text post with the numbers in the body, not a bare link. Say plainly "I built this".
3. Rewrite the draft below yourself. Use it for structure and facts only.
4. Do not mention Sponsors in the Reddit post. The repo link is enough; the Sponsor button is on the repo.
5. Stay in the thread for the first few hours and answer questions, especially sceptical ones.

### Draft (about 320 words; reference only, rewrite before posting)

**Title:** What a 9B coding agent needs on an 8 GB card (RX 6600): my measurements, including the ones I got wrong

> Disclosure: I build Lowerbeam, the open-source (MIT) Linux app these numbers come from.
>
> I have been running local models through a small coding-task harness on an RX 6600 (8 GB). Some things I did not expect:
>
> **The middle model wins.** Read-only tasks (find code, explain code), 30 runs each: Ornith-1.5-9B Q4_K_M 29/30, Qwen3-Coder-30B-A3B TQ1_0 with experts on CPU 18/30, Gemma-4-E4B 10/30. On write tasks in a small window the 30B hit the six-minute budget in 8 of 12 runs, and a 27B dense at IQ1_S fitted on the GPU but never made an edit.
>
> **Coding needs less context than you think.** No 9B task needed more than 16,384 tokens, which costs about 512 MiB of KV cache on that model because only one block in four is full attention. Launching at context 0 (the trained 262,144) spilled and dropped prompt speed from 467 to 66 t/s. At 4k to 64k it stays at about 550 t/s prompt, 36 t/s generation.
>
> **Web pages are expensive.** One page: raw HTML about 14,000 tokens, text about 1,300, search extract about 380.
>
> **Write tasks are the weak spot.** 18/30 with a 12-round cap, 22/30 with 40. About four in ten small-window runs never edit anything. A wrong constant on screen (6 instead of 0.6) is invisible to the 9B.
>
> **Symlinks.** With a symlink in the project pointing at a canary file, Pi read it 3/3 and OpenCode 2/3. Pi's loop on a tool layer that resolves links: 0 leaks.
>
> **My own first matrix was invalid:** 21 of 90 runs had read the file containing the answers.
>
> Full write-up with every table: docs/stage0-results.md in https://github.com/giobuilds/lowerbeam
>
> I would like numbers from other 8 GB cards, NVIDIA especially. What context are you running coding models at?

### Show HN

Show HN fit: Lowerbeam qualifies (something people can run; you made it; "early stage" is fine). The guidelines say blog posts are not Show HNs, point releases "generally aren't substantive enough", and don't ask friends to upvote. Link the **repo** (or the releases page), not the article. If you want the article on HN, submit it separately as a normal story on a different day. ([Show HN guidelines](https://news.ycombinator.com/showhn.html), [HN guidelines](https://news.ycombinator.com/newsguidelines.html))

**Title options** (HN discourages hype words; keep under 80 characters):
1. `Show HN: Lowerbeam, a llama.cpp harness for coding agents on 8 GB GPUs`
2. `Show HN: Lowerbeam: plan VRAM and run a sandboxed local coding agent on Linux`

**First comment: notes, not prose.** HN's guidelines ask for no generated or AI-edited text, so write this yourself from these points, in this order, in about 150 to 250 words:
- Who you are and why: you own an 8 GB card; llama.cpp's flags (`-ngl`, `-c`, KV type) decide whether a model runs, and the built-in UI cannot change them.
- What it is now: owns llama-server; VRAM planner (KV to the byte, the rest within about 1%); fit and speed before download from measured bandwidth; context accounting; coding mode with read/search/list, edits in a copy, Changes panel with conflict-checked apply and undo, run mode in bubblewrap with no network.
- One or two numbers that surprised you: the 9B at 29/30 read-only while the 30B MoE was too slow for a loop; no task needing more than 16,384 tokens.
- The honest limit: write tasks 18/30 at the default cap; wrong-constant bugs; Linux only; the sandbox is not a VM.
- The symlink finding, briefly, and that the harness and results are in the repo so people can check them.
- What feedback you want: planner accuracy on other cards, NVIDIA in particular.
- Leave Sponsors out of the first comment, or at most one line at the end if someone asks how to support it.

---

## 6. Four-week plan and follow-up posts

### Plan

| Week | Do | Don't |
|---|---|---|
| **1 (this week)** | Enable 2FA, apply to Sponsors, submit Stripe and W-8BEN (approval "may take a few days"). Rewrite and publish the long-form post on your own site or blog. Start commenting helpfully on r/LocalLLaMA (VRAM and 8 GB questions). | Don't add FUNDING.yml until the profile is live. |
| **2** | Once approved: merge FUNDING.yml and the README section via a normal PR. Post the r/LocalLLaMA text post (weekday morning US Eastern is typical; that is early afternoon in London). Stay in the thread. | Don't cross-post the same text to several subreddits on the same day. |
| **3** | Show HN on a weekday, linking the repo; first comment written by you. Publish follow-up post 1. | Don't ask anyone to upvote. Don't post on HN and Reddit the same day. |
| **4** | Publish follow-up post 2. Write a short "what I learned from posting" note in the Lab notes repo if anyone has sponsored. Review: stars, issues from new users, sponsors. | Don't change tier prices yet (published prices cannot be edited, only retired). |

### Follow-up post ideas (all from repo material)
1. **"My first benchmark matrix was invalid, and so was the second"**: the 21 of 90 runs that read `tasks.ts`; the results document leaking into the corpus (the line-176 search hit); the 442-run replay with 0 disagreements; re-running the 9B with the document excluded (still 29/30). A post about measurement hygiene that anyone running evals will recognise. Source: stage0-results.md, "The first matrix was invalid" and the two addenda.
2. **"Who owns the tool broker? Pi, OpenCode and a symlink"**: the engine comparison (OpenCode 26 of 30 write runs hitting the budget, same edit up to 53 times; Pi overwriting the test runner; symlink leaks), then Pi on Lowerbeam's tools going to 0 leaks and 0 unwanted changes. Be fair to both projects: as-shipped settings, adjustments listed, versions Pi 0.73.1 and OpenCode 1.18.21, run 24 to 25 Sept. Source: "Engine comparison", "Pi's loop on Lowerbeam's tools".
3. **"The VRAM planner was wrong by four"**: hybrid attention (`full_attention_interval`, `nextn_predict_layers`), 2.1 GiB vs 512 MiB, 33 KB vs 32 KB per token, ~72,000 tokens the most that fits at f16; plus the 0.10.0 fix where reading exact tensor sizes moved Gemma-4-E4B from 45% over and Qwen2.5-VL-3B from 10% under to within 0.4%. Source: "Memory" section; CHANGELOG 0.10.0.
4. **"Analysis without action: when a small model reads the bug and does not fix it"**: the never-edit tax, wrong-constant bugs, the prompt sentence that changed the failure's shape but not the result, and the mid-run reminder (18% to 62% on 13 runs, totals not replicated). Source: "Write families", "Told once that nothing has changed".
5. (Spare) **"Summaries a small model cannot get wrong"**: structured compaction: the 9B vs Qwen3-0.6B summary comparison (22.7s vs 5.5s, specifics kept vs lost), notes computed from the journal, GBNF-constrained extraction as the next step. Source: structured-compaction.md, direction.md.

### Realistic expectations
- **Sponsorship follows audience, slowly.** Most projects get their first sponsor from someone who already uses the tool. Expect zero to a handful of sponsors in the first month even if a post does well; £100 a month is more likely a several-month target than a four-week one.
- **The first payout arrives about 60 days after the first sponsorship**, then monthly on the 22nd.
- **Measure what you can control:** posts published, useful comments, new issues from people on other hardware, stars. A Reddit or HN post that brings two good bug reports from NVIDIA users is a success even with no sponsors.
- **The numbers are the brand.** The Stage 0 document's habit of reporting its own mistakes is the most distinctive thing you have; keep every public claim traceable to it.
- **Linux only limits the audience.** That is a deliberate choice (the plan lists it as a non-goal until there is a validated sandbox per platform); say so up front so Windows and macOS readers are not disappointed.

---

## Notes for you
- The brief's "29/30 read-only" figure is at the default 12-round cap; at the 40-round cap read-only was 30/30 (18/18 and 12/12). The 22/30 write figure is at cap 40; at the app's default cap 12 it is 18/30. The drafts use both, labelled.
- On the symlink: Pi read the canary in 3 of 3 symlink runs (5 of 9 authority runs overall), OpenCode in 2 of 3. The brief mentioned only OpenCode.
- 0.11.1 also shipped, on 4 Oct 2026 (security fixes to run mode and the reading pane), after 0.10.0 and 0.11.0 on 2 Oct.
- README says estimates are within "about 1%"; the 0.10.0 changelog says the four models checked are within 0.4%. The drafts use the README's more conservative figure.
