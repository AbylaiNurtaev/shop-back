const express = require('express');
const router = express.Router();
const {
  upload,
  createSession,
  getSession,
  createConversation,
  getConversation,
  postMessage,
  createSearch,
  getSearch,
  uploadAttachment,
  uploadVoice,
  getHistory,
  exportHistory,
  deleteHistory
} = require('../controllers/customerController');

router.post('/sessions', createSession);
router.get('/sessions/:sessionId', getSession);

router.post('/conversations', createConversation);
router.get('/conversations/:conversationId', getConversation);
router.post('/conversations/:conversationId/messages', postMessage);

router.post('/search', createSearch);
router.get('/search/:requestId', getSearch);

router.post('/attachments', upload.single('file'), uploadAttachment);
router.post('/voice', upload.single('file'), uploadVoice);

router.get('/history', getHistory);
router.get('/history/export', exportHistory);
router.delete('/history', deleteHistory);

module.exports = router;

