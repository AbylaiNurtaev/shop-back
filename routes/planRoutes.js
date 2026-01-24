const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createPlan,
  getMyPlans,
  getSalesRepresentativePlans,
  updatePlan,
  deletePlan,
  createCategoryPlan,
  getMyCategoryPlans,
  getSalesRepresentativeCategoryPlans,
  updateCategoryPlan,
  deleteCategoryPlan
} = require('../controllers/planController');

router.use(authenticateToken);

// Эндпоинты для торговых представителей
router.get('/me', getMyPlans);

// Эндпоинты для дистрибьюторов
router.post('/', createPlan);
router.get('/sales-representatives/:salesRepresentativeId', getSalesRepresentativePlans);
router.put('/:planId', updatePlan);
router.delete('/:planId', deletePlan);

// Эндпоинты для планов по категориям - торговые представители
router.get('/categories/me', getMyCategoryPlans);

// Эндпоинты для планов по категориям - дистрибьюторы
router.post('/categories', createCategoryPlan);
router.get('/categories/sales-representatives/:salesRepresentativeId', getSalesRepresentativeCategoryPlans);
router.put('/categories/:planId', updateCategoryPlan);
router.delete('/categories/:planId', deleteCategoryPlan);

module.exports = router;
