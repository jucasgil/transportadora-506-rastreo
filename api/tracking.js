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

// ============================================================================
// TRADUCCIÓN DE ESTADOS
// Velocity devuelve sus propios nombres de estado internos (p.ej. "Asignar
// Piloto"), pensados para el operador, no para el cliente final. Acá se
// traducen a un texto público más amigable antes de mostrarlo en la página
// de rastreo. La comparación de la llave NO distingue mayúsculas/minúsculas
// (se normaliza con .toLowerCase()), pero escribe la llave como la ves en
// [STATUS RAW] en los logs para que sea fácil de encontrar y editar.
// Si un estado no está en el mapa, se muestra tal cual llega de Velocity.
// ============================================================================
const STATUS_LABELS = {
  'orden creada': 'En proceso',
  'asignar piloto': 'Orden creada',
  'asignado a piloto': 'En proceso',
  'asignado piloto': 'En proceso',
  'recoger': 'Asignado para distribución',
  'en camino': 'En camino',
  'pendiente': 'Pendiente',
  'confirmado': 'Confirmado',
  'en ruta': 'En camino',
  'en tránsito': 'En camino',
  'entregado': 'Entregado',
  'fallido': 'Novedad en la entrega',
  'cancelado': 'Cancelado',
  'devuelto': 'Devuelto'
  // Agrega aquí más pares "nombre en minúsculas de Velocity": "Texto para mostrar"
};

function publicStatusLabel(rawName) {
  if (!rawName) return 'Desconocido';
  const key = rawName.trim().toLowerCase();
  return STATUS_LABELS[key] || rawName;
}

// ============================================================================
// ENTREGA ESTIMADA
// El campo `delivery_date` que envía Velocity resultó ser una fecha fija
// calculada al CREAR el pedido (~8-9 días después), que NO se recalcula con
// el avance real del envío: se confirmó viendo pedidos ya "Entregado" que
// seguían mostrando una fecha estimada varios días en el futuro. Por eso acá
// se ignora ese campo y se construye una estimación propia:
//   - Estado final (Entregado/Cancelado/Devuelto/Fallido): no se estima nada,
//     se muestra el resultado real (o el estado, si no hay fecha del evento).
//   - Estado en proceso: ventana de días anclada a la fecha de CREACIÓN del
//     pedido, según qué tan avanzada esté la etapa. Estos días son una regla
//     de negocio, no vienen de Velocity — ajústalos aquí si cambian los
//     tiempos reales de tu operación.
// ============================================================================

// Regla por estado (llave = nombre de Velocity en minúsculas). Cuatro tipos:
//   - 'offset':       un solo día = fecha de CREACIÓN del pedido + N días
//   - 'event':        un solo día = fecha en que el pedido CAMBIÓ a ese
//                      estado (se busca en el historial; si no aparece ahí,
//                      se usa hoy)
//   - 'event_offset': un solo día = fecha en que el pedido CAMBIÓ a ese
//                      estado + N días (igual que 'event' pero sumando días)
//   - 'range':        rango de días desde la creación (min-max), para
//                      estados sin regla explícita todavía
const STATUS_DELIVERY_RULES = {
  'orden creada': { type: 'offset', days: 3 },
  'pendiente': { type: 'offset', days: 3 },
  'asignar piloto': { type: 'event_offset', days: 3 },
  'asignado a piloto': { type: 'event_offset', days: 1 },
  'asignado piloto': { type: 'event_offset', days: 1 },
  'recoger': { type: 'event' },
  'confirmado': { type: 'range', minDays: 2, maxDays: 4 },
  'en camino': { type: 'event' },
  'en ruta': { type: 'event' },
  'en tránsito': { type: 'event' }
};
const DEFAULT_RULE = { type: 'range', minDays: 2, maxDays: 5 };

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateEs(isoDate, opts) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es-CO', opts || { day: 'numeric', month: 'long', year: 'numeric' });
}

function findEventTimestamp(events, statusKeyLower) {
  if (!Array.isArray(events)) return null;
  // Toma la más reciente si el estado aparece varias veces en el historial.
  const matches = events.filter(e => (e.status_raw || e.status || '').toString().trim().toLowerCase() === statusKeyLower);
  if (!matches.length) return null;
  return matches[matches.length - 1].timestamp;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Si el pedido se quedó más tiempo del previsto en un estado (ej. lleva 3
// días en "Asignar Piloto" pero la regla solo daba +1 día), la cuenta desde
// la creación cae en el pasado. Nunca se debe prometer una fecha ya vencida:
// se sube al menos a hoy.
function clampToToday(date) {
  const today = startOfDay(new Date());
  return startOfDay(date) < today ? new Date() : date;
}

function buildDeliveryEstimate({ statusKeyLower, events, createdAt }) {
  if (statusKeyLower === 'entregado') {
    const deliveredAt = findEventTimestamp(events, 'entregado');
    return {
      label: 'Entrega Estimada',
      display: deliveredAt ? `Entregado el ${formatDateEs(deliveredAt)}` : 'Entregado'
    };
  }
  if (statusKeyLower === 'cancelado') {
    return { label: 'Estado', display: 'Pedido cancelado' };
  }
  if (statusKeyLower === 'devuelto') {
    return { label: 'Estado', display: 'Pedido devuelto' };
  }
  if (statusKeyLower === 'fallido') {
    return { label: 'Estado', display: 'Novedad en la entrega' };
  }

  const rule = STATUS_DELIVERY_RULES[statusKeyLower] || DEFAULT_RULE;

  if (rule.type === 'event') {
    // El día a mostrar es cuando el pedido cambió a este estado, no la
    // creación. Si el historial no trae ese evento todavía, se asume hoy
    // (el cambio de estado que activó esta consulta acaba de ocurrir).
    const changedAt = findEventTimestamp(events, statusKeyLower) || new Date().toISOString();
    return { label: 'Entrega Estimada', display: formatDateEs(changedAt) };
  }

  if (rule.type === 'event_offset') {
    // Igual que 'event', pero sumando N días a la fecha del cambio de
    // estado (no a la creación del pedido).
    const changedAt = findEventTimestamp(events, statusKeyLower) || new Date().toISOString();
    const target = clampToToday(addDays(changedAt, rule.days));
    return { label: 'Entrega Estimada', display: formatDateEs(target) };
  }

  if (!createdAt) {
    return { label: 'Entrega Estimada', display: 'Por confirmar' };
  }

  if (rule.type === 'offset') {
    const target = clampToToday(addDays(createdAt, rule.days));
    return { label: 'Entrega Estimada', display: formatDateEs(target) };
  }

  // rule.type === 'range'
  let from = addDays(createdAt, rule.minDays);
  let to = addDays(createdAt, rule.maxDays);
  const today = startOfDay(new Date());

  if (startOfDay(to) < today) {
    // Todo el rango ya venció (el pedido lleva más días de los previstos en
    // esta etapa): se muestra un solo día, hoy, en vez de un rango pasado.
    return { label: 'Entrega Estimada', display: formatDateEs(new Date()) };
  }
  if (startOfDay(from) < today) {
    // El inicio del rango ya pasó pero el final todavía no: se recorta el
    // rango para que empiece hoy.
    from = new Date();
  }

  const fromLabel = from.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
  const toLabel = to.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  return { label: 'Entrega Estimada', display: `Entre el ${fromLabel} y el ${toLabel}` };
}

// ============================================================================
// BARRA DE PROGRESO
// Reduce cualquier estado de Velocity a un punto dentro de una línea de
// tiempo fija de 5 etapas, para dibujar un stepper/barra de progreso en la
// página de rastreo. Cada etapa agrupa uno o más estados crudos de Velocity
// (en minúsculas) que caen en esa etapa.
// ============================================================================
const PROGRESS_STAGES = [
  { label: 'Orden creada', matches: ['orden creada', 'asignar piloto', 'pendiente'] },
  { label: 'En proceso', matches: ['confirmado', 'asignado a piloto', 'asignado piloto'] },
  { label: 'Asignado para distribución', matches: ['recoger'] },
  { label: 'En camino', matches: ['en camino', 'en ruta', 'en tránsito'] },
  { label: 'Entregado', matches: ['entregado'] }
];

function buildProgress(statusKeyLower) {
  const stages = PROGRESS_STAGES.map(s => s.label);

  if (statusKeyLower === 'cancelado' || statusKeyLower === 'devuelto') {
    return { stages, current_index: -1, state: 'cancelled' };
  }

  const idx = PROGRESS_STAGES.findIndex(s => s.matches.includes(statusKeyLower));
  if (statusKeyLower === 'fallido') {
    // Novedad en la entrega: se muestra el avance hasta la última etapa
    // conocida (normalmente "En camino"), marcado como incidencia.
    return { stages, current_index: idx >= 0 ? idx : stages.length - 2, state: 'issue' };
  }
  if (idx === -1) {
    // Estado no mapeado todavía: se asume la primera etapa por defecto.
    return { stages, current_index: 0, state: 'normal' };
  }
  return { stages, current_index: idx, state: 'normal' };
}

function transformVelocityGoResponse(data, trackingId) {
  // Velocity devuelve el estado como objeto { id, name, color }, no como string plano
  const statusObj = data.order_status || {};
  const statusName = statusObj.name || data.status;
  const statusKeyLower = (statusName || '').trim().toLowerCase();
  // Deja ver en los logs de Vercel el nombre exacto que envía Velocity,
  // útil si aparece un estado nuevo que aún no está en STATUS_LABELS.
  console.log('[STATUS RAW]', JSON.stringify(statusName));
  const shipping = data.shipping_information || data.location || {};
  const customer = data.customer || {};

  const events = Array.isArray(data.history) ? data.history.map(e => ({
    timestamp: e.timestamp || e.created_at || e.date,
    status: publicStatusLabel(e.status || e.name),
    status_raw: (e.status || e.name || '').toString(),
    description: e.description || e.message,
    location: e.location
  })) : [];

  const deliveryEstimate = buildDeliveryEstimate({
    statusKeyLower,
    events,
    createdAt: data.created_at
  });

  const progress = buildProgress(statusKeyLower);

  return {
    tracking_id: trackingId,
    velocitygo_order_id: data.id || data.order_id,
    order_number: data.order_number,
    status: publicStatusLabel(statusName),
    status_raw: statusName || 'Desconocido',
    status_code: statusObj.id ?? data.status,
    status_color: statusObj.color,
    location: {
      latitude: shipping.latitude || shipping.lat,
      longitude: shipping.longitude || shipping.lng,
      address: shipping.address || data.delivery_address,
      city: shipping.city,
      country: 'Colombia'
    },
    estimated_delivery_label: deliveryEstimate.label,
    estimated_delivery_display: deliveryEstimate.display,
    // Se conserva el crudo de Velocity solo como referencia/depuración; ya no
    // se muestra directamente en la página de rastreo.
    estimated_delivery_raw: data.delivery_date || data.estimated_delivery_date || data.estimated_delivery,
    progress,
    events,
    // El destinatario (a quién se le entrega) vive en shipping_information;
    // customer es quien hizo/pagó el pedido. Se usa shipping primero y
    // customer como respaldo si algún campo viene vacío.
    recipient_name: shipping.full_name || customer.full_name,
    recipient_phone: shipping.phone_number || shipping.mobile_phone_number || customer.phone_number || customer.mobile_phone_number,
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

function extractOrderList(responseData) {
  if (Array.isArray(responseData)) return responseData;
  if (Array.isArray(responseData?.data)) return responseData.data;
  if (Array.isArray(responseData?.results)) return responseData.results;
  if (Array.isArray(responseData?.items)) return responseData.items;
  if (Array.isArray(responseData?.orders)) return responseData.orders;
  return [];
}

async function searchOrderByField(client, field, trackingId, operator) {
  try {
    const filters = JSON.stringify([[field, operator, operator === 'LIKE' ? `%${trackingId}%` : trackingId]]);
    const search = await client.get('/orders', { params: { filters, size: 1 } });
    const results = extractOrderList(search.data);
    console.log(`[SEARCH ${field} ${operator}] "${trackingId}" -> ${results.length} resultado(s)`);
    if (results.length === 0) {
      // TEMPORAL: para depurar la forma real de la respuesta cuando no hay
      // resultados, por si el array viene bajo otra llave que no estamos
      // contemplando en extractOrderList.
      console.log(`[SEARCH ${field} ${operator}] respuesta cruda:`, JSON.stringify(search.data).slice(0, 500));
    }
    return results.length ? results[0] : null;
  } catch (err) {
    // Un campo que no existe en el esquema de Velocity (columna inválida u
    // otro 400/422/500 de la búsqueda) no debe tumbar todo el request: se
    // registra y se sigue probando con el siguiente campo.
    console.error(`[SEARCH ${field} ${operator}] error, se omite:`, err.response?.data?.message || err.message);
    return null;
  }
}

// Campos confirmados que existen en el esquema de Velocity: order_number
// (código propio, ej. "QARHYX") y external_order_id (número de la orden de
// origen, ej. el pedido de VTEX "1662201085931-01").
const SEARCH_FIELDS = ['order_number', 'external_order_id'];
const OPERATORS = ['=', 'LIKE'];

async function fetchVelocityGoOrder(client, trackingId) {
  try {
    const direct = await client.get(`/orders/${trackingId}`);
    if (direct.data) return direct.data;
  } catch (err) {
    if (!isNotFoundResponse(err)) throw err;
  }

  // Candidatos a probar: el valor tal cual, y si trae un sufijo tipo "-01"
  // (típico de VTEX cuando una orden se separa en varios fulfillments),
  // también la parte antes del guion, por si Velocity la guarda sin sufijo.
  const candidates = [trackingId];
  if (trackingId.includes('-')) {
    candidates.push(trackingId.split('-')[0]);
  }

  for (const field of SEARCH_FIELDS) {
    for (const candidate of candidates) {
      for (const operator of OPERATORS) {
        const found = await searchOrderByField(client, field, candidate, operator);
        if (found) return found;
      }
    }
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
