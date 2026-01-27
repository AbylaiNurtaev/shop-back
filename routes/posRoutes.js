const express = require('express');
const router = express.Router();
const { authenticateToken, requireStoreSeller } = require('../middleware/auth');
const {
  getStoreSellerAccount,
  updateStoreSellerAccount,
  createSale,
  getCurrentSale,
  addItemToSale,
  removeItemFromSale,
  updateItemQuantity,
  completeSale,
  cancelSale,
  getSalesHistory,
  getSalesStatistics
} = require('../controllers/posController');

// Все маршруты требуют авторизации и роль продавца магазина
router.use(authenticateToken);
router.use(requireStoreSeller);

// Настройки аккаунта продавца магазина (кассира)
router.get('/account', getStoreSellerAccount);
router.put('/account', updateStoreSellerAccount);

// Создание нового чека
router.post('/sale', createSale);

// Получение текущего чернового чека
router.get('/sale/current', getCurrentSale);

// Добавление товара в чек по артикулу
router.post('/sale/item', addItemToSale);

// Удаление товара из чека
router.delete('/sale/item', removeItemFromSale);

// Обновление количества товара в чеке
router.put('/sale/item', updateItemQuantity);

// Завершение продажи (пробитие чека)
router.post('/sale/complete', completeSale);

// Отмена чека
router.post('/sale/cancel', cancelSale);

// История продаж
router.get('/sales', getSalesHistory);

// Статистика продаж
router.get('/sales/statistics', getSalesStatistics);

module.exports = router;
