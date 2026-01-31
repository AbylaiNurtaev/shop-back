const { models } = require('../models/database');
const { generateId } = require('../utils/uuid');

const { Notification, User } = models;

// Получение всех уведомлений пользователя
async function getNotifications(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const { isRead, limit = 50, offset = 0 } = req.query;
    
    // Формируем запрос
    const query = { userId };
    if (isRead !== undefined) {
      query.isRead = isRead === 'true';
    }

    // Получаем уведомления
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    // Получаем общее количество
    const total = await Notification.countDocuments(query);

    res.json({
      items: notifications,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Ошибка при получении уведомлений:', error);
    res.status(500).json({ error: 'Ошибка при получении уведомлений' });
  }
}

// Получение количества непрочитанных уведомлений
async function getUnreadCount(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const count = await Notification.countDocuments({
      userId,
      isRead: false
    });

    res.json({ count });
  } catch (error) {
    console.error('Ошибка при получении количества непрочитанных уведомлений:', error);
    res.status(500).json({ error: 'Ошибка при получении количества непрочитанных уведомлений' });
  }
}

// Отметить уведомление как прочитанное
async function markAsRead(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const { notificationId } = req.params;

    const notification = await Notification.findOne({ id: notificationId }).lean();
    if (!notification) {
      return res.status(404).json({ error: 'Уведомление не найдено' });
    }

    if (notification.userId !== userId) {
      return res.status(403).json({ error: 'Нет доступа к этому уведомлению' });
    }

    await Notification.updateOne(
      { id: notificationId },
      { isRead: true, updatedAt: new Date() }
    );

    res.json({ message: 'Уведомление отмечено как прочитанное' });
  } catch (error) {
    console.error('Ошибка при отметке уведомления как прочитанного:', error);
    res.status(500).json({ error: 'Ошибка при отметке уведомления как прочитанного' });
  }
}

// Отметить все уведомления как прочитанные
async function markAllAsRead(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    await Notification.updateMany(
      { userId, isRead: false },
      { isRead: true, updatedAt: new Date() }
    );

    res.json({ message: 'Все уведомления отмечены как прочитанные' });
  } catch (error) {
    console.error('Ошибка при отметке всех уведомлений как прочитанных:', error);
    res.status(500).json({ error: 'Ошибка при отметке всех уведомлений как прочитанных' });
  }
}

// Удалить уведомление
async function deleteNotification(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const { notificationId } = req.params;

    const notification = await Notification.findOne({ id: notificationId }).lean();
    if (!notification) {
      return res.status(404).json({ error: 'Уведомление не найдено' });
    }

    if (notification.userId !== userId) {
      return res.status(403).json({ error: 'Нет доступа к этому уведомлению' });
    }

    await Notification.deleteOne({ id: notificationId });

    res.json({ message: 'Уведомление удалено' });
  } catch (error) {
    console.error('Ошибка при удалении уведомления:', error);
    res.status(500).json({ error: 'Ошибка при удалении уведомления' });
  }
}

// Функция для создания уведомления (используется в других контроллерах)
async function createNotification({ userId, type, title, message, metadata = {} }) {
  try {
    const notification = await Notification.create({
      id: generateId(),
      userId,
      type,
      title,
      message,
      isRead: false,
      metadata
    });
    return notification;
  } catch (error) {
    console.error('Ошибка при создании уведомления:', error);
    return null;
  }
}

// Функция для создания уведомлений для всех пользователей бренда
async function createNotificationForBrandUsers({ brandId, type, title, message, metadata = {} }) {
  try {
    const { models } = require('../models/database');
    const { Brand } = models;

    // Находим бренд по ID, чтобы получить email
    const brand = await Brand.findOne({ id: brandId }).lean();
    if (!brand || !brand.email) {
      console.error('Бренд не найден или у него нет email');
      return [];
    }

    // Находим всех пользователей бренда по email
    const brandUsers = await User.find({
      role: 'BRAND',
      email: brand.email,
      isActive: true
    }).lean();

    // Создаем уведомления для каждого пользователя
    const notifications = [];
    for (const user of brandUsers) {
      const notification = await createNotification({
        userId: user.id,
        type,
        title,
        message,
        metadata
      });
      if (notification) {
        notifications.push(notification);
      }
    }

    return notifications;
  } catch (error) {
    console.error('Ошибка при создании уведомлений для пользователей бренда:', error);
    return [];
  }
}

// Функция для создания уведомлений для всех пользователей дистрибьютора
async function createNotificationForDistributorUsers({ distributorId, type, title, message, metadata = {} }) {
  try {
    const { models } = require('../models/database');
    const { Distributor } = models;

    // Находим дистрибьютора по ID, чтобы получить email
    const distributor = await Distributor.findOne({ id: distributorId }).lean();
    if (!distributor || !distributor.email) {
      console.error('Дистрибьютор не найден или у него нет email');
      return [];
    }

    // Находим всех пользователей дистрибьютора по email
    const distributorUsers = await User.find({
      role: 'DISTRIBUTOR',
      email: distributor.email,
      isActive: true
    }).lean();

    // Создаем уведомления для каждого пользователя
    const notifications = [];
    for (const user of distributorUsers) {
      const notification = await createNotification({
        userId: user.id,
        type,
        title,
        message,
        metadata
      });
      if (notification) {
        notifications.push(notification);
      }
    }

    return notifications;
  } catch (error) {
    console.error('Ошибка при создании уведомлений для пользователей дистрибьютора:', error);
    return [];
  }
}

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  createNotification,
  createNotificationForBrandUsers,
  createNotificationForDistributorUsers
};
