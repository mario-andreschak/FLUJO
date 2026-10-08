import readline from 'node:readline';
import { createJourneyEnvironment } from './environment.mjs';

// Terminal control for a CUA/manual run of the same fixtures used by CI.
const environment = await createJourneyEnvironment({ applicationRoot: process.argv[2] ?? process.cwd(), port: Number(process.argv[3] ?? 4286) });
console.log(JSON.stringify({ ready: true, dataDir: environment.dataDir, baseURL: environment.baseURL }));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try {
    if (line === 'restart') { await environment.restart(); console.log(JSON.stringify({ restarted: true, epochs: environment.epochs })); }
    else if (line === 'release') { environment.fixture.releaseBusy(); console.log('Released busy receipt.'); }
    else if (line === 'inspect') console.log(JSON.stringify(await environment.inspect()));
    else if (line === 'stop') { input.close(); break; }
    else console.log('Commands: inspect, release, restart, stop');
  } catch (error) { console.error(String(error)); }
}
await environment.close();
