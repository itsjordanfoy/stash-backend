const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
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

module.exports = { uploadScreenshot, getPresignedUrl };
