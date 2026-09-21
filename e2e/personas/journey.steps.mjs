// Shared user actions. No fixture HTTP, storage writes, or internal IDs here.
// Uses the locator subset also available through the Codex CUA browser API.
export const names = Object.freeze({
  role: 'Journey teammate', persona: 'Journey Alex',
  prompt: 'Carry out the requested local acceptance task, using only the granted receipt App and specialist Behavior.',
});

export async function createRole(page) {
  await page.getByRole('link', { name: /^(New Role|Neue Rolle)$/ }).click();
  await page.getByRole('textbox', { name: /^(Role name|Name der Rolle)$/ }).fill(names.role);
  await page.getByRole('textbox', { name: /^(What should this Role do\?|Was soll diese Rolle tun\?)$/ }).fill(names.prompt);
  await page.getByRole('button', { name: /^(Choose Apps|Apps auswählen)$/ }).click();
  await page.getByRole('checkbox', { name: 'Journey receipt App', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Journey alternate App', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Close|Schließen)$/ }).click();
  await page.getByRole('button', { name: /^(Save Role|Rolle speichern)$/ }).click();
  await page.getByRole('heading', { name: names.role, exact: true }).waitFor({ state: 'visible' });
}

export async function createPersona(page) {
  await page.getByRole('tab', { name: 'Personas', exact: true }).click();
  await page.getByRole('button', { name: /^(Create Persona|Persona erstellen)$/ }).first().click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(names.persona);
  await page.getByRole('textbox', { name: /^(One-sentence purpose \(optional\)|Aufgabe in einem Satz \(optional\))$/ }).fill('Verify the local teammate journey.');
  const next = () => page.getByRole('button', { name: /^(Next|Weiter)$/ }).click();
  await next();
  await page.getByRole('radio', { name: names.role, exact: true }).click();
  await next();
  // The Role's suggestions are preselected; retain one and replace the other.
  await page.getByRole('checkbox', { name: 'Journey alternate App', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Journey replacement App', exact: true }).click();
  await next();
  await page.getByRole('button', { name: /^(Skip|Überspringen)$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Create Persona|Persona erstellen)$/ }).click();
  await page.getByRole('heading', { name: names.persona, exact: true }).waitFor({ state: 'visible' });
}

export async function configureFlows(page) {
  await page.getByRole('tab', { name: /^(Behaviors|Verhaltensweisen)$/ }).click();
  await page.getByRole('button', { name: /^(Change Flow|Flow ändern)$/ }).first().click();
  await page.getByLabel('Journey model-ready Core', { exact: true })
    .getByRole('button', { name: /^(Use this Flow|Diesen Flow verwenden)$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^(Add Behavior|Verhaltensweise hinzufügen)$/ }).click();
  await page.getByLabel('Journey receipt specialist', { exact: true })
    .getByRole('button', { name: /^(Use this Flow|Diesen Flow verwenden)$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Journey receipt specialist', exact: true }).waitFor({ state: 'visible' });
}

export async function copySpecialist(page) {
  await page.getByRole('button', { name: /^(Change Flow|Flow ändern)$/ }).last().click();
  await page.getByLabel('Journey receipt specialist', { exact: true })
    .getByRole('button', { name: /^(Make a copy for this Persona|Kopie für diese Persona erstellen)$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Journey receipt specialist Journey Alex', exact: true }).waitFor({ state: 'visible' });
}

export async function addAndCorrectMemory(page) {
  await page.getByRole('tab', { name: /^(Memory|Erinnerung)$/ }).click();
  await page.getByRole('button', { name: /^(Add memory|Erinnerung hinzufügen)$/ }).click();
  const content = () => page.getByRole('textbox', { name: /^(What should this Persona remember\?|Was soll sich diese Persona merken\?)$/ });
  await content().fill('The journey meeting is on Tuesday.');
  await page.getByRole('dialog').getByRole('button', { name: /^(Add memory|Erinnerung hinzufügen)$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^(Correct|Korrigieren)$/ }).click();
  await content().fill('The journey meeting is on Wednesday.');
  await page.getByRole('dialog').getByRole('button', { name: /^(Save|Speichern)$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^(Mark important|Als wichtig markieren)$/ }).click();
  await page.getByRole('button', { name: /^(See earlier versions \(1\)|Frühere Versionen ansehen \(1\))$/ }).click();
  await page.getByText('The journey meeting is on Tuesday.', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /^(Unpin from core|Aus Kernerinnerungen lösen)$/ }).click();
}

export async function previewForget(page) {
  await page.getByRole('button', { name: /^(Forget|Vergessen)$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Cancel|Abbrechen)$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^(Forget|Vergessen)$/ }).click();
}

export async function confirmForget(page) {
  await page.getByRole('dialog').getByRole('button', { name: /^(Forget|Vergessen)$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

export async function saveTask(page) {
  await page.getByRole('tab', { name: /^(Tasks|Aufgaben)$/ }).click();
  await page.getByRole('button', { name: /^(New Task|Neue Aufgabe)$/ }).click();
  await page.getByRole('textbox', { name: /^(Title|Titel)$/ }).fill('Journey saved receipt');
  await page.getByRole('textbox', { name: /^(Description|Beschreibung)$/ }).fill('JOURNEY_TASK: obtain one receipt from the granted local App, then finish.');
  await page.getByRole('textbox', { name: /^(Next step|Nächster Schritt)$/ }).fill('Call the receipt App with JOURNEY_TASK.');
  await page.getByRole('dialog').getByRole('button', { name: /^(Save|Speichern)$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Journey saved receipt', exact: true }).waitFor({ state: 'visible' });
}

export async function sendChat(page, text) {
  await page.getByRole('button', { name: /^(Chat|Chatten)$/ }).click();
  // Conversation loading renders a composer before the Persona target is ready.
  // Wait for the visible target before entering the first message.
  await page.getByRole('button', { name: /^Journey Alex ·/ }).waitFor({ state: 'visible' });
  await page.getByRole('textbox', { name: /^(Message|Nachricht)$/ }).fill(text);
  await page.getByRole('button', { name: /^(Send message|Nachricht senden)$/ }).click();
}

export async function assignTask(page) {
  await page.getByRole('button', { name: /^(Assign|Zuweisen)$/ }).click();
  await page.getByRole('button', { name: /^(Assigned|Zugewiesen)$/ }).waitFor({ state: 'visible' });
}

export async function filterTaskHistory(page, since) {
  await page.getByRole('tab', { name: /^(History|Aktivitätsverlauf)$/ }).click();
  await page.getByRole('combobox', { name: /^(Type|Typ)(?:\s|$)/ }).click();
  await page.getByRole('option', { name: /^(Task|Aufgabe)$/ }).click();
  await page.getByRole('combobox', { name: /^(Status|State)(?:\s|$)/ }).click();
  await page.getByRole('option', { name: /^(Completed|Abgeschlossen)$/ }).click();
  await page.getByLabel(/^(On or after|Am oder nach)$/).fill(since);
}

export async function previewExport(page) {
  await page.getByRole('main').getByRole('tab', { name: /^(Settings|Einstellungen)$/ }).click();
  await page.getByRole('button', { name: /^(Preview export|Exportvorschau)$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Download configuration|Konfiguration herunterladen)$/ }).waitFor({ state: 'visible' });
}

export async function previewDeletion(page) {
  await page.getByRole('button', { name: /^(Delete Persona|Persona löschen)$/ }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: /DELETE/ }).waitFor({ state: 'visible' });
}
