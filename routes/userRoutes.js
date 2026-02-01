const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createUser,
  getUserById,
  getUsers,
  updateUser,
  deleteUser,
  getMyUserSettings,
  updateMyUserSettings
} = require('../controllers/userController');

router.post('/', createUser);

router.use(authenticateToken);

// Эндпоинты для настроек текущего пользователя
router.get('/me/settings', getMyUserSettings);
router.put('/me/settings', updateMyUserSettings);

router.get('/', getUsers);
router.get('/:userId', getUserById);
router.put('/:userId', updateUser);
router.delete('/:userId', deleteUser);

module.exports = router;
