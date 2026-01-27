const { models } = require('../models/database');
const { generateId } = require('./uuid');

const { StoreActivityHistory } = models;

/**
 * Логирует действие владельца магазина
 * @param {string} storeId - ID магазина
 * @param {string} storeOwnerId - ID владельца магазина (userId)
 * @param {string} actionType - Тип действия (например, 'ADD_STOCK', 'REMOVE_STOCK', 'UPDATE_PRICE', 'UPDATE_QUANTITY', 'CONFIRM_INVOICE')
 * @param {string} description - Описание действия
 * @param {Object} metadata - Дополнительные данные (опционально)
 */
async function logStoreActivity(storeId, storeOwnerId, actionType, description, metadata = {}) {
  try {
    if (!storeId || !storeOwnerId || !actionType || !description) {
      console.warn('Попытка логирования с неполными данными:', { storeId, storeOwnerId, actionType, description });
      return;
    }

    // Ищем существующую запись истории для магазина
    let history = await StoreActivityHistory.findOne({ storeId }).lean();

    if (!history) {
      // Создаем новую запись истории
      history = await StoreActivityHistory.create({
        id: generateId(),
        storeId,
        storeOwnerId,
        actions: []
      });
    } else {
      // Обновляем существующую запись
      await StoreActivityHistory.updateOne(
        { storeId },
        {
          $push: {
            actions: {
              actionType,
              description,
              metadata,
              timestamp: new Date()
            }
          },
          updatedAt: new Date()
        }
      );
      return;
    }

    // Если создали новую запись, добавляем действие
    await StoreActivityHistory.updateOne(
      { id: history.id },
      {
        $push: {
          actions: {
            actionType,
            description,
            metadata,
            timestamp: new Date()
          }
        },
        updatedAt: new Date()
      }
    );
  } catch (error) {
    // Не прерываем выполнение основной логики при ошибке логирования
    console.error('Ошибка при логировании действия владельца магазина:', error);
  }
}

module.exports = {
  logStoreActivity
};
