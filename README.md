# 🚀 Servidor Baileys - WhatsApp a Supabase

Servidor Node.js que conecta WhatsApp (vía Baileys) con Supabase para sincronizar mensajes, contactos y conversaciones.

---
Grcias.

## 📋 REQUISITOS

- [Node.js 18+](https://nodejs.org/)
- Cuenta en [Supabase](https://supabase.com)
- Cuenta en [Railway](https://railway.app) (para deploy)
- Base44 con estructura de BD actualizada

---

## ⚙️ INSTALACIÓN LOCAL (para desarrollo)

### 1. Clonar o descargar este código

```bash
git clone <tu-repo>
cd baileys-server
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

Copia `.env.example` a `.env`:

```bash
cp .env.example .env
```

Edita `.env` con tus credenciales:

```
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_KEY=tu-api-key-anon-aqui
PORT=3000
```

**¿Dónde obtener SUPABASE_URL y SUPABASE_KEY?**

1. Ve a https://app.supabase.com
2. Selecciona tu proyecto
3. Ve a Settings → API
4. Copia:
   - `Project URL` → SUPABASE_URL
   - `anon key` (la pública) → SUPABASE_KEY

### 4. Ejecutar localmente

```bash
npm run dev
```

Deberías ver:
```
🚀 Servidor Baileys corriendo en puerto 3000
📊 Health check: http://localhost:3000/health
```

---

## 🚢 DEPLOY EN RAILWAY

### 1. Preparar código en GitHub

```bash
# Crear repo en GitHub
git init
git add .
git commit -m "Initial commit: Baileys server"
git push origin main
```

### 2. Conectar a Railway

1. Ve a https://railway.app
2. Sign up / Log in
3. "New Project" → "Deploy from GitHub"
4. Selecciona tu repo
5. Railway detecta automáticamente Node.js

### 3. Configurar variables en Railway

En Railway dashboard:

1. Va a tu proyecto
2. "Variables" → "Add Variable"
3. Agrega:

```
SUPABASE_URL = https://tu-proyecto.supabase.co
SUPABASE_KEY = tu-api-key-aqui
```

### 4. Deploy automático

Railroad detecta cambios en GitHub y redeploya automáticamente.

Tu servidor estará en: `https://tu-proyecto.railway.app`

---

## 🐳 DOCKER

### Build

```bash
docker build -t baileys-server .
```

### Run

```bash
docker run -d \
  --name baileys-server \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  --memory 512m \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  baileys-server
```

### Required env vars (in `.env`)

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Supabase API key (anon or service role) |
| `API_KEY` | Secret key to authenticate API calls (`x-api-key` header) |
| `WEBHOOK_SECRET` | (Optional) Second secret for server-to-server calls (`x-webhook-secret` header) |
| `PORT` | (Optional) Port inside container, default `3000` |
| `ALLOWED_ORIGINS` | (Optional) Comma-separated allowed origins, default `*` |

### Same-network deployment (remote host)

On the remote host:

```bash
# SSH into the machine
ssh user@your-remote-host

# Install Docker if needed
curl -fsSL https://get.docker.com | sh

# Create a working directory
mkdir -p ~/baileys && cd ~/baileys

# Copy your .env file there
scp .env user@your-remote-host:~/baileys/

# Build and run
docker build -t baileys-server .
docker run -d \
  --name baileys-server \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  --memory 512m \
  baileys-server
```

Your app (Vercel / Base44 / etc.) calls this server at `http://<remote-ip>:3000` from the same network, or via your public IP + port-forward. Set `ALLOWED_ORIGINS` to restrict which origins can call the API.

---

## 🔒 SEGURIDAD

### Claves de autenticación

El servidor acepta **dos claves secretas** en paralelo. Puedes usar una o ambas:

| Clave | Env var | Header | Uso |
|---|---|---|---|
| `API_KEY` | `API_KEY` | `x-api-key` | Llamadas directas desde Edge Functions o clientes |
| `WEBHOOK_SECRET` | `WEBHOOK_SECRET` | `x-webhook-secret` | Server-to-server (Edge Functions como intermediarias) |

### Arquitectura recomendada (frontend → Baileys nunca directo)

```
Navegador / App
      ↓
Supabase (lecturas + Realtime)
      ↓  fetch() con x-api-key o x-webhook-secret
Baileys Docker (servidor propio)
```

**Nunca expongas las claves API en el navegador.** Todas las llamadas al Baileys server deben pasar por Supabase Edge Functions o tu backend.

### Endpoints públicos (sin clave)

| Ruta | Notas |
|---|---|
| `GET /health` | Solo verificación de vida del servicio |

### Endpoints protegidos (requieren clave)

Todas las demás rutas requieren `x-api-key` **o** `x-webhook-secret` en el header.

### Ejemplo desde Supabase Edge Function

```javascript
// Enviar mensaje via Baileys
await fetch('http://tu-baileys-host:3000/api/whatsapp/enviar', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': Deno.env.get('API_KEY'),
  },
  body: JSON.stringify({ numero: '+34123456789', contacto: '+34987654321', mensaje: 'Hola' })
});
```

---

## 📡 API ENDPOINTS

### Conectar un número

```bash
POST https://tu-servidor.railway.app/api/whatsapp/connect/:numero

Body: {}

Respuesta:
{
  "success": true,
  "mensaje": "Iniciando conexión para +34123456789. Escanea el QR."
}
```

### Obtener QR

```bash
GET https://tu-servidor.railway.app/api/whatsapp/qr/+34123456789

Respuesta:
{
  "numero": "+34123456789",
  "qr": "data:image/png;base64,...",
  "estado": "qr_required"
}
```

### Estado de conexión

```bash
GET https://tu-servidor.railway.app/api/whatsapp/status/+34123456789

Respuesta:
{
  "numero": "+34123456789",
  "status": "open",
  "last_connected": "2025-03-11T10:30:00.000Z"
}
```

### Obtener mensajes

```bash
GET https://tu-servidor.railway.app/api/whatsapp/mensajes/+34123456789?contacto=+34987654321&limite=50

Respuesta:
{
  "numero": "+34123456789",
  "contacto": "+34987654321",
  "total": 15,
  "mensajes": [
    {
      "id": "uuid",
      "content": "Hola, ¿cómo estás?",
      "type": "text",
      "direction": "inbound",
      "timestamp": "2025-03-11T10:25:00.000Z"
    }
  ]
}
```

### Enviar mensaje

```bash
POST https://tu-servidor.railway.app/api/whatsapp/enviar

Body:
{
  "numero": "+34123456789",
  "contacto": "+34987654321",
  "mensaje": "¡Hola! Recibí tu mensaje"
}

Respuesta:
{
  "success": true,
  "mensajeId": "wamid.xxxxx"
}
```

### Obtener contactos

```bash
GET https://tu-servidor.railway.app/api/whatsapp/contactos/+34123456789

Respuesta:
{
  "numero": "+34123456789",
  "total": 42,
  "contactos": [
    {
      "id": "uuid",
      "full_name": "Juan García",
      "phone": "+34987654321",
      "avatar_url": null
    }
  ]
}
```

### Health check

```bash
GET https://tu-servidor.railway.app/health

Respuesta:
{
  "status": "ok",
  "timestamp": "2025-03-11T10:30:00.000Z"
}
```

---

## 🔗 INTEGRACIÓN CON BASE44

En tu app Base44, cuando quieras conectar un número:

```javascript
// En un endpoint de tu app Base44

const numero = "+34123456789";
const railwayUrl = "https://tu-servidor.railway.app";

// 1. Iniciar conexión
const connectResponse = await fetch(
  `${railwayUrl}/api/whatsapp/connect/${numero}`,
  { method: 'POST' }
);

// 2. Mostrar QR
const qrResponse = await fetch(
  `${railwayUrl}/api/whatsapp/qr/${numero}`
);
const { qr } = await qrResponse.json();

// Mostrar qr (es una imagen PNG en base64)
document.getElementById('qrImage').src = qr;

// 3. Esperando escaneo (polling cada 3 segundos)
const checkStatus = async () => {
  const status = await fetch(
    `${railwayUrl}/api/whatsapp/status/${numero}`
  ).then(r => r.json());

  if (status.status === 'open') {
    console.log('✅ Conectado!');
    // Guardar número en BD
  } else {
    setTimeout(checkStatus, 3000);
  }
};

checkStatus();
```

---

## 📊 FLUJO DE DATOS

```
┌─────────────────────────┐
│   Usuario escanea QR    │
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│  Baileys se conecta     │
│  a WhatsApp             │
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│  Contacto te escribe    │
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│  Baileys recibe mensaje │
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│  Se guarda en Supabase  │
│  - contacts             │
│  - conversations        │
│  - messages             │
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│  Base44 lo muestra      │
│  en tiempo real         │
└─────────────────────────┘
```

---

## 🛠️ TROUBLESHOOTING

### "SUPABASE_URL y SUPABASE_KEY son requeridas"

Verifica que las variables de entorno estén configuradas en Railway:
- Dashboard → Tu proyecto → Variables

### "No hay sesión activa para +34..."

El número aún no se conectó o se desconectó. Ejecuta:

```bash
POST /api/whatsapp/connect/+34123456789
```

Y escanea el QR nuevamente.

### "Error de memoria en Railway"

Baileys usa ~30-50MB por número conectado. Con el plan $5 de Railway tienes 512MB. Puedes:

1. Desconectar números inactivos
2. Upgrade a plan de más RAM
3. Usar múltiples instancias

### QR expira cada minuto

Es normal. Solicita uno nuevo con:

```bash
GET /api/whatsapp/qr/+34123456789
```

---

## 📚 REFERENCIAS

- [Baileys Docs](https://github.com/WhiskeySockets/Baileys)
- [Supabase Docs](https://supabase.com/docs)
- [Railway Docs](https://docs.railway.app)
- [Base44 Docs](https://base44.com/docs)

---

## 📝 NOTAS IMPORTANTES

1. **Respeto a WhatsApp**: No hagas spam. Usa esto solo para interacciones legítimas.

2. **Sesiones persistentes**: Las sesiones se guardan en `/tmp/baileys_auth` en Railway. Si el servidor se reinicia, necesitarás volver a escanear el QR.

3. **Escalabilidad**: Cada número conectado usa recursos. Para producción con muchos números, considera múltiples instancias.

4. **Backup**: La BD está en Supabase. Configura backups automáticos.

---

## 🚀 ¿Próximos pasos?

1. ✅ Desplegar este servidor en Railway
2. ✅ Conectar con Base44
3. ✅ Crear frontend para escanear QR
4. ✅ Mostrar mensajes en tiempo real
5. ✅ Implementar respuestas automáticas con IA

¡Listo! 🎉
