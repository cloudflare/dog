/**
 * @type {import('cfw').Config}
 */
module.exports = {
	entry: 'index.ts',
	build(config) {
		// Allow esbuild to load HTML files
		config.loader = config.loader || {};
		config.loader['.html'] = 'text';
	}
};
