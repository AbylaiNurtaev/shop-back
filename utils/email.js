// Resend API для отправки email
const { Resend } = require('resend');

// Ленивая инициализация Resend (только когда нужен)
let resendInstance = null;

function getResend() {
  if (!resendInstance) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY не задан в переменных окружения');
    }
    resendInstance = new Resend(apiKey);
  }
  return resendInstance;
}

// Основная функция отправки email (сохраняем обратную совместимость)
async function sendEmail({ to, subject, text, html }) {
  // Получаем экземпляр Resend (проверка API ключа происходит внутри getResend)
  const resend = getResend();

  // Определяем адрес отправителя
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const fromName = process.env.SMTP_FROM_NAME || 'Inventory Admin';
  // const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const from = 'info@omiai.kz';
  // Если HTML не предоставлен, создаем простой HTML из текста
  let htmlContent = html;
  if (!htmlContent && text) {
    // Простое преобразование текста в HTML (сохраняем переносы строк)
    htmlContent = text.replace(/\n/g, '<br>');
  }

  // Если нет ни HTML, ни текста, создаем минимальный HTML
  if (!htmlContent) {
    htmlContent = '<p>No content</p>';
  }

  try {
    const { data, error } = await resend.emails.send({
      from: from,
      to: to,
      subject: subject,
      html: htmlContent,
    });

    if (error) {
      throw new Error(`Resend API ошибка: ${error.message}`);
    }

    console.log('Email sent successfully:', data);
    return { success: true, data };
  } catch (error) {
    console.error('Ошибка при отправке email через Resend:', error);
    throw new Error(`Email sending failed: ${error.message}`);
  }
}

// Функция для отправки кода верификации (дополнительная функция)
async function sendVerificationCode(email, code) {
  const subject = 'Код верификации';
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Подтверждение email</h2>
      <p style="color: #666; font-size: 16px;">Ваш код верификации:</p>
      <div style="background-color: #f4f4f4; padding: 20px; font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; margin: 20px 0; border-radius: 8px; color: #333;">
        ${code}
      </div>
      <p style="color: #666; font-size: 14px;">Этот код действителен в течение 10 минут.</p>
      <p style="color: #999; font-size: 12px; margin-top: 30px;">Если вы не запрашивали этот код, пожалуйста, проигнорируйте это письмо.</p>
    </div>
  `;

  return await sendEmail({ to: email, subject, html });
}

module.exports = { sendEmail, sendVerificationCode };
