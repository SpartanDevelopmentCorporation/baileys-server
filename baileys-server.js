import crypto from 'crypto';
if (!globalThis.crypto) globalThis.crypto = crypto;

import express from 'express';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const API_KEY = process.env.API_KEY;
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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Auth Middleware - Validar API Key en todas las rutas excepto /health y /api/whatsapp/events (SSE usa query param)
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.path === '/api/whatsapp/events') return next();
  if (req.path === '/api/whatsapp/debug') return next();

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
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

    console.log('Baileys importado correctamente, makeWASocket type:', typeof makeWASocket);
    return { makeWASocket, DisconnectReason };
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
    const { makeWASocket, DisconnectReason } =
      await initBaileys();

    debugLog(`Iniciando sesión para ${numero}...`);

    const { state, saveCreds } = await useSupabaseAuthState(numero);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: ['Nexus', 'Chrome', '120.0.0'],
    });

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
            .from('whatsapp_accounts')
            .update({
              qr_code: currentQRCode,
              connection_status: 'qr_required',
              qr_expires_at: new Date(Date.now() + 60000).toISOString()
            })
            .eq('display_phone_number', numero);

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
          .from('whatsapp_accounts')
          .update({
            connection_status: 'open',
            last_connected_at: new Date().toISOString(),
            qr_code: null
          })
          .eq('display_phone_number', numero);

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
          .from('whatsapp_accounts')
          .update({
            connection_status: shouldReconnect ? 'reconnecting' : 'disconnected'
          })
          .eq('display_phone_number', numero);

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

async function syncContactos(numero, sock) {
  try {
    const contacts = await sock.fetchContacts();

    const { data: account } = await supabase
      .from('whatsapp_accounts')
      .select('id')
      .eq('display_phone_number', numero)
      .single();

    if (!account) {
      console.error(`WhatsAppAccount no encontrado para ${numero}`);
      return;
    }

    const whatsapp_account_id = account.id;

    for (const contact of contacts) {
      const phoneNumber = contact.id.split('@')[0];
      if (phoneNumber === 'status') continue;

      const fullPhone = phoneNumber.includes(':') 
        ? '+' + phoneNumber.split(':')[0] 
        : '+' + phoneNumber;

      const { error } = await supabase
        .from('contacts')
        .upsert({
          full_name: contact.name || fullPhone,
          phone: fullPhone,
          phone_e164: fullPhone,
          whatsapp_account_id: whatsapp_account_id,
          target_phone_number: numero,
          avatar_url: contact.picture || null
        }, {
          onConflict: 'phone,whatsapp_account_id'
        });

      if (error) {
        console.error(`Error guardando contacto ${fullPhone}:`, error);
      }
    }

    console.log(`✅ Sincronizados ${contacts.length} contactos para ${numero}`);
  } catch (error) {
    console.error(`Error sincronizando contactos:`, error);
  }
}

async function guardarMensaje(numero, message) {
  try {
    const { data: account } = await supabase
      .from('whatsapp_accounts')
      .select('id')
      .eq('display_phone_number', numero)
      .single();

    if (!account) return;

    const contactNumber = message.key.remoteJid.split('@')[0];
    const fullPhone = '+' + contactNumber;

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone', fullPhone)
      .eq('whatsapp_account_id', account.id)
      .single();

    let contactId = contact?.id;

    if (!contactId) {
      const { data: newContact } = await supabase
        .from('contacts')
        .insert({
          full_name: fullPhone,
          phone: fullPhone,
          phone_e164: fullPhone,
          whatsapp_account_id: account.id,
          target_phone_number: numero
        })
        .select('id')
        .single();

      contactId = newContact?.id;
    }

    if (!contactId) return;

    let conversationId;
    const { data: convo } = await supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
      .eq('whatsapp_account_id', account.id)
      .single();

    if (convo) {
      conversationId = convo.id;
    } else {
      const { data: newConvo } = await supabase
        .from('conversations')
        .insert({
          contact_id: contactId,
          whatsapp_account_id: account.id,
          platform: 'whatsapp',
          status: 'open'
        })
        .select('id')
        .single();

      conversationId = newConvo?.id;
    }

    if (!conversationId) return;

    let content = '';
    let messageType = 'text';

    if (message.message.conversation) {
      content = message.message.conversation;
    } else if (message.message.extendedTextMessage) {
      content = message.message.extendedTextMessage.text;
    } else if (message.message.imageMessage) {
      content = message.message.imageMessage.caption || '[Imagen]';
      messageType = 'image';
    } else if (message.message.documentMessage) {
      content = `[Documento: ${message.message.documentMessage.fileName}]`;
      messageType = 'document';
    } else if (message.message.audioMessage) {
      content = '[Audio]';
      messageType = 'audio';
    } else {
      content = '[Mensaje no soportado]';
    }

    await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        whatsapp_account_id: account.id,
        direction: 'inbound',
        provider: 'baileys',
        provider_message_id: message.key.id,
        from_e164: fullPhone,
        to_e164: numero,
        sender_type: 'contact',
        sender_id: contactId,
        sender_name: contact?.full_name || fullPhone,
        type: messageType,
        content: content,
        status: 'received',
        timestamp: new Date(message.messageTimestamp * 1000).toISOString()
      });

    await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: content.substring(0, 50),
        unread_count: (await getUnreadCount(conversationId)) + 1
      })
      .eq('id', conversationId);

    // Notificar a clientes SSE del nuevo mensaje
    broadcast('new_message', {
      account: numero,
      contact_phone: fullPhone,
      conversation_id: conversationId,
    });

  } catch (error) {
    console.error('Error guardando mensaje:', error);
  }
}

async function getUnreadCount(conversationId) {
  const { data } = await supabase
    .from('messages')
    .select('id', { count: 'exact' })
    .eq('conversation_id', conversationId)
    .eq('status', 'received')
    .eq('direction', 'inbound');

  return data?.length || 0;
}

app.get('/api/whatsapp/qr/:numero', async (req, res) => {
  const numero = normalizePhone(req.params.numero);

  try {
    const { data } = await supabase
      .from('whatsapp_accounts')
      .select('qr_code, connection_status')
      .eq('display_phone_number', numero)
      .single();

    if (!data) {
      return res.status(404).json({ error: 'Número no encontrado' });
    }

    res.json({
      numero,
      qr: data.qr_code,
      estado: data.connection_status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint - ver estado de sesiones activas
app.get('/api/whatsapp/debug', (req, res) => {
  if (req.query.key !== API_KEY) return res.status(401).json({ error: 'Add ?key=YOUR_API_KEY' });
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
    // Verificar si existe en Supabase, si no, auto-crear
    const { data: existing } = await supabase
      .from('whatsapp_accounts')
      .select('id')
      .eq('display_phone_number', numero)
      .single();

    if (!existing) {
      console.log(`[${numero}] Auto-creando registro en whatsapp_accounts`);
      await supabase.from('whatsapp_accounts').insert({
        name: numero,
        display_phone_number: numero,
        connection_status: 'connecting',
      });
    } else {
      await supabase.from('whatsapp_accounts')
        .update({ connection_status: 'connecting' })
        .eq('display_phone_number', numero);
    }

    // Limpiar creds anteriores corruptas para forzar QR fresco
    // (si ya estuviera conectado, no llegaría aquí porque el frontend no muestra el botón)
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

  try {
    const { data } = await supabase
      .from('whatsapp_accounts')
      .select('connection_status, last_connected_at')
      .eq('display_phone_number', numero)
      .single();

    if (!data) {
      return res.status(404).json({ error: 'Número no encontrado' });
    }

    res.json({
      numero,
      status: data.connection_status,
      last_connected: data.last_connected_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/mensajes/:numero', async (req, res) => {
  const numero = normalizePhone(req.params.numero);
  const { contacto, limite = 50 } = req.query;

  try {
    const { data: account } = await supabase
      .from('whatsapp_accounts')
      .select('id')
      .eq('display_phone_number', numero)
      .single();

    if (!account) {
      return res.status(404).json({ error: 'Número no encontrado' });
    }

    let query = supabase
      .from('messages')
      .select('*')
      .eq('whatsapp_account_id', account.id)
      .order('timestamp', { ascending: false })
      .limit(parseInt(limite));

    if (contacto) {
      query = query.eq('from_e164', contacto);
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

    const { data: account } = await supabase
      .from('whatsapp_accounts')
      .select('id')
      .eq('display_phone_number', numero)
      .single();

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone', contacto)
      .eq('whatsapp_account_id', account.id)
      .single();

    if (account && contact) {
      const { data: convo } = await supabase
        .from('conversations')
        .select('id')
        .eq('contact_id', contact.id)
        .eq('whatsapp_account_id', account.id)
        .single();

      if (convo) {
        await supabase
          .from('messages')
          .insert({
            conversation_id: convo.id,
            whatsapp_account_id: account.id,
            direction: 'outbound',
            provider: 'baileys',
            provider_message_id: sentMsg.key.id,
            from_e164: numero,
            to_e164: contacto,
            sender_type: 'agent',
            sender_name: 'Agente',
            type: 'text',
            content: mensaje,
            status: 'sent',
            timestamp: new Date().toISOString()
          });

        await supabase
          .from('conversations')
          .update({
            last_message_at: new Date().toISOString(),
            last_message_preview: mensaje.substring(0, 50)
          })
          .eq('id', convo.id);
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
    const { data: account } = await supabase
      .from('whatsapp_accounts')
      .select('id')
      .eq('display_phone_number', numero)
      .single();

    if (!account) {
      return res.status(404).json({ error: 'Número no encontrado' });
    }

    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('whatsapp_account_id', account.id)
      .order('last_contact_date', { ascending: false });

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
app.get('/api/whatsapp/events', (req, res) => {
  const apiKey = req.query.apiKey;
  if (!apiKey || apiKey !== API_KEY) {
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
      .from('whatsapp_accounts')
      .select('display_phone_number')
      .eq('connection_status', 'open');

    for (const acc of activeAccounts || []) {
      console.log(`🔄 Reconectando ${acc.display_phone_number}...`);
      startWhatsAppSession(acc.display_phone_number)
        .then(({ sock }) => console.log(`✅ Reconexión iniciada para ${acc.display_phone_number}`))
        .catch(err => console.error(`Error reconectando ${acc.display_phone_number}:`, err));
    }
  } catch (err) {
    console.error('Error en auto-reconexión:', err);
  }
});
