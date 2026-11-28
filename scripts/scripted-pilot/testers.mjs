// The scripted first-time users. Each one opens a fresh FLUJO with an empty data folder and works
// through the tester guide's day-one tasks on a different screen size, the way testers in the
// pilot would arrive with different computers.

export const TESTERS = Object.freeze([
  {
    id: 'p01-desk',
    name: 'Tester p01: desktop screen',
    description: 'Uses a wide desktop window (1600 x 900), where the whole top navigation is visible.',
    viewport: { width: 1600, height: 900 },
  },
  {
    id: 'p02-laptop',
    name: 'Tester p02: laptop screen',
    description: 'Uses a laptop window (1280 x 720), where the navigation sits behind the menu button.',
    viewport: { width: 1280, height: 720 },
  },
  {
    id: 'p03-phone',
    name: 'Tester p03: phone-sized window',
    description: 'Uses a narrow window the size of a phone (390 x 844).',
    viewport: { width: 390, height: 844 },
  },
]);

/** The testers named on the command line, in the fixed order above. */
export function pickTesters(only) {
  if (!only) return [...TESTERS];
  const wanted = String(only).split(',').map((entry) => entry.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !TESTERS.some((tester) => tester.id === id));
  if (unknown.length) throw new Error(`Unknown tester ${unknown.join(', ')}; choose from ${TESTERS.map((tester) => tester.id).join(', ')}.`);
  return TESTERS.filter((tester) => wanted.includes(tester.id));
}
