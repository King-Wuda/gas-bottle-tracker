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

/**
 * Split `"Gas Cylinder Tracker <no-reply@gct.co.za>"` into its two halves.
 *
 * SMTP and Resend both take the combined string, so this existed nowhere until Brevo,
 * whose API wants `{ name, email }` as separate JSON fields. A bare address with no
 * display name is equally valid and comes back with `name` undefined, which Brevo
 * accepts — it falls back to the address, exactly as a mail client would.
 */
export function parseAddress(value: string): { email: string; name?: string } {
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  const email = angled?.[2];
  if (!email) return { email: value.trim() };
  // A quoted display name ("Gas Cylinder Tracker" <...>) is legal; the quotes are
  // syntax, not part of the name, and Brevo would render them literally.
  const name = (angled[1] ?? '').replace(/^"(.*)"$/, '$1').trim();
  return name ? { email: email.trim(), name } : { email: email.trim() };
}

/**
 * Any SMTP server — Gmail, a work mail server, an ESP that speaks SMTP.
 *
 * This exists because the alternative to it is not "a better transport", it is "no
 * email to anyone but one person". Resend and SendGrid both refuse to send to
 * arbitrary recipients until a DOMAIN is verified, which needs a domain you own and
 * DNS records that propagate. An SMTP account you already have has neither
 * requirement and delivers to anybody today.
 *
 * It is not a downgrade in honesty: unlike the sink this replaced, a misconfigured
 * SMTP server fails loudly at send time and the error lands in
 * `OutboundEmail.lastError` like any other refusal.
 */
function buildSmtpTransport(): Transporter {
  const config = env();
  if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
    throw new Error('MAILER=smtp but SMTP_HOST, SMTP_USER or SMTP_PASS is unset');
  }
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    // 465 is implicit TLS; 587 upgrades with STARTTLS. Neither sends in the clear.
    secure: config.SMTP_SECURE || config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
}

/** SendGrid over SMTP, so no extra dependency is needed for it. */
function buildSendgridTransport(): Transporter {
  const config = env();
  if (!config.SENDGRID_API_KEY) throw new Error('MAILER=sendgrid but SENDGRID_API_KEY is unset');
  return nodemailer.createTransport({
    host: 'smtp.sendgrid.net',
    port: 587,
    auth: { user: 'apikey', pass: config.SENDGRID_API_KEY },
  });
}

/**
 * Every message the `capture` mailer has accepted, newest last.
 *
 * This replaced MailHog. MailHog was a Docker container speaking real SMTP on a real
 * port, which meant a sink you had to remember to run, a second thing that could be
 * "not started", and — worst — a `MAILER` value that looked like a working mail setup
 * and delivered nothing to anyone. This is a transport that never touches the network
 * and says so in its name.
 *
 * It is for the integration suite, which asserts that the worker really composed a
 * message with the right recipient, subject and attachments. Nothing in a deployment
 * should be pointed at it: `resend` is the transport that sends mail.
 */
const captured: MailMessage[] = [];

/** The messages `MAILER=capture` has taken, for tests to assert against. */
export function capturedMail(): readonly MailMessage[] {
  return captured;
}

export function clearCapturedMail(): void {
  captured.length = 0;
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
        throw new Error(
          explainRefusal('resend', `Resend refused the message: ${error.name}: ${error.message}`, {
            from: parseAddress(from).email,
            to: msg.to,
          }),
        );
      }
    },
  };
}

/**
 * Brevo — the transport that reaches project managers without owning a domain.
 *
 * This exists because the other two routes out of "we can only email one person" are
 * both shut on the host this runs on. Resend (and SendGrid, and any ESP that
 * authenticates by DOMAIN) refuses arbitrary recipients until SPF and DKIM records are
 * verified, which needs a domain you own and DNS you control. `MAILER=smtp` sidesteps
 * that and delivers to anybody — but not from Render's free plan, where outbound SMTP
 * is blocked on every port and mail has to leave over 443. Measured, both ports, in
 * docs/DEPLOY.md.
 *
 * Brevo is the one that fits through the gap: it authenticates a SINGLE SENDER by
 * emailing a confirmation link to that address, so a plain Gmail account becomes a
 * legitimate `From:` with no domain and no DNS, and it sends over HTTPS like Resend.
 * 300 messages a day on the free tier, which is far above what a depot produces.
 *
 * Called through `fetch` rather than Brevo's SDK deliberately: the whole API surface
 * used here is one POST, and a dependency whose transitive tree we would have to keep
 * patched is a poor trade for the twenty lines below.
 */
function buildBrevoMailer(): Mailer {
  const config = env();
  if (!config.BREVO_API_KEY) {
    throw new Error(
      'MAILER=brevo but BREVO_API_KEY is unset. Create a key at ' +
        'app.brevo.com/settings/keys/api, verify the address you want to send from ' +
        'under Senders, then set BREVO_API_KEY and MAIL_FROM to that address. ' +
        'See "Sending to more than one person" in docs/DEPLOY.md.',
    );
  }
  const apiKey = config.BREVO_API_KEY;
  const sender = parseAddress(fromAddress());
  return {
    async send(msg) {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        // Without this a hung connection holds the outbox row in SENDING until the
        // worker's 5-minute stale lease expires, which stalls every message behind it.
        // 30s is far longer than a send of a few hundred KB should ever take.
        signal: AbortSignal.timeout(30_000),
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender,
          to: [{ email: msg.to }],
          subject: msg.subject,
          textContent: msg.text,
          ...(msg.html ? { htmlContent: msg.html } : {}),
          // Brevo takes attachments as base64 in the JSON body, not as multipart.
          ...(msg.attachments?.length
            ? {
                attachment: msg.attachments.map((a) => ({
                  name: a.filename,
                  content: a.content.toString('base64'),
                })),
              }
            : {}),
        }),
      });
      if (!response.ok) {
        // Brevo reports refusals as `{ code, message }`. Read it as text first: an
        // auth failure or a gateway error can answer with HTML, and a JSON.parse
        // throwing here would replace a useful status line with "Unexpected token <".
        const body = await response.text().catch(() => '');
        let detail = body;
        try {
          const parsed = JSON.parse(body) as { code?: string; message?: string };
          if (parsed.message)
            detail = parsed.code ? `${parsed.code}: ${parsed.message}` : parsed.message;
        } catch {
          /* keep the raw body */
        }
        throw new Error(
          explainRefusal(
            'brevo',
            `Brevo refused the message (HTTP ${response.status}): ${detail}`,
            {
              from: sender.email,
              to: msg.to,
            },
          ),
        );
      }
    },
  };
}

/**
 * Turn a provider's refusal into something that names the fix.
 *
 * Every one of these was, in its raw form, a line that reads like a bug in this app
 * and is actually a five-minute change in someone's dashboard. The one that cost the
 * most time is Resend's: a batch addressed to anyone but the account owner is refused
 * with a 403 whose text mentions neither the account owner nor domain verification, so
 * the queue fills with failures that look arbitrary. The message is what a human reads
 * off `lastError` at 6am, so it is worth more than the provider's own wording.
 *
 * The original text is always kept — a translation that guesses wrong must not destroy
 * the evidence underneath it.
 */
export function explainRefusal(
  provider: 'resend' | 'brevo',
  raw: string,
  addresses: { from: string; to: string },
): string {
  const lower = raw.toLowerCase();
  const hint = ((): string | null => {
    if (provider === 'resend') {
      // Resend's test mode: no verified domain, so exactly one recipient is reachable.
      if (lower.includes('testing emails') || lower.includes('own email address')) {
        return (
          `Resend is in test mode: with no verified domain it delivers ONLY to the ` +
          `address that owns the Resend account, so ${addresses.to} is refused. ` +
          `Either verify a domain at resend.com/domains and set MAIL_FROM to an ` +
          `address on it, or switch to MAILER=brevo, which needs no domain — see ` +
          `docs/DEPLOY.md.`
        );
      }
      if (lower.includes('domain is not verified') || lower.includes('not verified')) {
        return (
          `Resend will not send as ${addresses.from}: that domain is not verified. ` +
          `Verify it at resend.com/domains, or use MAILER=brevo, which verifies a ` +
          `single address instead of a whole domain.`
        );
      }
    }
    if (provider === 'brevo') {
      if (
        lower.includes('sender') &&
        (lower.includes('not valid') || lower.includes('not exist'))
      ) {
        return (
          `Brevo does not recognise ${addresses.from} as a verified sender. Add it at ` +
          `app.brevo.com/senders, click the confirmation link Brevo emails to that ` +
          `address, and make sure MAIL_FROM matches it exactly.`
        );
      }
      if (lower.includes('unauthorized') || lower.includes('http 401')) {
        return `Brevo rejected BREVO_API_KEY. Re-issue one at app.brevo.com/settings/keys/api.`;
      }
      // The free tier's 300/day ceiling, hit mid-run.
      if (lower.includes('http 402') || lower.includes('credit') || lower.includes('quota')) {
        return (
          `Brevo is out of sending credit for today (the free tier allows 300 emails ` +
          `per day). The queue retries, so this clears on its own when the quota resets.`
        );
      }
    }
    return null;
  })();
  return hint ? `${hint}\n\nProvider said: ${raw}` : raw;
}

let cached: Mailer | undefined;

export function getMailer(): Mailer {
  if (cached) return cached;
  if (env().MAILER === 'resend') {
    cached = buildResendMailer();
    return cached;
  }
  if (env().MAILER === 'brevo') {
    cached = buildBrevoMailer();
    return cached;
  }
  if (env().MAILER === 'capture') {
    cached = {
      async send(msg) {
        captured.push(msg);
      },
    };
    return cached;
  }
  const transport = env().MAILER === 'smtp' ? buildSmtpTransport() : buildSendgridTransport();
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
