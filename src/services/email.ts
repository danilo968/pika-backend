import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.SMTP_FROM || 'Pika <noreply@pikaspot.online>';

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendVerificationEmail(email: string, code: string): Promise<void> {
  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: 'Verify your Pika account',
    html: `
      <div style="background:#000;color:#fff;padding:40px;font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h1 style="font-weight:100;letter-spacing:4px;font-size:36px;margin:0 0 30px 0;">Pika.</h1>
        <div style="width:40px;height:1px;background:#D4A853;margin-bottom:30px;"></div>
        <p style="font-weight:300;font-size:15px;line-height:1.6;color:#999;">
          Your verification code is:
        </p>
        <div style="background:#0A0A0A;border:1px solid #1A1A1A;padding:24px;text-align:center;margin:20px 0;">
          <span style="font-size:32px;letter-spacing:12px;font-weight:400;color:#fff;">${code}</span>
        </div>
        <p style="font-weight:300;font-size:13px;color:#555;line-height:1.5;">
          This code expires in 15 minutes. If you didn't create a Pika account, ignore this email.
        </p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(email: string, code: string): Promise<void> {
  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: 'Reset your Pika password',
    html: `
      <div style="background:#000;color:#fff;padding:40px;font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h1 style="font-weight:100;letter-spacing:4px;font-size:36px;margin:0 0 30px 0;">Pika.</h1>
        <div style="width:40px;height:1px;background:#D4A853;margin-bottom:30px;"></div>
        <p style="font-weight:300;font-size:15px;line-height:1.6;color:#999;">
          Your password reset code is:
        </p>
        <div style="background:#0A0A0A;border:1px solid #1A1A1A;padding:24px;text-align:center;margin:20px 0;">
          <span style="font-size:32px;letter-spacing:12px;font-weight:400;color:#fff;">${code}</span>
        </div>
        <p style="font-weight:300;font-size:13px;color:#555;line-height:1.5;">
          This code expires in 15 minutes. If you didn't request a password reset, ignore this email.
        </p>
      </div>
    `,
  });
}

export { generateCode, sendVerificationEmail, sendPasswordResetEmail };
