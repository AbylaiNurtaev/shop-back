const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');

const { Offer, Product, Store, User, SalesRepresentativeStore, SalesRepresentative, BrandDistributorRequest } = models;

const STORE_ROLES = ['STORE', 'STORE_USER'];

// Получение storeId для владельца магазина
async function getStoreIdForStoreOwner(user) {
  if (!user || !user.userId) {
    return null;
  }

  const userDoc = await User.findOne({ id: user.userId, role: 'STORE' }).lean();
  return userDoc ? userDoc.storeId : null;
}

// Получение storeId для продавца магазина (кассира)
async function getStoreIdForStoreSeller(user) {
  if (!user || !user.userId) {
    return null;
  }

  const userDoc = await User.findOne({ id: user.userId, role: 'STORE_SELLER' }).lean();
  return userDoc ? userDoc.storeId : null;
}

// Получение доступных storeId для продавца
async function getStoreIdsForSalesRep(user) {
  if (!user || (!user.userId && !user.salesRepresentativeId)) {
    return [];
  }

  const linkIds = [];

  if (user.salesRepresentativeId) {
    const [salesRep, userById] = await Promise.all([
      SalesRepresentative.findOne({ id: user.salesRepresentativeId }).lean(),
      User.findOne({ id: user.salesRepresentativeId, role: 'SALES_REPRESENTATIVE' }).lean()
    ]);

    if (salesRep) linkIds.push(salesRep.id);
    if (userById) {
      linkIds.push(userById.id);
      if (userById.email) {
        const salesRepByEmail = await SalesRepresentative.findOne({ email: userById.email }).lean();
        if (salesRepByEmail) linkIds.push(salesRepByEmail.id);
      }
    }
  }

  if (!linkIds.length && user.userId) {
    const userById = await User.findOne({ id: user.userId, role: 'SALES_REPRESENTATIVE' }).lean();
    if (userById) {
      linkIds.push(userById.id);
      if (userById.email) {
        const salesRepByEmail = await SalesRepresentative.findOne({ email: userById.email }).lean();
        if (salesRepByEmail) linkIds.push(salesRepByEmail.id);
      }
    }
  }

  if (!linkIds.length) {
    return [];
  }

  const links = await SalesRepresentativeStore.find({
    salesRepresentativeId: { $in: linkIds }
  }).lean();

  return Array.from(new Set(links.map(link => link.storeId)));
}

// Проверка доступа продавца к магазину
async function checkSalesRepStoreAccess(user, storeId) {
  const allowedStoreIds = await getStoreIdsForSalesRep(user);
  return allowedStoreIds.includes(storeId);
}

// ========== ФУНКЦИИ ДЛЯ ВЛАДЕЛЬЦА МАГАЗИНА ==========

// Получение всех товаров на складе магазина
async function getWarehouseInventory(req, res) {
  try {
    const storeId = await getStoreIdForStoreOwner(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const offers = await Offer.find({ storeId }).lean();
    const productIds = [...new Set(offers.map(offer => offer.productId))];
    const products = productIds.length > 0
      ? await Product.find({ id: { $in: productIds } }).lean()
      : [];

    const productById = new Map(products.map(product => [product.id, product]));

    const items = offers.map(offer => {
      const product = productById.get(offer.productId) || null;
      return {
        ...offer,
        product: product
          ? {
            id: product.id,
            name: product.name,
            sku: product.sku,
            brandName: product.brandName,
            categoryId: product.categoryId
          }
          : null
      };
    });

    res.json({
      items,
      total: items.length
    });
  } catch (error) {
    console.error('Ошибка при получении инвентаря склада:', error);
    res.status(500).json({ error: 'Ошибка при получении инвентаря склада' });
  }
}

// Приход товара на склад (владелец магазина)
async function addStock(req, res) {
  try {
    const storeId = await getStoreIdForStoreOwner(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const { productId, quantity, price, currency } = req.body;

    if (!productId || quantity === undefined || quantity <= 0) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля или неверное количество' });
    }

    // Проверяем существование товара
    const product = await Product.findOne({ id: productId }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Получаем пользователя магазина для проверки дистрибьютора
    const storeUser = await User.findOne({
      storeId,
      role: { $in: STORE_ROLES },
      isActive: true
    }).lean();

    if (!storeUser) {
      return res.status(404).json({ error: 'Магазин не найден или не активен' });
    }

    // Если магазин привязан к дистрибьютору, проверяем связь бренда с дистрибьютором
    if (storeUser.distributorId) {
      const brandDistributorConnection = await BrandDistributorRequest.findOne({
        brandId: product.brandId,
        distributorId: storeUser.distributorId,
        status: 'ACCEPTED'
      }).lean();

      if (!brandDistributorConnection) {
        return res.status(403).json({
          error: 'Товар не может быть добавлен: бренд не подключен к дистрибьютору этого магазина'
        });
      }
    }

    // Ищем или создаем оффер
    let offer = await Offer.findOne({ productId, storeId }).lean();

    if (!offer) {
      // Если оффера нет, создаем новый
      const defaultPrice = price !== undefined ? price : 0;
      const defaultCurrency = currency || 'RUB';

      offer = await Offer.create({
        id: generateId(),
        productId,
        storeId,
        price: defaultPrice,
        currency: defaultCurrency,
        isAvailable: true,
        quantity: quantity
      });
      offer = offer.toObject();
    } else {
      // Если оффер есть, увеличиваем количество
      const newQuantity = (offer.quantity || 0) + quantity;
      const update = { quantity: newQuantity, updatedAt: new Date() };

      // Обновляем цену и валюту, если они указаны
      if (price !== undefined) update.price = price;
      if (currency !== undefined) update.currency = currency;

      offer = await Offer.findOneAndUpdate(
        { id: offer.id },
        update,
        { new: true }
      ).lean();
    }

    // Получаем информацию о товаре для ответа
    res.json({
      message: 'Товар успешно добавлен на склад',
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        brandName: product.brandName
      },
      offer: {
        id: offer.id,
        quantity: offer.quantity,
        price: offer.price,
        currency: offer.currency
      }
    });
  } catch (error) {
    console.error('Ошибка при добавлении товара на склад:', error);
    res.status(500).json({ error: 'Ошибка при добавлении товара на склад' });
  }
}

// Уход товара со склада (владелец магазина)
async function removeStock(req, res) {
  try {
    const storeId = await getStoreIdForStoreOwner(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const { productId, quantity } = req.body;

    if (!productId || quantity === undefined || quantity <= 0) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля или неверное количество' });
    }

    const offer = await Offer.findOne({ productId, storeId }).lean();
    if (!offer) {
      return res.status(404).json({ error: 'Товар не найден на складе' });
    }

    const currentQuantity = offer.quantity || 0;
    if (quantity > currentQuantity) {
      return res.status(400).json({ error: 'Недостаточно товара на складе' });
    }

    const newQuantity = currentQuantity - quantity;
    const updatedOffer = await Offer.findOneAndUpdate(
      { id: offer.id },
      { quantity: newQuantity, updatedAt: new Date() },
      { new: true }
    ).lean();

    // Получаем информацию о товаре
    const product = await Product.findOne({ id: productId }).lean();

    res.json({
      message: 'Товар успешно списан со склада',
      product: product
        ? {
          id: product.id,
          name: product.name,
          sku: product.sku,
          brandName: product.brandName
        }
        : null,
      offer: {
        id: updatedOffer.id,
        quantity: updatedOffer.quantity,
        price: updatedOffer.price,
        currency: updatedOffer.currency
      }
    });
  } catch (error) {
    console.error('Ошибка при списании товара со склада:', error);
    res.status(500).json({ error: 'Ошибка при списании товара со склада' });
  }
}

// Обновление количества товара на складе (владелец магазина)
async function updateStock(req, res) {
  try {
    const storeId = await getStoreIdForStoreOwner(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const { productId, quantity, price, currency } = req.body;

    if (!productId || quantity === undefined || quantity < 0) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля или неверное количество' });
    }

    const offer = await Offer.findOne({ productId, storeId }).lean();
    if (!offer) {
      return res.status(404).json({ error: 'Товар не найден на складе' });
    }

    const update = { quantity, updatedAt: new Date() };
    if (price !== undefined) update.price = price;
    if (currency !== undefined) update.currency = currency;

    const updatedOffer = await Offer.findOneAndUpdate(
      { id: offer.id },
      update,
      { new: true }
    ).lean();

    // Получаем информацию о товаре
    const product = await Product.findOne({ id: productId }).lean();

    res.json({
      message: 'Количество товара успешно обновлено',
      product: product
        ? {
          id: product.id,
          name: product.name,
          sku: product.sku,
          brandName: product.brandName
        }
        : null,
      offer: {
        id: updatedOffer.id,
        quantity: updatedOffer.quantity,
        price: updatedOffer.price,
        currency: updatedOffer.currency
      }
    });
  } catch (error) {
    console.error('Ошибка при обновлении количества товара:', error);
    res.status(500).json({ error: 'Ошибка при обновлении количества товара' });
  }
}

// Аналитика склада (владелец магазина)
async function getWarehouseAnalytics(req, res) {
  try {
    const storeId = await getStoreIdForStoreOwner(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const offers = await Offer.find({ storeId }).lean();
    const productIds = [...new Set(offers.map(offer => offer.productId))];
    const products = productIds.length > 0
      ? await Product.find({ id: { $in: productIds } }).lean()
      : [];

    const productById = new Map(products.map(product => [product.id, product]));

    const threshold = parseInt(req.query.threshold) || 5;
    const now = new Date();

    let totalValue = 0;
    let lowStockItems = [];
    let expiringItems = [];
    let totalItems = 0;
    let totalQuantity = 0;

    for (const offer of offers) {
      const product = productById.get(offer.productId);
      if (!product) continue;

      const quantity = offer.quantity || 0;
      totalItems++;
      totalQuantity += quantity;

      // Проверка на низкий остаток
      if (quantity <= threshold) {
        lowStockItems.push({
          offerId: offer.id,
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          currentQuantity: quantity,
          threshold
        });
      }

      // Проверка на истечение срока годности
      if (product.expirationDate) {
        const expiryDate = new Date(product.expirationDate);
        const daysLeft = Math.ceil((expiryDate - now) / (24 * 60 * 60 * 1000));
        if (daysLeft >= 0 && daysLeft <= 7) {
          expiringItems.push({
            offerId: offer.id,
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            quantity,
            expiryDate,
            daysLeft
          });
        }
      }
    }

    res.json({
      summary: {
        totalItems,
        totalQuantity,
        lowStockCount: lowStockItems.length,
        expiringCount: expiringItems.length
      },
      lowStockItems,
      expiringItems
    });
  } catch (error) {
    console.error('Ошибка при получении аналитики склада:', error);
    res.status(500).json({ error: 'Ошибка при получении аналитики склада' });
  }
}

// ========== ФУНКЦИИ ДЛЯ ПРОДАВЦА МАГАЗИНА (QR-СКАНЕР) ==========

// Поиск товара по штрих-коду (SKU) - для продавца магазина
async function findProductByBarcode(req, res) {
  try {
    const { barcode } = req.params;

    if (!barcode) {
      return res.status(400).json({ error: 'Штрих-код не указан' });
    }

    // Получаем storeId для продавца магазина
    const storeId = await getStoreIdForStoreSeller(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    // Ищем товар по SKU (штрих-коду)
    const product = await Product.findOne({ sku: barcode }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар с таким штрих-кодом не найден' });
    }

    // Ищем оффер для этого товара в магазине
    const offer = await Offer.findOne({ productId: product.id, storeId }).lean();

    // Получаем информацию о магазине
    const store = await Store.findOne({ id: storeId }).lean();

    res.json({
      store: store
        ? {
          id: store.id,
          name: store.name,
          address: store.address
        }
        : null,
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        brandName: product.brandName,
        categoryId: product.categoryId
      },
      offer: offer
        ? {
          id: offer.id,
          quantity: offer.quantity || 0,
          price: offer.price,
          currency: offer.currency
        }
        : null
    });
  } catch (error) {
    console.error('Ошибка при поиске товара по штрих-коду:', error);
    res.status(500).json({ error: 'Ошибка при поиске товара по штрих-коду' });
  }
}

// Быстрый приход товара по штрих-коду (продавец магазина)
async function quickAddStockByBarcode(req, res) {
  try {
    const { barcode, quantity } = req.body;

    // Получаем storeId для продавца магазина
    const targetStoreId = await getStoreIdForStoreSeller(req.user);
    if (!targetStoreId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    if (!barcode || quantity === undefined || quantity <= 0) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля или неверное количество' });
    }

    // Ищем товар по SKU
    const product = await Product.findOne({ sku: barcode }).lean();
    if (!product) {
      return res.status(404).json({ error: 'Товар с таким штрих-кодом не найден' });
    }

    // Ищем или создаем оффер
    let offer = await Offer.findOne({ productId: product.id, storeId: targetStoreId }).lean();

    if (!offer) {
      // Если оффера нет, создаем новый
      offer = await Offer.create({
        id: generateId(),
        productId: product.id,
        storeId: targetStoreId,
        price: 0, // Цену нужно будет установить позже
        currency: 'RUB',
        isAvailable: true,
        quantity: quantity
      });
      offer = offer.toObject();
    } else {
      // Если оффер есть, увеличиваем количество
      const newQuantity = (offer.quantity || 0) + quantity;
      offer = await Offer.findOneAndUpdate(
        { id: offer.id },
        { quantity: newQuantity, updatedAt: new Date() },
        { new: true }
      ).lean();
    }

    // Получаем информацию о магазине
    const store = await Store.findOne({ id: targetStoreId }).lean();

    res.json({
      message: 'Товар успешно добавлен на склад',
      store: store
        ? {
          id: store.id,
          name: store.name,
          address: store.address
        }
        : null,
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        brandName: product.brandName
      },
      offer: {
        id: offer.id,
        quantity: offer.quantity,
        price: offer.price,
        currency: offer.currency
      }
    });
  } catch (error) {
    console.error('Ошибка при быстром добавлении товара:', error);
    res.status(500).json({ error: 'Ошибка при быстром добавлении товара' });
  }
}

module.exports = {
  // Функции для владельца магазина
  getWarehouseInventory,
  addStock,
  removeStock,
  updateStock,
  getWarehouseAnalytics,
  // Функции для продавца (QR-сканер)
  findProductByBarcode,
  quickAddStockByBarcode
};
