const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const router = express.Router();

// SSRF protection — block private/loopback ranges
const BLOCKED_HOSTS = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|0\.0\.0\.0)/i;

// Browser-like headers that most CDNs and retailers will accept
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'identity', // don't ask for gzip — easier to pipe raw
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site',
};

/**
 * GET /api/proxy/image?url=<encoded-image-url>
 *
 * Fetches an image from the upstream URL using browser-like headers,
 * then streams it back to the iOS client with a 24 h cache header.
 * Includes basic SSRF protection.
 */
router.get('/image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  // Validate URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  }

  if (BLOCKED_HOSTS.test(parsed.hostname)) {
    return res.status(403).json({ error: 'Blocked host' });
  }

  // Set Referer to the image's own domain so most anti-hotlink checks pass
  const referer = `${parsed.protocol}//${parsed.hostname}/`;
  const headers = { ...BROWSER_HEADERS, Referer: referer };

  const lib = parsed.protocol === 'https:' ? https : http;
  const port = parsed.port
    ? parseInt(parsed.port)
    : parsed.protocol === 'https:'
    ? 443
    : 80;

  const options = {
    hostname: parsed.hostname,
    port,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers,
    timeout: 12000,
  };

  const doFetch = (fetchUrl, redirectsLeft) => {
    return new Promise((resolve, reject) => {
      const parsedFetch = new URL(fetchUrl);
      const fetchLib = parsedFetch.protocol === 'https:' ? https : http;
      const fetchPort = parsedFetch.port
        ? parseInt(parsedFetch.port)
        : parsedFetch.protocol === 'https:'
        ? 443
        : 80;

      const fetchOptions = {
        hostname: parsedFetch.hostname,
        port: fetchPort,
        path: parsedFetch.pathname + parsedFetch.search,
        method: 'GET',
        headers: { ...BROWSER_HEADERS, Referer: `${parsedFetch.protocol}//${parsedFetch.hostname}/` },
        timeout: 12000,
      };

      const proxyReq = fetchLib.request(fetchOptions, (proxyRes) => {
        const { statusCode, headers: resHeaders } = proxyRes;

        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(statusCode) && resHeaders.location) {
          proxyRes.resume(); // drain
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(resHeaders.location, fetchUrl).toString();
          doFetch(next, redirectsLeft - 1).then(resolve).catch(reject);
          return;
        }

        if (statusCode !== 200) {
          proxyRes.resume();
          return reject(new Error(`Upstream returned ${statusCode}`));
        }

        const contentType = resHeaders['content-type'] || 'image/jpeg';
        if (!contentType.startsWith('image/')) {
          proxyRes.resume();
          return reject(new Error('Response is not an image'));
        }

        // Stream back to client
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 h
        if (resHeaders['content-length']) {
          res.setHeader('Content-Length', resHeaders['content-length']);
        }

        proxyRes.pipe(res);
        proxyRes.on('end', resolve);
        proxyRes.on('error', reject);
      });

      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('Request timed out'));
      });
      proxyReq.end();
    });
  };

  try {
    await doFetch(url, 4);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to fetch image', detail: err.message });
    }
  }
});

module.exports = router;
