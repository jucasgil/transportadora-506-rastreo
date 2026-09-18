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
