import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/** @type {import('eslint').Linter.Config[]} */
const config = [
  // Next.js recommended rules (includes React, React Hooks, and Next.js-specific checks)
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Warn on any types — many already exist in the codebase (see issue H-5);
      // raising to 'error' should be a follow-up once the WS handlers are typed.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow intentionally unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Catch unguarded console.log calls in production code (issue LOW-1)
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];

export default config;
