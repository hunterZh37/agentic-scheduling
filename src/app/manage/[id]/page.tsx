import { prisma } from "@/lib/db";
import { verifyManageToken } from "@/lib/booking/manageToken";
import { ManageBooking } from "@/components/booking/ManageBooking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Manage your booking" };

// Attendee-facing self-serve page. Reached from the manage link in the invite:
// /manage/{id}?t={signature}. The signature (HMAC of the id) authorizes it — no
// account needed — and is verified server-side before any booking data is read.
export default async function ManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;

  const valid = await verifyManageToken(id, t);
  const booking = valid ? await prisma.booking.findUnique({ where: { id } }) : null;

  return (
    <ManageBooking
      token={t ?? ""}
      booking={
        valid && booking
          ? {
              id: booking.id,
              title: booking.title,
              start: booking.startTime.toISOString(),
              end: booking.endTime.toISOString(),
              timezone: booking.attendeeTimezone,
              cancelled: booking.status === "cancelled",
            }
          : null
      }
    />
  );
}
