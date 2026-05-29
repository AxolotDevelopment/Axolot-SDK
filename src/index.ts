import type { AstroIntegration } from 'astro';
import { startAxolotTunnel } from './tunnel-client.js';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

function loadEnvFile() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fsSync.existsSync(envPath)) {
      const content = fsSync.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index > 0) {
          const key = trimmed.slice(0, index).trim();
          const val = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (err) {
    console.error(' [Axolot SDK] Failed to load local .env file:', err);
  }
}

// Helper para buscar archivos .astro recursivamente
async function getAstroFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((res) => {
    const resPath = path.resolve(dir, res.name);
    return res.isDirectory() ? getAstroFiles(resPath) : (res.name.endsWith('.astro') ? resPath : null);
  }));
  return files.flat().filter(Boolean) as string[];
}

// Helper para realizar fetch con timeout y evitar bloqueos en el hilo principal de Astro
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 3000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
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
    const checkRes = await fetchWithTimeout(`${apiUrl}/auth/me`, {
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

/**
 *  Axolot CMS — Astro Integration
 * Bridge centralizado y sin dependencias externas.
 */
export default function axolot(): AstroIntegration {
  console.log(' [Axolot SDK] axolot() function called!');
  loadEnvFile();

  let viteServer: any = null;
  let tunnelStarted = false;
  let lastReportedPagesHash = '';

  return {
    name: '@axolot/sdk',
    hooks: {
      'astro:config:setup': async ({ injectScript, command, updateConfig, injectRoute }) => {
        console.log(' [Axolot SDK] Hook astro:config:setup triggered! command:', command);
        const isDev = command === 'dev';
        injectScript('page', `
          (function() {
            const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            
            // Prioridad 1: Variables inyectadas desde el servidor (si existen)
            // Prioridad 2: Fallback dinámico basado en el entorno
            let rawUrl = "${process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL || ''}";
            if (rawUrl.includes(':3002')) rawUrl = rawUrl.replace(':3002', ':3001');
            window.AXOLOT_SITE_ID = window.AXOLOT_SITE_ID || "${process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID || ''}";
            window.AXOLOT_API_URL = window.AXOLOT_API_URL || rawUrl 
              || (isLocal || ${isDev} ? 'http://localhost:3001' : 'https://api.axolotcms.com');
            
            console.log(' [Axolot] SDK Configured:', { 
              siteId: window.AXOLOT_SITE_ID, 
              apiUrl: window.AXOLOT_API_URL,
              mode: "${command}"
            });
          })();
        `);

        // DYNAMIC i18n ROUTE INJECTION
        const siteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
        const apiToken = process.env.PUBLIC_AXOLOT_API_TOKEN || process.env.AXOLOT_API_TOKEN;
        const rawApiUrl = process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL;
        
        let baseUrl = (rawApiUrl || 'http://localhost:3001').trim();
        if (baseUrl.endsWith('/api/v1')) {
          baseUrl = baseUrl.slice(0, -7);
        } else if (baseUrl.endsWith('/api/v1/')) {
          baseUrl = baseUrl.slice(0, -8);
        }
        baseUrl = baseUrl.replace(/\/$/, '');
        const apiUrl = `${baseUrl}/api/v1`;

        if (siteId && apiToken) {
          try {
            const res = await fetchWithTimeout(`${apiUrl}/sites/${siteId}/translations/settings`, {
              headers: {
                'Authorization': `Bearer ${apiToken}`
              }
            }, 500);
            if (res.ok) {
              const settings = await res.json() as any;
              const languages = settings.languages || [];
              const defaultLanguage = settings.defaultLanguage || 'en';

              if (languages.length > 0) {
                // Fetch existing translations to get route/slug mappings
                let translations: any[] = [];
                try {
                  const transRes = await fetchWithTimeout(`${apiUrl}/sites/${siteId}/translations/`, {
                    headers: { 'Authorization': `Bearer ${apiToken}` }
                  }, 1000);
                  if (transRes.ok) {
                    translations = await transRes.json();
                  }
                } catch (e) {}

                const pagesDir = path.join(process.cwd(), 'src', 'pages');
                const files: string[] = [];

                async function scan(dir: string) {
                  try {
                    const entries = await fs.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                      const fullPath = path.join(dir, entry.name);
                      if (entry.isDirectory()) {
                        // Skip folders that match any of our configured locales to avoid routes collision
                        if (languages.includes(entry.name) || entry.name === defaultLanguage) continue;
                        await scan(fullPath);
                      } else if (entry.name.endsWith('.astro') || entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
                        const name = entry.name.replace(/\.(astro|md|mdx)$/, '');
                        if (name.startsWith('_') || name.startsWith('.')) continue;
                        files.push(fullPath);
                      }
                    }
                  } catch (e) {}
                }

                await scan(pagesDir);

                for (const file of files) {
                  const relative = path.relative(pagesDir, file).replace(/\\/g, '/');
                  const baseRoute = relative.replace(/\.(astro|md|mdx)$/, '');
                  let routePattern = '';
                  if (baseRoute === 'index') {
                    routePattern = '/';
                  } else if (baseRoute.endsWith('/index')) {
                    routePattern = '/' + baseRoute.substring(0, baseRoute.length - 6);
                  } else {
                    routePattern = '/' + baseRoute;
                  }

                  for (const locale of languages) {
                    // Match route translation (e.g. originalText === '/pricing')
                    const normalizedOrig = routePattern.startsWith('/') ? routePattern : '/' + routePattern;
                    const match = translations.find((t: any) => t.locale === locale && t.originalText === normalizedOrig);

                    let translatedPath = routePattern;
                    if (match && match.translatedText) {
                      translatedPath = match.translatedText;
                      if (!translatedPath.startsWith('/')) {
                        translatedPath = '/' + translatedPath;
                      }
                    }

                    // Avoid double slash
                    const prefix = `/${locale}`;
                    const suffix = translatedPath === '/' ? '' : translatedPath;
                    const pattern = prefix + suffix;

                    console.log(` [Axolot SDK] Dynamically injecting route: ${pattern} -> ${relative}`);
                    injectRoute({
                      pattern,
                      entrypoint: file
                    });
                  }
                }
              }
            }
          } catch (e: any) {
            console.log(' [Axolot Bridge] i18n route injection skipped:', e.message);
          }
        }

        // Register custom Vite plugin to inject the dev endpoints directly into Vite
        if (isDev) {
          updateConfig({
            vite: {
              plugins: [{
                name: 'axolot-vite-plugin',
                configureServer(server) {
                  console.log(' [Axolot Vite Plugin] configureServer triggered!');
                  viteServer = server;

                  // 1. ENDPOINT: /_axolot/fs/read
                  server.middlewares.use('/_axolot/fs/read', async (req, res) => {
                    if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
                    const authorized = await validateRequest(req, res, 'filesystem:read');
                    if (!authorized) return;
                    let body = ''; req.on('data', chunk => { body += chunk; });
                    req.on('end', async () => {
                      try {
                        const { filePath } = JSON.parse(body);
                        const absolutePath = path.resolve(process.cwd(), filePath);
                        if (!absolutePath.startsWith(process.cwd())) {
                          res.statusCode = 403;
                          return res.end(JSON.stringify({ error: 'Forbidden', message: 'Path traversal detected' }));
                        }
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
                        const absolutePath = path.resolve(process.cwd(), filePath);
                        if (!absolutePath.startsWith(process.cwd())) {
                          res.statusCode = 403;
                          return res.end(JSON.stringify({ error: 'Forbidden', message: 'Path traversal detected' }));
                        }
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
                      const relativeFiles = files.map(f => path.relative(process.cwd(), f).replace(/\\/g, '/'));
                      res.setHeader('Content-Type', 'application/json');
                      res.end(JSON.stringify({ files: relativeFiles }));
                    } catch (err: any) {
                      res.statusCode = 500; res.end(JSON.stringify({ error: err.message }));
                    }
                  });
                }
              }]
            }
          });
        }
      },

      'astro:server:start': ({ address }) => {
        console.log(' [Axolot Bridge] Hook astro:server:start triggered! Address:', address);
        
        if (tunnelStarted) return;
        tunnelStarted = true;

        const port = address.port;
        const pagesDir = path.join(process.cwd(), 'src', 'pages');
        const normPagesDir = pagesDir.replace(/\\/g, '/');

        //  AUTO-SYNC LOCAL PAGES TO PRODUCTION DB
        async function reportPages() {
          const siteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
          const apiToken = process.env.PUBLIC_AXOLOT_API_TOKEN || process.env.AXOLOT_API_TOKEN;
          const rawApiUrl = process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL;
          
          console.log(' [Axolot Bridge] reportPages resolved:', { siteId, apiToken: apiToken ? 'Present' : 'Missing', rawApiUrl });

          if (!siteId || !apiToken) {
            console.log(' [Axolot Bridge] Skipping page auto-sync: Site ID or API Token not found in process.env');
            return;
          }
          
          let baseUrl = (rawApiUrl || 'http://localhost:3001').trim();
          if (baseUrl.endsWith('/api/v1')) {
            baseUrl = baseUrl.slice(0, -7);
          } else if (baseUrl.endsWith('/api/v1/')) {
            baseUrl = baseUrl.slice(0, -8);
          }
          baseUrl = baseUrl.replace(/\/$/, '');
          const apiUrl = `${baseUrl}/api/v1`;
          
          try {
            const discoveredPages: { title: string, slug: string }[] = [];
            await scanPagesDir(pagesDir, discoveredPages);
            
            if (discoveredPages.length > 0) {
              const currentHash = JSON.stringify(discoveredPages);
              if (currentHash === lastReportedPagesHash) {
                return;
              }

              const res = await fetchWithTimeout(`${apiUrl}/sites/${siteId}/pages/report`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiToken}`
                },
                body: JSON.stringify({ pages: discoveredPages })
              });
              const data = await res.json() as any;
              console.log(' [Axolot Bridge] Pages auto-synced successfully:', data);
              if (data && data.success) {
                lastReportedPagesHash = currentHash;
              }
            }
          } catch (err: any) {
            console.error(' [Axolot Bridge] Error auto-syncing pages:', err.message);
          }
        }

        async function scanPagesDir(dir: string, discoveredPages: any[], baseRoute = '') {
          const exists = await fs.access(dir).then(() => true).catch(() => false);
          if (!exists) return;
          const items = await fs.readdir(dir, { withFileTypes: true });
          for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
              await scanPagesDir(fullPath, discoveredPages, `${baseRoute}/${item.name}`);
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

        //  START SECURE TUNNEL TO PRODUCTION
        async function startTunnel() {
          const siteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
          const apiToken = process.env.PUBLIC_AXOLOT_API_TOKEN || process.env.AXOLOT_API_TOKEN;
          const rawApiUrl = process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL;
          const tunnelHost = process.env.PUBLIC_AXOLOT_TUNNEL_HOST || process.env.AXOLOT_TUNNEL_HOST;

          console.log(' [Axolot Tunnel] startTunnel resolved variables:', { siteId, apiToken: apiToken ? 'Present' : 'Missing', rawApiUrl, tunnelHost });

          if (!siteId || !apiToken) {
            console.log(' [Axolot Tunnel] Skipping tunnel: Site ID or API Token not found in process.env');
            return;
          }

          if (!tunnelHost) {
            console.log(' [Axolot Tunnel] Skipping tunnel: AXOLOT_TUNNEL_HOST not configured.');
            return;
          }

          let baseUrl = (rawApiUrl || 'http://localhost:3001').trim();
          if (baseUrl.endsWith('/api/v1')) {
            baseUrl = baseUrl.slice(0, -7);
          } else if (baseUrl.endsWith('/api/v1/')) {
            baseUrl = baseUrl.slice(0, -8);
          }
          baseUrl = baseUrl.replace(/\/$/, '');
          const apiUrl = `${baseUrl}/api/v1`;

          // 1. Fetch site stagingDomain or slug to use as subdomain
          let subdomainPrefix = '';
          let fallbackSubdomain = '';
          try {
            const pkgJsonPath = path.join(process.cwd(), 'package.json');
            if (fsSync.existsSync(pkgJsonPath)) {
              const pkg = JSON.parse(fsSync.readFileSync(pkgJsonPath, 'utf-8'));
              if (pkg.name && pkg.name.startsWith('site-')) {
                fallbackSubdomain = pkg.name.substring(5);
              } else if (pkg.name) {
                fallbackSubdomain = pkg.name;
              }
            }
            if (!fallbackSubdomain) {
              fallbackSubdomain = path.basename(process.cwd());
            }
          } catch (e) {}

          try {
            const res = await fetchWithTimeout(`${apiUrl}/sites/${siteId}`, {
              headers: { 'Authorization': `Bearer ${apiToken}` }
            });
            if (res.ok) {
              const siteData = await res.json() as any;
              if (siteData.stagingDomain) {
                subdomainPrefix = siteData.stagingDomain.split('.')[0];
              } else {
                subdomainPrefix = siteData.slug || '';
              }
            } else {
              console.log(' [Axolot Tunnel] Site fetch responded with status:', res.status);
            }
          } catch (err: any) {
            console.log(' [Axolot Tunnel] Could not fetch site info:', err.message);
          }

          const chosenSubdomain = subdomainPrefix || fallbackSubdomain || undefined;
          console.log(' [Axolot Tunnel] Initializing tunnel with subdomain:', chosenSubdomain);

          // 2. Start WebSocket tunnel
          const stopTunnel = startAxolotTunnel({
            port,
            host: tunnelHost as string,
            subdomain: chosenSubdomain,
            onConnect: async (tunnelUrl: string) => {
              try {
                const patchRes = await fetchWithTimeout(`${apiUrl}/sites/${siteId}`, {
                  method: 'PATCH',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiToken}`
                  },
                  body: JSON.stringify({ stagingUrl: tunnelUrl })
                });
                if (patchRes.ok) {
                  console.log(' [Axolot Tunnel] Tunnel URL registered in database.');
                }
              } catch (e: any) {
                console.error(' [Axolot Tunnel] Failed to register tunnel URL:', e.message);
              }
            },
          });

          // 3. Cleanup on exit
          const cleanup = async () => {
            console.log(' [Axolot Tunnel] Disconnecting tunnel...');
            stopTunnel();
            try {
              await fetchWithTimeout(`${apiUrl}/sites/${siteId}`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiToken}`
                },
                body: JSON.stringify({ stagingUrl: null })
              });
            } catch (e) {}
          };

          process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
          process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
          
          if (viteServer) {
            viteServer.httpServer?.on('close', cleanup);
          }
        }

        async function generateLlmDocs() {
          const siteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
          const apiToken = process.env.PUBLIC_AXOLOT_API_TOKEN || process.env.AXOLOT_API_TOKEN;
          const rawApiUrl = process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL;

          if (!siteId || !apiToken) return;

          let baseUrl = (rawApiUrl || 'http://localhost:3001').trim();
          if (baseUrl.endsWith('/api/v1')) {
            baseUrl = baseUrl.slice(0, -7);
          } else if (baseUrl.endsWith('/api/v1/')) {
            baseUrl = baseUrl.slice(0, -8);
          }
          baseUrl = baseUrl.replace(/\/$/, '');
          const apiUrl = `${baseUrl}/api/v1`;

          try {
            const res = await fetchWithTimeout(`${apiUrl}/sites/${siteId}`, {
              headers: { 'Authorization': `Bearer ${apiToken}` }
            });
            if (res.ok) {
              const site = await res.json() as any;
              const modules = (site.activeModules || []).map((m: any) => m.module?.name || 'desconocido');
              const designTokensStr = JSON.stringify(site.designTokens || {}, null, 2);

              const docContent = `# Axolot CMS — Contexto de IA para el Sitio Local

Este archivo es autogenerado por el SDK de Axolot. Proporciona contexto en tiempo real para los asistentes de IA que trabajan en este proyecto.

## Información de este Sitio
- **Nombre**: ${site.name}
- **ID de Sitio**: ${site.id}
- **Plan de Suscripción**: ${site.plan || 'Free'}
- **Estado**: ${site.status}
- **Ruta de Trabajo Local**: ${site.localPath}

## Módulos Activos (${modules.length})
${modules.length > 0 ? modules.map((m: string) => `- \`${m}\``).join('\n') : 'Ninguno. (Puedes activar los módulos "blog", "shop", "bookings" o "seo" desde tu plan en el Dashboard de Axolot)'}

> [!NOTE]
> Reglas de Negocio de Módulos:
> - Plan Free: Módulos estándar únicamente (sin tienda ni reservas).
> - Plan Pro: Habilita el módulo de tienda ("shop") y el de reservas ("bookings").
> - Plan Enterprise: Habilita entornos de Staging y bases de datos personalizadas.

## Paleta de Colores y Tokens de Diseño (Design Tokens)
\`\`\`json
${designTokensStr}
\`\`\`
*Instrucción para la IA: Utiliza exclusivamente estos colores y valores tipográficos en los nuevos componentes para mantener la identidad visual del cliente.*

## Guía de Desarrollo del SDK
1. **Zonas Editables**: Para hacer que un título, párrafo, imagen o enlace sea editable por el usuario final, añade el atributo \`data-slot="seccion.campo"\`. Ejemplo:
   \`\`\`html
   <h1 data-slot="hero.title">Título</h1>
   \`\`\`
2. **Auto-Registro**: Cuando añadas un nuevo slot en tu código Astro, utiliza la herramienta MCP \`createSlot\` para registrar la clave (ej: \`hero.title\`) en la base de datos de Axolot.
3. **Carga de Imágenes**: Usa la función helper \`getMediaUrl(path)\` del SDK para resolver las rutas de las imágenes subidas al gestor de medios del CMS.
`;

              const docPath = path.join(process.cwd(), 'llms-axolot.txt');
              await fs.writeFile(docPath, docContent, 'utf-8');
              console.log(' [Axolot SDK] llms-axolot.txt context file generated successfully.');
            }
          } catch (err: any) {
            console.error(' [Axolot SDK] Failed to generate llms-axolot.txt:', err.message);
          }
        }

        async function autoRegisterSlots() {
          const siteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
          const apiToken = process.env.PUBLIC_AXOLOT_API_TOKEN || process.env.AXOLOT_API_TOKEN;
          const rawApiUrl = process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL;

          if (!siteId || !apiToken) return;

          let baseUrl = (rawApiUrl || 'http://localhost:3001').trim();
          if (baseUrl.endsWith('/api/v1')) {
            baseUrl = baseUrl.slice(0, -7);
          } else if (baseUrl.endsWith('/api/v1/')) {
            baseUrl = baseUrl.slice(0, -8);
          }
          baseUrl = baseUrl.replace(/\/$/, '');
          const apiUrl = `${baseUrl}/api/v1`;

          try {
            const pagesRes = await fetchWithTimeout(`${apiUrl}/sites/${siteId}/pages`, {
              headers: { 'Authorization': `Bearer ${apiToken}` }
            });
            if (!pagesRes.ok) return;
            const pages = await pagesRes.json() as any[];

            const srcDir = path.join(process.cwd(), 'src');
            const files = await getAstroFiles(srcDir);

            const slotsRes = await fetchWithTimeout(`${apiUrl}/sites/${siteId}/slots`, {
              headers: { 'Authorization': `Bearer ${apiToken}` }
            });
            const existingSlots = slotsRes.ok ? await slotsRes.json() as any[] : [];
            const existingKeys = new Set(existingSlots.map(s => s.key));

            for (const file of files) {
              const content = await fs.readFile(file, 'utf-8');
              const slotRegex = /data-slot=["']([^"']+)["']/g;
              let match;

              const relativePath = path.relative(srcDir, file).replace(/\\/g, '/');
              let pageId: string | undefined = undefined;
              if (relativePath.startsWith('pages/')) {
                const pagePart = relativePath.substring(6).replace(/\.astro$/, '');
                const pageSlug = pagePart === 'index' ? '/' : `/${pagePart}`;
                const page = pages.find(p => p.slug === pageSlug);
                pageId = page?.id;
              }

              while ((match = slotRegex.exec(content)) !== null) {
                const key = match[1];
                if (!key) continue;
                if (existingKeys.has(key)) continue;

                let type: 'text' | 'image' | 'link' | 'richtext' = 'text';
                const lowerKey = key.toLowerCase();
                if (lowerKey.includes('image') || lowerKey.includes('img') || lowerKey.includes('logo') || lowerKey.includes('banner')) {
                  type = 'image';
                } else if (lowerKey.includes('link') || lowerKey.includes('url') || lowerKey.includes('cta')) {
                  type = 'link';
                }

                const label = key
                  .split('.')
                  .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                  .join(' - ');

                try {
                  const regRes = await fetchWithTimeout(`${apiUrl}/sites/${siteId}/slots`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${apiToken}`
                    },
                    body: JSON.stringify({
                      pageId,
                      key,
                      label,
                      type,
                      value: '',
                      required: false
                    })
                  });

                  if (regRes.ok) {
                    console.log(` [Axolot Bridge] Auto-registered slot: "${key}" (${type})`);
                    existingKeys.add(key);
                  }
                } catch (e: any) {
                  console.error(` [Axolot Bridge] Error registering slot "${key}":`, e.message);
                }
              }
            }
          } catch (err: any) {
            console.error(' [Axolot Bridge] Error in slot auto-registration:', err.message);
          }
        }

        reportPages();
        startTunnel();
        generateLlmDocs();
        autoRegisterSlots();

        // Listen for additions or deletions of astro/md/mdx files in src/pages
        if (viteServer) {
          viteServer.watcher.on('add', (file: string) => {
            const normFile = file.replace(/\\/g, '/');
            if (normFile.includes(normPagesDir) && /\.(astro|md|mdx)$/.test(normFile)) {
              console.log(' [Axolot Bridge] Page added, syncing...', path.basename(file));
              reportPages();
            }
            if (/\.astro$/.test(normFile)) {
              autoRegisterSlots();
            }
          });

          viteServer.watcher.on('change', (file: string) => {
            const normFile = file.replace(/\\/g, '/');
            if (/\.astro$/.test(normFile)) {
              autoRegisterSlots();
            }
          });
          
          viteServer.watcher.on('unlink', (file: string) => {
            const normFile = file.replace(/\\/g, '/');
            if (normFile.includes(normPagesDir) && /\.(astro|md|mdx)$/.test(normFile)) {
              console.log(' [Axolot Bridge] Page removed, syncing...', path.basename(file));
              reportPages();
            }
          });
        }
      }
    }
  };
}

export * from './lib/cms.js';
