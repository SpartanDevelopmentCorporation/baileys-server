# Baileys WhatsApp Server

Servidor Baileys para conectar WhatsApp con Supabase.

## Stack

- **Runtime**: Node.js 20 (ESM modules)
- **Framework**: Express
- **WhatsApp**: @whiskeysockets/baileys v7
- **Database**: Supabase (@supabase/supabase-js)
- **Entry point**: `baileys-server.js`

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `SUPABASE_URL` | ✅ | URL del proyecto Supabase |
| `SUPABASE_KEY` | ✅ | API key de Supabase |
| `API_KEY` | ✅ | Clave secreta para autenticación de la API |
| `WEBHOOK_SECRET` | ❌ | Clave secreta para validar webhooks |
| `PORT` | ❌ | Puerto del servidor (default: `3000`) |
| `ALLOWED_ORIGINS` | ❌ | Orígenes CORS permitidos (default: `*`) |

## Docker

### Build

```bash
docker build -t 172.28.48.1:5000/baileys-server:latest .
```

### Push a registry local

```bash
# Levantar registry local (si no existe)
docker run -d -p 5000:5000 --restart always --name registry registry:2

# Push
docker push 172.28.48.1:5000/baileys-server:latest
```

### Run con resiliencia

```bash
docker run -d \
  --name baileys-server \
  --restart always \
  -p 3000:3000 \
  -e SUPABASE_URL=<tu-url> \
  -e SUPABASE_KEY=<tu-key> \
  -e API_KEY=<tu-api-key> \
  -e WEBHOOK_SECRET=<tu-webhook-secret> \
  -e ALLOWED_ORIGINS=<origenes-permitidos> \
  -e PORT=3000 \
  172.28.48.1:5000/baileys-server:latest
```

### Notas de despliegue

- La IP `172.28.48.1` es la interfaz WSL/Hyper-V del host Windows
- Si Docker no encuentra el registry, agregar `"insecure-registries": ["172.28.48.1:5000"]` en Docker Desktop → Settings → Docker Engine
- El Dockerfile incluye un healthcheck que verifica `/health` cada 30s
- `--restart always` asegura que el contenedor se reinicie ante fallos o reboot del host

## Tareas pendientes

- [ ] Levantar registry local: `docker run -d -p 5000:5000 --restart always --name registry registry:2`
- [ ] Agregar `"insecure-registries": ["172.28.48.1:5000"]` en Docker Desktop → Settings → Docker Engine y reiniciar
- [ ] Build de la imagen: `docker build -t 172.28.48.1:5000/baileys-server:latest .`
- [ ] Push al registry: `docker push 172.28.48.1:5000/baileys-server:latest`
- [ ] Correr el contenedor con variables de Supabase y `--restart always` (ver sección "Run con resiliencia")

## Desarrollo

```bash
# Instalar dependencias
npm install

# Modo desarrollo (con watch y .env)
npm run dev

# Producción
npm start
```
