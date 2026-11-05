const { publicCache } = require('../services/publicCache');

// Invalidate only after a successful write; unrelated classifier/task writes do not evict public data.
function cacheInvalidation(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const path = req.path;
    let groups = [];
    if (path.startsWith('/mushroom-species')) groups = ['species', 'gallery', 'progress'];
    else if (path.startsWith('/production-facilities')) {
        if (/\/images(?:\/|$)/.test(path)) groups = ['gallery'];
        else if (/^\/production-facilities\/\d+\/?$/.test(path)) groups = ['gallery', 'progress'];
    } else if (path.startsWith('/cultivation-batches')) {
        if (/\/images(?:\/|$)/.test(path)) groups = ['gallery'];
        else if (/\/(?:growth-progress|harvests)(?:\/|$)/.test(path) || /^\/cultivation-batches\/\d+\/?$/.test(path)) groups = ['progress', 'gallery'];
    }
    if (!groups.length) return next();
    const original = res.json.bind(res);
    res.json = body => {
        if (res.statusCode < 200 || res.statusCode >= 300) return original(body);
        void publicCache().invalidate(groups).then(() => original(body), next);
        return res;
    };
    next();
}
module.exports = { cacheInvalidation };
