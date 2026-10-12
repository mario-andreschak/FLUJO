const path = require('node:path');
const { globSync: maintainedGlobSync } = require('tinyglobby');

// This adapter is scoped to the single glob API used by the pinned Next lint
// plugin, the lockfile's only consumer. A future caller change must fail visibly
// rather than silently skip lint coverage; this is not a general fast-glob API.
function globSync(pattern, options) {
  if (typeof pattern !== 'string' || options?.onlyDirectories !== true
      || Object.keys(options).length !== 1) {
    throw new Error('Next lint glob adapter only supports directory-root discovery.');
  }
  return maintainedGlobSync(pattern, {
    onlyDirectories: true,
    // fast-glob matches literal directory roots without expanding descendants.
    expandDirectories: false,
    absolute: path.isAbsolute(pattern),
  });
}

module.exports = { globSync };
