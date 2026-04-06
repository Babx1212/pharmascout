/**
 * PharmaScout — Netlify Function : Swissmedic Proxy
 * Recherche les médicaments autorisés par Swissmedic pour une substance donnée.
 * Retourne : nombre d'AMM CH, titulaires, statut.
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
    // 1. Page de recherche Swissmedic — médicaments humains autorisés
    const searchUrl = `https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/authorisations/authorised-human-medicinal-products/search.html?query=${encodeURIComponent(substance)}`;
    const html = await fetchUrl(searchUrl);

    // Extraction du nombre de résultats CH
    let totalCH = 0;
    const countPatterns = [
      /(\d+)\s+results?/i,
      /(\d+)\s+Ergebnis/i,
      /(\d+)\s+r.sultat/i,
      /"total"\s*:\s*(\d+)/,
      /found\s+(\d+)/i
    ];
    for (const p of countPatterns) {
      const m = html.match(p);
      if (m) { totalCH = parseInt(m[1]); break; }
    }

    // Extraction des produits et titulaires
    const products = [];
    // Chercher les noms de produits dans les résultats
    const rowPattern = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const tdPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const rows = html.match(rowPattern) || [];

    for (const row of rows.slice(0, 20)) {
      const cells = [];
      let cellMatch;
      while ((cellMatch = tdPattern.exec(row)) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      tdPattern.lastIndex = 0;
      if (cells.length >= 2 && cells[0] && cells[0].length > 2) {
        const productName = cells[0];
        const holder = cells[1] || '';
        if (productName.toLowerCase().includes(substance.substring(0, 5)) ||
            (holder && !productName.match(/^\d+$/))) {
          products.push({ name: productName, holder: holder });
        }
      }
    }

    // Fallback: chercher les titres dans la page
    if (products.length === 0 && totalCH === 0) {
      const altPattern = /class="[^"]*result[^"]*"[^>]*>([\s\S]*?)(?=class="[^"]*result|<\/div>)/gi;
      let altMatch;
      while ((altMatch = altPattern.exec(html)) !== null && products.length < 10) {
        const text = altMatch[1].replace(/<[^>]+>/g, '').trim();
        if (text && text.length > 3) products.push({ name: text });
      }
      if (products.length > 0) totalCH = products.length;
    }

    // 2. Essai sur le portail AIPS (swissmedicinfo.ch) pour données complémentaires
    let aipsCount = 0;
    try {
      const aipsUrl = `https://www.swissmedicinfo.ch/?lang=EN`;
      const aipsSearchUrl = `https://www.swissmedicinfo.ch/ShowText.aspx?lang=EN&searchtype=wi&term=${encodeURIComponent(substance)}`;
      const aipsHtml = await fetchUrl(aipsSearchUrl);

      const aipsCountMatch = aipsHtml.match(/(\d+)\s+(?:result|Treffer|r\u00e9sultat)/i);
      if (aipsCountMatch) aipsCount = parseInt(aipsCountMatch[1]);

      // Si pas de résultat sur la page principale, compter les occurrences du nom
      if (aipsCount === 0) {
        const mentions = (aipsHtml.match(new RegExp(substance.substring(0, 6), 'gi')) || []).length;
        if (mentions > 2) aipsCount = Math.floor(mentions / 3);
      }
    } catch (_) {}

    // Utiliser le meilleur comptage disponible
    const finalCount = Math.max(totalCH, aipsCount);

    // 3. Alertes Swissmedic (pharmacovigilance)
    let pvAlert = false;
    let pvDetails = null;
    try {
      const pvUrl = `https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/market-surveillance/pharmacovigilance/vigilance-news.html`;
      const pvHtml = await fetchUrl(pvUrl);
      const subLower = substance.toLowerCase();
      if (pvHtml.toLowerCase().includes(subLower.substring(0, Math.min(8, subLower.length)))) {
        pvAlert = true;
        const linkPattern = new RegExp(`<a[^>]+href="([^"]+)"[^>]*>[^<]*${substance.substring(0, 6)}[^<]*<\/a>`, 'i');
        const linkMatch = pvHtml.match(linkPattern);
        if (linkMatch) pvDetails = 'https://www.swissmedic.ch' + linkMatch[1];
      }
    } catch (_) {}

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        substance,
        totalCHProducts: finalCount,
        products: products.slice(0, 8),
        pvAlert,
        pvDetails,
        searchUrl,
        aipsCount
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

function fetchUrl(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://www.swissmedic.ch' + res.headers.location;
        fetchUrl(redirectUrl, timeout).then(resolve).catch(reject);
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
