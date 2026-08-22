import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['build/**', 'admin/**', 'coverage/**', 'node_modules/**', '.review/**'],
    },
    {
        rules: {
            // This project documents intent where it is not obvious rather than annotating every
            // symbol; the blanket JSDoc rules only produce empty stubs when auto-fixed.
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
            'jsdoc/require-returns': 'off',
        },
    },
    {
        // The package and integration suites run under mocha, not jest.
        files: ['test/package.js', 'test/integration.js'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                it: 'readonly',
                before: 'readonly',
                after: 'readonly',
            },
        },
    },
];
