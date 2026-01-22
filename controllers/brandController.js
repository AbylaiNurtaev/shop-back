const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');
const { hashPassword } = require('../utils/password');
const { sendEmail } = require('../utils/email');

const { Brand, Category, User, AuthCredential } = models;

async function createBrand(req, res) {
  let createdUserId = null;
  let createdBrandId = null;
  let email = null;

  try {
    const { name, country, categoryId, logoUrl, email: emailParam, password, contactName } = req.body;
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
        categoryId,
        logoUrl: logoUrl || null,
        email,
        contactName: contactName || null
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
    const { name, country, categoryId, logoUrl } = req.body;

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
    if (categoryId !== undefined) update.categoryId = categoryId;
    if (logoUrl !== undefined) update.logoUrl = logoUrl;

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

module.exports = {
  createBrand,
  getBrandById,
  getBrands,
  getPendingBrands,
  approveBrand,
  rejectBrand,
  updateBrand,
  deleteBrand
};
