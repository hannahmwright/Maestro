export interface MultipleChoiceOption {
	label: string;
	description: string;
	replyValue: string;
	isRecommended: boolean;
}

export interface MultipleChoiceQuestion {
	id: string;
	label?: string;
	prompt?: string;
	replyPrefix: string;
	options: MultipleChoiceOption[];
	manualAnswerOption?: MultipleChoiceOption;
}

interface TableBlock {
	startLine: number;
	endLine: number;
	rows: string[][];
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const QUESTION_LABEL_RE = /\b(Q\d+)\b/i;
const QUESTION_PREFIX_RE = /^Q\d+[:.)-]?\s*/i;
const OPTION_LABEL_RE = /^[A-E]$/i;
const MANUAL_OPTION_RE = /^(custom|short)$/i;
const RECOMMENDED_OPTION_RE = /recommended:\s*option\s*\[?([A-E])\]?/i;

function splitMarkdownRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
	return (
		cells.length > 0 &&
		cells.every((cell) => cell.length > 0 && /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))
	);
}

function stripMarkdown(text: string): string {
	return text
		.replace(/\*\*/g, '')
		.replace(/`/g, '')
		.replace(/\[(.*?)\]\(.*?\)/g, '$1')
		.trim();
}

function extractTableBlocks(lines: string[]): TableBlock[] {
	const blocks: TableBlock[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (!TABLE_ROW_RE.test(lines[i])) continue;

		const startLine = i;
		const blockLines: string[] = [];

		while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
			blockLines.push(lines[i]);
			i++;
		}

		const rows = blockLines.map(splitMarkdownRow);
		if (rows.length >= 3 && isSeparatorRow(rows[1])) {
			blocks.push({
				startLine,
				endLine: i - 1,
				rows,
			});
		}

		i--;
	}

	return blocks;
}

function findQuestionPrompt(contextLines: string[]): string | undefined {
	for (let i = contextLines.length - 1; i >= 0; i--) {
		const line = stripMarkdown(contextLines[i]);
		if (!line) continue;
		if (QUESTION_LABEL_RE.test(line) || line.endsWith('?')) {
			return line.replace(QUESTION_PREFIX_RE, '').trim();
		}
	}

	return undefined;
}

export function parseMultipleChoiceQuestions(content: string): MultipleChoiceQuestion[] {
	if (!content.trim()) return [];

	const lines = content.split('\n');
	const tables = extractTableBlocks(lines);
	const questions: Array<Omit<MultipleChoiceQuestion, 'replyPrefix'> & { lineIndex: number }> = [];
	let previousTableEnd = -1;

	for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
		const table = tables[tableIndex];
		const [headerRow] = table.rows;
		if (!headerRow || !/^(option|choice)$/i.test(headerRow[0] || '')) {
			previousTableEnd = table.endLine;
			continue;
		}

		const contextLines = lines
			.slice(previousTableEnd + 1, table.startLine)
			.filter((line) => line.trim().length > 0);
		const contextText = stripMarkdown(contextLines.join('\n'));
		const labelMatch = Array.from(contextText.matchAll(/\b(Q\d+)\b/gi)).at(-1);
		const recommendedMatch = contextText.match(RECOMMENDED_OPTION_RE);
		const recommendedLabel = recommendedMatch?.[1]?.toUpperCase();

		const options = table.rows
			.slice(2)
			.map((cells) => {
				const rawLabel = stripMarkdown(cells[0] || '');
				if (!rawLabel) return null;

				const normalizedLabel = rawLabel.toUpperCase();
				const isClickable = OPTION_LABEL_RE.test(normalizedLabel);
				const isManual = MANUAL_OPTION_RE.test(rawLabel);
				if (!isClickable && !isManual) return null;

				return {
					label: rawLabel,
					description: stripMarkdown(cells.slice(1).join(' | ')),
					replyValue: normalizedLabel,
					isRecommended: normalizedLabel === recommendedLabel,
				};
			})
			.filter((option): option is MultipleChoiceOption => option !== null);

		const clickableOptions = options.filter((option) => OPTION_LABEL_RE.test(option.label));
		if (clickableOptions.length === 0) {
			previousTableEnd = table.endLine;
			continue;
		}

		const manualAnswerOption = options.find((option) => MANUAL_OPTION_RE.test(option.label));
		questions.push({
			id: labelMatch?.[1]?.toUpperCase() || `question-${questions.length + 1}`,
			label: labelMatch?.[1]?.toUpperCase(),
			prompt: findQuestionPrompt(contextLines),
			options: clickableOptions,
			manualAnswerOption,
			lineIndex: table.startLine,
		});

		previousTableEnd = table.endLine;
	}

	const hasMultipleQuestions = questions.length > 1;
	return questions.map(({ lineIndex: _lineIndex, ...question }, index) => ({
		...question,
		replyPrefix: hasMultipleQuestions
			? `${question.label || `Q${index + 1}`}: `
			: question.label
				? `${question.label}: `
				: '',
	}));
}
