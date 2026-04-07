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

    // Helper : extraire toute URL de referral/signal de la page (HTTP ou JS redirect)
    function extractPracUrlFromHtml(pageHtml) {
      // Canonical URL
      const canonical = pageHtml.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
        || pageHtml.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
      if (canonical && (canonical[1].includes('/referrals/') || canonical[1].includes('/signals/'))) {
        return canonical[1].startsWith('http') ? canonical[1] : 'https://www.ema.europa.eu' + canonical[1];
      }
      // og:url
      const ogUrl = pageHtml.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
        || pageHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
      if (ogUrl && (ogUrl[1].includes('/referrals/') || ogUrl[1].includes('/signals/'))) {
        return ogUrl[1].startsWith('http') ? ogUrl[1] : 'https://www.ema.europa.eu' + ogUrl[1];
      }
      // Meta refresh
      const metaRefresh = pageHtml.match(/<meta[^>]+http-equiv=["'refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i)
      if (metaRefresh && (metaRefresh[1].includes('/referrals/') || metaRefresh[1].includes('/signals/'))) {
        return metaRefresh[1].startsWith('http') ? metaRefresh[1] : 'https://www.ema.europa.eu' + metaRefresh[1];
      }
      // JS window.location redirect
      const jsRedirect = pageHtml.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+(?:referrals|signals)[^"']+)["']/i)
      if (jsRedirect) {
        return jsRedirect[1].startsWith('http') ? jsRedirect[1] : 'https://www.ema.europa.eu' + jsRedirect[1];
      }
      // Lien direct vers referral/signal dans la page
      const directLink = pageHtml.match(/href=["']((?:https:\/\/www\.ema\.europa\.eu)?\/en\/medicines\/human\/(?:referrals|signals)\/[^"']+)["']/i);
      if (directLink) {
        return directLink[1].startsWith('http') ? directLink[1] : 'https://www.ema.europa.eu' + directLink[1];
      }
      return null;
    }

    // Stratégie A : referral formel avec slug exact
    if (!pracActive) {
      try {
        const url = `https://www.ema.europa.eu/en/medicines/human/referrals/${encodeURIComponent(referralSlug)}`;
        const { html: pracHtml, finalUrl } = await fetchUrlWithFinalUrl(url);
        if (!pracHtml.toLowerCase().includes('not found') && pracHtml.toLowerCase().includes(subShort)) {
          pracActive = true;
          const titleMatch = pracHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          pracUrl = finalUrl || url;
        }
      } catch (_) {}
    }

    // Stratégie B : signal avec slug exact
    if (!pracActive) {
      try {
        const url = `https://www.ema.europa.eu/en/medicines/human/signals/${encodeURIComponent(referralSlug)}`;
        const { html: sigHtml, finalUrl } = await fetchUrlWithFinalUrl(url);
        if (!sigHtml.toLowerCase().includes('not found') && sigHtml.toLowerCase().includes(subShort)) {
          pracActive = true;
          const titleMatch = sigHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          pracUrl = finalUrl || url;
        }
      } catch (_) {}
    }

    // Stratégie C : recherche EMA referrals (gère HTTP et JS redirects, slugs composés)
    if (!pracActive) {
      try {
        const searchReferralUrl = `https://www.ema.europa.eu/en/medicines/human/referrals?search_api_fulltext=${encodeURIComponent(substance)}`;
        const { html: refHtml, finalUrl } = await fetchUrlWithFinalUrl(searchReferralUrl);
        // Vérifier si on a bien du contenu pertinent
        const hasSubstance = refHtml.toLowerCase().includes(subShort);
        const notFound = refHtml.toLowerCase().includes('not found');
        if (!notFound && hasSubstance) {
          // Extraire l'URL du referral depuis le HTML (HTTP redirect, JS redirect, canonical, lien direct...)
          const foundUrl = extractPracUrlFromHtml(refHtml);
          // Ou vérifier si finalUrl est déjà une page referral
          const isRedirectedPage = finalUrl && finalUrl.includes('/referrals/') && !finalUrl.endsWith('/referrals');
          if (foundUrl || isRedirectedPage) {
            pracActive = true;
            pracUrl = foundUrl || finalUrl;
            const titleMatch = refHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
            if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            // Si le titre est vide (page de résultats, pas la page referral), fetcher la page referral
            if ((!pracDetails || pracDetails.length < 5) && pracUrl) {
              try {
                const refPage = await fetchUrl(pracUrl);
                const t = refPage.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
                if (t) pracDetails = t[1].replace(/<[^>]+>/g, '').trim();
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }

    // Stratégie D : recherche EMA signals (gère HTTP et JS redirects)
    if (!pracActive) {
      try {
        const searchSignalUrl = `https://www.ema.europa.eu/en/medicines/human/signals?search_api_fulltext=${encodeURIComponent(substance)}`;
        const { html: sigHtml, finalUrl } = await fetchUrlWithFinalUrl(searchSignalUrl);
        const hasSubstance = sigHtml.toLowerCase().includes(subShort);
        const notFound = sigHtml.toLowerCase().includes('not found');
        if (!notFound && hasSubstance) {
          const foundUrl = extractPracUrlFromHtml(sigHtml);
          const isRedirectedPage = finalUrl && finalUrl.includes('/signals/') && !finalUrl.endsWith('/signals');
          if (foundUrl || isRedirectedPage) {
            pracActive = true;
            pracUrl = foundUrl || finalUrl;
            const titleMatch = sigHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
            if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            if ((!pracDetails || pracDetails.length < 5) && pracUrl) {
              try {
                const sigPage = await fetchUrl(pracUrl);
                const t = sigPage.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
                if (t) pracDetails = t[1].replace(/<[^>]+>/g, '').trim();
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }

    // Stratégie E : recherche full-text EMA (fallback général)
    if (!pracActive) {
      try {
        const ftsUrl = `https://www.ema.europa.eu/en/search?search_api_fulltext=${encodeURIComponent(substance + ' referral')}`;
        const ftsHtml = await fetchUrl(ftsUrl);
        const hasSubstance = new RegExp(subShort, 'i').test(ftsHtml);
        if (hasSubstance) {
          const foundUrl = extractPracUrlFromHtml(ftsHtml);
          if (foundUrl) {
            pracActive = true;
            pracUrl = foundUrl;
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

function fetchUrl(url, timeout = 12000) {
  return fetchUrlWithFinalUrl(url, timeout).then(r => r.html);
}
