import { authorKeysFor, buildKeyStore, harvestKeys, splitKeyList, subSheets } from '../../public/scripts/extensions/weavers-vault/lorebook-keys.js';
import { buildLorebook } from '../../public/scripts/extensions/weavers-vault/lorebook-build.js';

const SHEET = [
    '- Servant Name: Jingle Abel Meunière;',
    '- Keywords: "Meunière","Meuniere","Coffin Staff Officer",',
    '- Role: Chaldea Coffin Staff Officer;',
].join('\n');

describe('splitKeyList / harvestKeys', () => {
    test('strips quotes, brackets and a trailing comma', () => {
        expect(splitKeyList('"Meunière","Meuniere","Coffin Staff Officer",')).toEqual([
            'Meunière',
            'Meuniere',
            'Coffin Staff Officer',
        ]);
    });

    test('reads the dash form and the bracket form', () => {
        expect(harvestKeys(SHEET)).toEqual(['Meunière', 'Meuniere', 'Coffin Staff Officer']);
        expect(harvestKeys('[Keywords: Artoria, Saber]')).toEqual(['Artoria', 'Saber']);
        expect(harvestKeys('- Spirit Origin: no keys here')).toEqual([]);
    });
});

describe('buildKeyStore', () => {
    test('stores the title, its slash parts and the declared keywords', () => {
        const store = buildKeyStore([{ title: 'Artoria Pendragon / Saber', content: SHEET }]).store;
        expect(store['artoria pendragon / saber']).toEqual([
            'Artoria Pendragon / Saber',
            'Artoria Pendragon',
            'Saber',
            'Meunière',
            'Meuniere',
            'Coffin Staff Officer',
        ]);
    });

    test('a container keeps its rows under their own names', () => {
        const content = ['[Name: Kiara Sessyoin', '- Keywords: "Dr. Kiara","Therapist Kiara"', '', '[Name: Cerejeira Elron', '- Keywords: "Cerejeira"'].join('\n');
        const store = buildKeyStore([{ title: 'Chaldea Staff', content }]).store;
        expect(store['kiara sessyoin']).toEqual(['Kiara Sessyoin', 'Dr. Kiara', 'Therapist Kiara']);
        expect(store['cerejeira elron']).toEqual(['Cerejeira Elron', 'Cerejeira']);
    });

    test('reports a key that two entries would both claim', () => {
        const { collisions } = buildKeyStore([
            { title: 'Caenis', content: '- Servant Name: Caenis;' },
            { title: 'Caenis (Summer)', content: '- Servant Name: Caenis;' },
        ]);
        expect(collisions.map((entry) => entry.key)).toContain('Caenis');
    });

    test('a qualified title falls back to the base name', () => {
        const store = { goetia: ['Goetia'] };
        expect(authorKeysFor(store, 'Goetia (Servant)')).toEqual(['Goetia']);
    });
});

describe('buildLorebook keys', () => {
    test('the author list is used as it stands, duplicates removed', () => {
        const text = '- Servant Name: Artoria Pendragon;\n- Height/Weight: 154cm, 42kg;';
        const { book } = buildLorebook({ text, authorKeys: { 'artoria pendragon': ['Saber', 'Seiba', 'saber'] } });
        const entry = Object.values(book.entries)[0];
        expect(entry.key).toEqual(['Saber', 'Seiba']);
    });
});