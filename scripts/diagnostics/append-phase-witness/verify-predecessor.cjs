'use strict';
// Read-only prerequisite, selected only for250 and before any installation.
const fs = require('node:fs');
const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const demand = (condition, message) => { if (!condition) throw new Error(message); };
const assigned = JSON.parse(fs.readFileSync(process.argv[2]));
demand(assigned.state === 'ASSIGNED' && assigned.count === 250 && assigned.authorizedByRoot === true && assigned.authorizedByQueue === true, 'Separate250 assignment required');
const earlierBytes = fs.readFileSync(assigned.previous100Receipt.file);
const releasedBytes = fs.readFileSync(assigned.previous100Release.file);
demand(sha(earlierBytes) === assigned.previous100Receipt.sha256 && sha(releasedBytes) === assigned.previous100Release.sha256, 'Reviewed prior100 hashes mismatch');
const earlier = JSON.parse(earlierBytes); const released = JSON.parse(releasedBytes);
demand(earlier.count === 100 && earlier.head === assigned.head && earlier.tree === assigned.tree && earlier.packetManifestSha256 === assigned.packetManifestSha256 && earlier.sourceRestored && earlier.state === 'SHORT_WITNESS_COMPLETED_NOT_PERFORMANCE_OR_ENDURANCE_QUALIFICATION' && earlier.stages.length === 2 && earlier.stages.every(item => item.natural && item.exit.code === 0), 'Same-source/same-packet100 natural completion required before installation');
demand(released.state === 'RELEASED' && released.knownProcessBirthsAbsent === true && released.controllerAlreadyExited === true && released.sourceClean === true && released.outputMembersMatch === true && released.releasedBy?.pid !== earlier.controller.pid && released.receiptSha256 === sha(earlierBytes), 'Independently released100 required before installation');
process.stdout.write(JSON.stringify({ state: 'PRIOR100_REVIEWED_HASHES_MATCH_NATURAL_RESULT_AND_INDEPENDENT_RELEASE', receiptSha256: sha(earlierBytes), releaseSha256: sha(releasedBytes) }) + '\n');
