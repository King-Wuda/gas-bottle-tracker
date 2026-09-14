import { describe, it, expect, afterEach, vi } from 'vitest';
import { resetEnvCache } from '../src/env.js';
import {
  explainRefusal,
  getMailer,
  parseAddress,
  setMailer,
} from '../src/services/mailer/index.js';

/**
 * The Brevo transport and the refusal translator.
 *
 * Both exist for one reason: mail that reaches every project manager, from a host that
 * blocks SMTP and an account that owns no domain. The tests worth writing are
 * therefore not "does it POST" but "does it POST the shape Brevo documents", because a
 * wrong field name here fails only in production, as a 400 nobody reads.
 */

/** Run `fn` with the environment a Brevo deployment would have, then put it back. */
async function withBrevoEnv(
  overrides: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const applied = { MAILER: 'brevo', ...overrides };
  // Restore key by key. Reassigning `process.env` wholesale swaps Node's live
  // environment for a plain object and every later read comes back undefined.
  const saved = Object.fromEntries(Object.keys(applied).map((k) => [k, process.env[k]] as const));
  Object.assign(process.env, applied);
  resetEnvCache();
  // getMailer() memoises, and every other suite relies on the capture transport.
  setMailer(undefined);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
    setMailer(undefined);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `fetch` stub typed like the real thing, so `mock.calls` is not `[] | undefined`. */
const stubFetch = (response: () => Response) => {
  const mock = vi.fn((url: string, init: RequestInit) => {
    void url;
    void init;
    return Promise.resolve(response());
  });
  vi.stubGlobal('fetch', mock);
  return mock;
};

/** The single request the stub was handed, with its JSON body already parsed. */
const sentRequest = (mock: ReturnType<typeof stubFetch>) => {
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = mock.mock.calls[0]!;
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
};

describe('parseAddress', () => {
  it('splits a display name from its address', () => {
    expect(parseAddress('Gas Cylinder Tracker <no-reply@gct.co.za>')).toEqual({
      name: 'Gas Cylinder Tracker',
      email: 'no-reply@gct.co.za',
    });
  });

  it('strips the quotes off a quoted display name rather than sending them', () => {
    expect(parseAddress('"Gas Cylinder Tracker" <no-reply@gct.co.za>')).toEqual({
      name: 'Gas Cylinder Tracker',
      email: 'no-reply@gct.co.za',
    });
  });

  it('treats a bare address as an address with no name', () => {
    expect(parseAddress('depot@example.com')).toEqual({ email: 'depot@example.com' });
  });

  it('does not invent an empty name from "<addr>"', () => {
    expect(parseAddress('<depot@example.com>')).toEqual({ email: 'depot@example.com' });
  });
});

describe('MAILER=brevo', () => {
  /**
   * Loud, and at env-validation time rather than at the first send — the same rule
   * MAILER=resend already follows. A server that boots believing it can send mail and
   * cannot is the state this whole area is built to avoid.
   */
  it('refuses to run without a key, naming the variable and where to get one', async () => {
    await withBrevoEnv({ BREVO_API_KEY: '' }, async () => {
      expect(() => getMailer()).toThrow(/BREVO_API_KEY/);
      expect(() => getMailer()).toThrow(/app\.brevo\.com/);
    });
  });

  it('posts the documented body: sender split, to as a list, base64 attachments', async () => {
    const fetchMock = stubFetch(() => new Response('{}', { status: 201 }));

    await withBrevoEnv(
      { BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'Depot <depot@example.com>' },
      async () => {
        await getMailer().send({
          to: 'pm@example.com',
          subject: 'QR codes',
          text: 'Sheet attached.',
          attachments: [
            {
              filename: 'qr-sheet.pdf',
              content: Buffer.from('%PDF-1.7'),
              contentType: 'application/pdf',
            },
          ],
        });
      },
    );

    const sent = sentRequest(fetchMock);
    expect(sent.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(sent.headers['api-key']).toBe('xkeysib-test');
    expect(sent.body).toEqual({
      sender: { name: 'Depot', email: 'depot@example.com' },
      to: [{ email: 'pm@example.com' }],
      subject: 'QR codes',
      textContent: 'Sheet attached.',
      // Brevo takes attachment bytes as base64 in the JSON body, under `attachment`.
      attachment: [{ name: 'qr-sheet.pdf', content: Buffer.from('%PDF-1.7').toString('base64') }],
    });
  });

  it('omits htmlContent entirely when there is no HTML body', async () => {
    const fetchMock = stubFetch(() => new Response('{}', { status: 201 }));
    await withBrevoEnv({ BREVO_API_KEY: 'k' }, async () => {
      await getMailer().send({ to: 'pm@example.com', subject: 's', text: 't' });
    });
    const { body } = sentRequest(fetchMock);
    expect('htmlContent' in body).toBe(false);
    expect('attachment' in body).toBe(false);
  });

  /**
   * The whole point of checking `response.ok`: without it a refused message is marked
   * SENT and the project manager silently never receives their sheet.
   */
  it('throws on a refusal, and says how to fix an unverified sender', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ code: 'invalid_parameter', message: 'sender is not valid' }),
          {
            status: 400,
          },
        ),
    );
    await withBrevoEnv({ BREVO_API_KEY: 'k', MAIL_FROM: 'depot@example.com' }, async () => {
      await expect(
        getMailer().send({ to: 'pm@example.com', subject: 's', text: 't' }),
      ).rejects.toThrow(/verified sender[\s\S]*app\.brevo\.com\/senders/);
    });
  });

  it('survives a non-JSON error body instead of masking it with a parse error', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    await withBrevoEnv({ BREVO_API_KEY: 'k' }, async () => {
      await expect(
        getMailer().send({ to: 'pm@example.com', subject: 's', text: 't' }),
      ).rejects.toThrow(/HTTP 502[\s\S]*502 Bad Gateway/);
    });
  });
});

describe('explainRefusal', () => {
  const addresses = { from: 'onboarding@resend.dev', to: 'pm@example.com' };

  /**
   * The refusal that started all of this. Resend's own wording never mentions domain
   * verification, so read off `lastError` it looks like a bug in this app.
   */
  it('translates Resend test mode into the two things that actually fix it', () => {
    const out = explainRefusal(
      'resend',
      'Resend refused the message: validation_error: You can only send testing emails to your own email address (owner@example.com).',
      addresses,
    );
    expect(out).toMatch(/test mode/);
    expect(out).toMatch(/pm@example\.com is refused/);
    expect(out).toMatch(/resend\.com\/domains/);
    expect(out).toMatch(/MAILER=brevo/);
  });

  it('keeps the provider’s original words underneath the translation', () => {
    const raw =
      'Resend refused the message: validation_error: You can only send testing emails to your own email address.';
    expect(explainRefusal('resend', raw, addresses)).toContain(raw);
  });

  it('explains a Brevo quota exhaustion as self-clearing, not as a misconfiguration', () => {
    const out = explainRefusal('brevo', 'Brevo refused the message (HTTP 402): not enough credit', {
      from: 'depot@example.com',
      to: 'pm@example.com',
    });
    expect(out).toMatch(/300 emails/);
    expect(out).toMatch(/retries/);
  });

  /** A refusal we do not recognise must pass through untouched, not be guessed at. */
  it('returns an unrecognised refusal verbatim', () => {
    const raw = 'Resend refused the message: internal_error: something unfamiliar';
    expect(explainRefusal('resend', raw, addresses)).toBe(raw);
  });
});
