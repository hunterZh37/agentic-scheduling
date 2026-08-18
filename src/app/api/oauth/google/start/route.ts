import { Provider } from "@prisma/client";
import { makeStartHandler } from "@/lib/oauth/routeHandlers";

export const runtime = "nodejs";
export const GET = makeStartHandler(Provider.google);
