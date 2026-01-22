const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');
const { uploadPhoto, checkS3 } = require('../controllers/uploadController');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Загрузка фото - публичный эндпоинт (для регистрации бренда)
router.post('/photo', upload.single('file'), uploadPhoto);

// Проверка S3 - требует авторизации
router.get('/check', authenticateToken, checkS3);

module.exports = router;

