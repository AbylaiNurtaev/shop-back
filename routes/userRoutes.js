const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createUser,
  getUserById,
  getUsers,
  updateUser,
  deleteUser
} = require('../controllers/userController');

router.post('/', createUser);

router.use(authenticateToken);
router.get('/', getUsers);
router.get('/:userId', getUserById);
router.put('/:userId', updateUser);
router.delete('/:userId', deleteUser);

module.exports = router;
