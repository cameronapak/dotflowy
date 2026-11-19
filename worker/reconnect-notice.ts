import { Schema } from "effect";

import { sendEmail, type EmailEnv } from "./email";
import { isPlausibleEmail, normalizeEmail } from "./identity";

export const ReconnectNoticeBody = Schema.Struct({
  recipients: Schema.Array(
    Schema.String.check(
      Schema.makeFilter((value) => isPlausibleEmail(normalizeEmail(value))),
    ),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  dryRun: Schema.optional(Schema.Boolean),
});

export const reconnectNoticeEmail = {
  subject: "A quick sign-in refresh for your Dotflowy connections",
  text: `Hi there,

We've updated Dotflowy's sign-in system to help keep your connections secure. Your connected AI apps and the Dotflowy CLI need you to sign in again just once.

- AI apps such as Claude, ChatGPT, and Cursor: reconnect Dotflowy in the app's connector settings, then sign in and approve the connection again.
- Dotflowy CLI: run \`dotflowy login\` and follow the sign-in steps in your browser.

Your outlines, browser sessions, and API keys are unchanged. If you connect using an API key, there's nothing you need to do.

Thanks for using Dotflowy!
— Cam Pak, creator of Dotflowy`,
  html: `<p>Hi there,</p>
<p>We've updated Dotflowy's sign-in system to help keep your connections secure. Your connected AI apps and the Dotflowy CLI need you to sign in again just once.</p>
<ul>
  <li><strong>AI apps such as Claude, ChatGPT, and Cursor:</strong> reconnect Dotflowy in the app's connector settings, then sign in and approve the connection again.</li>
  <li><strong>Dotflowy CLI:</strong> run <code>dotflowy login</code> and follow the sign-in steps in your browser.</li>
</ul>
<p>Your outlines, browser sessions, and API keys are unchanged. If you connect using an API key, there's nothing you need to do.</p>
<p>Thanks for using Dotflowy!<br>— Cam Pak, creator of Dotflowy</p>`,
};

export async function runReconnectNotice(
  env: EmailEnv,
  body: typeof ReconnectNoticeBody.Type,
) {
  const recipients = [...new Set(body.recipients.map(normalizeEmail))];
  const dryRun = body.dryRun ?? true;
  const results: {
    email: string;
    status: "accepted" | "failed" | "simulated";
  }[] = [];
  for (const email of recipients) {
    // Avoid the email seam's local fallback, which logs recipient addresses.
    const outcome =
      dryRun || !env.EMAIL
        ? { status: "simulated" as const }
        : await sendEmail(env, { to: email, ...reconnectNoticeEmail });
    results.push({ email, status: outcome.status });
  }
  return {
    dryRun,
    results,
    message: dryRun ? reconnectNoticeEmail : undefined,
  };
}
