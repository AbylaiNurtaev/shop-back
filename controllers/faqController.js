const { getCustomerFAQResponse } = require('../utils/gemini');

/**
 * Обработка FAQ запроса от пользователя (универсальный для всех ролей)
 * POST /api/faq
 */
async function handleFAQ(req, res) {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    }

    // Получаем роль пользователя из токена (если есть)
    const userRole = req.user && req.user.role ? req.user.role : null;

    // Получаем ответ от FAQ чата
    const response = await getCustomerFAQResponse({
      message: message.trim(),
      userRole: userRole
    });

    res.json({
      success: true,
      response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Ошибка при обработке FAQ запроса:', error);
    res.status(500).json({
      error: 'Ошибка при обработке запроса',
      message: error.message
    });
  }
}

module.exports = {
  handleFAQ
};
