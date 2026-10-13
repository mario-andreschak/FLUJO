'use strict';

/** Native 1.3.3 exposes a TSV catalog, not a models JSON flag. Project only the
 * verified two-column format; a catalog never proves account entitlement. */
function parseNativeModels(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 1024 * 1024) {
    throw new Error('Antigravity model catalog exceeded its limit.');
  }
  const models = [];
  const seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(parts[0])
        || !parts[1].trim() || parts[1].length > 500 || /[\x00-\x1f\x7f]/.test(parts[1])
        || seen.has(parts[0]) || models.length >= 512) {
      throw new Error('Antigravity returned an unsupported model catalog.');
    }
    seen.add(parts[0]);
    models.push({ id: parts[0], name: parts[1].trim() });
  }
  if (!models.length) throw new Error('Antigravity returned an empty model catalog.');
  return models;
}

module.exports = { parseNativeModels };
