const sharp = require('sharp');

/**
 * Сжимает изображение с сохранением качества
 * @param {Buffer} buffer - Буфер изображения
 * @param {string} mimeType - MIME тип изображения
 * @param {Object} options - Опции сжатия
 * @param {number} options.maxWidth - Максимальная ширина (по умолчанию 1920)
 * @param {number} options.maxHeight - Максимальная высота (по умолчанию 1920)
 * @param {number} options.quality - Качество JPEG (по умолчанию 85)
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function compressImage(buffer, mimeType, options = {}) {
  const {
    maxWidth = 1920,
    maxHeight = 1920,
    quality = 85
  } = options;

  // Определяем формат выходного изображения
  let outputFormat = 'jpeg';
  if (mimeType === 'image/png') {
    outputFormat = 'png';
  } else if (mimeType === 'image/webp') {
    outputFormat = 'webp';
  }

  try {
    let sharpInstance = sharp(buffer);

    // Получаем метаданные для проверки размеров
    const metadata = await sharpInstance.metadata();
    const { width, height } = metadata;

    // Если изображение меньше максимальных размеров, просто конвертируем формат
    if (width <= maxWidth && height <= maxHeight) {
      const compressedBuffer = await sharpInstance
        .toFormat(outputFormat, {
          quality: outputFormat === 'jpeg' ? quality : undefined,
          compressionLevel: outputFormat === 'png' ? 9 : undefined
        })
        .toBuffer();

      return {
        buffer: compressedBuffer,
        mimeType: outputFormat === 'jpeg' ? 'image/jpeg' : 
                  outputFormat === 'png' ? 'image/png' : 
                  'image/webp'
      };
    }

    // Если изображение больше - ресайзим и сжимаем
    const compressedBuffer = await sharpInstance
      .resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .toFormat(outputFormat, {
        quality: outputFormat === 'jpeg' ? quality : undefined,
        compressionLevel: outputFormat === 'png' ? 9 : undefined
      })
      .toBuffer();

    return {
      buffer: compressedBuffer,
      mimeType: outputFormat === 'jpeg' ? 'image/jpeg' : 
                outputFormat === 'png' ? 'image/png' : 
                'image/webp'
    };
  } catch (error) {
    console.error('Ошибка при сжатии изображения:', error);
    // В случае ошибки возвращаем оригинальный буфер
    return {
      buffer,
      mimeType
    };
  }
}

module.exports = {
  compressImage
};
