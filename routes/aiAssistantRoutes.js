const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
    handleAIAssistantMessage,
    getSalesRepsCount,
    getStoresWithoutSalesReps,
    getTopBrandsTurnover,
    getExpiringProducts,
    getDemandForecast
} = require('../controllers/aiAssistantController');

// Все эндпоинты требуют аутентификации
router.use(authenticateToken);

// Эндпоинт для отправки сообщения ИИ-помощнику
router.post('/message', handleAIAssistantMessage);

// Готовые вопросы
router.get('/questions/sales-reps-count', getSalesRepsCount);
router.get('/questions/stores-without-sales-reps', getStoresWithoutSalesReps);
router.get('/questions/top-brands-turnover', getTopBrandsTurnover);
router.get('/questions/expiring-products', getExpiringProducts);

// Прогноз спроса (AI)
router.get('/demand-forecast', getDemandForecast);

module.exports = router;
