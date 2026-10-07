# Lowerbeam telemetry design (draft)

Based on main at b740e95 (v0.11.1 plus #126 "Measure this model" and #127). Status: proposal. Nothing here is built.

> **Legal points in this document are guidance, not legal advice.** They draw on ICO pages cited in section 7. Get a qualified review before shipping Tier B.

## 1. Goals and principles

- **Goal:** learn what actually runs on which GPUs, so the VRAM planner (`src/main/planner.ts`, `VramPlanView`), the speed estimate (`src/main/speed.ts`, `SpeedEstimate`) and the capability record (`src/shared/capability.ts`) can be calibrated across more machines than the developer's own.
- **Off by default.** Nothing is collected, queued or sent until the person turns it on. This holds even for data that may count as anonymous.
- **Two tiers, separate switches.**
  - Tier A is background, coarse and numeric only.
  - Tier B is sent only when the person presses Send on one item after seeing a preview.
- **No stable identity.** There is no install ID. The only identifier is an optional rotating batch ID, and it never repeats across batches.
- **Coarse by construction.** Values are bucketed on the device before they are queued. The queue never holds raw values, so a leak of the queue leaks nothing finer than what would be sent.
- **Local first.** Every report can be viewed, exported and deleted before it is sent.

## 2. What is never collected (both tiers)

- Prompts, model output, conversation titles and system prompts.
- File names, file contents and project paths (`CodingRunSummary.projectRoot`, `task` and `answer` are excluded).
- Command text and command output (`*.cmd-N.txt`).
- Model file paths and file names. Models are identified only by an allow-listed public identity (section 3.3).
- `sha256` of private models. A hash is sent only when it matches a model in the public catalogue.
- Hostnames, usernames, IP addresses (stripped at the edge), the MAC address and GPU serials.
- Exact free memory (`GpuDevice.freeMiB`) and exact RAM.
- Settings values: the API key, the SearXNG URL, MCP server commands and their environments, and `GrantTerms.alsoRead` paths.
- Timestamps finer than one day. There is no time of day and no time zone.
- Locale, language, screen size and fonts.

## 3. Tier A: background telemetry (opt-in, default off)

### 3.1 Events and where they come from

| Event | Source in code | Notes |
|---|---|---|
| `fit` | `VramPlanView` (types.ts:268) at launch, plus the outcome of the load step (`HealthStep` 'load', types.ts:320) and the supervisor phase `crashed` (supervisor.ts:255) | Predicted against actual memory use |
| `speed` | `SpeedEstimate.tokensPerSecond` and `placement` (speed.ts:52) against the measured value (`BenchResult.tokensPerSecond`, or `HealthCheckResult.tokensPerSecond`) | One per model, quant and placement per day |
| `context` | Chat: compaction in `src/context/compact.ts` (`COMPACT_AT` 0.75, `PREEMPT_AT` 0.6), plus `cutOff` (`finish_reason === 'length'`, compact.ts:233). Coding: `checkpoint` journal events | Counts only |
| `usage` | `CodingMode` (coding.ts:161), `RunOutcome` (coding.ts:145), `ApplyResult` (coding.ts:218), discard (supervisor.ts `discard`), `denials` | Daily counts |
| `env` | App version, OS family, sandbox probe booleans (`SandboxProbe`, sandbox.ts:28) | Sent once per batch |

### 3.2 Batch schema (JSON Schema, draft 2020-12, abridged)

```json
{
  "$id": "https://telemetry.lowerbeam.dev/schema/a/1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "batch", "day", "env", "events"],
  "properties": {
    "schema": { "const": "a/1" },
    "batch":  { "type": "string", "pattern": "^[0-9a-f]{16}$", "description": "Random per batch, never reused, never stored after send" },
    "day":    { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": "UTC date the batch was sealed" },
    "env": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "app":      { "type": "string", "pattern": "^\\d+\\.\\d+$", "description": "major.minor only, e.g. 0.11" },
        "os":       { "enum": ["linux", "other"] },
        "distro":   { "enum": ["fedora", "ubuntu", "debian", "arch", "opensuse", "other"] },
        "package":  { "enum": ["appimage", "rpm", "source"] },
        "llama":    { "type": "string", "pattern": "^b\\d{2}00$", "description": "llama.cpp build rounded down to the hundred, from BinaryInfo.version, e.g. b10800" },
        "binary":   { "enum": ["llama-server", "unified"] },
        "backend":  { "enum": ["cuda", "rocm", "vulkan", "metal", "sycl", "cpu", "other"] },
        "gpu":      { "type": "string", "description": "From the public allow-list of GPU model names, e.g. 'RX 7600', else 'other'" },
        "gpuCount": { "enum": [0, 1, 2, "3+"] },
        "vramGiB":  { "enum": [0, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48, "64+"], "description": "Total VRAM rounded down to the bucket" },
        "ramGiB":   { "enum": [8, 16, 32, 64, "128+"] },
        "sandbox":  { "type": "object", "properties": { "ok": {"type":"boolean"}, "userNamespaces": {"type":"boolean"}, "landlock": {"type":"boolean"} } }
      }
    },
    "events": { "type": "array", "maxItems": 200, "items": { "oneOf": [
      { "$ref": "#/$defs/fit" }, { "$ref": "#/$defs/speed" }, { "$ref": "#/$defs/context" }, { "$ref": "#/$defs/usage" } ] } }
  },
  "$defs": {
    "model": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "arch":   { "type": "string", "description": "GGUF general.architecture, allow-listed, e.g. qwen3moe, else 'other'" },
        "paramsB":{ "enum": [1, 2, 4, 8, 14, 24, 32, 70, "100+"], "description": "Total parameters rounded to the bucket" },
        "moe":    { "type": "boolean" },
        "quant":  { "type": "string", "description": "ModelEntryView.quant, allow-listed, e.g. Q4_K_M" },
        "catalogue": { "type": ["string", "null"], "description": "Public repo id only if the file's sha256 is in the published catalogue, else null" }
      }
    },
    "fit": { "type": "object", "properties": {
      "type": { "const": "fit" }, "model": { "$ref": "#/$defs/model" },
      "contextK": { "enum": [2, 4, 8, 16, 32, 64, 128, "256+"], "description": "contextPerSlot in thousands, rounded down" },
      "kvType":   { "enum": ["f16", "q8_0", "q4_0", "other"] },
      "placement":{ "enum": ["gpu", "hybrid-moe", "partial", "cpu", "wont-load"] },
      "offloadPct": { "enum": [0, 25, 50, 75, 100], "description": "offloadedLayers / totalLayers, nearest quarter" },
      "predictedPct": { "type": "integer", "multipleOf": 5, "minimum": 0, "maximum": 150, "description": "VramPlanView.totalMiB / total VRAM, to 5%" },
      "errorPct": { "type": ["integer", "null"], "multipleOf": 5, "minimum": -50, "maximum": 50, "description": "(actual - predicted) / predicted, to 5%; null when not measurable" },
      "result": { "enum": ["ready", "oom", "crashed-load", "crashed-warmup", "crashed-inference", "timeout", "other"] }
    } },
    "speed": { "type": "object", "properties": {
      "type": { "const": "speed" }, "model": { "$ref": "#/$defs/model" },
      "placement": { "enum": ["gpu", "hybrid-moe", "partial", "cpu"] },
      "kind": { "enum": ["prompt", "generation"] },
      "estimatedTps": { "type": ["integer", "null"], "description": "Rounded to 2 significant figures" },
      "measuredTps":  { "type": "integer", "description": "Rounded to 2 significant figures" },
      "source": { "enum": ["bench", "health", "chat"] }
    } },
    "context": { "type": "object", "properties": {
      "type": { "const": "context" }, "surface": { "enum": ["chat", "coding"] },
      "contextK": { "enum": [2, 4, 8, 16, 32, 64, 128, "256+"] },
      "turns":       { "enum": ["0", "1-5", "6-20", "21-100", "100+"] },
      "compactions": { "enum": ["0", "1", "2-5", "6+"] },
      "cutOffs":     { "enum": ["0", "1", "2-5", "6+"] }
    } },
    "usage": { "type": "object", "properties": {
      "type": { "const": "usage" },
      "runs": { "type": "object", "properties": { "inspect": {"$ref":"#/$defs/count"}, "edit": {"$ref":"#/$defs/count"}, "run": {"$ref":"#/$defs/count"} } },
      "outcomes": { "type": "object", "propertyNames": { "enum": ["answered", "rounds", "timeout", "cancelled", "error"] }, "additionalProperties": {"$ref":"#/$defs/count"} },
      "applied": {"$ref":"#/$defs/count"}, "discarded": {"$ref":"#/$defs/count"}, "withConflicts": {"$ref":"#/$defs/count"}, "undone": {"$ref":"#/$defs/count"},
      "features": { "type": "object", "propertyNames": { "enum": ["chat", "reader", "webSearch", "mcp", "localApi", "router", "structuredOutput", "measure", "download"] }, "additionalProperties": {"$ref":"#/$defs/count"} }
    } },
    "count": { "enum": ["0", "1", "2-5", "6-20", "21+"] }
  }
}
```

### 3.3 Rules that keep it coarse

- The allow-lists for GPU names, architectures and quants are published with the schema. Anything not on them becomes `other`.
- A day's `fit` and `speed` events are de-duplicated on (model, placement, contextK, kind). Only the median is kept.
- A batch is dropped locally, not sent, if its `env` combination is rare. The client cannot know global rarity, so the server-side threshold in 6.3 does the real work. The client only drops `gpu: other` combined with an exotic `gpuCount`.

### 3.4 Gaps in today's code that Tier A depends on

- **There is no crash category.** `describeCrash` (supervisor.ts:270) returns English text with only SIGSEGV and warmup heuristics, and `health.ts:165` is the same. OOM is not detected (no `out of memory` or `cudaMalloc` match anywhere in `src/main`). Step 1 of the plan adds `CrashCause = 'oom' | 'warmup-segv' | 'inference-segv' | 'bad-flag' | 'model-format' | 'exit' | 'unknown'`, so `fit.result` never needs log text.
- **The actual VRAM in use is not recorded** after load. Only `freeMiB` before launch is known (`GpuDevice`). Proposal: read the `--list-devices` free value again after `ready`, or the memory llama-server reports, and store only the difference as `errorPct`.
- **Apply and undo are not journaled** (supervisor.ts:475-498, `appliedAt` is in memory only). The `applied` and `undone` counts need batch-3 issue 6.

## 4. Tier B: user-submitted contributions (one press of Send each)

Each submission is its own document. It is built locally and shown in full. Nothing is sent without pressing Send on that exact text.

```json
{
  "$id": "https://telemetry.lowerbeam.dev/schema/b/1",
  "type": "object", "additionalProperties": false,
  "required": ["schema", "kind", "day", "env"],
  "properties": {
    "schema": { "const": "b/1" },
    "kind":   { "enum": ["measure", "crash", "sandbox", "update", "feedback"] },
    "day":    { "type": "string", "format": "date" },
    "env":    { "$ref": "a/1#/properties/env" },
    "measure": {
      "type": "object", "additionalProperties": false,
      "description": "From MeasureProgress / ModelCapability.indicative (capability.ts:88-115, measure.ts)",
      "properties": {
        "corpus": { "const": "ledgerline 1" },
        "model":  { "$ref": "a/1#/$defs/model" },
        "contextK": { "enum": [2, 4, 8, 16, 32, 64, 128, "256+"] },
        "launch": { "type": "array", "items": { "type": "string", "enum": ["--flash-attn", "--cpu-moe", "--n-cpu-moe", "-ctk", "-ctv", "-ngl", "-c", "-np", "--jinja"] }, "description": "Flag names only, values dropped except the allow-listed enums below" },
        "kvType": { "enum": ["f16", "q8_0", "q4_0", "other"] },
        "tasks": { "type": "array", "maxItems": 20, "items": { "type": "object", "additionalProperties": false, "properties": {
          "id": { "type": "string", "description": "Shipped task id from MEASURE_TASKS" },
          "family": { "enum": ["locate", "explain", "authority", "small-fix", "recover"] },
          "passed": { "type": "boolean" },
          "rounds": { "type": "integer", "maximum": 50 },
          "seconds": { "type": "integer", "description": "ms/1000 rounded" },
          "peakContextK": { "type": "number", "multipleOf": 0.5 }
        } } },
        "verdicts": { "type": "object", "properties": { "inspect": {"enum":["cleared","refused","unmeasured"]}, "edit": {"enum":["cleared","refused","unmeasured"]}, "run": {"enum":["cleared","refused","unmeasured"]} } }
      }
    },
    "crash": { "type": "object", "properties": {
      "cause": { "enum": ["oom", "warmup-segv", "inference-segv", "bad-flag", "model-format", "exit", "unknown"] },
      "signal": { "enum": ["SIGSEGV", "SIGABRT", "SIGKILL", "SIGBUS", "none", "other"] },
      "exitCode": { "type": ["integer", "null"] },
      "stage": { "enum": ["spawn", "load", "ready", "inference", "stop"] },
      "fit": { "$ref": "a/1#/$defs/fit" },
      "log": { "type": "array", "maxItems": 40, "items": { "type": "string", "maxLength": 300 }, "description": "Sanitised tail of the server log, see 4.1" }
    } },
    "sandbox": { "type": "object", "properties": {
      "ok": {"type":"boolean"}, "bubblewrap": { "type": ["string","null"], "pattern": "^\\d+\\.\\d+$" },
      "userNamespaces": {"type":"boolean"}, "landlock": {"type":"boolean"},
      "reasonCode": { "enum": ["no-bwrap", "userns-disabled", "apparmor-userns", "bwrap-failed", "other"] },
      "toolchain": { "enum": ["install-root", "binary-only", "none", "version-manager"] }
    } },
    "update": { "type": "object", "properties": {
      "phase": { "enum": ["checking", "downloading", "ready"] },
      "from": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" }, "to": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
      "errorCode": { "enum": ["network", "sha512-mismatch", "no-write-permission", "not-appimage", "github-rate-limit", "other"] }
    } },
    "feedback": { "type": "object", "properties": {
      "text": { "type": "string", "maxLength": 2000 },
      "contactEmail": { "type": ["string", "null"], "format": "email", "description": "Only if typed by the person, for a reply" }
    } }
  }
}
```

### 4.1 Sanitising crash logs (on the device, before the preview)

- Take the last 40 lines from `LogBuffer` (stderr and app streams only). The log is already masked for `--api-key` (supervisor.ts:521).
- Keep only lines that match an allow-list of llama.cpp prefixes (`llama_model_load`, `ggml_cuda`, `ggml_vulkan`, `load_tensors`, `llama_kv_cache`, `srv`, `main:`).
- Replace absolute paths with `<path>/basename-category` (for example `<model>.gguf`). Replace `$HOME`, the username, the hostname, IPs, ports, URLs, hex runs of 16 or more characters, and email addresses with placeholders.
- Never include request bodies, prompt text or `srv` lines that echo prompts. Drop any line containing `prompt`, `content` or `messages`.
- The preview marks every replacement so the person can check it. They can also delete any line before sending.

### 4.2 The `update` reason codes

These need `Updater` (updater.ts:49-56) to map `error` events to the enum. At present only the message string is kept in `UpdateState.error`.

## 5. Client behaviour

### 5.1 Consent text

**First run (one screen, after the model picker, never before):**

> **Help make Lowerbeam's estimates better for your hardware?**
>
> Lowerbeam can send coarse, anonymous statistics: your GPU model and VRAM size in steps (for example "8 GB"), your llama.cpp backend, whether models loaded or ran out of memory, and how fast they ran compared with Lowerbeam's estimate. It never sends prompts, chats, file names, file contents, commands, paths or your IP address, and it has no install ID.
>
> Reports wait on this computer for up to 7 days. You can read, export or delete them in Settings, Privacy, and turn this off at any time. Turning it off deletes what has not been sent.
>
> [Not now] [Show me an example] [Send anonymous statistics]

Both buttons have equal weight. "Not now" is the default focus. No box is pre-ticked. Choosing "Not now" does not ask again for 90 days, or ever, if "Don't ask again" is ticked.

**Settings, Privacy:**

> **Anonymous statistics** [off/on]: coarse hardware, fit and speed numbers, sent weekly. [View queue] [Export] [Delete queue]
>
> **Ask before sending reports**: when a model crashes, a measurement finishes, the sandbox is unavailable or an update fails, Lowerbeam offers to send a report. You see every word before anything is sent. [on/off]
>
> Who receives it: Lowerbeam project (controller details in Privacy statement). [Read the privacy statement] [Withdraw and delete everything sent]

### 5.2 Preview UI

- Tier A: Settings, Privacy, View queue lists each batch as formatted JSON with a plain-English line for each field ("GPU: RX 7600, VRAM: 8 GB bucket").
- Tier B: the offer appears inline (for example in the crash banner: "Send a crash report?"). The panel has:
  - a human summary;
  - a "Show exactly what will be sent" view of the JSON, read-only;
  - checkboxes for each optional section (log lines, fit details, contact email);
  - Send and Don't send.
- Nothing is queued until Send is pressed. "Don't send" discards the draft.

### 5.3 Queueing and sending

- Queue file: `userData/telemetry/queue.jsonl`, 0600 in a 0700 folder (depends on batch-3 issue 1).
- Caps:
  - Tier A: one batch per day, 32 KB per batch, 7 batches. The oldest is dropped.
  - Tier B: 64 KB per item, 10 items.
- Schedule:
  - Tier A batches are sealed at local midnight and sent weekly at a random moment in the session, with jitter so the send time is not a fingerprint.
  - Tier B is sent at once on Send, with a retry for 24 hours.
- Transport:
  - `POST https://telemetry.lowerbeam.dev/v1/a` or `/v1/b` over HTTPS with TLS 1.2 or later, using Electron `net` and the system proxy.
  - No cookies, no `User-Agent` beyond `Lowerbeam/0.11`, and the Electron/Chromium version is stripped from the header.
  - The body is gzip JSON.
  - Retries use backoff, up to 3 attempts.
- Strings are validated against the same schema locally before queueing and again at the server, which rejects anything with unknown fields.
- Off means off: no network request is made, not even a "consent declined" ping.

### 5.4 User controls

- View, Export (one JSON file to a place the person chooses) and Delete queue.
- A sent-history log keeps the day, kind and size of each report, with no content, for 90 days, so the person can see what left the machine.
- Withdraw consent: switches both tiers off and deletes the queue. For Tier B, the person can ask for deletion of sent reports (see 7.6). Each Tier B submission shows a one-off receipt code the person can keep. This is the only way to find a report again, because the server holds no identity.

## 6. Server side

### 6.1 Endpoint

- A single small service, for example a Cloudflare Worker or a Fly or Hetzner VM, with about 150 lines of code.
- It validates against the schema, rejects bodies over 64 KB and writes to a store.
- **IP addresses:** the edge does not log them. Turn access logging off. If a rate limit is needed, use a per-IP token bucket held in memory for 60 seconds and never persisted. Drop `CF-Connecting-IP` and `X-Forwarded-For` before the handler.
- No accounts and no cookies.

### 6.2 Storage and retention

| Data | Retention |
|---|---|
| Tier A raw batches | 30 days, then only daily aggregates are kept and the raw rows are deleted |
| Tier A aggregates | Indefinite (they are not personal data if 6.3 holds) |
| Tier B measure | 12 months raw. The aggregated capability rows are kept |
| Tier B crash, sandbox, update | 6 months |
| Tier B feedback | 6 months, or until the reply thread ends. Contact emails are deleted 30 days after the last reply |

### 6.3 Aggregation and publication

- Public table: `docs/hardware-table.md`, or a JSON on the site, rebuilt weekly.
- Rows are (gpu, vramGiB, backend, model.catalogue or arch+paramsB, quant, contextK, placement). The columns are:
  - load success rate;
  - OOM rate;
  - the median `errorPct` of predicted VRAM;
  - median measured tok/s;
  - measured/estimated speed ratio;
  - for Tier B, the measure pass rate for each family.
- **k-anonymity:** a row is published only if it rests on reports from at least **k = 10** distinct batches across at least **5** distinct days. Otherwise it is merged up a level:
  - the GPU becomes "8 GB class";
  - the quant becomes the quant family;
  - the context becomes coarser.
  - If the row is still too small, it is suppressed.
- Medians and rates only, never minima, maxima or lists.
- Counts are rounded to the nearest 5.
- Optional later step: add Laplace noise (epsilon about 1) to counts of rows near the threshold.
- Tier B free text and logs are never published. Measure results are published only through the aggregated table.

## 7. UK and EU data protection (guidance, not legal advice)

### 7.1 Is it personal data?

- **Tier A** is designed to be anonymous: no identifier, coarse buckets, IP never stored, and raw rows deleted after aggregation. The ICO treats data as anonymous only when the risk of identifying someone is "sufficiently remote", taking account of the means reasonably likely to be used. Rare hardware (a dual 48 GB card setup on openSUSE) can single someone out. That is why the buckets exist and why the raw-row retention is short. Treat raw Tier A batches as **pseudonymous at best while they are held**. Pseudonymised data is still personal data, and the ICO says so explicitly. Only the published aggregates aim to be anonymous.
- **Tier B is likely personal data.** Free-text feedback, contact emails and even sanitised crash logs can identify a person (a username left in a path, a distinctive project name). So can a detailed environment combined with a date. Plan on the basis that it is personal data.

### 7.2 Lawful basis

- **Tier B: consent** (UK GDPR Art. 6(1)(a)). The consent is specific (one press per report), informed (the preview) and freely given (the app works fully without it), and it can be withdrawn.
- **Tier A:** use consent as well. Legitimate interests might be argued for anonymous statistics. But consent is what PECR needs anyway (7.3), and having one model for both tiers is simpler and more honest.

### 7.3 PECR (storage and access on the device)

- PECR regulation 6 covers storing or reading information on a user's device. It applies to apps as well as websites, and to the queue file and to reading GPU and OS details for sending. It applies even when the data is not personal.
- After the Data (Use and Access) Act 2025 there is a **"statistical purposes" exception**. It allows analytics without consent, provided there is clear information and a simple, free way to object. Tier A might fit it.
- This design still uses opt-in consent, for three reasons:
  - it is the project's direction (privacy-first);
  - the exception does not cover the EU, where the ePrivacy Directive Art. 5(3) still needs consent;
  - the exception is narrow and does not cover the diagnostic Tier B.
- Consent must be a clear positive action, with no pre-ticked boxes and nothing collected before it is given.

### 7.4 Controller, processor, transfers

- **Controller:** the person or entity who decides why and how the data is processed. At present that is the maintainer, Giovanni Dick (LICENSE). Name them and give a contact address in the privacy statement.
- Check whether the ICO data protection fee applies. Small, non-commercial projects may be exempt; check the ICO self-assessment.
- **Processor:** a hosting provider (Cloudflare, Fly, Hetzner) is a processor and needs an Art. 28 data processing agreement. These are usually part of the standard terms. Prefer UK or EU hosting (Hetzner DE or FI, or Cloudflare with EU data localisation) to avoid restricted transfers.
- If a US processor is used, the transfer needs:
  - the UK Extension to the EU-US Data Privacy Framework (the provider must be certified), or the IDTA or Addendum;
  - for EU users, the EU-US DPF or SCCs.
- **EU users and a UK controller:** an EU representative under Art. 27 EU GDPR may be required when EU people are targeted or monitored regularly. Opt-in diagnostics from an open-source app are arguably "occasional", but confirm this.

### 7.5 DPIA

- A DPIA is recommended before Tier B ships. It may not be strictly required, but it covers the novel aspects (crash logs from personal machines, free text, and possible special-category data typed into feedback by mistake), and it documents the anonymisation reasoning for Tier A.
- The ICO provides a DPIA template.

### 7.6 Rights

- **Withdrawing consent** must be as easy as giving it: one switch in Settings (5.4). Withdrawal stops future processing. It does not make past processing unlawful.
- Access and erasure for Tier B: because no identity is held, the receipt code (5.4) lets the person point to their reports. Without it, Art. 11 UK GDPR applies: processing that does not require identification. Explain this in the notice.
- Tell people they can complain to the ICO (UK) or their EU supervisory authority.

### 7.7 ICO sources (checked 7 Oct 2026)

- Anonymisation guidance: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/about-this-guidance/
- Pseudonymisation (still personal data; keep the extra information separate): https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/pseudonymisation/ (the ICO notes it is under review after the DUAA)
- PECR rules on storage and access: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-pecr-rules/
- PECR exceptions, including statistical purposes: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/
- Storage and access guidance hub (finalised 29 April 2026): https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies
- Consent, DPIAs, international transfers and controllers and processors: see the ICO's UK GDPR guidance index at https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/ (exact sub-page URLs not re-checked).

## 8. Implementation plan (small PRs)

1. **Crash cause enum.** Add `CrashCause` and classify OOM, warmup SIGSEGV, inference SIGSEGV, bad flag and format errors in `describeCrash` and `health.ts`. Show it in the UI with tests. This is useful even without telemetry.
2. **Update error codes.** Map `autoUpdater` errors to the enum in 4.2 and keep the text for the UI.
3. **Journal apply and undo** (batch-3 issue 6). Required for the usage counts.
4. **Post-load VRAM reading.** Record the actual-against-predicted difference locally on the profile, with no sending.
5. **Schema package.** Add `src/shared/telemetry.ts` with the zod schemas for a/1 and b/1, the allow-lists and the bucketing functions, plus property tests that no raw value survives bucketing.
6. **Local collector, disabled.** Add `src/main/telemetry/collector.ts` to subscribe to supervisor, coding and compaction events and build daily batches in memory. It writes nothing while consent is off. Add a test that it is a no-op when off.
7. **Queue and file modes.** Write `queue.jsonl` with 0600 and 0700, the caps and expiry. This depends on batch-3 issue 1.
8. **Settings, Privacy panel.** Switches, View, Export, Delete queue and the sent history.
9. **First-run consent screen.** With the text from 5.1, equal-weight buttons and no collection before acceptance.
10. **Server endpoint, in a separate repo.** Schema validation, no IP logging, retention jobs, and a staging deploy.
11. **Sender.** Weekly jittered Tier A sending behind a build flag, with the endpoint pinned to a constant (not overridable through the environment in packaged builds).
12. **Tier B offers and preview.** Measure result first, as it is the least sensitive, then sandbox, update and crash (with the 4.1 sanitiser and its tests on fixture logs), then feedback.
13. **Privacy statement, DPIA and controller details.** Must merge before PR 11 ships in a release.
14. **Aggregation job and public hardware table** with the k-thresholds in 6.3.
15. **Withdraw and receipts.** Receipt codes for Tier B, and a deletion endpoint keyed on the receipt.

## 9. Privacy statement wording to add (PRIVACY.md)

> **Telemetry and reports**
>
> Lowerbeam collects nothing unless you turn it on. There are two separate choices.
>
> **Anonymous statistics (off unless you turn it on).** If you agree, Lowerbeam sends a small report about once a week. It contains:
> - your GPU model;
> - VRAM and RAM in rounded steps;
> - your llama.cpp backend and build (rounded);
> - your Linux family;
> - Lowerbeam's major and minor version;
> - for the models you load: architecture, size class, quantisation, context size, whether the model loaded or ran out of memory, how far Lowerbeam's memory and speed estimates were off, and counts of features used.
>
> It contains no prompts, chats, file names, file contents, commands, paths, model file names, exact times or install ID. Our server does not record your IP address. Raw reports are deleted after 30 days. What we keep and publish are combined tables, and a row is only published when at least 10 reports support it.
>
> **Reports you choose to send.** When a model crashes, a measurement finishes, the sandbox cannot start or an update fails, Lowerbeam may offer to send a report. You see exactly what will be sent and can remove parts before pressing Send. Crash reports include a cleaned excerpt of the server log, with paths, names and addresses removed. Feedback includes whatever you type. These reports may be personal data. We process them on the basis of your consent, keep them for up to 6 months (measurement results up to 12 months) and use them only to fix bugs and improve Lowerbeam's estimates.
>
> **Your choices.**
> - You can view, export or delete reports that have not been sent yet in Settings, Privacy.
> - Turning either option off stops sending and deletes what is waiting.
> - To have a report you sent deleted, email us with its receipt code.
> - You can complain to the Information Commissioner's Office (ico.org.uk) or your local data protection authority.
>
> **Who we are.** The controller is [name], [contact email]. Reports are stored with [provider] in [UK/EU region] under a data processing agreement.

## 10. Open questions

- The controller identity and whether the ICO fee applies.
- The hosting provider and region.
- Whether an EU representative is needed.
- Whether Tier A is ever moved to the PECR statistical exception for UK users only. Not recommended: it complicates the model.
- The exact k (10) and day spread (5) depend on the user count. With very few users, the public table should start at the "VRAM class" level, not individual GPU models.
- The `llama` build rounding (to the hundred) may be too coarse for spotting regressions. Rounding to the ten is an option once volume allows.
