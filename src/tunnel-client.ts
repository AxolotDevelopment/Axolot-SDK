/**
 * Axolot Tunnel Client
 * Cliente de túnel WebSocket personalizado que reemplaza el paquete localtunnel.
 * Comunica con el servidor axolot-tunnel-server.cjs en el VPS.
 * Funciona 100% sobre el puerto 443 (WSS), sin puertos TCP adicionales.
 */

import * as http from 'node:http';

interface TunnelRequest {
  type: 'request';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string | string[]>;
  body: string | null; // base64
}

interface TunnelResponse {
  type: 'response';
  id: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: string; // base64
}

interface TunnelConnectedMsg {
  type: 'connected';
  url: string;
  subdomain: string;
}

type TunnelServerMsg = TunnelRequest | TunnelConnectedMsg;

function forwardToLocal(port: number, msg: TunnelRequest): Promise<Omit<TunnelResponse, 'type' | 'id'>> {
  return new Promise((resolve) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(msg.headers || {})) {
      const key = k.toLowerCase();
      // Skip hop-by-hop headers
      if (['connection', 'upgrade', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding'].includes(key)) continue;
      headers[key] = v;
    }
    headers['host'] = `localhost:${port}`;

    const options: http.RequestOptions = {
      hostname: 'localhost',
      port,
      path: msg.path || '/',
      method: msg.method || 'GET',
      headers,
    };

    const localReq = http.request(options, (localRes) => {
      const chunks: Buffer[] = [];
      localRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      localRes.on('end', () => {
        // Clean response headers
        const resHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(localRes.headers || {})) {
          if (v !== undefined && !['connection', 'transfer-encoding'].includes(k.toLowerCase())) {
            resHeaders[k] = v as string | string[];
          }
        }
        resolve({
          status: localRes.statusCode || 200,
          headers: resHeaders,
          body: Buffer.concat(chunks).toString('base64'),
        });
      });
      localRes.on('error', () => {
        resolve({ status: 502, headers: {}, body: Buffer.from('Local server response error').toString('base64') });
      });
    });

    localReq.on('error', () => {
      resolve({ status: 502, headers: {}, body: Buffer.from('Could not connect to local server').toString('base64') });
    });

    localReq.setTimeout(15000, () => {
      localReq.destroy();
      resolve({ status: 504, headers: {}, body: Buffer.from('Local server timeout').toString('base64') });
    });

    if (msg.body) {
      localReq.write(Buffer.from(msg.body, 'base64'));
    }
    localReq.end();
  });
}

export interface AxolotTunnelOptions {
  port: number;
  host: string;       // e.g. https://tn.axolotcms.com
  subdomain?: string; // e.g. oaxhosting
  onConnect?: (url: string) => void;
  onDisconnect?: () => void;
}

export function startAxolotTunnel(options: AxolotTunnelOptions): () => void {
  const { port, host, subdomain, onConnect, onDisconnect } = options;

  // Convert https:// → wss://, http:// → ws://
  const wsBase = host.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  // Use PATH for subdomain so Apache doesn't strip it during WebSocket proxy
  const wsUrl = subdomain ? `${wsBase}/${encodeURIComponent(subdomain)}` : wsBase;

  let ws: any = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function connect() {
    if (stopped) return;

    // Dynamically import ws (so it doesn't break build in browser contexts)
    import('ws').then(({ default: WS }) => {
      if (stopped) return;

      ws = new WS(wsUrl, {
        handshakeTimeout: 10000,
        headers: { 'x-axolot-client': '1' },
      });

      ws.on('open', () => {
        console.log(` 🔌 [Axolot Tunnel] Connecting to ${wsUrl}...`);
      });

      ws.on('message', async (rawData: Buffer) => {
        let msg: TunnelServerMsg;
        try {
          msg = JSON.parse(rawData.toString()) as TunnelServerMsg;
        } catch {
          return;
        }

        if (msg.type === 'connected') {
          console.log(` ✅ [Axolot Tunnel] Tunnel active: \x1b[36m${msg.url}\x1b[0m → http://localhost:${port}`);
          reconnectAttempts = 0;
          onConnect?.(msg.url);

          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (ws?.readyState === 1 /* OPEN */) {
              ws.ping();
            }
          }, 30000);
          return;
        }

        if (msg.type === 'request') {
          try {
            const result = await forwardToLocal(port, msg);
            const response: TunnelResponse = {
              type: 'response',
              id: msg.id,
              ...result,
            };
            if (ws?.readyState === 1 /* OPEN */) {
              ws.send(JSON.stringify(response));
            }
          } catch (err: any) {
            console.error(` [Axolot Tunnel] Error forwarding request:`, err.message);
          }
        }
      });

      ws.on('close', () => {
        if (stopped) return;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        reconnectAttempts++;
        const nextDelay = Math.min(5000 * Math.pow(1.5, reconnectAttempts - 1), 60000);
        console.log(` ⚠️  [Axolot Tunnel] Connection lost. Reconnecting in ${Math.round(nextDelay / 1000)}s...`);
        onDisconnect?.();
        reconnectTimer = setTimeout(connect, nextDelay);
      });

      ws.on('error', (err: any) => {
        if (stopped) return;
        console.error(` [Axolot Tunnel] WebSocket error: ${err?.message || err} (Code: ${err?.code || 'unknown'})`, err?.stack || '');
      });
    }).catch((err) => {
      console.error(' [Axolot Tunnel] Failed to load ws module:', err.message);
    });
  }

  connect();

  // Return stop function for cleanup
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (ws) {
      ws.close();
      ws = null;
    }
  };
}
