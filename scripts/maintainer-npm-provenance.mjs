import path from 'node:path';

const repository = 'mario-andreschak/FLUJO';
const workflow = `${repository}/.github/workflows/publish-npm.yml`;
const sourceRef = 'refs/heads/main';
const workflowURI = `https://github.com/${workflow}@${sourceRef}`;
const predicateType = 'https://slsa.dev/provenance/v1';
const maxBytes = 4 * 1024 * 1024;

function assertPin(options) {
  const encoded = options.integrity?.match(/^sha512-([A-Za-z0-9+/]{86}==)$/)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(options.version ?? '')
      || !/^[a-f0-9]{40}$/.test(options.artifactSourceRevision ?? '')
      || !encoded || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
    throw new Error('Npm provenance requires the exact version, SHA-512 integrity and source pin.');
  }
  return Buffer.from(encoded, 'base64').toString('hex');
}

/** Bounded registry reads; fixtures can provide transport, never a CLI bypass. */
export async function fetchNpmProvenance(options, { directory, capture, signal, fetchResponse = fetch }) {
  assertPin(options);
  const readJson = async (url, name) => {
    const response = await fetchResponse(url, { redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Npm provenance read returned ${response.status}.`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Npm provenance response exceeds 4 MiB.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    await capture(name, bytes);
    return JSON.parse(bytes.toString('utf8'));
  };
  const metadataUrl = `https://registry.npmjs.org/flujo-ai/${options.version}`;
  const attestationsUrl = `https://registry.npmjs.org/-/npm/v1/attestations/flujo-ai@${options.version}`;
  const tarballUrl = `https://registry.npmjs.org/flujo-ai/-/flujo-ai-${options.version}.tgz`;
  const metadata = await readJson(metadataUrl, 'npm-version.json');
  if (metadata?.name !== 'flujo-ai' || metadata.version !== options.version
      || metadata.dist?.integrity !== options.integrity || metadata.dist?.tarball !== tarballUrl
      || metadata.dist?.attestations?.url !== attestationsUrl
      || metadata.dist.attestations.provenance?.predicateType !== predicateType) {
    throw new Error('Published npm metadata differs from the pin or official provenance endpoint.');
  }
  const attestations = await readJson(attestationsUrl, 'npm-attestations.json');
  if (!Array.isArray(attestations?.attestations)) throw new Error('Published npm provenance bundles are missing or malformed.');
  const bundles = attestations.attestations.filter(item => item?.predicateType === predicateType).map(item => item.bundle);
  if (!Array.isArray(bundles) || !bundles.length || bundles.some(bundle => !bundle?.dsseEnvelope || !bundle.verificationMaterial)) {
    throw new Error('Published npm provenance bundles are missing or malformed.');
  }
  const bundleName = 'npm-provenance-bundles.jsonl';
  // Preserve each complete Sigstore bundle. Decoded predicates are not signer evidence.
  await capture(bundleName, bundles.map(bundle => JSON.stringify(bundle)).join('\n') + '\n');
  return { metadataUrl, attestationsUrl, bundlePath: path.join(directory, bundleName), bundles: bundles.length };
}

/** Accept only successful gh cryptographic verification plus the pinned certificate/subject policy. */
export function verifyNpmProvenance(options, { archive, bundlePath }, run) {
  const sha512 = assertPin(options);
  if (!path.isAbsolute(archive) || !path.isAbsolute(bundlePath)) throw new Error('Absolute private provenance paths are required.');
  const verified = JSON.parse(run('gh', ['attestation', 'verify', archive, '--bundle', bundlePath,
    '--repo', repository, '--hostname', 'github.com', '--signer-workflow', workflow,
    '--source-ref', sourceRef, '--source-digest', options.artifactSourceRevision,
    '--signer-digest', options.artifactSourceRevision, '--deny-self-hosted-runners',
    '--digest-alg', 'sha512', '--predicate-type', predicateType,
    '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com', '--format', 'json']));
  if (!Array.isArray(verified) || !verified.length) throw new Error('No cryptographically verified npm provenance returned.');
  const attestations = verified.map(item => {
    const result = item?.verificationResult;
    const certificate = result?.signature?.certificate;
    const expected = {
      issuer: 'https://token.actions.githubusercontent.com', subjectAlternativeName: workflowURI,
      buildSignerURI: workflowURI, buildSignerDigest: options.artifactSourceRevision,
      sourceRepositoryURI: `https://github.com/${repository}`, sourceRepositoryDigest: options.artifactSourceRevision,
      sourceRepositoryRef: sourceRef, runnerEnvironment: 'github-hosted',
      buildConfigURI: workflowURI, buildConfigDigest: options.artifactSourceRevision,
    };
    if (!certificate || Object.entries(expected).some(([key, value]) => certificate[key] !== value)
        || !Array.isArray(result.verifiedTimestamps) || !result.verifiedTimestamps.length
        || result.statement?.predicateType !== predicateType
        || !Array.isArray(result.statement.subject)
        || !result.statement.subject.some(subject => subject?.name === `pkg:npm/flujo-ai@${options.version}` && subject.digest?.sha512 === sha512)) {
      throw new Error('Verified npm provenance does not satisfy the pinned certificate and package policy.');
    }
    return { certificate: expected, verifiedTimestamps: result.verifiedTimestamps,
      subject: { name: `pkg:npm/flujo-ai@${options.version}`, sha512 } };
  });
  return { result: 'passed-pinned-npm-provenance', version: options.version,
    sourceRevision: options.artifactSourceRevision, integrity: options.integrity, attestations,
    registryEcdsaSignaturesVerified: false, fullDistributionQualified: false, independentHumanAcceptance: false };
}
