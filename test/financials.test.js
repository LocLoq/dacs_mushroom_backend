const assert = require('node:assert/strict');
const { test } = require('node:test');
const { entryData, financialSummary, financialSeries } = require('../services/financials');
const { dateField } = require('../services/apiHelpers');

test('money multiplication rounds half up and validates precision and overflow', () => {
    assert.equal(entryData({ quantityKg: '2.500', unitPrice: '10.25' }, 'sales').amount.toFixed(2), '25.63');
    for (const body of [{ quantityKg: false, unitPrice: '1' }, { quantityKg: '1.0001', unitPrice: '1' }, { quantityKg: '1', unitPrice: '-1' }, { quantityKg: '1', unitPrice: '1.001' }, { quantityKg: '999999999.999', unitPrice: '9999999999999999.99' }]) {
        assert.throws(() => entryData(body, 'sales'), (error) => error.status === 400);
    }
});

test('summary preserves large monetary totals and represents loss and missing ratios', () => {
    const summary = financialSummary([{ amount: '9999999999999999.99', quantityKg: '1' }, { amount: '9999999999999999.99', quantityKg: '1' }], [], []);
    assert.equal(summary.revenue, '19999999999999999.98');
    assert.equal(summary.costPerHarvestKg, null);
    const loss = financialSummary([], [{ category: 'TOOL', amount: '10.10' }], []);
    assert.equal(loss.profit, '-10.10');
    assert.equal(loss.profitMarginPercent, null);
    assert.equal(loss.costsByCategory.TOOL, '10.10');
});

test('financial timeline groups event dates across midnight in Vietnam', () => {
    const series = financialSeries([{ soldAt: '2026-09-30T18:00:00Z', amount: '30.25' }], [{ incurredAt: '2026-10-01T00:00:00Z', amount: '10.10' }], 'day');
    assert.deepEqual(series, [{ period: '2026-10-01', revenue: '30.25', totalCost: '10.10', profit: '20.15' }]);
});

test('financial dates reject impossible calendar days and timestamps without timezone', () => {
    assert.throws(() => dateField('2026-02-30', 'soldAt'));
    assert.throws(() => dateField('2026-10-03T08:00:00', 'soldAt'));
    assert.equal(dateField('2026-10-03T08:00:00+07:00', 'soldAt').toISOString(), '2026-10-03T01:00:00.000Z');
});
