import nodemailer from 'nodemailer';
import config from '../config/config.js';
import logger from './logger.js';

const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: Number(config.SMTP_PORT),
  secure: config.SMTP_SECURE === 'true',
  auth: {
    user: config.GMAIL,
    pass: config.PASSWORD,
  },
});

export const sendOrderConfirmationEmail = async (email: string, order: any) => {
  const itemsHtml = order.items
    .map(
      (item: any) => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">
          <img src="${item.image}" alt="${item.name}" width="60" style="border-radius: 4px;" />
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">${item.name}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">${item.quantity}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">$${item.price.toFixed(2)}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">$${(item.price * item.quantity).toFixed(2)}</td>
      </tr>
    `
    )
    .join('');

  const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Order Confirmation - Aljo Store</title>
  <style>
    body { font-family: 'Helvetica', Arial, sans-serif; background: #f6f9fc; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .header { background: #1a73e8; padding: 30px; text-align: center; color: white; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 30px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #f1f3f4; text-align: left; padding: 12px; }
    td { padding: 12px; }
    .total { font-size: 18px; font-weight: bold; text-align: right; padding: 20px 0; }
    .footer { background: #f1f3f4; padding: 20px; text-align: center; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Aljo Store</h1>
      <p>Order Confirmation</p>
    </div>
    <div class="content">
      <h2>Thank you for your order!</h2>
      <p>Order ID: <strong>#${order._id.toString().slice(-8).toUpperCase()}</strong></p>
      <p>Order Date: <strong>${new Date(order.createdAt).toLocaleDateString()}</strong></p>
      <p>Status: <strong>${order.status.toUpperCase()}</strong></p>

      <h3>Order Items</h3>
      <table>
        <thead>
          <tr>
            <th>Image</th>
            <th>Product</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <div class="total">
        Subtotal: $${order.subtotal.toFixed(2)}<br>
        Total: <strong>$${order.total.toFixed(2)}</strong>
      </div>

      <p>You can check your order's status anytime under My Orders in your account.</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} Aljo Store. All rights reserved.</p>
      <p>Thank you for shopping with us!</p>
    </div>
  </div>
</body>
</html>
  `;

  const mailOptions = {
    from: `"Aljo Store" <${config.GMAIL}>`,
    to: email,
    subject: `Order Confirmation - #${order._id.toString().slice(-8).toUpperCase()}`,
    html: htmlTemplate,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info('Order confirmation email sent', { orderId: order._id, email });
  } catch (error: any) {
    logger.error('Failed to send order confirmation email', { orderId: order._id, error: error.message });
    // Don't throw — email failure shouldn't break payment flow
  }
};