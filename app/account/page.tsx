import { buttonVariants } from "@heroui/react";
import { ShieldCheck, Upload } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DeleteAccountButton } from "@/components/delete-account-button";
import { DisplayNameForm } from "@/components/display-name-form";
import { ExportSendsButton } from "@/components/export-sends-button";
import { PrivacyControls } from "@/components/privacy-controls";
import { ProductTour } from "@/components/product-tour";
import { ResetPasswordButton } from "@/components/reset-password-button";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeSelect } from "@/components/theme-select";
import { AppLink } from "@/components/ui/app-link";
import { cardClass } from "@/components/ui/card";
import { Eyebrow } from "@/components/ui/eyebrow";
import { PageTitle, SectionHeading } from "@/components/ui/typography";
import { UserAvatar } from "@/components/ui/user-avatar";
import { getDb } from "@/db/client";
import { getUser } from "@/db/queries";
import { getSession, isAdmin } from "@/lib/session";
import { signInUrl } from "@/lib/sign-in-redirect";

export const metadata: Metadata = {
  title: "Account",
  robots: { index: false },
};

/** One card per account concern. Keeping descriptions with their controls
 * makes the settings page scannable without turning it into a button grid. */
function AccountSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`flex h-full flex-col gap-4 ${cardClass("md")}`}>
      <div className="flex flex-col gap-1">
        <SectionHeading>{title}</SectionHeading>
        <p className="text-sm text-muted">{description}</p>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export default async function AccountPage() {
  const session = await getSession();

  if (!session) {
    redirect(signInUrl("/account"));
  }

  const db = await getDb();
  const user = await getUser(db, session.user.id);
  const name = user?.name ?? session.user.name;
  const image = user?.image ?? session.user.image;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <section className={cardClass("md")}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <UserAvatar name={name} image={image} size="lg" />
            <div className="min-w-0">
              <Eyebrow>Account</Eyebrow>
              <PageTitle className="truncate">{name}</PageTitle>
              <p className="truncate text-sm text-muted">{session.user.email}</p>
            </div>
          </div>
          <AppLink
            href={`/users/${session.user.id}`}
            className={`${buttonVariants({ variant: "outline" })} shrink-0 self-start text-foreground sm:self-auto`}
          >
            View my profile
          </AppLink>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <AccountSection
          title="Display name"
          description="How your name appears to other climbers. Names are unique across Betabook."
        >
          <DisplayNameForm initialName={name} />
        </AccountSection>

        <AccountSection title="Appearance" description="Choose how Betabook looks on this device.">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Theme</span>
            <ThemeSelect />
          </div>
        </AccountSection>

        <AccountSection title="Privacy" description="Control who can see your climbing log.">
          <PrivacyControls
            initialIsPrivate={user?.isPrivate ?? false}
            initialJournalVisibility={user?.journalVisibility ?? "private"}
          />
        </AccountSection>

        <AccountSection
          title="Send data"
          description="Bring your history in or keep a copy offline."
        >
          <AppLink
            href="/account/import"
            className={`${buttonVariants({ variant: "outline", fullWidth: true })} gap-2 text-foreground`}
          >
            <Upload className="size-4" />
            Import sends
          </AppLink>
          <ExportSendsButton userId={session.user.id} />
        </AccountSection>

        <AccountSection
          title="Getting started"
          description="Learn how sessions, sends, projects, and training fit together."
        >
          <ProductTour />
        </AccountSection>

        <AccountSection title="Security" description="Manage your password and current session.">
          <ResetPasswordButton email={session.user.email} />
          <SignOutButton />
        </AccountSection>

        {isAdmin({ user: { role: user?.role } }) && (
          <AccountSection
            title="Moderation"
            description="Review change requests for the areas you moderate."
          >
            <AppLink
              href="/admin/requests"
              className={`${buttonVariants({ variant: "outline", fullWidth: true })} gap-2 text-foreground`}
            >
              <ShieldCheck className="size-4" />
              Review requests
            </AppLink>
          </AccountSection>
        )}
      </div>

      <section className="flex flex-col gap-4 rounded-xl border border-danger/30 bg-danger/5 p-6">
        <div className="flex flex-col gap-1">
          <SectionHeading>Danger zone</SectionHeading>
          <p className="text-sm text-muted">
            Permanently remove your account and climbing history.
          </p>
        </div>
        <p className="text-sm text-muted">
          Export your sends above before deleting your account — this can&apos;t be undone.
        </p>
        <div className="self-start">
          <DeleteAccountButton />
        </div>
      </section>
    </div>
  );
}
