const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS']
}));

// Rutas de tracking
const trackingRoutes = require('./api/tracking');
app.use('/api/tracking', trackingRoutes);

// Servir HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/rastreo.html'));
});

app.get('/rastreo.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/rastreo.html'));
});

app.get('/rastreo/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/rastreo.html'));
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Error
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});

module.exports = app;
