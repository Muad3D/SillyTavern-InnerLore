import assert from 'node:assert/strict';
import test from 'node:test';

import { outputParseDiagnostics, parseInnerLoreDsl, parseInnerLoreOutput } from '../output-codec.js';

const curator = { format: 'dsl', task: 'curator', salvageTruncated: true };

// Shape of a real Qwen3.8-27B loop: good atomic facts, then a short cycle of
// restatements repeated until DRY made end-of-sequence the cheapest token.
const LOOP_OUTPUT = [
    'INNERLORE CURATOR 1',
    "LOCATION Muad's Place",
    "facts += Muad's place is nestled into the treeline on the edge of the city block.",
    "facts += Muad's place has a massive garden and a pool right off the patio.",
    "facts += Muad's place has a bodyless AI named Xel that runs the house.",
    "facts += Muad's place has a large mahogany front door.",
    ...Array.from({ length: 6 }, () => [
        "facts += Muad's place has a pool.",
        "facts += Muad's place has a patio.",
        "facts += Muad's place has a lobby.",
        "facts += Muad's place has a garden.",
    ]).flat(),
    "facts += Muad's place has a living room pit.",
].join('\n');

test('a looping record cut by end-of-sequence is closed, deduplicated, and kept', () => {
    const parsed = parseInnerLoreOutput(LOOP_OUTPUT, curator);
    assert.equal(parsed.entities.length, 1);
    const entity = parsed.entities[0];
    assert.equal(entity.name, "Muad's Place");
    // Four real facts plus the four cycle items once each; the final line was
    // possibly cut mid-value, so it is dropped.
    assert.equal(entity.facts.length, 8);
    assert.equal(new Set(entity.facts).size, entity.facts.length);
    assert.ok(!entity.facts.includes("Muad's place has a living room pit."));
    const codes = outputParseDiagnostics(parsed).map(item => item.code);
    assert.ok(codes.includes('open_record_closed'));
    const duplicates = outputParseDiagnostics(parsed).find(item => item.code === 'duplicate_list_item_dropped');
    assert.equal(duplicates.count, 20);
    assert.equal(duplicates.path, 'facts');
});

test('a final line that ended with a newline is complete and kept', () => {
    const parsed = parseInnerLoreOutput(`${LOOP_OUTPUT}\n`, curator);
    assert.ok(parsed.entities[0].facts.includes("Muad's place has a living room pit."));
});

test('one record keeps at most 20 new curator list items per pass', () => {
    const lines = ['INNERLORE CURATOR 1', 'CHARACTER Maddison Fox', 'importance = 80'];
    for (let index = 1; index <= 35; index++) lines.push(`facts += Maddison detail number ${index}.`);
    lines.push('END', 'DONE');
    const parsed = parseInnerLoreDsl(lines.join('\n'), 'curator');
    const facts = parsed.entities[0].facts;
    assert.equal(facts.length, 20);
    assert.equal(facts[0], 'Maddison detail number 1.');
    assert.equal(facts[19], 'Maddison detail number 20.');
    const capped = outputParseDiagnostics(parsed).find(item => item.code === 'list_append_cap_dropped');
    assert.deepEqual({ count: capped.count, cap: capped.cap, path: capped.path }, { count: 15, cap: 20, path: 'facts' });
});

test('the cap and duplicate filter are per list, so separate records and fields are unaffected', () => {
    const lines = ['INNERLORE CURATOR 1'];
    for (const name of ['Ana', 'Bea']) {
        lines.push(`CHARACTER ${name}`);
        for (let index = 1; index <= 20; index++) lines.push(`facts += ${name} fact ${index}.`);
        lines.push('history += Met the player.', 'END');
    }
    lines.push('DONE');
    const parsed = parseInnerLoreDsl(lines.join('\n'), 'curator');
    assert.deepEqual(parsed.entities.map(entity => entity.facts.length), [20, 20]);
    assert.deepEqual(parsed.entities.map(entity => entity.history), [['Met the player.'], ['Met the player.']]);
    assert.deepEqual(outputParseDiagnostics(parsed), []);
});

test('duplicates differing only in case or spacing collapse to the first wording', () => {
    const parsed = parseInnerLoreDsl([
        'INNERLORE CURATOR 1',
        'LOCATION Dock',
        'facts += The pier  is wet.',
        'facts += the pier is wet.',
        'END',
        'DONE',
    ].join('\n'), 'curator');
    assert.deepEqual(parsed.entities[0].facts, ['The pier  is wet.']);
});

test('an unclosed ITEM block is cut away whole and the record kept', () => {
    const parsed = parseInnerLoreOutput([
        'INNERLORE CURATOR 1',
        'LOCATION Ben Tavern',
        'importance = 70',
        'facts += The cellar floods in spring.',
        'ITEM spatial.set',
        'kind = entrance',
        'statement = A trapdoor behind the bar leads down',
    ].join('\n'), curator);
    const entity = parsed.entities[0];
    assert.deepEqual(entity.facts, ['The cellar floods in spring.']);
    assert.equal(entity.spatial, undefined);
});

test('a cut header or a header with no complete field still never becomes an entity', () => {
    assert.throws(() => parseInnerLoreOutput('INNERLORE CURATOR 1\nLOCATION House beside', curator), /DONE marker|END/u);
    assert.throws(() => parseInnerLoreOutput('INNERLORE CURATOR 1\nCHARACTER Freesia\nimportance = 9', curator), /DONE marker|END/u);
    // A cut new header after a closed record: the closed record survives alone.
    const parsed = parseInnerLoreOutput(
        'INNERLORE CURATOR 1\nLOCATION Ben Tavern\nimportance = 60\nEND\nLOCATION House beside',
        curator,
    );
    assert.deepEqual(parsed.entities.map(entity => entity.name), ['Ben Tavern']);
});
