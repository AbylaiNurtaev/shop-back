require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const storeRoutes = require('./routes/storeRoutes');
const storeExpenseRoutes = require('./routes/storeExpenseRoutes');
const distributorRoutes = require('./routes/distributorRoutes');
const salesRepRoutes = require('./routes/salesRepRoutes');
const brandRoutes = require('./routes/brandRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const productRoutes = require('./routes/productRoutes');
const offerRoutes = require('./routes/offerRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const customerRoutes = require('./routes/customerRoutes');
const warehouseRoutes = require('./routes/warehouseRoutes');
const posRoutes = require('./routes/posRoutes');
const planRoutes = require('./routes/planRoutes');
const aiAssistantRoutes = require('./routes/aiAssistantRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const faqRoutes = require('./routes/faqRoutes');
const wappiRoutes = require('./routes/wappiRoutes');
const { connectToDatabase } = require('./models/database');
const { checkAndDisableExpiredPayments } = require('./utils/paymentExpiration');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Ограничение размера тела запроса
// Для webhook от Wappi может потребоваться больший лимит
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// Роуты
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/store-expenses', storeExpenseRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/sales-reps', salesRepRoutes);
app.use('/api/sales-representatives', salesRepRoutes); // Алиас для совместимости
app.use('/api/brands', brandRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/warehouse', warehouseRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/ai-assistant', aiAssistantRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/faq', faqRoutes);
app.use('/api/wappi', wappiRoutes);

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// 404 обработчик
app.use((req, res) => {
  res.status(404).json({ error: 'Маршрут не найден' });
});

// Запуск сервера
async function startServer() {
  try {
    await connectToDatabase();

    // Проверяем истечение оплаты при старте сервера
    try {
      await checkAndDisableExpiredPayments();
    } catch (error) {
      console.warn('Ошибка при проверке истечения оплаты при старте:', error.message);
    }

    // Настраиваем периодическую проверку истечения оплаты (каждый час)
    setInterval(async () => {
      try {
        await checkAndDisableExpiredPayments();
      } catch (error) {
        console.warn('Ошибка при периодической проверке истечения оплаты:', error.message);
      }
    }, 60 * 60 * 1000); // 1 час в миллисекундах

    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
      console.log(`API доступен по адресу http://localhost:${PORT}/api`);
      console.log('Автоматическая проверка истечения оплаты товаров настроена (каждый час)');
    });
  } catch (error) {
    console.error('Критическая ошибка при запуске сервера:', error.message);
    console.error('Детали ошибки:', error);
    // Даем время для логирования перед завершением
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
}

// Обработка необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Необработанное отклонение промиса:', reason);
  // Не завершаем процесс, чтобы сервер продолжал работать
});

process.on('uncaughtException', (error) => {
  console.error('Необработанное исключение:', error);
  // Даем время для логирования перед завершением
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

startServer();

module.exports = app;
