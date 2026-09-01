const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { loadEnvFile } = require('node:process');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const mariadb = require('mariadb');

const pool = mariadb.createPool({
  host: process.env.DATABASE_HOST,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  port: parseInt(process.env.DATABASE_PORT) || 3306
});
const adapter = new PrismaMariaDb(pool);
const prisma = new PrismaClient({ adapter });

loadEnvFile();
const app = express();
const port = process.env.PORT || 8080;

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const allRoles = ['admin', 'manager', 'staff'];
const privilegedRoles = ['admin', 'manager'];

global.io = io;
global.prisma = prisma;
global.allRoles = allRoles;
global.privilegedRoles = privilegedRoles;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// api
app.use('/api', require('./routes/test'));
app.use('/api', require('./routes/login'));
app.use('/api/mushroom', require('./routes/mushroom'));
app.use('/api/mushroom-species', require('./routes/mushroomSpeciesManagement'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/production-facilities', require('./routes/productionFacilityManagement'));

// basic socket event
io.on('connection', (socket) => {
  console.log('A client connected');
  
  socket.on('subscribe_job', (jobId) => {
    socket.join(`job_${jobId}`);
    console.log(`Socket ${socket.id} joined room job_${jobId}`);
  });

  socket.on('disconnect', () => {
    console.log('A client disconnected');
  });
});


server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});