const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { loadEnvFile } = require('node:process');

// load routes
const testRoutes = require('./routes/test.cjs');

loadEnvFile();
const app = express();
const port = process.env.PORT || 8080;

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

global.io = io;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// api
app.use('/api', testRoutes);

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