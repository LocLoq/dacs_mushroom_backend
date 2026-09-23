const express = require('express');
const ExcelJS = require('exceljs');
const path = require('path');
const pdfMake = require('pdfmake');

const { auditAction } = require('../middlewares/audit');
const { authenticateToken, authorizeRoles } = require('../middlewares/auth');

const router = express.Router();
const prisma = global.prisma;
const allowedTypes = new Set(['overview', 'cultivation', 'classifier', 'audit']);
const allowedStatuses = new Set(['PREPARATION', 'INCUBATION', 'FRUITING', 'HARVESTING', 'COMPLETED', 'FAILED']);
const pdfFontDirectory = path.join(__dirname, '..', 'node_modules', 'pdfmake', 'fonts', 'Roboto');

pdfMake.addFonts({
    Roboto: {
        normal: path.join(pdfFontDirectory, 'Roboto-Regular.ttf'),
        bold: path.join(pdfFontDirectory, 'Roboto-Medium.ttf'),
        italics: path.join(pdfFontDirectory, 'Roboto-Italic.ttf'),
        bolditalics: path.join(pdfFontDirectory, 'Roboto-MediumItalic.ttf')
    }
});
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy((filePath) => path.resolve(filePath).startsWith(path.resolve(pdfFontDirectory)));

const parsePositiveInteger = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toDate = (value, endOfDay = false) => {
    if (!value) return undefined;
    const text = String(value);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
        ? new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+07:00`)
        : new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
};

const getFilters = (query) => {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), 0, 1);
    const parsedFrom = toDate(query.from);
    const parsedTo = toDate(query.to, true);
    const from = parsedFrom === undefined ? defaultFrom : parsedFrom;
    const to = parsedTo === undefined ? now : parsedTo;
    const facilityId = query.facilityId ? parsePositiveInteger(query.facilityId) : undefined;
    const mushroomId = query.mushroomId ? parsePositiveInteger(query.mushroomId) : undefined;
    const status = query.status || undefined;
    const groupBy = query.groupBy || 'month';
    const page = parsePositiveInteger(query.page) || 1;
    const limit = Math.min(parsePositiveInteger(query.limit) || 20, 100);
    const maxRange = 5 * 366 * 24 * 60 * 60 * 1000;

    if (!from || !to || from > to || to - from > maxRange || (query.facilityId && !facilityId) || (query.mushroomId && !mushroomId) || (status && !allowedStatuses.has(status)) || !['day', 'month'].includes(groupBy)) {
        return { error: 'Bộ lọc báo cáo không hợp lệ hoặc vượt quá 5 năm' };
    }
    return { from, to, facilityId, mushroomId, status, groupBy, page, limit };
};

const batchWhere = (filters) => ({
    ...(filters.facilityId && { facilityId: filters.facilityId }),
    ...(filters.mushroomId && { mushroomId: filters.mushroomId }),
    ...(filters.status && { status: filters.status }),
    startDate: { gte: filters.from, lte: filters.to }
});

const harvestWhere = (filters) => ({
    harvestedAt: { gte: filters.from, lte: filters.to },
    batch: {
        ...(filters.facilityId && { facilityId: filters.facilityId }),
        ...(filters.mushroomId && { mushroomId: filters.mushroomId }),
        ...(filters.status && { status: filters.status })
    }
});

const dateKey = (value, groupBy) => {
    const date = new Date(value);
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    return groupBy === 'month' ? month : `${month}-${String(date.getUTCDate()).padStart(2, '0')}`;
};

const seriesFromRows = (rows, field, groupBy) => Object.values(rows.reduce((accumulator, row) => {
    const key = dateKey(row.createdAt || row.harvestedAt, groupBy);
    accumulator[key] = accumulator[key] || { period: key, count: 0, totalYieldKg: 0 };
    accumulator[key].count += 1;
    if (field) accumulator[key].totalYieldKg += Number(row[field] || 0);
    return accumulator;
}, {})).sort((left, right) => left.period.localeCompare(right.period));

const getCultivationRows = async (filters, skip = 0, take = 20) => {
    const rows = await prisma.cultivationBatch.findMany({
        where: batchWhere(filters), skip, take, orderBy: { startDate: 'desc' },
        include: {
            facility: { select: { name: true, province: true } },
            mushroom: { select: { commonName: true, scientificName: true } },
            harvestRecords: { where: { harvestedAt: { gte: filters.from, lte: filters.to } }, select: { totalYieldKg: true } },
            growthRecords: { take: 1, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: { stage: true, recordedAt: true } }
        }
    });
    return rows.map((row) => ({
        batchCode: row.batchCode, facility: row.facility.name, province: row.facility.province,
        mushroom: row.mushroom.commonName, scientificName: row.mushroom.scientificName,
        status: row.status, startDate: row.startDate, expectedHarvestDate: row.expectedHarvestDate,
        endDate: row.endDate, defectRate: row.defectRate,
        totalHarvestKg: row.harvestRecords.reduce((sum, item) => sum + item.totalYieldKg, 0),
        latestGrowthStage: row.growthRecords[0]?.stage || null,
        latestGrowthRecordedAt: row.growthRecords[0]?.recordedAt || null
    }));
};

const getClassifierRows = async (filters, skip = 0, take = 20) => prisma.classifierLookup.findMany({
    where: { createdAt: { gte: filters.from, lte: filters.to } }, skip, take, orderBy: { createdAt: 'desc' },
    select: { id: true, originalName: true, status: true, predictedName: true, edibility: true, confidence: true, errorMessage: true, createdAt: true, completedAt: true, user: { select: { username: true } } }
});

const getAuditRows = async (filters, skip = 0, take = 20) => prisma.auditLog.findMany({
    where: { createdAt: { gte: filters.from, lte: filters.to } }, skip, take, orderBy: { createdAt: 'desc' },
    select: { actorUsername: true, actorRole: true, action: true, entityType: true, entityId: true, method: true, path: true, statusCode: true, outcome: true, durationMs: true, createdAt: true }
});

const getOverview = async (filters) => {
    const cultivationWhere = batchWhere(filters);
    const [facilities, species, batchCount, statusBreakdown, harvestAggregate, overdueBatches, classifierRows, auditRows, harvestRows] = await Promise.all([
        prisma.productionFacility.count({ where: filters.facilityId ? { id: filters.facilityId } : {} }),
        prisma.mushroom.count({ where: filters.mushroomId ? { id: filters.mushroomId } : {} }),
        prisma.cultivationBatch.count({ where: cultivationWhere }),
        prisma.cultivationBatch.groupBy({ by: ['status'], where: cultivationWhere, _count: { _all: true }, _avg: { defectRate: true } }),
        prisma.harvestRecord.aggregate({ where: harvestWhere(filters), _sum: { totalYieldKg: true } }),
        prisma.cultivationBatch.count({ where: { ...cultivationWhere, expectedHarvestDate: { lte: new Date() }, status: { in: ['PREPARATION', 'INCUBATION', 'FRUITING', 'HARVESTING'] } } }),
        prisma.classifierLookup.findMany({ where: { createdAt: { gte: filters.from, lte: filters.to } }, select: { status: true, predictedName: true, confidence: true, createdAt: true } }),
        prisma.auditLog.findMany({ where: { createdAt: { gte: filters.from, lte: filters.to } }, select: { action: true, actorUsername: true, outcome: true, createdAt: true } }),
        prisma.harvestRecord.findMany({ where: harvestWhere(filters), select: { harvestedAt: true, totalYieldKg: true } })
    ]);
    const statusMap = Object.fromEntries(statusBreakdown.map((item) => [item.status, { count: item._count._all, averageDefectRate: item._avg.defectRate }]));
    const succeeded = classifierRows.filter((item) => item.status === 'SUCCEEDED');
    const predictions = Object.entries(classifierRows.reduce((accumulator, item) => {
        if (item.predictedName) accumulator[item.predictedName] = (accumulator[item.predictedName] || 0) + 1;
        return accumulator;
    }, {})).sort((left, right) => right[1] - left[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
    const actions = Object.entries(auditRows.reduce((accumulator, item) => { accumulator[item.action] = (accumulator[item.action] || 0) + 1; return accumulator; }, {})).map(([action, count]) => ({ action, count }));
    return {
        period: { from: filters.from, to: filters.to, groupBy: filters.groupBy },
        cultivation: { facilities, species, batchCount, statusBreakdown: statusMap, overdueBatches, totalHarvestKg: harvestAggregate._sum.totalYieldKg || 0, harvestSeries: seriesFromRows(harvestRows, 'totalYieldKg', filters.groupBy) },
        classifier: { total: classifierRows.length, succeeded: succeeded.length, failed: classifierRows.filter((item) => item.status === 'FAILED').length, averageConfidence: succeeded.length ? succeeded.reduce((sum, item) => sum + (item.confidence || 0), 0) / succeeded.length : null, topPredictions: predictions, series: seriesFromRows(classifierRows, null, filters.groupBy) },
        audit: { totalActions: auditRows.length, failedActions: auditRows.filter((item) => item.outcome === 'FAILURE').length, actions, series: seriesFromRows(auditRows, null, filters.groupBy) }
    };
};

const reportHandler = (action, handler) => [auditAction(action, { entityType: 'Report' }), authenticateToken, authorizeRoles(...global.privilegedRoles), handler];

router.get('/overview', ...reportHandler('REPORT_OVERVIEW_VIEW', async (req, res) => {
    const filters = getFilters(req.query);
    if (filters.error) return res.status(400).json({ message: filters.error });
    try { res.json({ data: await getOverview(filters) }); } catch (error) { console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); }
}));

router.get('/cultivation', ...reportHandler('REPORT_CULTIVATION_VIEW', async (req, res) => {
    const filters = getFilters(req.query);
    if (filters.error) return res.status(400).json({ message: filters.error });
    try {
        const [totalItems, data] = await Promise.all([prisma.cultivationBatch.count({ where: batchWhere(filters) }), getCultivationRows(filters, (filters.page - 1) * filters.limit, filters.limit)]);
        res.json({ data, pagination: { totalItems, currentPage: filters.page, totalPages: Math.ceil(totalItems / filters.limit), pageSize: filters.limit } });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); }
}));

router.get('/classifier', ...reportHandler('REPORT_CLASSIFIER_VIEW', async (req, res) => {
    const filters = getFilters(req.query);
    if (filters.error) return res.status(400).json({ message: filters.error });
    try {
        const where = { createdAt: { gte: filters.from, lte: filters.to } };
        const [totalItems, data] = await Promise.all([prisma.classifierLookup.count({ where }), getClassifierRows(filters, (filters.page - 1) * filters.limit, filters.limit)]);
        res.json({ data, pagination: { totalItems, currentPage: filters.page, totalPages: Math.ceil(totalItems / filters.limit), pageSize: filters.limit } });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); }
}));

router.get('/audit', ...reportHandler('REPORT_AUDIT_VIEW', async (req, res) => {
    const filters = getFilters(req.query);
    if (filters.error) return res.status(400).json({ message: filters.error });
    try {
        const where = { createdAt: { gte: filters.from, lte: filters.to } };
        const [totalItems, data] = await Promise.all([prisma.auditLog.count({ where }), getAuditRows(filters, (filters.page - 1) * filters.limit, filters.limit)]);
        res.json({ data, pagination: { totalItems, currentPage: filters.page, totalPages: Math.ceil(totalItems / filters.limit), pageSize: filters.limit } });
    } catch (error) { console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); }
}));

const columnsFor = (type) => ({
    cultivation: [['Mã lô', 'batchCode'], ['Cơ sở', 'facility'], ['Tỉnh', 'province'], ['Nấm', 'mushroom'], ['Trạng thái', 'status'], ['Bắt đầu', 'startDate'], ['Thu hoạch (kg)', 'totalHarvestKg'], ['Giai đoạn mới nhất', 'latestGrowthStage']],
    classifier: [['ID', 'id'], ['Tệp ảnh', 'originalName'], ['Trạng thái', 'status'], ['Dự đoán', 'predictedName'], ['Độ ăn được', 'edibility'], ['Độ tin cậy', 'confidence'], ['Người gửi', 'user.username'], ['Thời gian', 'createdAt']],
    audit: [['Người thao tác', 'actorUsername'], ['Vai trò', 'actorRole'], ['Hành động', 'action'], ['Đối tượng', 'entityType'], ['ID đối tượng', 'entityId'], ['Method', 'method'], ['HTTP', 'statusCode'], ['Kết quả', 'outcome'], ['Thời gian', 'createdAt']]
}[type] || [['Chỉ số', 'metric'], ['Giá trị', 'value']]);

const valueAt = (row, key) => key.split('.').reduce((value, part) => value?.[part], row) ?? '';
const stringify = (value) => value instanceof Date ? value.toISOString() : String(value ?? '');
const csvCell = (value) => `"${stringify(value).replace(/"/g, '""')}"`;

const overviewRows = (overview) => [
    { metric: 'Tổng lô', value: overview.cultivation.batchCount },
    { metric: 'Tổng sản lượng (kg)', value: overview.cultivation.totalHarvestKg },
    { metric: 'Lô trễ hạn', value: overview.cultivation.overdueBatches },
    { metric: 'Lượt classifier', value: overview.classifier.total },
    { metric: 'Hành động audit', value: overview.audit.totalActions }
];

const exportRows = async (type, filters, maxRows) => {
    if (type === 'overview') return overviewRows(await getOverview(filters));
    const getRows = { cultivation: getCultivationRows, classifier: getClassifierRows, audit: getAuditRows }[type];
    const rows = await getRows(filters, 0, maxRows + 1);
    if (rows.length > maxRows) return null;
    return rows;
};

router.get('/:type/export', ...reportHandler('REPORT_EXPORT', async (req, res) => {
    const { type } = req.params;
    const format = String(req.query.format || '').toLowerCase();
    const filters = getFilters(req.query);
    if (!allowedTypes.has(type) || !['csv', 'xlsx', 'pdf'].includes(format)) return res.status(400).json({ message: 'Loại báo cáo hoặc định dạng xuất không hợp lệ' });
    if (filters.error) return res.status(400).json({ message: filters.error });

    try {
        const maxRows = format === 'pdf' ? 2000 : 50000;
        const rows = await exportRows(type, filters, maxRows);
        if (!rows) return res.status(422).json({ message: `Báo cáo vượt quá giới hạn ${maxRows.toLocaleString('vi-VN')} dòng; vui lòng thu hẹp bộ lọc` });
        const columns = columnsFor(type);
        const filename = `${type}-report-${new Date().toISOString().slice(0, 10)}`;

        if (format === 'csv') {
            const csv = [columns.map(([label]) => csvCell(label)).join(','), ...rows.map((row) => columns.map(([, key]) => csvCell(valueAt(row, key))).join(','))].join('\r\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
            return res.send(`\uFEFF${csv}`);
        }

        if (format === 'xlsx') {
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet('Báo cáo');
            sheet.columns = columns.map(([header, key]) => ({ header, key, width: Math.max(14, header.length + 4) }));
            rows.forEach((row) => sheet.addRow(Object.fromEntries(columns.map(([, key]) => [key, valueAt(row, key)]))));
            sheet.getRow(1).font = { bold: true };
            const buffer = await workbook.xlsx.writeBuffer();
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
            return res.send(Buffer.from(buffer));
        }

        const document = {
            defaultStyle: { font: 'Roboto', fontSize: 8 }, pageOrientation: 'landscape',
            content: [
                { text: `Báo cáo ${type}`, style: 'header' },
                { text: `Từ ${filters.from.toISOString()} đến ${filters.to.toISOString()}`, margin: [0, 0, 0, 12] },
                { table: { headerRows: 1, widths: Array(columns.length).fill('*'), body: [columns.map(([label]) => ({ text: label, bold: true })), ...rows.map((row) => columns.map(([, key]) => stringify(valueAt(row, key))))] } }
            ],
            styles: { header: { fontSize: 16, bold: true } }
        };
        const buffer = await pdfMake.createPdf(document).getBuffer();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
        return res.send(Buffer.from(buffer));
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Không thể xuất báo cáo' });
    }
}));

module.exports = router;
