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
];
