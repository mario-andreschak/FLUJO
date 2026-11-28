// The issue text for each problem a sweep found, and the plan of what to file: a new issue for a new
// problem, one comment per release on an issue that already tracks it, nothing twice. A run opens at most
// MAX_NEW_ISSUES problem issues; the rest wait in one summary issue that later runs work down and close.
export const SWEEP_LABEL = 'release-sweep';
export const ISSUE_LABELS = [SWEEP_LABEL, 'classification: BUG'];
export const MAX_NEW_ISSUES = 5;
export const OVERFLOW_MARKER = '<!-- release-sweep:overflow -->';
const OVERFLOW_LIST_MAX = 100;
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

const releaseName = (version) => (version ? `FLUJO ${version}` : 'this FLUJO build');
const isRelease = (version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version ?? ''));

function evidenceLine(check, { runUrl, evidenceUrl }) {
  const files = [check.evidence?.screenshot, check.evidence?.aria].filter(Boolean).map((file) => `\`${file}\``);
  if (!files.length) return undefined;
  const where = evidenceUrl ? `in [the sweep's evidence files](${evidenceUrl})`
    : runUrl ? `in [the sweep's files](${runUrl}) (download the artifact)` : "in the sweep's output folder";
  return `**Proof:** the screenshot and accessibility snapshot ${files.join(' and ')} ${where}.`;
}

function stepBlock(check, repo) {
  const failed = check.failedStep;
  const lines = [
    `- **Page:** ${check.entryTitle} (${mapLink(check.file, repo)})`,
    `- **Step:** ${check.label} (\`${check.id}\`)`,
  ];
  if (failed?.step) lines.push(`- **Failed at:** step ${failed.index + 1} of ${failed.total}, ${code(`${failed.step.do} ${failed.step.role ?? ''} ${failed.step.name ?? failed.step.label ?? failed.step.text ?? failed.step.route ?? failed.step.key ?? ''}`)}`);
  if (check.error) lines.push(`- **Error:** ${code(check.error)}`);
  if (check.retryError && check.retryError !== check.error) lines.push(`- **Second try:** ${code(check.retryError)}`);
  if (check.url) lines.push(`- **Address:** ${code(check.url)}`);
  return lines.join('\n');
}

function reproduce(check, version) {
  return isRelease(version)
    ? `npm run release:sweep -- --release ${version} --only ${check.entry}`
    : `npm run drive -- launch\nnpm run release:sweep -- --only ${check.entry}\nnpm run drive -- stop`;
}

/** Title, body and labels for a new issue. Everything in it comes from the report, nothing else. */
export function renderIssue(problem, { version, repo, runUrl, evidenceUrl, cameBackAfter } = {}) {
  const release = releaseName(version);
  const parts = [];
  if (cameBackAfter) parts.push(`This came back after #${cameBackAfter} was closed as done.`);
  if (problem.kind === 'broken') {
    parts.push(`The release sweep could not test ${release}: it stopped before the first page.`, `- **Reason:** ${code(problem.error)}`,
      'The sweep machine was fine (its own failures are retried and never filed), so the reason above is on the FLUJO side: '
        + 'the release would not install or start, or the feature map has no step the sweep can run.');
  } else if (problem.kind === 'instance') {
    parts.push(`While the release sweep used ${release}, FLUJO stopped answering. The checks after this point were not run.`, `- **Error:** ${code(problem.error)}`);
    const first = problem.checks[0];
    if (first) parts.push(`It happened during ${first.entryTitle} › ${first.label} (\`${first.id}\`).`);
  } else if (problem.kind === 'page-error') {
    parts.push(`While the release sweep used ${release} like a person would, the page threw an error in the browser.`, `- **Error:** ${code(problem.error)}`,
      `- **Seen during:**\n${problem.checks.slice(0, 10).map((check) => `  - ${check.entryTitle} › ${check.label} (\`${check.id}\`)`).join('\n')}`);
  } else {
    const [check] = problem.checks;
    parts.push(`The release sweep used ${release} like a person would, following the feature map, and this step failed${check.confirmed ? ' twice in a row, each time in a fresh browser' : ''}.`, stepBlock(check, repo),
      'Either FLUJO broke here, or the feature map step no longer matches the page. Fix whichever is wrong.');
    const evidence = evidenceLine(check, { runUrl, evidenceUrl });
    if (evidence) parts.push(evidence);
    if (check.ariaExcerpt) parts.push(`<details open><summary>What the page showed (accessibility snapshot, start)</summary>\n\n${fence(check.ariaExcerpt, 'yaml')}\n\n</details>`);
    if (check.failedStep?.steps) parts.push(`<details><summary>Steps the sweep ran</summary>\n\n${fence(JSON.stringify(check.failedStep.steps, null, 2), 'json')}\n\n</details>`);
    parts.push(`**Try it yourself:**\n\n${fence(reproduce(check, version), 'sh')}`);
  }
  if (problem.kind !== 'step' && (evidenceUrl || runUrl)) parts.push(`**Sweep files:** ${evidenceUrl ?? runUrl}`);
  parts.push('Found by the release sweep (`scripts/release-sweep/run.mjs`, see `docs/release-sweep.md`).');
  parts.push([fingerprintMarker(problem.fingerprint), ...(version ? [seenMarker(version)] : [])].join('\n'));
  return { title: problem.title, body: parts.join('\n\n'), labels: [...ISSUE_LABELS] };
}

export function renderComment(problem, { version, runUrl, evidenceUrl, closedNumber } = {}) {
  const check = problem.checks[0];
  const where = check ? ` during ${check.entryTitle} › ${check.label} (\`${check.id}\`)` : '';
  const link = evidenceUrl ?? runUrl;
  return [
    `Seen again in the release sweep of ${releaseName(version)}${where}: ${code(problem.error)}.${link ? ` [Sweep files](${link})` : ''}`,
    closedNumber ? `That release was made before #${closedNumber} was closed, so it cannot hold the fix yet. The sweep of the next release checks again and opens a new issue only if it still fails there.` : '',
    version ? seenMarker(version) : '',
  ].filter(Boolean).join('\n\n');
}

function overflowList(problems) {
  const lines = problems.slice(0, OVERFLOW_LIST_MAX)
    .map((problem) => `- \`${problem.fingerprint}\` ${problem.title.replace(/^Release sweep: /, '')}: ${code(problem.error, 160)}`);
  if (problems.length > OVERFLOW_LIST_MAX) lines.push(`- and ${problems.length - OVERFLOW_LIST_MAX} more, listed in the run summary`);
  return lines.join('\n');
}

export function renderOverflow(problems, { version, runUrl, evidenceUrl, maxNew = MAX_NEW_ISSUES } = {}) {
  const link = evidenceUrl ?? runUrl;
  return {
    title: `Release sweep: ${problems.length} more problems in ${releaseName(version)} wait for their own issue`,
    body: [
      `The release sweep of ${releaseName(version)} found more new problems than it opens issues for in one run (${maxNew}). These wait here:`,
      overflowList(problems),
      `**How this clears itself:** problems that already have an issue only get a comment and do not count, so each following sweep opens issues for the next ${maxNew} problems on this list that still happen. When a sweep has walked every page and nothing is left waiting, it closes this issue.`,
      ...(link ? [`**Sweep files:** ${link}`] : []),
      'Found by the release sweep (`scripts/release-sweep/run.mjs`, see `docs/release-sweep.md`).',
      [OVERFLOW_MARKER, ...(version ? [seenMarker(version)] : [])].join('\n'),
    ].join('\n\n'),
    labels: [...ISSUE_LABELS],
  };
}

const mentions = (issue, marker) => [issue.body, ...(issue.comments ?? []).map((comment) => comment.body)]
  .some((text) => String(text ?? '').includes(marker));

/** An issue closed after the release was made cannot have its fix in that release. Unknown dates count as recent, so nothing is filed twice. */
function closedAfterRelease(issue, releasedAt) {
  const closed = Date.parse(issue.closedAt ?? '');
  const released = Date.parse(releasedAt ?? '');
  return Number.isNaN(closed) || Number.isNaN(released) || closed >= released;
}

/**
 * What to do for each problem, given the issues (open and closed) that carry the sweep label.
 * - An open issue with the fingerprint gets one comment per release.
 * - A closed one: closed as not planned keeps the problem quiet; closed after the release was made gets a comment
 *   (the fix cannot be in it yet); closed before that means the problem came back, so a new issue links the old one.
 * - At most `maxNew` new problem issues; the rest go into one summary issue (or a comment on the open one).
 * - When the sweep walked every page and nothing waits, the open summary issue is closed.
 * @param {object[]} problems from problemsFromReport
 * @param {{ number: number, state?: string, stateReason?: string, closedAt?: string, body?: string, comments?: { body?: string }[] }[]} knownIssues
 */
export function planIssues(problems, knownIssues, {
  version, repo, runUrl, evidenceUrl, releasedAt, walkComplete = false, maxNew = MAX_NEW_ISSUES,
} = {}) {
  const openByFingerprint = new Map();
  const closedByFingerprint = new Map();
  let overflowIssue;
  for (const issue of knownIssues) {
    const open = (issue.state ?? 'OPEN') === 'OPEN';
    if (open && String(issue.body ?? '').includes(OVERFLOW_MARKER) && !(overflowIssue?.number < issue.number)) overflowIssue = issue;
    for (const found of fingerprintsIn(issue.body)) {
      const byFingerprint = open ? openByFingerprint : closedByFingerprint;
      const current = byFingerprint.get(found);
      if (!current || (open ? issue.number < current.number : issue.number > current.number)) byFingerprint.set(found, issue);
    }
  }
  const noted = (issue) => Boolean(version) && mentions(issue, seenMarker(version));
  const ordered = [...problems].sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
  const actions = [];
  const waiting = [];
  for (const problem of ordered) {
    const title = problem.title;
    const open = openByFingerprint.get(problem.fingerprint);
    const closed = closedByFingerprint.get(problem.fingerprint);
    if (open) {
      actions.push(noted(open) ? { type: 'skip', number: open.number, title, problem, reason: `already noted for ${version}` }
        : { type: 'comment', number: open.number, title, problem, body: renderComment(problem, { version, runUrl, evidenceUrl }) });
    } else if (closed?.stateReason === 'NOT_PLANNED') {
      actions.push({ type: 'skip', number: closed.number, title, problem, reason: `closed as not planned in #${closed.number}; reopen it to hear about this again` });
    } else if (closed && closedAfterRelease(closed, releasedAt)) {
      actions.push(noted(closed) ? { type: 'skip', number: closed.number, title, problem, reason: `already noted for ${version}` }
        : { type: 'comment', number: closed.number, title, problem, body: renderComment(problem, { version, runUrl, evidenceUrl, closedNumber: closed.number }) });
    } else if (actions.filter((action) => action.type === 'create').length < maxNew) {
      actions.push({ type: 'create', title, problem, issue: renderIssue(problem, { version, repo, runUrl, evidenceUrl, cameBackAfter: closed?.number }) });
    } else {
      waiting.push(problem);
      actions.push({ type: 'defer', title, problem, reason: `waits in the summary issue; a later sweep files it (at most ${maxNew} new issues per run)` });
    }
  }
  if (waiting.length) {
    const overflow = renderOverflow(waiting, { version, runUrl, evidenceUrl, maxNew });
    if (!overflowIssue) actions.push({ type: 'create', title: overflow.title, overflow: true, issue: overflow });
    else if (noted(overflowIssue)) actions.push({ type: 'skip', number: overflowIssue.number, title: overflow.title, reason: `already noted for ${version}` });
    else {
      actions.push({
        type: 'comment', number: overflowIssue.number, title: overflow.title, overflow: true,
        body: [`The sweep of ${releaseName(version)} found ${waiting.length} problems still waiting for their own issue:`, overflowList(waiting),
          ...(version ? [seenMarker(version)] : [])].join('\n\n'),
      });
    }
  } else if (overflowIssue && walkComplete) {
    actions.push({
      type: 'close', number: overflowIssue.number, title: 'Release sweep summary issue',
      body: `The sweep of ${releaseName(version)} walked every page, and every problem from this list now has its own issue or no longer happens.`,
    });
  }
  return actions;
}

export function renderPlan(actions, { dryRun = true, runnerNotes = [], secondTry = [] } = {}) {
  const count = (type) => actions.filter((action) => action.type === type).length;
  const lines = [
    `# Release sweep issues${dryRun ? ' (dry run: nothing was filed)' : ''}`,
    '',
    `${count('create')} new, ${count('comment')} seen again, ${count('skip')} already noted, ${count('defer')} waiting in the summary issue`
      + `${count('close') ? ', summary issue closed' : ''}. ${runnerNotes.length} caused by the sweep machine (not filed).`,
  ];
  for (const action of actions) {
    lines.push('', '---', '');
    if (action.type === 'create') {
      lines.push(`## New issue: ${action.issue.title}`, '', `Labels: ${action.issue.labels.join(', ')}`, '', action.issue.body);
    } else if (action.type === 'comment') {
      lines.push(`## Comment on #${action.number}: ${action.title}`, '', action.body);
    } else if (action.type === 'close') {
      lines.push(`## Close #${action.number}: ${action.title}`, '', action.body);
    } else {
      lines.push(`## ${action.type === 'skip' ? `Skip #${action.number}` : 'Waiting'}: ${action.title}`, '', action.reason);
    }
  }
  if (runnerNotes.length) {
    lines.push('', '---', '', '## Caused by the sweep machine, not filed', '',
      'These were retried and still failed for reasons outside FLUJO. The next release\'s sweep runs them again.', '');
    for (const note of runnerNotes) lines.push(`- ${note.where}: ${note.cause} (${code(note.error, 200)})`);
  }
  if (secondTry.length) {
    lines.push('', '---', '', '## Passed only on the second try, not filed', '',
      'Each failed once and passed when the sweep ran it again in a fresh browser. A step that keeps doing this fails twice in some later sweep and gets an issue then.', '');
    for (const check of secondTry) lines.push(`- ${check.entryTitle} › ${check.label} (\`${check.id}\`): ${code(check.firstError, 200)}`);
  }
  return `${lines.join('\n')}\n`;
}
