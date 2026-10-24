import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { isAllowedCorsOrigin } from "../cors"

// Global so OPTIONS is answered before route lookup. A missing route otherwise
// becomes a 404 with no CORS headers, and the desktop renderer (oc://renderer)
// treats that failed preflight as "cannot connect".
export const corsLayer = HttpRouter.middleware(
  HttpMiddleware.cors({
    allowedOrigins: (origin) => isAllowedCorsOrigin(origin),
    maxAge: 86_400,
  }),
  { global: true },
)
