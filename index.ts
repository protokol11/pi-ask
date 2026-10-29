/**
 * Ask Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface AskResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
	// One line per field the argument clamp shortened. Always present in a result.
	warnings: string[];
}

// One source for every bound: the schema tells the model the limit, boundQuestions
// holds the call to it. Two hard-coded copies would drift.
export const LIMITS = {
	questions: 8,
	options: 10,
	label: 24,
	// Tab-bar labels stay short; option labels carry real content, so they get more room.
	optionLabel: 80,
	prompt: 300,
	description: 120,
	id: 32,
	budgetBytes: 8192,
} as const;

// Clipping keeps the ellipsis inside the bound, so a clamped value is never
// longer than the limit it is reported against. A cut that lands between the
// halves of a surrogate pair would leave a lone high half, which renders as a
// replacement glyph, so the pair is dropped whole and the ellipsis takes its slot.
function clampText(value: string, bound: number): string {
	if (value.length <= bound) return value;
	let end = bound - 1;
	const lastKept = value.charCodeAt(end - 1);
	if (lastKept >= 0xd800 && lastKept <= 0xdbff) {
		end--;
	}
	return `${value.slice(0, end)}…`;
}

// Schema
//
// The bounds are split by whether the tool can repair the overflow. Structural
// overflow (too many questions or options) changes what the user is asked, and no
// amount of clipping turns 9 questions into 8, so the schema rejects it outright
// and boundQuestions repeats the check against the same LIMITS. Text overflow is
// repairable by clipping, so the schema stays quiet about it: pi validates
// arguments before execute runs, so a schema length cap would reject the whole
// call and the clamp in boundQuestions would never get the chance to shorten the
// field the model sent.
const QuestionOptionSchema = Type.Object({
	label: Type.String({
		description: `Display label for the option (clamped to ${LIMITS.optionLabel} characters)`,
	}),
	description: Type.Optional(
		Type.String({
			description: `Optional description shown below label (clamped to ${LIMITS.description} characters)`,
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(
		Type.String({
			description: `Identifier for this question (defaults to q1, q2, ...; clamped to ${LIMITS.id} characters)`,
		}),
	),
	label: Type.Optional(
		Type.String({
			description: `Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2; clamped to ${LIMITS.label} characters)`,
		}),
	),
	prompt: Type.String({
		description: `The full question text to display (clamped to ${LIMITS.prompt} characters)`,
	}),
	options: Type.Array(QuestionOptionSchema, {
		minItems: 1,
		maxItems: LIMITS.options,
		description: "Available options to choose from",
	}),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: LIMITS.questions,
		description: "Questions to ask the user",
	}),
});

/**
 * Enforces the argument bounds on a raw `ask` call. Pure: it reads `params`,
 * returns plain data, and never throws.
 *
 * Order: JSON byte budget -> shape -> counts -> per-field truncation.
 * Structure that would change what the user is asked (too many questions or
 * options, an oversize payload) is rejected; text is clamped and reported.
 */
export function boundQuestions(
	params: unknown,
): { ok: true; questions: Question[]; warnings: string[] } | { ok: false; error: string } {
	let size: number;
	try {
		// Real UTF-8 bytes, because the error names bytes: `.length` counts UTF-16
		// code units, so 5000 Cyrillic characters (~10 KB on the wire) would pass.
		size = Buffer.byteLength(JSON.stringify(params) ?? "", "utf8");
	} catch {
		return {
			ok: false,
			error: "Error: arguments are not serializable JSON — retry with plain questions and options.",
		};
	}
	if (size > LIMITS.budgetBytes) {
		return {
			ok: false,
			error: `Error: arguments too large (${size} bytes) — the limit is ${LIMITS.budgetBytes}`,
		};
	}

	const raw = (params ?? {}) as { questions?: unknown };
	if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
		return {
			ok: false,
			error:
				"Error: No questions provided. `questions` must be a non-empty array — arguments that arrive truncated or without `questions` are rejected before any UI opens.",
		};
	}
	if (raw.questions.length > LIMITS.questions) {
		return {
			ok: false,
			error: `Error: too many questions (${raw.questions.length}) — the limit is ${LIMITS.questions}`,
		};
	}

	const warnings: string[] = [];
	const questions: Question[] = [];

	for (let i = 0; i < raw.questions.length; i++) {
		const q = (raw.questions[i] ?? {}) as Partial<Question>;
		const fallbackId = `q${i + 1}`;
		const rawId = typeof q.id === "string" ? q.id : "";
		// Path names stay short and stable: an oversize id is reported against its slot.
		const name = rawId.length > 0 && rawId.length <= LIMITS.id ? rawId : fallbackId;

		const prompt = typeof q.prompt === "string" ? q.prompt : "";
		if (prompt.trim().length === 0) {
			return { ok: false, error: `Error: every question needs a non-empty \`prompt\` (${name} is empty)` };
		}

		const rawOptions = Array.isArray(q.options) ? q.options : [];
		if (rawOptions.length > LIMITS.options) {
			return {
				ok: false,
				error: `Error: too many options in ${name} (${rawOptions.length}) — the limit is ${LIMITS.options}`,
			};
		}

		const options: QuestionOption[] = rawOptions.map((entry, j) => {
			const o = (entry ?? {}) as Partial<QuestionOption>;
			const option = { ...o } as QuestionOption;
			if (typeof o.label === "string") {
				option.label = clampText(o.label, LIMITS.optionLabel);
				if (o.label.length > LIMITS.optionLabel) {
					warnings.push(`${name}.options[${j}].label truncated to ${LIMITS.optionLabel}`);
				}
			} else {
				option.label = "";
			}
			if (typeof o.description === "string") {
				option.description = clampText(o.description, LIMITS.description);
				if (o.description.length > LIMITS.description) {
					warnings.push(`${name}.options[${j}].description truncated to ${LIMITS.description}`);
				}
			}
			return option;
		});

		let id = fallbackId;
		if (rawId.length > 0) {
			id = clampText(rawId, LIMITS.id);
			if (rawId.length > LIMITS.id) {
				warnings.push(`${name}.id truncated to ${LIMITS.id}`);
			}
		}

		const rawLabel = typeof q.label === "string" ? q.label : "";
		const label = rawLabel.length > 0 ? clampText(rawLabel, LIMITS.label) : `Q${i + 1}`;
		if (rawLabel.length > LIMITS.label) {
			warnings.push(`${name}.label truncated to ${LIMITS.label}`);
		}

		const clampedPrompt = clampText(prompt, LIMITS.prompt);
		if (prompt.length > LIMITS.prompt) {
			warnings.push(`${name}.prompt truncated to ${LIMITS.prompt}`);
		}

		questions.push({ id, label, prompt: clampedPrompt, options, allowOther: q.allowOther !== false });
	}

	return { ok: true, questions, warnings };
}

function errorResult(
	message: string,
	questions: Question[] = [],
	warnings: string[] = [],
): { content: { type: "text"; text: string }[]; details: AskResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true, warnings },
	};
}

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user one or more questions, each with options. One question behaves like a plain choice list; several get a tab bar and a Submit tab. Use for clarifying requirements, getting preferences, or confirming decisions.",
		parameters: AskParams,
		// Local patch: upstream example omits executionMode, which defaults to
		// "parallel" — concurrent question calls break the TUI answers (pi #6189).
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// A malformed call (truncated JSON, missing questions) must never throw and
			// must never open the UI: a thrown execute leaves the overlay spinning.
			try {
				// Bounds run first: an oversize or malformed call reports the argument
				// problem, not a mode problem, and no code path reaches the UI unguarded.
				const bounded = boundQuestions(params);
				if (!bounded.ok) {
					return errorResult(bounded.error);
				}
				const { questions, warnings } = bounded;

				if (ctx.mode !== "tui") {
					return errorResult("Error: UI not available (running in non-interactive mode)", [], warnings);
				}

				const isMulti = questions.length > 1;
				const totalTabs = questions.length + 1; // questions + Submit

				const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
					// State
					let currentTab = 0;
					let optionIndex = 0;
					let inputMode = false;
					let inputQuestionId: string | null = null;
					let cachedLines: string[] | undefined;
					const answers = new Map<string, Answer>();

					// Editor for "Type something" option
					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					// Helpers
					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function submit(cancelled: boolean) {
						done({ questions, answers: Array.from(answers.values()), cancelled, warnings });
					}

					function currentQuestion(): Question | undefined {
						return questions[currentTab];
					}

					function currentOptions(): RenderOption[] {
						const q = currentQuestion();
						if (!q) return [];
						const opts: RenderOption[] = [...q.options];
						if (q.allowOther) {
							opts.push({ label: "Type something.", isOther: true });
						}
						// No options and no free-text entry leaves the question unanswerable,
						// which traps the overlay, so always keep that way out.
						if (opts.length === 0) {
							opts.push({ label: "Type something.", isOther: true });
						}
						return opts;
					}

					function allAnswered(): boolean {
						return questions.every((q) => answers.has(q.id));
					}

					function advanceAfterAnswer() {
						if (!isMulti) {
							submit(false);
							return;
						}
						if (currentTab < questions.length - 1) {
							currentTab++;
						} else {
							currentTab = questions.length; // Submit tab
						}
						optionIndex = 0;
						refresh();
					}

					function saveAnswer(questionId: string, label: string, wasCustom: boolean, index?: number) {
						answers.set(questionId, { id: questionId, label, wasCustom, index });
					}

					// Editor submit callback
					editor.onSubmit = (value) => {
						if (!inputQuestionId) return;
						const trimmed = value.trim() || "(no response)";
						saveAnswer(inputQuestionId, trimmed, true);
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						advanceAfterAnswer();
					};

					function handleInput(data: string) {
						// Input mode: route to editor
						if (inputMode) {
							if (matchesKey(data, Key.escape)) {
								inputMode = false;
								inputQuestionId = null;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						const q = currentQuestion();
						const opts = currentOptions();

						// Tab navigation (multi-question only)
						if (isMulti) {
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
								currentTab = (currentTab + 1) % totalTabs;
								optionIndex = 0;
								refresh();
								return;
							}
							if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
								currentTab = (currentTab - 1 + totalTabs) % totalTabs;
								optionIndex = 0;
								refresh();
								return;
							}
						}

						// Submit tab
						if (currentTab === questions.length) {
							if (matchesKey(data, Key.enter) && allAnswered()) {
								submit(false);
							} else if (matchesKey(data, Key.escape)) {
								submit(true);
							}
							return;
						}

						// Option navigation
						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(opts.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						// Select option
						if (matchesKey(data, Key.enter) && q) {
							const opt = opts[optionIndex];
							if (!opt) {
								refresh();
								return;
							}
							if (opt.isOther) {
								inputMode = true;
								inputQuestionId = q.id;
								editor.setText("");
								refresh();
								return;
							}
							saveAnswer(q.id, opt.label, false, optionIndex + 1);
							advanceAfterAnswer();
							return;
						}

						// Cancel
						if (matchesKey(data, Key.escape)) {
							submit(true);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const renderWidth = Math.max(1, width);
						const q = currentQuestion();
						const opts = currentOptions();

						function addWrapped(text: string) {
							lines.push(...wrapTextWithAnsi(text, renderWidth));
						}

						function addWrappedWithPrefix(prefix: string, text: string) {
							const prefixWidth = visibleWidth(prefix);
							if (prefixWidth >= renderWidth) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
							const continuationPrefix = " ".repeat(prefixWidth);
							for (let i = 0; i < wrapped.length; i++) {
								lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
							}
						}

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						// Tab bar (multi-question only)
						if (isMulti) {
							const tabs: string[] = ["← "];
							for (let i = 0; i < questions.length; i++) {
								const isActive = i === currentTab;
								const isAnswered = answers.has(questions[i].id);
								const lbl = questions[i].label;
								const box = isAnswered ? "■" : "□";
								const color = isAnswered ? "success" : "muted";
								const text = ` ${box} ${lbl} `;
								const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
								tabs.push(`${styled} `);
							}
							const canSubmit = allAnswered();
							const isSubmitTab = currentTab === questions.length;
							const submitText = " ✓ Submit ";
							const submitStyled = isSubmitTab
								? theme.bg("selectedBg", theme.fg("text", submitText))
								: theme.fg(canSubmit ? "success" : "dim", submitText);
							tabs.push(`${submitStyled} →`);
							addWrappedWithPrefix(" ", tabs.join(""));
							lines.push("");
						}

						// Helper to render options list
						function renderOptions() {
							for (let i = 0; i < opts.length; i++) {
								const opt = opts[i];
								const selected = i === optionIndex;
								const isOther = opt.isOther === true;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
								const color = selected || (isOther && inputMode) ? "accent" : "text";

								addWrappedWithPrefix(prefix, theme.fg(color, label));
								if (opt.description) {
									addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
								}
							}
						}

						// Content
						if (inputMode && q) {
							addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
							lines.push("");
							// Show options for reference
							renderOptions();
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
						} else if (currentTab === questions.length) {
							addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
							lines.push("");
							for (const question of questions) {
								const answer = answers.get(question.id);
								if (answer) {
									const prefix = answer.wasCustom ? "(wrote) " : "";
									const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
									addWrappedWithPrefix(" ", summary);
								}
							}
							lines.push("");
							if (allAnswered()) {
								addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
							} else {
								const missing = questions
									.filter((q) => !answers.has(q.id))
									.map((q) => q.label)
									.join(", ");
								addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
							}
						} else if (q) {
							addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
							lines.push("");
							renderOptions();
						}

						lines.push("");
						if (!inputMode) {
							const help = isMulti
								? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
								: "↑↓ navigate • Enter select • Esc cancel";
							addWrappedWithPrefix(" ", theme.fg("dim", help));
						}
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				});

				if (result.cancelled) {
					return {
						content: [{ type: "text", text: "User cancelled the questionnaire" }],
						details: { ...result, warnings },
					};
				}

				const answerLines = result.answers.map((a) => {
					const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
					if (a.wasCustom) {
						return `${qLabel}: user wrote: ${a.label}`;
					}
					return `${qLabel}: user selected: ${a.index}. ${a.label}`;
				});

				// A clamped value that nobody mentions reads as if the user saw the full
				// text, so the note is part of the answer whenever a field was shortened.
				const note = warnings.length > 0 ? `\n\nnote: ${warnings.length} field(s) truncated — see warnings` : "";

				return {
					content: [{ type: "text", text: `${answerLines.join("\n")}${note}` }],
					details: { ...result, warnings },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`Error: ask failed — ${message}. Retry with well-formed questions.`);
			}
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("ask "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
