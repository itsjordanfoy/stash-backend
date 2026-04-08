const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');
const { logger } = require('../utils/logger');

// Lazy-init S3 client (only if AWS env vars are present)
let s3Client;
function getS3() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION || 'eu-west-2',
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined, // falls back to IAM role / env
    });
  }
  return s3Client;
}

const BUCKET = process.env.AWS_S3_BUCKET || 'product-tracker-screenshots';

/**
 * Upload a screenshot buffer to S3 and return the S3 key.
 */
async function uploadScreenshot(buffer, mimeType = 'image/png') {
  const key = `screenshots/${uuidv4()}.${mimeType.split('/')[1]}`;
  try {
    await getS3().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        ServerSideEncryption: 'AES256',
      })
    );
    return key;
  } catch (err) {
    logger.error('S3 upload failed', { error: err.message });
    throw err;
  }
}

/**
 * Generate a pre-signed URL for a given S3 key (60 min expiry).
 */
async function getPresignedUrl(key, expiresIn = 3600) {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return await getSignedUrl(getS3(), command, { expiresIn });
  } catch (err) {
    logger.error('Presigned URL generation failed', { key, error: err.message });
    return null;
  }
}

/**
 * Download an image from a URL and return its buffer + content-type.
 * Follows up to 4 redirects and sends browser-like headers.
 */
function downloadImage(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: `${parsed.protocol}//${parsed.hostname}/`,
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(res.headers.location, url).toString();
          return downloadImage(next, redirectsLeft - 1).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const contentType = res.headers['content-type'] || 'image/jpeg';
        if (!contentType.startsWith('image/')) {
          res.resume();
          return reject(new Error('Not an image'));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

/**
 * Download an image from a URL and upload it to S3.
 * Returns the public S3 URL, or null if anything fails.
 */
async function uploadImageFromUrl(sourceUrl) {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_S3_BUCKET) return null;
  try {
    // Normalise protocol-relative URLs (//cdn.shopify.com/...) to https
    if (sourceUrl.startsWith('//')) sourceUrl = 'https:' + sourceUrl;
    const { buffer, contentType } = await downloadImage(sourceUrl);
    const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg';
    const key = `products/${uuidv4()}.${ext}`;
    await getS3().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000',
      })
    );
    const region = process.env.AWS_REGION || 'eu-west-2';
    return `https://${BUCKET}.s3.${region}.amazonaws.com/${key}`;
  } catch (err) {
    logger.warn('S3 image upload failed', { sourceUrl, error: err.message });
    return null;
  }
}

/**
 * Upload all images for a product to S3 in parallel.
 * Returns { imageUrl, images } with S3 URLs replacing originals where successful.
 * Falls back to the original URL for any image that fails to upload.
 */
async function uploadProductImages(imageUrl, images = []) {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_S3_BUCKET) {
    return { imageUrl, images };
  }

  // Deduplicate
  const allUrls = [...new Set([imageUrl, ...images].filter(Boolean))];

  // Upload all in parallel (cap at 12)
  const results = await Promise.all(
    allUrls.slice(0, 12).map(url => uploadImageFromUrl(url).then(s3Url => s3Url || url))
  );

  const urlMap = Object.fromEntries(allUrls.map((u, i) => [u, results[i]]));
  const newImageUrl = imageUrl ? urlMap[imageUrl] : null;
  const newImages = images.map(u => urlMap[u] || u);

  logger.info('Product images uploaded to S3', {
    total: allUrls.length,
    succeeded: results.filter((r, i) => r !== allUrls[i]).length,
  });

  return { imageUrl: newImageUrl, images: newImages };
}

module.exports = { uploadScreenshot, getPresignedUrl, uploadProductImages };
