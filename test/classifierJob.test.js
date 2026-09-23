const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const updates = [];
const events = [];
const auditEntries = [];
global.prisma = {
    classifierLookup: { update: async (args) => { updates.push(args); return args.data; } },
    auditLog: { create: async ({ data }) => auditEntries.push(data) }
};
global.io = { to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
const { createMushroomClassifierProcessor } = require('../jobs/mushroom');

test('classifier worker persists success before broadcasting and removes the input image', async () => {
    updates.length = 0;
    events.length = 0;
    auditEntries.length = 0;
    const inputPath = path.join(os.tmpdir(), `classifier-${Date.now()}.png`);
    await fs.promises.writeFile(inputPath, 'image');
    const sendMushroomClassifierReq = createMushroomClassifierProcessor({
        classify: async () => ({ result: { name: 'Nấm demo', edibility: 'NON_POISONOUS', confidence: 0.98 } })
    });
    await sendMushroomClassifierReq({ data: { lookupId: '11111111-1111-4111-8111-111111111111', originalName: 'mushroom.png', mimeType: 'image/png', path: inputPath } });
    assert.equal(updates[0].data.status, 'PROCESSING');
    assert.equal(updates[1].data.status, 'SUCCEEDED');
    assert.equal(events.at(-1).event, 'finished');
    assert.equal(auditEntries[0].action, 'CLASSIFIER_COMPLETED');
    await assert.rejects(fs.promises.access(inputPath));
});
