# Wappi Webhook API

## POST `/api/wappi/webhook`

### Отправка (от Wappi)

```json
{
  "messages": [
    {
      "chatId": "79991234567@c.us",
      "from": "79991234567@c.us",
      "body": "Найди колу",
      "is_me": false,
      "fromMe": false,
      "profile_id": "your_profile_id"
    }
  ]
}
```

**Или один объект:**
```json
{
  "message": {
    "chatId": "79991234567@c.us",
    "body": "Найди колу"
  }
}
```

### Прием (ответ сервера)

**Успешный запрос:**
```json
{
  "received": true,
  "requestId": "wappi-1234567890-abc123"
}
```

**Игнорировано (от бота):**
```json
{
  "received": true,
  "ignored": true,
  "reason": "fromMe"
}
```

**Игнорировано (пустое сообщение):**
```json
{
  "received": true,
  "ignored": true,
  "reason": "empty body"
}
```

**Ошибка:**
```json
{
  "received": true,
  "error": "Missing chatId"
}
```

**Примечание:** Обработка асинхронная. Ответ пользователю отправляется через Wappi API отдельно.

## Тестовый режим

Добавьте `?test=true` в URL для синхронной обработки и получения ответа в response (без отправки в WhatsApp):

**Запрос:**
```
POST /api/wappi/webhook?test=true
```

**Ответ (успех):**
```json
{
  "received": true,
  "requestId": "wappi-1234567890-abc123",
  "testMode": true,
  "response": "✅ Найден товар: Coca-Cola (Coca-Cola) - 0.5л\n\nНайдено магазинов: 3\n\n1. Магазин №1\n   Адрес: ул. Ленина, 1\n   Цена: 89 RUB\n\n...",
  "processingTime": 1234,
  "totalTime": 1456
}
```

**Ответ (ошибка):**
```json
{
  "received": true,
  "requestId": "wappi-1234567890-abc123",
  "testMode": true,
  "error": "Error message",
  "response": "Произошла ошибка при поиске товаров. Попробуйте позже.",
  "processingTime": 500,
  "totalTime": 600
}
```
