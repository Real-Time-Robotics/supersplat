import { rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import { rollup } from 'rollup';

const output = path.resolve('scripts/.model-import-smoke-tmp.mjs');
try {
    const bundle = await rollup({
        input: 'scripts/model-import-smoke.ts',
        plugins: [
            typescript({
                tsconfig: false,
                include: ['scripts/model-import-smoke.ts', 'src/model/*.ts', 'src/scene-content-policy.ts'],
                compilerOptions: {
                    target: 'es2022',
                    module: 'esnext',
                    moduleResolution: 'bundler',
                    lib: ['es2022', 'dom', 'webworker'],
                    strictNullChecks: false,
                    skipLibCheck: true
                }
            }),
            resolve()
        ]
    });
    await bundle.write({ file: output, format: 'esm' });
    await bundle.close();
    await import(`${pathToFileURL(output).href}?t=${Date.now()}`);
} finally {
    await rm(output, { force: true });
}
