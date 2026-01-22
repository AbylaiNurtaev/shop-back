const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { generateId } = require('./uuid');

const bucketName = process.env.AWS_BUCKET_NAME;
const region = process.env.AWS_S3_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY;
const secretAccessKey = process.env.AWS_SECRET_KEY;

if (!bucketName || !region || !accessKeyId || !secretAccessKey) {
  throw new Error('AWS переменные окружения не заданы полностью');
}

const s3Client = new S3Client({
  region,
  credentials: { accessKeyId, secretAccessKey }
});

function getPublicUrl(key) {
  return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
}

async function uploadImage({ buffer, contentType, folder = 'uploads' }) {
  const fileId = generateId();
  const extension = contentType.split('/')[1] || 'bin';
  const key = `${folder}/${fileId}.${extension}`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3Client.send(command);

  return {
    key,
    url: getPublicUrl(key)
  };
}

async function checkS3Access() {
  const command = new HeadBucketCommand({ Bucket: bucketName });
  await s3Client.send(command);
  return true;
}

module.exports = {
  uploadImage,
  checkS3Access
};

