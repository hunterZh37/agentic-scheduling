import { Provider } from "@prisma/client";
import { makeCallbackHandler } from "@/lib/oauth/routeHandlers";

export const runtime = "nodejs";
export const GET = makeCallbackHandler(Provider.microsoft);
