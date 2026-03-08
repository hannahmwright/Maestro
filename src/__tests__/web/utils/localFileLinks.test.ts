import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../web/utils/config', () => ({
	getSessionLocalFileViewerUrl: (sessionId: string, filePath: string) =>
		`https://example.test/app/api/session/${sessionId}/local-file/view?path=${encodeURIComponent(filePath)}`,
}));

import {
	buildSessionLocalFileViewerUrl,
	extractStreamableLocalFilePath,
	findStreamableLocalFilePathsInText,
} from '../../../web/utils/localFileLinks';

describe('localFileLinks', () => {
	describe('extractStreamableLocalFilePath', () => {
		it('extracts malformed app-wrapped local URLs from remote output', () => {
			expect(
				extractStreamableLocalFilePath(
					'/http://192.168.1.103:47123/app/Users/hannahwright/Documents/Code/Meal%20Planner/output/playwright/week-navigation-demo.webm'
				)
			).toBe(
				'/Users/hannahwright/Documents/Code/Meal Planner/output/playwright/week-navigation-demo.webm'
			);
		});

		it('extracts direct app-hosted local URLs', () => {
			expect(
				extractStreamableLocalFilePath(
					'https://dev.thewrighthome.app/app/Users/hannahwright/Documents/Code/Meal%20Planner/output/playwright/week-navigation-demo.webm'
				)
			).toBe(
				'/Users/hannahwright/Documents/Code/Meal Planner/output/playwright/week-navigation-demo.webm'
			);
		});

		it('extracts file URLs', () => {
			expect(
				extractStreamableLocalFilePath(
					'file:///Users/hannahwright/Documents/Code/Meal%20Planner/output/playwright/week-navigation-demo.webm'
				)
			).toBe(
				'/Users/hannahwright/Documents/Code/Meal Planner/output/playwright/week-navigation-demo.webm'
			);
		});

		it('keeps relative output paths for session-scoped streaming', () => {
			expect(extractStreamableLocalFilePath('output/playwright/week-navigation-demo.webm')).toBe(
				'output/playwright/week-navigation-demo.webm'
			);
		});

		it('ignores normal web links', () => {
			expect(extractStreamableLocalFilePath('https://runmaestro.ai')).toBeNull();
		});
	});

	describe('buildSessionLocalFileViewerUrl', () => {
		it('builds a session-scoped viewer URL', () => {
			expect(
				buildSessionLocalFileViewerUrl(
					'session-123',
					'/Users/hannahwright/Documents/Code/Meal Planner/output/playwright/week-navigation-demo.webm'
				)
			).toBe(
				'https://example.test/app/api/session/session-123/local-file/view?path=%2FUsers%2Fhannahwright%2FDocuments%2FCode%2FMeal%20Planner%2Foutput%2Fplaywright%2Fweek-navigation-demo.webm'
			);
		});
	});

	describe('findStreamableLocalFilePathsInText', () => {
		it('finds raw local file paths embedded in assistant text', () => {
			expect(
				findStreamableLocalFilePathsInText(
					'Open /Users/hannahwright/Documents/Code/Meal Planner/output/playwright/week-navigation-demo.webm or output/playwright/step-1.png'
				)
			).toEqual([
				'/Users/hannahwright/Documents/Code/Meal Planner/output/playwright/week-navigation-demo.webm',
				'output/playwright/step-1.png',
			]);
		});
	});
});
