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
        // Función recursiva nativa para buscar archivos .astro
        async function getAstroFiles(dir: string): Promise<string[]> {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const files = await Promise.all(entries.map((res) => {
            const resPath = path.resolve(dir, res.name);
            return res.isDirectory() ? getAstroFiles(resPath) : (res.name.endsWith('.astro') ? resPath : null);
          }));
          return files.flat().filter(Boolean) as string[];
        }

        // 1. ENDPOINT: /_axolot/fs/read
        server.middlewares.use('/_axolot/fs/read', async (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
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
