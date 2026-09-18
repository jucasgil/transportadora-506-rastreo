/**
 * RUTAS DE TRACKING
 * GET /api/tracking/:trackingId
 * POST /api/tracking/generate-link
 * GET /api/tracking/public/:publicTrackingId
 */

const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const router = express.Router();

// ============================================================================
// CONFIG
// ============================================================================

const VELOCITYGO_TOKEN = process.env.VELOCITYGO_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CACHE_DURATION_MINUTES = 5;

// ============================================================================
// CREAR CLIENTE VELOCITYGO
// ============================================================================

function createVelocityGoClient() {
  const client = axios.create({
    baseURL: process.env.VELOCITYGO_API_URL || 'https://api.velocity-x.co',
    timeout: 10000,
    headers: {
      'X-Velocity-Access-Token': VELOCITYGO_TOKEN,
      'Content-Type': 'application/json'
    }
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      console.error('[VelocityGo Error]', {
        status: error.response?.status,
        message: error.response?.data?.message
      });
      throw error;
    }
  );

  return client;
}

// ============================================================================
// FUNCIONES AUXILIARES
// ============================================================================

async function getShipmentFromCache(trackingId) {
  try {
    const { data, error } = await supabase
      .from('shipments')
      .select('*')
      .eq('tracking_id', trackingId)
      .gt('cached_until', new Date().toISOString())
      .single();

    if (!error && data) {
      console.log(`[CACHE HIT] ${trackingId}`);
      return data;
    }
    return null;
  } catch (err) {
    console.error('[Cache Read Error]', err.message);
    return null;
  }
}

async function saveShipmentToCache(trackingId, shipmentData) {
  try {
    const cachedUntil = new Date(Date.now() + CACHE_DURATION_MINUTES * 60 * 1000);

    const { error } = await supabase
      .from('shipments')
      .upsert([
        {
          tracking_id: trackingId,
          ...shipmentData,
          cached_until: cachedUntil.toISOString()
        }
      ], { onConflict: 'tracking_id' });

    if (error) {
      console.error('[Cache Write Error]', error.message);
    }
  } catch (err) {
    console.error('[Cache Save Error]', err.message);
  }
}

function transformVelocityGoResponse(data, trackingId) {
  // Velocity devuelve el estado como objeto { id, name, color }, no como string plano
  const statusObj = data.order_status || {};
  const statusName = statusObj.name || data.status;
  const shipping = data.shipping_information || data.location || {};
  const driver = data.driver || {};
  const provider = data.delivery_provider || {};

  return {
    tracking_id: trackingId,
    velocitygo_order_id: data.id || data.order_id,
    order_number: data.order_number,
    status: statusName || 'Desconocido',
    status_code: statusObj.id ?? data.status,
    status_color: statusObj.color,
    location: {
      latitude: shipping.latitude || shipping.lat,
      longitude: shipping.longitude || shipping.lng,
      address: shipping.address || data.delivery_address,
      city: shipping.city,
      country: 'Colombia'
    },
    estimated_delivery: data.delivery_date || data.estimated_delivery_date || data.estimated_delivery,
    current_carrier: provider.name || data.carrier_name || data.carrier,
    driver_name: driver.full_name || driver.name || data.driver_name,
    driver_phone: driver.phone || data.driver_phone,
    events: Array.isArray(data.history) ? data.history.map(e => ({
      timestamp: e.timestamp || e.created_at || e.date,
      status: e.status || e.name,
      description: e.description || e.message,
      location: e.location
    })) : [],
    recipient_name: data.recipient_name || data.receiver_name || data.customer_name,
    recipient_phone: data.recipient_phone || data.receiver_phone || data.customer_phone,
    updated_at: new Date().toISOString()
  };
}

function generatePublicTrackingId() {
  const randomStr = crypto.randomBytes(6).toString('hex').toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
  return `TRA-${randomStr.slice(0, 6)}-${timestamp}`;
}

// ============================================================================
// ENDPOINT 1: GET /api/tracking/:trackingId
// ============================================================================

router.get('/:trackingId', async (req, res) => {
  try {
    const { trackingId } = req.params;

    if (!trackingId || trackingId.length < 3) {
      return res.status(400).json({
        error: 'invalid_tracking_id',
        message: 'El ID debe tener al menos 3 caracteres'
      });
    }

    // Intentar caché
    const cached = await getShipmentFromCache(trackingId);
    if (cached) {
      return res.json({ ...cached, source: 'cache' });
    }

    // Consultar VelocityGo
    console.log(`[API CALL] Consultando: ${trackingId}`);
    const client = createVelocityGoClient();
    const orderData = await fetchVelocityGoOrder(client, trackingId);

    if (!orderData) {
      return res.status(404).json({ error: 'not_found', message: 'Pedido no encontrado' });
    }

    const trackingData = transformVelocityGoResponse(orderData, trackingId);
    await saveShipmentToCache(trackingId, trackingData);

    res.json({ ...trackingData, source: 'live', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[Tracking Error]', error.message);

    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'not_found', message: 'Pedido no encontrado' });
    }

    res.status(500).json({ error: 'tracking_error', message: 'Error consultando pedido' });
  }
});

// ============================================================================
// BUSCAR PEDIDO EN VELOCITYGO
// {id} en GET /orders/{id} es el ID interno de Velocity, no el order_number
// ni el tracking_number que el cliente escribe. Por eso primero se intenta
// el lookup directo (por si el valor SÍ es el id interno) y si falla, se
// busca por order_number con la DSL de filtros que sí soporta ese campo.
// ============================================================================

function isNotFoundResponse(err) {
  if (err.response?.status === 404) return true;
  // Velocity responde 500 con este mensaje cuando el {id} de /orders/{id}
  // no es un ID interno válido (por ejemplo, cuando el cliente escribió su
  // order_number/tracking_number en vez del ID interno)
  const msg = (err.response?.data?.message || '').toLowerCase();
  return err.response?.status === 500 && msg.includes('record not found');
}

async function searchOrderByField(client, field, trackingId) {
  const filters = JSON.stringify([[field, 'LIKE', `%${trackingId}%`]]);
  const search = await client.get('/orders', { params: { filters, size: 1 } });
  const results = search.data?.data || search.data?.results || search.data?.items || [];
  console.log(`[SEARCH ${field}] "${trackingId}" -> ${Array.isArray(results) ? results.length : 0} resultado(s)`);
  return Array.isArray(results) && results.length ? results[0] : null;
}

// Campos por los que puede llegar el identificador que escribe el cliente:
// order_number (número propio de Velocity) o external_id (ID de la orden de
// origen, p.ej. el número de orden de VTEX si Velocity es el fulfillment).
const SEARCH_FIELDS = ['order_number', 'external_id'];

async function fetchVelocityGoOrder(client, trackingId) {
  try {
    const direct = await client.get(`/orders/${trackingId}`);
    if (direct.data) return direct.data;
  } catch (err) {
    if (!isNotFoundResponse(err)) throw err;
  }

  for (const field of SEARCH_FIELDS) {
    const found = await searchOrderByField(client, field, trackingId);
    if (found) return found;
  }
  return null;
}

// ============================================================================
// ENDPOINT 2: POST /api/tracking/generate-link
// ============================================================================

router.post('/generate-link', async (req, res) => {
  try {
    const { velocitygo_order_id, customer_email, customer_phone, customer_name } = req.body;

    if (!velocitygo_order_id || !customer_email) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const publicTrackingId = generatePublicTrackingId();
    const baseUrl = process.env.TRACKING_BASE_URL || 'https://transportadora-506-rastreo.vercel.app';
    const trackingUrl = `${baseUrl}/rastreo/${publicTrackingId}`;

    const { error } = await supabase
      .from('tracking_links')
      .insert([{
        public_tracking_id: publicTrackingId,
        velocitygo_order_id,
        customer_email,
        customer_phone,
        customer_name,
        created_at: new Date().toISOString()
      }]);

    if (error) {
      console.error('[Generate Link Error]', error);
      return res.status(500).json({ error: 'database_error' });
    }

    res.status(201).json({
      success: true,
      public_tracking_id: publicTrackingId,
      tracking_url: trackingUrl,
      qr_code_url: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(trackingUrl)}`
    });
  } catch (error) {
    console.error('[Generate Link Error]', error.message);
    res.status(500).json({ error: 'generate_link_error' });
  }
});

// ============================================================================
// ENDPOINT 3: GET /api/tracking/public/:publicTrackingId
// ============================================================================

router.get('/public/:publicTrackingId', async (req, res) => {
  try {
    const { publicTrackingId } = req.params;

    const { data: trackingLink, error: linkError } = await supabase
      .from('tracking_links')
      .select('velocitygo_order_id, customer_name, customer_email, customer_phone')
      .eq('public_tracking_id', publicTrackingId)
      .single();

    if (linkError || !trackingLink) {
      return res.status(404).json({ error: 'invalid_link', message: 'Link expirado o no válido' });
    }

    // Intentar caché
    const cached = await getShipmentFromCache(trackingLink.velocitygo_order_id);
    let trackingData;

    if (cached) {
      trackingData = cached;
    } else {
      const client = createVelocityGoClient();
      const orderData = await fetchVelocityGoOrder(client, trackingLink.velocitygo_order_id);
      if (!orderData) {
        return res.status(404).json({ error: 'not_found', message: 'Pedido no encontrado' });
      }
      trackingData = transformVelocityGoResponse(orderData, trackingLink.velocitygo_order_id);
      await saveShipmentToCache(trackingLink.velocitygo_order_id, trackingData);
    }

    res.json({
      ...trackingData,
      customer_name: trackingLink.customer_name,
      customer_email: trackingLink.customer_email,
      customer_phone: trackingLink.customer_phone,
      public_link: true
    });
  } catch (error) {
    console.error('[Public Tracking Error]', error.message);
    res.status(500).json({ error: 'tracking_error' });
  }
});

module.exports = router;
