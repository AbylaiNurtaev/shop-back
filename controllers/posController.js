const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const mongoose = require('mongoose');

const { Sale, Offer, Product, Store, User } = models;

// Получение storeId для продавца магазина
async function getStoreIdForStoreSeller(user) {
  if (!user || !user.userId) {
    return null;
  }

  const userDoc = await User.findOne({ id: user.userId, role: 'STORE_SELLER' }).lean();
  return userDoc ? userDoc.storeId : null;
}

// Создание нового чека (продажи)
async function createSale(req, res) {
  try {
    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const sale = await Sale.create({
      id: generateId(),
      storeId,
      sellerId: req.user.userId,
      status: 'DRAFT',
      items: [],
      totalAmount: 0,
      currency: 'RUB'
    });

    res.status(201).json({
      sale: sale.toObject(),
      message: 'Чек создан'
    });
  } catch (error) {
    console.error('Ошибка при создании чека:', error);
    res.status(500).json({ error: 'Ошибка при создании чека' });
  }
}

// Получение текущего чернового чека или создание нового
async function getCurrentSale(req, res) {
  try {
    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    // Ищем незавершенный чек для этого продавца
    let sale = await Sale.findOne({
      storeId,
      sellerId: req.user.userId,
      status: 'DRAFT'
    }).sort({ createdAt: -1 }).lean();

    // Если нет чернового чека, создаем новый
    if (!sale) {
      const newSale = await Sale.create({
        id: generateId(),
        storeId,
        sellerId: req.user.userId,
        status: 'DRAFT',
        items: [],
        totalAmount: 0,
        currency: 'RUB'
      });
      sale = newSale.toObject();
    }

    res.json({ sale });
  } catch (error) {
    console.error('Ошибка при получении текущего чека:', error);
    res.status(500).json({ error: 'Ошибка при получении текущего чека' });
  }
}

// Добавление товара в чек по артикулу (SKU)
async function addItemToSale(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { saleId, sku, quantity } = req.body;

    if (!saleId || !sku || !quantity || quantity <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Отсутствуют обязательные поля или неверное количество' });
    }

    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    // Получаем чек
    const sale = await Sale.findOne({
      id: saleId,
      storeId,
      sellerId: req.user.userId,
      status: 'DRAFT'
    }).session(session);

    if (!sale) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Чек не найден или уже завершен' });
    }

    // Ищем товар по SKU
    const product = await Product.findOne({ sku }).lean();
    if (!product) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Товар с таким артикулом не найден' });
    }

    // Получаем оффер (цену товара в магазине)
    const offer = await Offer.findOne({ productId: product.id, storeId }).lean();
    if (!offer) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Товар не найден в магазине' });
    }

    // Проверяем наличие товара на складе
    if (offer.quantity < quantity) {
      await session.abortTransaction();
      return res.status(400).json({
        error: 'Недостаточно товара на складе',
        available: offer.quantity,
        requested: quantity
      });
    }

    // Проверяем, есть ли уже этот товар в чеке
    const existingItemIndex = sale.items.findIndex(
      item => item.productId === product.id
    );

    const itemPrice = offer.price;
    const itemTotalPrice = itemPrice * quantity;

    if (existingItemIndex >= 0) {
      // Обновляем существующую позицию
      const existingItem = sale.items[existingItemIndex];
      const newQuantity = existingItem.quantity + quantity;
      const newTotalPrice = itemPrice * newQuantity;

      // Проверяем наличие товара с учетом уже добавленного количества
      if (offer.quantity < newQuantity) {
        await session.abortTransaction();
        return res.status(400).json({
          error: 'Недостаточно товара на складе',
          available: offer.quantity,
          requested: newQuantity,
          alreadyInCart: existingItem.quantity
        });
      }

      sale.items[existingItemIndex].quantity = newQuantity;
      sale.items[existingItemIndex].totalPrice = newTotalPrice;
    } else {
      // Добавляем новую позицию
      sale.items.push({
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        quantity,
        price: itemPrice,
        totalPrice: itemTotalPrice,
        currency: offer.currency
      });
    }

    // Пересчитываем общую сумму
    sale.totalAmount = sale.items.reduce((sum, item) => sum + item.totalPrice, 0);
    sale.currency = offer.currency;

    await sale.save({ session });
    await session.commitTransaction();

    res.json({
      message: 'Товар добавлен в чек',
      sale: sale.toObject()
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Ошибка при добавлении товара в чек:', error);
    res.status(500).json({ error: 'Ошибка при добавлении товара в чек' });
  } finally {
    session.endSession();
  }
}

// Удаление товара из чека
async function removeItemFromSale(req, res) {
  try {
    const { saleId, productId } = req.body;

    if (!saleId || !productId) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }

    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const sale = await Sale.findOne({
      id: saleId,
      storeId,
      sellerId: req.user.userId,
      status: 'DRAFT'
    });

    if (!sale) {
      return res.status(404).json({ error: 'Чек не найден или уже завершен' });
    }

    // Удаляем позицию из чека
    sale.items = sale.items.filter(item => item.productId !== productId);

    // Пересчитываем общую сумму
    sale.totalAmount = sale.items.reduce((sum, item) => sum + item.totalPrice, 0);

    await sale.save();

    res.json({
      message: 'Товар удален из чека',
      sale: sale.toObject()
    });
  } catch (error) {
    console.error('Ошибка при удалении товара из чека:', error);
    res.status(500).json({ error: 'Ошибка при удалении товара из чека' });
  }
}

// Обновление количества товара в чеке
async function updateItemQuantity(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { saleId, productId, quantity } = req.body;

    if (!saleId || !productId || quantity === undefined || quantity < 0) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Отсутствуют обязательные поля или неверное количество' });
    }

    if (quantity === 0) {
      // Если количество 0, удаляем позицию
      await session.abortTransaction();
      session.endSession();
      
      // Вызываем удаление без транзакции
      const storeId = await getStoreIdForStoreSeller(req.user);
      if (!storeId) {
        return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
      }

      const sale = await Sale.findOne({
        id: saleId,
        storeId,
        sellerId: req.user.userId,
        status: 'DRAFT'
      });

      if (!sale) {
        return res.status(404).json({ error: 'Чек не найден или уже завершен' });
      }

      sale.items = sale.items.filter(item => item.productId !== productId);
      sale.totalAmount = sale.items.reduce((sum, item) => sum + item.totalPrice, 0);
      await sale.save();

      return res.json({
        message: 'Товар удален из чека',
        sale: sale.toObject()
      });
    }

    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const sale = await Sale.findOne({
      id: saleId,
      storeId,
      sellerId: req.user.userId,
      status: 'DRAFT'
    }).session(session);

    if (!sale) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Чек не найден или уже завершен' });
    }

    const itemIndex = sale.items.findIndex(item => item.productId === productId);
    if (itemIndex === -1) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Товар не найден в чеке' });
    }

    // Проверяем наличие товара на складе
    const offer = await Offer.findOne({ productId, storeId }).lean();
    if (!offer) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Товар не найден в магазине' });
    }

    if (offer.quantity < quantity) {
      await session.abortTransaction();
      return res.status(400).json({
        error: 'Недостаточно товара на складе',
        available: offer.quantity,
        requested: quantity
      });
    }

    // Обновляем количество и пересчитываем сумму позиции
    const item = sale.items[itemIndex];
    item.quantity = quantity;
    item.totalPrice = item.price * quantity;

    // Пересчитываем общую сумму
    sale.totalAmount = sale.items.reduce((sum, item) => sum + item.totalPrice, 0);

    await sale.save({ session });
    await session.commitTransaction();

    res.json({
      message: 'Количество товара обновлено',
      sale: sale.toObject()
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Ошибка при обновлении количества товара:', error);
    res.status(500).json({ error: 'Ошибка при обновлении количества товара' });
  } finally {
    session.endSession();
  }
}

// Завершение продажи (пробитие чека) - списание товаров со склада
async function completeSale(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { saleId } = req.body;

    if (!saleId) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'ID чека не указан' });
    }

    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    // Получаем чек
    const sale = await Sale.findOne({
      id: saleId,
      storeId,
      sellerId: req.user.userId,
      status: 'DRAFT'
    }).session(session);

    if (!sale) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Чек не найден или уже завершен' });
    }

    if (!sale.items || sale.items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Чек пуст. Добавьте товары перед завершением продажи' });
    }

    // Проверяем наличие всех товаров на складе и списываем их
    for (const item of sale.items) {
      const offer = await Offer.findOne({ productId: item.productId, storeId }).session(session);
      
      if (!offer) {
        await session.abortTransaction();
        return res.status(404).json({
          error: `Товар ${item.productName} не найден в магазине`
        });
      }

      if (offer.quantity < item.quantity) {
        await session.abortTransaction();
        return res.status(400).json({
          error: `Недостаточно товара ${item.productName} на складе`,
          available: offer.quantity,
          requested: item.quantity
        });
      }

      // Списываем товар со склада
      offer.quantity -= item.quantity;
      await offer.save({ session });
    }

    // Завершаем продажу
    sale.status = 'COMPLETED';
    sale.completedAt = new Date();
    await sale.save({ session });

    await session.commitTransaction();

    res.json({
      message: 'Продажа завершена, товары списаны со склада',
      sale: sale.toObject()
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Ошибка при завершении продажи:', error);
    res.status(500).json({ error: 'Ошибка при завершении продажи' });
  } finally {
    session.endSession();
  }
}

// Отмена чека
async function cancelSale(req, res) {
  try {
    const { saleId } = req.body;

    if (!saleId) {
      return res.status(400).json({ error: 'ID чека не указан' });
    }

    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const sale = await Sale.findOne({
      id: saleId,
      storeId,
      sellerId: req.user.userId,
      status: 'DRAFT'
    });

    if (!sale) {
      return res.status(404).json({ error: 'Чек не найден или уже завершен' });
    }

    sale.status = 'CANCELLED';
    await sale.save();

    res.json({
      message: 'Чек отменен',
      sale: sale.toObject()
    });
  } catch (error) {
    console.error('Ошибка при отмене чека:', error);
    res.status(500).json({ error: 'Ошибка при отмене чека' });
  }
}

// Получение истории продаж
async function getSalesHistory(req, res) {
  try {
    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Фильтр по статусу (опционально)
    const status = req.query.status;
    const query = {
      storeId,
      sellerId: req.user.userId
    };
    if (status) {
      query.status = status;
    }

    const [sales, total] = await Promise.all([
      Sale.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Sale.countDocuments(query)
    ]);

    res.json({
      items: sales,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Ошибка при получении истории продаж:', error);
    res.status(500).json({ error: 'Ошибка при получении истории продаж' });
  }
}

// Получение статистики продаж (для аналитики)
async function getSalesStatistics(req, res) {
  try {
    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const startDate = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // По умолчанию 30 дней
    const endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();

    const sales = await Sale.find({
      storeId,
      sellerId: req.user.userId,
      status: 'COMPLETED',
      completedAt: { $gte: startDate, $lte: endDate }
    }).lean();

    // Подсчет статистики
    const totalSales = sales.length;
    const totalRevenue = sales.reduce((sum, sale) => sum + (sale.totalAmount || 0), 0);
    const averageSale = totalSales > 0 ? totalRevenue / totalSales : 0;

    // Топ товаров
    const productStats = {};
    sales.forEach(sale => {
      if (sale.items) {
        sale.items.forEach(item => {
          if (!productStats[item.productId]) {
            productStats[item.productId] = {
              productId: item.productId,
              productName: item.productName,
              sku: item.sku,
              totalQuantity: 0,
              totalRevenue: 0
            };
          }
          productStats[item.productId].totalQuantity += item.quantity;
          productStats[item.productId].totalRevenue += item.totalPrice;
        });
      }
    });

    const topProducts = Object.values(productStats)
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 10);

    res.json({
      period: {
        startDate,
        endDate
      },
      summary: {
        totalSales,
        totalRevenue,
        averageSale: Math.round(averageSale * 100) / 100
      },
      topProducts
    });
  } catch (error) {
    console.error('Ошибка при получении статистики продаж:', error);
    res.status(500).json({ error: 'Ошибка при получении статистики продаж' });
  }
}

module.exports = {
  createSale,
  getCurrentSale,
  addItemToSale,
  removeItemFromSale,
  updateItemQuantity,
  completeSale,
  cancelSale,
  getSalesHistory,
  getSalesStatistics
};
