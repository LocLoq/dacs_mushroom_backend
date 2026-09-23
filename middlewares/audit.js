const crypto = require('crypto');

const IMPORTANT_GET_PATHS = new Set([
    '/api/reports/overview',
    '/api/reports/cultivation',
    '/api/reports/classifier',
    '/api/reports/audit',
    '/api/admin/audit-logs',
    '/api/admin/users',
    '/api/admin/roles'
]);

const safeValue = (value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value.slice(0, 500);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 20).map(safeValue);
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !['password', 'password_hash', 'token', 'authorization'].includes(key.toLowerCase()))
            .slice(0, 20)
            .map(([key, item]) => [key, safeValue(item)]));
    }
    return String(value).slice(0, 500);
};

const writeAuditLog = async (data) => {
    try {
        await global.prisma.auditLog.create({ data });
    } catch (error) {
        console.error('Unable to write audit log:', error.message);
    }
};

const auditAction = (action, options = {}) => (req, res, next) => {
    res.locals.audit = {
        action,
        entityType: options.entityType,
        entityId: options.entityId,
        metadata: options.metadata
    };
    next();
};

const auditMiddleware = (req, res, next) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
        const pathname = req.originalUrl.split('?')[0];
        const taggedAudit = res.locals.audit;
        const shouldAudit = Boolean(taggedAudit)
            || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
            || IMPORTANT_GET_PATHS.has(pathname);

        if (!shouldAudit || pathname === '/api/test') return;

        const audit = taggedAudit || {};
        const actor = req.user || res.locals.auditActor;
        const pathSegments = pathname.split('/').filter(Boolean);
        const fallbackEntityType = pathSegments[1] || 'api';
        const fallbackEntityId = pathSegments.slice(2).find((segment) => /^\d+$/.test(segment)) || null;
        const suppliedMetadata = typeof audit.metadata === 'function'
            ? audit.metadata(req, res)
            : audit.metadata;

        void writeAuditLog({
            actorUserId: actor?.id || null,
            actorUsername: actor?.username || null,
            actorRole: actor?.role || null,
            action: audit.action || `${req.method}_${fallbackEntityType.replace(/-/g, '_').toUpperCase()}`,
            entityType: audit.entityType || fallbackEntityType,
            entityId: (typeof audit.entityId === 'function' ? audit.entityId(req, res) : audit.entityId) || fallbackEntityId,
            method: req.method,
            path: pathname,
            statusCode: res.statusCode,
            outcome: res.statusCode >= 200 && res.statusCode < 400 ? 'SUCCESS' : 'FAILURE',
            ipAddress: req.ip || req.socket.remoteAddress || null,
            userAgent: req.get('user-agent') || null,
            requestId,
            durationMs: Date.now() - startedAt,
            metadata: safeValue({
                params: req.params,
                query: req.query,
                ...suppliedMetadata
            })
        });
    });

    next();
};

module.exports = { auditAction, auditMiddleware, writeAuditLog };
