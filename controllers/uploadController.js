const { uploadImage, checkS3Access } = require('../utils/s3');

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

async function uploadPhoto(req, res) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Файл не передан' });
    }

    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return res.status(400).json({ error: 'Недопустимый тип файла' });
    }

    const { url, key } = await uploadImage({
      buffer: file.buffer,
      contentType: file.mimetype,
      folder: 'photos'
    });

    res.status(201).json({ url, key });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при загрузке фото' });
  }
}

async function checkS3(req, res) {
  try {
    await checkS3Access();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка доступа к S3', details: error.message });
  }
}

module.exports = { uploadPhoto, checkS3 };

