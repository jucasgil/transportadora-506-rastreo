const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rutas de tracking
const trackingRoutes = require('./api/tracking');
app.use('/api/tracking', trackingRoutes);

// Servir rastreo.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/rastreo.html'));
});

app.get('/rastreo.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/rastreo.html'));
});

app.get('/rastreo/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/rastreo.html'));
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Para local
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Escuchando en puerto ${PORT}`));
}

module.exports = app;
