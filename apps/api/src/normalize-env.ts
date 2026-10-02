// Må importeres FØRST i hver prosess-inngang (ES-moduler evalueres i importrekkefølge): fjerner tomme
// miljøvariabler (`NAVN=""` fra compose `${NAVN:-}`) slik at `?? default` virker. Se `normalizeBlankEnv`.
import { normalizeBlankEnv } from "@jarvis/contracts";

normalizeBlankEnv();
