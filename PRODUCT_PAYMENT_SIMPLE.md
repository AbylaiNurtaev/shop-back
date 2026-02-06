# 💳 Оплата товаров - Простая версия

## Обзор

Оплата товаров происходит **на фронтенде**. Backend только активирует товары на выбранный период (6, 9 или 12 месяцев) после успешной оплаты. Минимальный период оплаты - 6 месяцев.

## API Эндпоинты

### 1. Оплата одного товара

**POST** `/api/products/:productId/pay`

Активирует один товар на выбранный период (6, 9 или 12 месяцев).

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**
```json
{
  "periodMonths": 6
}
```

**Параметры:**
- `periodMonths` (number, required) - Период оплаты в месяцах. Допустимые значения: `6`, `9`, `12`

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/products/prod_123/pay \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"periodMonths": 6}'
```

**Успешный ответ (200):**
```json
{
  "message": "Товар успешно оплачен. Показ товара активен на 6 месяцев.",
  "product": {
    "id": "prod_123",
    "name": "Coca-Cola 0.5L",
    "brandId": "brand_456",
    "brandName": "Coca-Cola",
    "isPayed": true,
    "paymentDate": "2026-02-05T12:00:00.000Z",
    "paymentExpiresAt": "2026-08-05T12:00:00.000Z",
    ...
  }
}
```

**Ошибки:**
- `400` - Период оплаты не указан или имеет недопустимое значение (должен быть 6, 9 или 12 месяцев)
- `403` - Пользователь не бренд или товар не принадлежит бренду
- `404` - Товар не найден
- `500` - Ошибка сервера

---

### 2. Оплата нескольких товаров

**POST** `/api/products/pay/multiple`

Активирует несколько товаров на выбранный период (6, 9 или 12 месяцев).

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**
```json
{
  "productIds": ["prod_123", "prod_456", "prod_789"],
  "periodMonths": 12
}
```

**Параметры:**
- `productIds` (array, required) - Массив ID товаров для оплаты
- `periodMonths` (number, required) - Период оплаты в месяцах. Допустимые значения: `6`, `9`, `12`

**Пример запроса:**
```bash
curl -X POST http://localhost:3000/api/products/pay/multiple \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "productIds": ["prod_123", "prod_456", "prod_789"],
    "periodMonths": 12
  }'
```

**Успешный ответ (200):**
```json
{
  "message": "3 товаров успешно оплачено. Показ товаров активен на 12 месяцев.",
  "products": [
    {
      "id": "prod_123",
      "name": "Coca-Cola 0.5L",
      "isPayed": true,
      "paymentDate": "2026-02-05T12:00:00.000Z",
      "paymentExpiresAt": "2027-02-05T12:00:00.000Z",
      ...
    },
    {
      "id": "prod_456",
      "name": "Coca-Cola 1.0L",
      "isPayed": true,
      "paymentDate": "2026-02-05T12:00:00.000Z",
      "paymentExpiresAt": "2027-02-05T12:00:00.000Z",
      ...
    },
    ...
  ]
}
```

**Ошибки:**
- `400` - Список товаров не указан или пустой
- `403` - Пользователь не бренд или некоторые товары не принадлежат бренду
- `404` - Некоторые товары не найдены
- `500` - Ошибка сервера

---

### 3. Получение списка товаров с информацией об оплате

**GET** `/api/products`

Возвращает список товаров. Для брендов включает информацию об оплате.

**Headers:**
```
Authorization: Bearer <token>
```

**Query параметры:**
- `brandId` (опционально) - Фильтр по ID бренда

**Пример запроса:**
```bash
curl -X GET "http://localhost:3000/api/products?brandId=brand_123" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Ответ (200):**
```json
{
  "items": [
    {
      "id": "prod_123",
      "name": "Coca-Cola 0.5L",
      "brandId": "brand_456",
      "brandName": "Coca-Cola",
      "isPayed": true,
      "paymentDate": "2026-02-05T12:00:00.000Z",
      "paymentExpiresAt": "2026-03-07T12:00:00.000Z",
      "description": "Газированный напиток",
      "categoryId": "cat_789",
      "images": ["https://example.com/image.jpg"],
      "sku": "SKU-12345",
      ...
    },
    {
      "id": "prod_456",
      "name": "Coca-Cola 1.0L",
      "brandId": "brand_456",
      "brandName": "Coca-Cola",
      "isPayed": false,
      "paymentDate": null,
      "paymentExpiresAt": null,
      ...
    }
  ],
  "total": 2
}
```

**Важно:**
- **Бренды** видят все свои товары (оплаченные и неоплаченные)
- **Остальные пользователи** видят только оплаченные товары с действующей оплатой
- Поля `isPayed`, `paymentDate`, `paymentExpiresAt` всегда возвращаются

---

## Фронтенд интеграция

### Шаг 1: Оплата на фронтенде

Используйте любую платежную систему на фронтенде (TipTop, Stripe, PayPal, etc.)

```javascript
// Пример с TipTop
async function payForProduct(productId, amount) {
  // 1. Инициируем оплату через TipTop на фронтенде
  const tipTopWidget = new TipTopPayWidget();
  
  tipTopWidget.pay({
    publicId: 'your_public_key',
    amount: amount,
    currency: 'KZT',
    description: 'Оплата показа товара'
  }, {
    onSuccess: async (result) => {
      // 2. После успешной оплаты активируем товар на бэкенде
      await activateProduct(productId);
    },
    onFail: (reason) => {
      console.error('Оплата не удалась:', reason);
    }
  });
}
```

### Шаг 2: Активация товара на бэкенде

После успешной оплаты вызовите API бэкенда:

```javascript
async function activateProduct(productId, periodMonths = 6) {
  try {
    const response = await fetch(`/api/products/${productId}/pay`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${yourToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        periodMonths: periodMonths // 6, 9 или 12
      })
    });

    const data = await response.json();
    
    if (response.ok) {
      console.log('Товар активирован:', data.product);
      // Обновите UI - товар теперь оплачен
      const periodText = periodMonths === 6 ? '6 месяцев' : periodMonths === 9 ? '9 месяцев' : '12 месяцев';
      alert(`Товар успешно оплачен и активирован на ${periodText}!`);
    }
  } catch (error) {
    console.error('Ошибка активации:', error);
  }
}
```

### Шаг 3: Отображение статуса оплаты

При получении списка товаров показывайте статус:

```javascript
async function loadProducts() {
  const response = await fetch('/api/products', {
    headers: {
      'Authorization': `Bearer ${yourToken}`
    }
  });

  const data = await response.json();

  data.items.forEach(product => {
    if (product.isPayed) {
      const daysLeft = Math.ceil(
        (new Date(product.paymentExpiresAt) - new Date()) / (1000 * 60 * 60 * 24)
      );
      console.log(`${product.name} - Оплачен (осталось ${daysLeft} дней)`);
    } else {
      console.log(`${product.name} - Не оплачен`);
    }
  });
}
```

---

## Пример: Оплата нескольких товаров

```javascript
async function payForMultipleProducts(productIds, totalAmount) {
  // 1. Оплата на фронтенде
  const tipTopWidget = new TipTopPayWidget();
  
  tipTopWidget.pay({
    publicId: 'your_public_key',
    amount: totalAmount,
    currency: 'KZT',
    description: `Оплата показа ${productIds.length} товаров`
  }, {
    onSuccess: async (result) => {
      // 2. Активируем все товары на бэкенде
      await activateMultipleProducts(productIds);
    },
    onFail: (reason) => {
      console.error('Оплата не удалась:', reason);
    }
  });
}

async function activateMultipleProducts(productIds, periodMonths = 6) {
  try {
    const response = await fetch('/api/products/pay/multiple', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${yourToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        productIds: productIds,
        periodMonths: periodMonths // 6, 9 или 12
      })
    });

    const data = await response.json();
    
    if (response.ok) {
      console.log(`${data.products.length} товаров активировано`);
      alert(`${data.products.length} товаров успешно оплачено!`);
    }
  } catch (error) {
    console.error('Ошибка активации:', error);
  }
}
```

---

## Важные моменты

### 1. Оплата на фронтенде
- Вся логика оплаты (TipTop, Stripe, PayPal) реализуется на фронтенде
- Backend не знает о деталях платежной системы
- Backend только активирует товары после успешной оплаты

### 2. Безопасность
- Только бренды могут активировать товары
- Бренд может активировать только свои товары
- Требуется авторизация (Bearer token)

### 3. Срок действия
- После активации товар показывается на выбранный период: **6, 9 или 12 месяцев**
- Минимальный период оплаты - **6 месяцев**
- По истечении срока товар автоматически скрывается
- Товар можно оплатить повторно (срок продлится на новый период)

### 4. Видимость товаров
- **Бренды** видят все свои товары (оплаченные и неоплаченные)
- **Дистрибьюторы, магазины** видят только оплаченные товары
- При запросе `/api/products` всегда возвращаются поля `isPayed`, `paymentDate`, `paymentExpiresAt`

---

## Тестирование

### Тест 1: Оплата одного товара

```bash
# 1. Получите список товаров (найдите неоплаченный)
curl -X GET "http://localhost:3000/api/products" \
  -H "Authorization: Bearer YOUR_BRAND_TOKEN"

# 2. Активируйте товар
curl -X POST "http://localhost:3000/api/products/PRODUCT_ID/pay" \
  -H "Authorization: Bearer YOUR_BRAND_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"periodMonths": 6}'

# 3. Проверьте что товар оплачен
curl -X GET "http://localhost:3000/api/products/PRODUCT_ID" \
  -H "Authorization: Bearer YOUR_BRAND_TOKEN"
```

### Тест 2: Оплата нескольких товаров

```bash
# Активируйте несколько товаров
curl -X POST "http://localhost:3000/api/products/pay/multiple" \
  -H "Authorization: Bearer YOUR_BRAND_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "productIds": ["prod_1", "prod_2", "prod_3"],
    "periodMonths": 12
  }'
```

---

## FAQ

**Q: Нужно ли передавать сумму оплаты на бэкенд?**  
A: Нет. Оплата происходит на фронтенде, бэкенд только активирует товар.

**Q: Как проверить, что оплата действительно прошла?**  
A: Это ответственность фронтенда. Вызывайте API активации только после подтверждения оплаты от платежной системы.

**Q: Можно ли оплатить уже оплаченный товар?**  
A: Да, срок действия продлится еще на выбранный период (6, 9 или 12 месяцев) с момента новой оплаты.

**Q: Что делать, если срок оплаты истек?**  
A: Товар скроется автоматически. Нужно оплатить снова, чтобы активировать.

---

**Версия:** 1.0  
**Дата:** 5 февраля 2026
