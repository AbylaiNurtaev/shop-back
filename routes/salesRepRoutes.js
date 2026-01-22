const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getMySalesRepresentativeStores } = require('../controllers/distributorController');
const {
  getMyProductGroups,
  getMyStockControl,
  getMyAiAnalytics
} = require('../controllers/salesRepController');

router.use(authenticateToken);
router.get('/stores', getMySalesRepresentativeStores);
router.get('/product-groups', getMyProductGroups);
router.get('/stock-control', getMyStockControl);
router.get('/ai-analytics', getMyAiAnalytics);

module.exports = router;

