// The issue text for each problem a sweep found, and the plan of what to file: a new issue for a new
// problem, one comment per release on an issue that is still open, nothing twice.
export const SWEEP_LABEL = 'release-sweep';
export const ISSUE_LABELS = [SWEEP_LABEL, 'classification: BUG'];
export const DEFAULT_MAX_NEW = 10;
const KIND_ORDER = ['broken', 'instance', 'step', 'page-error'];

export const fingerprintMarker = (fingerprint) => `<!-- release-sweep:fingerprint=${fingerprint} -->`;
export const seenMarker = (version) => `<!-- release-sweep:seen=${version} -->`;

export function fingerprintsIn(text) {
  return [...String(text ?? '').matchAll(/<!-- release-sweep:fingerprint=(rs-[0-9a-f]{12}) -->/g)].map((match) => match[1]);
}

/** Inline code that cannot break out of its backticks. */
function code(text, max = 300) {
  const clean = String(text ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
  return `\`${clean.length > max ? `${clean.slice(0, max)}…` : clean}\``;
}

/** A fenced block that the text inside cannot close early. */
function fence(text, language) {
  return `\`\`\`\`${language}\n${String(text ?? '').replace(/````/g, "''''").trimEnd()}\n\`\`\`\``;
}

function mapLink(file, repo) {
  const target = `docs/feature-map/${file}`;
  return repo ? `[\`${target}\`](https://github.com/${repo}/blob/main/${target})` : `\`${target}\``;
}

function evidenceLine(check, runUrl) {
  const files = [check.evidence?.screenshot, check.evidence?.aria].filter(Boolean).map((file) => `\`${file}\``);
  if (!files.length) return undefined;
  const where = runUrl ? `in [the sweep's files](${runUrl}) (download the artifact)` : 'in the sweep\'s output folder';
  return `**Evidence:** ${files.join(' and ')} ${where}.`;
}

function stepBlock(check, repo) {
  const failed = check.failedStep;
  const lines = [
    `- **Page:** ${check.entryTitle} (${mapLink(check.file, repo)})`,
    `- **Step:** ${check.label} (\`${check.id}\`)`,
  ];
  if (failed?.step) lines.push(`- **Failed at:** step ${failed.index + 1} of ${failed.total}, ${code(`${failed.step.do} ${failed.step.role ?? ''} ${failed.step.name ?? failed.step.label ?? failed.step.text ?? failed.step.route ?? failed.step.key ?? ''}`)}`);
  if (check.error) lines.push(`- **Error:** ${code(check.error)}`);
  if (check.url) lines.push(`- **Address:** ${code(check.url)}`);
  return lines.join('\n');
}

/** Title, body and labels for a new issue. Everything in it comes from the report, nothing else. */
export function renderIssue(problem, { version, repo, runUrl, cameBackAfter } = {}) {
  const release = version ? `FLUJO ${version}` : 'this FLUJO build';
  const parts = [];
  if (cameBackAfter) parts.push(`This came back after #${cameBackAfter} was closed as done.`);
  if (problem.kind === 'broken') {
    parts.push(`The release sweep could not test ${release}: it stopped before it walked the feature map.`, `- **Reason:** ${code(problem.error)}`,
      'If FLUJO itself would not install or start, that is the bug. If the sweep machine failed (network, browser), run the sweep again.');
  } else if (problem.kind === 'instance') {
    parts.push(`While the release sweep used ${release}, FLUJO stopped answering. The checks after this point were not run.`, `- **Error:** ${code(problem.error)}`);
    const first = problem.checks[0];
    if (first) parts.push(`It happened during ${first.entryTitle} › ${first.label} (\`${first.id}\`).`);
  } else if (problem.kind === 'page-error') {
    parts.push(`While the release sweep used ${release} like a person would, the page threw an error in the browser.`, `- **Error:** ${code(problem.error)}`,
      `- **Seen during:**\n${problem.checks.slice(0, 10).map((check) => `  - ${check.entryTitle} › ${check.label} (\`${check.id}\`)`).join('\n')}`);
  } else {
    const [check] = problem.checks;
    parts.push(`The release sweep used ${release} like a person would, following the feature map, and this step failed.`, stepBlock(check, repo),
      'Either FLUJO broke here, or the feature map step no longer matches the page. Fix whichever is wrong.');
    const evidence = evidenceLine(check, runUrl);
    if (evidence) parts.push(evidence);
    if (check.ariaExcerpt) parts.push(`<details><summary>What the page showed (accessibility snapshot, start)</summary>\n\n${fence(check.ariaExcerpt, 'yaml')}\n\n</details>`);
    if (check.failedStep?.steps) parts.push(`<details><summary>Steps the sweep ran</summary>\n\n${fence(JSON.stringify(check.failedStep.steps, null, 2), 'json')}\n\n</details>`);
    parts.push(`**Try it yourself:**\n\n${fence(`npm run drive -- launch\nnpm run release:sweep -- --only ${check.entry}\nnpm run drive -- stop`, 'sh')}`);
  }
  if (problem.kind !== 'step' && runUrl) parts.push(`**Sweep files:** ${runUrl}`);
  parts.push('Found by the release sweep (`scripts/release-sweep/run.mjs`, see `docs/release-sweep.md`).');
  parts.push([fingerprintMarker(problem.fingerprint), ...(version ? [seenMarker(version)] : [])].join('\n'));
  return { title: problem.title, body: parts.join('\n\n'), labels: [...ISSUE_LABELS] };
}

export function renderComment(problem, { version, runUrl } = {}) {
  const check = problem.checks[0];
  const where = check ? ` during ${check.entryTitle} › ${check.label} (\`${check.id}\`)` : '';
  return [
    `Seen again in the release sweep of ${version ? `FLUJO ${version}` : 'a FLUJO build'}${where}: ${code(problem.error)}.${runUrl ? ` [Sweep files](${runUrl})` : ''}`,
    version ? seenMarker(version) : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * What to do for each problem, given the issues (open and closed) that carry the sweep label.
 * An issue closed as not planned silences its problem until someone reopens it.
 * @param {object[]} problems from problemsFromReport
 * @param {{ number: number, state?: string, stateReason?: string, body?: string, comments?: { body?: string }[] }[]} knownIssues
 */
export function planIssues(problems, knownIssues, { version, repo, runUrl, maxNew = DEFAULT_MAX_NEW } = {}) {
  const openByFingerprint = new Map();
  const closedByFingerprint = new Map();
  for (const issue of knownIssues) {
    const open = (issue.state ?? 'OPEN') === 'OPEN';
    for (const found of fingerprintsIn(issue.body)) {
      if (open && !openByFingerprint.has(found)) openByFingerprint.set(found, issue);
      if (!open && !(closedByFingerprint.get(found)?.number > issue.number)) closedByFingerprint.set(found, issue);
    }
  }
  const ordered = [...problems].sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
  const actions = [];
  let created = 0;
  for (const problem of ordered) {
    const issue = openByFingerprint.get(problem.fingerprint);
    const closed = closedByFingerprint.get(problem.fingerprint);
    if (issue) {
      const texts = [issue.body, ...(issue.comments ?? []).map((comment) => comment.body)];
      if (version && texts.some((text) => String(text ?? '').includes(seenMarker(version)))) {
        actions.push({ type: 'skip', number: issue.number, problem, reason: `already noted for ${version}` });
      } else actions.push({ type: 'comment', number: issue.number, problem, body: renderComment(problem, { version, runUrl }) });
    } else if (closed?.stateReason === 'NOT_PLANNED') {
      actions.push({ type: 'skip', number: closed.number, problem, reason: `closed as not planned in #${closed.number}; reopen it to hear about this again` });
    } else if (created < maxNew) {
      created += 1;
      actions.push({ type: 'create', problem, issue: renderIssue(problem, { version, repo, runUrl, cameBackAfter: closed?.number }) });
    } else {
      actions.push({ type: 'defer', problem, reason: `more than ${maxNew} new problems in one run; the next run files it` });
    }
  }
  return actions;
}

export function renderPlan(actions, { dryRun = true } = {}) {
  const count = (type) => actions.filter((action) => action.type === type).length;
  const lines = [
    `# Release sweep issues${dryRun ? ' (dry run: nothing was filed)' : ''}`,
    '',
    `${count('create')} new, ${count('comment')} seen again, ${count('skip')} already noted, ${count('defer')} left for the next run.`,
  ];
  for (const action of actions) {
    lines.push('', '---', '');
    if (action.type === 'create') {
      lines.push(`## New issue: ${action.issue.title}`, '', `Labels: ${action.issue.labels.join(', ')}`, '', action.issue.body);
    } else if (action.type === 'comment') {
      lines.push(`## Comment on #${action.number}: ${action.problem.title}`, '', action.body);
    } else {
      lines.push(`## ${action.type === 'skip' ? `Skip #${action.number}` : 'Later'}: ${action.problem.title}`, '', action.reason);
    }
  }
  return `${lines.join('\n')}\n`;
}
