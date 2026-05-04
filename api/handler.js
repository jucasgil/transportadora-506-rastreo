const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, '../public')));

const trackingRoutes = require('./tracking');
app.use('/api/tracking', trackingRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/rastreo.html'));
});

app.get('/rastreo.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/rastreo.html'));
});

app.get('/rastreo/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/rastreo.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

module.exports = app;
