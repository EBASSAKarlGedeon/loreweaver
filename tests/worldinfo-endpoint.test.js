import { afterEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

import { router } from '../src/endpoints/worldinfo.js';

const temporaryDirectories = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function createApp(directory) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories: { worlds: directory } };
        if (req.path.endsWith('/import')) {
            req.file = {
                originalname: 'malformed.json',
                destination: directory,
                filename: 'upload.json',
            };
        }
        next();
    });
    app.use('/api/worldinfo', router);
    return app;
}

function makeDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loreweaver-worldinfo-endpoint-'));
    temporaryDirectories.push(directory);
    return directory;
}

describe('world info UID guard endpoints', () => {
    test('normalizes an imported array-form world before saving it', async () => {
        const directory = makeDirectory();
        const app = createApp(directory);
        const malformed = { entries: [{ content: 'one' }, { content: 'two' }] };

        const response = await request(app)
            .post('/api/worldinfo/import')
            .send({ convertedData: JSON.stringify(malformed) });

        expect(response.status).toBe(200);
        const saved = JSON.parse(fs.readFileSync(path.join(directory, 'malformed.json'), 'utf8'));
        expect(Array.isArray(saved.entries)).toBe(false);
        expect(saved.entries['0'].uid).toBe(0);
        expect(saved.entries['1'].uid).toBe(1);
    });

    test('normalizes an edit payload before saving it', async () => {
        const directory = makeDirectory();
        const app = createApp(directory);
        const malformed = { entries: { 'SKILLS-HUB': { uid: 1, content: 'one' } } };

        const response = await request(app)
            .post('/api/worldinfo/edit')
            .send({ name: 'edited', data: malformed });

        expect(response.status).toBe(200);
        const saved = JSON.parse(fs.readFileSync(path.join(directory, 'edited.json'), 'utf8'));
        expect(Object.keys(saved.entries)).toEqual(['1']);
        expect(saved.entries['1'].uid).toBe(1);
        expect(saved.entries['1'].extensions.legacy_id).toBe('SKILLS-HUB');
    });

    test('normalizes a world read through the get endpoint', async () => {
        const directory = makeDirectory();
        fs.writeFileSync(path.join(directory, 'book.json'), JSON.stringify({
            entries: { 0: { content: 'one' }, 1: { content: 'two' } },
        }));
        const app = createApp(directory);

        const response = await request(app)
            .post('/api/worldinfo/get')
            .send({ name: 'book' });

        expect(response.status).toBe(200);
        expect(Object.keys(response.body.entries)).toEqual(['0', '1']);
        expect(response.body.entries['0'].uid).toBe(0);
        expect(response.body.entries['1'].uid).toBe(1);
    });
});
