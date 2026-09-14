import type { FetchLike } from "./stripe.js";

/**
 * Sending a licence to the person who bought it.
 *
 * An interface rather than a hard dependency on one provider, because this is
 * the piece most likely to be swapped, and because tests need to assert what
 * would have been sent without sending it.
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/**
 * A mailer for deployments with no email provider configured.
 *
 * Deliberately not silent. Delivery failing is survivable — the success page
 * shows the licence key too, and `/api/license/recover` can re-issue it — but
 * it must be visible in the logs rather than pretended away.
 */
export class LoggingMailer implements Mailer {
  readonly sent: OutgoingMail[] = [];

  async send(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail);
    console.warn(
      `[cloud] No email provider configured; "${mail.subject}" to ${mail.to} was not delivered.`,
    );
  }
}

/**
 * Resend, over its REST API.
 *
 * No SDK: it is one authenticated POST, and the rest of this repo already
 * talks to Stripe, OpenRouter and Gemini the same way.
 */
export class ResendMailer implements Mailer {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: FetchLike;

  constructor({
    apiKey,
    from,
    fetchImpl,
  }: {
    apiKey: string;
    from: string;
    fetchImpl?: FetchLike;
  }) {
    this.#apiKey = apiKey;
    this.#from = from;
    this.#fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async send(mail: OutgoingMail): Promise<void> {
    const response = await this.#fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.#from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
    });

    if (!response.ok) {
      // Thrown, not swallowed — but every caller treats a delivery failure as
      // non-fatal, because the purchase itself has already succeeded and the
      // key is shown on screen regardless.
      throw new Error(`Resend returned HTTP ${response.status}`);
    }
  }
}

export function signinCodeEmail(code: string, ttlMinutes: number): OutgoingMail {
  return {
    to: "",
    subject: `${code} is your Store Validator sign-in code`,
    text: `Your sign-in code is:

${code}

Enter it in the app to finish signing in. It expires in ${ttlMinutes} minutes.

If you didn't ask to sign in, you can ignore this — the code is useless without
access to the app, and nothing has changed on your account.
`,
  };
}
