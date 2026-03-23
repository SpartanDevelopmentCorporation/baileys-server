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

// Map LID → real phone number
const lidToPhone = {};

// Dedup: track processed message IDs to avoid duplicates
const processedMessages = new Set();
function isProcessed(msgId) {
  if (processedMessages.has(msgId)) return true;
  processedMessages.add(msgId);
  // Keep set small — clear old entries after 1000
  if (processedMessages.size > 1000) {
    const arr = [...processedMessages];
    arr.splice(0, 500).forEach(id => processedMessages.delete(id));
  }
  return false;
}

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
      debugLog(`[${numero}] messages.upsert: ${m.messages.length} mensajes, type: ${m.type}`);
      for (const message of m.messages) {
        const fromMe = message.key.fromMe;
        const hasMsg = !!message.message;
        const remoteJid = message.key.remoteJid;
        debugLog(`[${numero}] msg: fromMe=${fromMe}, hasMessage=${hasMsg}, jid=${remoteJid}`);

        if (hasMsg) {
          // Dedup: skip if already processed
          const msgId = message.key.id;
          if (isProcessed(msgId)) {
            debugLog(`[${numero}] ⏭ Duplicate message skipped: ${msgId}`);
            continue;
          }

          // Skip group messages
          if (remoteJid && remoteJid.endsWith('@g.us')) {
            debugLog(`[${numero}] ⏭ Grupo ignorado: ${remoteJid}`);
            continue;
          }

          // Skip status/broadcast
          if (remoteJid === 'status@broadcast') {
            continue;
          }

          if (fromMe) {
            // Message sent from phone — save as outbound (agent)
            try {
              await guardarMensaje(numero, message, true);
              debugLog(`[${numero}] ✅ Mensaje propio guardado de ${remoteJid}`);
            } catch (err) {
              debugLog(`[${numero}] ❌ Error guardando mensaje propio: ${err.message}`);
            }
          } else {
            // Incoming message
            try {
              await guardarMensaje(numero, message, false);
              debugLog(`[${numero}] ✅ Mensaje guardado de ${remoteJid}`);
            } catch (err) {
              debugLog(`[${numero}] ❌ Error guardando mensaje: ${err.message}`);
            }
          }
        }
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

    // Build LID → phone map from contacts.update events
    sock.ev.on('contacts.update', async (updates) => {
      for (const update of updates) {
        // contacts.update may contain lid ↔ phone mappings
        if (update.id && update.lid) {
          const phone = update.id.split('@')[0];
          const lid = update.lid.split('@')[0];
          lidToPhone[lid] = phone;
          debugLog(`[${numero}] LID map: ${lid} → ${phone}`);
        }
      }
    });

    // En Baileys v7, los contactos llegan por el evento 'contacts.upsert'
    sock.ev.on('contacts.upsert', async (contacts) => {
      let count = 0;
      for (const contact of contacts) {
        const phoneNumber = contact.id.split('@')[0];
        if (phoneNumber === 'status') continue;

        // Build LID → phone map
        const contactLid = contact.lid ? contact.lid.split('@')[0] : null;
        if (contactLid) {
          const realPhone = phoneNumber.includes(':') ? phoneNumber.split(':')[0] : phoneNumber;
          lidToPhone[contactLid] = realPhone;
        }

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
          // Update name and LID if we have them
          const updateData = {};
          if (contact.name || contact.notify) updateData.name = contactName;
          if (contactLid) updateData.lid = contactLid;
          if (Object.keys(updateData).length > 0) {
            await supabase
              .from('wmp_contacts')
              .update(updateData)
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

async function guardarMensaje(numero, message, isFromMe = false) {
  try {
    const account = await findAccount(numero);
    if (!account) return;

    const remoteJid = message.key.remoteJid;
    const isLid = remoteJid.endsWith('@lid');

    let cleanPhone;
    let contact = null;

    if (isLid) {
      const lidNum = remoteJid.split('@')[0];

      // First: try to find contact by LID column in DB
      const { data: lidContact } = await supabase
        .from('wmp_contacts')
        .select('id, phone_number')
        .eq('lid', lidNum)
        .eq('whatsapp_account_id', account.id)
        .single();

      if (lidContact) {
        contact = lidContact;
        cleanPhone = lidContact.phone_number;
        debugLog(`[${numero}] Resolved LID ${lidNum} → ${cleanPhone} via DB`);
      } else if (lidToPhone[lidNum]) {
        // Second: try in-memory map
        cleanPhone = lidToPhone[lidNum];
        debugLog(`[${numero}] Resolved LID ${lidNum} → ${cleanPhone} via map`);
      } else {
        // Fallback: store with LID as phone
        cleanPhone = lidNum;
        debugLog(`[${numero}] Could not resolve LID ${lidNum}, storing as-is`);
      }
    } else {
      const contactNumber = remoteJid.split('@')[0];
      cleanPhone = contactNumber.includes(':')
        ? contactNumber.split(':')[0]
        : contactNumber;
    }

    // Find contact by phone if not already found via LID
    if (!contact) {
      const { data: phoneContact } = await supabase
        .from('wmp_contacts')
        .select('id')
        .eq('phone_number', cleanPhone)
        .eq('whatsapp_account_id', account.id)
        .single();

      contact = phoneContact;
    }

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

    // Extract message content and media
    let content = '';
    let media_url = null;
    let media_type = null;
    const msg = message.message;

    if (msg.conversation) {
      content = msg.conversation;
    } else if (msg.extendedTextMessage) {
      content = msg.extendedTextMessage.text;
    } else if (msg.imageMessage) {
      content = msg.imageMessage.caption || '';
      media_type = 'image';
      try {
        const baileys = await import('@whiskeysockets/baileys');
        const buffer = await baileys.downloadMediaMessage(message, 'buffer', {}, {
          logger: console,
          reuploadRequest: activeSessions[numero]?.sock?.updateMediaMessage,
        });
        if (buffer) {
          const ext = msg.imageMessage.mimetype?.split('/')[1] || 'jpg';
          const fileName = `media/${numero}/${Date.now()}.${ext}`;
          const { error: uploadErr } = await supabase.storage
            .from('whatsapp-media')
            .upload(fileName, buffer, { contentType: msg.imageMessage.mimetype || 'image/jpeg' });
          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from('whatsapp-media').getPublicUrl(fileName);
            media_url = urlData.publicUrl;
            debugLog(`[${numero}] 📷 Imagen subida: ${media_url}`);
          } else {
            debugLog(`[${numero}] ❌ Error subiendo imagen: ${uploadErr.message}`);
            content = content || '[Imagen]';
          }
        }
      } catch (dlErr) {
        debugLog(`[${numero}] ❌ Error descargando imagen: ${dlErr.message}`);
        content = content || '[Imagen]';
      }
    } else if (msg.stickerMessage) {
      content = '';
      media_type = 'sticker';
      try {
        const baileys = await import('@whiskeysockets/baileys');
        const buffer = await baileys.downloadMediaMessage(message, 'buffer', {}, {
          logger: console,
          reuploadRequest: activeSessions[numero]?.sock?.updateMediaMessage,
        });
        if (buffer) {
          const fileName = `media/${numero}/${Date.now()}.webp`;
          const { error: uploadErr } = await supabase.storage
            .from('whatsapp-media')
            .upload(fileName, buffer, { contentType: 'image/webp' });
          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from('whatsapp-media').getPublicUrl(fileName);
            media_url = urlData.publicUrl;
            debugLog(`[${numero}] 🎭 Sticker subido: ${media_url}`);
          } else {
            content = '[Sticker]';
          }
        }
      } catch (dlErr) {
        debugLog(`[${numero}] ❌ Error descargando sticker: ${dlErr.message}`);
        content = '[Sticker]';
      }
    } else if (msg.videoMessage) {
      content = msg.videoMessage.caption || '';
      media_type = 'video';
      try {
        const baileys = await import('@whiskeysockets/baileys');
        const buffer = await baileys.downloadMediaMessage(message, 'buffer', {}, {
          logger: console,
          reuploadRequest: activeSessions[numero]?.sock?.updateMediaMessage,
        });
        if (buffer) {
          const ext = msg.videoMessage.mimetype?.split('/')[1] || 'mp4';
          const fileName = `media/${numero}/${Date.now()}.${ext}`;
          const { error: uploadErr } = await supabase.storage
            .from('whatsapp-media')
            .upload(fileName, buffer, { contentType: msg.videoMessage.mimetype || 'video/mp4' });
          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from('whatsapp-media').getPublicUrl(fileName);
            media_url = urlData.publicUrl;
            debugLog(`[${numero}] 🎬 Video subido: ${media_url}`);
          } else {
            content = content || '[Video]';
          }
        }
      } catch (dlErr) {
        debugLog(`[${numero}] ❌ Error descargando video: ${dlErr.message}`);
        content = content || '[Video]';
      }
    } else if (msg.audioMessage) {
      content = '';
      media_type = 'audio';
      try {
        const baileys = await import('@whiskeysockets/baileys');
        const buffer = await baileys.downloadMediaMessage(message, 'buffer', {}, {
          logger: console,
          reuploadRequest: activeSessions[numero]?.sock?.updateMediaMessage,
        });
        if (buffer) {
          const fileName = `media/${numero}/${Date.now()}.ogg`;
          const { error: uploadErr } = await supabase.storage
            .from('whatsapp-media')
            .upload(fileName, buffer, { contentType: 'audio/ogg' });
          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from('whatsapp-media').getPublicUrl(fileName);
            media_url = urlData.publicUrl;
            debugLog(`[${numero}] 🎵 Audio subido: ${media_url}`);
          } else {
            content = '[Audio]';
          }
        }
      } catch (dlErr) {
        debugLog(`[${numero}] ❌ Error descargando audio: ${dlErr.message}`);
        content = '[Audio]';
      }
    } else if (msg.documentMessage) {
      content = msg.documentMessage.fileName || '[Documento]';
      media_type = 'document';
      try {
        const baileys = await import('@whiskeysockets/baileys');
        const buffer = await baileys.downloadMediaMessage(message, 'buffer', {}, {
          logger: console,
          reuploadRequest: activeSessions[numero]?.sock?.updateMediaMessage,
        });
        if (buffer) {
          const ext = msg.documentMessage.fileName?.split('.').pop() || 'pdf';
          const fileName = `media/${numero}/${Date.now()}_${msg.documentMessage.fileName || 'doc.' + ext}`;
          const { error: uploadErr } = await supabase.storage
            .from('whatsapp-media')
            .upload(fileName, buffer, { contentType: msg.documentMessage.mimetype || 'application/octet-stream' });
          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from('whatsapp-media').getPublicUrl(fileName);
            media_url = urlData.publicUrl;
            debugLog(`[${numero}] 📎 Documento subido: ${media_url}`);
          } else {
            content = `[Documento: ${msg.documentMessage.fileName}]`;
          }
        }
      } catch (dlErr) {
        debugLog(`[${numero}] ❌ Error descargando documento: ${dlErr.message}`);
        content = `[Documento: ${msg.documentMessage.fileName}]`;
      }
    } else if (msg.locationMessage) {
      content = `[Ubicacion: ${msg.locationMessage.degreesLatitude}, ${msg.locationMessage.degreesLongitude}]`;
      media_type = 'location';
    } else if (msg.contactMessage) {
      content = `[Contacto: ${msg.contactMessage.displayName || 'Sin nombre'}]`;
    } else if (msg.reactionMessage) {
      content = msg.reactionMessage.text || '';
      media_type = 'reaction';
    } else {
      content = '[Mensaje no soportado]';
    }

    // Don't save empty reactions
    if (media_type === 'reaction' && !content) return;

    // Build insert object
    const insertData = {
      contact_id: contact.id,
      whatsapp_account_id: account.id,
      content: content || '',
      direction: isFromMe ? 'outbound' : 'inbound',
      sender_type: isFromMe ? 'agent' : 'customer',
    };
    if (media_url) insertData.media_url = media_url;
    if (media_type) insertData.media_type = media_type;

    // Insert message
    const { error: msgError } = await supabase
      .from('wmp_messages')
      .insert(insertData);

    if (msgError) {
      console.error(`❌ Error insertando mensaje:`, msgError);
      return;
    }

    // Update last_message_at always, but only increment unread for inbound
    if (!isFromMe) {
      const { data: currentContact } = await supabase
        .from('wmp_contacts')
        .select('unread_count')
        .eq('id', contact.id)
        .single();

      await supabase
        .from('wmp_contacts')
        .update({
          last_message_at: new Date().toISOString(),
          unread_count: ((currentContact?.unread_count || 0) + 1),
        })
        .eq('id', contact.id);
    } else {
      // Just update last_message_at for outbound
      await supabase
        .from('wmp_contacts')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', contact.id);
    }

    // Notify SSE clients
    broadcast('new_message', {
      account: numero,
      contact_phone: cleanPhone,
      contact_id: contact.id,
    });

    // Only trigger AI for inbound messages
    if (!isFromMe) {
      handleAIResponse(numero, contact.id, account.id, content).catch(err => {
        debugLog(`[${numero}] AI handler error: ${err.message}`);
      });
    }

  } catch (error) {
    console.error('Error guardando mensaje:', error);
  }
}

// === AI INTEGRATION ===

function isWithinBusinessHours() {
  const now = new Date();
  // Convert to Eastern Time
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = eastern.getDay(); // 0=Sunday
  const hour = eastern.getHours();
  const minute = eastern.getMinutes();
  const time = hour * 60 + minute;

  // Saturday: 9am-6pm
  if (day === 6) return time >= 540 && time < 1080;
  // Sunday-Friday: 9am-9pm
  return time >= 540 && time < 1260;
}

async function getAIResponse(contactId, accountId, incomingMessage) {
  try {
    // Get AI config
    const { data: aiConfig } = await supabase
      .from('wmp_ai_config')
      .select('*')
      .eq('is_active', true)
      .single();

    if (!aiConfig || !aiConfig.api_key) {
      debugLog('AI not configured or no API key');
      return null;
    }

    const withinHours = isWithinBusinessHours();

    // If within business hours and copilot mode, just save suggestion (don't auto-reply)
    if (withinHours && aiConfig.copilot_enabled && !aiConfig.auto_reply_when_absent) {
      debugLog('Within business hours, copilot mode — skipping auto-reply');
      return null;
    }

    // If within business hours and copilot enabled, save suggestion for agent
    if (withinHours && aiConfig.copilot_enabled) {
      debugLog('Within business hours, generating suggestion for agent');
    }

    // Get knowledge base
    const { data: knowledge } = await supabase
      .from('wmp_ai_knowledge_base')
      .select('title, content');

    // Get recent messages for context
    const { data: messages } = await supabase
      .from('wmp_messages')
      .select('content, direction, sender_type, created_at')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(20);

    const sortedMessages = [...(messages || [])].reverse();

    // Get contact info
    const { data: contact } = await supabase
      .from('wmp_contacts')
      .select('name, phone_number')
      .eq('id', contactId)
      .single();

    // Build conversation for OpenAI
    const conversationHistory = sortedMessages.map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content || '',
    }));

    const knowledgeContext = (knowledge || [])
      .map(k => `## ${k.title}\n${k.content}`)
      .join('\n\n');

    const systemPrompt = `${aiConfig.system_prompt}\n\nBASE DE CONOCIMIENTO:\n${knowledgeContext}\n\nINFORMACIÓN DEL CLIENTE:\n- Nombre: ${contact?.name || 'Desconocido'}\n- Teléfono: ${contact?.phone_number || 'No disponible'}`;

    // Call OpenAI
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.api_key}`,
      },
      body: JSON.stringify({
        model: aiConfig.model || 'gpt-4o-mini',
        temperature: aiConfig.temperature || 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
        ],
        max_tokens: 500,
      }),
    });

    if (!openaiResponse.ok) {
      const err = await openaiResponse.text();
      debugLog(`OpenAI error: ${err}`);
      return null;
    }

    const data = await openaiResponse.json();
    const suggestion = data.choices?.[0]?.message?.content || '';

    if (!suggestion) return null;

    return { suggestion, withinHours, autoReply: !withinHours && aiConfig.auto_reply_when_absent };
  } catch (error) {
    debugLog(`AI error: ${error.message}`);
    return null;
  }
}

async function handleAIResponse(numero, contactId, accountId, content) {
  const aiResult = await getAIResponse(contactId, accountId, content);
  if (!aiResult) return;

  const { suggestion, withinHours, autoReply } = aiResult;

  if (autoReply) {
    // Outside business hours — send automatically
    debugLog(`[${numero}] AI auto-reply: ${suggestion.substring(0, 50)}...`);

    const session = activeSessions[numero];
    if (!session?.socket) {
      debugLog(`[${numero}] No active session for AI auto-reply`);
      return;
    }

    // Get contact to find JID
    const { data: contact } = await supabase
      .from('wmp_contacts')
      .select('phone_number, lid')
      .eq('id', contactId)
      .single();

    if (!contact) return;

    const phoneOrLid = contact.lid || contact.phone_number;
    const isLid = phoneOrLid.length >= 15;
    const jid = isLid ? `${phoneOrLid}@lid` : `${phoneOrLid}@s.whatsapp.net`;

    try {
      // Parse and extract customer data from AI response
      const dataMatch = suggestion.match(/\[DATOS:\s*(.+?)\]/);
      let cleanSuggestion = suggestion.replace(/\[DATOS:\s*.+?\]/, '').trim();

      if (dataMatch) {
        const dataStr = dataMatch[1];
        const updates = {};
        const fieldMap = {
          'nombre': 'name',
          'telefono': 'phone_number',
          'email': 'email',
          'destino_pais': 'destination_country',
          'destino_ciudad': 'destination_city',
          'zip': 'zip_code',
          'usa_zip': 'usa_zip_code',
          'mx_zip': 'mx_zip_code',
          'origen_estado': 'origin_state',
          'origen_ciudad': 'origin_city',
          'servicio': 'service_type',
          'notas': 'notes',
        };

        for (const pair of dataStr.split(',')) {
          const [key, ...valParts] = pair.split('=');
          const val = valParts.join('=').trim();
          const dbField = fieldMap[key.trim()];
          if (dbField && val) updates[dbField] = val;
        }

        if (Object.keys(updates).length > 0) {
          // Don't overwrite phone_number if contact already has a real one
          if (updates.phone_number) {
            const { data: existing } = await supabase
              .from('wmp_contacts')
              .select('phone_number')
              .eq('id', contactId)
              .single();
            if (existing?.phone_number && existing.phone_number.length < 15) {
              delete updates.phone_number;
            }
          }
          if (Object.keys(updates).length > 0) {
            await supabase.from('wmp_contacts').update(updates).eq('id', contactId);
            debugLog(`[${numero}] 📋 Client data saved: ${JSON.stringify(updates)}`);
          }
        }
      }

      // Separate TAREAS PARA AGENTE from client-visible message
      let clientMessage = (cleanSuggestion || suggestion);
      const taskMatch = clientMessage.match(/TAREAS?\s*PARA\s*AGENTE[S]?:\s*([\s\S]*?)(?=\n\n|$)/i);
      let agentTask = null;
      if (taskMatch) {
        agentTask = taskMatch[0].trim();
        clientMessage = clientMessage.replace(taskMatch[0], '').trim();
      }

      // Send only client-visible part to WhatsApp
      if (clientMessage) {
        await session.socket.sendMessage(jid, { text: clientMessage });
      }

      // Save client-visible message to DB
      await supabase.from('wmp_messages').insert({
        contact_id: contactId,
        whatsapp_account_id: accountId,
        content: clientMessage || cleanSuggestion || suggestion,
        direction: 'outbound',
        sender_type: 'ai',
      });

      // If there's a task for agents, send it to internal chat
      if (agentTask) {
        const contactName = contact.name || contact.phone_number || 'Desconocido';
        await supabase.from('wmp_internal_messages').insert({
          sender_email: 'paquita@paquetex.net',
          sender_name: 'Paquita (IA)',
          content: `📋 ${agentTask}\n\n👤 Cliente: ${contactName}\n📞 Tel: ${contact.phone_number || 'No disponible'}`,
        });
        debugLog(`[${numero}] 📋 Task enviado al chat interno`);
      }

      debugLog(`[${numero}] ✅ AI auto-reply sent`);
    } catch (err) {
      debugLog(`[${numero}] ❌ AI auto-reply failed: ${err.message}`);
    }
  } else if (withinHours) {
    // Within business hours — save suggestion for agent
    debugLog(`[${numero}] AI suggestion saved for agent`);
    broadcast('ai_suggestion', {
      contact_id: contactId,
      suggestion: suggestion,
    });
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

    const cleanNum = contacto.replace('+', '');
    // Real phone numbers are max 14 digits. LIDs are 15+ digits.
    const isLidNumber = cleanNum.length >= 15;
    const jid = isLidNumber ? `${cleanNum}@lid` : `${cleanNum}@s.whatsapp.net`;
    debugLog(`[${numero}] Enviando a JID: ${jid} (isLid: ${isLidNumber}, digits: ${cleanNum.length})`);
    debugLog(`[${numero}] Enviando a JID: ${jid}`);
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
