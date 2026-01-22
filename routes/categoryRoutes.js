const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
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
} = require('../controllers/categoryController');

// Публичные эндпоинты (не требуют авторизации)
router.get('/', getCategories);

// Эндпоинты для брендов (требуют авторизации для получения brandId)
router.post('/requests', authenticateToken, createCategoryRequest);

// Публичный эндпоинт для получения категории по ID
// Размещен здесь, чтобы не перехватывать маршруты /requests/*
router.get('/:categoryId', getCategoryById);

// CRUD операции с категориями (без проверки токенов)
router.post('/', createCategory);
router.put('/:categoryId', updateCategory);
router.delete('/:categoryId', deleteCategory);

// Работа с заявками на категории (без проверки токенов)
router.get('/requests/all', getCategoryRequests);
router.get('/requests/pending', getPendingCategoryRequests);
router.post('/requests/:requestId/approve', approveCategoryRequest);
router.post('/requests/:requestId/reject', rejectCategoryRequest);

module.exports = router;
