const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { classifierUploadDirectory } = require('../../services/classifierLifecycle');

const equal = (a, b) => a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : a === b;
function matches(row, where) {
    return Object.entries(where).every(([key, value]) => {
        if (value === undefined) return true;
        if (value && typeof value === 'object' && !(value instanceof Date)) {
            if (value.in) return value.in.includes(row[key]);
            if (value.gt !== undefined) return row[key] > value.gt;
        }
        return equal(row[key], value);
    });
}

function lookupStore(initial = []) {
    const rows = new Map(initial.map((row) => [row.id, structuredClone(row)]));
    const updates = [];
    const classifierLookup = {
        create: async ({ data }) => {
            const row = { id: crypto.randomUUID(), status: 'QUEUED', queuedAt: new Date(), updatedAt: new Date(), startedAt: null, completedAt: null, ...data };
            rows.set(row.id, row);
            return structuredClone(row);
        },
        findUnique: async ({ where }) => structuredClone(rows.get(where.id) || null),
        findFirst: async ({ where }) => structuredClone([...rows.values()].find((row) => matches(row, where)) || null),
        findMany: async ({ where, take = 100 } = {}) => [...rows.values()].filter((row) => matches(row, where || {}))
            .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map((row) => structuredClone(row)),
        updateMany: async ({ where, data }) => {
            updates.push({ where, data });
            let count = 0;
            for (const row of rows.values()) {
                if (!matches(row, where)) continue;
                Object.assign(row, data, { updatedAt: new Date(Math.max(Date.now(), new Date(row.updatedAt).getTime() + 1)) });
                count++;
            }
            return { count };
        },
        count: async () => rows.size
    };
    return { prisma: { classifierLookup, auditLog: { create: async () => {} } }, rows, updates };
}

async function inputFile() {
    await fs.promises.mkdir(classifierUploadDirectory, { recursive: true });
    const inputPath = path.join(classifierUploadDirectory, `${crypto.randomUUID()}.png`);
    await fs.promises.writeFile(inputPath, 'image');
    return inputPath;
}

module.exports = { lookupStore, inputFile };
