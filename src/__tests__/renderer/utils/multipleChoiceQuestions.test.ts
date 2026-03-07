import { describe, expect, it } from 'vitest';
import { parseMultipleChoiceQuestions } from '../../../renderer/utils/multipleChoiceQuestions';

describe('parseMultipleChoiceQuestions', () => {
	it('parses a single recommended option table', () => {
		const content = `
Q1: Which auth flow should we use?

**Recommended:** Option B - Lower operational overhead.

| Option | Description |
| ------ | ----------- |
| A | Custom JWT auth |
| B | Clerk |
| C | NextAuth |
| Short | Provide a different short answer |
		`.trim();

		expect(parseMultipleChoiceQuestions(content)).toEqual([
			{
				id: 'Q1',
				label: 'Q1',
				prompt: 'Which auth flow should we use?',
				replyPrefix: 'Q1: ',
				options: [
					{
						label: 'A',
						description: 'Custom JWT auth',
						replyValue: 'A',
						isRecommended: false,
					},
					{
						label: 'B',
						description: 'Clerk',
						replyValue: 'B',
						isRecommended: true,
					},
					{
						label: 'C',
						description: 'NextAuth',
						replyValue: 'C',
						isRecommended: false,
					},
				],
				manualAnswerOption: {
					label: 'Short',
					description: 'Provide a different short answer',
					replyValue: 'SHORT',
					isRecommended: false,
				},
			},
		]);
	});

	it('adds per-question prefixes when multiple tables are present', () => {
		const content = `
Q1: Pick a runtime.

| Option | Description |
| ------ | ----------- |
| A | Node |
| B | Bun |

Q2: Pick a database.

| Option | Description |
| ------ | ----------- |
| A | SQLite |
| B | Postgres |
| Custom | Provide your own answer |
		`.trim();

		const questions = parseMultipleChoiceQuestions(content);

		expect(questions).toHaveLength(2);
		expect(questions[0]?.replyPrefix).toBe('Q1: ');
		expect(questions[1]?.replyPrefix).toBe('Q2: ');
		expect(questions[1]?.manualAnswerOption?.label).toBe('Custom');
	});

	it('ignores non-question tables', () => {
		const content = `
| Name | Value |
| ---- | ----- |
| Foo | Bar |
		`.trim();

		expect(parseMultipleChoiceQuestions(content)).toEqual([]);
	});
});
