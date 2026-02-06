const express = require('express');
const router = express.Router();
const { optionalAuthenticateToken } = require('../middleware/auth');
const { handleFAQ } = require('../controllers/faqController');

// Универсальный FAQ-чат для всех ролей (авторизация опциональна)
router.post('/', optionalAuthenticateToken, handleFAQ);

module.exports = router;
