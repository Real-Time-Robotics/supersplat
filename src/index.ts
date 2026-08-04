import './ui/scss/style.scss';
import { version as pcuiVersion, revision as pcuiRevision } from '@playcanvas/pcui';
import { version as stVersion, revision as stRevision } from '@playcanvas/splat-transform';
import { basisInitialize, version as engineVersion, revision as engineRevision } from 'playcanvas';

import { basisGlueUrl, basisWasmUrl } from './basis-cdn';
import { main } from './main';
import { version as appVersion } from '../package.json';

// print out versions of dependent packages
// NOTE: add dummy style reference to prevent tree shaking
console.log(`SuperSplat v${appVersion} | SplatTransform v${stVersion} (${stRevision}) | Engine v${engineVersion} (${engineRevision}) | PCUI v${pcuiVersion} (${pcuiRevision})`);

basisInitialize({
    glueUrl: basisGlueUrl,
    wasmUrl: basisWasmUrl,
    lazyInit: true
});

main();
