import { describe, expect, test } from '@jest/globals';
import { isChatPath, splitChatLines, joinChatLines, chatPrefixMerge, planMerge } from '../../src/sync/merge.js';

const chat = (header, ...messages) => Buffer.from([header, ...messages].join('\n') + '\n', 'utf-8');
const META = '{"chat_metadata":{"integrity":"abc"}}';
const MSG = (i) => JSON.stringify({ name: 'Char', is_user: i % 2 === 0, mes: `message ${i}` });

describe('isChatPath', () => {
    test('recognises chat files', () => {
        expect(isChatPath('chats/room/chat.jsonl')).toBe(true);
        expect(isChatPath('group chats/g.jsonl')).toBe(true);
        expect(isChatPath('chats/room/notes.txt')).toBe(false);
        expect(isChatPath('characters/x.json')).toBe(false);
    });
});

describe('splitChatLines / joinChatLines', () => {
    test('splits header and messages', () => {
        const buf = chat(META, MSG(0), MSG(1));
        const { header, messages } = splitChatLines(buf);
        expect(header).toBe(META);
        expect(messages).toHaveLength(2);
        expect(JSON.parse(messages[0]).mes).toBe('message 0');
    });

    test('round-trips through join', () => {
        const buf = chat(META, MSG(0), MSG(1));
        const { header, messages } = splitChatLines(buf);
        const rebuilt = joinChatLines(header, messages);
        expect(rebuilt.equals(buf)).toBe(true);
    });

    test('tolerates missing chat_metadata header', () => {
        const buf = Buffer.from('not json\nline2\n', 'utf-8');
        const { header, messages } = splitChatLines(buf);
        expect(header).toBe('');
        expect(messages).toEqual(['not json', 'line2']);
    });

    test('tolerates empty files', () => {
        const { header, messages } = splitChatLines(Buffer.alloc(0));
        expect(header).toBe('');
        expect(messages).toEqual([]);
    });
});

describe('chatPrefixMerge', () => {
    test('local is a prefix of hub: hub wins (continued on another device)', () => {
        const local = chat(META, MSG(0), MSG(1));
        const hub = chat(META, MSG(0), MSG(1), MSG(2));
        const plan = chatPrefixMerge(local, hub);
        expect(plan?.action).toBe('fast-forward');
        expect(plan?.winner).toBe('hub');
        expect(plan?.content.equals(hub)).toBe(true);
    });

    test('hub is a prefix of local: local wins', () => {
        const local = chat(META, MSG(0), MSG(1), MSG(2));
        const hub = chat(META, MSG(0), MSG(1));
        const plan = chatPrefixMerge(local, hub);
        expect(plan?.action).toBe('fast-forward');
        expect(plan?.winner).toBe('local');
        expect(plan?.content.equals(local)).toBe(true);
    });

    test('identical content is a fast-forward (no-op)', () => {
        const buf = chat(META, MSG(0));
        const plan = chatPrefixMerge(buf, buf);
        expect(plan?.action).toBe('fast-forward');
        expect(plan?.reason).toBe('equal');
    });

    test('diverged messages return null (fall through to Rule B)', () => {
        const local = chat(META, MSG(0), MSG(1), 'swipe-b');
        const hub = chat(META, MSG(0), MSG(1), 'swipe-a');
        expect(chatPrefixMerge(local, hub)).toBeNull();
    });

    test('edited middle message returns null', () => {
        const local = chat(META, MSG(0), '{"name":"Char","mes":"edited"}');
        const hub = chat(META, MSG(0), MSG(1));
        expect(chatPrefixMerge(local, hub)).toBeNull();
    });

    test('empty local file: hub wins', () => {
        const plan = chatPrefixMerge(Buffer.alloc(0), chat(META, MSG(0)));
        expect(plan?.action).toBe('fast-forward');
        expect(plan?.winner).toBe('hub');
    });
});

describe('planMerge', () => {
    test('chat prefix case fast-forwards', () => {
        const local = chat(META, MSG(0));
        const hub = chat(META, MSG(0), MSG(1));
        const plan = planMerge('chats/r/chat.jsonl', local, hub);
        expect(plan.action).toBe('fast-forward');
        expect(plan.winner).toBe('hub');
    });

    test('non-chat file falls back to hub (Rule B)', () => {
        const plan = planMerge('characters/x.json', Buffer.from('local'), Buffer.from('hub'));
        expect(plan.action).toBe('hub');
        expect(plan.content?.toString()).toBe('hub');
    });

    test('chat divergence falls back to hub (Rule B)', () => {
        const local = chat(META, MSG(0), 'swipe-b');
        const hub = chat(META, MSG(0), 'swipe-a');
        const plan = planMerge('chats/r/chat.jsonl', local, hub);
        expect(plan.action).toBe('hub');
    });

    test('delete on hub, edit locally: local wins', () => {
        const plan = planMerge('chats/r/chat.jsonl', Buffer.from('edit'), null);
        expect(plan.action).toBe('local');
    });

    test('delete locally, edit on hub: hub wins', () => {
        const plan = planMerge('chats/r/chat.jsonl', null, Buffer.from('hub edit'));
        expect(plan.action).toBe('hub');
    });

    test('deleted on both sides: manual/no-op', () => {
        const plan = planMerge('chats/r/chat.jsonl', null, null);
        expect(plan.action).toBe('manual');
        expect(plan.content).toBeNull();
    });
});
