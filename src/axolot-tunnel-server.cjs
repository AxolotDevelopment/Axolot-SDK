/**
 * Axolot Tunnel Server
 * Servidor de túneles WebSocket minimalista para el VPS.
 * 
 * INSTALACIÓN EN VPS:
 *   cd /home/axolotcm/tn.axolotcms.com
 *   npm install ws
 *   nohup node axolot-tunnel-server.cjs > /home/axolotcm/logs/tunnel.log 2>&1 &
 * 
 * Requiere:
 *   - Node.js >= 14 (CommonJS, sin ESM)
 *   - npm install ws
 *   - Apache configurado para hacer proxy de *.tn.axolotcms.com → localhost:8080
 *     Y proxy WebSocket con RewriteRule ws://
 */

'use strict';

const http = require('http');
const crypto = require('crypto');

// WS se carga de forma dinámica para dar error claro si no está instalado
let WebSocketServer, WebSocket;
try {
  const wsModule = require('ws');
  WebSocketServer = wsModule.WebSocketServer || wsModule.Server;
  WebSocket = wsModule.WebSocket || wsModule;
} catch (e) {
  console.error('[ERROR] El paquete "ws" no está instalado. Ejecuta: npm install ws');
  process.exit(1);
}

// ─────────────────────────────────────────────
//  Configuración
// ─────────────────────────────────────────────
const DOMAIN      = process.env.TUNNEL_DOMAIN || 'tn.axolotcms.com';
const PORT        = parseInt(process.env.PORT  || '8080');
const REQUEST_TTL = 30000; // 30s timeout por petición

// ─────────────────────────────────────────────
//  Estado global
// ─────────────────────────────────────────────
// tunnels: subdomain → ws (WebSocket connection from SDK client)
const tunnels = new Map();

// pending: requestId → { res, timer }
const pending = new Map();

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─────────────────────────────────────────────
//  Servidor HTTP principal
// ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // LiteSpeed (and Apache) with mod_rewrite [P] rewrites the Host header to the backend.
  // The original host is preserved in X-Forwarded-Host. Check that first.
  const rawHost = (
    (req.headers['x-forwarded-host'] || req.headers.host || '') + ''
  ).split(',')[0].trim().toLowerCase().split(':')[0];

  // ── DEBUG: Log every incoming request ──
  console.log(`[REQ] ${req.method} ${req.url}`);
  console.log(`  host            : ${req.headers.host}`);
  console.log(`  x-forwarded-host: ${req.headers['x-forwarded-host'] || '(none)'}`);
  console.log(`  x-forwarded-for : ${req.headers['x-forwarded-for'] || '(none)'}`);
  console.log(`  resolved rawHost: ${rawHost}`);
  console.log(`  active tunnels  : [${Array.from(tunnels.keys()).join(', ')}]`);

  // ── Ruta de estado (dominio raíz) ──
  if (rawHost === DOMAIN || rawHost === `www.${DOMAIN}`) {
    const connected = Array.from(tunnels.keys());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      server: 'Axolot Tunnel Server',
      domain: DOMAIN,
      port: PORT,
      tunnels: connected,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // ── Extraer subdominio ──
  const domainSuffix = '.' + DOMAIN;
  if (!rawHost.endsWith(domainSuffix)) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const subdomain = rawHost.slice(0, rawHost.length - domainSuffix.length);
  const ws = tunnels.get(subdomain);

  if (!ws || ws.readyState !== 1 /* OPEN */) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><title>Túnel no conectado</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:80px auto;text-align:center">
  <h1>🦎 ${subdomain}.${DOMAIN}</h1>
  <p style="color:#666">El túnel local no está conectado.</p>
  <p>Arranca tu servidor Astro con <code>pnpm dev</code> y el SDK de Axolot lo conectará automáticamente.</p>
</body></html>`);
    return;
  }

  // ── Recolectar body de la petición ──
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const requestId = generateId();

    const message = {
      type: 'request',
      id: requestId,
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: body.length > 0 ? body.toString('base64') : null,
    };

    // Timeout de seguridad
    const timer = setTimeout(() => {
      pending.delete(requestId);
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('504 Gateway Timeout - Local dev server did not respond in time.');
      }
    }, REQUEST_TTL);

    pending.set(requestId, { res, timer });

    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(requestId);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('502 Bad Gateway - Could not forward request to tunnel client.');
      }
    }
  });

  req.on('error', (err) => {
    console.error(`[Axolot Tunnel] Request error for ${subdomain}:`, err.message);
  });
});

// ─────────────────────────────────────────────
//  Servidor WebSocket (para los clientes SDK)
// ─────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Subdomain comes as the first path segment: /oaxhosting
  // (query string is stripped by Apache during WebSocket proxy)
  let subdomain;
  try {
    const pathname = req.url ? req.url.split('?')[0] : '/';
    const pathParts = pathname.split('/').filter(Boolean);
    subdomain = pathParts[0] || generateId().slice(0, 8);
  } catch {
    subdomain = generateId().slice(0, 8);
  }

  // Si ya había un túnel con ese subdominio, cerrarlo limpiamente
  const existing = tunnels.get(subdomain);
  if (existing && existing.readyState === 1) {
    try { existing.close(1000, 'Replaced by new connection'); } catch {}
  }

  tunnels.set(subdomain, ws);
  const tunnelUrl = `https://${subdomain}.${DOMAIN}`;

  console.log(`✅ [Axolot Tunnel] Client connected: ${tunnelUrl}`);

  // Enviar URL de confirmación al cliente SDK
  ws.send(JSON.stringify({
    type: 'connected',
    url: tunnelUrl,
    subdomain,
  }));

  // ── Recibir respuestas del cliente SDK ──
  ws.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    if (msg.type === 'response' && msg.id) {
      const handler = pending.get(msg.id);
      if (!handler) return;

      const { res, timer } = handler;
      clearTimeout(timer);
      pending.delete(msg.id);

      if (res.headersSent) return;

      // Limpiar cabeceras problemáticas
      const headers = { ...(msg.headers || {}) };
      delete headers['transfer-encoding'];
      delete headers['connection'];
      delete headers['keep-alive'];

      try {
        res.writeHead(msg.status || 200, headers);
        if (msg.body) {
          res.end(Buffer.from(msg.body, 'base64'));
        } else {
          res.end();
        }
      } catch (err) {
        console.error(`[Axolot Tunnel] Error sending response:`, err.message);
      }
    }
  });

  ws.on('close', (code, reason) => {
    if (tunnels.get(subdomain) === ws) {
      tunnels.delete(subdomain);
      console.log(`⚠️  [Axolot Tunnel] Client disconnected: ${subdomain} (code: ${code})`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Axolot Tunnel] WebSocket error for ${subdomain}:`, err.message);
    if (tunnels.get(subdomain) === ws) {
      tunnels.delete(subdomain);
    }
  });
});

// ─────────────────────────────────────────────
//  Arranque
// ─────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦎 Axolot Tunnel Server`);
  console.log(`   Puerto   : ${PORT}`);
  console.log(`   Dominio  : ${DOMAIN}`);
  console.log(`   Protocolo: WSS sobre HTTPS (sin puertos TCP adicionales)\n`);
});

// Manejo de errores no capturados para evitar caídas
process.on('uncaughtException', (err) => {
  console.error('[Axolot Tunnel] Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Axolot Tunnel] Unhandled rejection:', reason);
});
