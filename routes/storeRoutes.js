const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createStore,
  getStoreById,
  getStores,
  updateStore,
  deleteStore
} = require('../controllers/storeController');

router.post('/', createStore);

router.use(authenticateToken);
router.get('/', getStores);
router.get('/:storeId', getStoreById);
router.put('/:storeId', updateStore);
router.delete('/:storeId', deleteStore);

module.exports = router;
