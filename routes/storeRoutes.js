const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createStore,
  getStoreById,
  getStores,
  updateStore,
  deleteStore,
  getMyStoreSettings,
  updateMyStoreSettings
} = require('../controllers/storeController');

router.post('/', createStore);

router.use(authenticateToken);

// Эндпоинты для настроек магазина (для владельцев магазинов)
router.get('/me/settings', getMyStoreSettings);
router.put('/me/settings', updateMyStoreSettings);

router.get('/', getStores);
router.get('/:storeId', getStoreById);
router.put('/:storeId', updateStore);
router.delete('/:storeId', deleteStore);

module.exports = router;
