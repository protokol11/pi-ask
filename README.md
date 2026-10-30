# ask
npm package: [`@protokol11/pi-ask`](https://www.npmjs.com/package/@protokol11/pi-ask). Source of truth: [agent-governance](https://github.com/protokol11/agent-governance) monorepo.

One `ask` tool for pi: a TUI questionnaire whose selected answers come back as text.

## Table of contents

- [Why](#why)
- [Scope](#scope)
- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Tools](#tools)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Why

An agent that guesses at a requirement writes the wrong code and reports success.
`ask` gives the agent one call that stops and asks, with numbered options and a
free-text fallback, so a preference is recorded as the user stated it instead of
being inferred from the prompt.

The failure mode this extension is built around is a malformed call. A model can
send truncated JSON, `questions: []`, or 40 KB of description. Each of those used
to reach the overlay and leave it spinning or produce an unanswerable question.
Here the argument bounds run before any UI opens: structural overflow (too many
questions or options, an oversize payload) returns an error result, text overflow
is clipped and reported, and a bad call never throws.

## Scope

In scope: one `ask` tool, one to eight questions per call, a tab bar for
multi-question flows, a Submit tab, and per-field clamping with warnings.

Out of scope: persisting answers, running anything after the user answers,
collecting secrets, and any behaviour outside the interactive TUI. There is no
command, no state on disk, and no configuration file.

## How it works

Mental model: `ask(questions[])` returns the answers as plain text in the tool
result; the model reads that text and continues. Nothing else is stored.

```text
model ── ask(questions) ──► boundQuestions: bytes → shape → counts → clamp
                             │ reject (error result, no UI)
                             ▼
                    one question: choice list
                    two or more: tab bar + Submit tab
                             │ ↑↓ select, Enter confirm, Tab/←→ move, Esc cancel
                             ▼
                    result text: "Q1: user selected: 1. <label>"
                                 "Q2: user wrote: <free text>"
                                 plus a truncation note when a field was clipped
```

Two design points carry the rest:

- One question behaves like a plain choice list and submits on selection. Two or
  more questions get a tab bar, advance to the next tab on each answer, and end on
  a Submit tab that lists every answer and names the unanswered ones.
- `executionMode: "sequential"`. pi defaults an omitted mode to parallel, and concurrent
  question calls interleave the overlay and corrupt the answers (pi #6189).

Every option label doubles as its answer, so there is no separate value field to
keep in sync. A question with no options and `allowOther: false` still renders one
"Type something." row: leaving a question unanswerable would trap the overlay.

## Quick start

```sh
npm install @protokol11/pi-ask
```

Or from a clone of this repo:

```sh
cp -r pi-ask ~/.pi/agent/extensions/pi-ask
```

Details below.

## Install

Prerequisites: pi installed (it provides `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, and `typebox`). Node.js 24 or newer to run the tests.

```sh
cp -r ask ~/.pi/agent/extensions/ask
```

Expected: `~/.pi/agent/extensions/ask` holds `index.ts`, `package.json`, and
`test/ask.test.mjs`. Restart pi; the `ask` tool appears in the tool list.

## Usage

One path to one result: the model asks two questions, the user answers both, and
the tool result carries the answers.

The call:

```json
{
  "questions": [
    {
      "id": "scope",
      "label": "Scope",
      "prompt": "What should the overlay keep?",
      "options": [
        { "label": "Keep the current layout", "description": "No visual change" },
        { "label": "Merge prompt and options", "description": "One block, fewer lines" }
      ]
    },
    {
      "id": "when",
      "label": "When",
      "prompt": "When should this land?"
    }
  ]
}
```

The rendered overlay, with the first tab active:

```text
────────────────────────────────────────────────────────
 ←  ■ Scope  □ When   ✓ Submit →
────────────────────────────────────────────────────────
 What should the overlay keep?

> 1. Keep the current layout
      No visual change
  2. Merge prompt and options
      One block, fewer lines
  3. Type something.

 ↑↓ navigate • Enter select • Esc cancel
 Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel
────────────────────────────────────────────────────────
```

After Enter on option 1 and typing a date on the second tab, the tool result reads:

```text
Scope: user selected: 1. Keep the current layout
When: user wrote: after the release cut
```

Cancelling with Esc returns `User cancelled the questionnaire` with
`details.cancelled: true` and no answers. Omitting `label` gives the tab the name
`Q1`, `Q2`, and so on; omitting `id` gives `q1`, `q2`.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `ask` | `questions[]`: `prompt` (required), `options[]` (at least one), `id`, `label`, `allowOther` (default `true`) | One line per answer in the tool result, `details.questions`, `details.answers`, `details.cancelled`, `details.warnings` |

Each answer is `{ id, label, wasCustom, index? }`. `index` is the 1-based position
of the chosen option; `wasCustom` is true when the text came from "Type something.".

## Configuration

No settings file and no environment variables. The bounds live in one exported
`LIMITS` object in `index.ts`, which the test suite reads, so a changed bound can
not drift from its test.

| Key | Default | Effect |
|---|---|---|
| `questions` | 8 | Maximum questions per call; more is rejected. |
| `options` | 10 | Maximum options per question; more is rejected. |
| `id` | 32 | Question id, clipped with an ellipsis. |
| `label` | 24 | Tab-bar label, clipped. |
| `optionLabel` | 80 | Option label, clipped. Kept larger than `label` because it carries the answer. |
| `prompt` | 300 | Question text, clipped. |
| `description` | 120 | Option description, clipped. |
| `budgetBytes` | 8192 | Whole-call JSON size in UTF-8 bytes; more is rejected. |

Structural limits are also declared in the tool schema, because no amount of
clipping turns nine questions into eight. Text limits are not in the schema: pi
validates arguments before `execute` runs, and a schema `maxLength` would reject
the call instead of letting the clamp shorten the field that was sent.

## Troubleshooting

- **Symptom:** `Error: UI not available (running in non-interactive mode)`. **Cause:**
  the call arrived outside the TUI (`print`, rpc, or a headless run). **Fix:** use
  `ask` only in an interactive session, or pass the decision as a plain question in
  the prompt for headless runs.
- **Symptom:** `Error: No questions provided`. **Cause:** `questions` was missing,
  empty, or the arguments arrived truncated. **Fix:** retry with one or more
  questions; the call is rejected before the overlay opens.
- **Symptom:** `Error: arguments too large (N bytes) — the limit is 8192`. **Cause:**
  long descriptions or prompts, measured in UTF-8 bytes. **Fix:** shorten the text
  or move context into the conversation and ask only the decision.
- **Symptom:** `Error: too many questions (9) — the limit is 8`, or the same for
  options. **Cause:** structural overflow; it changes what the user is asked.
  **Fix:** split the call, or reduce the option list to the real choices.
- **Symptom:** a label ends in `…` and the result says `note: N field(s) truncated`.
  **Cause:** `boundQuestions` clipped the field to its bound. **Fix:** expected
  behaviour; send shorter text when the user must see all of it.

## Contributing

File issues in `protokol11/agent-governance` under `extensions/ask`. Run the tests
before sending a change:

```sh
node --test test/*.test.mjs
```

Current suite: 27 passing, headless against `index.ts` with a mock theme and TUI
(no running pi needed, but the `@earendil-works` packages must be resolvable).

## License

[MIT](../../LICENSE)
