import assert from 'node:assert/strict';
import test from 'node:test';

import { renderStoryClockBlock, compileContext } from '../context-compiler.js';
import {
    createEmptyStore,
    mergeEntityOperations,
    renderCompactEntity,
    renderLoreContent,
    stampEntityTimes,
    storyOffsetLabel,
} from '../core.js';
import { createProgressionState } from '../progression.js';

function storeWithNanobots() {
    const store = createEmptyStore('story-time');
    const result = mergeEntityOperations(store, [{
        type: 'item',
        name: 'Nanobot Swarm',
        importance: 80,
        summary: 'A swarm of nanobots now living in Rowan.',
        facts: ['Rowan swallowed the nanobots at the clinic.'],
        history: ['Rowan first used the swarm to seal a cut.'],
    }], { messageIndex: 3 });
    return { store, ids: result.changedIds };
}

test('storyOffsetLabel reads naturally at each scale', () => {
    assert.equal(storyOffsetLabel(5), 'story start');
    assert.equal(storyOffsetLabel(40 * 60), 'story +40m');
    assert.equal(storyOffsetLabel(2 * 3600 + 10 * 60), 'story +2h 10m');
    assert.equal(storyOffsetLabel(3 * 86400), 'story +3d');
    assert.equal(storyOffsetLabel(NaN), '');
});

test('facts and history are stamped once and never restamped', () => {
    const { store, ids } = storeWithNanobots();
    assert.ok(ids.length);
    assert.ok(stampEntityTimes(store, ids, 600) >= 2);
    // A later pass restating the same fact keeps the original time.
    mergeEntityOperations(store, [{
        type: 'item',
        name: 'Nanobot Swarm',
        importance: 80,
        facts: ['Rowan swallowed the nanobots at the clinic.', 'The swarm answers to Rowan\'s pulse.'],
    }], { messageIndex: 9 });
    stampEntityTimes(store, ids, 2400);
    const record = store.entities[ids[0]];
    const times = Object.values(record.factTimes).sort((a, b) => a - b);
    assert.deepEqual(times, [600, 600, 2400]);
    assert.equal(record.firstSeenStorySeconds, 600);
});

test('removed facts lose their stamp', () => {
    const { store, ids } = storeWithNanobots();
    stampEntityTimes(store, ids, 600);
    mergeEntityOperations(store, [{
        type: 'item',
        name: 'Nanobot Swarm',
        importance: 80,
        remove_facts: ['Rowan swallowed the nanobots at the clinic.'],
    }], { messageIndex: 5 });
    stampEntityTimes(store, ids, 900);
    const record = store.entities[ids[0]];
    assert.equal(Object.keys(record.factTimes).length, 1);
});

test('stamps show in the injected entry and the lorebook mirror, text stays removable', () => {
    const { store, ids } = storeWithNanobots();
    stampEntityTimes(store, ids, 40 * 60);
    const record = store.entities[ids[0]];
    assert.ok(record.facts.every(fact => !fact.includes('[story')), 'stored text must stay unstamped');
    const compact = renderCompactEntity(record, 1800, {});
    assert.match(compact, /Rowan swallowed the nanobots at the clinic\. \[story \+40m\]/);
    assert.match(compact, /first recorded story \+40m/);
    assert.match(renderLoreContent(record), /\[story \+40m\]/);
    assert.doesNotMatch(renderCompactEntity(record, 1800, { storyTimeStamps: false }), /\[story/);
});

test('nothing is stamped without a usable clock reading', () => {
    const { store, ids } = storeWithNanobots();
    assert.equal(stampEntityTimes(store, ids, NaN), 0);
    assert.equal(stampEntityTimes(store, ids, -5), 0);
    assert.doesNotMatch(renderLoreContent(store.entities[ids[0]]), /\[story/);
});

test('the story clock block is separate, bounded, and switchable', () => {
    const progression = createProgressionState();
    assert.equal(renderStoryClockBlock(progression), '');
    progression.clock.estimatedSeconds = 2400;
    progression.clock.minimumSeconds = 1800;
    progression.clock.maximumSeconds = 3000;
    const block = renderStoryClockBlock(progression);
    assert.match(block, /<inner_lore_story_clock/);
    assert.match(block, /40m/);
    assert.match(block, /at most that old/);
    assert.equal(renderStoryClockBlock(progression, { storyClockBlockEnabled: false }), '');
});

test('the compiled context carries the clock block even without a progression block', () => {
    const { store } = storeWithNanobots();
    store.progression = createProgressionState();
    store.progression.clock.estimatedSeconds = 2400;
    store.progression.clock.minimumSeconds = 2400;
    store.progression.clock.maximumSeconds = 2400;
    const compiled = compileContext({
        store,
        messages: [{ is_user: false, name: 'Narrator', mes: 'Rowan flexes her hand.' }],
        recentText: 'Rowan flexes her hand.',
        playerName: 'Rowan',
        currentIndex: 0,
        settings: { enabled: true, innerSelfEnabled: true, autoLoreEnabled: true, worldProgressionEnabled: false, currentIndex: 0 },
    });
    assert.match(compiled.text, /inner_lore_story_clock/);
    assert.ok(compiled.blocks.clock.includes('40m'));
});

test('a squeezed packet drops progression but keeps the story clock', () => {
    const { store } = storeWithNanobots();
    store.progression = createProgressionState();
    store.progression.clock.estimatedSeconds = 2400;
    store.progression.clock.minimumSeconds = 2400;
    store.progression.clock.maximumSeconds = 2400;
    const compiled = compileContext({
        store,
        messages: [{ is_user: false, name: 'Narrator', mes: 'Rowan flexes her hand.' }],
        recentText: 'Rowan flexes her hand.',
        playerName: 'Rowan',
        currentIndex: 0,
        settings: {
            enabled: true,
            innerSelfEnabled: true,
            autoLoreEnabled: true,
            worldProgressionEnabled: true,
            currentIndex: 0,
            // The smallest allowance the config accepts forces the last-resort drop.
            derivedContext: {
                maximumCharacters: 2_000,
                sections: { scene: 1_000, minds: 1_000, lore: 1_000, progression: 1_000, game: 0 },
            },
        },
    });
    assert.equal(compiled.blocks.progression, '', 'progression is the sacrificial block');
    assert.match(compiled.text, /inner_lore_story_clock/);
});
