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

    // 2. Recherche PRAC — plusieurs stratégies en parallèle
    let pracActive = false;
    let pracDetails = null;
    let pracUrl = null;

    // Stratégie A : referral formel dédié (ex: ibuprofen, valproate)
    const referralSlug = substance.replace(/\s+/g, '-');
    const referralUrl = `https://www.ema.europa.eu/en/medicines/human/referrals/${encodeURIComponent(referralSlug)}`;
    try {
      const pracHtml = await fetchUrl(referralUrl);
      if (!pracHtml.includes('Page not found') && !pracHtml.includes('404') &&
          pracHtml.includes(substance.substring(0, 5))) {
        pracActive = true;
        const titleMatch = pracHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
        if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
        pracUrl = referralUrl;
      }
    } catch (_) {}

    // Stratégie B : signaux de sécurité PRAC (ex: finasteride, isotretinoin)
    // La section "signals" couvre les évaluations de signaux de pharmacovigilance
    if (!pracActive) {
      try {
        const signalsUrl = `https://www.ema.europa.eu/en/medicines/human/signals/${encodeURIComponent(referralSlug)}`;
        const sigHtml = await fetchUrl(signalsUrl);
        if (!sigHtml.includes('Page not found') && !sigHtml.includes('404') &&
            sigHtml.toLowerCase().includes(substance.substring(0, 5))) {
          pracActive = true;
          const titleMatch = sigHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
          if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          pracUrl = signalsUrl;
        }
      } catch (_) {}
    }

    // Stratégie C : recherche full-text EMA pour PRAC + substance
    // Couvre les cas où la page n'est pas indexée par nom exact
    if (!pracActive) {
      try {
        const ftsUrl = `https://www.ema.europa.eu/en/search?search_api_fulltext=${encodeURIComponent(substance + ' PRAC')}`;
        const ftsHtml = await fetchUrl(ftsUrl);
        const subLower = substance.toLowerCase();
        const subShort = subLower.substring(0, Math.min(6, subLower.length));
        // Chercher des résultats de type signal/PRAC dans les résultats de recherche
        const hasPRAC = /prac|signal|referral|pharmacovigilance/i.test(ftsHtml);
        const hasSubstance = new RegExp(subShort, 'i').test(ftsHtml);
        if (hasPRAC && hasSubstance) {
          // Vérifier qu'il y a bien un lien vers un signal/referral spécifique
          const signalLinkMatch = ftsHtml.match(/href="(\/en\/medicines\/human\/(?:signals|referrals)\/[^"]+)"/i);
          if (signalLinkMatch) {
            pracActive = true;
            pracUrl = 'https://www.ema.europa.eu' + signalLinkMatch[1];
            // Essayer de récupérer le titre de la page du signal
            try {
              const sigPageHtml = await fetchUrl(pracUrl);
              const titleMatch = sigPageHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
              if (titleMatch) pracDetails = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // Stratégie D : liste des signaux EMA (page principale signals)
    let referralMentions = 0;
    if (!pracActive) {
      try {
        const signalsListUrl = `https://www.ema.europa.eu/en/medicines/human/signals`;
        const listHtml = await fetchUrl(signalsListUrl);
        const subShort = substance.substring(0, Math.min(8, substance.length));
        const regex = new RegExp(subShort, 'gi');
        const matches = listHtml.match(regex) || [];
        referralMentions = matches.length;
        if (referralMentions > 0) {
          pracActive = true;
          // Tenter de trouver le lien vers le signal dans la liste
          const linkRegex = new RegExp(`href="(/en/medicines/human/signals/[^"]*${subShort.substring(0,4)}[^"]*)"`, 'i');
          const linkMatch = listHtml.match(linkRegex);
          if (linkMatch) pracUrl = 'https://www.ema.europa.eu' + linkMatch[1];
        }
      } catch (_) {}
    }

    // Stratégie E : liste des referrals EMA (page principale referrals)
    if (!pracActive) {
      try {
        const referralListUrl = 'https://www.ema.europa.eu/en/medicines/human/referrals';
        const listHtml = await fetchUrl(referralListUrl);
        const subShort = substance.substring(0, Math.min(8, substance.length));
        const regex = new RegExp(subShort, 'gi');
        const matches = listHtml.match(regex) || [];
        if (matches.length > 0) {
          referralMentions += matches.length;
          pracActive = true;
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

function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/1.0)',
        'Accept': 'text/html,application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, (res) => {
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
