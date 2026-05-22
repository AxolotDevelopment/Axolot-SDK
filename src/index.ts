import type { AstroIntegration } from 'astro';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 *  Axolot CMS — Astro Integration
 * Bridge centralizado y sin dependencias externas.
 */
export default function axolot(): AstroIntegration {
  return {
    name: '@axolot/sdk',
    hooks: {
      'astro:config:setup': ({ injectScript, command }) => {
        const isDev = command === 'dev';
        injectScript('page', `
          (function() {
            const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            
            // Prioridad 1: Variables inyectadas desde el servidor (si existen)
            // Prioridad 2: Fallback dinámico basado en el entorno
            window.AXOLOT_SITE_ID = window.AXOLOT_SITE_ID || "${process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID || ''}";
            window.AXOLOT_API_URL = window.AXOLOT_API_URL || "${process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL || ''}" 
              || (isLocal || ${isDev} ? 'http://localhost:3001' : 'https://api.axolotcms.com');
            
            console.log(' [Axolot] SDK Configured:', { 
              siteId: window.AXOLOT_SITE_ID, 
              apiUrl: window.AXOLOT_API_URL,
              mode: "${command}"
            });
          })();
        `);
      },
      
      'astro:server:setup': ({ server }) => {
        //  AUTO-SYNC LOCAL PAGES TO PRODUCTION DB
        const pagesDir = path.join(process.cwd(), 'src', 'pages');
        const normPagesDir = pagesDir.replace(/\\/g, '/');
        
        async function reportPages() {
          const siteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
          const apiToken = process.env.PUBLIC_AXOLOT_API_TOKEN || process.env.AXOLOT_API_TOKEN;
          const rawApiUrl = process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL;
          
          if (!siteId || !apiToken) {
            console.log(' [Axolot Bridge] Skipping page auto-sync: Site ID or API Token not found in process.env');
            return;
          }
          
          const baseUrl = (rawApiUrl || 'http://localhost:3001').replace(/\/api\/v1\/?$/, '');
          const apiUrl = `${baseUrl}/api/v1`;
          
          try {
            const discoveredPages: { title: string, slug: string }[] = [];
            
            async function scanDir(dir: string, baseRoute = '') {
              const exists = await fs.access(dir).then(() => true).catch(() => false);
              if (!exists) return;
              const items = await fs.readdir(dir, { withFileTypes: true });
              for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                  await scanDir(fullPath, `${baseRoute}/${item.name}`);
                } else if (item.name.endsWith('.astro') || item.name.endsWith('.md') || item.name.endsWith('.mdx')) {
                  let slug = '';
                  const name = item.name.replace(/\.(astro|md|mdx)$/, '');
                  
                  if (name.startsWith('_') || name.startsWith('.')) continue;

                  if (name === 'index') {
                    slug = baseRoute === '' ? '/' : baseRoute;
                  } else {
                    slug = `${baseRoute}/${name}`;
                  }

                  if (slug.includes('[') || slug.includes('...')) continue;

                  const title = name === 'index' && baseRoute !== '' 
                    ? baseRoute.split('/').pop()?.replace(/-/g, ' ') || 'Página'
                    : name.replace(/-/g, ' ');
                  
                  const capitalizedTitle = title.charAt(0).toUpperCase() + title.slice(1);
                  
                  discoveredPages.push({
                    title: capitalizedTitle === 'Index' ? 'Inicio' : capitalizedTitle,
                    slug: slug === '' ? '/' : slug
                  });
                }
              }
            }

            await scanDir(pagesDir);
            
            if (discoveredPages.length > 0) {
              const res = await fetch(`${apiUrl}/sites/${siteId}/pages/report`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiToken}`
                },
                body: JSON.stringify({ pages: discoveredPages })
              });
              const data = await res.json() as any;
              console.log(' [Axolot Bridge] Pages auto-synced successfully:', data);
            }
          } catch (err: any) {
            console.error(' [Axolot Bridge] Error auto-syncing pages:', err.message);
          }
        }

        //  START SECURE TUNNEL TO PRODUCTION
        async function startTunnel() {
          const siteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
          const apiToken = process.env.PUBLIC_AXOLOT_API_TOKEN || process.env.AXOLOT_API_TOKEN;
          const rawApiUrl = process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL;
          
          if (!siteId || !apiToken) {
            console.log(' [Axolot Tunnel] Skipping tunnel: Site ID or API Token not found in process.env');
            return;
          }
          
          const baseUrl = (rawApiUrl || 'http://localhost:3001').replace(/\/api\/v1\/?$/, '');
          const apiUrl = `${baseUrl}/api/v1`;
          
          async function runTunnel(port: number) {
            try {
              // 1. Get site slug to try as subdomain
              let siteSlug = '';
              try {
                const res = await fetch(`${apiUrl}/sites/${siteId}`, {
                  headers: { 'Authorization': `Bearer ${apiToken}` }
                });
                if (res.ok) {
                  const siteData = await res.json() as any;
                  siteSlug = siteData.slug;
                }
              } catch (err: any) {
                console.log(' [Axolot Tunnel] Could not fetch site details:', err.message);
              }
              
              console.log(` [Axolot Tunnel] Connecting local port ${port} to Axolot Cloud...`);
              
              const lt = (await import('localtunnel')).default;
              let tunnel: any;
              
              try {
                // Try utilizing the slug as subdomain
                tunnel = await lt({ port, subdomain: siteSlug || undefined });
              } catch (err) {
                // Fallback to random subdomain
                tunnel = await lt({ port });
              }
              
              const tunnelUrl = tunnel.url;
              console.log(` [Axolot Tunnel] Tunnel created successfully: \x1b[36m${tunnelUrl}\x1b[0m -> http://localhost:${port}`);
              
              // 2. Register this tunnelUrl in production database
              const patchRes = await fetch(`${apiUrl}/sites/${siteId}`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiToken}`
                },
                body: JSON.stringify({ stagingUrl: tunnelUrl })
              });
              
              if (patchRes.ok) {
                console.log(' [Axolot Tunnel] Tunnel URL registered in production database.');
              } else {
                console.error(' [Axolot Tunnel] Failed to register tunnel URL in database:', patchRes.statusText);
              }
              
              // 3. Clear tunnel URL on exit/SIGINT/SIGTERM
              const cleanup = async () => {
                console.log(' [Axolot Tunnel] Disconnecting tunnel and clearing remote staging URL...');
                try {
                  tunnel.close();
                  await fetch(`${apiUrl}/sites/${siteId}`, {
                    method: 'PATCH',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${apiToken}`
                    },
                    body: JSON.stringify({ stagingUrl: null })
                  });
                } catch (e) {}
              };
              
              process.on('SIGINT', async () => {
                await cleanup();
                process.exit(0);
              });
              
              process.on('SIGTERM', async () => {
                await cleanup();
                process.exit(0);
              });
              
              // Astro dev server close hook or process exit
              server.httpServer?.on('close', async () => {
                await cleanup();
              });
              
            } catch (err: any) {
              console.error(' [Axolot Tunnel] Failed to start tunnel:', err.message);
            }
          }

          const defaultPort = server.config.server.port || 4321;
          if (server.httpServer) {
            if (server.httpServer.listening) {
              const address = server.httpServer.address();
              const activePort = address && typeof address === 'object' ? address.port : defaultPort;
              runTunnel(activePort);
            } else {
              server.httpServer.once('listening', () => {
                const address = server.httpServer?.address();
                const activePort = address && typeof address === 'object' ? address.port : defaultPort;
                runTunnel(activePort);
              });
            }
          } else {
            runTunnel(defaultPort);
          }
        }

        // Run initially on server setup
        reportPages();
        startTunnel();

        // Listen for additions or deletions of astro/md/mdx files in src/pages
        server.watcher.on('add', (file: string) => {
          const normFile = file.replace(/\\/g, '/');
          if (normFile.includes(normPagesDir) && /\.(astro|md|mdx)$/.test(normFile)) {
            console.log(' [Axolot Bridge] Page added, syncing...', path.basename(file));
            reportPages();
          }
        });
        
        server.watcher.on('unlink', (file: string) => {
          const normFile = file.replace(/\\/g, '/');
          if (normFile.includes(normPagesDir) && /\.(astro|md|mdx)$/.test(normFile)) {
            console.log(' [Axolot Bridge] Page removed, syncing...', path.basename(file));
            reportPages();
          }
        });

        // Función recursiva nativa para buscar archivos .astro
        async function getAstroFiles(dir: string): Promise<string[]> {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const files = await Promise.all(entries.map((res) => {
            const resPath = path.resolve(dir, res.name);
            return res.isDirectory() ? getAstroFiles(resPath) : (res.name.endsWith('.astro') ? resPath : null);
          }));
          return files.flat().filter(Boolean) as string[];
        }

        // Helper para validar el token y los permisos
        async function validateRequest(req: any, res: any, requiredScope: 'filesystem:read' | 'filesystem:write'): Promise<boolean> {
          const authHeader = req.headers.authorization;
          let token = '';
          if (authHeader?.startsWith('Bearer ') && authHeader.split(' ')[1] !== 'undefined') {
            token = authHeader.split(' ')[1];
          } else if (authHeader && authHeader !== 'undefined') {
            token = authHeader;
          }

          const localApiToken = process.env.PUBLIC_AXOLOT_API_TOKEN || process.env.AXOLOT_API_TOKEN;
          const localSiteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
          const rawApiUrl = process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL;
          const baseUrl = (rawApiUrl || 'http://localhost:3001').replace(/\/api\/v1\/?$/, '');
          const apiUrl = `${baseUrl}/api/v1`;

          if (!token) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Unauthorized', message: 'No authorization token provided' }));
            return false;
          }

          // Caso 1: El token coincide directamente con la API Key local del desarrollador
          if (localApiToken && token === localApiToken) {
            return true;
          }

          // Caso 2: Verificar contra la API central (p. ej. token de sesión del dashboard)
          try {
            const checkRes = await fetch(`${apiUrl}/auth/me`, {
              headers: { 'Authorization': authHeader }
            });

            if (!checkRes.ok) {
              res.statusCode = 401;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Unauthorized', message: 'Invalid token' }));
              return false;
            }

            const userData = await checkRes.json() as any;

            // Validar acceso al sitio
            if (userData.role !== 'super_admin' && userData.siteId !== localSiteId) {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Forbidden', message: 'No access to this site' }));
              return false;
            }

            // Validar permisos (scopes)
            if (userData.scopes && !userData.scopes.includes(requiredScope)) {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Forbidden', message: `Missing required scope: ${requiredScope}` }));
              return false;
            }

            return true;
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }));
            return false;
          }
        }

        // 1. ENDPOINT: /_axolot/fs/read
        server.middlewares.use('/_axolot/fs/read', async (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
          const authorized = await validateRequest(req, res, 'filesystem:read');
          if (!authorized) return;
          let body = ''; req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { filePath } = JSON.parse(body);
              const absolutePath = path.join(process.cwd(), filePath);
              const content = await fs.readFile(absolutePath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ content }));
            } catch (err: any) {
              res.statusCode = 500; res.end(JSON.stringify({ error: err.message }));
            }
          });
        });

        // 2. ENDPOINT: /_axolot/fs/write
        server.middlewares.use('/_axolot/fs/write', async (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
          const authorized = await validateRequest(req, res, 'filesystem:write');
          if (!authorized) return;
          let body = ''; req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { filePath, content } = JSON.parse(body);
              const absolutePath = path.join(process.cwd(), filePath);
              await fs.writeFile(absolutePath, content, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (err: any) {
              res.statusCode = 500; res.end(JSON.stringify({ error: err.message }));
            }
          });
        });

        // 3. ENDPOINT: /_axolot/fs/list
        server.middlewares.use('/_axolot/fs/list', async (req, res) => {
          if (req.method !== 'GET') { res.statusCode = 405; return res.end(); }
          const authorized = await validateRequest(req, res, 'filesystem:read');
          if (!authorized) return;
          try {
            const srcPath = path.join(process.cwd(), 'src');
            const files = await getAstroFiles(srcPath);
            // Devolver rutas relativas para mayor seguridad/comodidad
            const relativeFiles = files.map(f => path.relative(process.cwd(), f).replace(/\\/g, '/'));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ files: relativeFiles }));
          } catch (err: any) {
            res.statusCode = 500; res.end(JSON.stringify({ error: err.message }));
          }
        });
      }
    }
  };
}

export * from './lib/cms.js';
