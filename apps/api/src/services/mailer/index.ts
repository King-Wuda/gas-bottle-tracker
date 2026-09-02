import nodemailer, { type Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { env } from '../../env.js';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Both `EMAIL_FROM` (the name the change spec uses) and `MAIL_FROM` (the name this
 *  repo already used) name the same thing; EMAIL_FROM wins when both are set. */
const fromAddress = (): string => env().EMAIL_FROM ?? env().MAIL_FROM;

/** One nodemailer transport, chosen by MAILER. SendGrid is reached over SMTP so
 *  no extra dependency is needed. */
function buildTransport(): Transporter {
  const config = env();
  if (config.MAILER === 'sendgrid') {
    if (!config.SENDGRID_API_KEY) throw new Error('MAILER=sendgrid but SENDGRID_API_KEY is unset');
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      auth: { user: 'apikey', pass: config.SENDGRID_API_KEY },
    });
  }
  // mailhog (dev): plain SMTP, no auth, no TLS
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: false,
    ignoreTLS: true,
  });
}

/**
 * Resend — the recommended production transport.
 *
 * Reached through its own SDK rather than SMTP because that is the supported path and
 * it returns a structured error we can put in `OutboundEmail.lastError`. Called only
 * from here, which is only ever reached from the email worker: the API key is a server
 * secret and never leaves this process. (The device build inlines EXPO_PUBLIC_* vars
 * into a downloadable bundle — a key there would be public.)
 *
 * The failure below is deliberately loud and at construction time. A silently
 * misconfigured mailer is the worst outcome available: batches keep saving, the queue
 * keeps draining, and nobody notices the project manager stopped receiving QR sheets.
 */
function buildResendMailer(): Mailer {
  const config = env();
  if (!config.RESEND_API_KEY) {
    throw new Error(
      'MAILER=resend but RESEND_API_KEY is unset. Create an API key at resend.com, ' +
        'verify your sending domain (SPF + DKIM + DMARC), then set RESEND_API_KEY and ' +
        'EMAIL_FROM. See "Sending real email" in README.md.',
    );
  }
  const client = new Resend(config.RESEND_API_KEY);
  const from = fromAddress();
  return {
    async send(msg) {
      const { error } = await client.emails.send({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        attachments: msg.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      // The SDK reports delivery refusals in `error` rather than by throwing, so an
      // unchecked call would mark the row SENT for mail that was never accepted.
      if (error) {
        throw new Error(`Resend refused the message: ${error.name}: ${error.message}`);
      }
    },
  };
}

let cached: Mailer | undefined;

export function getMailer(): Mailer {
  if (cached) return cached;
  if (env().MAILER === 'resend') {
    cached = buildResendMailer();
    return cached;
  }
  const transport = buildTransport();
  const from = fromAddress();
  cached = {
    async send(msg) {
      await transport.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        attachments: msg.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
    },
  };
  return cached;
}

/** Test seam. */
export function setMailer(mock: Mailer | undefined): void {
  cached = mock;
}
