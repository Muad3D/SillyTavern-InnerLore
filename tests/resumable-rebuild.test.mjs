import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createEmptyStore,
    createStoreCheckpoint,
    mergeEntityOperations,
    snapshotMessageRange,
} from '../core.js';
import { applyProgressionPatch, createProgressionState } from '../progression.js';
import { upsertTriggerEventDefinition } from '../trigger-events.js';
import { installMockInnerLoreStorage } from './mock-storage-server.mjs';
import { createEventListeners } from './mock-event-source.mjs';

installMockInnerLoreStorage();

const waitFor = async (predicate, timeout = 12_000) => {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error('Timed out waiting for mocked InnerLore state.');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

// Index 0 assistant greeting, then alternating user (odd) / assistant (even).
function buildChat() {
    const chat = [{ is_user: false, is_system: false, name: 'Narrator', mes: 'Turn 0 — the hall is quiet.' }];
    for (let i = 1; i <= 23; i++) {
        const user = i % 2 === 1;
        chat.push({ is_user: user, is_system: false, name: user ? 'Jet' : 'Narrator', mes: `Turn ${i} — ${user ? 'Jet speaks' : 'the story continues'} distinctly.` });
    }
    return chat;
}

function progressionPayload(prefix, elapsedSeconds) {
    return {
        time: {
            elapsed: { minimum_seconds: elapsedSeconds, estimated_seconds: elapsedSeconds, maximum_seconds: elapsedSeconds },
            confidence: 1,
            basis: [`${prefix} completed exchange`],
            completed_actions: [`completed ${prefix}`],
        },
        goals: [{
            key: `${prefix}_goal`,
            owner: `${prefix} NPC`,
            title: `${prefix} goal`,
            status: 'active',
            evidence: [`${prefix} goal is established.`],
        }],
        processes: [],
        events: [],
    };
}

async function installHarness({ chatId, chat, store, settings = {}, sendRequest }) {
    const listeners = createEventListeners();
    const worlds = new Map();
    const extensionSettings = {
        disabledExtensions: [],
        connectionManager: {
            selectedProfile: 'resume-profile',
            profiles: [{ id: 'resume-profile', name: 'Resume Profile', model: 'mock/model' }],
        },
        inner_lore: {
            gameEnabled: false,
            enabled: true,
            autoUpdate: true,
            autoRecoverIncomplete: false,
            innerSelfEnabled: true,
            autoLoreEnabled: true,
            worldProgressionEnabled: false,
            processEveryAssistantTurns: 1,
            maintenanceSchedulingVersion: 1,
            lookbackMessages: 10,
            connectionSource: 'profile',
            connectionProfileId: 'resume-profile',
            progressionConnectionProfileId: 'resume-profile',
            requestTimeoutSeconds: 15,
            progressionRequestTimeoutSeconds: 15,
            autoRebuildOnHistoryChange: true,
            autoRebuildMessageLimit: 120,
            ...settings,
        },
    };
    const events = {
        MESSAGE_RECEIVED: 'message_received',
        GENERATION_STARTED: 'generation_started',
        CHAT_CHANGED: 'chat_changed',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_DELETED: 'message_deleted',
    };
    const chatMetadata = { inner_lore: store };
    const context = {
        extensionSettings,
        chatMetadata,
        chat,
        chatId,
        name1: 'Jet',
        name2: 'Narrator',
        getCurrentChatId: () => chatId,
        getCharacterCardFields: () => ({}),
        saveSettingsDebounced: () => {},
        saveMetadata: async () => {},
        saveMetadataDebounced: () => {},
        setExtensionPrompt: () => {},
        renderExtensionTemplateAsync: async () => '',
        eventSource: { on: listeners.on },
        eventTypes: events,
        SlashCommandParser: null,
        SlashCommand: null,
        ConnectionManagerRequestService: {
            getSupportedProfiles: () => extensionSettings.connectionManager.profiles,
            sendRequest,
        },
        loadWorldInfo: async name => worlds.get(name) || null,
        saveWorldInfo: async (name, data) => worlds.set(name, structuredClone(data)),
        updateWorldInfoList: async () => {},
    };
    globalThis.document = { activeElement: null, getElementById: () => null, querySelectorAll: () => [] };
    globalThis.$ = () => ({ append: () => {} });
    globalThis.toastr = { error: () => {}, warning: () => {}, success: () => {}, info: () => {} };
    globalThis.confirm = () => true;
    globalThis.SillyTavern = { getContext: () => context };
    await import(`../index.js?resumable-rebuild=${chatId}-${Date.now()}-${Math.random()}`);
    await waitFor(() => listeners.size === 6);
    return { chatMetadata, events, listeners };
}

const joinMessages = messages => messages.map(message => message.content).join('\n');
const EMPTY_PATCH = { content: '{"entities":[],"minds":[]}' };

test('a failed rebuild keeps its finished batches and the next rebuild resumes after them', async () => {
    const chatId = 'interrupted-chat';
    const chat = buildChat();
    const store = createEmptyStore(chatId);
    store.lastProcessedIndex = 22;
    store.processedFingerprints = snapshotMessageRange(chat, 0, 22);

    let failLate = true;
    const transcripts = [];
    const harness = await installHarness({
        chatId,
        chat,
        store,
        sendRequest: async (_profileId, messages) => {
            const joined = joinMessages(messages);
            transcripts.push(joined);
            if (failLate && (/Turn 15 —/u.test(joined) || /NOT A DSL DOCUMENT/u.test(joined))) {
                return { content: 'NOT A DSL DOCUMENT' };
            }
            return EMPTY_PATCH;
        },
    });
    const live = () => harness.chatMetadata.inner_lore;

    // An early edit has no covering snapshot: a full rebuild starts, and the
    // batch holding message 15 fails non-transiently (parse + repair).
    chat[3] = { is_user: true, is_system: false, name: 'Jet', mes: 'Turn 3 — an early rewrite.' };
    harness.listeners.get(harness.events.MESSAGE_EDITED)();
    await waitFor(() => live().interruptedRebuild && live().lastError);

    const interrupted = live().interruptedRebuild;
    assert.ok(interrupted.resumeIndex >= 0 && interrupted.resumeIndex < 15, `resume point ${interrupted.resumeIndex} precedes the failed batch`);
    assert.ok(live().checkpoints.some(checkpoint => checkpoint.index === interrupted.resumeIndex));
    assert.equal(live().needsRebuild, true, 'the stale store stays quarantined');

    // The next rebuild (here: another history change) resumes after the kept
    // batch instead of re-reading the chat from message 0.
    const before = transcripts.length;
    failLate = false;
    harness.listeners.get(harness.events.MESSAGE_EDITED)();
    await waitFor(() => live().needsRebuild === false && !live().interruptedRebuild);

    const second = transcripts.slice(before);
    assert.ok(second.length >= 1);
    assert.ok(second.every(text => !/Turn 5 —/u.test(text)), 'no message before the kept snapshot is re-read');
    assert.ok(second.some(text => /Turn 15 —/u.test(text)), 'the failed batch is retried');
    assert.equal(live().lastProcessedIndex, 22);
    assert.equal(live().lastError, '');
});

test('the automatic limit counts messages to re-read, not chat length', async () => {
    const chatId = 'limit-chat';
    const chat = buildChat();
    const checkpointStore = createEmptyStore(chatId);
    checkpointStore.lastProcessedIndex = 19;
    checkpointStore.processedFingerprints = snapshotMessageRange(chat, 0, 19);
    mergeEntityOperations(checkpointStore, [{ type: 'location', name: 'Old Landmark', importance: 80, facts: ['Established early.'] }], { messageIndex: 5, minimumImportance: 0 });
    const store = createEmptyStore(chatId);
    store.lastProcessedIndex = 22;
    store.processedFingerprints = snapshotMessageRange(chat, 0, 22);
    store.checkpoints = [createStoreCheckpoint(checkpointStore)];
    store.entities = structuredClone(checkpointStore.entities);

    let requests = 0;
    const harness = await installHarness({
        chatId,
        chat,
        store,
        // 24 messages would exceed this limit; 3 messages after the snapshot do not.
        settings: { autoRebuildMessageLimit: 10 },
        sendRequest: async () => {
            requests++;
            return EMPTY_PATCH;
        },
    });
    chat[22] = { is_user: false, is_system: false, name: 'Narrator', mes: 'Turn 22 — a rewritten late beat.' };
    harness.listeners.get(harness.events.MESSAGE_SWIPED)(22);
    await waitFor(() => requests > 0 && harness.chatMetadata.inner_lore.needsRebuild === false);
    assert.ok(harness.chatMetadata.inner_lore.entities['location:old landmark'], 'resumed from the snapshot');
});

function progressionFixture(chatId, chat) {
    // Snapshot after message 19 whose World Progression already holds a goal,
    // ten minutes of story time, and two user-defined trigger events.
    let snapshotProgression = createProgressionState();
    for (const [key, title] of [['kept_event', 'A Kept Event'], ['edited_event', 'An Edited Event']]) {
        snapshotProgression = upsertTriggerEventDefinition(snapshotProgression, {
            id: `trigger:${key}`,
            key,
            title,
            enabled: true,
            actionCondition: 'A non-player character greets Jet.',
            actorScope: 'npc',
            activationVisibility: 'hidden',
        }, { clock: snapshotProgression.clock, messageIndex: -1 }).state;
    }
    snapshotProgression = applyProgressionPatch(snapshotProgression, progressionPayload('snapshot', 600), {
        clock: snapshotProgression.clock,
        messageIndex: 19,
    }).state;
    snapshotProgression.lastProcessedIndex = 19;
    snapshotProgression.processedFingerprints = snapshotMessageRange(chat, 0, 19);
    snapshotProgression.eventRuntime['trigger:kept_event'].triggeredAtMessage = 12;
    snapshotProgression.eventRuntime['trigger:edited_event'].triggeredAtMessage = 12;

    const checkpointStore = createEmptyStore(chatId);
    checkpointStore.lastProcessedIndex = 19;
    checkpointStore.processedFingerprints = snapshotMessageRange(chat, 0, 19);
    checkpointStore.progression = snapshotProgression;

    const store = createEmptyStore(chatId);
    store.lastProcessedIndex = 22;
    store.processedFingerprints = snapshotMessageRange(chat, 0, 22);
    store.checkpoints = [createStoreCheckpoint(checkpointStore)];
    // The live chat's definitions: one unchanged, one edited since.
    store.progression = structuredClone(snapshotProgression);
    store.progression.eventDefinitions['trigger:edited_event'].title = 'An Edited Event, Renamed';
    return store;
}

async function runProgressionResume(chatId, settings) {
    const chat = buildChat();
    const store = progressionFixture(chatId, chat);
    const progressionTranscripts = [];
    const harness = await installHarness({
        chatId,
        chat,
        store,
        settings: { worldProgressionEnabled: true, ...settings },
        sendRequest: async (_profileId, messages) => {
            const joined = joinMessages(messages);
            if (/World Progression Engine/u.test(joined)) {
                progressionTranscripts.push(joined);
                const payload = progressionPayload('tail', 30);
                payload.event_evaluations = ['kept_event', 'edited_event'].map(key => ({
                    key, evaluated: true, reason: 'No greeting in this passage.',
                }));
                return { content: JSON.stringify(payload) };
            }
            return EMPTY_PATCH;
        },
    });
    chat[22] = { is_user: false, is_system: false, name: 'Narrator', mes: 'Turn 22 — a rewritten late beat.' };
    harness.listeners.get(harness.events.MESSAGE_SWIPED)(22);
    await waitFor(() => progressionTranscripts.length > 0 && harness.chatMetadata.inner_lore.needsRebuild === false);
    return { progression: harness.chatMetadata.inner_lore.progression, progressionTranscripts };
}

test('a resumed rebuild continues World Progression from the snapshot', async () => {
    const { progression, progressionTranscripts } = await runProgressionResume('progression-resume-chat', {});
    const goalKeys = Object.values(progression.goals).map(goal => goal.key);
    assert.ok(goalKeys.includes('snapshot_goal'), 'the snapshot goal survives');
    assert.ok(goalKeys.includes('tail_goal'), 'the tail was read');
    assert.equal(progression.clock.estimatedSeconds, 630, 'story time continues from the snapshot clock');
    assert.ok(progressionTranscripts.every(text => !/Turn 5 —/u.test(text)), 'progression does not re-read from message 0');
    assert.equal(progression.eventRuntime['trigger:kept_event'].triggeredAtMessage, 12, 'an unchanged trigger keeps its runtime');
    assert.equal(progression.eventRuntime['trigger:edited_event'].triggeredAtMessage, -1, 'an edited trigger is re-armed');
    assert.equal(progression.eventDefinitions['trigger:edited_event'].title, 'An Edited Event, Renamed', 'the current definition wins');
});

test('with progression resume off, World Progression is re-read from message 0 as before', async () => {
    const { progression, progressionTranscripts } = await runProgressionResume('progression-fresh-chat', {
        resumeProgressionFromCheckpoints: false,
    });
    const goalKeys = Object.values(progression.goals).map(goal => goal.key);
    assert.ok(!goalKeys.includes('snapshot_goal'));
    assert.ok(progressionTranscripts.some(text => /Turn 5 —/u.test(text)));
});

test('saving an interrupted rebuild keeps older snapshots that still match the chat', async () => {
    const chatId = 'merge-ladder-chat';
    const chat = buildChat();
    const original3 = chat[3];
    const checkpointStore = createEmptyStore(chatId);
    checkpointStore.lastProcessedIndex = 19;
    checkpointStore.processedFingerprints = snapshotMessageRange(chat, 0, 19);
    mergeEntityOperations(checkpointStore, [{ type: 'location', name: 'Old Landmark', importance: 80, facts: ['Established early.'] }], { messageIndex: 5, minimumImportance: 0 });
    const store = createEmptyStore(chatId);
    store.lastProcessedIndex = 22;
    store.processedFingerprints = snapshotMessageRange(chat, 0, 22);
    store.checkpoints = [createStoreCheckpoint(checkpointStore)];

    let failLate = true;
    const transcripts = [];
    const harness = await installHarness({
        chatId,
        chat,
        store,
        sendRequest: async (_profileId, messages) => {
            // An early message differs while the rebuild starts (a transient
            // change), so the run begins at message 0; it is back by the time
            // the run fails at message 15.
            const joined = joinMessages(messages);
            transcripts.push(joined);
            if (failLate && (/Turn 15 —/u.test(joined) || /NOT A DSL DOCUMENT/u.test(joined))) {
                chat[3] = original3;
                return { content: 'NOT A DSL DOCUMENT' };
            }
            return EMPTY_PATCH;
        },
    });
    const live = () => harness.chatMetadata.inner_lore;
    chat[3] = { is_user: true, is_system: false, name: 'Jet', mes: 'Turn 3 — briefly different.' };
    harness.listeners.get(harness.events.MESSAGE_EDITED)();
    await waitFor(() => live().interruptedRebuild && live().lastError);

    assert.ok(live().checkpoints.some(checkpoint => checkpoint.index === 19), 'the still-valid snapshot after message 19 is kept');
    assert.equal(live().interruptedRebuild.resumeIndex, 19);

    const before = transcripts.length;
    failLate = false;
    harness.listeners.get(harness.events.MESSAGE_EDITED)();
    await waitFor(() => live().needsRebuild === false && !live().interruptedRebuild);
    assert.ok(transcripts.slice(before).every(text => !/Turn 15 —/u.test(text)), 'resumed after message 19');
    assert.ok(live().entities['location:old landmark']);
});

test('a rebuild requested when nothing diverged resumes from the newest snapshot', async () => {
    const chatId = 'no-divergence-chat';
    const chat = buildChat();
    const checkpointStore = createEmptyStore(chatId);
    checkpointStore.lastProcessedIndex = 22;
    checkpointStore.processedFingerprints = snapshotMessageRange(chat, 0, 22);
    mergeEntityOperations(checkpointStore, [{ type: 'location', name: 'Old Landmark', importance: 80, facts: ['Established early.'] }], { messageIndex: 5, minimumImportance: 0 });
    const store = createEmptyStore(chatId);
    store.lastProcessedIndex = 22;
    store.processedFingerprints = snapshotMessageRange(chat, 0, 22);
    store.checkpoints = [createStoreCheckpoint(checkpointStore)];
    store.entities = structuredClone(checkpointStore.entities);

    let requests = 0;
    const harness = await installHarness({
        chatId,
        chat,
        store,
        sendRequest: async () => {
            requests++;
            return EMPTY_PATCH;
        },
    });
    // A history event with no actual change (e.g. a swipe seen before its new
    // text exists): stock code rebuilt from message 0 here.
    harness.listeners.get(harness.events.MESSAGE_EDITED)();
    await waitFor(() => harness.chatMetadata.inner_lore.needsRebuild === true);
    await waitFor(() => harness.chatMetadata.inner_lore.needsRebuild === false);
    assert.equal(requests, 0, 'nothing is re-read');
    assert.ok(harness.chatMetadata.inner_lore.entities['location:old landmark']);
    assert.equal(harness.chatMetadata.inner_lore.lastProcessedIndex, 22);
});
