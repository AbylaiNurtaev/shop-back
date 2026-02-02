const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const mongoose = require('mongoose');

const { Sale, Offer, Product, Store, User, POSWeeklyReport } = models;

// -----------------------------------------------------------------------------
// АККАУНТ ПРОДАВЦА МАГАЗИНА
// -----------------------------------------------------------------------------

// Получение настроек аккаунта продавца магазина (кассира)
async function getStoreSellerAccount(req, res) {
  try {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const user = await User.findOne({ id: req.user.userId, role: 'STORE_SELLER' }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    let store = null;
    if (user.storeId) {
      store = await Store.findOne({ id: user.storeId }).lean();
    }

    return res.json({
      id: user.id,
      role: user.role,
      name: user.firstName || null,
      email: user.email,
      storeId: user.storeId || null,
      storeName: store ? store.name : null
    });
  } catch (error) {
    console.error('Ошибка при получении аккаунта продавца магазина:', error);
    return res.status(500).json({ error: 'Ошибка при получении аккаунта продавца магазина' });
  }
}

// Обновление настроек аккаунта продавца магазина (сейчас только имя)
async function updateStoreSellerAccount(req, res) {
  try {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Поле name обязательно' });
    }

    const updatedUser = await User.findOneAndUpdate(
      { id: req.user.userId, role: 'STORE_SELLER' },
      { firstName: name.trim(), updatedAt: new Date() },
      { new: true }
    ).lean();

    if (!updatedUser) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    return res.json({
      id: updatedUser.id,
      role: updatedUser.role,
      name: updatedUser.firstName || null,
      email: updatedUser.email,
      storeId: updatedUser.storeId || null
    });
  } catch (error) {
    console.error('Ошибка при обновлении аккаунта продавца магазина:', error);
    return res.status(500).json({ error: 'Ошибка при обновлении аккаунта продавца магазина' });
  }
}

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

// Вспомогательная функция для получения начала недели (понедельник)
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Понедельник
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Вспомогательная функция для получения конца недели (воскресенье)
function getWeekEnd(weekStart) {
  const sunday = new Date(weekStart);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return sunday;
}

// Вспомогательная функция для получения или создания недельного отчета
async function getOrCreateWeeklyReport(storeId, date, currency, session) {
  const weekStart = getWeekStart(date);
  const weekEnd = getWeekEnd(weekStart);

  let report = await POSWeeklyReport.findOne({
    storeId,
    weekStartDate: weekStart
  }).session(session);

  if (!report) {
    // Создаем новый недельный отчет с пустыми днями
    const days = [];
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + i);
      days.push({
        date: dayDate,
        cashAmount: 0,
        cardAmount: 0,
        hybridAmount: 0,
        totalAmount: 0,
        salesCount: 0,
        sales: []
      });
    }

    report = await POSWeeklyReport.create([{
      id: generateId(),
      storeId,
      weekStartDate: weekStart,
      weekEndDate: weekEnd,
      days,
      weeklyTotal: {
        cashAmount: 0,
        cardAmount: 0,
        hybridAmount: 0,
        totalAmount: 0,
        salesCount: 0
      },
      currency
    }], { session });

    report = report[0];
  }

  return report;
}

// Вспомогательная функция для обновления недельного отчета
async function updateWeeklyReport(storeId, sale, session) {
  const completedAt = sale.completedAt || new Date();
  const weekStart = getWeekStart(completedAt);
  const report = await getOrCreateWeeklyReport(storeId, completedAt, sale.currency, session);

  // Находим день недели (0 = понедельник, 6 = воскресенье)
  const dayOfWeek = completedAt.getDay();
  const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Воскресенье = 6, понедельник = 0

  if (!report.days[dayIndex]) {
    // Если дня нет, создаем его
    report.days[dayIndex] = {
      date: new Date(completedAt),
      cashAmount: 0,
      cardAmount: 0,
      hybridAmount: 0,
      totalAmount: 0,
      salesCount: 0,
      sales: []
    };
  }

  const dayData = report.days[dayIndex];

  // Обновляем данные дня
  dayData.salesCount += 1;
  dayData.totalAmount += sale.totalAmount;

  // Обновляем суммы по способам оплаты
  if (sale.paymentMethod === 'CASH') {
    dayData.cashAmount += sale.totalAmount;
  } else if (sale.paymentMethod === 'CARD') {
    dayData.cardAmount += sale.totalAmount;
  } else if (sale.paymentMethod === 'HYBRID') {
    dayData.hybridAmount += sale.totalAmount;
    if (sale.cashAmount) dayData.cashAmount += sale.cashAmount;
    if (sale.cardAmount) dayData.cardAmount += sale.cardAmount;
  }

  // Добавляем детализацию продажи
  dayData.sales.push({
    saleId: sale.id,
    totalAmount: sale.totalAmount,
    paymentMethod: sale.paymentMethod,
    cashAmount: sale.cashAmount || null,
    cardAmount: sale.cardAmount || null,
    completedAt: completedAt
  });

  // Обновляем итоговые суммы за неделю
  report.weeklyTotal.salesCount += 1;
  report.weeklyTotal.totalAmount += sale.totalAmount;

  if (sale.paymentMethod === 'CASH') {
    report.weeklyTotal.cashAmount += sale.totalAmount;
  } else if (sale.paymentMethod === 'CARD') {
    report.weeklyTotal.cardAmount += sale.totalAmount;
  } else if (sale.paymentMethod === 'HYBRID') {
    report.weeklyTotal.hybridAmount += sale.totalAmount;
    if (sale.cashAmount) report.weeklyTotal.cashAmount += sale.cashAmount;
    if (sale.cardAmount) report.weeklyTotal.cardAmount += sale.cardAmount;
  }

  await report.save({ session });
  return report;
}

// Завершение продажи (пробитие чека) - списание товаров со склада
async function completeSale(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { saleId, paymentMethod, cashAmount, cardAmount } = req.body;

    if (!saleId) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'ID чека не указан' });
    }

    // Валидация способа оплаты
    if (!paymentMethod || !['CASH', 'CARD', 'HYBRID'].includes(paymentMethod)) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Способ оплаты обязателен и должен быть CASH, CARD или HYBRID' });
    }

    // Валидация для гибридной оплаты
    if (paymentMethod === 'HYBRID') {
      if (cashAmount === undefined || cardAmount === undefined || cashAmount === null || cardAmount === null) {
        await session.abortTransaction();
        return res.status(400).json({ error: 'Для гибридной оплаты необходимо указать cashAmount и cardAmount' });
      }
      if (cashAmount < 0 || cardAmount < 0) {
        await session.abortTransaction();
        return res.status(400).json({ error: 'Суммы оплаты не могут быть отрицательными' });
      }
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

    // Сохраняем способ оплаты
    sale.paymentMethod = paymentMethod;
    sale.cashAmount = paymentMethod === 'HYBRID' ? cashAmount : (paymentMethod === 'CASH' ? sale.totalAmount : null);
    sale.cardAmount = paymentMethod === 'HYBRID' ? cardAmount : (paymentMethod === 'CARD' ? sale.totalAmount : null);
    sale.status = 'COMPLETED';
    sale.completedAt = new Date();
    await sale.save({ session });

    // Обновляем недельный отчет
    await updateWeeklyReport(storeId, sale, session);

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

// Получение недельного отчета
async function getWeeklyReport(req, res) {
  try {
    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    // Получаем дату из query параметра или используем текущую дату
    const dateParam = req.query.date;
    const targetDate = dateParam ? new Date(dateParam) : new Date();
    
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'Неверный формат даты' });
    }

    const weekStart = getWeekStart(targetDate);
    
    const report = await POSWeeklyReport.findOne({
      storeId,
      weekStartDate: weekStart
    }).lean();

    if (!report) {
      // Возвращаем пустой отчет, если данных нет
      const weekEnd = getWeekEnd(weekStart);
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dayDate = new Date(weekStart);
        dayDate.setDate(dayDate.getDate() + i);
        days.push({
          date: dayDate,
          cashAmount: 0,
          cardAmount: 0,
          hybridAmount: 0,
          totalAmount: 0,
          salesCount: 0,
          sales: []
        });
      }

      return res.json({
        id: null,
        storeId,
        weekStartDate: weekStart,
        weekEndDate: weekEnd,
        days,
        weeklyTotal: {
          cashAmount: 0,
          cardAmount: 0,
          hybridAmount: 0,
          totalAmount: 0,
          salesCount: 0
        },
        currency: 'RUB'
      });
    }

    res.json(report);
  } catch (error) {
    console.error('Ошибка при получении недельного отчета:', error);
    res.status(500).json({ error: 'Ошибка при получении недельного отчета' });
  }
}

// Получение списка недельных отчетов
async function getWeeklyReports(req, res) {
  try {
    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [reports, total] = await Promise.all([
      POSWeeklyReport.find({ storeId })
        .sort({ weekStartDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      POSWeeklyReport.countDocuments({ storeId })
    ]);

    res.json({
      items: reports,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Ошибка при получении списка недельных отчетов:', error);
    res.status(500).json({ error: 'Ошибка при получении списка недельных отчетов' });
  }
}

// Получение данных за конкретный день
async function getDailyReport(req, res) {
  try {
    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const dateParam = req.query.date;
    if (!dateParam) {
      return res.status(400).json({ error: 'Параметр date обязателен' });
    }

    const targetDate = new Date(dateParam);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'Неверный формат даты' });
    }

    const weekStart = getWeekStart(targetDate);
    const report = await POSWeeklyReport.findOne({
      storeId,
      weekStartDate: weekStart
    }).lean();

    if (!report) {
      return res.json({
        date: targetDate,
        cashAmount: 0,
        cardAmount: 0,
        hybridAmount: 0,
        totalAmount: 0,
        salesCount: 0,
        sales: []
      });
    }

    // Находим день недели
    const dayOfWeek = targetDate.getDay();
    const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const dayData = report.days[dayIndex] || {
      date: targetDate,
      cashAmount: 0,
      cardAmount: 0,
      hybridAmount: 0,
      totalAmount: 0,
      salesCount: 0,
      sales: []
    };

    res.json(dayData);
  } catch (error) {
    console.error('Ошибка при получении данных за день:', error);
    res.status(500).json({ error: 'Ошибка при получении данных за день' });
  }
}

module.exports = {
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
  getSalesStatistics,
  getWeeklyReport,
  getWeeklyReports,
  getDailyReport
};
