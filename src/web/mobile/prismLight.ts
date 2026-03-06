import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua';
import makefile from 'react-syntax-highlighter/dist/esm/languages/prism/makefile';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import perl from 'react-syntax-highlighter/dist/esm/languages/prism/perl';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import scala from 'react-syntax-highlighter/dist/esm/languages/prism/scala';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

const LANGUAGE_MAP: Record<string, string> = {
	bash: 'bash',
	c: 'c',
	cpp: 'cpp',
	'c++': 'cpp',
	cs: 'csharp',
	csharp: 'csharp',
	css: 'css',
	diff: 'diff',
	patch: 'diff',
	docker: 'docker',
	dockerfile: 'docker',
	go: 'go',
	golang: 'go',
	graphql: 'graphql',
	gql: 'graphql',
	html: 'markup',
	xml: 'markup',
	svg: 'markup',
	java: 'java',
	js: 'javascript',
	javascript: 'javascript',
	json: 'json',
	jsx: 'jsx',
	kt: 'kotlin',
	kotlin: 'kotlin',
	lua: 'lua',
	make: 'makefile',
	makefile: 'makefile',
	markdown: 'markdown',
	md: 'markdown',
	perl: 'perl',
	php: 'php',
	py: 'python',
	python: 'python',
	r: 'r',
	rb: 'ruby',
	ruby: 'ruby',
	rs: 'rust',
	rust: 'rust',
	scala: 'scala',
	scss: 'scss',
	sh: 'bash',
	shell: 'bash',
	sql: 'sql',
	swift: 'swift',
	toml: 'toml',
	ts: 'typescript',
	tsx: 'tsx',
	typescript: 'typescript',
	yaml: 'yaml',
	yml: 'yaml',
	zsh: 'bash',
};

const SUPPORTED_LANGUAGES = new Set<string>([
	'bash',
	'c',
	'cpp',
	'csharp',
	'css',
	'diff',
	'docker',
	'go',
	'graphql',
	'java',
	'javascript',
	'json',
	'jsx',
	'kotlin',
	'lua',
	'makefile',
	'markdown',
	'markup',
	'perl',
	'php',
	'python',
	'r',
	'ruby',
	'rust',
	'scala',
	'scss',
	'sql',
	'swift',
	'toml',
	'tsx',
	'typescript',
	'yaml',
]);

SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('c', c);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('csharp', csharp);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('diff', diff);
SyntaxHighlighter.registerLanguage('docker', docker);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('graphql', graphql);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('kotlin', kotlin);
SyntaxHighlighter.registerLanguage('lua', lua);
SyntaxHighlighter.registerLanguage('makefile', makefile);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('markup', markup);
SyntaxHighlighter.registerLanguage('perl', perl);
SyntaxHighlighter.registerLanguage('php', php);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('r', r);
SyntaxHighlighter.registerLanguage('ruby', ruby);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('scala', scala);
SyntaxHighlighter.registerLanguage('scss', scss);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('swift', swift);
SyntaxHighlighter.registerLanguage('toml', toml);
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('yaml', yaml);

export function normalizeMobileCodeLanguage(language: string | undefined): string {
	if (!language) {
		return 'text';
	}

	const normalized = language.toLowerCase().trim();
	const mappedLanguage = LANGUAGE_MAP[normalized] || normalized;
	return SUPPORTED_LANGUAGES.has(mappedLanguage) ? mappedLanguage : 'text';
}

export { SyntaxHighlighter };
