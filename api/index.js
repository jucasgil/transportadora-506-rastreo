/**
 * TRANSPORTADORA 506 - TRACKING API
 * Optimizado para Vercel Serverless
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS']
}));

// ============================================================================
// RUTAS DE TRACKING
// ============================================================================

const trackingRoutes = require('./tracking');
app.use('/api/tracking', trackingRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({
    error: 'internal_server_error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Error interno'
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

module.exports = app;

// Para desarrollo local
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✓ Servidor en http://localhost:${PORT}`);
  });
}
