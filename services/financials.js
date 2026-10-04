const { Prisma } = require('@prisma/client');
const { fail, dateField, textField } = require('./apiHelpers');

const Decimal = Prisma.Decimal.clone({ precision: 40, rounding: Prisma.Decimal.ROUND_HALF_UP });
const categories = ['MATERIAL', 'TOOL', 'FERTILIZER', 'OTHER'];
const decimalField = (value, name, places, positive = false) => {
    if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d+)?$/.test(String(value))) fail(400, `${name} không hợp lệ`);
    const result = new Decimal(value);
    if (!result.isFinite() || result.isNegative() || positive && result.isZero() || result.decimalPlaces() > places || result.gte(new Decimal(10).pow(places === 3 ? 9 : 16))) fail(400, `${name} vượt giới hạn hoặc sai độ chính xác`);
    return result;
};

const entryData = (body, kind, existing) => {
    const expense = kind === 'expenses';
    const quantityField = expense ? 'quantity' : 'quantityKg';
    const dateName = expense ? 'incurredAt' : 'soldAt';
    const data = {};
    if (quantityField in body || !existing) data[quantityField] = decimalField(body[quantityField], quantityField, 3, true);
    if ('unitPrice' in body || !existing) data.unitPrice = decimalField(body.unitPrice, 'unitPrice', 2);
    if (dateName in body) data[dateName] = dateField(body[dateName], dateName);
    else if (!existing) data[dateName] = new Date();
    if ('notes' in body) data.notes = textField(body.notes, 'notes', 10000, true);
    if (expense) {
        if ('name' in body || !existing) data.name = textField(body.name, 'name', 255);
        if ('unit' in body || !existing) data.unit = textField(body.unit, 'unit', 50);
        if ('category' in body || !existing) {
            if (!categories.includes(body.category)) fail(400, 'Nhóm chi phí không hợp lệ');
            data.category = body.category;
        }
    } else if ('buyer' in body) data.buyer = textField(body.buyer, 'buyer', 255, true);
    data.amount = new Decimal(data[quantityField] ?? existing[quantityField]).mul(data.unitPrice ?? existing.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (data.amount.gte('10000000000000000')) fail(400, 'Thành tiền vượt giới hạn');
    return data;
};

const sum = (rows, field) => rows.reduce((total, row) => total.plus(row[field] ?? 0), new Decimal(0));
const financialSummary = (sales = [], expenses = [], harvests = []) => {
    const revenue = sum(sales, 'amount');
    const totalCost = sum(expenses, 'amount');
    const profit = revenue.minus(totalCost);
    const yieldKg = sum(harvests, 'totalYieldKg');
    return {
        currency: 'VND', totalHarvestKg: yieldKg.toNumber(), totalSoldKg: sum(sales, 'quantityKg').toNumber(),
        revenue: revenue.toFixed(2), totalCost: totalCost.toFixed(2), profit: profit.toFixed(2),
        costsByCategory: Object.fromEntries(categories.map((category) => [category, sum(expenses.filter((row) => row.category === category), 'amount').toFixed(2)])),
        profitMarginPercent: revenue.isZero() ? null : profit.div(revenue).mul(100).toFixed(2),
        costPerHarvestKg: yieldKg.isZero() ? null : totalCost.div(yieldKg).toFixed(2)
    };
};

const financialSeries = (sales, expenses, groupBy) => {
    const periods = new Map();
    for (const [rows, dateName, kind] of [[sales, 'soldAt', 'revenue'], [expenses, 'incurredAt', 'totalCost']]) for (const row of rows) {
        const local = new Date(new Date(row[dateName]).getTime() + 7 * 3600000).toISOString();
        const period = local.slice(0, groupBy === 'day' ? 10 : 7);
        if (!periods.has(period)) periods.set(period, { period, revenue: new Decimal(0), totalCost: new Decimal(0) });
        periods.get(period)[kind] = periods.get(period)[kind].plus(row.amount);
    }
    return [...periods.values()].sort((left, right) => left.period.localeCompare(right.period)).map((row) => ({ period: row.period, revenue: row.revenue.toFixed(2), totalCost: row.totalCost.toFixed(2), profit: row.revenue.minus(row.totalCost).toFixed(2) }));
};

module.exports = { entryData, financialSummary, financialSeries, decimalField };
