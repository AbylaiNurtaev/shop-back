const { models } = require('../models/database');
const { generateId } = require('./uuid');

const { DistributorActivityHistory } = models;

/**
 * Логирует действие дистрибьютора
 * @param {string} distributorId - ID дистрибьютора
 * @param {string} actionType - Тип действия (например, 'UPDATE_NAME', 'ADD_STORE')
 * @param {string} description - Описание действия
 * @param {Object} metadata - Дополнительные данные (опционально)
 */
async function logDistributorActivity(distributorId, actionType, description, metadata = {}) {
  try {
    if (!distributorId || !actionType || !description) {
      console.warn('Попытка логирования с неполными данными:', { distributorId, actionType, description });
      return;
    }

    // Ищем существующую запись истории для дистрибьютора
    let history = await DistributorActivityHistory.findOne({ distributorId }).lean();

    if (!history) {
      // Создаем новую запись истории
      history = await DistributorActivityHistory.create({
        id: generateId(),
        distributorId,
        actions: []
      });
    } else {
      // Обновляем существующую запись
      await DistributorActivityHistory.updateOne(
        { distributorId },
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
    await DistributorActivityHistory.updateOne(
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
    console.error('Ошибка при логировании действия дистрибьютора:', error);
  }
}

module.exports = {
  logDistributorActivity
};
