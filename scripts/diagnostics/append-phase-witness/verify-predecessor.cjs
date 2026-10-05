'use strict';
// Read-only prerequisite, selected only for250 and before any installation.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { assertReleasedPredecessor } = require('./controller-terminal.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const demand = (condition, message) => { if (!condition) throw new Error(message); };
const assigned = JSON.parse(fs.readFileSync(process.argv[2]));
demand(assigned.state === 'ASSIGNED' && assigned.count === 250 && assigned.authorizedByRoot === true && assigned.authorizedByQueue === true, 'Separate250 assignment required');
const earlierBytes = fs.readFileSync(assigned.previous100Receipt.file);
const releasedBytes = fs.readFileSync(assigned.previous100Release.file);
demand(sha(earlierBytes) === assigned.previous100Receipt.sha256 && sha(releasedBytes) === assigned.previous100Release.sha256, 'Reviewed prior100 hashes mismatch');
assertReleasedPredecessor(earlierBytes, releasedBytes, assigned);
process.stdout.write(JSON.stringify({ state: 'PRIOR100_REVIEWED_HASHES_MATCH_NATURAL_RESULT_AND_INDEPENDENT_RELEASE', receiptSha256: sha(earlierBytes), releaseSha256: sha(releasedBytes) }) + '\n');
