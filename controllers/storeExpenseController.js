const { generateId } = require('../utils/uuid');
const { models } = require('../models/database');

const { StoreExpense, User } = models;

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

// Создание расхода
async function createStoreExpense(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, что у пользователя есть магазин
    if (!user.storeId) {
      return res.status(404).json({ error: 'Магазин не найден для данного пользователя' });
    }

    const { name, amount, currency } = req.body;

    if (!name || amount === undefined) {
      return res.status(400).json({ error: 'Отсутствуют обязательные поля: name, amount' });
    }

    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Название расхода должно быть непустой строкой' });
    }

    if (typeof amount !== 'number' || amount < 0) {
      return res.status(400).json({ error: 'Сумма должна быть неотрицательным числом' });
    }

    const expense = await StoreExpense.create({
      id: generateId(),
      storeId: user.storeId,
      storeOwnerId: userId,
      name: name.trim(),
      amount: amount,
      currency: currency || user.currency || 'KZT'
    });

    res.status(201).json(expense.toObject());
  } catch (error) {
    console.error('Ошибка при создании расхода:', error);
    res.status(500).json({ error: 'Ошибка при создании расхода' });
  }
}

// Получение всех расходов текущего магазина
async function getMyStoreExpenses(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, что у пользователя есть магазин
    if (!user.storeId) {
      return res.status(404).json({ error: 'Магазин не найден для данного пользователя' });
    }

    const expenses = await StoreExpense.find({ 
      storeId: user.storeId 
    })
    .sort({ createdAt: -1 })
    .lean();

    res.json({
      items: expenses,
      total: expenses.length
    });
  } catch (error) {
    console.error('Ошибка при получении расходов:', error);
    res.status(500).json({ error: 'Ошибка при получении расходов' });
  }
}

// Получение расхода по ID
async function getStoreExpenseById(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, что у пользователя есть магазин
    if (!user.storeId) {
      return res.status(404).json({ error: 'Магазин не найден для данного пользователя' });
    }

    const { expenseId } = req.params;
    const expense = await StoreExpense.findOne({ 
      id: expenseId,
      storeId: user.storeId 
    }).lean();

    if (!expense) {
      return res.status(404).json({ error: 'Расход не найден' });
    }

    res.json(expense);
  } catch (error) {
    console.error('Ошибка при получении расхода:', error);
    res.status(500).json({ error: 'Ошибка при получении расхода' });
  }
}

// Обновление расхода
async function updateStoreExpense(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, что у пользователя есть магазин
    if (!user.storeId) {
      return res.status(404).json({ error: 'Магазин не найден для данного пользователя' });
    }

    const { expenseId } = req.params;
    const { name, amount, currency } = req.body;

    // Проверяем существование расхода
    const existingExpense = await StoreExpense.findOne({ 
      id: expenseId,
      storeId: user.storeId 
    }).lean();

    if (!existingExpense) {
      return res.status(404).json({ error: 'Расход не найден' });
    }

    const update = { updatedAt: new Date() };

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Название расхода должно быть непустой строкой' });
      }
      update.name = name.trim();
    }

    if (amount !== undefined) {
      if (typeof amount !== 'number' || amount < 0) {
        return res.status(400).json({ error: 'Сумма должна быть неотрицательным числом' });
      }
      update.amount = amount;
    }

    if (currency !== undefined) {
      if (typeof currency !== 'string' || currency.trim().length === 0) {
        return res.status(400).json({ error: 'Валюта должна быть непустой строкой' });
      }
      update.currency = currency.trim();
    }

    // Проверяем, есть ли что обновлять
    if (Object.keys(update).length === 1) {
      // Только updatedAt
      return res.status(400).json({ error: 'Нет полей для обновления' });
    }

    const updatedExpense = await StoreExpense.findOneAndUpdate(
      { id: expenseId, storeId: user.storeId },
      update,
      { new: true }
    ).lean();

    if (!updatedExpense) {
      return res.status(404).json({ error: 'Расход не найден' });
    }

    res.json(updatedExpense);
  } catch (error) {
    console.error('Ошибка при обновлении расхода:', error);
    res.status(500).json({ error: 'Ошибка при обновлении расхода' });
  }
}

// Удаление расхода
async function deleteStoreExpense(req, res) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Токен доступа отсутствует' });
    }

    const user = await User.findOne({ id: userId }).lean();
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, что у пользователя есть магазин
    if (!user.storeId) {
      return res.status(404).json({ error: 'Магазин не найден для данного пользователя' });
    }

    const { expenseId } = req.params;

    const result = await StoreExpense.deleteOne({ 
      id: expenseId,
      storeId: user.storeId 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Расход не найден' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Ошибка при удалении расхода:', error);
    res.status(500).json({ error: 'Ошибка при удалении расхода' });
  }
}

module.exports = {
  createStoreExpense,
  getMyStoreExpenses,
  getStoreExpenseById,
  updateStoreExpense,
  deleteStoreExpense
};
