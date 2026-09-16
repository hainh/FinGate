import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'db/**/*.js',
      'apps/web/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // fg/no-raw-color (DS §12.2): screen cấm hex literal — chỉ tokens.css + theme.ts được phép.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/app/theme.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}/]",
          message: 'fg/no-raw-color: hex literal bị cấm trong apps/web — dùng var(--fg-*) hoặc Fg* props.',
        },
        {
          selector: "TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}/]",
          message: 'fg/no-raw-color: hex trong template literal bị cấm — dùng var(--fg-*).',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Cấm parseFloat với tiền — dùng money()/parseMoneyInput() của @fingate/shared (DS §19.5-1).' },
      ],
    },
  },
);
