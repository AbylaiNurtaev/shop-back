const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createBrand,
  getBrandById,
  getBrands,
  getPendingBrands,
  approveBrand,
  rejectBrand,
  updateBrand,
  deleteBrand,
  getMyBrand,
  getMyBrandSettings,
  updateMyBrandSettings,
  getBrandSearchStatistics,
  validateProductImageForBrand
} = require('../controllers/brandController');
const { getBrandProducts } = require('../controllers/productController');

// Настройка multer для загрузки изображений
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Создание бренда - без авторизации (публичный эндпоинт для регистрации)
router.post('/', createBrand);

// Публичный эндпоинт для просмотра товаров бренда (для дистрибьюторов)
router.get('/:brandId/products', getBrandProducts);

// Все остальные роуты требуют авторизации
router.use(authenticateToken);

// Эндпоинты для брендов (настройки)
router.get('/me', getMyBrand);
router.get('/me/settings', getMyBrandSettings);
router.put('/me/settings', updateMyBrandSettings);
router.get('/me/search-statistics', getBrandSearchStatistics);

// Валидация изображения товара
router.post('/products/validate-image', upload.single('image'), validateProductImageForBrand);

// Список всех брендов (для админ-панели)
router.get('/', getBrands);

// Список заявок брендов, ещё не одобренных
router.get('/pending', getPendingBrands);

// Одобрить/отклонить бренд (для админ-панели)
router.post('/:brandId/approve', approveBrand);
router.post('/:brandId/reject', rejectBrand);

router.get('/:brandId', getBrandById);
router.put('/:brandId', updateBrand);
router.delete('/:brandId', deleteBrand);

module.exports = router;
