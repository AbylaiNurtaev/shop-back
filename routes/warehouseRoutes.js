const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authenticateToken, requireStoreOwner, requireStoreSeller } = require('../middleware/auth');
const {
  // Функции для владельца магазина
  getWarehouseInventory,
  addStock,
  removeStock,
  updateStock,
  getWarehouseAnalytics,
  processInvoice,
  // Функции для продавца магазина (QR-сканер)
  findProductByBarcode,
  quickAddStockByBarcode
} = require('../controllers/warehouseController');

// Настройка multer для загрузки файлов
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

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

// Обработка накладной с помощью ИИ
// Принимаем файл с любым именем поля (file, invoice, image и т.д.)
router.post('/invoice/process', requireStoreOwner, upload.any(), processInvoice);

// ========== МАРШРУТЫ ДЛЯ ПРОДАВЦА МАГАЗИНА (QR-СКАНЕР) ==========
// Только быстрый приход товара по штрих-коду

// Поиск товара по штрих-коду
router.get('/barcode/:barcode', requireStoreSeller, findProductByBarcode);

// Быстрый приход товара по штрих-коду
router.post('/barcode/quick-add', requireStoreSeller, quickAddStockByBarcode);

module.exports = router;
