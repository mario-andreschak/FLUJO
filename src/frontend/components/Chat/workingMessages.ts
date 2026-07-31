/**
 * Long-running chats deserve better than a short activity list with suffixes
 * bolted onto it.  This module is a small procedural comedy writer: each
 * family has its own sentence shape and compatible vocabulary, and the
 * sequencer walks families and variants in deterministic, non-repeating
 * permutations.  Nothing random changes during a render.
 */

type MessageFamily = {
  count: number;
  render: (variant: number) => string;
};

const characters = [
  'the Moon’s night janitor', 'a time-traveling intern', 'three unionized pigeons',
  'the neighborhood wizard', 'a deeply skeptical goldfish', 'the museum’s newest ghost',
  'an off-duty oracle', 'the last honest pirate', 'a committee of raccoons',
  'the office cryptozoologist', 'a surprisingly calm astronaut', 'the royal beekeeper',
  'the lighthouse keeper’s cat', 'a detective from next Thursday', 'the village’s backup dragon',
  'an accountant with a jetpack', 'the submarine’s etiquette officer', 'a retired supervillain',
  'the expedition’s emotional-support goose', 'a knight from customer support',
  'the train conductor’s imaginary friend', 'an archaeologist in slippers',
  'the weather station’s resident crow', 'a philosopher who only answers in receipts',
] as const;

const objects = [
  'the emergency moon ladder', 'a left sock with diplomatic immunity', 'the ceremonial stapler',
  'an umbrella labeled “indoor use only”', 'the spare compass that points to lunch',
  'a suspiciously warm snow globe', 'the department’s last clean teaspoon',
  'a map of places that deny existing', 'the prototype self-folding napkin',
  'a briefcase full of polite thunder', 'the antique Wi-Fi divining rod',
  'a sandwich with its own legal counsel', 'the backup sun', 'a jar of premium silence',
  'the haunted office printer', 'an extremely load-bearing baguette',
  'the pocket-sized drawbridge', 'a key marked “probably not this one”',
  'the inflatable anvil', 'a coupon for one free prophecy', 'the reversible telescope',
  'a wheelbarrow of classified confetti', 'the world’s least decisive pendulum',
  'a small but ambitious volcano',
] as const;

const places = [
  'the Moon’s lost-and-found', 'an underwater post office', 'the Bermuda Triangle gift shop',
  'a castle with suspiciously good Wi-Fi', 'the attic behind the other attic',
  'the North Pole’s complaint department', 'platform nine and three quarters-ish',
  'the quiet end of a black hole', 'a library shelved by emotional intensity',
  'the basement of the cloud', 'the international waters of the office kitchen',
  'a forest currently pretending to be a spreadsheet', 'the volcano’s visitors’ center',
  'the tiny door behind the grandfather clock', 'the republic of Lost Luggage',
  'the observatory’s snack balcony', 'the castle moat’s shallow end',
  'a desert with excellent room service', 'the museum of almost-correct inventions',
  'the second-most-secret laboratory', 'the train station at the end of causality',
  'the dragon’s fire-safety seminar', 'an island visible only on Tuesdays',
  'the supply closet’s northern frontier',
] as const;

const tools = [
  'one bent paperclip', 'a calibrated rubber chicken', 'the good magnifying glass',
  'a teaspoon and unreasonable confidence', 'an abacus borrowed from the future',
  'a laser pointer approved by three cats', 'the emergency accordion',
  'a ruler that exaggerates slightly', 'a compass and a strongly worded memo',
  'the laboratory’s ceremonial whisk', 'a pocket sundial', 'two magnets and an alibi',
  'a wrench translated from the original Latin', 'the tiny hammer reserved for diplomacy',
  'a roll of tape with tenure', 'an ethically sourced crystal ball',
  'a slide rule haunted by fractions', 'the expedition’s backup kazoo',
  'a spirit level with low self-esteem', 'the left-handed telescope',
  'a clipboard of uncertain authority', 'four meters of emergency string',
  'a borrowed weather vane', 'the instruction manual’s missing page',
] as const;

const skills = [
  'fold a fitted sheet in four dimensions', 'whistle in a legally distinct key',
  'parallel-park a gondola', 'alphabetize fog', 'moonwalk without disturbing the tides',
  'forge a doctor’s note for a dragon', 'juggle increasingly theoretical objects',
  'read the room’s source code', 'negotiate with an automatic door',
  'brew tea at escape velocity', 'translate sarcasm into semaphore',
  'win an argument with a sundial', 'smuggle daylight through customs',
  'assemble furniture from the prophecy alone', 'tell north from suspiciously north',
  'interview a witness who has not happened yet', 'balance a budget on a unicycle',
  'write cursive in zero gravity', 'herd cats across a loading screen',
  'perform first aid on a metaphor', 'land a paper airplane in international waters',
  'make small talk with the abyss', 'reverse politely out of a time loop',
  'explain taxes to a medieval peasant',
] as const;

const mysteries = [
  'why the Moon has a service entrance', 'who keeps moving Wednesday',
  'whether gravity has read the terms and conditions', 'where all the matching socks defected to',
  'why the office plant knows Morse code', 'who put the echo on speakerphone',
  'whether pigeons are billing by the hour', 'why the horizon looks freshly painted',
  'where the staircase goes on its lunch break', 'who authorized a sequel to Tuesday',
  'why the compass keeps pointing at Gary', 'whether the sea is just extremely committed soup',
  'who taught the photocopier dramatic timing', 'why the future keeps returning our mail',
  'where the extra five minutes came from', 'whether the castle is zoned for hauntings',
  'why the treasure map has restaurant reviews', 'who keeps feeding the plot holes',
  'whether the stars are alphabetized from the other side', 'why the elevator sighs at floor seven',
  'where the thunder stores its receipts', 'who scheduled the eclipse during lunch',
  'whether the mirror is freelancing', 'why the emergency exit leads to 1843',
] as const;

const claims = [
  'gravity is only a strongly held opinion', 'Tuesday can be postponed with enough paperwork',
  'the Moon is mostly decorative', 'every maze has a customer-service desk',
  'time flies because walking was over budget', 'the ocean is hiding a second, smaller ocean',
  'all ravens share one extremely busy lawyer', 'history is written by whoever found a pen',
  'the shortest distance between two points is under renovation',
  'a watched kettle merely becomes self-conscious', 'clouds are mountains with commitment issues',
  'the floor is lava only during business hours', 'silence is just sound wearing formal clothes',
  'mirrors are windows with excellent boundaries', 'the map is avoiding the territory',
  'luck is outsourced coincidence', 'every locked door is a wall with ambitions',
  'the early bird is covering somebody else’s shift', 'facts travel faster when carrying gossip',
  'all prophecies are drafts until approved', 'the Sun is running a very long free trial',
  'common sense is currently in beta', 'the past has an aggressive returns policy',
  'reality rounds up at checkout',
] as const;

const evidence = [
  'a receipt dated next Thursday', 'three footprints leading into a wall',
  'a pie chart drawn by an actual pie', 'the testimony of a very nervous hat',
  'an alibi written in disappearing ink', 'a voicemail from the Bronze Age',
  'one feather wearing a visitor badge', 'a map that blushes near the border',
  'the minutes from tomorrow’s meeting', 'a shadow with the wrong forwarding address',
  'four identical keys and no visible lock', 'an eyewitness account from the mirror',
  'a weather forecast for indoors', 'the fingerprints of someone wearing oven mitts',
  'a bookmark found at the scene', 'an invoice for seven metric mysteries',
  'a trail of increasingly formal breadcrumbs', 'security footage filmed in watercolor',
  'the sworn statement of a garden gnome', 'an ominous but properly formatted spreadsheet',
  'a compass pointing firmly at the suspect', 'the original napkin calculations',
  'a tiny parachute with no registered owner', 'a note saying “this is not a clue”',
] as const;

const records = [
  'the minutes from a meeting that never occurred', 'a permit to operate one moonbeam',
  'the dragon’s expense report', 'an apology addressed to the concept of distance',
  'the unabridged history of the lunch queue', 'a warranty for the laws of physics',
  'the lighthouse’s performance review', 'a cease-and-desist from the future',
  'the treasure map’s privacy policy', 'the official taxonomy of awkward silences',
  'a user manual for déjà vu', 'the penguins’ collective-bargaining agreement',
  'a strongly footnoted ghost story', 'the castle’s annual moat survey',
  'an incident report filed by the incident', 'the instruction manual for Wednesday',
  'a peer-reviewed shopping list', 'the classified appendix to the phone book',
  'a risk assessment for opening this risk assessment', 'the prophecy’s change log',
  'the submarine’s upstairs floor plan', 'a passport issued to an idea',
  'the weather’s written explanation', 'the terms of service for coincidence',
] as const;

const formats = [
  'a strongly worded puppet show', 'interpretive semaphore', 'a twelve-slide cave painting',
  'an opera for one nervous kazoo', 'a legally binding limerick', 'a pop-up spreadsheet',
  'a detective novel with only footnotes', 'a weather forecast performed by spoons',
  'an annotated treasure map', 'a silent film with aggressive subtitles',
  'a bar chart made of actual bars', 'a medieval group chat', 'a three-act voicemail',
  'a tasteful arrangement of warning cones', 'a sonnet with technical diagrams',
  'an escape room for accountants', 'a very small parade', 'a recipe with courtroom sketches',
  'a flowchart that knows too much', 'a constellation visible from the break room',
  'a memo delivered by trebuchet', 'a musical number in the original binary',
  'an emotionally available pie chart', 'a documentary narrated by the suspect',
] as const;

const events = [
  'the annual eclipse rehearsal', 'the emergency tea ceremony', 'a surprise inspection of gravity',
  'the interdepartmental moon landing', 'the ceremonial changing of the Wi-Fi password',
  'the grand reopening of yesterday', 'the regional hide-and-seek finals',
  'a fire drill for the underwater office', 'the quarterly meeting of anonymous time travelers',
  'the lighthouse’s indoor picnic', 'the official launch of the backup plan',
  'a retirement party for the old horizon', 'the expedition’s mandatory talent show',
  'the castle’s bring-your-own-ghost night', 'the first annual coincidence convention',
  'the unveiling of the smaller Big Ben', 'the neighborhood’s silent alarm concert',
  'a ribbon-cutting for the infinite corridor', 'the volcano’s open-house afternoon',
  'the rehearsal dinner for breakfast', 'the maritime spelling bee',
  'the museum’s live demonstration of ancient Wi-Fi', 'the parade of plausible deniability',
  'the surprise audit of the surprise party',
] as const;

const coincidenceMoments = [
  'the fire inspector walks in holding burnt toast',
  'the inventor arrives to deny inventing it',
  'the one person mentioned in the footnote calls',
  'the lights flicker in perfect Morse code',
  'tomorrow phones to ask for its receipt back',
  'the missing witness emerges from the coat rack',
  'the smoke alarm chooses that moment to pass its exam',
  'the prophecy is delivered with the groceries',
  'every clock in the building clears its throat',
  'the emergency drill becomes unexpectedly relevant',
  'a lawyer for the squirrels requests a sidebar',
  'the Moon sends a calendar invitation',
  'the “decorative” lever begins counting down',
  'the alibi walks past the window wearing sunglasses',
  'a second, identical meeting starts next door',
  'the backup plan asks to speak privately',
  'the weather apologizes and does it anyway',
  'the map adds a tiny “you are kidding” marker',
  'someone finds the exact missing page under the manual',
  'the coincidence department closes for coincidence',
  'the only adult in the room turns out to be the goose',
  'the supposedly empty box starts taking minutes',
  'a comet arrives several centuries early for the appointment',
  'the narrator is asked to leave the premises',
] as const;

const outcomes = [
  'the paperwork remains cautiously optimistic', 'the control group demands a sequel',
  'nobody makes eye contact with the lever', 'the hypothesis requests legal representation',
  'lunch is promoted to a critical dependency', 'the committee calls it “mostly reproducible”',
  'the nearest calendar quietly resigns', 'three historians ask for a clean take',
  'the manual insists this is the expected behavior', 'morale improves for completely unrelated reasons',
  'the graph develops a concerning subplot', 'the witness changes species mid-statement',
  'the budget gains a mysterious weather category', 'the experiment is renewed for another season',
  'the floor plan adds an escape clause', 'the results are peer-reviewed by nearby ducks',
  'management upgrades the problem to a tradition', 'the emergency confetti is deployed',
  'the timeline asks everyone to stop touching it', 'the incident receives a commemorative plaque',
  'the laws of physics issue a narrow exemption', 'the applause is traced to an empty cupboard',
  'the conclusion is sent back for better handwriting', 'the universe marks the ticket as resolved',
] as const;

const constraints = [
  'without waking the timeline', 'before the alibi expires', 'using the scenic laws of physics',
  'without involving a second moon', 'while remaining technically indoors',
  'before the committee discovers the first attempt', 'under strict accordion silence',
  'with no more than one ceremonial explosion', 'without voiding the prophecy',
  'while the adults are distracted by the goose', 'before Tuesday notices',
  'without making the map self-conscious', 'under maritime library rules',
  'before gravity’s lunch break', 'using only locally sourced coincidences',
  'without alerting the Department of Foreshadowing', 'while the clocks are looking elsewhere',
  'before the warranty becomes sentient', 'under an assumed constellation',
  'without exceeding the recommended number of ravens', 'during a brief lapse in causality',
  'before anyone reads the label', 'while maintaining plausible choreography',
  'in accordance with ancient snack protocol',
] as const;

const units = [
  'cups of existential dread', 'nautical eyebrows', 'metric rumors', 'decibels of side-eye',
  'standardized moonbeams', 'imperial breadcrumbs', 'handfuls per fortnight',
  'degrees of unnecessary suspense', 'liters of plausible deniability', 'horsepower per pigeon',
  'compressed Tuesdays', 'average-sized astonishments', 'knots of awkward silence',
  'parcels per prophecy', 'spoons of gravitational intent', 'pages per dragon',
  'microfortnights', 'bells per invisible bicycle', 'cubits of Wi-Fi', 'watts of mild concern',
  'fathoms of paperwork', 'bananas for scale', 'chronological teaspoons', 'certified vibes',
] as const;

const adjectives = [
  'historically damp', 'emotionally load-bearing', 'ceremonially reversible',
  'unexpectedly bilingual', 'legally moon-adjacent', 'structurally optimistic',
  'haunted within tolerance', 'approximately royal', 'suspiciously aerodynamic',
  'peer-reviewed by geese', 'waterproof on paper', 'chronologically freelance',
  'ethically invisible', 'medieval after taxes', 'quantum but house-trained',
  'officially unofficial', 'north-facing in spirit', 'dramatically underqualified',
  'mostly harmless before noon', 'weather-resistant emotionally', 'licensed for indoor thunder',
  'alphabetically waterproof', 'locally impossible', 'upside-down compatible',
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

const signatureMessages = [
  'Landing on the Moon before breakfast and discovering the café is cash-only',
  'Discovering magnetism when the fridge refuses to return the shopping list',
  'Inventing time travel five minutes after the patent office closes',
  'Finding the missing sock serving as ambassador to the laundry basket',
  'Testing the smoke alarm precisely as the fire inspector burns the toast',
  'Following the treasure map to the cartographer’s surprise birthday party',
  'Proving ghosts exist while trying to dispute the attic’s utility bill',
  'Calling tech support and reaching the knight who installed the original drawbridge',
  'Opening the emergency umbrella during the building’s first indoor rainstorm',
  'Learning semaphore just as everyone else switches to carrier pigeons',
  'Repairing the time machine with a part delivered tomorrow morning',
  'Locating the fountain of youth behind the retirement home’s vending machine',
  'Winning hide-and-seek after accidentally entering a parallel dimension',
  'Photographing Bigfoot while he photographs an even bigger foot',
  'Explaining gravity to an apple moments before it files a complaint',
  'Missing the train to punctuality because it departed early',
  'Returning a library book about procrastination exactly forty years late',
  'Discovering Atlantis after taking the wrong exit from the aquarium',
  'Meeting the inventor of awkward silence in a stalled elevator',
  'Finding north after the compass asks a nearby goose for directions',
  'Solving the cold case when the evidence requests a warmer office',
  'Interviewing the future and learning it has not prepared either',
  'Reaching the end of the rainbow during a paint shortage',
  'Unmasking the phantom at the annual mask-inspection conference',
  'Teaching a goldfish algebra on the exact day it remembers everything',
  'Filing the weather report while a small cloud edits over one shoulder',
  'Finding a needle in the haystack and discovering it runs the lost-and-found',
  'Escaping the maze through its employee entrance during orientation',
  'Asking the oracle for directions and being handed the same broken compass',
  'Crossing the international date line and forgetting to declare yesterday',
  'Calling a meeting about unnecessary meetings; the duplicate invite arrives immediately',
  'Measuring twice and discovering the ruler has been exaggerating for years',
  'Auditing the Bermuda Triangle when all three corners submit different receipts',
  'Looking for intelligent life while the office printer watches in silence',
  'Inventing the self-opening door just as the cat learns to operate handles',
  'Rehearsing the fire drill while the volcano requests a visitor badge',
  'Tracing an anonymous tip back to the detective’s own future voicemail',
  'Breaking the sound barrier during the library’s mandatory quiet hour',
  'Finding buried treasure beneath the “no digging” sign installer’s lunchbox',
  'Mapping an imaginary island until it sends a correction to the coastline',
  'Launching a paper airplane and receiving an international arrival notice',
  'Discovering the shortcut is maintained by the scenic-route committee',
  'Calling the coincidence hotline at the exact moment it calls back',
  'Taking a rain check and accidentally triggering a bank fraud investigation',
  'Turning over a new leaf and finding the old one has a forwarding address',
  'Reading the room just as it publishes an amended edition',
  'Checking under the bed while the monster checks the closet for humans',
  'Finding the skeleton key attending a locksmith convention under an alias',
  'Observing a moment of silence until the moment asks for another minute',
  'Following the chain of command to a very authoritative bicycle lock',
  'Testing the emergency exit and stepping into the building’s grand opening',
  'Discovering perpetual motion while chasing the office chair downhill',
  'Asking for a sign and receiving a municipal permit application',
  'Looking on the bright side until it requests protective eyewear',
  'Running out of thyme while the time machine idles beside the herb garden',
  'Finding common ground at the property line between two feuding surveyors',
  'Reaching a fork in the road during the cutlery delivery strike',
  'Preparing for the unexpected and accidentally spoiling its surprise party',
  'Following protocol until it ducks into an alley and changes hats',
  'Closing the loop just as the loop files to remain open',
  'Checking the fine print with a microscope borrowed from the contract lawyer',
  'Discovering the elephant in the room has been chairing the meeting remotely',
  'Trying to think outside the box while the box conducts an exit interview',
  'Taking the path of least resistance directly into an electrical inspection',
  'Asking what could possibly go wrong and receiving a numbered agenda',
  'Putting two and two together during the mathematicians’ separation hearing',
  'Getting cold feet beside the penguin expedition’s heated boot rack',
  'Searching for a silver lining in the cloud’s lost-property envelope',
  'Calling it a day only for Thursday to answer',
  'Reading between the lines and meeting the editor hiding there',
  'Holding all the cards when the magician reports a deck shortage',
  'Waiting for the dust to settle while it negotiates a longer lease',
  'Moving heaven and earth during the celestial zoning board’s lunch break',
  'Finding the last straw employed as the camel’s risk assessor',
  'Keeping an eye on the clock until it asks about the other eye',
  'Getting the ball rolling moments before the hill-inspection team arrives',
  'Opening a can of worms at the fisheries department’s potluck',
  'Burning the midnight oil when the night-shift fire marshal knocks',
  'Leaving no stone unturned except the one running the geology seminar',
  'Pulling strings at the marionette ethics hearing by pure coincidence',
  'Barking up the wrong tree while the correct tree quietly changes parks',
  'Stealing someone’s thunder and finding their name engraved on the lightning',
  'Going back to square one just as it is rezoned as a triangle',
  'Finding a loophole occupied by a very small zoning attorney',
  'Putting the cart before the horse during autonomous-vehicle testing',
  'Letting the cat out of the bag at the luggage-security briefing',
  'Watching history repeat itself because nobody saved the first draft',
  'Meeting opportunity after it knocks on the neighboring timeline',
  'Following a gut feeling to the gastroenterologists’ navigation workshop',
  'Taking matters into our own hands and discovering they require gloves',
  'Making ends meet at the annual rope-makers’ networking breakfast',
  'Hitting the nail on the head during the helmet certification test',
  'Going the extra mile and finding it already claimed by the marathon',
  'Getting ducks in a row moments before the parade switches to geese',
  'Changing horses midstream during the bridge inspector’s coffee break',
  'Finding the writing on the wall listed as a protected historical document',
  'Throwing caution to the wind just as the wind’s lawyer arrives',
] as const;

const signatureCodas = [
  'the paperwork had somehow arrived first', 'nobody mentions this was on the agenda',
  'the witness calls it an unrelated miracle', 'the calendar claims prior knowledge',
  'the nearest goose looks vindicated', 'three departments take simultaneous credit',
  'the instruction manual skips this chapter', 'the timing is described as “within tolerance”',
  'the control group applauds from inside a cupboard', 'the universe denies coordinating anything',
  'the coincidence officer asks for a quieter coincidence', 'the footnote is promoted to headline',
  'the backup plan quietly changes its name', 'the map pretends not to recognize the location',
  'the forecast insists this is seasonal', 'the legal team requests the extended version',
  'the clock refuses to corroborate', 'the prophecy asks not to be dragged into this',
  'the entire incident fits suspiciously well on the form', 'the narrator checks the script twice',
  'the odds department closes early', 'the alibi develops excellent comic timing',
  'history marks the event as “needs review”', 'lunch proceeds under heightened security',
] as const;

const generatedFamilies: MessageFamily[] = [
  createFamily([objects, tools, places, constraints], (object, tool, place, constraint) => `Calibrating ${object} in ${place} using ${tool}, ${constraint}`),
  createFamily([characters, skills, events, outcomes], (character, skill, event, outcome) => `Teaching ${character} to ${skill} for ${event}; ${outcome}`),
  createFamily([mysteries, evidence, tools, places], (mystery, proof, tool, place) => `Investigating ${mystery} using ${proof} and ${tool} beneath ${place}`),
  createFamily([records, characters, formats, constraints], (record, character, format, constraint) => `Rewriting ${record} for ${character} as ${format}, ${constraint}`),
  createFamily([objects, characters, objects, outcomes], (wanted, character, payment, outcome) => `Negotiating ${wanted} away from ${character} in exchange for ${payment}; ${outcome}`),
  createFamily([records, formats, claims, characters], (record, format, claim, character) => `Translating ${record} into ${format} for ${character}, on the theory that ${claim}`),
  createFamily([claims, places, tools, outcomes], (claim, place, tool, outcome) => `Testing whether ${claim} inside ${place} with ${tool}; ${outcome}`),
  createFamily([objects, places, characters, coincidenceMoments], (object, place, character, coincidence) => `Searching ${place} for ${object} alongside ${character}, just as ${coincidence}`),
  createFamily([characters, skills, coincidenceMoments, outcomes], (character, skill, coincidence, outcome) => `Asking ${character} to ${skill}; ${coincidence}, and ${outcome}`),
  createFamily([objects, places, claims, constraints], (object, place, claim, constraint) => `Launching ${object} toward ${place}, powered entirely by the belief that ${claim}, ${constraint}`),
  createFamily([places, objects, evidence, coincidenceMoments], (place, object, proof, coincidence) => `Auditing ${place} for signs of ${object}; finding ${proof} precisely when ${coincidence}`),
  createFamily([objects, objects, units, outcomes], (left, right, unit, outcome) => `Comparing ${left} with ${right} in ${unit}; ${outcome}`),
  createFamily([characters, claims, evidence, formats], (character, claim, proof, format) => `Persuading ${character} that ${claim} using ${proof} presented as ${format}`),
  createFamily([objects, places, characters, coincidenceMoments], (object, place, character, coincidence) => `Quietly hiding ${object} inside ${place} moments before ${character} arrives and ${coincidence}`),
  createFamily([skills, events, characters, coincidenceMoments], (skill, event, character, coincidence) => `Rehearsing how to ${skill} for ${event} with ${character}, until ${coincidence}`),
  createFamily([objects, adjectives, units, outcomes], (object, adjective, unit, outcome) => `Cataloguing ${object} as ${adjective}, measured in ${unit}; ${outcome}`),
  createFamily([objects, evidence, tools, claims], (object, proof, tool, claim) => `Reverse-engineering ${object} from ${proof} with ${tool}, assuming ${claim}`),
  createFamily([objects, places, tools, constraints], (object, place, tool, constraint) => `Installing ${object} at ${place} with ${tool}, ${constraint}`),
  createFamily([evidence, places, places, characters], (clue, origin, destination, character) => `Following ${clue} from ${origin} to ${destination}, where ${character} has been waiting politely`),
  createFamily([objects, characters, records, outcomes], (object, character, record, outcome) => `Preparing ${object} for ${character} according to ${record}; ${outcome}`),
  createFamily([mysteries, skills, coincidenceMoments, characters], (mystery, skill, coincidence, character) => `Discovering ${mystery} while trying to ${skill}; ${coincidence}, and ${character} calls it beginner’s luck`),
  createFamily([characters, claims, coincidenceMoments, evidence], (character, claim, coincidence, proof) => `The exact moment ${character} announces that ${claim}, ${coincidence}; nearby, ${proof} suddenly looks relevant`),
  createFamily([objects, places, events, coincidenceMoments], (object, place, event, coincidence) => `Returning ${object} to ${place} on the day of ${event}, just as ${coincidence}`),
  createFamily([objects, coincidenceMoments, outcomes, constraints], (object, coincidence, outcome, constraint) => `Testing ${object} precisely when ${coincidence}; ${outcome}, ${constraint}`),
  createFamily([places, events, characters, objects], (place, event, character, object) => `Booking ${place} for ${event}, unaware that ${character} has already reserved it for ${object}`),
  createFamily([objects, places, characters, records], (object, place, character, record) => `Finally finding ${object} in ${place}, one minute after ${character} files ${record}`),
  createFamily([events, skills, characters, outcomes], (event, skill, character, outcome) => `Trying to avoid ${event}; accidentally learning to ${skill}, which ${character} records as a success; ${outcome}`),
  createFamily([characters, mysteries, coincidenceMoments, formats], (character, mystery, coincidence, format) => `Calling ${character} about ${mystery} while ${coincidence}; explaining it all through ${format}`),
  createFamily([claims, coincidenceMoments, characters, outcomes], (claim, coincidence, character, outcome) => `Promising everyone that ${claim} seconds before ${coincidence}; ${character} takes notes and ${outcome}`),
  createFamily([evidence, places, characters, objects], (proof, place, character, object) => `Following ${proof} to ${place}, where ${character} happens to be returning ${object}`),
  createFamily([events, coincidenceMoments, records, outcomes], (event, coincidence, record, outcome) => `Scheduling ${event} around the moment ${coincidence}; ${record} says this was inevitable, and ${outcome}`),
  createFamily([characters, objects, places, coincidenceMoments], (character, object, place, coincidence) => `Watching ${character} carry ${object} into ${place}, just as ${coincidence}`),
  createFamily([mysteries, records, characters, outcomes], (mystery, record, character, outcome) => `Cross-referencing ${mystery} against ${record} with ${character}; ${outcome}`),
  createFamily([places, units, tools, adjectives], (place, unit, tool, adjective) => `Surveying ${place} in ${unit} with ${tool}; initial findings are ${adjective}`),
  createFamily([characters, events, formats, constraints], (character, event, format, constraint) => `Briefing ${character} on ${event} through ${format}, ${constraint}`),
  createFamily([objects, records, evidence, outcomes], (object, record, proof, outcome) => `Fact-checking ${object} against ${record} and ${proof}; ${outcome}`),
  createFamily([places, claims, coincidenceMoments, constraints], (place, claim, coincidence, constraint) => `Mapping ${place} under the assumption that ${claim}; ${coincidence}, ${constraint}`),
  createFamily([characters, objects, tools, adjectives], (character, object, tool, adjective) => `Helping ${character} untangle ${object} with ${tool}; the knot is reportedly ${adjective}`),
  createFamily([events, records, formats, outcomes], (event, record, format, outcome) => `Documenting ${event} in ${record} as ${format}; ${outcome}`),
  createFamily([skills, tools, units, constraints], (skill, tool, unit, constraint) => `Attempting to ${skill} with ${tool}, budgeting exactly seven ${unit}, ${constraint}`),
];

// Hand-written coincidence jokes are deliberately split into several families
// so a bespoke line surfaces regularly instead of once every several minutes.
const signatureFamilies: MessageFamily[] = Array.from({ length: 8 }, (_, group) => {
  const messages = signatureMessages.filter((_, index) => index % 8 === group);
  return createFamily(
    [messages, signatureCodas],
    (message, coda) => `${message}; ${coda}`,
  );
});

const messageFamilies = [...generatedFamilies, ...signatureFamilies];

/** More than thirteen million structurally distinct messages, without eagerly
 * allocating a multi-megabyte array in every browser tab. */
export const WORKING_MESSAGE_COUNT = messageFamilies.reduce((total, family) => total + family.count, 0);

/** Requested cadence: the old five-second message lasted half as long. */
export const WORKING_MESSAGE_INTERVAL_MS = 10_000;

const positiveModulo = (value: number, modulus: number): number => ((value % modulus) + modulus) % modulus;

const greatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
};

/** A compact integer mixer gives each run a different deterministic route. */
const mix32 = (value: number): number => {
  let mixed = value | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
};

const coprimeStep = (size: number, seed: number): number => {
  let step = (mix32(seed) % (size - 1)) + 1;
  while (greatestCommonDivisor(step, size) !== 1) {
    step = (step % (size - 1)) + 1;
  }
  return step;
};

/**
 * Returns the message at a run-local sequence position.
 *
 * Every block visits every sentence family exactly once in a seeded order.
 * Within a family, a second coprime walk visits every variant before repeating.
 * That prevents the former “same first half ten times” behavior and also keeps
 * different runs from opening with the same handful of jokes.
 */
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
