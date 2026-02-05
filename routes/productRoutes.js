const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createProduct,
  getProductById,
  getProducts,
  getBrandProducts,
  updateProduct,
  deleteProduct,
  searchProducts,
  generateUniqueSku,
  payProduct,
  payMultipleProducts
} = require('../controllers/productController');

router.use(authenticateToken);

router.post('/', createProduct);
router.post('/search', searchProducts);

// Оплата товаров (активация на 30 дней после оплаты на фронтенде)
router.post('/:productId/pay', payProduct); // Оплата одного товара
router.post('/pay/multiple', payMultipleProducts); // Оплата нескольких товаров

router.get('/', getProducts);
router.get('/sku', generateUniqueSku);
router.get('/brand/:brandId', getBrandProducts);
router.get('/:productId', getProductById);
router.put('/:productId', updateProduct);
router.delete('/:productId', deleteProduct);

module.exports = router;
