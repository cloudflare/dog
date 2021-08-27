import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

let dir = path.dirname(fileURLToPath(import.meta.url));
let entry = path.join(dir, '../src/index.ts');

await build({
	bundle: true,
	target: 'esnext',
	entryPoints: [entry],
	outfile: 'index.js',
	charset: 'utf8',
	format: 'esm',

	sourcemap: false,
	treeShaking: true,
	logLevel: 'info',
});
