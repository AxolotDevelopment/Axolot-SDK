/**
 *  Axolot CMS — Client Helpers
 */

export async function fetchFromCms(path: string, options: RequestInit = {}) {
  const isDev = typeof process !== 'undefined' ? process.env.NODE_ENV !== 'production' : import.meta.env?.DEV;
  const defaultUrl = isDev ? 'http://127.0.0.1:3001' : 'https://api.axolotcms.com';
  
  const API_URL = (typeof process !== 'undefined' ? (process.env.PUBLIC_AXOLOT_API_URL || process.env.AXOLOT_API_URL) : (import.meta.env?.PUBLIC_AXOLOT_API_URL || import.meta.env?.AXOLOT_API_URL)) || defaultUrl;
  const token = (typeof process !== 'undefined' ? process.env.AXOLOT_API_TOKEN : import.meta.env?.AXOLOT_API_TOKEN);

  // Normalize base URL to prevent duplicate /api/v1
  let baseUrl = API_URL.trim();
  if (baseUrl.endsWith('/api/v1')) {
    baseUrl = baseUrl.slice(0, -7);
  } else if (baseUrl.endsWith('/api/v1/')) {
    baseUrl = baseUrl.slice(0, -8);
  }
  baseUrl = baseUrl.replace(/\/$/, '');

  console.log(` [Axolot Debug] Fetching from: ${baseUrl}/api/v1${path}`);
  console.log(` [Axolot Debug] Token present: ${token ? 'YES (' + token.substring(0, 10) + '...)' : 'NO'}`);

  try {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      ...options,
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
    })

    if (!res.ok) {
      console.error(` [Axolot] CMS Fetch Error: ${res.status} ${res.statusText} on ${path}`)
      return null
    }

    const contentType = res.headers.get('content-type')
    if (contentType && !contentType.includes('application/json')) {
      const text = await res.text()
      console.error(` [Axolot] Expected JSON but received ${contentType}. Check if your API is returning an error page or Localtunnel protection is active.`)
      return null
    }

    return await res.json()
  } catch (err: any) {
    console.warn(` [Axolot Bridge] Connection failed to CMS API at ${baseUrl}/api/v1${path}:`, err.message);
    return null;
  }
}

export function getMediaUrl(path: string | null | undefined) {
  if (!path) return ''
  if (path.startsWith('http')) return path
  const API_URL = (typeof process !== 'undefined' ? process.env.AXOLOT_API_URL : import.meta.env?.AXOLOT_API_URL) || 'https://api.axolotcms.com';
  return `${API_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

export async function getTestimonials(siteId: string) {
  return await fetchFromCms(`/modules/${siteId}/testimonials`);
}

export async function getFaqs(siteId: string) {
  return await fetchFromCms(`/modules/${siteId}/faqs`);
}

export async function getCustomModuleRows(siteId: string, tableName: string) {
  return await fetchFromCms(`/modules/${siteId}/custom/${tableName}`);
}


