const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { loadEnvironment, getDatabaseUrl } = require('../config/environment.cjs');
const { classifierConfig, retryDelay } = require('../config/classifier.cjs');

test('injected environment works without a local env file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'mushroom-env-'));
    const key = 'MUSHROOM_ENV_TEST_VALUE';
    const previous = process.env[key];
    try {
        process.env[key] = 'injected-value';
        assert.doesNotThrow(() => loadEnvironment(path.join(directory, 'missing.env')));
        writeFileSync(path.join(directory, '.env'), `${key}=file-value\nMUSHROOM_ENV_TEST_FILE=loaded\n`);
        loadEnvironment(path.join(directory, '.env'));
        assert.equal(process.env[key], 'injected-value');
        assert.equal(process.env.MUSHROOM_ENV_TEST_FILE, 'loaded');
        assert.throws(() => loadEnvironment(directory));
    } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
        delete process.env.MUSHROOM_ENV_TEST_FILE;
        unlinkSync(path.join(directory, '.env'));
        rmdirSync(directory);
    }
});

test('Prisma URL preserves explicit configuration and encodes database credentials', () => {
    assert.equal(getDatabaseUrl({ DATABASE_URL: 'mysql://custom/database' }), 'mysql://custom/database');
    assert.equal(getDatabaseUrl({}), undefined);
    const url = new URL(getDatabaseUrl({
        DATABASE_HOST: 'db', DATABASE_USER: 'app@user', DATABASE_PASSWORD: 'p@ss:/?#% word',
        DATABASE_NAME: 'mushroom management', DATABASE_PORT: '3307'
    }));
    assert.equal(url.hostname, 'db');
    assert.equal(url.port, '3307');
    assert.equal(decodeURIComponent(url.username), 'app@user');
    assert.equal(decodeURIComponent(url.password), 'p@ss:/?#% word');
    assert.equal(decodeURIComponent(url.pathname), '/mushroom management');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(getDatabaseUrl({ DATABASE_HOST: '::1', DATABASE_USER: 'app', DATABASE_NAME: 'db' }),
        'mysql://app:@[::1]:3306/db');
});

test('classifier configuration validates overrides and preserves retry and watchdog defaults', () => {
    const config = classifierConfig({});
    assert.equal(config.attempts, 3);
    assert.equal(config.queueWaitMs, 300000);
    assert.equal(config.processingTimeoutMs, 150000);
    assert.deepEqual([1, 2].map((attempt) => retryDelay(attempt, config.backoffMs)), [30000, 60000]);
    assert.equal(classifierConfig({ CLASSIFIER_TIMEOUT_MS: '200000' }).processingTimeoutMs, 230000);
    assert.equal(classifierConfig({ CLASSIFIER_JOB_ATTEMPTS: '5' }).attempts, 5);
    for (const value of ['0', '-1', 'abc', '1.5', '']) {
        assert.throws(() => classifierConfig({ CLASSIFIER_JOB_ATTEMPTS: value }));
    }
});
