import { promises as fs } from 'node:fs';
import { test, expect } from '@playwright/test';
import { createJourneyEnvironment } from '../../scripts/persona-browser-acceptance/environment.mjs';
import * as journey from './journey.steps.mjs';
import { journeyTestTitle, journeySteps } from '../../scripts/persona-browser-acceptance/evidence.mjs';

let environment;
test.beforeAll(async () => {
  environment = await createJourneyEnvironment({
    applicationRoot: process.env.PERSONA_JOURNEY_APP_DIR ?? process.cwd(),
    port: Number(process.env.PERSONA_JOURNEY_PORT ?? 4286),
  });
});
test.afterAll(async ({}, testInfo) => {
  if (!environment) return;
  await environment.close();
  await testInfo.attach('journey-final-process-and-effect-record', {
    body: JSON.stringify({ epochs: environment.epochs, fixtureEvents: environment.fixture.events }, null, 2),
    contentType: 'application/json',
  });
});

test(journeyTestTitle, async ({ page, context }, testInfo) => {
  let personaId;
  const detail = () => environment.request(`/v1/personas/${encodeURIComponent(personaId)}`);
  const completedEffects = token => environment.fixture.events.filter(event => event.kind === 'app_completed' && event.token === token);
  const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const observations = { mode: 'deterministic-browser-journey', qualityReview: 'not_evaluated',
    source: { commit: process.env.PERSONA_JOURNEY_COMMIT ?? null, runId: process.env.PERSONA_JOURNEY_RUN_ID ?? null }, steps: [] };
  const step = async (name, action) => test.step(name, async () => {
    await action();
    observations.steps.push({ name, passedAt: new Date().toISOString() });
  });
  try {
    await page.goto(`${environment.baseURL}/roles`);
    await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
    // The first-use privacy notice may cover form buttons. Closing it must not
    // change either privacy preference; that is a temporary UI action only.
    const notice = page.getByRole('alert').filter({ hasText: 'daily' });
    await expect(notice).toBeVisible();
    const noticeSettings = await environment.request('/api/storage?key=speech_settings');
    await notice.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(notice).toBeHidden();
    expect((await environment.request('/api/storage?key=speech_settings')).value).toEqual(noticeSettings.value);
    await step(journeySteps[0], () => journey.createRole(page));
    await step(journeySteps[1], async () => {
      await journey.createPersona(page);
      const personas = await environment.request('/v1/personas');
      expect(personas).toHaveLength(1);
      personaId = personas[0].id;
      expect(personaId).toBeTruthy();
      const state = await detail();
      expect(state.persona.name).toBe(journey.names.persona);
      expect(state.roleVersion.name).toBe(journey.names.role);
      expect(state.appGrants.map(grant => grant.mcpServerName).sort()).toEqual(['Journey receipt App', 'Journey replacement App']);
    });
    await step(journeySteps[2], async () => {
      await journey.configureFlows(page);
      const composition = (await detail()).persona.composition;
      expect(composition.coreFlowRef).toBe('journey-core');
      expect(composition.behaviors.find(item => item.name === 'Journey receipt specialist').binding.mode).toBe('shared');
    });
    await step(journeySteps[3], async () => {
      await journey.copySpecialist(page);
      const composition = (await detail()).persona.composition;
      const specialist = composition.behaviors.find(item => item.name === 'Journey receipt specialist');
      expect(specialist.binding.mode).toBe('persona_copy');
      expect(specialist.binding.sharedFlowRef).toBe('journey-specialist');
      expect(specialist.binding.personaFlowRef).not.toBe('journey-specialist');
    });
    await step(journeySteps[4], async () => {
      await journey.addAndCorrectMemory(page);
      await journey.previewForget(page);
      await expect(page.getByRole('dialog')).toContainText(/future work|history/);
      await journey.confirmForget(page);
      await expect(page.getByRole('region', { name: /^Forgotten/ })).toContainText('The journey meeting is on Wednesday.');
      const state = await detail();
      expect(state.memoryItems.find(item => item.content === 'The journey meeting is on Wednesday.').status).toBe('forgotten');
      expect(state.memoryItems.find(item => item.content === 'The journey meeting is on Tuesday.').status).toBe('superseded');
      expect(state.persona.composition.memoryRefs).toEqual([]);
    });
    await step(journeySteps[5], async () => {
      await journey.saveTask(page);
      await page.getByRole('link', { name: /^(Skip to content|Zum Inhalt springen)$/ }).press('Enter');
      await expect(page.getByRole('main')).toBeFocused();
      await expect(page).toHaveURL(/#main-content$/);
      const personaURL = page.url();
      await journey.sendChat(page, 'JOURNEY_CHAT: call the receipt specialist Behavior, then the granted receipt App, and report both actual results.');
      await expect(page.getByText('JOURNEY-BEHAVIOR-RECEIPT:verified', { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('JOURNEY_CHAT: complete; verified JOURNEY-APP-RECEIPT:JOURNEY_CHAT and JOURNEY-BEHAVIOR-RECEIPT:verified.', { exact: true })).toBeVisible();
      await expect.poll(() => completedEffects('JOURNEY_CHAT').length).toBe(1);
      await expect.poll(async () => (await detail()).activities.filter(activity => activity.status === 'completed' && activity.outcome?.resolution === 'succeeded').length).toBe(1);
      // Returning to a skip-link fragment must restore the Persona, not leave
      // the conversation rendered under the Persona URL.
      await page.goBack();
      await expect(page).toHaveURL(personaURL);
      await expect(page.getByRole('heading', { name: journey.names.persona, exact: true })).toBeVisible();
    });
    await step(journeySteps[6], async () => {
      const taskPageURL = page.url();
      const busyPage = await context.newPage();
      await busyPage.goto(taskPageURL);
      await journey.sendChat(busyPage, 'JOURNEY_BUSY: call the granted local receipt App and wait for its result.');
      await expect.poll(() => environment.fixture.events.some(event => event.kind === 'app_started' && event.token === 'JOURNEY_BUSY'), { timeout: 30_000 }).toBe(true);
      await journey.assignTask(page);
      await expect(page.getByText(/Task queued for this Persona|Waiting \/ queued/).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Assigned', exact: true })).toBeDisabled();
      const before = await detail();
      const task = before.workItems.find(item => item.title === 'Journey saved receipt');
      expect(before.mailboxItems.filter(item => item.source.sourceId === task.id && item.status === 'queued')).toHaveLength(1);
      expect(completedEffects('JOURNEY_TASK')).toHaveLength(0);
      await environment.restart();
      environment.fixture.releaseBusy();
      await page.reload();
      await expect.poll(async () => (await detail()).workItems.find(item => item.id === task.id).status, { timeout: 60_000 }).toBe('completed');
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Journey saved receipt', exact: true })).toBeVisible();
      const after = await detail();
      expect(after.mailboxItems.filter(item => item.source.sourceId === task.id)).toHaveLength(1);
      const assignments = after.activities.filter(activity => activity.kind === 'assignment');
      expect(assignments).toHaveLength(1);
      expect(assignments[0].status).toBe('completed');
      expect(assignments[0].outcome.resolution).toBe('succeeded');
      expect(completedEffects('JOURNEY_TASK')).toHaveLength(1);
      expect(environment.epochs).toHaveLength(2);
      expect(environment.epochs[0].exitedAt).toBeTruthy();
      expect(environment.epochs[1].pid).not.toBe(environment.epochs[0].pid);
      await busyPage.close();
    });
    await step(journeySteps[7], async () => {
      await journey.filterTaskHistory(page, since);
      await expect(page.getByLabel('On or after', { exact: true })).toHaveValue(since);
      await expect(page.getByText('Journey saved receipt', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open chat', exact: true })).toHaveCount(1);
      await journey.previewExport(page);
      await expect(page.getByRole('dialog')).toContainText('It does not contain private runtime or account data.');
      const pendingDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download configuration', exact: true }).click();
      const download = await pendingDownload;
      const exportedPath = testInfo.outputPath('persona-configuration.flujo.json');
      await download.saveAs(exportedPath);
      const exported = JSON.parse(await fs.readFile(exportedPath, 'utf8'));
      for (const key of ['secrets', 'models', 'mcpServers', 'plannedExecutions']) expect(exported[key]).toEqual([]);
      for (const key of ['memoryItems', 'activities', 'conversations', 'mailboxItems', 'appGrants']) expect(exported).not.toHaveProperty(key);
      expect(JSON.stringify(exported)).not.toContain('The journey meeting is on');
      expect(exported.personaTemplates).toHaveLength(1);
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await journey.previewDeletion(page);
      await expect(page.getByRole('dialog')).toContainText(/backups.*expiry|backups.*expire/i);
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Delete Persona', exact: true })).toBeDisabled();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Delete Persona', exact: true })).toBeFocused();
      expect((await detail()).persona.name).toBe(journey.names.persona);
    });
    await step(journeySteps[8], async () => {
      expect(await environment.request('/v1/personas', undefined, 'journey-isolation')).toEqual([]);
      const foreign = await fetch(`${environment.baseURL}/v1/personas/${encodeURIComponent(personaId)}?workspace=journey-isolation`);
      expect(foreign.status).toBe(404);
      expect(environment.fixture.events.filter(event => event.kind === 'fixture_error')).toEqual([]);
      expect(completedEffects('JOURNEY_TASK')).toHaveLength(1);
    });
  } finally {
    Object.assign(observations, { dataDir: environment.dataDir, buildId: environment.buildId, epochs: environment.epochs,
      fixtureEvents: environment.fixture.events, finalState: personaId ? await detail().catch(() => null) : null });
    await testInfo.attach('journey-observations', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
  }
});
