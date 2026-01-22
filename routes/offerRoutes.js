const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createOffer,
  getOfferById,
  getOffers,
  updateOffer,
  deleteOffer
} = require('../controllers/offerController');

router.use(authenticateToken);

router.post('/', createOffer);
router.get('/', getOffers);
router.get('/:offerId', getOfferById);
router.put('/:offerId', updateOffer);
router.delete('/:offerId', deleteOffer);

module.exports = router;
