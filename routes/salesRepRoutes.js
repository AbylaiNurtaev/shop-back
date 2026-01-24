const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getMySalesRepresentativeStores } = require('../controllers/distributorController');
const {
  getMyProductGroups,
  getMyStockControl,
  getMyAiAnalytics,
  getMySalesRepresentative,
  updateMySalesRepresentative,
  getMyProducts,
  getMySalesAnalytics,
  getExpiringProducts,
  getPoorlySellingProducts,
  getProductSalesByStores
} = require('../controllers/salesRepController');

router.use(authenticateToken);
router.get('/me', getMySalesRepresentative);
router.put('/me', updateMySalesRepresentative);
router.get('/stores', getMySalesRepresentativeStores);
router.get('/products', getMyProducts);
router.get('/product-groups', getMyProductGroups);
router.get('/stock-control', getMyStockControl);
router.get('/ai-analytics', getMyAiAnalytics);
router.get('/sales-analytics', getMySalesAnalytics);
router.get('/expiring-products', getExpiringProducts);
router.get('/poorly-selling-products', getPoorlySellingProducts);
router.get('/products/:productId/sales-by-stores', getProductSalesByStores);

module.exports = router;

