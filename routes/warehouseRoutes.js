const express = require('express');
const router = express.Router();
const { authenticateToken, requireStoreOwner, requireStoreSeller } = require('../middleware/auth');
const {
  // Функции для владельца магазина
  getWarehouseInventory,
  addStock,
  removeStock,
  updateStock,
  getWarehouseAnalytics,
  // Функции для продавца магазина (QR-сканер)
  findProductByBarcode,
  quickAddStockByBarcode
} = require('../controllers/warehouseController');

// Все маршруты требуют авторизации
router.use(authenticateToken);

// ========== МАРШРУТЫ ДЛЯ ВЛАДЕЛЬЦА МАГАЗИНА ==========
// Полный доступ к складу: приход, уход, аналитика

// Получение всего инвентаря склада
router.get('/inventory', requireStoreOwner, getWarehouseInventory);

// Приход товара на склад
router.post('/stock/add', requireStoreOwner, addStock);

// Уход товара со склада
router.post('/stock/remove', requireStoreOwner, removeStock);

// Обновление количества товара
router.put('/stock/update', requireStoreOwner, updateStock);

// Аналитика склада
router.get('/analytics', requireStoreOwner, getWarehouseAnalytics);

// ========== МАРШРУТЫ ДЛЯ ПРОДАВЦА МАГАЗИНА (QR-СКАНЕР) ==========
// Только быстрый приход товара по штрих-коду

// Поиск товара по штрих-коду
router.get('/barcode/:barcode', requireStoreSeller, findProductByBarcode);

// Быстрый приход товара по штрих-коду
router.post('/barcode/quick-add', requireStoreSeller, quickAddStockByBarcode);

module.exports = router;
