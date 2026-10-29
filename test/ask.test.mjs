// Run: node --test test/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import ask, { boundQuestions, LIMITS } from "../index.ts";

// Minimal mock theme/tui so the real component factory runs headless.
const theme = {
  fg: (_c, s) => s,
  bg: (_c, s) => s,
  bold: (s) => s,
};
// Editor.render() reads terminal.rows, so the mock needs it too.
const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };

// Fake pi capturing registered tools.
function makePi() {
  const tools = [];
  ask({ registerTool: (tool) => tools.push(tool) });
  return tools;
}

// Drives execute() with a ui.custom that invokes the real component factory,
// then immediately cancels (Esc) so done() fires with the normalized questions.
async function run(params, { mode = "tui" } = {}) {
  const tool = makePi()[0];
  const ctx = {
    mode,
    ui: {
      custom: async (factory) =>
        new Promise((resolve) => {
          const component = factory(tui, theme, {}, resolve);
          component.handleInput("\x1b"); // Esc -> cancel, but done carries questions
        }),
    },
  };
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

test("registers under name ask with label Ask and sequential mode", () => {
  const tools = makePi();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "ask");
  assert.equal(tools[0].label, "Ask");
  assert.equal(tools[0].executionMode, "sequential");
  assert.match(tools[0].description, /one or more questions/);
});

test("single question normalizes to id q1, label Q1, allowOther true", async () => {
  const result = await run({
    questions: [{ prompt: "Pick?", options: [{ label: "A" }, { label: "B" }] }],
  });
  assert.deepEqual(result.details.questions, [
    {
      id: "q1",
      label: "Q1",
      prompt: "Pick?",
      options: [{ label: "A" }, { label: "B" }],
      allowOther: true,
    },
  ]);
  assert.equal(result.details.cancelled, true); // we cancelled via Esc
  assert.match(result.content[0].text, /cancelled/i);
});

test("allowOther: false is preserved", async () => {
  const result = await run({
    questions: [{ prompt: "Pick?", allowOther: false, options: [{ label: "A" }] }],
  });
  assert.equal(result.details.questions[0].allowOther, false);
});

test("two questions get labels Q1/Q2 and explicit ids are kept", async () => {
  const result = await run({
    questions: [
      { id: "scope", prompt: "Scope?", options: [{ label: "A" }] },
      { prompt: "Priority?", options: [{ label: "B" }] },
    ],
  });
  const [q1, q2] = result.details.questions;
  assert.equal(q1.id, "scope");
  assert.equal(q1.label, "Q1");
  assert.equal(q2.id, "q2");
  assert.equal(q2.label, "Q2");
});

test("empty questions returns error result with cancelled true", async () => {
  const result = await run({ questions: [] });
  assert.equal(result.details.cancelled, true);
  assert.deepEqual(result.details.answers, []);
  assert.match(result.content[0].text, /No questions provided/);
});

test("non-tui mode returns the non-interactive error", async () => {
  const result = await run({ questions: [{ prompt: "P?", options: [{ label: "A" }] }] }, { mode: "rpc" });
  assert.equal(result.details.cancelled, true);
  assert.equal(result.content[0].text, "Error: UI not available (running in non-interactive mode)");
});

test("selecting an option answers with its label (no separate value)", async () => {
  const tool = makePi()[0];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory) =>
        new Promise((resolve) => {
          const component = factory(tui, theme, {}, resolve);
          component.handleInput("\r"); // Enter selects option 1
        }),
    },
  };
  const result = await tool.execute(
    "call-1",
    { questions: [{ prompt: "Pick?", options: [{ label: "A" }, { label: "B" }] }] },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(result.details.answers, [{ id: "q1", label: "A", wasCustom: false, index: 1 }]);
  assert.equal(result.details.cancelled, false);
  assert.match(result.content[0].text, /user selected: 1\. A/);
});

// Like run(), but records whether the UI was opened at all.
async function runTrackingUi(params) {
  const tool = makePi()[0];
  let customCalls = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory) =>
        new Promise((resolve) => {
          customCalls++;
          const component = factory(tui, theme, {}, resolve);
          component.handleInput("\x1b");
        }),
    },
  };
  const result = await tool.execute("call-1", params, undefined, undefined, ctx);
  return { result, customCalls };
}

test("empty params {} resolves with an error and never opens the UI", async () => {
  const { result, customCalls } = await runTrackingUi({});
  assert.equal(customCalls, 0);
  assert.match(result.content[0].text, /No questions provided/);
  assert.equal(result.details.cancelled, true);
});

test("questions: [] resolves with an error and never opens the UI", async () => {
  const { result, customCalls } = await runTrackingUi({ questions: [] });
  assert.equal(customCalls, 0);
  assert.match(result.content[0].text, /No questions provided/);
  assert.equal(result.details.cancelled, true);
});

test("blank prompt is rejected by name before the UI opens", async () => {
  const { result, customCalls } = await runTrackingUi({
    questions: [{ label: "Q1", prompt: "   ", options: [{ label: "x" }] }],
  });
  assert.equal(customCalls, 0);
  assert.match(result.content[0].text, /non-empty `prompt`/);
  assert.match(result.content[0].text, /q1 is empty/);
  assert.equal(result.details.cancelled, true);
});

test("options: [] with allowOther: false still renders a Type something row", async () => {
  const tool = makePi()[0];
  let rendered = [];
  let component;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory) =>
        new Promise((resolve) => {
          component = factory(tui, theme, {}, resolve);
          rendered = component.render(80);
        }),
    },
  };
  const pending = tool.execute(
    "call-1",
    { questions: [{ prompt: "Anything?", options: [], allowOther: false }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(rendered.join("\n"), /Type something\./);
  // Enter on the only row enters input mode instead of throwing on an undefined option.
  assert.doesNotThrow(() => component.handleInput("\r"));
  assert.match(component.render(80).join("\n"), /Your answer:/);
  // First Esc leaves input mode, second Esc cancels through done().
  component.handleInput("\x1b");
  component.handleInput("\x1b");
  const result = await pending;
  assert.equal(result.details.cancelled, true);
});

// --- argument bounds (SPECS/extensions-global/ask-argument-limits.md) ---

test("9 questions are rejected with the limit named and the UI never opens", async () => {
  const questions = Array.from({ length: 9 }, (_, i) => ({ prompt: `P${i}?`, options: [{ label: "A" }] }));
  const { result, customCalls } = await runTrackingUi({ questions });
  assert.equal(customCalls, 0);
  assert.equal(result.details.cancelled, true);
  assert.match(result.content[0].text, /too many questions \(9\)/);
  assert.match(result.content[0].text, /the limit is 8/);
  assert.deepEqual(result.details.warnings, []);
});

test("11 options are rejected with the limit named and the UI never opens", async () => {
  const options = Array.from({ length: 11 }, (_, i) => ({ label: `O${i}` }));
  const { result, customCalls } = await runTrackingUi({
    questions: [{ id: "scope", prompt: "Pick?", options }],
  });
  assert.equal(customCalls, 0);
  assert.equal(result.details.cancelled, true);
  assert.match(result.content[0].text, /too many options in scope \(11\)/);
  assert.match(result.content[0].text, /the limit is 10/);
});

test("a single 9 KB description is rejected with the byte limit and the actual size", async () => {
  const params = {
    questions: [{ prompt: "Pick?", options: [{ label: "A", description: "x".repeat(9000) }] }],
  };
  const size = JSON.stringify(params).length;
  assert.ok(size > LIMITS.budgetBytes);
  const { result, customCalls } = await runTrackingUi(params);
  assert.equal(customCalls, 0);
  const text = result.content[0].text;
  assert.match(text, /arguments too large/);
  assert.ok(text.includes(`(${size} bytes)`), text);
  assert.match(text, new RegExp(`the limit is ${LIMITS.budgetBytes}`));
});

// Like run(), but answers the first option so execute reaches the success path.
async function runAnswering(params) {
  const tool = makePi()[0];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory) =>
        new Promise((resolve) => {
          const component = factory(tui, theme, {}, resolve);
          component.handleInput("\r"); // Enter selects option 1
        }),
    },
  };
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

test("a 200-char description is clamped inside 120 with one warning", async () => {
  const long = "d".repeat(200);
  const result = await runAnswering({
    questions: [{ prompt: "Pick?", options: [{ label: "A", description: long }] }],
  });
  const clamped = result.details.questions[0].options[0].description;
  assert.ok(clamped.length <= LIMITS.description, `length ${clamped.length}`);
  assert.ok(clamped.endsWith("…"));
  assert.deepEqual(result.details.warnings, [
    `q1.options[0].description truncated to ${LIMITS.description}`,
  ]);
  assert.match(result.content[0].text, /note: 1 field\(s\) truncated — see warnings/);
});

test("prompt, label and id are clamped and each is reported", async () => {
  const result = await runAnswering({
    questions: [
      {
        id: "i".repeat(40),
        label: "l".repeat(40),
        prompt: `P${"p".repeat(499)}`,
        options: [{ label: "A" }],
      },
    ],
  });
  const q = result.details.questions[0];
  assert.ok(q.prompt.length <= LIMITS.prompt);
  assert.ok(q.label.length <= LIMITS.label);
  assert.ok(q.id.length <= LIMITS.id);
  assert.ok(q.prompt.endsWith("…") && q.label.endsWith("…") && q.id.endsWith("…"));
  assert.equal(result.details.warnings.length, 3);
  const joined = result.details.warnings.join("\n");
  for (const field of ["prompt", "label", "id"]) {
    assert.match(joined, new RegExp(`q1\\.${field} truncated to `));
  }
  assert.match(result.content[0].text, /note: 3 field\(s\) truncated/);
});

test("a 40-emoji label clamps without leaving a lone surrogate", () => {
  const label = "😀".repeat(40);
  assert.equal(label.length, 80); // 2 code units each, so the clamp slices mid-pair
  const outcome = boundQuestions({
    questions: [{ prompt: "Pick?", label, options: [{ label: "A" }] }],
  });
  assert.equal(outcome.ok, true);
  const value = outcome.questions[0].label;
  assert.ok(value.length <= LIMITS.label, `length ${value.length} over ${LIMITS.label}`);
  // No high half without its low half, and no low half without its high half.
  assert.doesNotMatch(value, /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])/u);
  assert.ok(value.endsWith("…"));
  assert.deepEqual(outcome.warnings, [`q1.label truncated to ${LIMITS.label}`]);
});

test("5000 Cyrillic characters are rejected on UTF-8 bytes, not UTF-16 units", () => {
  const description = "ж".repeat(5000);
  const params = { questions: [{ prompt: "Pick?", options: [{ label: "A", description }] }] };
  const serialized = JSON.stringify(params);
  // The old measure (code units) would have let this through; the wire size does not.
  assert.ok(serialized.length < LIMITS.budgetBytes, `code units ${serialized.length}`);
  const bytes = Buffer.byteLength(serialized, "utf8");
  assert.ok(bytes > LIMITS.budgetBytes, `bytes ${bytes}`);

  const outcome = boundQuestions(params);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /arguments too large/);
  const reported = Number(outcome.error.match(/\((\d+) bytes\)/)?.[1]);
  assert.equal(reported, bytes);
  assert.ok(reported > LIMITS.budgetBytes, outcome.error);
});

test("a small ASCII call still passes the byte budget and opens the UI", async () => {
  const params = { questions: [{ prompt: "Pick?", options: [{ label: "A" }, { label: "B" }] }] };
  assert.equal(boundQuestions(params).ok, true);
  const { result, customCalls } = await runTrackingUi(params);
  assert.equal(customCalls, 1);
  assert.equal(result.details.questions.length, 1);
  assert.deepEqual(result.details.warnings, []);
});

test("values exactly at the bound are kept unchanged with no warning", () => {
  const description = "d".repeat(LIMITS.description);
  const label = "l".repeat(LIMITS.label);
  const outcome = boundQuestions({
    questions: [{ label, prompt: "Pick?", options: [{ label: "A", description }] }],
  });
  assert.equal(outcome.ok, true);
  const q = outcome.questions[0];
  assert.equal(q.label, label);
  assert.equal(q.options[0].description, description);
  assert.deepEqual(outcome.warnings, []);
  assert.ok(!q.label.includes("…") && !q.options[0].description.includes("…"));
});

test("a valid 2-question call carries empty warnings and no note", async () => {
  const result = await run({
    questions: [
      { prompt: "Scope?", options: [{ label: "A" }, { label: "B" }] },
      { prompt: "Priority?", options: [{ label: "C" }] },
    ],
  });
  assert.equal(result.details.questions.length, 2);
  assert.deepEqual(result.details.warnings, []);
  assert.doesNotMatch(result.content[0].text, /note:/);
});

test("registered schema bounds structure only and carries no maxLength", () => {
  const params = makePi()[0].parameters;
  // Structural overflow cannot be repaired by clipping, so the schema keeps it.
  assert.equal(params.properties.questions.maxItems, LIMITS.questions);
  assert.equal(params.properties.questions.minItems, 1);
  const question = params.properties.questions.items;
  assert.equal(question.properties.options.maxItems, LIMITS.options);
  assert.equal(question.properties.options.minItems, 1);

  // Text overflow is repaired by boundQuestions, so no schema maxLength may exist:
  // pi validates before execute, and a maxLength would reject the call outright
  // instead of letting the clamp shorten the field.
  const serialized = JSON.stringify(params);
  assert.equal(serialized.includes("maxLength"), false, serialized);
});

test("boundQuestions never throws and never mutates the caller's arguments", () => {
  for (const input of [undefined, null, "text", 42, {}, { questions: [] }, { questions: "nope" }]) {
    const outcome = boundQuestions(input);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /^Error: /);
  }
  const long = "d".repeat(200);
  const params = { questions: [{ prompt: "Pick?", options: [{ label: "A", description: long }] }] };
  const outcome = boundQuestions(params);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.questions[0].options[0].description.length, LIMITS.description);
  assert.equal(params.questions[0].options[0].description, long);
});

test("regression: questions: undefined resolves fast without waiting on UI", async () => {
  const tool = makePi()[0];
  let customCalls = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async () => {
        customCalls++;
        return { questions: [], answers: [], cancelled: true };
      },
    },
  };
  const start = Date.now();
  const result = await tool.execute("call-1", { questions: undefined }, undefined, undefined, ctx);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `execute took ${elapsed}ms`);
  assert.equal(customCalls, 0);
  assert.match(result.content[0].text, /No questions provided/);
});

// --- option labels get their own, larger bound (LIMITS.optionLabel) ---

test("a 62-char option label passes through unclamped", () => {
  // Real option labels carry content; the 24-char tab-bar bound must not touch them.
  const optionLabel = "Выбор при создании + перенос в сайдбар и настройка вида панели";
  assert.equal(optionLabel.length, 62);
  assert.ok(optionLabel.length > LIMITS.label, `${optionLabel.length} vs ${LIMITS.label}`);
  assert.ok(optionLabel.length < LIMITS.optionLabel, `${optionLabel.length} vs ${LIMITS.optionLabel}`);

  const outcome = boundQuestions({
    questions: [{ prompt: "Pick?", options: [{ label: optionLabel }] }],
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.questions[0].options[0].label, optionLabel);
  assert.deepEqual(outcome.warnings, []);
});

test("a 30-char question label still clamps to 24", () => {
  const questionLabel = "l".repeat(30);
  const outcome = boundQuestions({
    questions: [{ label: questionLabel, prompt: "Pick?", options: [{ label: "A" }] }],
  });
  assert.equal(outcome.ok, true);
  const label = outcome.questions[0].label;
  assert.equal(label.length, LIMITS.label);
  assert.equal(label, `${"l".repeat(LIMITS.label - 1)}…`);
  // The option label's larger bound must not leak into the tab-bar label.
  assert.notEqual(LIMITS.label, LIMITS.optionLabel);
  assert.deepEqual(outcome.warnings, [`q1.label truncated to ${LIMITS.label}`]);
});

test("an option label over 80 clamps to optionLabel with the warning naming it", () => {
  const long = "x".repeat(100);
  const outcome = boundQuestions({
    questions: [{ prompt: "Pick?", options: [{ label: long }] }],
  });
  assert.equal(outcome.ok, true);
  const label = outcome.questions[0].options[0].label;
  assert.equal(label.length, LIMITS.optionLabel);
  assert.ok(label.endsWith("…"));
  assert.deepEqual(outcome.warnings, [`q1.options[0].label truncated to ${LIMITS.optionLabel}`]);
  // The warning reports the option bound, not the 24-char tab-bar one.
  assert.match(outcome.warnings[0], /truncated to 80$/);
});
