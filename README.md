# Backend Shop API

Backend API для магазина на Node.js Express.

## Установка

```bash
npm install
```

## Запуск

```bash
# Режим разработки (с nodemon)
npm run dev

# Продакшн режим
npm start
```

## Переменные окружения

Создайте файл `.env`:

```
PORT=3000
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRES_IN=3600
MONGO_URL=mongodb://localhost:27017/inventory
AWS_ACCESS_KEY=your-access-key
AWS_SECRET_KEY=your-secret-key
AWS_BUCKET_NAME=your-bucket
AWS_S3_REGION=eu-north-1
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-pass
SMTP_FROM_NAME=Inventory Admin
SMTP_FROM_EMAIL=your-smtp-user
```

## API Endpoints

### Авторизация

- `POST /api/auth/login` - Авторизация пользователя

### Пользователи

- `POST /api/users` - Создание пользователя
- `GET /api/users` - Получение списка пользователей
- `GET /api/users/:userId` - Получение пользователя по ID
- `PUT /api/users/:userId` - Обновление пользователя
- `DELETE /api/users/:userId` - Удаление пользователя

### Магазины

- `POST /api/stores` - Создание магазина
- `GET /api/stores` - Получение списка магазинов
- `GET /api/stores/:storeId` - Получение магазина по ID
- `PUT /api/stores/:storeId` - Обновление магазина
- `DELETE /api/stores/:storeId` - Удаление магазина

### Категории

- `GET /api/categories` - Получение списка категорий
- `GET /api/categories/:categoryId` - Получение категории по ID

### Товары

- `POST /api/products` - Создание товара
- `GET /api/products` - Получение списка товаров
- `GET /api/products/:productId` - Получение товара по ID
- `PUT /api/products/:productId` - Обновление товара
- `DELETE /api/products/:productId` - Удаление товара
- `POST /api/products/search` - Поиск товаров с геолокацией

### Офферы

- `POST /api/offers` - Создание оффера
- `GET /api/offers` - Получение списка офферов
- `GET /api/offers/:offerId` - Получение оффера по ID
- `PUT /api/offers/:offerId` - Обновление оффера
- `DELETE /api/offers/:offerId` - Удаление оффера

## Авторизация

Все эндпойнты (кроме `/api/auth/login`) требуют авторизации через Bearer токен:

```
Authorization: Bearer <accessToken>
```

## Тестовые учетные данные

- `admin:admin` (base64: `YWRtaW46YWRtaW4=`)
- `user:password` (base64: `dXNlcjpwYXNzd29yZA==`)

Учетные данные и базовые категории автоматически создаются при запуске, если
соответствующие коллекции пустые.

## Структура проекта

```
backend-shop/
├── controllers/     # Контроллеры для обработки запросов
├── middleware/      # Middleware (авторизация)
├── models/          # Модели данных и подключение к MongoDB
├── routes/          # Роутеры
├── utils/           # Утилиты (JWT, UUID, расстояние)
├── server.js        # Главный файл приложения
└── package.json     # Зависимости проекта
```
