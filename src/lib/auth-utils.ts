import { createSupabaseBrowserClient } from "@/lib/supabase-client";

export type StaffRole = "admin" | "designer";

/**
 * Fetches the current user's staff role from Supabase.
 * Returns null if not authenticated or not a staff member.
 */
export async function getClientRole(): Promise<StaffRole | null> {
  const supabase = createSupabaseBrowserClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: staff } = await supabase
    .from("staff")
    .select("role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (!staff || !staff.is_active) return null;
  return staff.role as StaffRole;
}

/**
 * Resolves the back URL from the ?from= param, validating it against the
 * user's role. Admin URLs are stripped for non-admin users.
 */
export function resolveBackUrl(
  fromParam: string | null | undefined,
  role: StaffRole | null,
  defaultUrl: string,
  defaultLabel: string
): { backUrl: string; backLabel: string } {
  const from = fromParam?.trim() ?? "";

  // Block designers from admin URLs in the from param
  const isAdminUrl = from.startsWith("/studio/admin");
  if (isAdminUrl && role !== "admin") {
    return { backUrl: defaultUrl, backLabel: defaultLabel };
  }

  if (!from) return { backUrl: defaultUrl, backLabel: defaultLabel };
  if (from.startsWith("/customer/"))           return { backUrl: from, backLabel: "Customer" };
  if (from === "/studio/admin/customers")      return { backUrl: from, backLabel: "Customers" };
  if (from === "/studio/admin")                return { backUrl: from, backLabel: "Admin" };
  if (from === "/studio/designer")             return { backUrl: from, backLabel: "Dashboard" };
  if (from.startsWith("/studio/admin/designers/")) return { backUrl: from, backLabel: "Designer" };
  if (from.startsWith("/studio/sessions/"))        return { backUrl: from, backLabel: "Session" };
  if (from.startsWith("/studio/admin/sessions/"))  return { backUrl: from, backLabel: "Session" };

  return { backUrl: defaultUrl, backLabel: defaultLabel };
}
