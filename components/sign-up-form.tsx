"use client";

import { Button, Input, Label, TextField } from "@heroui/react";
import { useState } from "react";

import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { AppLink } from "@/components/ui/app-link";
import { FORM_CARD_CLASS } from "@/components/ui/card";
import { PageTitle } from "@/components/ui/typography";
import { authClient } from "@/lib/auth-client";
import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/display-name";
import { safeNextPath, signInUrl } from "@/lib/sign-in-redirect";

export function SignUpForm({
  next,
  googleEnabled = false,
}: {
  next?: string;
  googleEnabled?: boolean;
}) {
  // The page already validates the param, but re-validate the prop here so
  // the form can never be handed an off-origin destination.
  const nextPath = safeNextPath(next);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [done, setDone] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendPending, setResendPending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  const passwordMismatch = submitAttempted && password !== confirmPassword;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitAttempted(true);
    if (password !== confirmPassword) return;
    setPending(true);
    void authClient.signUp.email(
      // The verification link lands back on sign-in, carrying the original
      // destination so the continuation survives sign-up → verify → sign-in.
      { name, email, password, callbackURL: signInUrl(nextPath) },
      {
        onSuccess: () => setDone(true),
        onError: (ctx) => setError(ctx.error.message ?? "Sign up failed"),
        onResponse: () => setPending(false),
      },
    );
  }

  // Bound to the just-registered address; same better-auth call (and the
  // same land-back-on-sign-in callback) as the sign-in form's resend.
  function resendVerification() {
    setResent(false);
    setResendError(null);
    setResendPending(true);
    void authClient.sendVerificationEmail(
      { email, callbackURL: signInUrl(nextPath) },
      {
        onSuccess: () => setResent(true),
        onError: (ctx) =>
          setResendError(ctx.error.message ?? "Could not resend the verification email"),
        onResponse: () => setResendPending(false),
      },
    );
  }

  if (done) {
    return (
      <div className={FORM_CARD_CLASS}>
        <PageTitle className="text-2xl">Check your email</PageTitle>
        <p className="text-sm text-muted">
          We sent a verification link to {email}. Verify your address, then{" "}
          <AppLink href={signInUrl(nextPath)}>sign in</AppLink>.
        </p>
        <Button variant="ghost" onPress={resendVerification} isDisabled={resent || resendPending}>
          {resent ? "Verification email sent" : "Resend verification email"}
        </Button>
        {resendError && <p className="text-sm text-danger">{resendError}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={FORM_CARD_CLASS}>
      <PageTitle className="text-2xl">Sign up</PageTitle>
      {googleEnabled && (
        <>
          <GoogleSignInButton nextPath={nextPath} onError={setError} disabled={pending} />
          <div className="relative flex items-center py-1">
            <div className="grow border-t border-separator" />
            <span className="mx-3 shrink text-xs text-muted uppercase">or</span>
            <div className="grow border-t border-separator" />
          </div>
        </>
      )}
      <TextField value={name} onChange={setName} isRequired maxLength={MAX_DISPLAY_NAME_LENGTH}>
        <Label>Display name</Label>
        <Input placeholder="How you'll appear to other climbers" />
      </TextField>
      <TextField value={email} onChange={setEmail} type="email" isRequired>
        <Label>Email</Label>
        <Input placeholder="you@example.com" />
      </TextField>
      <TextField value={password} onChange={setPassword} type="password" isRequired>
        <Label>Password</Label>
        <Input />
      </TextField>
      <TextField value={confirmPassword} onChange={setConfirmPassword} type="password" isRequired>
        <Label>Confirm password</Label>
        <Input />
      </TextField>
      {passwordMismatch && (
        <p role="alert" className="text-sm text-danger">
          Passwords do not match.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" fullWidth isDisabled={pending}>
        Sign up
      </Button>
      <p className="text-sm text-muted">
        Already have an account? <AppLink href={signInUrl(nextPath)}>Sign in</AppLink>
      </p>
    </form>
  );
}
