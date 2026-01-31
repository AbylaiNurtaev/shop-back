const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const { hashPassword } = require('../utils/password');
const { sendEmail } = require('../utils/email');
const { validateProductImage } = require('../utils/gemini');

const { Brand, Category, User, AuthCredential, ProductSearchLog, Product } = models;

async function createBrand(req, res) {
  let createdUserId = null;
  let createdBrandId = null;
  let email = null;

  try {
    const { name, country, city, categoryId, logoUrl, email: emailParam, password, contactName, phone } = req.body;
    email = emailParam;

    if (!name || !country || !categoryId || !email || !password) {
      return res.status(400).json({
        error: 'Отсутствуют обязательные поля: name, country, categoryId, email, password'
      });
    }

    // Проверяем, что email ещё не занят (проверяем все возможные места)
    const existingUser = await User.findOne({ email }).lean();
    const existingBrand = await Brand.findOne({ email }).lean();

    if (existingUser || existingBrand) {
      return res.status(409).json({
        error: existingBrand
          ? 'Бренд с таким email уже зарегистрирован'
          : 'Пользователь с таким email уже существует',
        code: 'EMAIL_ALREADY_EXISTS'
      });
    }

    // Проверяем наличие "висячих" учетных данных
    const existingCredential = await AuthCredential.findOne({ login: email }).lean();
    if (existingCredential) {
      // Если есть креды, но нет пользователя/бренда — считаем их мусором и удаляем
      await AuthCredential.deleteOne({ login: email });
    }

    // Проверяем существование категории
    const category = await Category.findOne({ id: categoryId }).lean();
    if (!category) {
      return res.status(400).json({ error: 'Категория не найдена' });
    }

    const userId = generateId();
    createdUserId = userId;

    // Создаем пользователя бренда
    try {
      await User.create({
        id: userId,
        role: 'BRAND',
        email,
        firstName: contactName || name,
        storeId: null,
        distributorId: null,
        isActive: true
      });
    } catch (userError) {
      // Если пользователь уже существует (race condition), возвращаем ошибку
      if (userError.code === 11000 || userError.message.includes('duplicate')) {
        return res.status(409).json({
          error: 'Пользователь с таким email уже существует',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      throw userError;
    }

    // Создаем учетные данные
    try {
      await AuthCredential.create({
        login: email,
        password: hashPassword(password)
      });
    } catch (credError) {
      // Если учетные данные уже существуют, удаляем созданного пользователя и возвращаем ошибку
      if (credError.code === 11000 || credError.message.includes('duplicate')) {
        await User.deleteOne({ id: userId });
        return res.status(409).json({
          error: 'Учетные данные уже существуют',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      // Если другая ошибка, удаляем пользователя и пробрасываем ошибку
      await User.deleteOne({ id: userId });
      throw credError;
    }

    // Создаем бренд
    const brandId = generateId();
    createdBrandId = brandId;

    try {
      const brand = await Brand.create({
        id: brandId,
        name,
        country,
        city: city || null,
        categoryId,
        logoUrl: logoUrl || null,
        email,
        contactName: contactName || null,
        phone: phone || null
      });

      res.status(201).json(brand.toObject());
    } catch (brandError) {
      // Если бренд не создался, удаляем пользователя и учетные данные
      await User.deleteOne({ id: userId });
      await AuthCredential.deleteOne({ login: email });

      if (brandError.code === 11000 || brandError.message.includes('duplicate')) {
        return res.status(409).json({
          error: 'Бренд с таким email уже существует',
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }
      throw brandError;
    }
  } catch (error) {
    console.error('Ошибка при создании бренда:', error);

    // Откатываем изменения, если что-то пошло не так
    if (createdUserId) {
      await User.deleteOne({ id: createdUserId }).catch(() => { });
    }
    if (createdUserId) {
      await AuthCredential.deleteOne({ login: email }).catch(() => { });
    }
    if (createdBrandId) {
      await Brand.deleteOne({ id: createdBrandId }).catch(() => { });
    }

    res.status(500).json({ error: 'Ошибка при создании бренда' });
  }
}

async function getBrandById(req, res) {
  try {
    const { brandId } = req.params;
    const brand = await Brand.findOne({ id: brandId }).lean();

    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    res.json(brand);
  } catch (error) {
    console.error('Ошибка при получении бренда:', error);
    res.status(500).json({ error: 'Ошибка при получении бренда' });
  }
}

async function getBrands(req, res) {
  try {
    const brands = await Brand.find({}).lean();
    res.json({
      items: brands,
      total: brands.length
    });
  } catch (error) {
    console.error('Ошибка при получении списка брендов:', error);
    res.status(500).json({ error: 'Ошибка при получении списка брендов' });
  }
}

async function updateBrand(req, res) {
  try {
    const { brandId } = req.params;
    const { name, country, city, categoryId, logoUrl, phone } = req.body;

    const brand = await Brand.findOne({ id: brandId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Проверяем категорию, если она изменяется
    if (categoryId) {
      const category = await Category.findOne({ id: categoryId }).lean();
      if (!category) {
        return res.status(400).json({ error: 'Категория не найдена' });
      }
    }

    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (country !== undefined) update.country = country;
    if (city !== undefined) update.city = city === null || city === '' ? null : city;
    if (categoryId !== undefined) update.categoryId = categoryId;
    if (logoUrl !== undefined) update.logoUrl = logoUrl;
    if (phone !== undefined) update.phone = phone === null || phone === '' ? null : phone;

    const updatedBrand = await Brand.findOneAndUpdate({ id: brandId }, update, { new: true }).lean();
    if (!updatedBrand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    res.json(updatedBrand);
  } catch (error) {
    console.error('Ошибка при обновлении бренда:', error);
    res.status(500).json({ error: 'Ошибка при обновлении бренда' });
  }
}

async function deleteBrand(req, res) {
  try {
    const { brandId } = req.params;
    const result = await Brand.deleteOne({ id: brandId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Ошибка при удалении бренда:', error);
    res.status(500).json({ error: 'Ошибка при удалении бренда' });
  }
}

// Получить бренды, которые еще не приняты админом
async function getPendingBrands(req, res) {
  try {
    const brands = await Brand.find({ isAccepted: false }).lean();
    res.json({
      items: brands,
      total: brands.length
    });
  } catch (error) {
    console.error('Ошибка при получении заявок брендов:', error);
    res.status(500).json({ error: 'Ошибка при получении заявок брендов' });
  }
}

// Одобрить заявку бренда
async function approveBrand(req, res) {
  try {
    const { brandId } = req.params;

    const brand = await Brand.findOneAndUpdate(
      { id: brandId },
      { isAccepted: true, rejectedReason: null, updatedAt: new Date() },
      { new: true }
    ).lean();

    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Отправляем уведомление на почту бренда
    if (brand.email) {
      try {
        await sendEmail({
          to: brand.email,
          subject: 'Ваша заявка бренда одобрена',
          text: `Бренд "${brand.name}" был одобрен администратором. Теперь вы можете войти в аккаунт по указанному email.`
        });
      } catch (e) {
        console.error('Не удалось отправить email об одобрении бренда:', e);
      }
    }

    res.json(brand);
  } catch (error) {
    console.error('Ошибка при одобрении бренда:', error);
    res.status(500).json({ error: 'Ошибка при одобрении бренда' });
  }
}

// Отклонить заявку бренда
async function rejectBrand(req, res) {
  try {
    const { brandId } = req.params;
    const { reason } = req.body;

    // Сначала находим бренд, чтобы иметь доступ к данным для письма
    const brand = await Brand.findOne({ id: brandId }).lean();

    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Отправляем уведомление об отклонении
    if (brand.email) {
      try {
        await sendEmail({
          to: brand.email,
          subject: 'Ваша заявка бренда отклонена',
          text: `Бренд "${brand.name}" был отклонен. Причина: ${reason || brand.rejectedReason || 'не указана'
            }`
        });
      } catch (e) {
        console.error('Не удалось отправить email об отклонении бренда:', e);
      }
    }

    // Удаляем бренд из базы, чтобы он не отображался в списках
    await Brand.deleteOne({ id: brandId });

    // Дополнительно удаляем пользователя и его учетные данные,
    // чтобы бренд не мог зайти в систему после отклонения
    if (brand.email) {
      try {
        await Promise.all([
          User.deleteOne({ email: brand.email }),
          AuthCredential.deleteOne({ login: brand.email })
        ]);
      } catch (cleanupError) {
        console.error('Ошибка при удалении пользователя бренда после отклонения:', cleanupError);
      }
    }

    res.status(204).send();
  } catch (error) {
    console.error('Ошибка при отклонении бренда:', error);
    res.status(500).json({ error: 'Ошибка при отклонении бренда' });
  }
}

// Получение информации о текущем бренде пользователя
async function getMyBrand(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId, role: 'BRAND' }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    const brand = await Brand.findOne({ email: user.email }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    res.json(brand);
  } catch (error) {
    console.error('Ошибка при получении бренда:', error);
    res.status(500).json({ error: 'Ошибка при получении бренда' });
  }
}

// Получение настроек бренда
async function getMyBrandSettings(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId, role: 'BRAND' }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    const brand = await Brand.findOne({ email: user.email }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Возвращаем только настройки (исключаем служебные поля)
    const settings = {
      id: brand.id,
      name: brand.name,
      email: brand.email,
      country: brand.country,
      city: brand.city,
      categoryId: brand.categoryId,
      logoUrl: brand.logoUrl,
      contactName: brand.contactName,
      phone: brand.phone,
      isAccepted: brand.isAccepted,
      createdAt: brand.createdAt,
      updatedAt: brand.updatedAt
    };

    res.json(settings);
  } catch (error) {
    console.error('Ошибка при получении настроек бренда:', error);
    res.status(500).json({ error: 'Ошибка при получении настроек бренда' });
  }
}

// Обновление настроек бренда
async function updateMyBrandSettings(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId, role: 'BRAND' }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    const brand = await Brand.findOne({ email: user.email }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    const {
      name,
      country,
      city,
      categoryId,
      logoUrl,
      contactName,
      phone
    } = req.body;

    // Получаем старые данные для логирования
    const oldBrand = brand;
    const update = { updatedAt: new Date() };
    const changes = [];

    // Валидация и обновление полей
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Имя должно быть непустой строкой' });
      }
      update.name = name.trim();
      if (oldBrand.name !== name.trim()) {
        changes.push(`имя: "${oldBrand.name}" → "${name.trim()}"`);
      }
    }

    if (country !== undefined) {
      if (typeof country !== 'string' || country.trim().length === 0) {
        return res.status(400).json({ error: 'Страна должна быть непустой строкой' });
      }
      update.country = country.trim();
      if (oldBrand.country !== country.trim()) {
        changes.push(`страна: "${oldBrand.country}" → "${country.trim()}"`);
      }
    }

    if (city !== undefined) {
      update.city = city === null || city === '' ? null : city.trim();
      if (oldBrand.city !== update.city) {
        changes.push(`город: "${oldBrand.city || 'не указан'}" → "${update.city || 'не указан'}"`);
      }
    }

    if (categoryId !== undefined) {
      if (typeof categoryId !== 'string' || categoryId.trim().length === 0) {
        return res.status(400).json({ error: 'ID категории должен быть непустой строкой' });
      }
      // Проверяем существование категории
      const category = await Category.findOne({ id: categoryId }).lean();
      if (!category) {
        return res.status(400).json({ error: 'Категория не найдена' });
      }
      update.categoryId = categoryId;
      if (oldBrand.categoryId !== categoryId) {
        changes.push(`категория обновлена`);
      }
    }

    if (logoUrl !== undefined) {
      update.logoUrl = logoUrl === null || logoUrl === '' ? null : logoUrl;
      if (oldBrand.logoUrl !== update.logoUrl) {
        changes.push('логотип обновлен');
      }
    }

    if (contactName !== undefined) {
      update.contactName = contactName === null || contactName === '' ? null : contactName.trim();
      if (oldBrand.contactName !== update.contactName) {
        changes.push(`контактное лицо: "${oldBrand.contactName || 'не указано'}" → "${update.contactName || 'не указано'}"`);
      }
    }

    if (phone !== undefined) {
      update.phone = phone === null || phone === '' ? null : phone.trim();
      if (oldBrand.phone !== update.phone) {
        changes.push(`телефон: "${oldBrand.phone || 'не указан'}" → "${update.phone || 'не указан'}"`);
      }
    }

    // Проверяем, есть ли что обновлять
    if (Object.keys(update).length === 1) {
      // Только updatedAt
      return res.status(400).json({ error: 'Нет полей для обновления' });
    }

    const updatedBrand = await Brand.findOneAndUpdate(
      { id: brand.id },
      update,
      { new: true }
    ).lean();

    if (!updatedBrand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Обновляем firstName пользователя, если изменилось contactName
    if (contactName !== undefined && contactName !== null && contactName.trim() !== '') {
      await User.findOneAndUpdate(
        { id: userId },
        { firstName: contactName.trim() },
        { new: true }
      );
    }

    res.json(updatedBrand);
  } catch (error) {
    console.error('Ошибка при обновлении настроек бренда:', error);
    res.status(500).json({ error: 'Ошибка при обновлении настроек бренда' });
  }
}

// Получение статистики поисков по бренду
async function getBrandSearchStatistics(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId, role: 'BRAND' }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    const brand = await Brand.findOne({ email: user.email }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Параметры фильтрации
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    const limit = parseInt(req.query.limit) || 50;

    // Формируем запрос для поиска логов
    const query = { brandId: brand.id };
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = startDate;
      }
      if (endDate) {
        query.createdAt.$lte = endDate;
      }
    }

    // Получаем все логи поисков для этого бренда
    // Ищем по brandId или по brandName (для обратной совместимости)
    const searchLogs = await ProductSearchLog.find({
      $or: [
        { brandId: brand.id },
        { brandName: { $regex: new RegExp(brand.name, 'i') } }
      ],
      ...(query.createdAt ? { createdAt: query.createdAt } : {})
    })
      .sort({ createdAt: -1 })
      .limit(1000) // Ограничиваем для производительности
      .lean();

    // Агрегируем статистику по товарам
    const productStats = new Map();

    searchLogs.forEach(log => {
      if (log.productId && log.searchResult === 'FOUND') {
        if (!productStats.has(log.productId)) {
          productStats.set(log.productId, {
            productId: log.productId,
            productName: log.productName || 'Неизвестный товар',
            searchCount: 0,
            lastSearched: null,
            queries: []
          });
        }

        const stat = productStats.get(log.productId);
        stat.searchCount += 1;
        if (!stat.lastSearched || new Date(log.createdAt) > new Date(stat.lastSearched)) {
          stat.lastSearched = log.createdAt;
        }
        if (log.searchQuery && !stat.queries.includes(log.searchQuery)) {
          stat.queries.push(log.searchQuery);
        }
      }
    });

    // Преобразуем в массив и сортируем по количеству поисков
    const topProducts = Array.from(productStats.values())
      .sort((a, b) => b.searchCount - a.searchCount)
      .slice(0, limit)
      .map(stat => ({
        productId: stat.productId,
        productName: stat.productName,
        searchCount: stat.searchCount,
        lastSearched: stat.lastSearched,
        topQueries: stat.queries.slice(0, 5) // Топ 5 запросов для этого товара
      }));

    // Общая статистика
    const totalSearches = searchLogs.length;
    const foundSearches = searchLogs.filter(log => log.searchResult === 'FOUND').length;
    const notFoundSearches = searchLogs.filter(log => log.searchResult === 'NOT_FOUND').length;
    const clarificationNeeded = searchLogs.filter(log => log.searchResult === 'CLARIFICATION_NEEDED').length;

    // Статистика по брендам (если есть поиски с указанием бренда)
    const brandSearchCount = searchLogs.filter(log => 
      log.intent && log.intent.brand && 
      log.intent.brand.toLowerCase().includes(brand.name.toLowerCase())
    ).length;

    res.json({
      brand: {
        id: brand.id,
        name: brand.name
      },
      period: {
        startDate: startDate ? startDate.toISOString() : null,
        endDate: endDate ? endDate.toISOString() : null
      },
      summary: {
        totalSearches,
        foundSearches,
        notFoundSearches,
        clarificationNeeded,
        uniqueProductsFound: productStats.size,
        brandSearchCount
      },
      topProducts
    });
  } catch (error) {
    console.error('Ошибка при получении статистики поисков:', error);
    res.status(500).json({ error: 'Ошибка при получении статистики поисков' });
  }
}

// Валидация изображения товара
async function validateProductImageForBrand(req, res) {
  try {
    console.log('=== Валидация изображения товара ===');
    console.log('req.body:', req.body);
    console.log('req.file:', req.file ? { name: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype } : null);
    
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    // Проверяем, что пользователь является брендом
    const user = await User.findOne({ id: userId, role: 'BRAND' }).lean();
    if (!user) {
      return res.status(403).json({ error: 'Доступ разрешен только брендам' });
    }

    const brand = await Brand.findOne({ email: user.email }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Получаем файл изображения
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Изображение не передано' });
    }

    // Проверяем тип файла
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return res.status(400).json({ 
        error: 'Недопустимый тип файла. Разрешены: JPEG, PNG, WebP' 
      });
    }

    // Получаем название товара из запроса
    // Multer может поместить поля формы в req.body, но иногда они могут быть в другом формате
    const name = req.body?.name || req.body?.productName || null;
    
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      console.log('Получен запрос валидации изображения:', {
        body: req.body,
        hasFile: !!file,
        bodyKeys: Object.keys(req.body || {})
      });
      return res.status(400).json({ error: 'Не указано название товара' });
    }

    // Подготавливаем информацию о товаре для валидации
    const productInfo = {
      name: name.trim(),
      brandName: brand.name,
      sku: null,
      packageInfo: null,
      description: null
    };

    // Выполняем валидацию через Gemini API
    try {
      const validationResult = await validateProductImage({
        buffer: file.buffer,
        mimeType: file.mimetype,
        productInfo
      });

      console.log('Результат валидации от Gemini:', JSON.stringify(validationResult, null, 2));

      // Определяем общий статус валидации (только проверка на лишние элементы)
      const isValid = validationResult.isValid === true && 
                      validationResult.hasExtraElements === false;

      // Собираем причины отказа
      const reasons = [];
      
      if (validationResult.hasExtraElements === true) {
        // Добавляем конкретные проблемы из issues
        if (validationResult.issues && validationResult.issues.length > 0) {
          reasons.push(...validationResult.issues);
        } else {
          reasons.push('На изображении есть лишние элементы (рамки, фоны, другие объекты)');
        }
      }

      // Формируем краткое сообщение
      let message = isValid 
        ? 'Изображение прошло валидацию' 
        : 'Изображение не прошло валидацию';

      if (reasons.length > 0) {
        message += '. Причины: ' + reasons.join('; ');
      }

      // Возвращаем упрощенный результат
      res.json({
        isValid,
        message,
        reasons: reasons
      });
    } catch (geminiError) {
      console.error('Ошибка при валидации изображения через Gemini:', geminiError);
      return res.status(500).json({ 
        error: 'Ошибка при анализе изображения',
        details: geminiError.message 
      });
    }
  } catch (error) {
    console.error('Ошибка при валидации изображения товара:', error);
    res.status(500).json({ error: 'Ошибка при валидации изображения товара' });
  }
}

module.exports = {
  createBrand,
  getBrandById,
  getBrands,
  getPendingBrands,
  approveBrand,
  rejectBrand,
  updateBrand,
  deleteBrand,
  getMyBrand,
  getMyBrandSettings,
  updateMyBrandSettings,
  getBrandSearchStatistics,
  validateProductImageForBrand
};
