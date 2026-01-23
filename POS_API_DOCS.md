# Инструкция по использованию API кассы (POS)

## Содержание
1. [Обзор](#обзор)
2. [Авторизация](#авторизация)
3. [Работа с чеком](#работа-с-чеком)
4. [История и аналитика](#история-и-аналитика)
5. [Примеры использования](#примеры-использования)
6. [Обработка ошибок](#обработка-ошибок)

---

## Обзор

API кассы предназначен для продавцов магазина (роль `STORE_SELLER`). Позволяет:
- Создавать и управлять чеками
- Добавлять товары в чек по артикулу (SKU)
- Завершать продажи с автоматическим списанием товаров со склада
- Просматривать историю продаж и статистику

**Важно:** Все операции оптимизированы - одна запись продажи содержит все товары чека, что минимизирует количество записей в базе данных.

---

## Авторизация

Все эндпоинты требуют авторизации. Токен передается в заголовке:

```
Authorization: Bearer <accessToken>
```

Для получения токена используйте эндпоинт `POST /api/auth/login`.

**Требования:** Роль пользователя должна быть `STORE_SELLER` (продавец магазина).

---

## Работа с чеком

### 1. Получение текущего чернового чека

**Эндпоинт:** `GET /api/pos/sale/current`

Получает незавершенный чек продавца или создает новый, если его нет.

**Ответ:**
```json
{
  "sale": {
    "id": "sale_123",
    "storeId": "store_456",
    "sellerId": "user_789",
    "status": "DRAFT",
    "items": [],
    "totalAmount": 0,
    "currency": "RUB",
    "completedAt": null,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "updatedAt": "2024-01-15T10:00:00.000Z"
  }
}
```

**Пример запроса:**
```bash
curl -X GET http://localhost:3000/api/pos/sale/current \
  -H "Authorization: Bearer <accessToken>"
```

---

### 2. Создание нового чека

**Эндпоинт:** `POST /api/pos/sale`

Создает новый черновой чек.

**Ответ:**
```json
{
  "sale": {
    "id": "sale_123",
    "storeId": "store_456",
    "sellerId": "user_789",
    "status": "DRAFT",
    "items": [],
    "totalAmount": 0,
    "currency": "RUB",
    "completedAt": null
  },
  "message": "Чек создан"
}
```

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/pos/sale \
  -H "Authorization: Bearer <accessToken>"
```

---

### 3. Добавление товара в чек по артикулу

**Эндпоинт:** `POST /api/pos/sale/item`

Добавляет товар в чек по артикулу (SKU). Если товар уже есть в чеке, увеличивает его количество.

**Тело запроса:**
```json
{
  "saleId": "sale_123",
  "sku": "SKU-12345",
  "quantity": 2
}
```

**Параметры:**
- `saleId` (string, обязательный) - ID чека
- `sku` (string, обязательный) - Артикул (SKU) товара
- `quantity` (number, обязательный) - Количество товара (должно быть > 0)

**Ответ:**
```json
{
  "message": "Товар добавлен в чек",
  "sale": {
    "id": "sale_123",
    "storeId": "store_456",
    "sellerId": "user_789",
    "status": "DRAFT",
    "items": [
      {
        "productId": "product_789",
        "sku": "SKU-12345",
        "productName": "Товар 1",
        "quantity": 2,
        "price": 100,
        "totalPrice": 200,
        "currency": "RUB"
      }
    ],
    "totalAmount": 200,
    "currency": "RUB"
  }
}
```

**Ошибки:**
- `400 Bad Request` - Недостаточно товара на складе
- `404 Not Found` - Товар не найден

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/pos/sale/item \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "saleId": "sale_123",
    "sku": "SKU-12345",
    "quantity": 2
  }'
```

---

### 4. Обновление количества товара в чеке

**Эндпоинт:** `PUT /api/pos/sale/item`

Обновляет количество товара в чеке.

**Тело запроса:**
```json
{
  "saleId": "sale_123",
  "productId": "product_789",
  "quantity": 3
}
```

**Параметры:**
- `saleId` (string, обязательный) - ID чека
- `productId` (string, обязательный) - ID товара
- `quantity` (number, обязательный) - Новое количество (должно быть > 0, если 0 - товар удаляется)

**Ответ:**
```json
{
  "message": "Количество товара обновлено",
  "sale": {
    "id": "sale_123",
    "items": [
      {
        "productId": "product_789",
        "quantity": 3,
        "totalPrice": 300
      }
    ],
    "totalAmount": 300
  }
}
```

**Пример запроса:**
```bash
curl -X PUT http://localhost:3000/api/pos/sale/item \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "saleId": "sale_123",
    "productId": "product_789",
    "quantity": 3
  }'
```

---

### 5. Удаление товара из чека

**Эндпоинт:** `DELETE /api/pos/sale/item`

Удаляет товар из чека.

**Тело запроса:**
```json
{
  "saleId": "sale_123",
  "productId": "product_789"
}
```

**Параметры:**
- `saleId` (string, обязательный) - ID чека
- `productId` (string, обязательный) - ID товара

**Ответ:**
```json
{
  "message": "Товар удален из чека",
  "sale": {
    "id": "sale_123",
    "items": [],
    "totalAmount": 0
  }
}
```

**Пример запроса:**
```bash
curl -X DELETE http://localhost:3000/api/pos/sale/item \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "saleId": "sale_123",
    "productId": "product_789"
  }'
```

---

### 6. Завершение продажи (пробитие чека)

**Эндпоинт:** `POST /api/pos/sale/complete`

Завершает продажу, списывает товары со склада и сохраняет чек в истории.

**Тело запроса:**
```json
{
  "saleId": "sale_123"
}
```

**Параметры:**
- `saleId` (string, обязательный) - ID чека

**Ответ:**
```json
{
  "message": "Продажа завершена, товары списаны со склада",
  "sale": {
    "id": "sale_123",
    "status": "COMPLETED",
    "completedAt": "2024-01-15T10:30:00.000Z",
    "items": [
      {
        "productId": "product_789",
        "sku": "SKU-12345",
        "productName": "Товар 1",
        "quantity": 2,
        "price": 100,
        "totalPrice": 200,
        "currency": "RUB"
      }
    ],
    "totalAmount": 200,
    "currency": "RUB"
  }
}
```

**Ошибки:**
- `400 Bad Request` - Чек пуст или недостаточно товара на складе
- `404 Not Found` - Чек не найден

**Важно:** Операция выполняется атомарно (транзакция) - либо все товары списываются, либо ничего не списывается.

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/pos/sale/complete \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "saleId": "sale_123"
  }'
```

---

### 7. Отмена чека

**Эндпоинт:** `POST /api/pos/sale/cancel`

Отменяет черновой чек без списания товаров.

**Тело запроса:**
```json
{
  "saleId": "sale_123"
}
```

**Ответ:**
```json
{
  "message": "Чек отменен",
  "sale": {
    "id": "sale_123",
    "status": "CANCELLED"
  }
}
```

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/pos/sale/cancel \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "saleId": "sale_123"
  }'
```

---

## История и аналитика

### 1. Получение истории продаж

**Эндпоинт:** `GET /api/pos/sales`

Получает историю продаж продавца с пагинацией.

**Query параметры:**
- `page` (number, опционально) - Номер страницы (по умолчанию: 1)
- `limit` (number, опционально) - Количество записей на странице (по умолчанию: 20)
- `status` (string, опционально) - Фильтр по статусу (`DRAFT`, `COMPLETED`, `CANCELLED`)

**Ответ:**
```json
{
  "items": [
    {
      "id": "sale_123",
      "storeId": "store_456",
      "sellerId": "user_789",
      "status": "COMPLETED",
      "items": [
        {
          "productId": "product_789",
          "sku": "SKU-12345",
          "productName": "Товар 1",
          "quantity": 2,
          "price": 100,
          "totalPrice": 200,
          "currency": "RUB"
        }
      ],
      "totalAmount": 200,
      "currency": "RUB",
      "completedAt": "2024-01-15T10:30:00.000Z",
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  ],
  "total": 50,
  "page": 1,
  "limit": 20,
  "totalPages": 3
}
```

**Пример запроса:**
```bash
curl -X GET "http://localhost:3000/api/pos/sales?page=1&limit=20&status=COMPLETED" \
  -H "Authorization: Bearer <accessToken>"
```

---

### 2. Получение статистики продаж

**Эндпоинт:** `GET /api/pos/sales/statistics`

Получает статистику продаж за период.

**Query параметры:**
- `startDate` (ISO date string, опционально) - Начало периода (по умолчанию: 30 дней назад)
- `endDate` (ISO date string, опционально) - Конец периода (по умолчанию: сейчас)

**Ответ:**
```json
{
  "period": {
    "startDate": "2023-12-16T00:00:00.000Z",
    "endDate": "2024-01-15T23:59:59.999Z"
  },
  "summary": {
    "totalSales": 150,
    "totalRevenue": 45000,
    "averageSale": 300
  },
  "topProducts": [
    {
      "productId": "product_789",
      "productName": "Товар 1",
      "sku": "SKU-12345",
      "totalQuantity": 100,
      "totalRevenue": 10000
    }
  ]
}
```

**Пример запроса:**
```bash
curl -X GET "http://localhost:3000/api/pos/sales/statistics?startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer <accessToken>"
```

---

## Примеры использования

### Пример на JavaScript (React/Next.js)

```javascript
// posService.js
const API_BASE_URL = 'http://localhost:3000/api';

class POSService {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  // Получение текущего чека
  async getCurrentSale() {
    const response = await fetch(`${API_BASE_URL}/pos/sale/current`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Ошибка получения чека: ${response.statusText}`);
    }

    return await response.json();
  }

  // Добавление товара в чек
  async addItem(saleId, sku, quantity) {
    const response = await fetch(`${API_BASE_URL}/pos/sale/item`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ saleId, sku, quantity })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Ошибка добавления товара');
    }

    return await response.json();
  }

  // Завершение продажи
  async completeSale(saleId) {
    const response = await fetch(`${API_BASE_URL}/pos/sale/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ saleId })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Ошибка завершения продажи');
    }

    return await response.json();
  }

  // История продаж
  async getSalesHistory(page = 1, limit = 20) {
    const response = await fetch(`${API_BASE_URL}/pos/sales?page=${page}&limit=${limit}`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Ошибка получения истории: ${response.statusText}`);
    }

    return await response.json();
  }
}

// Использование в компоненте кассы
const POSComponent = () => {
  const [currentSale, setCurrentSale] = useState(null);
  const [scannedSku, setScannedSku] = useState('');
  const accessToken = localStorage.getItem('accessToken');
  const posService = new POSService(accessToken);

  useEffect(() => {
    const loadCurrentSale = async () => {
      try {
        const data = await posService.getCurrentSale();
        setCurrentSale(data.sale);
      } catch (error) {
        console.error('Ошибка загрузки чека:', error);
      }
    };

    loadCurrentSale();
  }, []);

  const handleScan = async (sku) => {
    if (!currentSale) return;

    try {
      const result = await posService.addItem(currentSale.id, sku, 1);
      setCurrentSale(result.sale);
      setScannedSku('');
    } catch (error) {
      alert(`Ошибка: ${error.message}`);
    }
  };

  const handleComplete = async () => {
    if (!currentSale || currentSale.items.length === 0) {
      alert('Чек пуст');
      return;
    }

    try {
      const result = await posService.completeSale(currentSale.id);
      alert(`Продажа завершена! Сумма: ${result.sale.totalAmount} ${result.sale.currency}`);
      
      // Загружаем новый чек
      const newSale = await posService.getCurrentSale();
      setCurrentSale(newSale.sale);
    } catch (error) {
      alert(`Ошибка: ${error.message}`);
    }
  };

  return (
    <div>
      <h1>Касса</h1>
      
      {/* Сканер артикулов */}
      <input
        type="text"
        placeholder="Сканируйте артикул"
        value={scannedSku}
        onChange={(e) => setScannedSku(e.target.value)}
        onKeyPress={(e) => {
          if (e.key === 'Enter') {
            handleScan(scannedSku);
          }
        }}
      />

      {/* Товары в чеке */}
      {currentSale && (
        <div>
          <h2>Чек #{currentSale.id}</h2>
          <ul>
            {currentSale.items.map((item, index) => (
              <li key={index}>
                {item.productName} - {item.quantity} x {item.price} = {item.totalPrice} {item.currency}
              </li>
            ))}
          </ul>
          <p>Итого: {currentSale.totalAmount} {currentSale.currency}</p>
          <button onClick={handleComplete}>Завершить продажу</button>
        </div>
      )}
    </div>
  );
};
```

---

## Обработка ошибок

### Коды ошибок:

- **400 Bad Request** - Отсутствуют обязательные поля, неверный формат данных, недостаточно товара на складе, чек пуст
- **401 Unauthorized** - Токен доступа отсутствует или недействителен
- **403 Forbidden** - Доступ запрещен (неверная роль)
- **404 Not Found** - Чек, товар или магазин не найден
- **500 Internal Server Error** - Внутренняя ошибка сервера

### Примеры ответов с ошибками:

**400 Bad Request (недостаточно товара):**
```json
{
  "error": "Недостаточно товара на складе",
  "available": 5,
  "requested": 10
}
```

**404 Not Found:**
```json
{
  "error": "Товар с таким артикулом не найден"
}
```

---

## Важные замечания

1. **Оптимизация данных:**
   - Одна запись продажи (`Sale`) содержит все товары чека в массиве `items`
   - Это минимизирует количество записей в базе данных
   - Все данные для аналитики сохраняются в структурированном виде

2. **Атомарность операций:**
   - Завершение продажи выполняется в транзакции
   - Либо все товары списываются со склада, либо ничего не списывается
   - Гарантируется целостность данных

3. **Статусы чека:**
   - `DRAFT` - Черновой чек (можно редактировать)
   - `COMPLETED` - Завершенная продажа (товары списаны)
   - `CANCELLED` - Отмененный чек

4. **Автоматическое списание:**
   - При завершении продажи товары автоматически списываются со склада
   - Проверяется наличие товара перед списанием
   - Если товара недостаточно, продажа не завершается

5. **Аналитика:**
   - Все завершенные продажи сохраняются для аналитики
   - Доступна статистика по продажам и топ товаров
   - Можно фильтровать по периодам

---

## Поддержка

При возникновении проблем или вопросов обращайтесь к администратору системы.
