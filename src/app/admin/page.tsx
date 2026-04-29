import AdminPanel from "@/components/AdminPanel";
import { ADMIN_COOKIE, verifyAdminToken } from "@/lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default function AdminPage() {
  const token = cookies().get(ADMIN_COOKIE)?.value;

  if (!verifyAdminToken(token)) {
    redirect("/login?admin=1");
  }

  return <AdminPanel />;
}
