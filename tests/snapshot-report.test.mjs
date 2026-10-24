import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyStore, createStoreCheckpoint, snapshotMessageRange } from '../core.js';
import { installMockInnerLoreStorage } from './mock-storage-server.mjs';
import { createEventListeners } from './mock-event-source.mjs';

installMockInnerLoreStorage();

const waitFor = async (predicate, timeout = 4_000) => {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error('Timed out waiting for mocked InnerLore state.');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

function harness({ chat, store, generate }) {
    const listeners = createEventListeners();
    const commands = new Map();
    const toasts = [];
    const events = {
        MESSAGE_RECEIVED: 'message_received',
        GENERATION_STARTED: 'generation_started',
        GENERATION_STOPPED: 'generation_stopped',
        CHAT_CHANGED: 'chat_changed',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_DELETED: 'message_deleted',
    };
    const chatMetadata = { inner_lore: store };
    const context = {
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: { profiles: [], selectedProfile: '' },
            inner_lore: {
                gameEnabled: false,
                enabled: true,
                autoUpdate: false,
                autoRecoverIncomplete: true,
                incompleteRecoveryAttempts: 2,
                innerSelfEnabled: true,
                autoLoreEnabled: true,
                worldProgressionEnabled: false,
                autoRebuildOnHistoryChange: false,
            },
        },
        chatMetadata,
        chat,
        chatId: store.chatId,
        name1: 'Player',
        name2: 'Narrator',
        getCurrentChatId: () => store.chatId,
        getCharacterCardFields: () => ({}),
        saveSettingsDebounced: () => {},
        saveMetadata: async () => {},
        saveMetadataDebounced: () => {},
        saveChat: async () => {},
        deleteLastMessage: async () => {
            chat.pop();
            listeners.get(events.MESSAGE_DELETED)?.(chat.length);
        },
        setExtensionPrompt: () => {},
        renderExtensionTemplateAsync: async () => '',
        eventSource: { on: listeners.on },
        eventTypes: events,
        SlashCommandParser: { addCommandObject: command => commands.set(command.name, command) },
        SlashCommand: { fromProps: props => props },
        ConnectionManagerRequestService: null,
        generate: async (type, options) => generate(type, options, { chat, listeners, events }),
    };
    globalThis.document = {
        activeElement: null,
        getElementById: id => id === 'send_textarea' ? { value: '' } : null,
        querySelectorAll: () => [],
    };
    globalThis.$ = () => ({ append: () => {} });
    globalThis.toastr = {
        error: () => {},
        warning: message => toasts.push(message),
        success: () => {},
        info: message => toasts.push(message),
    };
    globalThis.confirm = () => true;
    globalThis.SillyTavern = { getContext: () => context };
    return { chatMetadata, commands, events, listeners, toasts };
}

test('/innerlore-snapshots names the first changed message for each snapshot', async () => {
    const chat = [
        { is_user: false, is_system: false, name: 'Narrator', mes: 'Turn 0 — the hall is quiet.' },
        { is_user: true, is_system: false, name: 'Player', mes: 'Turn 1 — I look around.' },
        { is_user: false, is_system: false, name: 'Narrator', mes: 'Turn 2 — a door opens.' },
        { is_user: true, is_system: false, name: 'Player', mes: 'Turn 3 — I step through.' },
        { is_user: false, is_system: false, name: 'Narrator', mes: 'Turn 4 — rain begins.' },
    ];
    const store = createEmptyStore('snapshot-report-chat');
    store.lastProcessedIndex = 4;
    store.processedFingerprints = snapshotMessageRange(chat, 0, 4);
    for (const index of [0, 2, 4]) {
        const checkpointStore = createEmptyStore('snapshot-report-chat');
        checkpointStore.lastProcessedIndex = index;
        checkpointStore.processedFingerprints = snapshotMessageRange(chat, 0, index);
        store.checkpoints.push(createStoreCheckpoint(checkpointStore));
    }
    const h = harness({ chat, store, generate: async () => {} });
    await import(`../index.js?snapshot-report=${Date.now()}`);
    await waitFor(() => h.commands.has('innerlore-snapshots'));
    await waitFor(() => !/no active chat/u.test(h.commands.get('innerlore-snapshots').callback()));

    // Hide message 1 (it becomes a system message) and edit message 3.
    chat[1].is_system = true;
    chat[3].mes = 'Turn 3 — I step through, rewritten.';
    const report = await h.commands.get('innerlore-snapshots').callback();

    assert.match(report, /Processed state: message 1: role changed: saved as user, now system/u);
    assert.match(report, /Snapshot after message 0: usable/u);
    assert.match(report, /Snapshot after message 2: unusable — message 1: role changed/u);
    assert.match(report, /Snapshot after message 4: unusable — message 1: role changed/u);
    assert.match(report, /A rebuild now would resume after message 0\./u);

    chat[1].is_system = false;
    const second = await h.commands.get('innerlore-snapshots').callback();
    assert.match(second, /Snapshot after message 2: usable/u);
    assert.match(second, /Snapshot after message 4: unusable — message 3: text changed — "Turn 3 — I step through, rewritten\."/u);
    assert.match(second, /A rebuild now would resume after message 2\./u);
    assert.ok(h.toasts.length >= 2, 'the report is shown on screen');

    // Nothing diverged: a rebuild resumes from the newest snapshot, not 0.
    chat[3].mes = 'Turn 3 — I step through.';
    const third = await h.commands.get('innerlore-snapshots').callback();
    assert.match(third, /Processed state: matches the chat\./u);
    assert.match(third, /A rebuild now would resume after message 4\./u);
});
