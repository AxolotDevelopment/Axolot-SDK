import { fetchFromCms } from './lib/cms.js';
import { tokenizeHtml, generateHash } from './lib/html-translator.js';

let cachedSettings: any = null;
let lastSettingsFetch = 0;

/**
 * Fetches translation settings from the CMS and caches them for 60 seconds.
 */
async function getTranslationSettings(siteId: string) {
  const now = Date.now();
  if (cachedSettings && now - lastSettingsFetch < 60000) {
    return cachedSettings;
  }
  
  const settings = await fetchFromCms(`/sites/${siteId}/translations/settings`);
  if (settings) {
    cachedSettings = settings;
    lastSettingsFetch = now;
  }
  return cachedSettings;
}

let cachedTranslations: any = null;
let lastTranslationsFetch = 0;

/**
 * Fetches translation entries and caches them for 60 seconds.
 */
async function getTranslations(siteId: string) {
  const now = Date.now();
  if (cachedTranslations && now - lastTranslationsFetch < 60000) {
    return cachedTranslations;
  }
  const list = await fetchFromCms(`/sites/${siteId}/translations/`);
  if (list) {
    cachedTranslations = list;
    lastTranslationsFetch = now;
  }
  return cachedTranslations || [];
}

/**
 * Astro middleware to intercept rendered HTML and apply dynamic translations on the fly.
 * Compatible with both SSR dev mode and static site generation build targets.
 */
export async function onRequest(context: any, next: any) {
  const response = await next();

  // 1. Only process HTML pages
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('text/html')) {
    return response;
  }

  // 2. Verify site configuration
  const siteId = process.env.PUBLIC_AXOLOT_SITE_ID || process.env.AXOLOT_SITE_ID;
  if (!siteId) {
    return response;
  }

  // 3. Load translation settings
  const settings = await getTranslationSettings(siteId);
  if (!settings) {
    return response;
  }

  // 4. Only process if context locale is resolved (or fallback from URL path)
  let locale = context.currentLocale;
  if (!locale) {
    try {
      const url = new URL(context.request.url);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0 && settings.languages.includes(parts[0])) {
        locale = parts[0];
      }
    } catch (e) {}
  }

  if (!locale) {
    return response;
  }

  // 5. Skip translation if requested locale matches default site language
  if (locale === settings.defaultLanguage) {
    return response;
  }

  const html = await response.text();

  // 6. Tokenize HTML document
  const tokens = tokenizeHtml(html);

  // 6.5. Rewrite links in <a> tags using route mappings
  const translationsList = await getTranslations(siteId);
  const routeMap: Record<string, string> = {};
  for (const item of translationsList) {
    if (item.locale === locale && item.originalText.startsWith('/')) {
      routeMap[item.originalText] = item.translatedText;
    }
  }

  for (const token of tokens) {
    if (token.type === 'tag' && /^<a\s/i.test(token.content)) {
      const match = token.content.match(/href=(["'])(.*?)\1/i);
      if (match) {
        const href = match[2];
        // Only rewrite relative links (starts with / but not // or assets/uploads/favicon)
        if (href && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/assets/') && !href.startsWith('/uploads/') && !href.startsWith('/favicon.')) {
          const urlParts = href.split(/[?#]/);
          const pathPart = urlParts[0] || '/';
          const restPart = href.substring(pathPart.length);

          const normalizedPath = pathPart.endsWith('/') && pathPart.length > 1 ? pathPart.slice(0, -1) : pathPart;

          // Check if it already has the locale prefix
          const prefixPattern = new RegExp(`^\\/${locale}(\\/|$)`);
          if (!prefixPattern.test(normalizedPath)) {
            let targetPath = normalizedPath;
            const mapped = routeMap[normalizedPath] || routeMap[normalizedPath + '/'];
            if (mapped) {
              targetPath = mapped;
            }

            if (!targetPath.startsWith('/')) {
              targetPath = '/' + targetPath;
            }

            const newHref = `/${locale}${targetPath === '/' ? '' : targetPath}${restPart}`;
            token.content = token.content.replace(/href=(["'])(.*?)\1/i, `href=$1${newHref}$1`);
          }
        }
      }
    }
  }

  const batch: { hash: string; text: string }[] = [];
  const textTokens: { token: any; text: string; hash: string }[] = [];

  // Extract translatable text strings, skipping whitespace-only nodes
  for (const token of tokens) {
    if (token.type === 'text') {
      const match = token.content.match(/^(\s*)(.*?)(\s*)$/s);
      if (match && match[2] && match[2].trim().length > 0) {
        const text = match[2];
        const hash = generateHash(text);
        batch.push({ hash, text });
        textTokens.push({ token, text, hash });
      }
    }
  }

  // Return processed HTML (with updated links) even if no translatable text was found
  if (batch.length === 0) {
    const translatedHtml = tokens.map((t) => t.content).join('');
    return new Response(translatedHtml, {
      status: response.status,
      headers: response.headers,
    });
  }

  // 7. Request translations from the backend API
  const translationsMap = await fetchFromCms(`/sites/${siteId}/translations/translate`, {
    method: 'POST',
    body: JSON.stringify({ texts: batch, locale }),
  });

  if (translationsMap) {
    // 8. Apply translations while strictly preserving original leading/trailing whitespaces
    for (const item of textTokens) {
      if (translationsMap[item.hash]) {
        const match = item.token.content.match(/^(\s*)(.*?)(\s*)$/s);
        if (match && match[1] !== undefined && match[3] !== undefined) {
          item.token.content = match[1] + translationsMap[item.hash] + match[3];
        }
      }
    }
  }

  // 9. Reassemble the translated HTML document
  const translatedHtml = tokens.map((t) => t.content).join('');

  return new Response(translatedHtml, {
    status: response.status,
    headers: response.headers,
  });
}
