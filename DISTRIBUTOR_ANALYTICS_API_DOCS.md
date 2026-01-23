# Инструкция по использованию API аналитики дистрибьютора

## Содержание
1. [Обзор](#обзор)
2. [Авторизация](#авторизация)
3. [Общая статистика](#общая-статистика)
4. [Остатки по магазинам](#остатки-по-магазинам)
5. [Оборот](#оборот)
6. [KPI торговых представителей](#kpi-торговых-представителей)
7. [Примеры использования](#примеры-использования)
8. [Обработка ошибок](#обработка-ошибок)

---

## Обзор

API аналитики дистрибьютора предоставляет комплексные инструменты для анализа бизнес-показателей. Позволяет:
- Получать общую статистику по магазинам, торговым представителям и товарам
- Анализировать остатки товаров по каждому магазину
- Отслеживать оборот по магазинам, брендам и товарам
- Оценивать эффективность работы торговых представителей (KPI)

**Важно:** Все эндпоинты доступны только для авторизованных дистрибьюторов и возвращают данные только по их магазинам и торговым представителям.

---

## Авторизация

Все эндпоинты требуют авторизации. Токен передается в заголовке:

```
Authorization: Bearer <accessToken>
```

Для получения токена используйте эндпоинт `POST /api/auth/login`.

**Требования:** Роль пользователя должна быть `DISTRIBUTOR` или пользователь должен иметь `distributorId` в токене.

---

## Общая статистика

### Эндпоинт: `GET /api/distributors/me/analytics/summary`

Получает общую статистику дистрибьютора: количество магазинов, торговых представителей и товаров.

**Параметры запроса:** Отсутствуют

**Ответ:**
```json
{
  "storesCount": 15,
  "salesRepresentativesCount": 8,
  "totalProducts": 234
}
```

**Описание полей:**
- `storesCount` - количество активных магазинов дистрибьютора
- `salesRepresentativesCount` - количество активных торговых представителей
- `totalProducts` - общее количество товаров из подключенных брендов (с активной оплатой)

**Пример запроса:**
```bash
curl -X GET http://localhost:3000/api/distributors/me/analytics/summary \
  -H "Authorization: Bearer <accessToken>"
```

**Пример на JavaScript:**
```javascript
const response = await fetch('http://localhost:3000/api/distributors/me/analytics/summary', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});

const data = await response.json();
console.log(`Магазинов: ${data.storesCount}`);
console.log(`Торговых представителей: ${data.salesRepresentativesCount}`);
console.log(`Товаров: ${data.totalProducts}`);
```

**Коды ответов:**
- `200 OK` - успешный запрос
- `403 Forbidden` - пользователь не является дистрибьютором
- `500 Internal Server Error` - ошибка сервера

---

## Остатки по магазинам

### Эндпоинт: `GET /api/distributors/me/analytics/stock-by-stores`

Получает детальную информацию об остатках товаров в каждом магазине дистрибьютора. Данные отсортированы по общему количеству товаров (убывание).

**Параметры запроса:** Отсутствуют

**Ответ:**
```json
{
  "items": [
    {
      "storeId": "store_123",
      "storeName": "Магазин на Ленина",
      "storeAddress": "ул. Ленина, д. 10",
      "items": [
        {
          "offerId": "offer_456",
          "productId": "product_789",
          "productName": "Молоко 3.2%",
          "sku": "MLK-001",
          "brandName": "Молочная ферма",
          "quantity": 45,
          "price": 89.90,
          "currency": "RUB",
          "value": 4045.50,
          "isAvailable": true
        },
        {
          "offerId": "offer_457",
          "productId": "product_790",
          "productName": "Хлеб белый",
          "sku": "BRD-001",
          "brandName": "Пекарня №1",
          "quantity": 12,
          "price": 45.00,
          "currency": "RUB",
          "value": 540.00,
          "isAvailable": true
        }
      ],
      "totalItems": 2,
      "totalQuantity": 57,
      "totalValue": 4585.50
    },
    {
      "storeId": "store_124",
      "storeName": "Магазин на Пушкина",
      "storeAddress": "ул. Пушкина, д. 5",
      "items": [
        {
          "offerId": "offer_458",
          "productId": "product_791",
          "productName": "Вода минеральная",
          "sku": "WTR-001",
          "brandName": "Горный источник",
          "quantity": 30,
          "price": 35.00,
          "currency": "RUB",
          "value": 1050.00,
          "isAvailable": true
        }
      ],
      "totalItems": 1,
      "totalQuantity": 30,
      "totalValue": 1050.00
    }
  ],
  "total": 2
}
```

**Описание полей:**

**Уровень магазина:**
- `storeId` - идентификатор магазина
- `storeName` - название магазина
- `storeAddress` - адрес магазина
- `items` - массив товаров в магазине (отсортирован по количеству, убывание)
- `totalItems` - общее количество позиций товаров
- `totalQuantity` - общее количество единиц товара
- `totalValue` - общая стоимость остатков

**Уровень товара:**
- `offerId` - идентификатор предложения (оффера)
- `productId` - идентификатор товара
- `productName` - название товара
- `sku` - артикул товара
- `brandName` - название бренда
- `quantity` - количество товара на складе
- `price` - цена за единицу
- `currency` - валюта
- `value` - общая стоимость (quantity × price)
- `isAvailable` - доступность товара

**Пример запроса:**
```bash
curl -X GET http://localhost:3000/api/distributors/me/analytics/stock-by-stores \
  -H "Authorization: Bearer <accessToken>"
```

**Пример на JavaScript:**
```javascript
const response = await fetch('http://localhost:3000/api/distributors/me/analytics/stock-by-stores', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});

const data = await response.json();
data.items.forEach(store => {
  console.log(`Магазин: ${store.storeName}`);
  console.log(`Всего товаров: ${store.totalItems}, Количество: ${store.totalQuantity}, Стоимость: ${store.totalValue}`);
  store.items.forEach(item => {
    console.log(`  - ${item.productName}: ${item.quantity} шт. (${item.value} ${item.currency})`);
  });
});
```

**Коды ответов:**
- `200 OK` - успешный запрос
- `403 Forbidden` - пользователь не является дистрибьютором
- `500 Internal Server Error` - ошибка сервера

**Примечания:**
- Магазины отсортированы по общему количеству товаров (убывание)
- Товары в каждом магазине отсортированы по количеству (убывание)
- Если у дистрибьютора нет магазинов, возвращается пустой массив

---

## Оборот

### Эндпоинт: `GET /api/distributors/me/analytics/turnover`

Получает данные об обороте (выручке) дистрибьютора с возможностью группировки по магазинам, брендам или товарам. Поддерживает фильтрацию по периоду.

**Параметры запроса:**

| Параметр | Тип | Обязательный | Описание |
|----------|-----|--------------|-----------|
| `type` | string | Нет | Тип группировки: `store` (по умолчанию), `brand`, `product` |
| `startDate` | string (ISO 8601) | Нет | Начальная дата периода (по умолчанию: 30 дней назад) |
| `endDate` | string (ISO 8601) | Нет | Конечная дата периода (по умолчанию: сегодня) |

**Примеры параметров:**
- `type=store` - оборот по магазинам
- `type=brand` - оборот по брендам
- `type=product` - оборот по товарам
- `startDate=2024-01-01&endDate=2024-01-31` - период с 1 по 31 января 2024

**Ответ (type=store):**
```json
{
  "type": "store",
  "period": {
    "startDate": "2024-01-01T00:00:00.000Z",
    "endDate": "2024-01-31T23:59:59.999Z"
  },
  "items": [
    {
      "storeId": "store_123",
      "storeName": "Магазин на Ленина",
      "storeAddress": "ул. Ленина, д. 10",
      "totalRevenue": 125000.50,
      "totalSales": 234,
      "totalQuantity": 567
    },
    {
      "storeId": "store_124",
      "storeName": "Магазин на Пушкина",
      "storeAddress": "ул. Пушкина, д. 5",
      "totalRevenue": 98000.00,
      "totalSales": 189,
      "totalQuantity": 432
    }
  ],
  "total": 2,
  "summary": {
    "totalRevenue": 223000.50,
    "totalSales": 423,
    "totalQuantity": 999
  }
}
```

**Ответ (type=brand):**
```json
{
  "type": "brand",
  "period": {
    "startDate": "2024-01-01T00:00:00.000Z",
    "endDate": "2024-01-31T23:59:59.999Z"
  },
  "items": [
    {
      "brandId": "brand_123",
      "brandName": "Молочная ферма",
      "totalRevenue": 85000.00,
      "totalSales": 156,
      "totalQuantity": 345
    },
    {
      "brandId": "brand_124",
      "brandName": "Пекарня №1",
      "totalRevenue": 62000.50,
      "totalSales": 112,
      "totalQuantity": 278
    }
  ],
  "total": 2,
  "summary": {
    "totalRevenue": 223000.50,
    "totalSales": 423,
    "totalQuantity": 999
  }
}
```

**Ответ (type=product):**
```json
{
  "type": "product",
  "period": {
    "startDate": "2024-01-01T00:00:00.000Z",
    "endDate": "2024-01-31T23:59:59.999Z"
  },
  "items": [
    {
      "productId": "product_789",
      "productName": "Молоко 3.2%",
      "sku": "MLK-001",
      "brandName": "Молочная ферма",
      "totalRevenue": 45000.00,
      "totalSales": 89,
      "totalQuantity": 234
    },
    {
      "productId": "product_790",
      "productName": "Хлеб белый",
      "sku": "BRD-001",
      "brandName": "Пекарня №1",
      "totalRevenue": 32000.50,
      "totalSales": 67,
      "totalQuantity": 156
    }
  ],
  "total": 2,
  "summary": {
    "totalRevenue": 223000.50,
    "totalSales": 423,
    "totalQuantity": 999
  }
}
```

**Описание полей:**

**Общие поля:**
- `type` - тип группировки данных
- `period` - период анализа
  - `startDate` - начальная дата периода
  - `endDate` - конечная дата периода
- `items` - массив элементов (отсортирован по выручке, убывание)
- `total` - количество элементов
- `summary` - общая статистика
  - `totalRevenue` - общая выручка за период
  - `totalSales` - общее количество продаж
  - `totalQuantity` - общее количество проданных товаров

**Поля для type=store:**
- `storeId` - идентификатор магазина
- `storeName` - название магазина
- `storeAddress` - адрес магазина
- `totalRevenue` - выручка магазина
- `totalSales` - количество продаж в магазине
- `totalQuantity` - количество проданных товаров

**Поля для type=brand:**
- `brandId` - идентификатор бренда
- `brandName` - название бренда
- `totalRevenue` - выручка по бренду
- `totalSales` - количество продаж товаров бренда
- `totalQuantity` - количество проданных товаров бренда

**Поля для type=product:**
- `productId` - идентификатор товара
- `productName` - название товара
- `sku` - артикул товара
- `brandName` - название бренда
- `totalRevenue` - выручка по товару
- `totalSales` - количество продаж товара
- `totalQuantity` - количество проданных единиц товара

**Примеры запросов:**

**Оборот по магазинам (по умолчанию):**
```bash
curl -X GET "http://localhost:3000/api/distributors/me/analytics/turnover" \
  -H "Authorization: Bearer <accessToken>"
```

**Оборот по брендам:**
```bash
curl -X GET "http://localhost:3000/api/distributors/me/analytics/turnover?type=brand" \
  -H "Authorization: Bearer <accessToken>"
```

**Оборот по товарам за период:**
```bash
curl -X GET "http://localhost:3000/api/distributors/me/analytics/turnover?type=product&startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer <accessToken>"
```

**Пример на JavaScript:**
```javascript
// Оборот по магазинам за последний месяц
const response = await fetch('http://localhost:3000/api/distributors/me/analytics/turnover?type=store', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});

const data = await response.json();
console.log(`Общая выручка: ${data.summary.totalRevenue}`);
console.log(`Всего продаж: ${data.summary.totalSales}`);
data.items.forEach(store => {
  console.log(`${store.storeName}: ${store.totalRevenue} руб. (${store.totalSales} продаж)`);
});
```

**Коды ответов:**
- `200 OK` - успешный запрос
- `403 Forbidden` - пользователь не является дистрибьютором
- `500 Internal Server Error` - ошибка сервера

**Примечания:**
- По умолчанию анализируется период последних 30 дней
- Учитываются только завершенные продажи (status: `COMPLETED`)
- Элементы отсортированы по выручке (убывание)
- Если у дистрибьютора нет магазинов или продаж, возвращается пустой массив

---

## KPI торговых представителей

### Эндпоинт: `GET /api/distributors/me/analytics/sales-rep-kpi`

Получает показатели эффективности работы торговых представителей (KPI) с информацией о выполнении планов продаж.

**Параметры запроса:**

| Параметр | Тип | Обязательный | Описание |
|----------|-----|--------------|-----------|
| `period` | string | Нет | Период анализа: `month` (по умолчанию), `quarter`, `year` |
| `startDate` | string (ISO 8601) | Нет | Начальная дата периода (приоритет над `period`) |
| `endDate` | string (ISO 8601) | Нет | Конечная дата периода (приоритет над `period`) |

**Примеры параметров:**
- `period=month` - текущий месяц
- `period=quarter` - текущий квартал
- `period=year` - текущий год
- `startDate=2024-01-01&endDate=2024-01-31` - произвольный период

**Ответ:**
```json
{
  "period": {
    "startDate": "2024-01-01T00:00:00.000Z",
    "endDate": "2024-01-31T23:59:59.999Z"
  },
  "items": [
    {
      "salesRepresentativeId": "user_123",
      "salesRepresentativeName": "Иван Петров",
      "email": "ivan.petrov@example.com",
      "storesCount": 5,
      "totalRevenue": 150000.00,
      "totalSales": 280,
      "totalQuantity": 650,
      "plan": {
        "id": "plan_456",
        "targetAmount": 140000.00,
        "targetQuantity": 600,
        "period": "2024-01"
      },
      "planCompletionPercent": 107.14
    },
    {
      "salesRepresentativeId": "user_124",
      "salesRepresentativeName": "Мария Сидорова",
      "email": "maria.sidorova@example.com",
      "storesCount": 3,
      "totalRevenue": 98000.00,
      "totalSales": 189,
      "totalQuantity": 432,
      "plan": {
        "id": "plan_457",
        "targetAmount": 120000.00,
        "targetQuantity": 500,
        "period": "2024-01"
      },
      "planCompletionPercent": 81.67
    },
    {
      "salesRepresentativeId": "user_125",
      "salesRepresentativeName": "Петр Иванов",
      "email": "petr.ivanov@example.com",
      "storesCount": 2,
      "totalRevenue": 75000.00,
      "totalSales": 145,
      "totalQuantity": 320,
      "plan": null,
      "planCompletionPercent": null
    }
  ],
  "total": 3
}
```

**Описание полей:**

**Общие поля:**
- `period` - период анализа
  - `startDate` - начальная дата периода
  - `endDate` - конечная дата периода
- `items` - массив KPI торговых представителей (отсортирован по выручке, убывание)
- `total` - количество торговых представителей

**Поля торгового представителя:**
- `salesRepresentativeId` - идентификатор торгового представителя
- `salesRepresentativeName` - имя торгового представителя (или email, если имя отсутствует)
- `email` - email торгового представителя
- `storesCount` - количество закрепленных магазинов
- `totalRevenue` - общая выручка за период
- `totalSales` - общее количество продаж
- `totalQuantity` - общее количество проданных товаров
- `plan` - информация о плане продаж (если есть)
  - `id` - идентификатор плана
  - `targetAmount` - целевая выручка
  - `targetQuantity` - целевое количество товаров
  - `period` - период плана
- `planCompletionPercent` - процент выполнения плана по выручке (округлено до 2 знаков после запятой), `null` если план отсутствует

**Примеры запросов:**

**KPI за текущий месяц:**
```bash
curl -X GET "http://localhost:3000/api/distributors/me/analytics/sales-rep-kpi?period=month" \
  -H "Authorization: Bearer <accessToken>"
```

**KPI за текущий квартал:**
```bash
curl -X GET "http://localhost:3000/api/distributors/me/analytics/sales-rep-kpi?period=quarter" \
  -H "Authorization: Bearer <accessToken>"
```

**KPI за произвольный период:**
```bash
curl -X GET "http://localhost:3000/api/distributors/me/analytics/sales-rep-kpi?startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer <accessToken>"
```

**Пример на JavaScript:**
```javascript
// Получение KPI за текущий месяц
const response = await fetch('http://localhost:3000/api/distributors/me/analytics/sales-rep-kpi?period=month', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});

const data = await response.json();
data.items.forEach(rep => {
  console.log(`${rep.salesRepresentativeName}:`);
  console.log(`  Выручка: ${rep.totalRevenue} руб.`);
  console.log(`  Продаж: ${rep.totalSales}`);
  console.log(`  Магазинов: ${rep.storesCount}`);
  if (rep.plan) {
    console.log(`  План: ${rep.plan.targetAmount} руб.`);
    console.log(`  Выполнение: ${rep.planCompletionPercent}%`);
  } else {
    console.log(`  План: не установлен`);
  }
});
```

**Коды ответов:**
- `200 OK` - успешный запрос
- `403 Forbidden` - пользователь не является дистрибьютором
- `500 Internal Server Error` - ошибка сервера

**Примечания:**
- По умолчанию анализируется текущий месяц
- Учитываются только завершенные продажи (status: `COMPLETED`)
- Торговые представители отсортированы по выручке (убывание)
- План выбирается автоматически на основе периода анализа (если есть план с соответствующими датами)
- Если у торгового представителя нет закрепленных магазинов или продаж, он все равно будет включен в ответ с нулевыми показателями
- Если у дистрибьютора нет торговых представителей, возвращается пустой массив

---

## Примеры использования

### Получение полной аналитической сводки

```javascript
async function getFullAnalytics(accessToken) {
  // 1. Общая статистика
  const summary = await fetch('http://localhost:3000/api/distributors/me/analytics/summary', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  }).then(r => r.json());
  
  console.log('=== Общая статистика ===');
  console.log(`Магазинов: ${summary.storesCount}`);
  console.log(`Торговых представителей: ${summary.salesRepresentativesCount}`);
  console.log(`Товаров: ${summary.totalProducts}`);

  // 2. Остатки по магазинам
  const stock = await fetch('http://localhost:3000/api/distributors/me/analytics/stock-by-stores', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  }).then(r => r.json());
  
  console.log('\n=== Остатки по магазинам ===');
  stock.items.forEach(store => {
    console.log(`${store.storeName}: ${store.totalQuantity} ед. (${store.totalValue} руб.)`);
  });

  // 3. Оборот по магазинам за последний месяц
  const turnover = await fetch('http://localhost:3000/api/distributors/me/analytics/turnover?type=store', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  }).then(r => r.json());
  
  console.log('\n=== Оборот по магазинам ===');
  console.log(`Общая выручка: ${turnover.summary.totalRevenue} руб.`);
  turnover.items.forEach(store => {
    console.log(`${store.storeName}: ${store.totalRevenue} руб.`);
  });

  // 4. KPI торговых представителей
  const kpi = await fetch('http://localhost:3000/api/distributors/me/analytics/sales-rep-kpi?period=month', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  }).then(r => r.json());
  
  console.log('\n=== KPI торговых представителей ===');
  kpi.items.forEach(rep => {
    const planInfo = rep.plan 
      ? `План: ${rep.planCompletionPercent}%`
      : 'План не установлен';
    console.log(`${rep.salesRepresentativeName}: ${rep.totalRevenue} руб. (${planInfo})`);
  });
}

// Использование
getFullAnalytics(accessToken);
```

### Анализ оборота по брендам за квартал

```javascript
async function getBrandTurnover(accessToken) {
  // Определяем даты квартала
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3);
  const startDate = new Date(now.getFullYear(), quarter * 3, 1);
  const endDate = new Date(now.getFullYear(), (quarter + 1) * 3, 0);
  
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  const response = await fetch(
    `http://localhost:3000/api/distributors/me/analytics/turnover?type=brand&startDate=${startStr}&endDate=${endStr}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );

  const data = await response.json();
  
  console.log(`Оборот по брендам за ${quarter + 1} квартал:`);
  console.log(`Общая выручка: ${data.summary.totalRevenue} руб.`);
  
  data.items.forEach(brand => {
    const share = (brand.totalRevenue / data.summary.totalRevenue * 100).toFixed(2);
    console.log(`${brand.brandName}: ${brand.totalRevenue} руб. (${share}%)`);
  });
}
```

### Мониторинг выполнения планов торговых представителей

```javascript
async function monitorPlanCompletion(accessToken) {
  const response = await fetch(
    'http://localhost:3000/api/distributors/me/analytics/sales-rep-kpi?period=month',
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );

  const data = await response.json();
  
  console.log('=== Выполнение планов ===');
  
  const onTrack = [];
  const behind = [];
  const noPlan = [];
  
  data.items.forEach(rep => {
    if (!rep.plan) {
      noPlan.push(rep);
    } else if (rep.planCompletionPercent >= 100) {
      onTrack.push(rep);
    } else {
      behind.push(rep);
    }
  });
  
  console.log(`\n✅ Выполняют план (${onTrack.length}):`);
  onTrack.forEach(rep => {
    console.log(`  ${rep.salesRepresentativeName}: ${rep.planCompletionPercent}%`);
  });
  
  console.log(`\n⚠️ Отстают от плана (${behind.length}):`);
  behind.forEach(rep => {
    console.log(`  ${rep.salesRepresentativeName}: ${rep.planCompletionPercent}%`);
  });
  
  console.log(`\n📋 Без плана (${noPlan.length}):`);
  noPlan.forEach(rep => {
    console.log(`  ${rep.salesRepresentativeName}`);
  });
}
```

---

## Обработка ошибок

### Стандартные коды ошибок

**403 Forbidden**
```json
{
  "error": "Только дистрибьюторы могут просматривать аналитику"
}
```
**Причина:** Пользователь не является дистрибьютором или не авторизован.

**Решение:** Убедитесь, что:
- Токен доступа валиден
- Пользователь имеет роль `DISTRIBUTOR` или `distributorId` в токене

**500 Internal Server Error**
```json
{
  "error": "Ошибка при получении общей статистики"
}
```
**Причина:** Внутренняя ошибка сервера.

**Решение:** 
- Проверьте логи сервера
- Повторите запрос через некоторое время
- Обратитесь к администратору системы

### Обработка пустых данных

Все эндпоинты корректно обрабатывают случаи, когда у дистрибьютора нет данных:

**Нет магазинов:**
```json
{
  "items": [],
  "total": 0
}
```

**Нет продаж:**
```json
{
  "items": [],
  "total": 0,
  "summary": {
    "totalRevenue": 0,
    "totalSales": 0,
    "totalQuantity": 0
  }
}
```

### Пример обработки ошибок на JavaScript

```javascript
async function safeAnalyticsRequest(url, accessToken) {
  try {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Ошибка при запросе аналитики:', error.message);
    
    if (error.message.includes('403')) {
      console.error('Доступ запрещен. Проверьте права доступа.');
    } else if (error.message.includes('500')) {
      console.error('Ошибка сервера. Попробуйте позже.');
    } else {
      console.error('Неизвестная ошибка:', error.message);
    }
    
    throw error;
  }
}

// Использование
try {
  const summary = await safeAnalyticsRequest(
    'http://localhost:3000/api/distributors/me/analytics/summary',
    accessToken
  );
  console.log('Статистика:', summary);
} catch (error) {
  // Ошибка уже обработана в safeAnalyticsRequest
}
```

---

## Важные замечания

1. **Производительность:**
   - Запросы аналитики могут быть ресурсоемкими при больших объемах данных
   - Рекомендуется использовать фильтры по периодам для ограничения объема данных
   - Кэширование результатов на клиенте поможет снизить нагрузку

2. **Актуальность данных:**
   - Данные обновляются в реальном времени
   - Учитываются только завершенные продажи (status: `COMPLETED`)
   - Остатки товаров отражают текущее состояние складов

3. **Периоды анализа:**
   - По умолчанию используется период последних 30 дней для оборота
   - По умолчанию используется текущий месяц для KPI
   - Всегда указывайте явные даты для точного анализа конкретных периодов

4. **Планы торговых представителей:**
   - План выбирается автоматически на основе периода анализа
   - Если план не найден, `plan` будет `null`
   - Процент выполнения рассчитывается только по выручке (`targetAmount`)

5. **Сортировка:**
   - Магазины в остатках отсортированы по общему количеству товаров
   - Элементы оборота отсортированы по выручке
   - KPI торговых представителей отсортированы по выручке

---

## Поддержка

При возникновении проблем или вопросов обращайтесь к администратору системы.
