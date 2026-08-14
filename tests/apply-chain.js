'use strict';
/**
 * Shared helper: apply fe/ or srv/ patch chains the same way boot does.
 * Empty patches.json (post-consolidation) is a no-op and returns the base file.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function applyChain(root, kind, baseFile) {
  let source = fs.readFileSync(path.join(root, baseFile), 'utf8').replace(/\r\n/g, '\n');
  let sha = crypto.createHash('sha256').update(source).digest('hex');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : `patches-${n}.json`;
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const patches = Array.isArray(spec.patches) ? spec.patches : [];
    // Consolidation leaves an empty patches.json placeholder — skip hash gates.
    if (!patches.length) break;
    assert.strictEqual(spec.baseSha256, sha, `${kind}/${name} continues the chain`);
    for (const [index, patch] of patches.entries()) {
      const count = source.split(patch.find).length - 1;
      assert.strictEqual(count, patch.count || 1, `${kind}/${name} patch ${index + 1} anchor count`);
      source = source.split(patch.find).join(patch.replace);
    }
    sha = crypto.createHash('sha256').update(source).digest('hex');
    assert.strictEqual(spec.expectedSha256, sha, `${kind}/${name} effective hash`);
  }
  return source;
}

module.exports = { applyChain };
