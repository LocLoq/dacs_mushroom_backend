// Explicit one-time data update; never run automatically on startup or seed.
const { prisma } = require('../prisma/prisma.cjs');
(async () => {
  try {
    const before = await Promise.all(['mushroomImage', 'facilityImage', 'batchImage'].map(async (model) => ({ model, total: await prisma[model].count(), public: await prisma[model].count({ where: { isPublic: true } }) })));
    const result = await prisma.mushroomImage.updateMany({ where: { isPublic: false }, data: { isPublic: true } });
    const after = await Promise.all(['mushroomImage', 'facilityImage', 'batchImage'].map(async (model) => ({ model, total: await prisma[model].count(), public: await prisma[model].count({ where: { isPublic: true } }) })));
    console.log(JSON.stringify({ updatedMushroomImages: result.count, before, after }, null, 2));
  } catch (error) {
    console.error('Mushroom gallery publication failed:', error.code || error.message);
    process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
})();
