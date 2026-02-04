// MailerSend API для отправки email
async function sendEmail({ to, subject, text, html }) {
  const MAILERSEND_API_KEY = process.env.MAILERSEND;

  if (!MAILERSEND_API_KEY) {
    throw new Error('MAILERSEND API ключ не задан в переменных окружения');
  }

  const fromName = process.env.SMTP_FROM_NAME || 'Inventory Admin';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

  if (!fromEmail) {
    throw new Error('SMTP_FROM_EMAIL или SMTP_USER должен быть задан для отправки email через MailerSend');
  }

  // Если HTML не предоставлен, создаем простой HTML из текста
  let htmlContent = html;
  if (!htmlContent && text) {
    // Простое преобразование текста в HTML (сохраняем переносы строк)
    htmlContent = text.replace(/\n/g, '<br>');
  }

  // Формируем тело запроса для MailerSend API
  const emailData = {
    from: {
      email: fromEmail,
      name: fromName
    },
    to: [
      {
        email: to
      }
    ],
    subject: subject,
    text: text || '',
    html: htmlContent || text || ''
  };

  try {
    const response = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILERSEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailData)
    });

    if (!response.ok) {
      let errorMessage = `MailerSend API ошибка: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.message) {
          errorMessage += `. ${errorData.message}`;
        }
        if (errorData.errors) {
          errorMessage += `. Ошибки: ${JSON.stringify(errorData.errors)}`;
        }
      } catch (parseError) {
        const errorText = await response.text().catch(() => '');
        if (errorText) {
          errorMessage += `. Ответ: ${errorText}`;
        }
      }
      throw new Error(errorMessage);
    }

    // MailerSend может вернуть пустой ответ при успехе (204) или JSON
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const result = await response.json();
      return result;
    }
    
    return { success: true, status: response.status };
  } catch (error) {
    console.error('Ошибка при отправке email через MailerSend:', error);
    throw error;
  }
}

module.exports = { sendEmail };
