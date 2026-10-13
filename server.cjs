const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { loadEnvironment } = require('./config/environment.cjs');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');
const { auditMiddleware } = require('./middlewares/audit');
const { galleryMediaAccess } = require('./middlewares/galleryMedia');

loadEnvironment();
const { getRateLimiters, configureTrustProxy } = require('./middlewares/rateLimit');

const adapter = new PrismaMariaDb({
  host: process.env.DATABASE_HOST,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  port: parseInt(process.env.DATABASE_PORT) || 3306,
  connectionLimit: 5
});
const prisma = new PrismaClient({ adapter });

const app = express();
configureTrustProxy(app);
const port = process.env.PORT || 8080;
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
const corsOrigin = corsOrigins.length ? corsOrigins : '*';
const corsOptions = { origin: corsOrigin, allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-Tunnel-Skip-AntiPhishing-Page'],
  exposedHeaders: ['Content-Disposition', 'RateLimit', 'RateLimit-Policy', 'Retry-After'] };

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions
});

const allRoles = ['admin', 'manager', 'staff'];
const privilegedRoles = ['admin', 'manager'];

global.io = io;
global.prisma = prisma;
global.allRoles = allRoles;
global.privilegedRoles = privilegedRoles;

app.use(cors(corsOptions));
app.use('/api', auditMiddleware, getRateLimiters().api);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', galleryMediaAccess, express.static(path.join(__dirname, 'uploads')));

// api
app.use('/api', require('./routes/test'));
app.use('/api', require('./routes/login'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/mushroom-classifier', require('./routes/mushroomClassifier'));
app.use('/api/mushroom-species', require('./routes/mushroomSpeciesManagement'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/production-facilities', require('./routes/productionFacilityManagement'));
app.use('/api/cultivation-batches', require('./routes/cultivationBatchManagement'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/public', require('./routes/publicGrowth'));

// Swagger UI
const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use(require('./services/apiHelpers').errorHandler);

const classifierQueue = require('./queues/mushroomClassifierQueue');
const { createClassifierMonitor, cleanStaleClassifierFiles } = require('./services/classifierMonitor');
const { activeRequests } = require('./services/classifierLifecycle');
const { withDeadline } = require('./services/classifierHealth');
const classifierWorker = classifierQueue.startWorker();
const classifierMonitor = createClassifierMonitor({ prisma, queue: classifierQueue });
classifierMonitor.start(classifierWorker);
void cleanStaleClassifierFiles(prisma);

require('./services/workflowEvents').configureWorkflowSocket(io);
const notificationWorker = require('./queues/notificationQueue').startNotificationWorker(prisma);

// basic socket event
io.on('connection', (socket) => {
  console.log('A client connected');
  
  socket.on('subscribe_job', async (jobId) => {
    if (typeof jobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(jobId)) return;
    socket.join(`job_${jobId}`);
    console.log(`Socket ${socket.id} joined room job_${jobId}`);

    try {
      const lookup = await prisma.classifierLookup.findUnique({ where: { id: jobId } });
      if (!lookup) return;
      socket.emit('refresh', { resource: 'classifier-job', id: jobId });
    } catch (error) {
      console.error('Unable to replay classifier status:', error.message);
    }
  });

  socket.on('disconnect', () => {
    console.log('A client disconnected');
  });
});


const listenHost = process.env.API_LISTEN_HOST || (process.env.PUSH_HOST_MODE === 'tunnel' ? '127.0.0.1' : '0.0.0.0');
server.listen(port, listenHost, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const active of activeRequests.values()) active.controller.abort(Object.assign(new Error('Backend stopping'), { code: 'WORKER_SHUTDOWN' }));
  try {
    await withDeadline(async () => {
      await classifierMonitor.stop(classifierWorker);
      await Promise.all([classifierWorker.close(), classifierQueue.close(), notificationWorker.close(), new Promise((resolve) => io.close(resolve))]);
      await prisma.$disconnect();
    }, 10000, new Error('Backend shutdown timed out'));
  } catch (error) { console.error(error.message); }
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
