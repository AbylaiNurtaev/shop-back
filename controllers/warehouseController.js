const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const { analyzeInvoice } = require('../utils/gemini');

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

    // Преобразуем цену в число, если она передана как строка
    if (price !== undefined && price !== null) {
      const numPrice = typeof price === 'string' ? parseFloat(price) : price;
      if (!isNaN(numPrice) && numPrice >= 0) {
        price = numPrice;
      } else {
        price = undefined; // Игнорируем невалидную цену
      }
    }

    // Ищем или создаем оффер
    let offer = await Offer.findOne({ productId, storeId }).lean();

    if (!offer) {
      // Если оффера нет, создаем новый
      const defaultPrice = price !== undefined && price !== null ? price : 0;
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
      if (price !== undefined && price !== null) {
        update.price = price;
        console.log(`Обновление цены товара ${productId} (SKU: ${product.sku}) при добавлении на склад: старая цена = ${offer.price}, новая цена = ${price}`);
      }
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

    let { productId, quantity, price, currency } = req.body;

    if (!productId || quantity === undefined || quantity < 0) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля или неверное количество' });
    }

    const offer = await Offer.findOne({ productId, storeId }).lean();
    if (!offer) {
      return res.status(404).json({ error: 'Товар не найден на складе' });
    }

    // Преобразуем цену в число, если она передана как строка
    if (price !== undefined && price !== null) {
      const numPrice = typeof price === 'string' ? parseFloat(price) : price;
      if (isNaN(numPrice) || numPrice < 0) {
        return res.status(400).json({ error: 'Цена должна быть неотрицательным числом' });
      }
      price = numPrice;
    }

    const update = { quantity, updatedAt: new Date() };
    // Явно обновляем цену, даже если она равна 0
    if (price !== undefined && price !== null) {
      update.price = price;
      // Получаем информацию о товаре для логирования
      const product = await Product.findOne({ id: productId }).lean();
      const sku = product?.sku || 'N/A';
      console.log(`Обновление цены товара ${productId} (SKU: ${sku}) в магазине ${storeId}: старая цена = ${offer.price}, новая цена = ${price}`);
    }
    if (currency !== undefined) update.currency = currency;

    const updatedOffer = await Offer.findOneAndUpdate(
      { id: offer.id },
      update,
      { new: true }
    ).lean();

    console.log(`Товар ${productId} обновлен. Финальная цена: ${updatedOffer.price}`);

    // Получаем информацию о товаре (если еще не получена для логирования)
    let product = await Product.findOne({ id: productId }).lean();

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

// Обработка накладной с помощью ИИ (владелец магазина)
async function processInvoice(req, res) {
  try {
    const storeId = await getStoreIdForStoreOwner(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    // Получаем файл из req.files (upload.any()) или req.file (upload.single())
    let file;
    if (req.files && req.files.length > 0) {
      if (req.files.length > 1) {
        return res.status(400).json({ error: 'Пожалуйста, загрузите только один файл накладной' });
      }
      file = req.files[0];
    } else {
      file = req.file;
    }

    if (!file) {
      return res.status(400).json({ error: 'Файл накладной не передан' });
    }

    // Проверяем тип файла
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Недопустимый тип файла. Разрешены только изображения' });
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

    // Анализируем накладную с помощью ИИ
    let invoiceData;
    try {
      invoiceData = await analyzeInvoice({
        buffer: file.buffer,
        mimeType: file.mimetype
      });
    } catch (error) {
      console.error('Ошибка при анализе накладной:', error);
      return res.status(500).json({
        error: 'Ошибка при анализе накладной',
        details: error.message
      });
    }

    if (!invoiceData.items || invoiceData.items.length === 0) {
      return res.status(400).json({
        error: 'Не удалось извлечь товары из накладной. Проверьте качество изображения.'
      });
    }

    // Анализируем каждый товар из накладной (без добавления на склад)
    const results = {
      found: [],      // Товары, найденные в базе
      notFound: [],   // Товары, не найденные в базе
      errors: []      // Товары с ошибками
    };

    for (const item of invoiceData.items) {
      try {
        if (!item.productName || !item.quantity || item.quantity <= 0) {
          results.errors.push({
            item,
            error: 'Отсутствует название товара или неверное количество'
          });
          continue;
        }

        // Ищем товар в базе данных
        // Сначала по SKU, если он указан
        let product = null;
        if (item.sku) {
          product = await Product.findOne({ sku: item.sku }).lean();
        }

        // Если не нашли по SKU, ищем по названию и бренду
        if (!product) {
          const searchQuery = {
            name: { $regex: item.productName, $options: 'i' }
          };

          // Если указан бренд, добавляем его в поиск
          if (item.brand) {
            searchQuery.brandName = { $regex: item.brand, $options: 'i' };
          }

          // Ищем товары, которые оплачены и не истекли
          searchQuery.isPayed = true;
          searchQuery.paymentExpiresAt = { $gt: new Date() };

          const products = await Product.find(searchQuery).lean();

          // Если найдено несколько товаров, выбираем наиболее подходящий
          if (products.length > 0) {
            // Если есть точное совпадение по названию - берем его
            const exactMatch = products.find(p =>
              p.name.toLowerCase() === item.productName.toLowerCase()
            );
            product = exactMatch || products[0];
          }
        }

        if (!product) {
          results.notFound.push({
            productName: item.productName,
            sku: item.sku,
            brand: item.brand,
            quantity: item.quantity,
            unit: item.unit,
            notes: item.notes
          });
          continue;
        }

        // Проверяем связь бренда с дистрибьютором (если магазин привязан к дистрибьютору)
        let brandError = null;
        if (storeUser.distributorId) {
          const brandDistributorConnection = await BrandDistributorRequest.findOne({
            brandId: product.brandId,
            distributorId: storeUser.distributorId,
            status: 'ACCEPTED'
          }).lean();

          if (!brandDistributorConnection) {
            brandError = 'Бренд товара не подключен к дистрибьютору этого магазина';
          }
        }

        // Проверяем текущее количество на складе (если оффер уже существует)
        const existingOffer = await Offer.findOne({ productId: product.id, storeId }).lean();
        const currentQuantity = existingOffer ? (existingOffer.quantity || 0) : 0;

        // Добавляем информацию о найденном товаре (без добавления на склад)
        results.found.push({
          // Исходные данные из накладной
          originalItem: {
            productName: item.productName,
            quantity: item.quantity,
            sku: item.sku,
            brand: item.brand,
            unit: item.unit,
            notes: item.notes
          },
          // Найденный товар в базе
          product: {
            id: product.id,
            name: product.name,
            sku: product.sku,
            brandName: product.brandName,
            brandId: product.brandId
          },
          // Информация о количестве
          quantity: item.quantity,
          currentQuantity: currentQuantity,
          newQuantity: currentQuantity + item.quantity,
          // Ошибки (если есть)
          error: brandError,
          // Флаг, можно ли добавить товар
          canAdd: !brandError
        });
      } catch (error) {
        console.error('Ошибка при анализе товара из накладной:', error);
        results.errors.push({
          item,
          error: error.message
        });
      }
    }

    res.json({
      message: 'Накладная проанализирована. Проверьте найденные товары и подтвердите добавление на склад.',
      invoiceInfo: {
        invoiceNumber: invoiceData.invoiceNumber,
        date: invoiceData.date,
        supplier: invoiceData.supplier
      },
      summary: {
        total: invoiceData.items.length,
        found: results.found.length,
        notFound: results.notFound.length,
        errors: results.errors.length
      },
      found: results.found,
      notFound: results.notFound,
      errors: results.errors
    });
  } catch (error) {
    console.error('Ошибка при обработке накладной:', error);
    res.status(500).json({ error: 'Ошибка при обработке накладной' });
  }
}

// Подтверждение и добавление товаров из накладной на склад
async function confirmInvoiceItems(req, res) {
  try {
    const storeId = await getStoreIdForStoreOwner(req.user);
    if (!storeId) {
      return res.status(404).json({ error: 'Магазин не найден для текущего пользователя' });
    }

    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Список товаров для добавления не передан' });
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

    const results = {
      processed: [],
      errors: []
    };

    for (const item of items) {
      try {
        // Проверяем обязательные поля
        if (!item.productId || !item.quantity || item.quantity <= 0) {
          results.errors.push({
            item,
            error: 'Отсутствует productId или неверное количество'
          });
          continue;
        }

        // Получаем товар из базы
        const product = await Product.findOne({ id: item.productId }).lean();
        if (!product) {
          results.errors.push({
            item,
            error: 'Товар не найден в базе данных'
          });
          continue;
        }

        // Проверяем связь бренда с дистрибьютором (если магазин привязан к дистрибьютору)
        if (storeUser.distributorId) {
          const brandDistributorConnection = await BrandDistributorRequest.findOne({
            brandId: product.brandId,
            distributorId: storeUser.distributorId,
            status: 'ACCEPTED'
          }).lean();

          if (!brandDistributorConnection) {
            results.errors.push({
              item,
              error: 'Бренд товара не подключен к дистрибьютору этого магазина'
            });
            continue;
          }
        }

        // Ищем или создаем оффер
        let offer = await Offer.findOne({ productId: product.id, storeId }).lean();

        if (!offer) {
          // Создаем новый оффер
          offer = await Offer.create({
            id: generateId(),
            productId: product.id,
            storeId,
            price: 0, // Цену нужно будет установить позже
            currency: 'RUB',
            isAvailable: true,
            quantity: item.quantity
          });
          offer = offer.toObject();
        } else {
          // Увеличиваем количество
          const newQuantity = (offer.quantity || 0) + item.quantity;
          offer = await Offer.findOneAndUpdate(
            { id: offer.id },
            { quantity: newQuantity, updatedAt: new Date() },
            { new: true }
          ).lean();
        }

        results.processed.push({
          productName: product.name,
          productId: product.id,
          sku: product.sku,
          brandName: product.brandName,
          quantity: item.quantity,
          totalQuantity: offer.quantity,
          offerId: offer.id
        });
      } catch (error) {
        console.error('Ошибка при добавлении товара на склад:', error);
        results.errors.push({
          item,
          error: error.message
        });
      }
    }

    res.json({
      message: 'Товары добавлены на склад',
      summary: {
        total: items.length,
        processed: results.processed.length,
        errors: results.errors.length
      },
      processed: results.processed,
      errors: results.errors
    });
  } catch (error) {
    console.error('Ошибка при подтверждении товаров из накладной:', error);
    res.status(500).json({ error: 'Ошибка при подтверждении товаров из накладной' });
  }
}

module.exports = {
  // Функции для владельца магазина
  getWarehouseInventory,
  addStock,
  removeStock,
  updateStock,
  getWarehouseAnalytics,
  processInvoice,
  confirmInvoiceItems,
  // Функции для продавца (QR-сканер)
  findProductByBarcode,
  quickAddStockByBarcode
};
