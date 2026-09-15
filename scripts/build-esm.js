// Emits a thin ESM entry so `import Raya from 'raya.js'` returns the class in native ESM too.
const fs = require('node:fs');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist');

fs.writeFileSync(
  path.join(dist, 'index.mjs'),
  "import cjs from './index.js';\nexport * from './index.js';\nexport default cjs.Raya;\n",
);
fs.writeFileSync(
  path.join(dist, 'index.d.mts'),
  "export * from './index.js';\nimport { Raya } from './index.js';\nexport default Raya;\n",
);
