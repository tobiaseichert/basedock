// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

// Lint TypeScript in src/ and GJS JavaScript in tests/. scripts/lint.sh runs
// ESLint from the repository root, so the file patterns are relative to that
// directory.
//
// Use @stylistic for formatting and follow the GNOME Shell conventions in
// lint/eslintrc-gjs.yml and lint/eslintrc-shell.yml.
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const gjsGlobals = {
    ...globals.es2024,
    // GJS
    ARGV: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    console: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    // GNOME Shell
    global: 'readonly',
};

const style = {
    '@stylistic/array-bracket-newline': ['error', 'consistent'],
    '@stylistic/array-bracket-spacing': ['error', 'never'],
    '@stylistic/arrow-parens': ['error', 'as-needed'],
    '@stylistic/arrow-spacing': 'error',
    '@stylistic/block-spacing': 'error',
    '@stylistic/brace-style': ['error', '1tbs', {allowSingleLine: true}],
    '@stylistic/comma-dangle': ['error', {
        arrays: 'always-multiline',
        objects: 'always-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'never',
    }],
    '@stylistic/comma-spacing': 'error',
    '@stylistic/comma-style': 'error',
    '@stylistic/computed-property-spacing': 'error',
    '@stylistic/dot-location': ['error', 'property'],
    '@stylistic/eol-last': 'error',
    '@stylistic/function-call-spacing': 'error',
    '@stylistic/indent': ['error', 4, {
        // Wrapped conditions and argument lists are aligned freely, as in
        // GNOME Shell.
        ignoredNodes: [
            'CallExpression > ArrowFunctionExpression',
            'ConditionalExpression',
            'CallExpression > *',
            'NewExpression > *',
        ],
        MemberExpression: 'off',
        SwitchCase: 1,
    }],
    '@stylistic/key-spacing': ['error', {mode: 'minimum', beforeColon: false, afterColon: true}],
    '@stylistic/keyword-spacing': 'error',
    '@stylistic/linebreak-style': 'error',
    '@stylistic/max-statements-per-line': 'error',
    '@stylistic/new-parens': 'error',
    '@stylistic/no-tabs': 'error',
    '@stylistic/no-trailing-spaces': 'error',
    '@stylistic/no-whitespace-before-property': 'error',
    '@stylistic/nonblock-statement-body-position': ['error', 'below'],
    '@stylistic/object-curly-newline': ['error', {consistent: true}],
    '@stylistic/object-curly-spacing': ['error', 'never'],
    '@stylistic/operator-linebreak': ['error', 'after', {overrides: {'?': 'before', ':': 'before'}}],
    '@stylistic/padded-blocks': ['error', 'never'],
    '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
    '@stylistic/rest-spread-spacing': 'error',
    '@stylistic/semi': 'error',
    '@stylistic/semi-spacing': 'error',
    '@stylistic/space-before-blocks': 'error',
    '@stylistic/space-before-function-paren': ['error', {
        named: 'never',
        anonymous: 'never',
        asyncArrow: 'always',
    }],
    '@stylistic/space-in-parens': 'error',
    '@stylistic/space-infix-ops': 'error',
    '@stylistic/space-unary-ops': 'error',
    '@stylistic/spaced-comment': 'error',
    '@stylistic/switch-colon-spacing': 'error',
    '@stylistic/template-curly-spacing': 'error',
    '@stylistic/template-tag-spacing': 'error',
    '@stylistic/wrap-iife': ['error', 'inside'],
    '@stylistic/yield-star-spacing': 'error',
};

const correctness = {
    'camelcase': ['error', {
        // GObject properties and vfuncs are snake_case.
        properties: 'never',
        allow: ['^vfunc_', '^on_'],
    }],
    'consistent-return': 'error',
    'curly': ['error', 'multi-or-nest', 'consistent'],
    'eqeqeq': 'error',
    'no-caller': 'error',
    'no-constant-condition': ['error', {checkLoops: false}],
    'no-empty': ['error', {allowEmptyCatch: true}],
    'no-extra-bind': 'error',
    'no-implicit-coercion': ['error', {allow: ['!!']}],
    'no-lonely-if': 'error',
    'no-loop-func': 'error',
    'no-nested-ternary': 'error',
    'no-new-wrappers': 'error',
    'no-object-constructor': 'error',
    'no-proto': 'error',
    'no-return-assign': 'error',
    'no-self-compare': 'error',
    'no-template-curly-in-string': 'error',
    'no-throw-literal': 'error',
    'no-undef-init': 'error',
    'no-unneeded-ternary': 'error',
    'no-unused-expressions': 'error',
    'no-useless-call': 'error',
    'no-useless-computed-key': 'error',
    'no-useless-concat': 'error',
    'no-useless-rename': 'error',
    'no-useless-return': 'error',
    'no-var': 'error',
    'object-shorthand': 'error',
    'prefer-arrow-callback': 'error',
    'prefer-const': 'error',
    'prefer-promise-reject-errors': 'error',
    'prefer-rest-params': 'error',
    'prefer-spread': 'error',
    'prefer-template': 'error',
    'symbol-description': 'error',
    'yoda': 'error',
};

export default tseslint.config(
    {ignores: ['dist/', 'node_modules/', 'lint/node_modules/']},
    {
        files: ['src/**/*.ts', 'tests/**/*.js', 'lint/*.js'],
        extends: [js.configs.recommended],
        plugins: {'@stylistic': stylistic},
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            ...style,
            ...correctness,
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
        },
    },
    {
        // Use syntax-aware TypeScript lint rules here. npm run typecheck
        // checks the TypeScript project separately.
        files: ['src/**/*.ts'],
        extends: [tseslint.configs.recommended],
        rules: {
            'no-unused-vars': 'off',
            // tsc's noUnusedLocals/noUnusedParameters cover these.
            '@typescript-eslint/no-unused-vars': 'off',
            // Casting through `unknown` is how private shell API is reached.
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/consistent-type-imports': ['error', {fixStyle: 'inline-type-imports'}],
        },
    }
);
