require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const storeRoutes = require('./routes/storeRoutes');
const distributorRoutes = require('./routes/distributorRoutes');
const salesRepRoutes = require('./routes/salesRepRoutes');
const brandRoutes = require('./routes/brandRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const productRoutes = require('./routes/productRoutes');
const offerRoutes = require('./routes/offerRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const customerRoutes = require('./routes/customerRoutes');
const { connectToDatabase } = require('./models/database');
const { checkAndDisableExpiredPayments } = require('./utils/paymentExpiration');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Роуты
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/sales-reps', salesRepRoutes);
app.use('/api/brands', brandRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/customer', customerRoutes);

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
    await checkAndDisableExpiredPayments();
    
    // Настраиваем периодическую проверку истечения оплаты (каждый час)
    setInterval(async () => {
      await checkAndDisableExpiredPayments();
    }, 60 * 60 * 1000); // 1 час в миллисекундах
    
    app.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
      console.log(`API доступен по адресу http://localhost:${PORT}/api`);
      console.log('Автоматическая проверка истечения оплаты товаров настроена (каждый час)');
    });
  } catch (error) {
    console.error('Ошибка подключения к MongoDB:', error.message);
    process.exit(1);
  }
}

startServer();

module.exports = app;
