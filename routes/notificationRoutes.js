const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification
} = require('../controllers/notificationController');

// Все эндпоинты требуют аутентификации
router.use(authenticateToken);

// Получение всех уведомлений пользователя
router.get('/', getNotifications);

// Получение количества непрочитанных уведомлений
router.get('/unread-count', getUnreadCount);

// Отметить уведомление как прочитанное
router.put('/:notificationId/read', markAsRead);

// Отметить все уведомления как прочитанные
router.put('/read-all', markAllAsRead);

// Удалить уведомление
router.delete('/:notificationId', deleteNotification);

module.exports = router;
