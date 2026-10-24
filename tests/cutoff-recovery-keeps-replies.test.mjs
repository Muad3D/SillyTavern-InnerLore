import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyStore, incompleteProseReason } from '../core.js';
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

test('quotation checks look only for an opener left dangling at the end', () => {
    // Complete prose the whole-reply count used to flag.
    assert.equal(incompleteProseReason('“The first paragraph of a long speech.\n\n“The second, still talking.\n\n“And the end of it.”'), '');
    assert.equal(incompleteProseReason('“Mixed marks," he says. She nods.'), '');
    assert.equal(incompleteProseReason('A stray “ slipped in early.\n\nThe last line is calm and complete.'), '');
    assert.equal(incompleteProseReason('"Wait—" Aldric catches the door.'), '');
    assert.equal(incompleteProseReason('He measures the post: six feet. "Done," he says.'), '');
    // Real cut-offs still caught.
    assert.equal(incompleteProseReason('He leans in. "Listen to me'), 'unclosed quotation');
    assert.equal(incompleteProseReason('Mara turns.\n\n“You promised you would'), 'unclosed quotation');
    assert.equal(incompleteProseReason('She whispers (barely audible'), 'unclosed parenthesis');
});

function harness({ chat, store, generate }) {
    const listeners = createEventListeners();
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
        SlashCommandParser: null,
        SlashCommand: null,
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
    return { chatMetadata, events, listeners, toasts };
}

test('a reply still looking cut short after Continue is kept, not deleted, and counted', async () => {
    const chat = [
        { is_user: false, is_system: false, name: 'Narrator', mes: 'The hearing begins.' },
        { is_user: true, is_system: false, name: 'Player', mes: 'I wait.' },
        { is_user: false, is_system: false, name: 'Narrator', mes: 'Osric turns toward the', extra: {} },
    ];
    const store = createEmptyStore('kept-reply-chat');
    store.lastProcessedIndex = 0;
    const continues = [];
    const h = harness({
        chat,
        store,
        generate: async (type, _options, { chat: messages, listeners, events }) => {
            continues.push(type);
            // The continuation never resolves the ending.
            messages[2].mes += ' window, and the';
            listeners.get(events.MESSAGE_RECEIVED)(2, 'continue');
        },
    });
    await import(`../index.js?cutoff-kept-reply=${Date.now()}`);
    await waitFor(() => h.listeners.has(h.events.MESSAGE_RECEIVED));
    h.listeners.get(h.events.MESSAGE_RECEIVED)(2, 'normal');
    await waitFor(() => chat[2]?.extra?.inner_lore_output_recovery);

    assert.deepEqual(continues, ['continue', 'continue']);
    assert.equal(chat.length, 3, 'the reply stays in the chat');
    assert.match(chat[2].mes, /^Osric turns toward the window/u);
    assert.deepEqual(chat[2].extra.inner_lore_output_recovery, {
        attempts: 2, completed: false, reason: 'trailing connector', quarantined: false, kept: true,
    });
    assert.equal(h.chatMetadata.inner_lore.lastOutputRecovery.quarantined, false);
    assert.equal(h.chatMetadata.inner_lore.assistantTurnsSincePass, 1, 'the kept reply counts as a story turn');
    assert.ok(h.toasts.some(message => /Kept the reply/u.test(message)));
});
