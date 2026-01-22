const { models } = require('../models/database');
const { generateId } = require('../utils/uuid');
const { sendEmail } = require('../utils/email');

const { Category, CategoryRequest, Brand } = models;

// Получить все категории с иерархией
async function getCategories(req, res) {
  try {
    const categories = await Category.find({}).lean();
    
    // Строим иерархию: основные категории и их подкатегории
    const mainCategories = categories.filter(cat => !cat.parentCategoryId);
    const subCategories = categories.filter(cat => cat.parentCategoryId);
    
    const categoriesWithSubs = mainCategories.map(mainCat => {
      const subs = subCategories.filter(sub => sub.parentCategoryId === mainCat.id);
      return {
        ...mainCat,
        subCategories: subs
      };
    });
    
    // Добавляем подкатегории, у которых родительская категория не найдена
    const orphanSubs = subCategories.filter(sub => {
      return !categories.find(cat => cat.id === sub.parentCategoryId);
    });

    res.json({
      items: categoriesWithSubs,
      subCategories: orphanSubs,
      total: categories.length
    });
  } catch (error) {
    console.error('Ошибка при получении списка категорий:', error);
    res.status(500).json({ error: 'Ошибка при получении списка категорий' });
  }
}

// Получить категорию по ID
async function getCategoryById(req, res) {
  try {
    const { categoryId } = req.params;
    const category = await Category.findOne({ id: categoryId }).lean();

    if (!category) {
      return res.status(404).json({ error: 'Категория не найдена' });
    }

    // Если это подкатегория, получаем родительскую категорию
    if (category.parentCategoryId) {
      const parentCategory = await Category.findOne({ id: category.parentCategoryId }).lean();
      return res.json({
        ...category,
        parentCategory
      });
    }

    // Если это основная категория, получаем все подкатегории
    const subCategories = await Category.find({ parentCategoryId: categoryId }).lean();
    return res.json({
      ...category,
      subCategories
    });
  } catch (error) {
    console.error('Ошибка при получении категории:', error);
    res.status(500).json({ error: 'Ошибка при получении категории' });
  }
}

// Создать категорию (только для администраторов)
async function createCategory(req, res) {
  try {
    const { name, description, parentCategoryId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Название категории обязательно' });
    }

    // Если указана родительская категория, проверяем её существование
    if (parentCategoryId) {
      const parentCategory = await Category.findOne({ id: parentCategoryId }).lean();
      if (!parentCategory) {
        return res.status(400).json({ error: 'Родительская категория не найдена' });
      }
    }

    // Проверяем, что категория с таким именем не существует
    const existingCategory = await Category.findOne({ 
      name, 
      parentCategoryId: parentCategoryId || null 
    }).lean();
    
    if (existingCategory) {
      return res.status(409).json({ error: 'Категория с таким именем уже существует' });
    }

    const category = await Category.create({
      id: generateId(),
      name,
      description: description || null,
      parentCategoryId: parentCategoryId || null
    });

    res.status(201).json(category.toObject());
  } catch (error) {
    console.error('Ошибка при создании категории:', error);
    res.status(500).json({ error: 'Ошибка при создании категории' });
  }
}

// Обновить категорию (только для администраторов)
async function updateCategory(req, res) {
  try {
    const { categoryId } = req.params;
    const { name, description, parentCategoryId } = req.body;

    const category = await Category.findOne({ id: categoryId }).lean();
    if (!category) {
      return res.status(404).json({ error: 'Категория не найдена' });
    }

    // Если изменяется родительская категория, проверяем её существование
    if (parentCategoryId !== undefined) {
      if (parentCategoryId) {
        const parentCategory = await Category.findOne({ id: parentCategoryId }).lean();
        if (!parentCategory) {
          return res.status(400).json({ error: 'Родительская категория не найдена' });
        }
        // Нельзя сделать категорию родителем самой себя
        if (parentCategoryId === categoryId) {
          return res.status(400).json({ error: 'Категория не может быть родителем самой себя' });
        }
      }
    }

    // Проверяем уникальность имени, если оно изменяется
    if (name && name !== category.name) {
      const existingCategory = await Category.findOne({ 
        name, 
        parentCategoryId: parentCategoryId !== undefined ? parentCategoryId : category.parentCategoryId,
        id: { $ne: categoryId }
      }).lean();
      
      if (existingCategory) {
        return res.status(409).json({ error: 'Категория с таким именем уже существует' });
      }
    }

    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (parentCategoryId !== undefined) update.parentCategoryId = parentCategoryId || null;

    const updatedCategory = await Category.findOneAndUpdate(
      { id: categoryId },
      update,
      { new: true }
    ).lean();

    if (!updatedCategory) {
      return res.status(404).json({ error: 'Категория не найдена' });
    }

    res.json(updatedCategory);
  } catch (error) {
    console.error('Ошибка при обновлении категории:', error);
    res.status(500).json({ error: 'Ошибка при обновлении категории' });
  }
}

// Удалить категорию (только для администраторов)
async function deleteCategory(req, res) {
  try {
    const { categoryId } = req.params;

    const category = await Category.findOne({ id: categoryId }).lean();
    if (!category) {
      return res.status(404).json({ error: 'Категория не найдена' });
    }

    // Проверяем, есть ли подкатегории
    const subCategories = await Category.find({ parentCategoryId: categoryId }).lean();
    if (subCategories.length > 0) {
      return res.status(400).json({ 
        error: 'Невозможно удалить категорию, у которой есть подкатегории. Сначала удалите все подкатегории.' 
      });
    }

    // Проверяем, используется ли категория в продуктах (можно добавить проверку через Product модель)
    // Пока просто удаляем

    const result = await Category.deleteOne({ id: categoryId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Категория не найдена' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Ошибка при удалении категории:', error);
    res.status(500).json({ error: 'Ошибка при удалении категории' });
  }
}

// Создать заявку на создание категории (для брендов)
async function createCategoryRequest(req, res) {
  try {
    const { name, description, parentCategoryId, parentCategoryName, brandId: bodyBrandId } = req.body;
    // Используем brandId из тела запроса, если он есть, иначе из токена
    const brandId = bodyBrandId || (req.user && req.user.brandId);

    if (!brandId) {
      return res.status(403).json({ error: 'Только бренды могут создавать заявки на категории' });
    }

    if (!name) {
      return res.status(400).json({ error: 'Название категории обязательно' });
    }

    // Проверяем, что бренд существует
    const brand = await Brand.findOne({ id: brandId }).lean();
    if (!brand) {
      return res.status(404).json({ error: 'Бренд не найден' });
    }

    // Если указана родительская категория по ID, проверяем её существование
    if (parentCategoryId) {
      const parentCategory = await Category.findOne({ id: parentCategoryId }).lean();
      if (!parentCategory) {
        return res.status(400).json({ error: 'Родительская категория не найдена' });
      }
    }

    // Если указано parentCategoryName, но нет parentCategoryId, 
    // проверяем, существует ли уже такая родительская категория
    let resolvedParentCategoryId = parentCategoryId;
    if (parentCategoryName && !parentCategoryId) {
      const existingParentCategory = await Category.findOne({ 
        name: parentCategoryName,
        parentCategoryId: null
      }).lean();
      
      if (existingParentCategory) {
        resolvedParentCategoryId = existingParentCategory.id;
      }
    }

    // Проверяем, нет ли уже такой категории
    const existingCategory = await Category.findOne({ 
      name, 
      parentCategoryId: resolvedParentCategoryId || null 
    }).lean();
    
    if (existingCategory) {
      return res.status(409).json({ error: 'Категория с таким именем уже существует' });
    }

    // Проверяем, нет ли уже активной заявки от этого бренда на такую же категорию
    const existingRequest = await CategoryRequest.findOne({
      brandId,
      name,
      $or: [
        { parentCategoryId: resolvedParentCategoryId || null },
        { parentCategoryName: parentCategoryName || null }
      ],
      status: 'PENDING'
    }).lean();

    if (existingRequest) {
      return res.status(409).json({ error: 'У вас уже есть активная заявка на создание этой категории' });
    }

    const categoryRequest = await CategoryRequest.create({
      id: generateId(),
      brandId,
      name,
      description: description || null,
      parentCategoryId: resolvedParentCategoryId || null,
      parentCategoryName: parentCategoryName || null,
      status: 'PENDING'
    });

    res.status(201).json(categoryRequest.toObject());
  } catch (error) {
    console.error('Ошибка при создании заявки на категорию:', error);
    res.status(500).json({ error: 'Ошибка при создании заявки на категорию' });
  }
}

// Получить все заявки на категории (для администраторов)
async function getCategoryRequests(req, res) {
  try {
    const categoryRequests = await CategoryRequest.find({})
      .sort({ createdAt: -1 })
      .lean();

    // Получаем информацию о брендах
    const brandIds = [...new Set(categoryRequests.map(req => req.brandId))];
    const brands = await Brand.find({ id: { $in: brandIds } }).lean();
    const brandMap = new Map(brands.map(b => [b.id, b]));

    const requestsWithBrands = categoryRequests.map(request => ({
      ...request,
      brand: brandMap.get(request.brandId) || null
    }));

    res.json({
      items: requestsWithBrands,
      total: requestsWithBrands.length
    });
  } catch (error) {
    console.error('Ошибка при получении заявок на категории:', error);
    res.status(500).json({ error: 'Ошибка при получении заявок на категории' });
  }
}

// Получить ожидающие заявки на категории (для администраторов)
async function getPendingCategoryRequests(req, res) {
  try {
    const categoryRequests = await CategoryRequest.find({ status: 'PENDING' })
      .sort({ createdAt: -1 })
      .lean();

    // Получаем информацию о брендах
    const brandIds = [...new Set(categoryRequests.map(req => req.brandId))];
    const brands = await Brand.find({ id: { $in: brandIds } }).lean();
    const brandMap = new Map(brands.map(b => [b.id, b]));

    const requestsWithBrands = categoryRequests.map(request => ({
      ...request,
      brand: brandMap.get(request.brandId) || null
    }));

    res.json({
      items: requestsWithBrands,
      total: requestsWithBrands.length
    });
  } catch (error) {
    console.error('Ошибка при получении ожидающих заявок на категории:', error);
    res.status(500).json({ error: 'Ошибка при получении ожидающих заявок на категории' });
  }
}

// Одобрить заявку на категорию (для администраторов)
async function approveCategoryRequest(req, res) {
  try {
    const { requestId } = req.params;

    const categoryRequest = await CategoryRequest.findOne({ id: requestId }).lean();
    if (!categoryRequest) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    if (categoryRequest.status !== 'PENDING') {
      return res.status(400).json({ error: 'Заявка уже обработана' });
    }

    let parentCategoryId = categoryRequest.parentCategoryId;

    // Если указано parentCategoryName, но нет parentCategoryId, создаем родительскую категорию
    if (categoryRequest.parentCategoryName && !parentCategoryId) {
      // Проверяем, существует ли уже такая родительская категория
      let parentCategory = await Category.findOne({ 
        name: categoryRequest.parentCategoryName,
        parentCategoryId: null
      }).lean();

      if (!parentCategory) {
        // Создаем родительскую категорию
        parentCategory = await Category.create({
          id: generateId(),
          name: categoryRequest.parentCategoryName,
          description: null,
          parentCategoryId: null
        });
      }
      parentCategoryId = parentCategory.id;
    }

    // Проверяем, не создана ли уже такая категория
    const existingCategory = await Category.findOne({ 
      name: categoryRequest.name, 
      parentCategoryId: parentCategoryId || null 
    }).lean();
    
    if (existingCategory) {
      // Обновляем статус заявки на отклоненную
      await CategoryRequest.findOneAndUpdate(
        { id: requestId },
        { 
          status: 'REJECTED', 
          rejectedReason: 'Категория с таким именем уже существует',
          updatedAt: new Date() 
        }
      );
      return res.status(409).json({ error: 'Категория с таким именем уже существует' });
    }

    // Создаем категорию
    const category = await Category.create({
      id: generateId(),
      name: categoryRequest.name,
      description: categoryRequest.description || null,
      parentCategoryId: parentCategoryId || null
    });

    // Обновляем статус заявки
    await CategoryRequest.findOneAndUpdate(
      { id: requestId },
      { 
        status: 'ACCEPTED', 
        updatedAt: new Date() 
      }
    );

    // Отправляем уведомление бренду
    const brand = await Brand.findOne({ id: categoryRequest.brandId }).lean();
    if (brand && brand.email) {
      try {
        await sendEmail({
          to: brand.email,
          subject: 'Ваша заявка на создание категории одобрена',
          text: `Ваша заявка на создание категории "${categoryRequest.name}" была одобрена администратором.`
        });
      } catch (e) {
        console.error('Не удалось отправить email об одобрении заявки:', e);
      }
    }

    res.json({
      message: 'Заявка одобрена, категория создана',
      category: category.toObject(),
      request: {
        ...categoryRequest,
        status: 'ACCEPTED'
      }
    });
  } catch (error) {
    console.error('Ошибка при одобрении заявки на категорию:', error);
    res.status(500).json({ error: 'Ошибка при одобрении заявки на категорию' });
  }
}

// Отклонить заявку на категорию (для администраторов)
async function rejectCategoryRequest(req, res) {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;

    const categoryRequest = await CategoryRequest.findOne({ id: requestId }).lean();
    if (!categoryRequest) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    if (categoryRequest.status !== 'PENDING') {
      return res.status(400).json({ error: 'Заявка уже обработана' });
    }

    // Обновляем статус заявки
    await CategoryRequest.findOneAndUpdate(
      { id: requestId },
      { 
        status: 'REJECTED', 
        rejectedReason: reason || null,
        updatedAt: new Date() 
      }
    );

    // Отправляем уведомление бренду
    const brand = await Brand.findOne({ id: categoryRequest.brandId }).lean();
    if (brand && brand.email) {
      try {
        await sendEmail({
          to: brand.email,
          subject: 'Ваша заявка на создание категории отклонена',
          text: `Ваша заявка на создание категории "${categoryRequest.name}" была отклонена.${reason ? `\n\nПричина: ${reason}` : ''}`
        });
      } catch (e) {
        console.error('Не удалось отправить email об отклонении заявки:', e);
      }
    }

    const updatedRequest = await CategoryRequest.findOne({ id: requestId }).lean();
    res.json({
      message: 'Заявка отклонена',
      request: updatedRequest
    });
  } catch (error) {
    console.error('Ошибка при отклонении заявки на категорию:', error);
    res.status(500).json({ error: 'Ошибка при отклонении заявки на категорию' });
  }
}

module.exports = {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  createCategoryRequest,
  getCategoryRequests,
  getPendingCategoryRequests,
  approveCategoryRequest,
  rejectCategoryRequest
};
