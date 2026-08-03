/** Short, varied status jokes for long-running chats. */

type MessageFamily = {
  count: number;
  render: (variant: number) => string;
};

export const MAX_WORKING_MESSAGE_LENGTH = 88;
export const WORKING_MESSAGE_INTERVAL_MS = 10_000;

const actors = [
  'the moon janitor', 'a time-hopping intern', 'three union pigeons',
  'the office wizard', 'a skeptical goldfish', 'the museum ghost',
  'an off-duty oracle', 'the last polite pirate', 'a raccoon committee',
  'the cryptid expert', 'a calm astronaut', 'the royal beekeeper',
  'the lighthouse cat', 'a future detective', 'the backup dragon',
  'a jetpack accountant', 'the submarine butler', 'a retired villain',
  'the support goose', 'a help-desk knight', 'an imaginary conductor',
  'an archaeology intern', 'the weather crow', 'a receipt philosopher',
] as const;

const objects = [
  'the moon ladder', 'a diplomatic sock', 'the royal stapler',
  'an indoor umbrella', 'the lunch compass', 'a warm snow globe',
  'the last teaspoon', 'a fictional map', 'the folding napkin',
  'a jar of thunder', 'the Wi-Fi wand', 'a lawyered sandwich',
  'the spare sun', 'a jar of silence', 'the haunted printer',
  'a load-bearing baguette', 'the tiny drawbridge', 'the wrong key',
  'the inflatable anvil', 'a prophecy coupon', 'the reverse telescope',
  'classified confetti', 'the nervous pendulum', 'a pocket volcano',
] as const;

const places = [
  'on the Moon', 'at the seafloor post office', 'at the Bermuda gift shop',
  'at the Wi-Fi castle', 'behind the second attic', 'at North Pole support',
  'on platform nine-ish', 'beside a black hole', 'inside the mood library',
  'under the cloud', 'in the office kitchen', 'inside spreadsheet forest',
  'at volcano reception', 'behind the old clock', 'in Lost Luggage',
  'on the snack balcony', 'in the shallow moat', 'at the desert hotel',
  'inside the failed museum', 'in lab number two', 'at tomorrow station',
  'inside dragon training', 'on Tuesday Island', 'past the supply closet',
] as const;

const tasks = [
  'sorting moon rocks', 'looking for lunch', 'testing the fire alarm',
  'folding space-time', 'counting invisible sheep', 'polishing the eclipse',
  'fixing yesterday', 'mapping the snack drawer', 'questioning the compass',
  'training the pigeons', 'debugging the horoscope', 'watering plastic plants',
  'auditing the pirates', 'rewinding the sundial', 'interviewing a shadow',
  'filing dragon taxes', 'calibrating breakfast', 'alphabetizing fog',
  'measuring gossip', 'rehearsing the alibi', 'charging the crystal ball',
  'untangling gravity', 'translating whale mail', 'backing up the Moon',
] as const;

const skills = [
  'fold a fitted sheet', 'whistle in binary', 'park a gondola',
  'alphabetize fog', 'moonwalk quietly', 'invoice a dragon',
  'juggle theories', 'read the room', 'argue with a door',
  'brew orbital tea', 'translate sarcasm', 'defeat a sundial',
  'smuggle daylight', 'assemble a prophecy', 'locate north',
  'interview tomorrow', 'budget on a unicycle', 'write in zero gravity',
  'herd digital cats', 'repair a metaphor', 'land a paper plane',
  'greet the abyss', 'exit a time loop', 'explain medieval taxes',
] as const;

const mysteries = [
  'the Moon’s back door', 'Wednesday’s location', 'gravity’s fine print',
  'the missing socks', 'the Morse-code plant', 'the speakerphone echo',
  'the pigeon payroll', 'the painted horizon', 'the absent staircase',
  'Tuesday’s sequel', 'the Gary compass', 'the second ocean',
  'the dramatic copier', 'tomorrow’s mail', 'the extra five minutes',
  'the licensed ghost', 'the reviewed treasure map', 'the hungry plot hole',
  'the sorted stars', 'the sighing elevator', 'the thunder receipts',
  'the lunch eclipse', 'the freelance mirror', 'the exit to 1843',
] as const;

const tools = [
  'a bent paperclip', 'a rubber chicken', 'the good magnifier',
  'one brave teaspoon', 'a future abacus', 'a cat laser',
  'an accordion', 'a dishonest ruler', 'a memo compass',
  'the royal whisk', 'a pocket sundial', 'two magnets',
  'a Latin wrench', 'the tiny hammer', 'tenured tape',
  'a crystal ball', 'a haunted slide rule', 'the backup kazoo',
  'a gloomy spirit level', 'the left telescope', 'a stern clipboard',
  'emergency string', 'a weather vane', 'the manual page',
] as const;

const events = [
  'the eclipse rehearsal', 'emergency teatime', 'the gravity inspection',
  'the office moon landing', 'the password ceremony', 'yesterday’s reopening',
  'the hiding finals', 'the underwater fire drill', 'the time-traveler meeting',
  'the lighthouse picnic', 'the backup launch', 'the horizon retirement',
  'the expedition talent show', 'bring-your-ghost night', 'Coincidence Day',
  'Small Ben’s unveiling', 'the silent concert', 'the endless ribbon-cutting',
  'the volcano open house', 'breakfast rehearsal', 'the maritime spelling bee',
  'the ancient Wi-Fi demo', 'the alibi parade', 'the surprise-party audit',
] as const;

const twists = [
  'the inspector walks in', 'the inventor denies it', 'the footnote calls',
  'the lights blink in Morse', 'tomorrow asks for help', 'the witness appears',
  'the smoke alarm passes', 'the prophecy arrives', 'every clock coughs',
  'the fire drill gets real', 'the squirrels object', 'the Moon calls back',
  'the red lever starts counting', 'the alibi walks past', 'next door repeats it',
  'the backup plan resigns', 'the weather apologizes', 'the map says “you first”',
  'the missing page falls out', 'Coincidence Day is canceled', 'the goose takes charge',
  'the empty box takes notes', 'a comet arrives early', 'the narrator gets fired',
] as const;

const verdicts = [
  'the goose approves', 'the timeline objects', 'the manual shrugs',
  'lunch takes priority', 'the pigeons demand credit', 'the chart looks worried',
  'the calendar resigns', 'history asks for a redo', 'the printer applauds',
  'gravity clocks out', 'the map denies everything', 'the ghost files a claim',
  'the budget grows a moat', 'the experiment gets renewed', 'the floor adds a door',
  'the ducks peer-review it', 'management calls it tradition', 'confetti is deployed',
  'the loop requests closure', 'a plaque is ordered', 'physics grants an exception',
  'the cupboard applauds', 'the conclusion needs edits', 'the universe closes the ticket',
] as const;

const createFamily = (
  vocabularies: readonly (readonly string[])[],
  write: (...words: string[]) => string,
): MessageFamily => {
  const count = vocabularies.reduce((product, vocabulary) => product * vocabulary.length, 1);
  return {
    count,
    render: (variant: number) => {
      let cursor = variant;
      const words = vocabularies.map(vocabulary => {
        const word = vocabulary[cursor % vocabulary.length];
        cursor = Math.floor(cursor / vocabulary.length);
        return word;
      });
      return `${write(...words)}…`;
    },
  };
};

const capitalize = (text: string): string => `${text[0].toUpperCase()}${text.slice(1)}`;

const messageFamilies: MessageFamily[] = [
  createFamily([actors, skills], (a, s) => `Teaching ${a} to ${s}`),
  createFamily([objects, places], (o, p) => `Finding ${o} ${p}`),
  createFamily([tasks, verdicts], (t, v) => `${capitalize(t)}; ${v}`),
  createFamily([mysteries, tools], (m, t) => `Solving ${m} with ${t}`),
  createFamily([objects, tools], (o, t) => `Repairing ${o} with ${t}`),
  createFamily([events, actors], (e, a) => `Rehearsing ${e} with ${a}`),
  createFamily([actors, tasks], (a, t) => `Helping ${a} finish ${t}`),
  createFamily([objects, verdicts], (o, v) => `Showing off ${o}; ${v}`),
  createFamily([mysteries, places], (m, p) => `Investigating ${m} ${p}`),
  createFamily([skills, tools], (s, t) => `Trying to ${s} with ${t}`),
  createFamily([objects, twists], (o, x) => `Hiding ${o} just as ${x}`),
  createFamily([events, twists], (e, x) => `Starting ${e} as ${x}`),
  createFamily([actors, objects], (a, o) => `${capitalize(a)} arrives carrying ${o}`),
  createFamily([tasks, twists], (t, x) => `While ${t}, ${x}`),
  createFamily([mysteries, actors], (m, a) => `Discovering ${m}; ${a} takes credit`),
  createFamily([objects, verdicts], (o, v) => `Testing ${o}; ${v}`),
  createFamily([places, actors], (p, a) => `Arriving ${p}; ${a} was already there`),
  createFamily([events, twists], (e, x) => `${capitalize(e)} begins moments before ${x}`),
  createFamily([actors, mysteries], (a, m) => `Asking ${a} about ${m}`),
  createFamily([skills, twists], (s, x) => `Learning to ${s} seconds before ${x}`),
  createFamily([objects, actors], (o, a) => `Returning ${o} to ${a}`),
  createFamily([events, places], (e, p) => `Booking ${e} ${p}`),
  createFamily([mysteries, twists], (m, x) => `Checking ${m} when ${x}`),
  createFamily([tasks, actors], (t, a) => `${capitalize(t)} with ${a}`),
  createFamily([objects, verdicts], (o, v) => `Calibrating ${o}; ${v}`),
  createFamily([events, tools], (e, t) => `Running ${e} with ${t}`),
  createFamily([actors, places], (a, p) => `Following ${a} ${p}`),
  createFamily([mysteries, verdicts], (m, v) => `Explaining ${m}; ${v}`),
  createFamily([tasks, tools], (t, tool) => `${capitalize(t)} with ${tool}`),
  createFamily([objects, events], (o, e) => `Preparing ${o} for ${e}`),
  createFamily([places, tools], (p, t) => `Taking notes ${p} with ${t}`),
  createFamily([actors, events], (a, e) => `Briefing ${a} on ${e}`),
  createFamily([objects, mysteries], (o, m) => `Checking ${o} against ${m}`),
  createFamily([places, verdicts], (p, v) => `Mapping ${p}; ${v}`),
  createFamily([actors, tools], (a, t) => `Helping ${a} use ${t}`),
  createFamily([events, mysteries], (e, m) => `Linking ${e} to ${m}`),
  createFamily([skills, actors], (s, a) => `Watching ${a} learn to ${s}`),
  createFamily([tasks, events], (t, e) => `${capitalize(t)} before ${e}`),
  createFamily([objects, places], (o, p) => `Delivering ${o} ${p}`),
  createFamily([actors, places], (a, p) => `Meeting ${a} ${p}`),
  createFamily([mysteries, events], (m, e) => `Discussing ${m} at ${e}`),
  createFamily([skills, places], (s, p) => `Trying to ${s} ${p}`),
  createFamily([tasks, objects], (t, o) => `${capitalize(t)} around ${o}`),
  createFamily([events, places], (e, p) => `Hosting ${e} ${p}`),
  createFamily([objects, mysteries], (o, m) => `Comparing ${o} with ${m}`),
  createFamily([actors, twists], (a, x) => `Meeting ${a} just as ${x}`),
  createFamily([tools, verdicts], (t, v) => `Pointing ${t} north; ${v}`),
  createFamily([skills, events], (s, e) => `Practicing how to ${s} at ${e}`),
];

/** 27,648 compact messages across 48 distinct sentence structures. */
export const WORKING_MESSAGE_COUNT = messageFamilies.reduce((total, family) => total + family.count, 0);

const gcd = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
};

const mix32 = (value: number): number => {
  let mixed = value | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
};

const coprimeStep = (size: number, seed: number): number => {
  let step = (mix32(seed) % (size - 1)) + 1;
  while (gcd(step, size) !== 1) step = (step % (size - 1)) + 1;
  return step;
};

/** Visits every sentence family before returning to one, in a run-seeded order. */
export const getWorkingMessage = (sequence: number, runSeed: number): string => {
  const safeSequence = Math.max(0, Math.floor(sequence));
  const safeSeed = Math.floor(runSeed);
  const familyCount = messageFamilies.length;
  const familyOffset = mix32(safeSeed) % familyCount;
  const familyStride = coprimeStep(familyCount, safeSeed ^ 0x6d2b79f5);
  const familyIndex = (familyOffset + safeSequence * familyStride) % familyCount;
  const family = messageFamilies[familyIndex];
  const familyRound = Math.floor(safeSequence / familyCount);
  const variantOffset = mix32(safeSeed ^ Math.imul(familyIndex + 1, 0x9e3779b1)) % family.count;
  const variantStride = coprimeStep(family.count, safeSeed ^ Math.imul(familyIndex + 1, 0x85ebca6b));
  const variant = (variantOffset + familyRound * variantStride) % family.count;
  return family.render(variant);
};
