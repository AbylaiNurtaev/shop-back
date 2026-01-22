const { models } = require('../models/database');

const { Product } = models;

/**
 * Проверяет и отключает товары с истекшей оплатой
 * Устанавливает isPayed = false для товаров, у которых paymentExpiresAt < текущей даты
 */
async function checkAndDisableExpiredPayments() {
  try {
    const now = new Date();
    const result = await Product.updateMany(
      {
        isPayed: true,
        paymentExpiresAt: { $lt: now }
      },
      {
        $set: {
          isPayed: false,
          updatedAt: now
        }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`Отключено ${result.modifiedCount} товаров с истекшей оплатой`);
    }

    return result.modifiedCount;
  } catch (error) {
    console.error('Ошибка при проверке истечения оплаты товаров:', error);
    return 0;
  }
}

module.exports = {
  checkAndDisableExpiredPayments
};
