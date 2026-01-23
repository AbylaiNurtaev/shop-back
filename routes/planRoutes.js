const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createPlan,
  getMyPlans,
  getSalesRepresentativePlans,
  updatePlan,
  deletePlan
} = require('../controllers/planController');

router.use(authenticateToken);

// Эндпоинты для торговых представителей
router.get('/me', getMyPlans);

// Эндпоинты для дистрибьюторов
router.post('/', createPlan);
router.get('/sales-representatives/:salesRepresentativeId', getSalesRepresentativePlans);
router.put('/:planId', updatePlan);
router.delete('/:planId', deletePlan);

module.exports = router;
