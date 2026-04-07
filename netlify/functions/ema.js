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

    // 2. Recherche PRAC — plusieurs stratégies
    let pracActive = false;
    let pracDetails = null;
    let pracUrl = null;
    let referralMentions = 0;

    const subShort = substance.substring(0, Math.min(5, substance.length));
    const referralSlug = substance.replace(/\s+/g, '-');

    // Stratégie A : referral formel avec slug exact (ex: ibuprofen, valproate)
    if (!pracActive) {
      try {
        const url = `https://www.ema.europa.eu/en/medicines/human/referrals/${encodeURIComponent(referralSlug)}`;
        const { html: pracHtml, finalUrl } = await fetchUrlWithFinalUrl(url);
        if (!pracHtml.includes('Page not found') && !pracHtml.includes('404') &&
            pracHtml.toLowerCase().includes(subShort)) {
          pracActive = true;
          const titleMatch = pracHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          pracUrl = finalUrl || url;
        }
      } catch (_) {}
    }

    // Stratégie B : signal avec slug exact (ex: isotretinoin)
    if (!pracActive) {
      try {
        const url = `https://www.ema.europa.eu/en/medicines/human/signals/${encodeURIComponent(referralSlug)}`;
        const { html: sigHtml, finalUrl } = await fetchUrlWithFinalUrl(url);
        if (!sigHtml.includes('Page not found') && !sigHtml.includes('404') &&
            sigHtml.toLowerCase().includes(subShort)) {
          pracActive = true;
          const titleMatch = sigHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          pracUrl = finalUrl || url;
        }
      } catch (_) {}
    }

    // Stratégie C : recherche EMA referrals par substance (suit les redirections)
    // Fonctionne même pour les slugs composés (ex: finasteride-dutasteride-containing-medicinal-products)
    if (!pracActive) {
      try {
        const searchReferralUrl = `https://www.ema.europa.eu/en/medicines/human/referrals?search_api_fulltext=${encodeURIComponent(substance)}`;
        const { html: refHtml, finalUrl } = await fetchUrlWithFinalUrl(searchReferralUrl);
        // Si la recherche a redirigé vers une page de referral spécifique
        const isRedirectedToReferral = finalUrl && finalUrl.includes('/referrals/') && !finalUrl.endsWith('/referrals');
        const isValidPage = !refHtml.includes('Page not found') && refHtml.toLowerCase().includes(subShort);
        if (isValidPage && (isRedirectedToReferral || refHtml.toLowerCase().includes('prac') || refHtml.toLowerCase().includes('referral'))) {
          pracActive = true;
          const titleMatch = refHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          // Utiliser la vraie URL du referral (après redirection)
          if (isRedirectedToReferral) {
            pracUrl = finalUrl;
          } else {
            // Chercher un lien vers un referral dans la page
            const linkRegex = new RegExp(`href="(/en/medicines/human/referrals/[^"]+)"`, 'i');
            const linkMatch = refHtml.match(linkRegex);
            if (linkMatch) pracUrl = 'https://www.ema.europa.eu' + linkMatch[1];
          }
        }
      } catch (_) {}
    }

    // Stratégie D : recherche EMA signals par substance (suit les redirections)
    if (!pracActive) {
      try {
        const searchSignalUrl = `https://www.ema.europa.eu/en/medicines/human/signals?search_api_fulltext=${encodeURIComponent(substance)}`;
        const { html: sigHtml, finalUrl } = await fetchUrlWithFinalUrl(searchSignalUrl);
        const isRedirectedToSignal = finalUrl && finalUrl.includes('/signals/') && !finalUrl.endsWith('/signals');
        const isValidPage = !sigHtml.includes('Page not found') && sigHtml.toLowerCase().includes(subShort);
        if (isValidPage && (isRedirectedToSignal || sigHtml.toLowerCase().includes('prac') || sigHtml.toLowerCase().includes('signal'))) {
          pracActive = true;
          const titleMatch = sigHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          if (isRedirectedToSignal) {
            pracUrl = finalUrl;
          } else {
            const linkRegex = new RegExp(`href="(/en/medicines/human/signals/[^"]+)"`, 'i');
            const linkMatch = sigHtml.match(linkRegex);
            if (linkMatch) pracUrl = 'https://www.ema.europa.eu' + linkMatch[1];
          }
        }
      } catch (_) {}
    }

    // Stratégie E : recherche full-text EMA (substance + PRAC/referral)
    if (!pracActive) {
      try {
        const ftsUrl = `https://www.ema.europa.eu/en/search?search_api_fulltext=${encodeURIComponent(substance + ' referral')}`;
        const ftsHtml = await fetchUrl(ftsUrl);
        const hasPRAC = /prac|signal|referral|pharmacovigilance/i.test(ftsHtml);
        const hasSubstance = new RegExp(subShort, 'i').test(ftsHtml);
        if (hasPRAC && hasSubstance) {
          const signalLinkMatch = ftsHtml.match(/href="(\/en\/medicines\/human\/(?:signals|referrals)\/[^"]+)"/i);
          if (signalLinkMatch) {
            pracActive = true;
            pracUrl = 'https://www.ema.europa.eu' + signalLinkMatch[1];
            try {
              const sigPageHtml = await fetchUrl(pracUrl);
              const titleMatch = sigPageHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
              if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        substance,
        totalEUProducts: total,
        products: products.slice(0, 6),
        pracActive,
        pracDetails,
        pracUrl,
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

// Fetch avec suivi de l'URL finale après redirections
function fetchUrlWithFinalUrl(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/1.0)',
        'Accept': 'text/html,application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://www.ema.europa.eu' + res.headers.location;
        fetchUrlWithFinalUrl(redirectUrl, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, finalUrl: url }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Fetch simple (rétrocompatible)
function fetchUrl(url, timeout = 12000) {
  return fetchUrlWithFinalUrl(url, timeout).then(r => r.html);
}
