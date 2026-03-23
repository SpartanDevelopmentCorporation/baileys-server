import crypto from 'crypto';
if (!globalThis.crypto) globalThis.crypto = crypto;

import express from 'express';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';

// Prevenir crashes por errores no manejados de sockets/fetch
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception (no crash):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled Rejection (no crash):', err.message || err);
});

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const API_KEY = process.env.API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL y SUPABASE_KEY son requeridas');
}
if (!API_KEY) {
  throw new Error('API_KEY es requerida');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// CORS Middleware - Restringir orígenes permitidos
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS === '*') {
    res.header('Access-Control-Allow-Origin', '*');
  } else {
    const allowed = ALLOWED_ORIGINS.split(',').map(o => o.trim());
    if (origin && allowed.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-api-key, x-webhook-secret');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Auth Middleware - Validar API Key en todas las rutas excepto /health y /api/whatsapp/events (SSE usa query param)
// Acepta x-api-key (para llamadas directas) o x-webhook-secret (para server-to-server via Edge Functions)
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.path === '/api/whatsapp/events') return next();
  if (req.path === '/api/whatsapp/debug') return next();

  const apiKey = req.headers['x-api-key'];
  const webhookSecret = req.headers['x-webhook-secret'];

  const validApiKey = apiKey === API_KEY;
  const validWebhookSecret = WEBHOOK_SECRET && webhookSecret === WEBHOOK_SECRET;

  if (!validApiKey && !validWebhookSecret) {
    return res.status(401).json({ error: 'API key inválida o faltante' });
  }
  next();
});

// Normalizar número de teléfono: asegurar formato +E.164
function normalizePhone(numero) {
  return numero.startsWith('+') ? numero : `+${numero}`;
}

let sock = null;
let currentQRCode = null;
let activeSessions = {};

// SSE - Server-Sent Events para actualizaciones en tiempo real
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

async function useSupabaseAuthState(sessionId) {
  const baileys = await import('@whiskeysockets/baileys');
  const initAuthCreds = baileys.initAuthCreds;
  const BufferJSON = baileys.BufferJSON;
  const proto = baileys.proto;

  // Read creds from Supabase
  const { data: credsRow } = await supabase
    .from('baileys_auth_state')
    .select('data_value')
    .eq('session_id', sessionId)
    .eq('data_key', 'creds')
    .single();

  const creds = credsRow?.data_value
    ? JSON.parse(JSON.stringify(credsRow.data_value), BufferJSON.reviver)
    : initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const result = {};
      if (!ids.length) return result;

      const dataKeys = ids.map(id => `${type}-${id}`);
      const { data } = await supabase
        .from('baileys_auth_state')
        .select('data_key, data_value')
        .eq('session_id', sessionId)
        .in('data_key', dataKeys);

      for (const row of data || []) {
        const id = row.data_key.replace(`${type}-`, '');
        let value = JSON.parse(JSON.stringify(row.data_value), BufferJSON.reviver);
        if (type === 'app-state-sync-key') {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        result[id] = value;
      }
      return result;
    },
    set: async (data) => {
      const rows = [];
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          const dataKey = `${type}-${id}`;
          if (value) {
            rows.push({
              session_id: sessionId,
              data_key: dataKey,
              data_value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
              updated_at: new Date().toISOString(),
            });
          } else {
            // Delete removed keys
            await supabase
              .from('baileys_auth_state')
              .delete()
              .eq('session_id', sessionId)
              .eq('data_key', dataKey);
          }
        }
      }
      if (rows.length) {
        await supabase
          .from('baileys_auth_state')
          .upsert(rows, { onConflict: 'session_id,data_key' });
      }
    },
  };

  const saveCreds = async () => {
    await supabase
      .from('baileys_auth_state')
      .upsert({
        session_id: sessionId,
        data_key: 'creds',
        data_value: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'session_id,data_key' });
  };

  return { state: { creds, keys }, saveCreds };
}

async function initBaileys() {
  try {
    const baileys = await import('@whiskeysockets/baileys');
    // Baileys puede exportar la función como default, default.default, o makeWASocket
    let makeWASocket = baileys.default;
    if (makeWASocket && typeof makeWASocket !== 'function' && makeWASocket.default) {
      makeWASocket = makeWASocket.default;
    }
    if (typeof makeWASocket !== 'function') {
      makeWASocket = baileys.makeWASocket;
    }
    const DisconnectReason = baileys.DisconnectReason;
    const fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;

    let version;
    try {
      const result = await fetchLatestWaWebVersion({});
      version = result.version;
      console.log('Versión WA Web obtenida:', version);
    } catch (err) {
      console.warn('No se pudo obtener versión WA Web, usando default:', err.message);
    }

    console.log('Baileys importado correctamente, makeWASocket type:', typeof makeWASocket);
    return { makeWASocket, DisconnectReason, version };
  } catch (error) {
    console.error('Error importando Baileys:', error);
    throw error;
  }
}

// Logger compatible con Baileys (requiere interfaz pino-like)
const baileysLogger = {
  level: 'warn',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (...args) => console.warn('[Baileys]', ...args),
  error: (...args) => console.error('[Baileys]', ...args),
  fatal: (...args) => console.error('[Baileys FATAL]', ...args),
  child: () => baileysLogger,
};

async function startWhatsAppSession(numero) {
  try {
    const { makeWASocket, DisconnectReason, version } =
      await initBaileys();

    debugLog(`Iniciando sesión para ${numero}...`);

    const { state, saveCreds } = await useSupabaseAuthState(numero);

    const socketOpts = {
      auth: state,
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: ['Nexus', 'Chrome', '120.0.0'],
    };
    if (version) socketOpts.version = version;

    const sock = makeWASocket(socketOpts);

    // Preservar qrResolve si existe (reconexión mientras /connect espera)
    const existingResolve = activeSessions[numero]?.qrResolve || null;

    // Inicializar ANTES de registrar event handlers para evitar race condition
    activeSessions[numero] = {
      socket: sock,
      estado: 'inicializando',
      qr: null,
      qrResolve: existingResolve,
      lastError: null,
    };

    // Promise que se resuelve cuando llega el primer QR o se conecta directo
    const qrPromise = new Promise((resolve) => {
      if (!activeSessions[numero].qrResolve) {
        activeSessions[numero].qrResolve = resolve;
      } else {
        // Ya hay un resolver pendiente (reconexión), encadenar ambos
        const original = activeSessions[numero].qrResolve;
        activeSessions[numero].qrResolve = (value) => {
          original(value);
          resolve(value);
        };
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      debugLog(`[${numero}] connection.update: ${JSON.stringify({ connection, qr: qr ? 'QR_PRESENT' : null, hasLastDisconnect: !!lastDisconnect })}`);

      if (qr) {
        try {
          currentQRCode = await QRCode.toDataURL(qr);
          if (activeSessions[numero]) {
            activeSessions[numero].qr = currentQRCode;
            activeSessions[numero].estado = 'qr_esperando';
          }
          debugLog(`[${numero}] QR generado`);

          await supabase
            .from('wmp_whatsapp_accounts')
            .update({
              qr_code: currentQRCode,
              status: 'connecting',
            })
            .eq('phone_number', numero.replace('+', ''));

          broadcast('qr_update', { account: numero, qr: currentQRCode });

          // Resolver el promise para que /connect retorne el QR
          if (activeSessions[numero]?.qrResolve) {
            activeSessions[numero].qrResolve(currentQRCode);
            activeSessions[numero].qrResolve = null;
          }
        } catch (err) {
          console.error('Error generando QR:', err);
        }
      }

      if (connection === 'open') {
        console.log(`✅ [${numero}] Conectado a WhatsApp`);
        if (activeSessions[numero]) {
          activeSessions[numero].estado = 'conectado';
          activeSessions[numero].socket = sock;
          activeSessions[numero].qr = null;
        }

        await supabase
          .from('wmp_whatsapp_accounts')
          .update({
            status: 'connected',
            qr_code: null
          })
          .eq('phone_number', numero.replace('+', ''));

        broadcast('connection_update', { account: numero, status: 'connected' });

        // Resolver promise si /connect está esperando (reconexión sin QR)
        if (activeSessions[numero]?.qrResolve) {
          activeSessions[numero].qrResolve(null);
          activeSessions[numero].qrResolve = null;
        }

        await syncContactos(numero, sock);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        const errorMsg = lastDisconnect?.error?.message || 'unknown';
        console.log(`❌ [${numero}] Desconectado, statusCode: ${statusCode}, error: ${errorMsg}, reconnect: ${shouldReconnect}`);

        if (activeSessions[numero]) {
          activeSessions[numero].estado = shouldReconnect ? 'reconectando' : 'desconectado';
          activeSessions[numero].lastError = `statusCode=${statusCode}, error=${errorMsg}`;
        }

        // Solo resolver qrPromise si NO va a reconectar
        // Si va a reconectar, dejamos el promise pendiente para que la reconexión genere el QR
        if (!shouldReconnect && activeSessions[numero]?.qrResolve) {
          activeSessions[numero].qrResolve(null);
          activeSessions[numero].qrResolve = null;
        }

        if (shouldReconnect) {
          setTimeout(() => startWhatsAppSession(numero), 3000);
        }

        await supabase
          .from('wmp_whatsapp_accounts')
          .update({
            status: shouldReconnect ? 'connecting' : 'disconnected'
          })
          .eq('phone_number', numero.replace('+', ''));

        broadcast('connection_update', { account: numero, status: 'disconnected' });
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];

      if (!message.key.fromMe && message.message) {
        await guardarMensaje(numero, message);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    return { sock, qrPromise };
  } catch (error) {
    console.error(`Error iniciando sesión ${numero}:`, error);
    throw error;
  }
}

// Helper: buscar account por numero (sin +)
async function findAccount(numero) {
  const phoneClean = numero.replace('+', '');
  const { data } = await supabase
    .from('wmp_whatsapp_accounts')
    .select('id')
    .eq('phone_number', phoneClean)
    .single();
  return data;
}

async function syncContactos(numero, sock) {
  try {
    const account = await findAccount(numero);

    if (!account) {
      console.error(`WhatsAppAccount no encontrado para ${numero}`);
      return;
    }

    const whatsapp_account_id = account.id;

    // En Baileys v7, los contactos llegan por el evento 'contacts.upsert'
    sock.ev.on('contacts.upsert', async (contacts) => {
      let count = 0;
      for (const contact of contacts) {
        const phoneNumber = contact.id.split('@')[0];
        if (phoneNumber === 'status') continue;

        const cleanPhone = phoneNumber.includes(':')
          ? phoneNumber.split(':')[0]
          : phoneNumber;

        const contactName = contact.name || contact.notify || `+${cleanPhone}`;

        // Check if contact exists
        const { data: existing } = await supabase
          .from('wmp_contacts')
          .select('id')
          .eq('phone_number', cleanPhone)
          .eq('whatsapp_account_id', whatsapp_account_id)
          .single();

        if (existing) {
          // Update name if we have a better one
          if (contact.name || contact.notify) {
            await supabase
              .from('wmp_contacts')
              .update({ name: contactName })
              .eq('id', existing.id);
          }
        } else {
          const { error } = await supabase
            .from('wmp_contacts')
            .insert({
              name: contactName,
              phone_number: cleanPhone,
              whatsapp_account_id: whatsapp_account_id,
              unread_count: 0,
            });

          if (error) {
            console.error(`Error guardando contacto ${cleanPhone}:`, error);
          } else {
            count++;
          }
        }
      }

      if (count > 0) {
        console.log(`✅ Sincronizados ${count} contactos para ${numero}`);
      }
    });

    console.log(`📇 Listener de contactos registrado para ${numero}`);
  } catch (error) {
    console.error(`Error configurando sync de contactos:`, error);
  }
}

async function guardarMensaje(numero, message) {
  try {
    const account = await findAccount(numero);
    if (!account) return;

    const contactNumber = message.key.remoteJid.split('@')[0];
    const cleanPhone = contactNumber.includes(':')
      ? contactNumber.split(':')[0]
      : contactNumber;

    // Find or create contact
    let { data: contact } = await supabase
      .from('wmp_contacts')
      .select('id')
      .eq('phone_number', cleanPhone)
      .eq('whatsapp_account_id', account.id)
      .single();

    if (!contact) {
      const { data: newContact } = await supabase
        .from('wmp_contacts')
        .insert({
          name: `+${cleanPhone}`,
          phone_number: cleanPhone,
          whatsapp_account_id: account.id,
          unread_count: 0,
        })
        .select('id')
        .single();

      contact = newContact;
    }

    if (!contact) return;

    // Extract message content
    let content = '';
    if (message.message.conversation) {
      content = message.message.conversation;
    } else if (message.message.extendedTextMessage) {
      content = message.message.extendedTextMessage.text;
    } else if (message.message.imageMessage) {
      content = message.message.imageMessage.caption || '[Imagen]';
    } else if (message.message.documentMessage) {
      content = `[Documento: ${message.message.documentMessage.fileName}]`;
    } else if (message.message.audioMessage) {
      content = '[Audio]';
    } else if (message.message.videoMessage) {
      content = message.message.videoMessage.caption || '[Video]';
    } else if (message.message.stickerMessage) {
      content = '[Sticker]';
    } else if (message.message.locationMessage) {
      content = '[Ubicacion]';
    } else if (message.message.contactMessage) {
      content = '[Contacto]';
    } else {
      content = '[Mensaje no soportado]';
    }

    // Insert message
    await supabase
      .from('wmp_messages')
      .insert({
        contact_id: contact.id,
        whatsapp_account_id: account.id,
        content: content,
        direction: 'inbound',
        sender_type: 'contact',
      });

    // Update contact: last_message_at and unread_count
    const { data: unreadData } = await supabase
      .from('wmp_messages')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contact.id)
      .eq('direction', 'inbound');

    await supabase
      .from('wmp_contacts')
      .update({
        last_message_at: new Date().toISOString(),
        unread_count: (unreadData?.length || 0),
      })
      .eq('id', contact.id);

    // Notify SSE clients
    broadcast('new_message', {
      account: numero,
      contact_phone: cleanPhone,
      contact_id: contact.id,
    });

  } catch (error) {
    console.error('Error guardando mensaje:', error);
  }
}

app.get('/api/whatsapp/qr/:numero', async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const phoneClean = numero.replace('+', '');

  try {
    const { data } = await supabase
      .from('wmp_whatsapp_accounts')
      .select('qr_code, status')
      .eq('phone_number', phoneClean)
      .single();

    if (!data) {
      return res.status(404).json({ error: 'Número no encontrado' });
    }

    res.json({
      numero,
      qr: data.qr_code,
      estado: data.status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint - ver estado de sesiones activas
app.get('/api/whatsapp/debug', (req, res) => {
  const validKey = req.query.key === API_KEY;
  const validSecret = WEBHOOK_SECRET && req.headers['x-webhook-secret'] === WEBHOOK_SECRET;
  if (!validKey && !validSecret) return res.status(401).json({ error: 'Add ?key=YOUR_API_KEY or x-webhook-secret header' });
  const sessions = {};
  for (const [num, session] of Object.entries(activeSessions)) {
    sessions[num] = {
      estado: session.estado,
      hasQr: !!session.qr,
      hasQrResolve: !!session.qrResolve,
      lastError: session.lastError,
    };
  }
  res.json({ sessions, debugLogs: debugBuffer });
});

// Buffer circular para debug logs
const debugBuffer = [];
function debugLog(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  debugBuffer.push(entry);
  if (debugBuffer.length > 50) debugBuffer.shift();
}

app.post('/api/whatsapp/connect/:numero', async (req, res) => {
  const numero = normalizePhone(req.params.numero);

  try {
    const phoneClean = numero.replace('+', '');
    // Verificar si existe en Supabase, si no, auto-crear
    const { data: existing } = await supabase
      .from('wmp_whatsapp_accounts')
      .select('id')
      .eq('phone_number', phoneClean)
      .single();

    if (!existing) {
      console.log(`[${numero}] Auto-creando registro en wmp_whatsapp_accounts`);
      await supabase.from('wmp_whatsapp_accounts').insert({
        phone_number: phoneClean,
        label: numero,
        status: 'connecting',
      });
    } else {
      await supabase.from('wmp_whatsapp_accounts')
        .update({ status: 'connecting' })
        .eq('phone_number', phoneClean);
    }

    // Cerrar sesión anterior si existe
    if (activeSessions[numero]?.socket) {
      console.log(`[${numero}] Cerrando sesión anterior...`);
      try { activeSessions[numero].socket.end(); } catch (e) {}
      delete activeSessions[numero];
    }

    // Limpiar creds anteriores corruptas para forzar QR fresco
    console.log(`[${numero}] Limpiando auth state previo para forzar QR nuevo`);
    await supabase
      .from('baileys_auth_state')
      .delete()
      .eq('session_id', numero);

    const { sock, qrPromise } = await startWhatsAppSession(numero);

    // Esperar QR con timeout de 60 segundos
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 60000)
    );

    try {
      const qr = await Promise.race([qrPromise, timeoutPromise]);
      if (qr) {
        res.json({ success: true, qr, estado: 'qr_esperando' });
      } else if (activeSessions[numero]?.estado === 'conectado') {
        res.json({ success: true, qr: null, estado: 'conectado' });
      } else {
        res.json({ success: true, qr: null, estado: activeSessions[numero]?.estado || 'inicializando' });
      }
    } catch (e) {
      // Timeout
      if (activeSessions[numero]?.estado === 'conectado') {
        res.json({ success: true, qr: null, estado: 'conectado' });
      } else {
        res.status(504).json({
          success: false,
          error: 'Timeout esperando QR de WhatsApp (30s)',
          estado: activeSessions[numero]?.estado,
          lastError: activeSessions[numero]?.lastError,
        });
      }
    }
  } catch (error) {
    console.error(`Error en /connect/${numero}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/status/:numero', async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const phoneClean = numero.replace('+', '');

  try {
    const { data } = await supabase
      .from('wmp_whatsapp_accounts')
      .select('status, created_at')
      .eq('phone_number', phoneClean)
      .single();

    if (!data) {
      return res.status(404).json({ error: 'Número no encontrado' });
    }

    res.json({
      numero,
      status: data.status,
      last_connected: data.created_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/mensajes/:numero', async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const { contacto, limite = 50 } = req.query;

  try {
    const account = await findAccount(numero);
    if (!account) {
      return res.status(404).json({ error: 'Número no encontrado' });
    }

    let query = supabase
      .from('wmp_messages')
      .select('*')
      .eq('whatsapp_account_id', account.id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limite));

    if (contacto) {
      // Find contact by phone
      const { data: contact } = await supabase
        .from('wmp_contacts')
        .select('id')
        .eq('phone_number', contacto.replace('+', ''))
        .eq('whatsapp_account_id', account.id)
        .single();

      if (contact) {
        query = query.eq('contact_id', contact.id);
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      numero,
      contacto: contacto || 'todos',
      total: data.length,
      mensajes: data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/enviar', async (req, res) => {
  const numero = normalizePhone(req.body.numero || '');
  const { contacto, mensaje } = req.body;

  if (!numero || !contacto || !mensaje) {
    return res.status(400).json({
      error: 'Faltan parámetros: numero, contacto, mensaje'
    });
  }

  try {
    const session = activeSessions[numero];

    if (!session || !session.socket) {
      return res.status(400).json({
        error: `No hay sesión activa para ${numero}`
      });
    }

    const jid = contacto.replace('+', '') + '@s.whatsapp.net';
    const sentMsg = await session.socket.sendMessage(jid, { text: mensaje });

    const account = await findAccount(numero);
    const cleanContacto = contacto.replace('+', '');

    if (account) {
      const { data: contact } = await supabase
        .from('wmp_contacts')
        .select('id')
        .eq('phone_number', cleanContacto)
        .eq('whatsapp_account_id', account.id)
        .single();

      if (contact) {
        await supabase
          .from('wmp_messages')
          .insert({
            contact_id: contact.id,
            whatsapp_account_id: account.id,
            content: mensaje,
            direction: 'outbound',
            sender_type: 'agent',
          });

        await supabase
          .from('wmp_contacts')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', contact.id);
      }
    }

    res.json({
      success: true,
      mensajeId: sentMsg.key.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/enviar-media', async (req, res) => {
  const numero = normalizePhone(req.body.numero || '');
  const { contacto, mediaUrl, mediaType, caption, fileName, mimeType } = req.body;

  if (!numero || !contacto || !mediaUrl) {
    return res.status(400).json({
      error: 'Faltan parámetros: numero, contacto, mediaUrl'
    });
  }

  try {
    const session = activeSessions[numero];

    if (!session || !session.socket) {
      return res.status(400).json({
        error: `No hay sesión activa para ${numero}`
      });
    }

    const jid = contacto.replace('+', '') + '@s.whatsapp.net';

    // Download media from URL
    const mediaResponse = await fetch(mediaUrl);
    if (!mediaResponse.ok) {
      return res.status(400).json({ error: 'No se pudo descargar el archivo' });
    }
    const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());

    // Build message based on media type
    let messageContent;
    switch (mediaType) {
      case 'image':
        messageContent = {
          image: mediaBuffer,
          caption: caption || undefined,
          mimetype: mimeType || 'image/jpeg',
        };
        break;
      case 'video':
        messageContent = {
          video: mediaBuffer,
          caption: caption || undefined,
          mimetype: mimeType || 'video/mp4',
        };
        break;
      case 'audio':
        messageContent = {
          audio: mediaBuffer,
          mimetype: mimeType || 'audio/mpeg',
          ptt: false,
        };
        break;
      case 'document':
      default:
        messageContent = {
          document: mediaBuffer,
          mimetype: mimeType || 'application/octet-stream',
          fileName: fileName || 'archivo',
        };
        break;
    }

    const sentMsg = await session.socket.sendMessage(jid, messageContent);

    // Save to DB
    const account = await findAccount(numero);
    const cleanContacto = contacto.replace('+', '');

    if (account) {
      const { data: contact } = await supabase
        .from('wmp_contacts')
        .select('id')
        .eq('phone_number', cleanContacto)
        .eq('whatsapp_account_id', account.id)
        .single();

      if (contact) {
        await supabase
          .from('wmp_messages')
          .insert({
            contact_id: contact.id,
            whatsapp_account_id: account.id,
            content: caption || fileName || `[${mediaType}]`,
            media_url: mediaUrl,
            media_type: mediaType,
            direction: 'outbound',
            sender_type: 'agent',
          });

        await supabase
          .from('wmp_contacts')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', contact.id);
      }
    }

    res.json({
      success: true,
      mensajeId: sentMsg.key.id
    });
  } catch (error) {
    console.error('Error enviando media:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/enviar-media', async (req, res) => {
  const numero = normalizePhone(req.body.numero || '');
  const { contacto, mediaUrl, mediaType, caption, fileName, mimeType } = req.body;

  if (!numero || !contacto || !mediaUrl) {
    return res.status(400).json({
      error: 'Faltan parámetros: numero, contacto, mediaUrl'
    });
  }

  try {
    const session = activeSessions[numero];

    if (!session || !session.socket) {
      return res.status(400).json({
        error: `No hay sesión activa para ${numero}`
      });
    }

    const jid = contacto.replace('+', '') + '@s.whatsapp.net';

    // Download media from URL
    const mediaResponse = await fetch(mediaUrl);
    if (!mediaResponse.ok) {
      return res.status(400).json({ error: 'No se pudo descargar el archivo' });
    }
    const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());

    // Build message based on media type
    let messageContent;
    switch (mediaType) {
      case 'image':
        messageContent = {
          image: mediaBuffer,
          caption: caption || undefined,
          mimetype: mimeType || 'image/jpeg',
        };
        break;
      case 'video':
        messageContent = {
          video: mediaBuffer,
          caption: caption || undefined,
          mimetype: mimeType || 'video/mp4',
        };
        break;
      case 'audio':
        messageContent = {
          audio: mediaBuffer,
          mimetype: mimeType || 'audio/mpeg',
          ptt: false,
        };
        break;
      case 'document':
      default:
        messageContent = {
          document: mediaBuffer,
          mimetype: mimeType || 'application/octet-stream',
          fileName: fileName || 'archivo',
        };
        break;
    }

    const sentMsg = await session.socket.sendMessage(jid, messageContent);

    // Save to DB
    const account = await findAccount(numero);
    const cleanContacto = contacto.replace('+', '');

    if (account) {
      const { data: contact } = await supabase
        .from('wmp_contacts')
        .select('id')
        .eq('phone_number', cleanContacto)
        .eq('whatsapp_account_id', account.id)
        .single();

      if (contact) {
        await supabase
          .from('wmp_messages')
          .insert({
            contact_id: contact.id,
            whatsapp_account_id: account.id,
            content: caption || fileName || `[${mediaType}]`,
            media_url: mediaUrl,
            media_type: mediaType,
            direction: 'outbound',
            sender_type: 'agent',
          });

        await supabase
          .from('wmp_contacts')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', contact.id);
      }
    }

    res.json({
      success: true,
      mensajeId: sentMsg.key.id
    });
  } catch (error) {
    console.error('Error enviando media:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/contactos/:numero', async (req, res) => {
  const numero = normalizePhone(req.params.numero);

  try {
    const account = await findAccount(numero);
    if (!account) {
      return res.status(404).json({ error: 'Número no encontrado' });
    }

    const { data, error } = await supabase
      .from('wmp_contacts')
      .select('*')
      .eq('whatsapp_account_id', account.id)
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (error) throw error;

    res.json({
      numero,
      total: data.length,
      contactos: data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SSE Endpoint - Auth via query param (EventSource no soporta headers custom)
// Acepta apiKey query param (para clientes legacy) o x-webhook-secret header (para server-to-server)
app.get('/api/whatsapp/events', (req, res) => {
  const apiKey = req.query.apiKey;
  const webhookSecret = req.headers['x-webhook-secret'];

  const validApiKey = apiKey === API_KEY;
  const validWebhookSecret = WEBHOOK_SECRET && webhookSecret === WEBHOOK_SECRET;

  if (!validApiKey && !validWebhookSecret) {
    return res.status(401).json({ error: 'API key inválida o faltante' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, async () => {
  console.log(`🚀 Servidor Baileys corriendo en puerto ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);

  // Auto-reconectar sesiones que estaban conectadas antes del reinicio
  try {
    const { data: activeAccounts } = await supabase
      .from('wmp_whatsapp_accounts')
      .select('phone_number')
      .eq('status', 'connected');

    for (const acc of activeAccounts || []) {
      const numero = normalizePhone(acc.phone_number);
      console.log(`🔄 Reconectando ${numero}...`);
      startWhatsAppSession(numero)
        .then(() => console.log(`✅ Reconexión iniciada para ${numero}`))
        .catch(err => console.error(`Error reconectando ${numero}:`, err));
    }
  } catch (err) {
    console.error('Error en auto-reconexión:', err);
  }
});
