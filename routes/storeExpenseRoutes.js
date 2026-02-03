const express = require('express');
const router = express.Router();
const { authenticateToken, requireStoreOwner } = require('../middleware/auth');
const {
  createStoreExpense,
  getMyStoreExpenses,
  getStoreExpenseById,
  updateStoreExpense,
  deleteStoreExpense
} = require('../controllers/storeExpenseController');

// Все роуты требуют аутентификации и прав владельца магазина
router.use(authenticateToken);
router.use(requireStoreOwner);

// CRUD операции для расходов магазина
router.post('/', createStoreExpense);
router.get('/', getMyStoreExpenses);
router.get('/:expenseId', getStoreExpenseById);
router.put('/:expenseId', updateStoreExpense);
router.delete('/:expenseId', deleteStoreExpense);

module.exports = router;
