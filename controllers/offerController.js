const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const { logStoreActivity } = require('../utils/storeActivityLogger');

const { Offer, Product, Category, User, BrandDistributorRequest } = models;

const STORE_ROLES = ['STORE', 'STORE_USER'];

// Получение storeId для владельца магазина
async function getStoreIdForStoreOwner(user) {
  if (!user || !user.userId) {
    return null;
  }

  const userDoc = await User.findOne({ 
    id: user.userId, 
    role: { $in: STORE_ROLES } 
  }).lean();
  return userDoc ? userDoc.storeId : null;
}

async function createOffer(req, res) {
  try {
    const { productId, storeId, price, markup, currency, isAvailable, quantity } = req.body;

    if (!productId || !storeId || price === undefined || !currency) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
    }

    // Получаем товар для проверки бренда
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

    const offer = await Offer.create({
      id: generateId(),
      productId,
      storeId,
      price,
      markup: markup || 0,
      currency,
      isAvailable: isAvailable !== undefined ? isAvailable : true,
      quantity: quantity || 0
    });

    // Логируем действие, если это владелец магазина
    const userStoreId = await getStoreIdForStoreOwner(req.user);
    if (userStoreId && userStoreId === storeId && product) {
      await logStoreActivity(
        storeId,
        req.user.userId,
        'CREATE_OFFER',
        `Создан новый оффер для товара "${product.name}" (SKU: ${product.sku}). Цена: ${price} ${currency}, количество: ${quantity || 0}`,
        {
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          brandName: product.brandName,
          price: price,
          currency: currency,
          quantity: quantity || 0,
          isAvailable: isAvailable !== undefined ? isAvailable : true,
          offerId: offer.id
        }
      );
    }

    res.status(201).json(offer.toObject());
  } catch (error) {
    console.error('Ошибка при создании оффера:', error);
    res.status(500).json({ error: 'Ошибка при создании оффера' });
  }
}

async function getOfferById(req, res) {
  try {
    const { offerId } = req.params;
    const offer = await Offer.findOne({ id: offerId }).lean();

    if (!offer) {
      return res.status(404).json({ error: 'Оффер не найден' });
    }

    const product = await Product.findOne({ id: offer.productId }).lean();
    if (!product) {
      return res.json({ ...offer, product: null });
    }
    const category = await Category.findOne({ id: product.categoryId }).lean();

    res.json({
      ...offer,
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        brandName: product.brandName,
        packageInfo: product.packageInfo,
        brandId: product.brandId,
        storageLife: product.storageLife,
        productionDate: product.productionDate,
        allergens: product.allergens,
        ageRestrictions: product.ageRestrictions,
        category: category ? { id: category.id, name: category.name } : null
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении оффера' });
  }
}

async function getOffers(req, res) {
  try {
    let query = {};
    if (req.user && req.user.userId) {
      const user = await models.User.findOne({ id: req.user.userId }).lean();
      if (user && user.storeId) {
        query = { storeId: user.storeId };
      } else if (req.user && req.user.brandId) {
        const brandProducts = await Product.find({ brandId: req.user.brandId }, 'id').lean();
        const brandProductIds = brandProducts.map(product => product.id);
        query = brandProductIds.length > 0
          ? { productId: { $in: brandProductIds } }
          : { productId: { $in: [] } };
      }
    }

    const offers = await Offer.find(query).lean();
    const productIds = offers.map(offer => offer.productId);
    const products = productIds.length > 0
      ? await Product.find({ id: { $in: productIds } }).lean()
      : [];
    const categoryIds = [...new Set(products.map(product => product.categoryId))];
    const categories = categoryIds.length > 0
      ? await Category.find({ id: { $in: categoryIds } }).lean()
      : [];
    const productById = new Map(products.map(product => [product.id, product]));
    const categoryById = new Map(categories.map(category => [category.id, category]));

    res.json({
      items: offers.map(offer => {
        const product = productById.get(offer.productId) || null;
        const category = product ? categoryById.get(product.categoryId) || null : null;
        return {
          ...offer,
          product: product
            ? {
                id: product.id,
                name: product.name,
                sku: product.sku,
                brandName: product.brandName,
                  packageInfo: product.packageInfo,
                  brandId: product.brandId,
                  storageLife: product.storageLife,
                  productionDate: product.productionDate,
                  allergens: product.allergens,
                  ageRestrictions: product.ageRestrictions,
                category: category ? { id: category.id, name: category.name } : null
              }
            : null
        };
      }),
      total: offers.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении списка офферов' });
  }
}

async function updateOffer(req, res) {
  try {
    const { offerId } = req.params;
    let { price, currency, isAvailable, quantity, markup } = req.body;

    console.log(`[UPDATE OFFER] Запрос на обновление оффера ${offerId}:`, { price, markup, currency, isAvailable, quantity });

    // Проверяем существование оффера
    const offer = await Offer.findOne({ id: offerId }).lean();
    if (!offer) {
      return res.status(404).json({ error: 'Оффер не найден' });
    }

    console.log(`[UPDATE OFFER] Текущее состояние оффера:`, { 
      price: offer.price, 
      markup: offer.markup, 
      currency: offer.currency,
      productId: offer.productId 
    });

    // Проверяем права доступа: владелец магазина может обновлять только свои офферы
    const userStoreId = await getStoreIdForStoreOwner(req.user);
    if (userStoreId && offer.storeId !== userStoreId) {
      return res.status(403).json({ 
        error: 'Нет доступа к этому офферу. Вы можете изменять только цены товаров своего магазина' 
      });
    }

    // Если пользователь не является владельцем магазина, проверяем другие роли (например, ADMIN)
    if (!userStoreId) {
      // Проверяем, является ли пользователь администратором
      if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ 
          error: 'Только владелец магазина может изменять цены товаров' 
        });
      }
    }

    // Преобразуем цену в число, если она передана как строка
    if (price !== undefined && price !== null) {
      const numPrice = typeof price === 'string' ? parseFloat(price) : price;
      if (isNaN(numPrice) || numPrice < 0) {
        return res.status(400).json({ error: 'Цена должна быть неотрицательным числом' });
      }
      price = numPrice;
    }

    // Валидация quantity
    if (quantity !== undefined && quantity !== null) {
      const numQuantity = typeof quantity === 'string' ? parseInt(quantity, 10) : quantity;
      if (isNaN(numQuantity) || numQuantity < 0) {
        return res.status(400).json({ error: 'Количество должно быть неотрицательным числом' });
      }
      quantity = numQuantity;
    }

    // Валидация markup
    if (markup !== undefined && markup !== null) {
      console.log(`[UPDATE OFFER] Валидация markup: входное значение = ${markup} (тип: ${typeof markup})`);
      const numMarkup = typeof markup === 'string' ? parseFloat(markup) : markup;
      if (isNaN(numMarkup) || numMarkup < 0) {
        console.log(`[UPDATE OFFER] Ошибка валидации markup: ${numMarkup}`);
        return res.status(400).json({ error: 'markup должен быть неотрицательным числом' });
      }
      markup = numMarkup;
      console.log(`[UPDATE OFFER] Markup после валидации: ${markup}`);
    } else {
      console.log(`[UPDATE OFFER] Markup не передан или null: markup = ${markup}`);
    }

    // Валидация isAvailable
    if (isAvailable !== undefined && isAvailable !== null) {
      if (typeof isAvailable !== 'boolean') {
        return res.status(400).json({ error: 'isAvailable должен быть булевым значением (true/false)' });
      }
    }

    const oldPrice = offer.price;
    const oldMarkup = offer.markup;
    const oldQuantity = offer.quantity || 0;
    const oldIsAvailable = offer.isAvailable;
    const oldCurrency = offer.currency;

    const update = { updatedAt: new Date() };
    // Явно обновляем цену, даже если она равна 0
    if (price !== undefined && price !== null) {
      update.price = price;
      console.log(`[UPDATE OFFER] Обновление цены оффера ${offerId}: старая цена = ${offer.price}, новая цена = ${price}`);
    }
    if (markup !== undefined && markup !== null) {
      update.markup = markup;
      console.log(`[UPDATE OFFER] Обновление наценки оффера ${offerId}: старая наценка = ${offer.markup}, новая наценка = ${markup}`);
    }
    if (currency !== undefined) update.currency = currency;
    if (isAvailable !== undefined) update.isAvailable = isAvailable;
    if (quantity !== undefined) update.quantity = quantity;

    console.log(`[UPDATE OFFER] Объект обновления:`, update);

    const updatedOffer = await Offer.findOneAndUpdate({ id: offerId }, update, {
      new: true
    }).lean();

    console.log(`[UPDATE OFFER] Оффер ${offerId} успешно обновлен:`, { 
      price: updatedOffer.price, 
      markup: updatedOffer.markup,
      updatedAt: updatedOffer.updatedAt 
    });

    // Логируем действия, если это владелец магазина
    if (userStoreId && userStoreId === offer.storeId) {
      const product = await Product.findOne({ id: offer.productId }).lean();
      
      if (product) {
        // Логируем изменение цены
        if (price !== undefined && price !== null && oldPrice !== price) {
          await logStoreActivity(
            offer.storeId,
            req.user.userId,
            'UPDATE_PRICE',
            `Изменена цена товара "${product.name}" (SKU: ${product.sku}). Старая цена: ${oldPrice} ${oldCurrency}, новая цена: ${price} ${updatedOffer.currency}`,
            {
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              brandName: product.brandName,
              oldPrice: oldPrice,
              newPrice: price,
              oldCurrency: oldCurrency,
              newCurrency: updatedOffer.currency,
              offerId: updatedOffer.id
            }
          );
        }

        // Логируем изменение наценки
        if (markup !== undefined && markup !== null && oldMarkup !== markup) {
          await logStoreActivity(
            offer.storeId,
            req.user.userId,
            'UPDATE_MARKUP',
            `Изменена наценка товара "${product.name}" (SKU: ${product.sku}). Старая наценка: ${oldMarkup || 0}, новая наценка: ${markup}`,
            {
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              brandName: product.brandName,
              oldMarkup: oldMarkup || 0,
              newMarkup: markup,
              offerId: updatedOffer.id
            }
          );
        }

        // Логируем изменение количества
        if (quantity !== undefined && oldQuantity !== quantity) {
          await logStoreActivity(
            offer.storeId,
            req.user.userId,
            'UPDATE_QUANTITY',
            `Изменено количество товара "${product.name}" (SKU: ${product.sku}) на складе. Старое количество: ${oldQuantity}, новое количество: ${quantity}`,
            {
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              brandName: product.brandName,
              oldQuantity: oldQuantity,
              newQuantity: quantity,
              offerId: updatedOffer.id
            }
          );
        }

        // Логируем изменение доступности товара
        if (isAvailable !== undefined && oldIsAvailable !== isAvailable) {
          await logStoreActivity(
            offer.storeId,
            req.user.userId,
            'UPDATE_AVAILABILITY',
            `Изменена доступность товара "${product.name}" (SKU: ${product.sku}). ${isAvailable ? 'Товар доступен' : 'Товар недоступен'}`,
            {
              productId: product.id,
              productName: product.name,
              sku: product.sku,
              brandName: product.brandName,
              oldIsAvailable: oldIsAvailable,
              newIsAvailable: isAvailable,
              offerId: updatedOffer.id
            }
          );
        }
      }
    }

    res.json(updatedOffer);
  } catch (error) {
    console.error('Ошибка при обновлении оффера:', error);
    res.status(500).json({ error: 'Ошибка при обновлении оффера' });
  }
}

async function deleteOffer(req, res) {
  try {
    const { offerId } = req.params;
    
    // Получаем оффер перед удалением для логирования
    const offer = await Offer.findOne({ id: offerId }).lean();
    if (!offer) {
      return res.status(404).json({ error: 'Оффер не найден' });
    }

    // Проверяем права доступа
    const userStoreId = await getStoreIdForStoreOwner(req.user);
    if (userStoreId && offer.storeId !== userStoreId) {
      return res.status(403).json({ 
        error: 'Нет доступа к этому офферу. Вы можете удалять только офферы своего магазина' 
      });
    }

    if (!userStoreId) {
      if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ 
          error: 'Только владелец магазина может удалять офферы' 
        });
      }
    }

    // Логируем действие перед удалением
    if (userStoreId && userStoreId === offer.storeId) {
      const product = await Product.findOne({ id: offer.productId }).lean();
      if (product) {
        await logStoreActivity(
          offer.storeId,
          req.user.userId,
          'DELETE_OFFER',
          `Удален оффер для товара "${product.name}" (SKU: ${product.sku}) со склада`,
          {
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            brandName: product.brandName,
            offerId: offer.id,
            lastPrice: offer.price,
            lastQuantity: offer.quantity || 0
          }
        );
      }
    }

    const result = await Offer.deleteOne({ id: offerId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Оффер не найден' });
    }

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении оффера' });
  }
}

module.exports = {
  createOffer,
  getOfferById,
  getOffers,
  updateOffer,
  deleteOffer
};
