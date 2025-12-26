
import nodemailer from 'nodemailer';
import config from '../config/config.js';
import logger from './logger.js';

const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: Number(config.SMTP_PORT),
  secure: config.SMTP_SECURE === 'true', // false for other ports
  auth: {
    user: config.GMAIL,
    pass: config.PASSWORD,
  },
});

// Google-style OTP Email Template
export const sendOTPEmail = async (to: string, otp: string) => {
  const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your Aljo Store account</title>
  <style>
    body {
      font-family: 'Roboto', 'Helvetica', Arial, sans-serif;
      background-color: #f4f4f4;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 600px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .header {
      background-color: #1a73e8;
      padding: 32px;
      text-align: center;
    }
    .logo {
      font-size: 28px;
      font-weight: 600;
      color: white;
      letter-spacing: 0.5px;
    }
    .content {
      padding: 40px 32px;
      text-align: center;
      color: #333333;
    }
    .title {
      font-size: 24px;
      font-weight: 500;
      margin-bottom: 16px;
      color: #202124;
    }
    .message {
      font-size: 16px;
      line-height: 1.6;
      color: #5f6368;
      margin-bottom: 32px;
    }
    .otp-box {
      background-color: #f1f3f4;
      border-radius: 8px;
      padding: 24px;
      margin: 32px auto;
      max-width: 300px;
    }
    .otp {
      font-size: 36px;
      font-weight: 700;
      letter-spacing: 8px;
      color: #1a73e8;
      margin: 0;
    }
    .footer {
      background-color: #f1f3f4;
      padding: 32px;
      text-align: center;
      font-size: 14px;
      color: #5f6368;
    }
    .footer a {
      color: #1a73e8;
      text-decoration: none;
    }
    @media only screen and (max-width: 600px) {
      .container {
        margin: 20px;
      }
      .content {
        padding: 32px 24px;
      }
    }
  </style>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">Aljo Store</div>
    </div>
    <div class="content">
      <h1 class="title">Verify your email address</h1>
      <p class="message">
        Thanks for signing up! Please use the following one-time code to complete your registration.
      </p>
      <div class="otp-box">
        <p class="otp">${otp}</p>
      </div>
      <p class="message">
        This code will expire in <strong>5 minutes</strong>.<br>
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
    <div class="footer">
      <p>© 2025 Aljo Store. All rights reserved.</p>
      <p>
        <a href="#">Privacy Policy</a> • 
        <a href="#">Terms of Service</a>
      </p>
    </div>
  </div>
</body>
</html>
  `;

  const mailOptions = {
    from: `"Aljo Store" <${config.GMAIL}>`,
    to,
    subject: 'Your Aljo Store Verification Code',
    html: htmlTemplate,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info('OTP email sent successfully', { to });
  } catch (error: any) {
    logger.error('Failed to send OTP email', { to, error: error.message });
    throw new Error('Failed to send verification email');
  }
};