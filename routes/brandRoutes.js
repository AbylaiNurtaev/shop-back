const express = require('express');
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
  deleteBrand
} = require('../controllers/brandController');
const { getBrandProducts } = require('../controllers/productController');

// Создание бренда - без авторизации (публичный эндпоинт для регистрации)
router.post('/', createBrand);

// Публичный эндпоинт для просмотра товаров бренда (для дистрибьюторов)
router.get('/:brandId/products', getBrandProducts);

// Все остальные роуты требуют авторизации
router.use(authenticateToken);

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
