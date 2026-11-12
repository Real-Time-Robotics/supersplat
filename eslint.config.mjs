import playcanvasConfig from '@playcanvas/eslint-config';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';

const withImportX = config => {
    if (!config.plugins?.import) return config;
    const { import: _import, ...plugins } = config.plugins;
    return {
        ...config,
        plugins: { ...plugins, 'import-x': importX },
        rules: Object.fromEntries(Object.entries(config.rules ?? {}).map(
            ([name, value]) => [name.replace(/^import\//, 'import-x/'), value]
        ))
    };
};

const cloudflareResolver = {
    name: 'cloudflare',
    interfaceVersion: 3,
    resolve: source => ({ found: source.startsWith('cloudflare:'), path: null })
};

export default [
    {
        ignores: ['src/genesis-recon/schema.d.ts']
    },
    ...playcanvasConfig.map(withImportX),
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            globals: {
                ...globals.browser,
                ...globals.serviceworker,
                BlobPart: 'readonly',
                DurableObjectState: 'readonly',
                Env: 'readonly',
                ExportedHandler: 'readonly',
                SqlStorage: 'readonly',
                SqlStorageValue: 'readonly'
            }
        },
        plugins: {
            '@typescript-eslint': tsPlugin
        },
        settings: {
            'import-x/resolver-next': [cloudflareResolver, createTypeScriptImportResolver()]
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'jsdoc/require-param': 'off',
            'jsdoc/require-param-type': 'off',
            'jsdoc/require-returns': 'off',
            'jsdoc/require-returns-type': 'off',
            'jsdoc/check-tag-names': 'off',
            'lines-between-class-members': 'off',
            'no-await-in-loop': 'off',
            'require-atomic-updates': 'off'
        }
    }, {
        files: ['worker/**/*.ts', 'src/backend/**/*.ts', 'src/genesis-recon/**/*.ts'],
        rules: {
            'no-undef': 'off'
        }
    }, {
        files: ['src/**/*.test.ts'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'import-x/extensions': 'off',
            'require-await': 'off',
            'regexp/prefer-w': 'off',
            'regexp/use-ignore-case': 'off'
        }
    }, {
        files: ['**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'import-x/no-unresolved': 'off'
        }
    }
];
