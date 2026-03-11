import express from 'express';
import { Telegraf } from 'telegraf';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BAILEYS_DATA_DIR = process.env.BAILEYS_DATA_DIR || './baileys_auth';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL y SUPABASE_KEY son requeridas');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

let sock = null;
let currentQRCode = null;
let activeSessions = {};

async function initBaileys() {
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = 
      await import('@whiskeysockets/baileys');

    console.log('Baileys importado correctamente');
    return { makeWASocket, useMultiFileAuthState, DisconnectReason };
  } catch (error) {
    console.error('Error importando Baileys:', error);
    throw error;
  }
}

async function startWhatsAppSession(numero) {
  try {
    const { makeWASocket, useMultiFileAuthState, DisconnectReason } = 
      await initBaileys();

    const sessionDir = path.join(BAILEYS_DATA_DIR, numero);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    console.log(`Iniciando sesión para ${numero}...`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: { info: console.log, error: console.error, warn: console.warn }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQRCode = await QRCode.toDataURL(qr);
          activeSessions[numero] = {
            ...activeSessions[numero],
            qr: currentQRCode,
            estado: 'qr_esperando'
          };
          console.log(`[${numero}] QR generado`);

          await supabase
            .from('whatsapp_accounts')
            .update({
              qr_code: currentQRCode,
              connection_status: 'qr_required',
              qr_expires_at: new Date(Date.now() + 60000).toISOString()
            })
            .eq('display_phone_number', numero);

        } catch (err) {
          console.error('Error generando QR:', err);
        }
      }

      if (connection === 'open') {
        console.log(`✅ [${numero}] Conectado a WhatsApp`);
        activeSessions[numero] = {
          ...activeSessions[numero],
          estado: 'conectado',
          socket: sock
        };

        await supabase
          .from('whatsapp_accounts')
          .update({
            connection_status: 'open',
            last_connected_at: new Date().toISOString(),
            qr_code: null
          })
          .eq('display_phone_number', numero);

        await syncContactos(numero, sock);
      }

      if (connection === 'close') {
        const shouldReconnect = 
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log(`❌ [${numero}] Desconectado`);
        activeSessions[numero].estado = 'desconectado';

        if (shouldReconnect) {
          setTimeout(() => startWhatsAppSession(numero), 3000);
        }

        await supabase
          .from('whatsapp_accounts')
          .update({
            connection_status: 'close'
          })
          .eq('display_phone_number', numero);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      const message = m.messages[0];

      if (!message.key.fromMe && message.message) {
        await guardarMensaje(numero, message);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    activeSessions[numero] = {
      socket: sock,
      estado: 'inicializando'
    };

    return sock;
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
  const { numero } = req.params;

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

app.post('/api/whatsapp/connect/:numero', async (req, res) => {
  const { numero } = req.params;

  try {
    const { data } = await supabase
      .from('whatsapp_accounts')
      .select('id')
      .eq('display_phone_number', numero)
      .single();

    if (!data) {
      return res.status(404).json({ error: 'WhatsApp Account no existe' });
    }

    await startWhatsAppSession(numero);

    res.json({
      success: true,
      mensaje: `Iniciando conexión para ${numero}. Escanea el QR.`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/status/:numero', async (req, res) => {
  const { numero } = req.params;

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
  const { numero } = req.params;
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
  const { numero, contacto, mensaje } = req.body;

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
  const { numero } = req.params;

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Baileys corriendo en puerto ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
