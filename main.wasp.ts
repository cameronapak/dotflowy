import { app, page, route } from "@wasp.sh/spec";
import { App } from "./src/app/App" with { type: "ref" };
import { HomePage } from "./src/app/HomePage" with { type: "ref" };
import { LoginPage } from "./src/app/auth/LoginPage" with { type: "ref" };
import { SignupPage } from "./src/app/auth/SignupPage" with { type: "ref" };
import { EmailVerificationPage } from "./src/app/auth/EmailVerificationPage" with { type: "ref" };
import { RequestPasswordResetPage } from "./src/app/auth/RequestPasswordResetPage" with { type: "ref" };
import { PasswordResetPage } from "./src/app/auth/PasswordResetPage" with { type: "ref" };
import { nodesSpec } from "./src/nodes/nodes.wasp";
import { tagsSpec } from "./src/plugins/tags/tags.wasp";
import { dailySpec } from "./src/plugins/daily/daily.wasp";
import { accountSpec } from "./src/account/account.wasp";

// Wasp foundation (PRD docs/PRD-wasp-migration.md): email/password auth + the
// Prisma data model (Phase 1) and the outline/plugin sync operations (Phase 2).
// The outline editor UI (routes, components, plugin client code) is ported in
// Phase 3 — the home route is an auth-gated placeholder until then.
export default app({
  name: "dotflowy",
  title: "Dotflowy",
  wasp: { version: "^0.24.0" },
  head: ["<link rel='icon' href='/favicon.ico' />"],
  auth: {
    userEntity: "User",
    methods: {
      // Email/password only in v1 (PRD decision #6; no OAuth). The Dummy
      // email sender prints verification/reset links to the server log in dev;
      // set SKIP_EMAIL_VERIFICATION_IN_DEV=true to log in right after signup.
      email: {
        fromField: {
          name: "Dotflowy",
          email: "noreply@dotflowy.app",
        },
        emailVerification: {
          clientRoute: "EmailVerificationRoute",
        },
        passwordReset: {
          clientRoute: "PasswordResetRoute",
        },
      },
    },
    onAuthSucceededRedirectTo: "/",
    onAuthFailedRedirectTo: "/login",
  },
  emailSender: {
    provider: "Dummy",
  },
  client: {
    rootComponent: App,
  },
  spec: [
    route("HomeRoute", "/", page(HomePage, { authRequired: true })),
    route("LoginRoute", "/login", page(LoginPage)),
    route("SignupRoute", "/signup", page(SignupPage)),
    route(
      "RequestPasswordResetRoute",
      "/request-password-reset",
      page(RequestPasswordResetPage),
    ),
    route("PasswordResetRoute", "/password-reset", page(PasswordResetPage)),
    route(
      "EmailVerificationRoute",
      "/email-verification",
      page(EmailVerificationPage),
    ),
    // Phase 2 operations (nested Spec arrays are flattened by the compiler).
    nodesSpec,
    tagsSpec,
    dailySpec,
    accountSpec,
  ],
});
