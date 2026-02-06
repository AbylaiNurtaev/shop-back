const express = require('express');
const router = express.Router();
const { handleWappiWebhook } = require('../controllers/wappiController');

// Webhook для получения сообщений от Wappi
router.post('/webhook', handleWappiWebhook);

module.exports = router;
