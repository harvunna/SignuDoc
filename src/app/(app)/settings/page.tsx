import { OrganizationSettings } from "@/components/settings/organization-settings";
import { SettingsShell } from "@/components/settings/settings-shell";
import { PlanPanel } from "@/components/settings/plan-panel";
import { UpdatesPanel } from "@/components/settings/updates-panel";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { isAdminUser } from "@/lib/auth/admin";
import { accountClosureBlock } from "@/lib/account";
import { getAuthSession } from "@/lib/auth/server";
import { toOrganizationSettingsView } from "@/lib/organization-settings";
import { hasPlan, readPlanConfig, readPlanUsage } from "@/lib/plan";
import {
  getSettings,
  readStoredSettings,
  resolveSettings,
} from "@/lib/settings";
import { usesTwoFactor } from "@/lib/sign-in-security";
import { getUpdateStatus } from "@/lib/software-update";

export default async function SettingsPage() {
  const session = await getAuthSession();
  const isAdmin = session ? await isAdminUser(session.user.id) : false;
  const settings = await getSettings();
  // GCM eSign plans: shown only on a site that has one, so a site without
  // plan settings (GCM's own) looks as it always has.
  const planUsage =
    isAdmin && hasPlan(readPlanConfig()) ? await readPlanUsage() : null;
  const closureBlockedReason = session
    ? await accountClosureBlock(session.user).catch(() => null)
    : null;

  return (
    <div className="space-y-8">
      <SettingsShell
        closureBlockedReason={closureBlockedReason}
        initialProfile={{
          email: session?.user.email ?? "",
          fullName: session?.user.name ?? "",
        }}
        twoFactor={{
          enabled: session ? usesTwoFactor(session.user) : false,
          required: settings.requireTwoFactor,
        }}
      />
      {/* GCM eSign change: anyone with an account can have API keys. An
          administrator manages every key from Organization settings. */}
      {session && !isAdmin && !settings.hosted ? (
        <ApiKeysPanel view="own" />
      ) : null}
      {planUsage ? <PlanPanel usage={planUsage} /> : null}
      {isAdmin ? (
        <OrganizationSettings
          // Read fresh, not from the short-lived cache, so the form never
          // shows a value that was just replaced.
          initialSettings={toOrganizationSettingsView(
            resolveSettings(await readStoredSettings()),
          )}
        />
      ) : null}
      {isAdmin ? <UpdatesPanel initialStatus={getUpdateStatus(null)} /> : null}
    </div>
  );
}
