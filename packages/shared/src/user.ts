import { z } from "zod";
import { AiSettingsSchema } from "./ai.js";
import { BackupDestinationSchema } from "./cloud.js";

export const TierSchema = z.enum(["free", "premium"]);
export type Tier = z.infer<typeof TierSchema>;

export const UserProfileSchema = z.object({
  id: z.string().min(1),
  email: z.email().nullable().default(null),
  tier: TierSchema.default("free"),
  /** ISO timestamp the current premium entitlement lapses, if any. */
  premiumUntil: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

/**
 * Metadata *about* a stored secret. The secret itself is never part of any
 * type that crosses the IPC boundary or gets logged — only these hints do.
 */
export const SecretMetadataSchema = z.object({
  present: z.boolean(),
  /** Last four characters only, for "is this the key I think it is?". */
  last4: z.string().length(4).nullable().default(null),
  updatedAt: z.iso.datetime().nullable().default(null),
  /** Result of the most recent validation call against the provider. */
  lastValidatedAt: z.iso.datetime().nullable().default(null),
});
export type SecretMetadata = z.infer<typeof SecretMetadataSchema>;

export const DeployProviderSchema = z.enum(["vercel", "netlify"]);
export type DeployProvider = z.infer<typeof DeployProviderSchema>;

export const SettingsViewSchema = z.object({
  profile: UserProfileSchema,
  /** BYOK: the user's own OpenRouter key. We never proxy inference. */
  openRouter: SecretMetadataSchema,
  /** BYOK: the user's own Google Gemini key. Same rule, second provider. */
  gemini: SecretMetadataSchema,
  /** Which AI provider to use, and the model chosen for each. */
  ai: AiSettingsSchema.prefault({}),
  /** BYOK: the user's own Stripe secret key. We never touch their payments. */
  stripe: SecretMetadataSchema,
  /** BYO hosting: the user's own deploy tokens, one per provider. */
  deployTokens: z.partialRecord(DeployProviderSchema, SecretMetadataSchema),
  backupEnabled: z.boolean().default(false),
  backupDir: z.string().nullable().default(null),
  /** Local folder, our hosted storage, or both. Defaults to local. */
  backupDestination: BackupDestinationSchema.default("local"),
  /**
   * Whether a backup encryption key exists. The key itself never travels in
   * this payload — it is fetched deliberately, by its own endpoint, when the
   * user asks to see it.
   */
  backupKeySet: z.boolean().default(false),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;
