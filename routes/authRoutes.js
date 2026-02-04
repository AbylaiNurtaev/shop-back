const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { login, registerAdmin, sendVerificationCode, verifyCode, registerDistributor, registerSalesRepresentative, registerStoreSeller, sendPhoneVerificationCode, verifyPhoneCode } = require('../controllers/authController');

// Rate limiting для отправки кодов верификации по телефону (более строгий)
const phoneCodeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 час
    max: 10, // максимум 10 кодов в час с одного IP
    message: {
        error: 'Слишком много запросов. Пожалуйста, попробуйте позже.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

router.post('/login', login);
router.post('/register-admin', registerAdmin);
router.post('/register-distributor', registerDistributor);
router.post('/register-sales-representative', registerSalesRepresentative);
router.post('/register-store-seller', registerStoreSeller);
router.post('/verification/send', sendVerificationCode);
router.post('/verification/verify', verifyCode);
router.post('/verification/phone/send', phoneCodeLimiter, sendPhoneVerificationCode);
router.post('/verification/phone/verify', verifyPhoneCode);

module.exports = router;
