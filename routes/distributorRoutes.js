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
  updateMyDistributorName,
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
  removeDistributorStore,
  getSalesRepresentativeProducts,
  addProductToSalesRepresentative,
  addProductsToSalesRepresentative,
  removeProductFromSalesRepresentative,
  getDistributorProducts,
  setProductCostPrice,
  getProductCostPrice,
  deleteProductCostPrice,
  getDistributorAnalyticsSummary,
  getDistributorStockByStores,
  getDistributorTurnover,
  getDistributorSalesRepKPI,
  getSalesRepresentativeProductSales,
  getDistributorActivityHistory,
  getDistributorPoorlySellingProducts,
  getDistributorProductSalesByStores
} = require('../controllers/distributorController');

router.post('/', createDistributor);

// Публичный эндпоинт для получения списка дистрибьюторов (для брендов)
router.get('/', getDistributors);

router.use(authenticateToken);

// Эндпоинты для дистрибьюторов
router.get('/me', getMyDistributor);
router.put('/me/name', updateMyDistributorName);
router.get('/me/sales-representatives', getSalesRepresentatives);
router.get('/me/stores', getDistributorStores);
router.get('/me/products', getDistributorProducts);
// Эндпоинты управления себестоимостью товаров
router.put('/me/products/:productId/cost-price', setProductCostPrice);
router.get('/me/products/:productId/cost-price', getProductCostPrice);
router.delete('/me/products/:productId/cost-price', deleteProductCostPrice);

// Эндпоинты аналитики
router.get('/me/analytics/summary', getDistributorAnalyticsSummary);
router.get('/me/analytics/stock-by-stores', getDistributorStockByStores);
router.get('/me/analytics/turnover', getDistributorTurnover);
router.get('/me/analytics/sales-rep-kpi', getDistributorSalesRepKPI);
router.get('/sales-representatives/:salesRepresentativeId/products/:productId/sales-by-stores', getSalesRepresentativeProductSales);

// Эндпоинты для плохих продаж и продаж по магазинам
router.get('/me/poorly-selling-products', getDistributorPoorlySellingProducts);
router.get('/me/products/:productId/sales-by-stores', getDistributorProductSalesByStores);

// Эндпоинт истории действий
router.get('/me/activity-history', getDistributorActivityHistory);
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
router.get('/sales-representatives/:salesRepresentativeId/products', getSalesRepresentativeProducts);
router.post('/sales-representatives/:salesRepresentativeId/products', addProductToSalesRepresentative);
router.post('/sales-representatives/:salesRepresentativeId/products/batch', addProductsToSalesRepresentative);
router.delete('/sales-representatives/:salesRepresentativeId/products/:productId', removeProductFromSalesRepresentative);
router.post('/stores', addDistributorStore);
router.delete('/stores/:storeId', removeDistributorStore);

// Эндпоинты для брендов (отправка запроса на подключение)
router.post('/:distributorId/request', sendConnectionRequest);

// Общие эндпоинты
router.get('/:distributorId', getDistributorById);
router.put('/:distributorId', updateDistributor);
router.delete('/:distributorId', deleteDistributor);

module.exports = router;

