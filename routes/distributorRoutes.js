const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createDistributor,
  getDistributorById,
  getDistributors,
  updateDistributor,
  deleteDistributor,
  getMyDistributor,
  sendConnectionRequest,
  getConnectionRequests,
  acceptConnectionRequest,
  rejectConnectionRequest,
  getSalesRepresentatives,
  addSalesRepresentative,
  removeSalesRepresentative,
  getSalesRepresentativeStores,
  addStoreToSalesRepresentative,
  addStoresToSalesRepresentative,
  removeStoreFromSalesRepresentative,
  getMySalesRepresentativeStores,
  getDistributorStores,
  addDistributorStore,
  removeDistributorStore
} = require('../controllers/distributorController');

router.post('/', createDistributor);

// Публичный эндпоинт для получения списка дистрибьюторов (для брендов)
router.get('/', getDistributors);

router.use(authenticateToken);

// Эндпоинты для дистрибьюторов
router.get('/me', getMyDistributor);
router.get('/me/sales-representatives', getSalesRepresentatives);
router.get('/me/stores', getDistributorStores);
router.get('/sales-representatives/me/stores', getMySalesRepresentativeStores);
router.get('/requests', getConnectionRequests);
router.post('/requests/:requestId/accept', acceptConnectionRequest);
router.post('/requests/:requestId/reject', rejectConnectionRequest);
router.post('/sales-representatives', addSalesRepresentative);
router.delete('/sales-representatives/:salesRepresentativeId', removeSalesRepresentative);
router.get('/sales-representatives/:salesRepresentativeId/stores', getSalesRepresentativeStores);
router.post('/sales-representatives/:salesRepresentativeId/stores', addStoreToSalesRepresentative);
router.post('/sales-representatives/:salesRepresentativeId/stores/batch', addStoresToSalesRepresentative);
router.delete('/sales-representatives/:salesRepresentativeId/stores/:storeId', removeStoreFromSalesRepresentative);
router.post('/stores', addDistributorStore);
router.delete('/stores/:storeId', removeDistributorStore);

// Эндпоинты для брендов (отправка запроса на подключение)
router.post('/:distributorId/request', sendConnectionRequest);

// Общие эндпоинты
router.get('/:distributorId', getDistributorById);
router.put('/:distributorId', updateDistributor);
router.delete('/:distributorId', deleteDistributor);

module.exports = router;

