/**
 * PharmaScout — Netlify Function : EMA Proxy
 * Recherche les médicaments autorisés par l'EMA pour une substance donnée.
 * Retourne : nombre de produits EU, noms, statut, référencements PRAC.
 */

const https = require('https');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const substance = (event.queryStringParameters?.substance || '').trim().toLowerCase();
  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing substance parameter' }) };
  }

  try {
    // 1. Recherche EMA — page produits humains
    const searchUrl = `https://www.ema.europa.eu/en/medicines/field_ema_web_categories%253Aname_field/Human/search_api_fulltext/${encodeURIComponent(substance)}`;
    const html = await fetchUrl(searchUrl);

    // Extraction du nombre de résultats
    const countPatterns = [
      /(\d+)\s+results?\s+found/i,
      /Showing[\s\S]{0,30}of\s+(\d+)/i,
      /(\d+)\s+medicine/i,
      /"count"\s*:\s*(\d+)/
    ];
    let total = 0;
    for (const pattern of countPatterns) {
      const m = html.match(pattern);
      if (m) { total = parseInt(m[1]); break; }
    }

    // Extraction des noms de produits et statuts
    const products = [];
    // Pattern pour les titres de médicaments dans les résultats EMA
    const titlePattern = /<h3[^>]*class="[^"]*views-field[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = titlePattern.exec(html)) !== null && products.length < 8) {
      const name = m[2].replace(/<[^>]+>/g, '').trim();
      if (name && name.length > 2) {
        products.push({
          name,
          url: m[1].startsWith('/') ? 'https://www.ema.europa.eu' + m[1] : m[1]
        });
      }
    }

    // Fallback: chercher les titres dans un autre format
    if (products.length === 0) {
      const altPattern = /class="[^"]*field-content[^"]*"[^>]*>[\s\S]*?<a[^>]+>([\s\S]*?)<\/a>/g;
      while ((m = altPattern.exec(html)) !== null && products.length < 8) {
        const name = m[1].replace(/<[^>]+>/g, '').trim();
        if (name && name.toLowerCase().includes(substance.substring(0, 5))) {
          products.push({ name });
        }
      }
    }

    // 2. Recherche PRAC referrals actifs
    const referralUrl = `https://www.ema.europa.eu/en/medicines/human/referrals/${encodeURIComponent(substance.replace(/\s+/g, '-'))}`;
    let pracActive = false;
    let pracDetails = null;
    try {
      const pracHtml = await fetchUrl(referralUrl);
      if (pracHtml.includes('referral') && !pracHtml.includes('404') && !pracHtml.includes('Page not found')) {
        pracActive = true;
        const titleMatch = pracHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
        if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
      }
    } catch (_) { /* pas de referral trouvé */ }

    // 3. Vérifier dans la liste de référencements EMA
    const referralListUrl = 'https://www.ema.europa.eu/en/medicines/human/referrals';
    let referralMentions = 0;
    try {
      const listHtml = await fetchUrl(referralListUrl);
      // Compte les mentions de la substance dans la liste des referrals
      const subLower = substance.toLowerCase();
      const regex = new RegExp(subLower.substring(0, Math.min(8, subLower.length)), 'gi');
      const matches = listHtml.match(regex) || [];
      referralMentions = matches.length;
      if (referralMentions > 0 && !pracActive) pracActive = true;
    } catch (_) {}

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        substance,
        totalEUProducts: total,
        products: products.slice(0, 6),
        pracActive,
        pracDetails,
        referralMentions,
        searchUrl
      })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: e.message, substance })
    };
  }
};

function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/1.0)',
        'Accept': 'text/html,application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, (res) => {
      // Suivre les redirections
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}
