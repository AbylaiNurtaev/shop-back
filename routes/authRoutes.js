const express = require('express');
const router = express.Router();
const { login, registerAdmin, sendVerificationCode, verifyCode, registerDistributor, registerSalesRepresentative } = require('../controllers/authController');

router.post('/login', login);
router.post('/register-admin', registerAdmin);
router.post('/register-distributor', registerDistributor);
router.post('/register-sales-representative', registerSalesRepresentative);
router.post('/verification/send', sendVerificationCode);
router.post('/verification/verify', verifyCode);

module.exports = router;
